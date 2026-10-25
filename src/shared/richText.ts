/**
 * 富文本的净化与纯文本抽取（第二轮 FEAT-002）
 *
 * 两件事必须做对，否则会出真问题：
 *
 * 1. **净化**：编辑器基于 contentEditable，用户在网页/Word 里复制的内容
 *    可能带 script、onerror、javascript: 链接。虽然渲染进程已被安全策略
 *    关掉了外部请求，但"能不执行可疑内容"和"靠别处拦着"是两件事。
 *
 * 2. **抽纯文本**：正文改成富文本后，三处依赖方会被 HTML 标签污染：
 *      - 全局搜索（src\shared\search.ts）会把标签当成内容匹配、也会显示出来
 *      - "生成复习卡"会把 HTML 拼进卡片正反面
 *      - 备忘"转任务"会把标签当任务标题
 *    所以凡是把正文当纯文本用的地方，都要先过 toPlainText。
 *
 * 兼容策略（关键）：旧数据是纯文本，**没有任何格式标记**。
 * 因此"没有 contentFormat 字段"一律按 plain 处理 → 旧数据零改写、零丢失风险。
 */

/** 正文的格式标记 */
export type ContentFormat = 'plain' | 'rich'

/** 给正文类字段用的可选标记。缺省视为 plain（旧数据即如此）。 */
export interface RichContent {
  contentFormat?: ContentFormat
}

/** 允许保留的标签（其余一律当标签去掉，内容保留） */
export const ALLOWED_TAGS = [
  'p',
  'br',
  'strong',
  'b',
  'em',
  'i',
  'u',
  's',
  'h1',
  'h2',
  'h3',
  'blockquote',
  'pre',
  'code',
  'ul',
  'ol',
  'li',
  'a'
] as const

/** 允许保留的属性：只有链接的 href */
const ALLOWED_ATTRS = ['href'] as const

/** 连内容一起整体丢掉的标签（不是"去掉标签保留文字"） */
const DROPPED_WITH_CONTENT = ['script', 'style', 'iframe', 'object', 'embed', 'noscript', 'svg']

/** 会产生换行的块级标签，抽纯文本时要变成换行而不是直接拼在一起 */
const BLOCK_TAGS = [
  'p',
  'div',
  'br',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'li',
  'blockquote',
  'pre',
  'tr'
]

/**
 * 两类内部标记，只在 htmlToPlainText 内部使用。
 * 用不可见控制字符，避免与用户真实内容冲突。
 */
const BLOCK_MARK = '\u0000'
const HARD_MARK = '\u0001'

/** 判断记录是不是富文本（缺省即纯文本） */
export function isRichContent(format: unknown): boolean {
  return format === 'rich'
}

/**
 * 把 HTML 实体还原成字符。
 *
 * 顺序很关键：`&amp;` 必须**最后**解，否则 `&amp;lt;` 会被错误地二次解码成 `<`。
 * 事实上这里刻意不解码 `&lt;`/`&gt;`/`&amp;` 之外可能造成二次解码的组合——
 * 先解数字实体与常见命名实体，`&amp;` 放最后。
 */
export function decodeEntities(input: string): string {
  return input
    .replace(/&#x([0-9a-fA-F]+);/g, (_match, hex: string) =>
      String.fromCodePoint(Number.parseInt(hex, 16))
    )
    .replace(/&#(\d+);/g, (_match, dec: string) => String.fromCodePoint(Number.parseInt(dec, 10)))
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&')
}

/**
 * 净化 HTML：只保留白名单标签与属性。
 *
 * 做法保守但明确：
 *   1. 整体丢掉 script/style/iframe 等（连同内容）
 *   2. 去掉所有 on* 事件属性、style 属性、srcdoc
 *   3. 去掉 javascript:/vbscript:/data: 协议的链接
 *   4. 非白名单标签只脱掉标签壳，文字保留（避免用户内容被吃掉）
 */
export function sanitizeHtml(input: unknown): string {
  if (typeof input !== 'string' || input === '') return ''
  let html = input

  // 1) 连内容一起丢掉危险元素（含未闭合的情况）
  for (const tag of DROPPED_WITH_CONTENT) {
    const paired = new RegExp(`<${tag}\\b[^>]*>[\\s\\S]*?<\\/${tag}\\s*>`, 'gi')
    html = html.replace(paired, '')
    const selfClosing = new RegExp(`<${tag}\\b[^>]*\\/>`, 'gi')
    html = html.replace(selfClosing, '')
    // 未闭合的起始标签：丢到结尾，避免残留半截脚本
    const unclosed = new RegExp(`<${tag}\\b[^>]*>[\\s\\S]*$`, 'gi')
    html = html.replace(unclosed, '')
  }

  // 2) 去掉事件属性与 style
  html = html.replace(/\son[a-z]+\s*=\s*"[^"]*"/gi, '')
  html = html.replace(/\son[a-z]+\s*=\s*'[^']*'/gi, '')
  html = html.replace(/\son[a-z]+\s*=\s*[^\s>]+/gi, '')
  html = html.replace(/\sstyle\s*=\s*"[^"]*"/gi, '')
  html = html.replace(/\sstyle\s*=\s*'[^']*'/gi, '')
  html = html.replace(/\ssrcdoc\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, '')

  // 3) 危险协议
  html = html.replace(
    /(href\s*=\s*["']?)\s*(javascript|vbscript|data)\s*:/gi,
    '$1blocked:'
  )

  // 4) 非白名单标签脱壳（保留文字），白名单标签保留
  const allowed = new Set<string>(ALLOWED_TAGS)
  html = html.replace(/<\/?([a-zA-Z][a-zA-Z0-9]*)\b([^>]*)>/g, (match, rawName: string, attrs: string) => {
    const name = rawName.toLowerCase()
    const isClosing = match.startsWith('</')
    if (!allowed.has(name)) return ''
    if (isClosing) return `</${name}>`

    const kept: string[] = []
    for (const attr of ALLOWED_ATTRS) {
      const found = new RegExp(`\\s${attr}\\s*=\\s*("([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i').exec(attrs)
      if (!found) continue
      const value = found[2] ?? found[3] ?? found[4] ?? ''
      kept.push(`${attr}="${value.replace(/"/g, '&quot;')}"`)
    }
    const selfClosing = name === 'br' ? ' /' : ''
    return `<${name}${kept.length > 0 ? ' ' + kept.join(' ') : ''}${selfClosing}>`
  })

  return html.trim()
}

/** 把连续的换行压到最多两个（即最多一个空行），去掉每行的首尾空白 */
export function collapseBlankLines(text: string): string {
  return text
    .split('\n')
    .map((line) => line.replace(/[ \t]+$/g, '').replace(/^[ \t]+/g, ''))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

/**
 * 把两类标记合并成真正的换行。
 *
 * 必须区分两类边界，否则 `</p><p>`（结构边界）与 `<br><br>`（用户想要空行）
 * 会长得一模一样，只能二选一：
 *   - BLOCK 是块级标签的结构边界：连续多个只算**一个**换行
 *     （否则 `<p>上</p><p>下</p>` 会变成"上、空行、下"）
 *   - HARD 是用户显式敲的换行：连续两个就是**一个空行**（符合直觉）
 *
 * 实现上不靠 split（分隔符会被吃掉、连续分隔符会产生空串，容易写错），
 * 而是把"一段连续标记"整体替换掉：替换时才知道这一段里有几个硬换行。
 */
export function joinBreakMarkers(text: string): string {
  const runRe = new RegExp(`[${BLOCK_MARK}${HARD_MARK}]+`, 'g')
  return text.replace(runRe, (run) => {
    let hard = 0
    for (const char of run) {
      if (char === HARD_MARK) hard += 1
    }
    // 结构边界算一个换行；硬换行按个数算，取两者较大的
    const newlines = Math.max(1, hard)
    return '\n'.repeat(newlines)
  })
}

/**
 * 从 HTML 抽纯文本：块级标签变换行，去掉其余标签，还原实体。
 * 保留换行与段落——否则多行备忘被压成一行，用户会觉得"格式丢了"。
 *
 * 不能直接把起始标签和结束标签各自换成 \n：
 * 那样 `</p><p>` 会插出两个换行，段落之间就凭空多出一个空行。
 * 因此先用标记记下边界，再统一合并（见 joinBreakMarkers）。
 */
export function htmlToPlainText(html: string): string {
  if (html === '') return ''

  let text = html
  // 显式换行单独标记
  text = text.replace(/<br\s*\/?>/gi, HARD_MARK)
  // 块级结构边界；引用块前后额外留一个空行以保持可读
  for (const tag of BLOCK_TAGS) {
    if (tag === 'br') continue
    const extra = tag === 'blockquote' ? BLOCK_MARK : ''
    text = text.replace(new RegExp(`<${tag}\\b[^>]*>`, 'gi'), extra + BLOCK_MARK)
    text = text.replace(new RegExp(`</${tag}\\s*>`, 'gi'), BLOCK_MARK + extra)
  }
  // 其余标签脱壳
  text = text.replace(/<[^>]*>/g, '')
  text = decodeEntities(text)

  return collapseBlankLines(joinBreakMarkers(text))
}

/**
 * 取正文的纯文本。
 * plain 直接返回原文（旧数据走这条路，行为与以前完全一致）；
 * rich 才剥标签。
 */
export function toPlainText(value: unknown, format?: unknown): string {
  const text = typeof value === 'string' ? value : value === undefined || value === null ? '' : String(value)
  if (!isRichContent(format)) return text
  return htmlToPlainText(text)
}

/**
 * 把**编辑器里**的 HTML 收敛成白名单认识的形式（第 04 块接页面时发现的一个真缺陷）。
 *
 * 起因：contentEditable 里按回车，Chromium 不会插 `<br>`，而是把每一行包成
 * `<div>…</div>`。而 `sanitizeHtml` 的白名单里没有 `div`（`ALLOWED_TAGS` 只有
 * `p` / `br` / `strong` 这些），于是 `<div>` 会被"脱壳保留文字"：
 *
 *     <div>第一行</div><div>第二行</div>  →  第一行第二行
 *
 * 也就是**换行在落库那一步整段丢掉**，多行备忘会被压成一行（显示时也分不开）。
 *
 * 修法有两种，这里选的是不动净化规则的那一种：
 *   - ✅ 在写库之前把 `div` 换成白名单里的块级标签 `p`（本函数）
 *   - ❌ 把 `div` 加进 `ALLOWED_TAGS` —— 那等于改净化规则，
 *     而且会让已有的净化单测（断言 `<div>` 被脱壳）不再成立
 *
 * 因此 `sanitizeHtml` 的规则**一个字都没改**，本函数只是编辑器侧的规范化。
 * 它只做标签名替换，不引入任何新标签、不碰属性，所以不扩大注入面。
 */
export function normalizeEditorHtml(html: unknown): string {
  if (typeof html !== 'string' || html === '') return ''
  return (
    html
      // 换行包装：<div> → <p>（块级语义与渲染结果都一致，且 p 在白名单里）
      .replace(/<div\b[^>]*>/gi, '<p>')
      .replace(/<\/div\s*>/gi, '</p>')
      // styleWithCSS 生效时加粗/斜体会变成 <span style="…">，白名单不收 span，
      // 顺手换成等价的行内标签，否则加粗在落库时会被脱壳丢掉
      .replace(/<span\s+style="[^"]*font-weight:\s*(?:bold|[6-9]00)[^"]*"\s*>([\s\S]*?)<\/span\s*>/gi, '<b>$1</b>')
      .replace(/<span\s+style="[^"]*font-style:\s*italic[^"]*"\s*>([\s\S]*?)<\/span\s*>/gi, '<i>$1</i>')
      .replace(/<span\s+style="[^"]*text-decoration:\s*underline[^"]*"\s*>([\s\S]*?)<\/span\s*>/gi, '<u>$1</u>')
      // 其余 span（纯样式容器）只脱壳，文字保留
      .replace(/<\/?span\b[^>]*>/gi, '')
  )
}

/**
 * 宽容规范化正文，返回可直接落库的形状。
 *
 * 与项目里其他 normalizeXxx 一致：输入可能来自磁盘、导入文件或界面，
 * 一律不抛错，只把非法值收敛成合理值。
 */
export function normalizeRichText(
  value: unknown,
  format?: unknown
): { text: string; contentFormat?: ContentFormat } {
  const raw = typeof value === 'string' ? value : value === undefined || value === null ? '' : String(value)
  if (raw === '') return { text: '' }

  if (!isRichContent(format)) {
    // 纯文本：原样保留（不做 trim，多行备忘的行尾空白也算用户内容）
    return { text: raw }
  }

  const clean = sanitizeHtml(raw)
  // 净化后如果只剩空标签（用户其实没写东西），当成空内容
  if (htmlToPlainText(clean) === '') return { text: '', contentFormat: 'rich' }
  return { text: clean, contentFormat: 'rich' }
}
