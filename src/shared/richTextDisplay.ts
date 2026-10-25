/**
 * 富文本"显示层"的纯逻辑（第二轮 FEAT-002 / `docs\TASKS\04`）
 *
 * 与 `richText.ts` 的分工要分清，这是本文件存在的原因：
 *
 *   - `richText.ts` 管**落库**：净化（`sanitizeHtml`）、抽纯文本（`toPlainText`）、
 *     规范化（`normalizeRichText`）。它是安全底线，**本轮不许改动它的规则**。
 *   - 本文件只管**显示**：把一条正文变成"可以直接交给 React 渲染"的形状。
 *
 * 显示层要做的那件事（把 `<a>` 变成不可点）不属于净化规则，
 * 所以单独放一个文件：改坏了也只影响"怎么显示"，不会动到落库那条链路。
 *
 * ## 链接只能存、不能点开（`docs\TASKS\04` §5.2 硬约束）
 *
 * 程序拦截一切外部请求，也不用 `shell.openExternal`，所以正文里的链接
 * **永远不该真的能跳转**。光靠"点了也不会有反应"是不够的——
 * 渲染出来的 DOM 里根本不带 `href`，就没有任何可跳转的入口
 * （鼠标点、键盘 Tab + Enter、右键"打开链接"都不成立）。
 * 原地址仍然留着（`data-href`），只是变成了纯展示信息。
 */
import { htmlToPlainText, isRichContent, sanitizeHtml } from './richText'

/** 一条正文该怎么渲染 */
export interface RichDisplay {
  /** text = 原样当纯文本渲染（React 文本子节点）；html = 渲染净化后的 HTML */
  kind: 'text' | 'html'
  /** kind 为 text 时是原文；为 html 时是**已净化、链接已不可点**的 HTML */
  content: string
  /** 正文里是否含链接（含就要给"链接只能保存、点不开"的提示） */
  hasLinks: boolean
}

/** 链接被改成不可点后挂上的 class（样式与提示都靠它） */
export const RICH_LINK_CLASS = 'rich-text__link-disabled'

/**
 * 把净化后 HTML 里的 `<a>` 改成"不可点"的形态。
 *
 * 具体做两件事：
 *   1. `href` → `data-href`：DOM 里不再有任何可跳转属性
 *   2. 挂上 class 与 title：样式与提示都能找到它
 *
 * 只用于**显示**，绝不用于落库——存进去的还是用户原本的 `href`
 * （否则改一次格式就把用户数据改了，违反"零改写"的立场）。
 */
export function disableLinks(html: string): { html: string; hasLinks: boolean } {
  let hasLinks = false
  const output = html.replace(/<a\b([^>]*)>/gi, (_match, rawAttrs: string) => {
    hasLinks = true
    const attrs = rawAttrs.replace(
      /\shref\s*=\s*("([^"]*)"|'([^']*)'|([^\s>]+))/i,
      (_hrefMatch, _whole, doubleQuoted?: string, singleQuoted?: string, bare?: string) => {
        const url = doubleQuoted ?? singleQuoted ?? bare ?? ''
        return ` data-href="${url.replace(/"/g, '&quot;')}"`
      }
    )
    return `<a class="${RICH_LINK_CLASS}" title="链接只保存，程序不会打开它"${attrs}>`
  })
  return { html: output, hasLinks }
}

/**
 * 正文渲染的统一入口。
 *
 * - `format` 不是 `'rich'`（含旧记录没有这个字段的情况）→ 原样返回原文。
 *   这就是"零改写"在显示侧的落点：旧数据一个字节都没动，显示行为与以前完全一致。
 * - `'rich'` → 先净化，再把链接改成不可点。净化后其实没有内容（只剩空标签）时
 *   按空文本处理，免得页面上多出一个空白块。
 */
export function richDisplay(value: unknown, format?: unknown): RichDisplay {
  const raw =
    typeof value === 'string' ? value : value === undefined || value === null ? '' : String(value)

  if (!isRichContent(format)) {
    return { kind: 'text', content: raw, hasLinks: false }
  }

  const safe = sanitizeHtml(raw)
  if (htmlToPlainText(safe) === '') {
    return { kind: 'text', content: '', hasLinks: false }
  }

  const { html, hasLinks } = disableLinks(safe)
  return { kind: 'html', content: html, hasLinks }
}

/**
 * 这条正文是"富文本且真的带格式"吗？
 *
 * 用于决定要不要给编辑器/显示块挂 `data-content-format="rich"`——
 * 验收与排查都靠这个读数据，不靠猜。
 */
export function isRichDisplay(display: RichDisplay): boolean {
  return display.kind === 'html'
}
