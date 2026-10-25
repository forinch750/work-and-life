/**
 * 读书页的**视图计算**（第 11 块 · `MASTER.md` §7.7 + §14 决定 22–24）
 *
 * 这里只放**纯函数**：进来的是记录数组，出去的是界面上直接显示的那几个字符串与数字。
 *
 * ## 为什么另起一份，而不是写在页面里
 *
 * 1. **书内进度不许重写**。`MASTER.md` §7.9 的"最小单元才算数"在
 *    `src\shared\treeProgress.ts` 里只有一份实现（08 块补的回归单测钉着它），
 *    本文件**一行公式都没有**：`chapterStats()` 直接转调 `treeProgress()`，
 *    `readingIndent()` 直接转调 `indentForDepth()`。
 *    → 单测能把"读书页算出来的数"与"公共实现的数"钉成同一个（§7.2 第一条）。
 * 2. **vitest 是 `environment: 'node'`**（没有 jsdom，也不许为了测组件引 jsdom）：
 *    组件行为交给端到端验收（`src\main\verify\phase8.ts` 的 P8-V*），
 *    能单测的只有"算出来的数对不对"，所以算的部分必须从组件里搬出来。
 *
 * ## 本块定义的界面口径（与 §7.7 的定稿一一对应）
 *
 * | 界面位置 | 显示什么 | 谁算 |
 * |---|---|---|
 * | 左栏书架行 | `在读 · 43%` + 封面块（书名首字）+ 进度细线 | `shelfMetaText()` / `coverInitial()` |
 * | 预览左侧信息卡 | 作者 / 格式 / 读到 N/M 页 / 章节 n/m 章 / 阅读记录 / 摘录·想法 | `bookPreviewFacts()` |
 * | 预览进度条 | **书内完成度 = 读完的章 / 总章数**（页码不参与） | `chapterStats()` |
 * | 中区「摘录与想法」 | `原文 · p.11` + 正文 + `→ 复习` | `excerptsOfBook()` |
 * | 中区「阅读记录」 | 日期 / 时长 / 页码范围（+ 挂在哪一章） | `recordsOfBook()` / `recordPagesText()` |
 * | 下区树的章节行 | 汇总章 `2/2`，最小单元 `读到 p.128` | `chapterRowProgress()` |
 *
 * > ⚠️ **摘录与想法永远不进树**（决定 24）：它不打勾，当叶子算会让进度永远偏低（已实测踩过）。
 * > `readingTreeNodes()` 就是这条规矩的落点——它只认 `kind: 'node'`。
 */

import {
  FORMAT_LABELS,
  STATUS_LABELS,
  coverInitial,
  normalizeReadingRecord,
  progressLabel,
  sortExcerpts,
  type Book,
  type ReadingNode,
  type ReadingStatus
} from './reading'
import { isTopicEntered } from './learningPageView'
import {
  indentForDepth,
  leafProgress,
  treeProgress,
  type LeafProgress
} from './treeProgress'

/** 视图计算只需要节点的这几项（`ReadingNode` 原样满足） */
export interface ReadingViewNode {
  id: string
  /** 所属的书 id */
  ownerId: string
  parentId: string | null
  title: string
  done: boolean
  /** 章节上的页码备注（"p.128" 这种） */
  note?: string
}

/** 视图计算只需要阅读记录的这几项（`ReadingProgress` 原样满足） */
export interface ReadingViewRecord {
  id: string
  bookId: string
  date: string
  minutes: number
  fromPage?: number
  toPage?: number
  percent?: number
  /** 这一条是从哪一章记下来的（第 11 块新增的可选字段） */
  nodeId?: string
}

/** 视图计算只需要摘录的这几项（`Excerpt` 原样满足） */
export interface ReadingViewExcerpt {
  id: string
  bookId: string
  type: 'quote' | 'thought'
  locator: string
  content: string
}

/** 书架的三档顺序：在读 → 想读 → 读完（与 §7.7 左栏一致） */
export const SHELF_STATUS_ORDER: ReadingStatus[] = ['reading', 'want', 'finished']

/** 状态归一：只认三档，其余一律当「想读」（与 `normalizeReadingRecord` 同一口径） */
export function normalizeStatus(value: unknown): ReadingStatus {
  if (value === 'reading' || value === 'finished' || value === 'want') return value
  return 'want'
}

/** 三档状态的显示文字（`想读` / `在读` / `读完`） */
export function statusLabel(value: unknown): string {
  return STATUS_LABELS[normalizeStatus(value)]
}

/** 格式的显示文字（`纸质书` / `电子书`） */
export function formatLabel(book: { format: Book['format'] }): string {
  return FORMAT_LABELS[book.format]
}

/**
 * 左栏书架行的顺序：三档分组**不打表头**，靠行里的状态字看得很清楚
 * （§7.7 的定稿图就是这样：`▣深 在读·43%`）。
 * 组内按最近更新倒序，与 `groupShelf()` 同一套口径。
 */
export function shelfRows<T extends { status: ReadingStatus; updatedAt?: string }>(
  books: T[]
): T[] {
  const rank = (status: ReadingStatus): number => SHELF_STATUS_ORDER.indexOf(normalizeStatus(status))
  return [...books].sort((a, b) => {
    const order = rank(a.status) - rank(b.status)
    if (order !== 0) return order
    return String(b.updatedAt ?? '').localeCompare(String(a.updatedAt ?? ''))
  })
}

/** 这本书下的章节树（顶层章 = `parentId === null`） */
export function nodesOfBook<T extends { ownerId: string }>(nodes: T[], bookId: string): T[] {
  if (bookId === '') return []
  return nodes.filter((node) => node.ownerId === bookId)
}

/**
 * 树里到底放什么：**只有 `kind: 'node'` 的章节**。
 *
 * 这条函数是"摘录不进树"（决定 24）的**唯一落点**：
 * 传进来的是整份 `data\reading.json` 的记录，出去的是能上树的节点。
 * 摘录 / 想法、阅读记录、书本身**都不会出现在结果里**——有单测钉着。
 */
export function readingTreeNodes(
  records: Array<Record<string, unknown>>
): ReadingNode[] {
  const out: ReadingNode[] = []
  for (const record of records) {
    // 回收站里的记录不上树（与 `splitReading` 同一口径）
    if (record['deletedAt'] !== undefined && record['deletedAt'] !== null) continue
    const normalized = normalizeReadingRecord(record)
    if (normalized === null) continue
    if (normalized.kind === 'node') out.push(normalized)
  }
  return out
}

/**
 * 书内完成度 = **读完的章 / 总章数**（只数最小单元，页码不参与）。
 *
 * 直接转调 `treeProgress()`——它与 `shared\reading.ts` 的 `chapterProgress()`
 * 是**同一个实现**，读书页不再写第二份。
 */
export function chapterStats(nodes: ReadingViewNode[]): LeafProgress {
  return treeProgress(nodes)
}

/** 进度条与左栏细线用的那一个数（0–100） */
export function bookPercent(nodes: ReadingViewNode[]): number {
  return chapterStats(nodes).percent
}

/** 预览里 `章节` 那一行的值：`3/7 章 · 43%`（数字与进度条同源） */
export function chapterProgressText(stats: LeafProgress): string {
  return `${stats.done}/${stats.total} 章 · ${stats.percent}%`
}

/** 左栏书架行的副标题：`在读 · 43%` */
export function shelfMetaText(book: { status: ReadingStatus }, nodes: ReadingViewNode[]): string {
  return `${statusLabel(book.status)} · ${bookPercent(nodes)}%`
}

/** 封面块里的那个字（纯色块 + 书名首字，不做图片上传） */
export function shelfCoverInitial(book: { title: string }): string {
  return coverInitial(book.title)
}

/** `读到 N/M 页`（纸质书）/ `32%`（电子书）——**只作参考，不参与进度** */
export function pageReferenceText(book: Book): string {
  return progressLabel(book)
}

/** 上一次阅读记录里的"读到哪了"（**传这本书的记录**；没有记录就是空串） */
export function lastReadSpot(records: ReadingViewRecord[]): string {
  const latest = sortByDateDesc(records)[0]
  if (latest === undefined) return ''
  if (latest.toPage !== undefined && latest.toPage > 0) return `上次读到 ${latest.toPage} 页`
  if (latest.percent !== undefined && latest.percent > 0) return `上次读到 ${latest.percent}%`
  return ''
}

/**
 * 进度条下面那句提示：把"页码只是参考"写在界面上，
 * 免得用户以为"读到 128 页 = 43%"（两者根本不是一回事）。
 */
export function spotNote(records: ReadingViewRecord[]): string {
  const spot = lastReadSpot(records)
  const base = '页码只作参考，完成度按章节算'
  return spot === '' ? base : `${base}（${spot}）`
}

/** 按日期倒序（同一天保持原有先后；不改变入参数组） */
export function sortByDateDesc<T extends { date: string }>(records: T[]): T[] {
  return [...records].sort((a, b) => (a.date === b.date ? 0 : a.date < b.date ? 1 : -1))
}

/** 这本书的阅读记录，按日期倒序 */
export function recordsOfBook<T extends ReadingViewRecord>(records: T[], bookId: string): T[] {
  if (bookId === '') return []
  return sortByDateDesc(records.filter((record) => record.bookId === bookId))
}

/** 这一章的阅读记录（只有"从章节里记"的那几条带 `nodeId`） */
export function recordsOfChapter<T extends ReadingViewRecord>(records: T[], nodeId: string): T[] {
  if (nodeId === '') return []
  return sortByDateDesc(records.filter((record) => record.nodeId === nodeId))
}

/**
 * 一条阅读记录的范围：`110–128 页` / `32%` / 空串。
 *
 * 电子书只有百分比、纸质书可能只填了到第几页——两种情况都要能显示，
 * 缺一个数就少写一段，别硬凑成 `0–0 页`。
 */
export function recordPagesText(record: {
  fromPage?: number
  toPage?: number
  percent?: number
}): string {
  const to = record.toPage !== undefined ? record.toPage : 0
  if (to > 0) {
    const from = record.fromPage !== undefined ? record.fromPage : 0
    return from > 0 && from !== to ? `${from}–${to} 页` : `读到 ${to} 页`
  }
  if (record.percent !== undefined && record.percent > 0) return `${record.percent}%`
  return ''
}

/** 这条记录挂在哪一章上（书级记录返回空串） */
export function recordOwnerText(record: ReadingViewRecord, nodes: ReadingViewNode[]): string {
  const nodeId = record.nodeId ?? ''
  if (nodeId === '') return ''
  const node = nodes.find((candidate) => candidate.id === nodeId)
  return node === undefined ? '' : `挂在「${node.title}」`
}

/** 阅读记录的汇总：`6 次 · 185 分钟` */
export function recordsSummary(records: ReadingViewRecord[]): {
  count: number
  minutes: number
  text: string
} {
  const count = records.length
  const minutes = records.reduce(
    (sum, record) => sum + Math.max(0, Math.round(record.minutes || 0)),
    0
  )
  return { count, minutes, text: `${count} 次 · ${minutes} 分钟` }
}

/** 摘录与想法的计数：`3 / 1`（原文 / 想法） */
export function excerptCounts(excerpts: ReadingViewExcerpt[]): {
  quotes: number
  thoughts: number
  text: string
} {
  const quotes = excerpts.filter((excerpt) => excerpt.type === 'quote').length
  const thoughts = excerpts.length - quotes
  return { quotes, thoughts, text: `${quotes} / ${thoughts}` }
}

/** 摘录的分类标签（`原文` / `想法`） */
export function excerptTypeLabel(type: 'quote' | 'thought'): string {
  return type === 'quote' ? '原文' : '想法'
}

/** 这本书的摘录与想法，按页码倒序（§7.7：留在中区列表里按页码看） */
export function excerptsOfBook<T extends { bookId: string; locator: string; createdAt?: string }>(
  excerpts: T[],
  bookId: string
): T[] {
  if (bookId === '') return []
  return sortExcerpts(excerpts.filter((excerpt) => excerpt.bookId === bookId))
}

/**
 * 预览左侧信息卡上的六行（§7.7）：
 * 作者 / 格式 / 读到 N/M 页 / 章节 n/m 章 / 阅读记录 / 摘录·想法。
 */
export interface BookPreviewFacts {
  author: string
  format: string
  /** `128/320 页`（电子书 `32%`）——**只作参考** */
  pages: string
  /** `3/7 章` */
  chapters: string
  /** 进度条上那个百分数 */
  percent: number
  /** `6 次 · 185 分钟` */
  records: string
  /** `3 / 1` */
  notes: string
}

export function bookPreviewFacts(
  book: Book,
  nodes: ReadingViewNode[],
  records: ReadingViewRecord[],
  excerpts: ReadingViewExcerpt[]
): BookPreviewFacts {
  const stats = chapterStats(nodes)
  return {
    author: book.author.trim() === '' ? '未填作者' : book.author,
    format: formatLabel(book),
    pages: pageReferenceText(book),
    chapters: `${stats.done}/${stats.total} 章`,
    percent: stats.percent,
    records: recordsSummary(records).text,
    notes: excerptCounts(excerpts).text
  }
}

/**
 * 树上一行右侧的补充信息（§7.7 的定稿图：汇总章 `2/2`、最小单元 `读到 p.128`）。
 *
 * 汇总章（有子节点）显示"下面勾了几个"；最小单元显示它自己的页码备注。
 * 两样都没有就返回 `null`（树会留空，不显示一格假数据）。
 */
export function chapterRowProgress(node: ReadingViewNode, nodes: ReadingViewNode[]): string | null {
  const hasChild = nodes.some((candidate) => candidate.parentId === node.id)
  if (hasChild) {
    const inner = leafProgress(nodes, node.id)
    return `${inner.done}/${inner.total}`
  }
  const note = (node.note ?? '').trim()
  return note === '' ? null : `读到 ${note}`
}

/**
 * 三步走的判定（决定 1 / §6.7）：**与学习页那条是同一个判据**。
 *
 * 「进入书」不是路由，也不整页替换：它只决定**下方树那一段显不显示**。
 * 换一本书（id 对不上）自动回到"未进入"。
 */
export function isBookEntered(enteredId: string | null, selectedId: string | null): boolean {
  return isTopicEntered(enteredId, selectedId)
}

/**
 * 树行的缩进（§7.2 / `docs\TASKS\02` §5.3）：**第 5 层起 12px**。
 *
 * 直接转调 `indentForDepth()`——读书树与学习树共用同一条缩进规则，
 * 页面里不许再写一遍 `depth * 20`。
 */
export function readingIndent(depth: number): number {
  return indentForDepth(depth)
}
