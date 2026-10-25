/**
 * 第 07 块：操作指南的三条断言（`docs\TASKS\07` §5.5，**缺一不可**）
 *
 * 1. **覆盖全部功能模块** —— 以后加了模块/功能忘了写说明，这里会红
 * 2. **快捷键表与代码一致** —— 表里每个键要么能在代码里找到注册，要么被显式标成"待实现"；
 *    反过来，标了"待实现"的键**不许**真的注册过（否则就是标注过期，指南在骗人）
 * 3. **`guide.ts` 与 `操作指南-正文.md` 不会各说各话** —— 逐字比对生成结果；
 *    测试**只读**仓库文件，一个字节都不写
 */
import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  GUIDE,
  GUIDE_HOTKEYS,
  chapterTitle,
  hotkeyTableBlock,
  parseInline,
  plainInline,
  renderGuideMarkdown,
  renderInlineMarkdown,
  type GuideBlock
} from '../../src/shared/guide'
import { DEFAULT_HOTKEYS, HOTKEY_ACTIONS } from '../../src/shared/preferences'
import { FIXED_HOTKEYS, comboLabel, newEntryKindOfView, todayHotkeyAppliesTo } from '../../src/shared/hotkeys'
import { NAV_ITEMS } from '../../src/shared/navigation'

/** 正文里被判成"键盘键"的写法（界面渲染成 `<kbd>`，这里用来核对表格） */
const KEY_COMBOS = new Set<string>([
  ...HOTKEY_ACTIONS.map((action) => comboLabel(DEFAULT_HOTKEYS[action])),
  ...FIXED_HOTKEYS.map((item) => comboLabel(item.combo))
])

/** 一个块里的全部文字（断言只看文字，不看结构） */
function blockText(block: GuideBlock): string[] {
  if (block.kind === 'paragraph') return [block.text]
  if (block.kind === 'list') return block.items.map((item) => item.text)
  if (block.kind === 'table') return [...block.head, ...block.rows.flat()]
  if (block.kind === 'code') return [...block.lines]
  if (block.kind === 'quote') return [block.text]
  return [block.title]
}

function chapterText(index: string): string {
  const chapter = GUIDE.chapters.find((item) => item.index === index)
  if (!chapter) throw new Error(`没有第 ${index} 章`)
  return chapter.blocks.flatMap(blockText).join('\n')
}

/** 第三章里"### 小节"的切分结果：小节标题 → 该小节自己的文字 */
function moduleSections(index: string): Map<string, string> {
  const chapter = GUIDE.chapters.find((item) => item.index === index)
  if (!chapter) throw new Error(`没有第 ${index} 章`)
  const sections = new Map<string, string[]>()
  let current = '（章首）'
  sections.set(current, [])
  for (const block of chapter.blocks) {
    if (block.kind === 'subhead') {
      current = block.title
      sections.set(current, [])
      continue
    }
    const bucket = sections.get(current)
    if (bucket) bucket.push(...blockText(block))
  }
  const out = new Map<string, string>()
  for (const [title, lines] of sections) out.set(title, lines.join('\n'))
  return out
}

// ===========================================================================
// 1. 覆盖全部功能模块
// ===========================================================================

describe('操作指南覆盖全部功能模块（加了功能忘写说明，这里就红）', () => {
  it('七章齐全，章序与标题照 MASTER §15.1 定稿，没有按十三块重排', () => {
    expect(GUIDE.chapters.map(chapterTitle)).toEqual([
      '一、这个程序是什么',
      '二、认识界面',
      '三、每个模块怎么用',
      '四、快捷键',
      '五、右键菜单',
      '六、数据、备份与恢复',
      '七、注意事项（请认真看）'
    ])
  })

  it('第三章为每个功能模块都留了小节（导航里 ready 的模块一个都不能少）', () => {
    const sections = moduleSections('三')
    const documented = [...sections.keys()]
    // 计划页里的日历也算一个模块（不在导航里，但用户要学）
    const expected = ['总览', '计划', '学习', '复习', '读书', '日历', '备忘录']
    expect(documented.filter((title) => title !== '（章首）')).toEqual(expected)

    // 反向：导航里每个"已就绪"的模块，指南里必须有小节
    const readyModules = NAV_ITEMS.filter((item) => item.ready && item.section === 'main').map(
      (item) => item.label
    )
    expect(readyModules.length).toBeGreaterThanOrEqual(6)
    for (const label of readyModules) {
      expect(documented).toContain(label)
    }
  })

  it('每个模块小节都讲了它关键的那几件事（不是只留个标题）', () => {
    const sections = moduleSections('三')
    const required: Record<string, string[]> = {
      总览: ['快速记一笔', '今日计划', '最近记的备忘'],
      /**
       * 计划这一行的关键词在**修改 5 轮改写过**（不是删测试）：
       * 旧口径要求正文写出「自动挪到今天」——那正是本轮取消的行为。
       * 新口径要求写出**现在**真实的三件事：不再自动挪、能按「某一天 → 某一天」批量搬、
       * 标了「未完成」的不被批量搬走。判据没有变松（从 5 个词变成 7 个词）。
       *
       * **修改 7 轮再补三个词**（同一套做法：口径变了就改写判据，不删）：
       * 「不发逾期」→ 标了「未完成」的不算逾期；标完不丢 → 「已标未完成」组；组标题写着「不计入逾期」。
       */
      计划: [
        '回车即创建',
        '五个视图',
        '重复',
        '不会自动挪',
        '把某一天没做完的移到另一天',
        '移动某天未完成的',
        '标记未完成（不自动搬动）',
        '不算逾期',
        '已标未完成',
        '不计入逾期',
        '拖到日历'
      ],
      学习: ['占比', '章节树', '打勾', '记一次学习'],
      复习: ['间隔', '空格', '就地背卡', '汇总复习', '复习历史'],
      读书: ['在读', '章节树', '摘录', '想法', '页码'],
      日历: ['24 小时', '月视图', '年视图', '空白格子', '上一周'],
      备忘录: ['Ctrl+回车', '置顶', '标签', '排进计划', '生成复习卡']
    }

    for (const [title, keywords] of Object.entries(required)) {
      const text = sections.get(title) ?? ''
      expect(text, `第三章缺小节：${title}`).not.toBe('')
      for (const keyword of keywords) {
        expect(text, `「${title}」小节没讲「${keyword}」`).toContain(keyword)
      }
    }
  })

  it('十三块对照清单逐条都能在正文里找到（§5.7 的 13 条）', () => {
    const checklist: Array<{ topic: string; where: string[]; keywords: string[] }> = [
      // 关键词「自动挪到今天」在修改 5 轮换成「不会自动挪」+「移动某天未完成的」：
      // 行为被推翻了，正文也就必须改成新口径（口径变更 → 改写判据，不许删）
      // 修改 7 轮再补「不算逾期」：标了「未完成」的退出逾期统计，正文必须写明
      { topic: '1 计划：视图 + 日历三档 + 行内新建 + 拖拽改期 + 逾期 + 重复', where: ['三'], keywords: ['五个视图', '拖到日历', '不会自动挪', '移动某天未完成的', '不算逾期', '已标未完成', '重复任务'] },
      { topic: '2 学习：主题 → 资料（占比）→ 章节树 + 记一次学习 + 进度算法', where: ['三'], keywords: ['章节树', '占比', '记一次学习', '进度数字怎么来的'] },
      { topic: '3 复习：到期数 + 就地背卡 + 三档评分 + 汇总复习 + 历史', where: ['三'], keywords: ['今日到期', '就地背卡', '有点模糊', '汇总复习', '复习历史'] },
      { topic: '4 读书：三档书架 + 章节树 + 摘录与想法 + 阅读记录 + 按章节算进度', where: ['三'], keywords: ['在读', '章节树与按章节算进度', '阅读记录', '摘录与想法'] },
      { topic: '5 备忘录：行内新建 + 多行 + 置顶 + 标签 + 转任务 / 转复习卡', where: ['三'], keywords: ['Ctrl+回车', '置顶', '标签', '排进计划', '生成复习卡'] },
      { topic: '6 日历：周（24 小时）/ 月 / 年 + 全天行 + 空白格新建 + 翻页', where: ['三'], keywords: ['完整 24 小时', '全天', '空白格子', '上一周 / 下一周'] },
      { topic: '7 右键菜单：各类实体右键能做什么', where: ['五'], keywords: ['点右键', '任务 / 日历里的任务', '复习卡片'] },
      { topic: '8 回收站：在哪、能看什么、怎么恢复、怎么彻底删、保留期限', where: ['六', '七'], keywords: ['回收站', '恢复', '彻底删除', '保留'] },
      { topic: '9 数据与设置：数据位置、备份、导出/导入、清空、偏好项', where: ['六'], keywords: ['数据在哪', '导出', '导入', '偏好'] },
      { topic: '10 自动保存：保存中 / 已保存 / 保存失败三态 + 失败时输入保留', where: ['六'], keywords: ['保存中', '已保存', '保存失败', '原样留在输入框里'] },
      { topic: '11 手动保存：Ctrl+S = 立即落盘', where: ['四', '六'], keywords: ['Ctrl+S'] },
      { topic: '12 删除规则：先解除关联再删 + 关联内容保留 + 进回收站 + 清空是唯一例外', where: ['七'], keywords: ['一起移走', '会保留', '清空全部数据'] },
      { topic: '13 快捷键全表', where: ['四'], keywords: ['Ctrl+Alt+M', 'Ctrl+K', 'Ctrl+S', 'Esc', '空格', 'N', 'T'] }
    ]

    for (const item of checklist) {
      const text = item.where.map((index) => chapterText(index)).join('\n')
      for (const keyword of item.keywords) {
        expect(text, `十三块第 ${item.topic} 条没写「${keyword}」`).toContain(keyword)
      }
    }
  })

  it('【待实现】标注与代码真实情况一致：已经一处都不剩', () => {
    const pending: string[] = []
    for (const chapter of GUIDE.chapters) {
      for (const block of chapter.blocks) {
        if (block.kind === 'paragraph' && block.pending === true) pending.push(block.text)
        if (block.kind === 'list') {
          for (const item of block.items) if (item.pending === true) pending.push(item.text)
        }
      }
    }

    // 一次也没剩：
    //   02–06 做完了章节树 / 就地背卡 / 汇总复习 / 复习历史 / 右键菜单 / N·T / 标签……
    //   08 做完了侧栏收起 / 导航下列出条目 / 滚动条只待在各框里
    // 所以这条断言从"只剩 08 块那三件事"改成"**一处都不剩**"。
    // 它仍然是**故意钉住**的：以后谁再标【待实现】，这里立刻红，逼着人回来把数量改对。
    expect(pending).toEqual([])

    const allText = GUIDE.chapters.flatMap((chapter) => chapter.blocks.flatMap(blockText)).join('\n')
    for (const done of ['章节树', '就地背卡', '汇总复习', '复习历史', '看历史', '添加标签', 'N', 'T']) {
      expect(allText).toContain(done)
    }
    // 已经做完的，不许再挂着【待实现】
    for (const stale of [
      '【待实现】**章节树**',
      '【待实现】**就地背卡**',
      '【待实现】**复习历史**',
      '【待实现】**侧栏可以收起来**',
      '【待实现】**导航下面会列出你当前模块里的条目**',
      '【待实现】**滚动条只待在各自的框里**'
    ]) {
      expect(allText).not.toContain(stale)
    }
    // 标签本身的**说明**留着（讲的是"万一遇到怎么理解"），但不许挂在任何一条功能说明上
    expect(allText).toContain('【待实现】')
    expect(allText).toContain('已经没有这样的条目了')
  })

  it('正文里每个反引号片段都能判断出该渲染成 <kbd> 还是 <code>', () => {
    const codes: string[] = []
    const walk = (text: string): void => {
      for (const token of parseInline(text)) {
        if (token.kind === 'code' || token.kind === 'key') codes.push(token.text)
      }
    }
    for (const chapter of GUIDE.chapters) {
      for (const block of chapter.blocks) {
        for (const text of blockText(block)) walk(text)
      }
    }
    // 键盘键必须被认出来（否则界面上就是一坨纯文本）
    expect(codes).toContain('Ctrl+K')
    expect(codes).toContain('N')
    expect(codes).toContain('空格')
    // 目录名 / 环境变量 / 角标文本不算键（不能被渲染成 <kbd>）
    for (const notKey of ['exports\\', 'WORKLIFE_ROOT', '99+', '%APPDATA%\\工作生活\\']) {
      expect(codes).toContain(notKey)
      expect(parseInline(`\`${notKey}\``)[0]?.kind).toBe('code')
    }
    expect(parseInline('`Ctrl+K`')[0]?.kind).toBe('key')
  })
})

// ===========================================================================
// 2. 快捷键表与代码一致
// ===========================================================================

describe('快捷键表与代码一致（指南里不许写一个按不出来的键）', () => {
  it('标"现在就有"的键都真的注册过', () => {
    for (const row of GUIDE_HOTKEYS) {
      expect(row.keys.length).toBeGreaterThan(0)
      if (row.status !== 'now') continue
      for (const key of row.keys) {
        expect(KEY_COMBOS.has(key), `「${key}」在代码里没有注册，不能标"现在就有"`).toBe(true)
      }
    }
  })

  it('标"待实现"的键一定没注册（标注不许过期）', () => {
    for (const row of GUIDE_HOTKEYS) {
      if (row.status !== 'pending') continue
      for (const key of row.keys) {
        expect(KEY_COMBOS.has(key), `「${key}」其实已经能按了，别再标"待实现"`).toBe(false)
      }
    }
  })

  it('十三块第 13 条要求的那几颗键一个都不少', () => {
    const documented = new Set(GUIDE_HOTKEYS.flatMap((row) => row.keys))
    for (const key of [
      'Ctrl+Alt+M',
      'Ctrl+K',
      'Ctrl+S',
      'Esc',
      '空格',
      '1',
      '2',
      '3',
      'Ctrl+回车',
      'N',
      'T'
    ]) {
      expect(documented.has(key), `快捷键表里少了「${key}」`).toBe(true)
    }
  })

  it('表格块是从 GUIDE_HOTKEYS 长出来的（不存在两份表）', () => {
    const chapter = GUIDE.chapters.find((item) => item.index === '四')
    const table = chapter?.blocks.find((block) => block.kind === 'table')
    expect(table).toBeDefined()
    expect(table).toEqual(hotkeyTableBlock())
    if (table?.kind !== 'table') throw new Error('第四章没有快捷键表格')
    expect(table.head).toEqual(['快捷键', '作用', '状态'])
    expect(table.rows).toHaveLength(GUIDE_HOTKEYS.length)
  })

  it('N / T 的说明与代码里的注册范围一致（复习页不注册 N，T 只在计划页）', () => {
    const newRow = GUIDE_HOTKEYS.find((row) => row.keys.includes('N'))
    const todayRow = GUIDE_HOTKEYS.find((row) => row.keys.includes('T'))
    expect(newRow?.status).toBe('now')
    expect(todayRow?.status).toBe('now')

    // 代码侧：复习页确实没注册 N，T 只在计划页
    expect(newEntryKindOfView('review')).toBeNull()
    expect(newEntryKindOfView('plan')).not.toBeNull()
    expect(todayHotkeyAppliesTo('plan')).toBe(true)
    expect(todayHotkeyAppliesTo('review')).toBe(false)

    // 指南侧：这两条规矩都得写出来，否则"按不出来"会被当成坏了
    const rules = chapterText('四')
    expect(rules).toContain('复习页不生效')
    expect(rules).toContain('输入框里时它们不生效')
  })
})

// ===========================================================================
// 3. 两份文稿同源
// ===========================================================================

describe('guide.ts 与 操作指南-正文.md 同源（逐字比对；测试只读不写）', () => {
  /**
   * 仓库里那份生成物（**只读**：测试绝不改仓库文件）。
   *
   * `docs\` 是内部资料，**不随公开仓库发布**（见 `.gitignore`）。这个文件是
   * `node scripts\export-guide.mjs` 的产物：本地构建过就存在。
   * 不存在时，依赖磁盘文件的两条断言会**显式跳过**（`it.skipIf`），
   * 而生成物自身的自洽性（BOM / LF、内联标记往返、七章结构）照旧逐条断言。
   */
  const markdownFile = fileURLToPath(new URL('../../docs/操作指南-正文.md', import.meta.url))
  const hasRepoMarkdown = existsSync(markdownFile)

  /**
   * 行尾归一。
   *
   * 本仓库 `core.autocrlf=true`：换一台机器 checkout 出来的工作区可能是 CRLF，
   * 而生成器固定输出 LF。差异只在行尾时不算"两份文稿打架"，
   * 所以比对前先把 CRLF 归一（**生成器自己必须是 LF**，下面单独断言）。
   */
  const normalized = (text: string): string => text.replace(/\r\n/g, '\n')

  it.skipIf(!hasRepoMarkdown)('生成结果与仓库里的 Markdown 逐字相同', () => {
    const onDisk = readFileSync(markdownFile, 'utf8')
    expect(normalized(renderGuideMarkdown(GUIDE))).toBe(normalized(onDisk))
  })

  it('生成物没有 BOM、统一 LF（Windows 上最容易踩的两个坑）', () => {
    const generated = renderGuideMarkdown(GUIDE)
    expect(generated.charCodeAt(0)).not.toBe(0xfeff)
    expect(generated.includes('\r')).toBe(false)
    expect(generated.endsWith('\n')).toBe(true)
    // 磁盘上那份也不该带 BOM（生成脚本用 'utf8' 写入，不带 BOM）
    if (hasRepoMarkdown) expect(readFileSync(markdownFile, 'utf8').charCodeAt(0)).not.toBe(0xfeff)
  })

  it('生成过程不会改写正文：内联标记原样往返', () => {
    for (const chapter of GUIDE.chapters) {
      for (const block of chapter.blocks) {
        for (const text of blockText(block)) {
          expect(renderInlineMarkdown(parseInline(text))).toBe(text)
          // 纯文本版本只该少掉标记，不该多出别的东西
          expect(plainInline(text).length).toBeLessThanOrEqual(text.length)
        }
      }
    }
  })

  it.skipIf(!hasRepoMarkdown)('这份 md 就是七章正文（不是别的东西被误写进去）', () => {
    const onDisk = readFileSync(markdownFile, 'utf8')
    const chapters = onDisk.split('\n').filter((line) => line.startsWith('## '))
    expect(chapters).toEqual(GUIDE.chapters.map((chapter) => `## ${chapterTitle(chapter)}`))
  })

  it('界面上渲染的与仓库里那份是同一份数据（GUIDE 就是生成 md 的那份）', () => {
    // 界面组件直接 import GUIDE，md 由 renderGuideMarkdown(GUIDE) 生成：
    // 只要这条成立，"应用里看到的"与"仓库里的"就不会是两份稿子
    expect(renderGuideMarkdown()).toBe(renderGuideMarkdown(GUIDE))
    expect(GUIDE.chapters.length).toBe(7)
  })
})
