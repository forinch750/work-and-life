/**
 * 读书模块的数据模型与逻辑（DEVPLAN 阶段 6 / PRD §5.5）
 *
 * 与"学习"刻意保持独立：两边数据库互不引用，书籍详情里没有任何指向学习模块的入口。
 *
 * 四类记录都放在 data\reading.json 里，用 kind 区分：
 *   book     书籍
 *   progress 阅读记录（日期、时长、页码范围）
 *   excerpt  摘录与想法（含页码）
 *   node     树节点（书 → 章 → 子章）—— v2 起新增
 *
 * v2 的树：书本身仍是一条 `book` 记录（不是根节点），章节是 `node` 记录，
 * `ownerId` = **书 id**。书内完成度 = 读完的章 / 总章数；
 * 页码（读到 128/320）只作"读到哪了"的参考显示。
 *
 * > ⚠️ **摘录与想法不进树**：它永远不打勾，当叶子算会让进度永远偏低（已实测踩过）。
 */
import type { BaseRecord } from './types'
import type { ContentFormat } from './richText'
import { toPlainText } from './richText'
import { treeProgress } from './treeProgress'

export type ReadingStatus = 'want' | 'reading' | 'finished'
export type BookFormat = 'paper' | 'ebook'

export const STATUS_LABELS: Record<ReadingStatus, string> = {
  want: '想读',
  reading: '在读',
  finished: '读完'
}

export const FORMAT_LABELS: Record<BookFormat, string> = {
  paper: '纸质书',
  ebook: '电子书'
}

export interface Book extends BaseRecord {
  kind: 'book'
  title: string
  author: string
  format: BookFormat
  status: ReadingStatus
  /** 纸质书：总页数；电子书此字段为 0 */
  totalPages: number
  /** 纸质书：当前页；电子书为 0 */
  currentPage: number
  /** 电子书：百分比 0–100；纸质书为 0 */
  percent: number
  /** 读完日期 YYYY-MM-DD */
  finishedAt: string | null
  /** 评分 1–5，未评为 0 */
  rating: number
  /** 一句话总评 */
  review: string
  tags?: string[]
  /** 总评正文的格式标记：缺省即 plain（旧数据零改写） */
  contentFormat?: ContentFormat
}

export interface ReadingProgress extends BaseRecord {
  kind: 'progress'
  bookId: string
  date: string
  minutes: number
  /** 本次从第几页读到第几页（纸质书） */
  fromPage?: number
  toPage?: number
  /** 电子书本次读到的百分比 */
  percent?: number
  /**
   * 这一条是**从哪一章记下来的**（第 11 块新增的**可选**字段）。
   *
   * 与学习日志挂在章节上（决定 16）是同一套做法：只有在章节里点「记一次阅读」
   * 才会写它；从书本身记的、以及所有旧记录**都不写这个键**——
   * 于是旧数据零改写、**不需要迁移**，`ReadingNode` / `Book` / `Excerpt` 的字段一个没动。
   * 章节就地展开时按它筛出"该章的阅读记录"。
   */
  nodeId?: string
}

export interface Excerpt extends BaseRecord {
  kind: 'excerpt'
  bookId: string
  /** 原文 或 想法 */
  type: 'quote' | 'thought'
  /** 页码（纸质书）或百分比（电子书） */
  locator: string
  content: string
  /** 正文格式标记：缺省即 plain（旧数据零改写），新记录写 rich */
  contentFormat?: ContentFormat
}

/**
 * 书的树节点（书 → 章 → 子章）。字段与 tree.ts 的 `TreeNode` 对齐，
 * `ownerId` = **书 id**（跨 owner 移动必须拒绝）。
 *
 * 书的进度改为**按章节算**：读完的章 / 总章数。页码只作参考显示。
 */
export interface ReadingNode extends BaseRecord {
  kind: 'node'
  /** 所属的书 id */
  ownerId: string
  parentId: string | null
  /** 同级内排序，从 0 开始 */
  order: number
  title: string
  done: boolean
  /** 正文格式标记：缺省即 plain（旧数据零改写） */
  contentFormat?: ContentFormat
  /** 章节上的备注（引用页码等） */
  note?: string
}

export type ReadingRecord = Book | ReadingProgress | Excerpt | ReadingNode

export function isBook(record: ReadingRecord): record is Book {
  return record.kind === 'book'
}
export function isProgress(record: ReadingRecord): record is ReadingProgress {
  return record.kind === 'progress'
}
export function isExcerpt(record: ReadingRecord): record is Excerpt {
  return record.kind === 'excerpt'
}
export function isReadingNode(record: ReadingRecord): record is ReadingNode {
  return record.kind === 'node'
}

export function isReadingStatus(value: unknown): value is ReadingStatus {
  return value === 'want' || value === 'reading' || value === 'finished'
}

export function isBookFormat(value: unknown): value is BookFormat {
  return value === 'paper' || value === 'ebook'
}

/** 把数字夹到指定范围 */
function clampInt(value: unknown, min: number, max: number): number {
  const parsed = typeof value === 'number' ? value : Number.parseInt(String(value ?? ''), 10)
  if (!Number.isFinite(parsed)) return min
  return Math.min(max, Math.max(min, Math.round(parsed)))
}

/** 书卡上的进度显示：纸质书 "128/320 页"，电子书 "32%" */
export function progressLabel(book: Book): string {
  if (book.format === 'ebook') return `${book.percent}%`
  if (book.totalPages <= 0) return book.currentPage > 0 ? `第 ${book.currentPage} 页` : '未开始'
  return `${book.currentPage}/${book.totalPages} 页`
}

/** 读到哪里（0–100），用于书卡进度条 */
export function progressPercent(book: Book): number {
  if (book.format === 'ebook') return clampInt(book.percent, 0, 100)
  if (book.totalPages <= 0) return book.currentPage > 0 ? 100 : 0
  return clampInt(Math.round((book.currentPage / book.totalPages) * 100), 0, 100)
}

/** 更新进度：纸质书按页算，电子书按百分比算，两者互不干扰 */
export function applyProgressUpdate(
  book: Book,
  update: { page?: number; percent?: number }
): Partial<Book> {
  if (book.format === 'paper') {
    const total = book.totalPages > 0 ? book.totalPages : Number.MAX_SAFE_INTEGER
    const page = clampInt(update.page ?? book.currentPage, 0, total)
    return { currentPage: page }
  }
  return { percent: clampInt(update.percent ?? book.percent, 0, 100) }
}

/** 读完时的补正：状态、日期与进度一起写 */
export function finishPatch(
  dateKey: string,
  rating: number,
  review: string
): Partial<Book> {
  return {
    status: 'finished',
    finishedAt: dateKey,
    rating: clampInt(rating, 0, 5),
    review: review.trim()
  }
}

/** 书封面用纯色块 + 书名首字生成（不做图片上传） */
export function coverInitial(title: string): string {
  const trimmed = title.trim()
  if (trimmed === '') return '书'
  return trimmed.slice(0, 1)
}

/** 由书名稳定派生一个色相，保证同一本书每次颜色一致 */
export function coverHue(title: string): number {
  let hash = 0
  for (let index = 0; index < title.length; index += 1) {
    hash = (hash * 31 + title.charCodeAt(index)) % 360
  }
  return hash
}

export interface ShelfGroups {
  reading: Book[]
  want: Book[]
  finished: Book[]
}

/** 按状态分组，组内按最近更新倒序 */
export function groupShelf(books: Book[]): ShelfGroups {
  const byUpdated = (a: Book, b: Book): number =>
    String(b.updatedAt).localeCompare(String(a.updatedAt))
  return {
    reading: books.filter((book) => book.status === 'reading').sort(byUpdated),
    want: books.filter((book) => book.status === 'want').sort(byUpdated),
    finished: books.filter((book) => book.status === 'finished').sort(byUpdated)
  }
}

/** 一组统计：在读几本、读完几本、本月阅读分钟数 */
export interface ShelfStats {
  reading: number
  want: number
  finished: number
  finishedThisMonth: number
  minutesThisMonth: number
}

export function shelfStats(
  books: Book[],
  progress: ReadingProgress[],
  monthKey: string
): ShelfStats {
  const inMonth = (dateKey: string): boolean => dateKey.slice(0, 7) === monthKey
  return {
    reading: books.filter((book) => book.status === 'reading').length,
    want: books.filter((book) => book.status === 'want').length,
    finished: books.filter((book) => book.status === 'finished').length,
    finishedThisMonth: books.filter(
      (book) => book.status === 'finished' && book.finishedAt !== null && inMonth(book.finishedAt)
    ).length,
    minutesThisMonth: progress
      .filter((item) => inMonth(item.date))
      .reduce((sum, item) => sum + item.minutes, 0)
  }
}

/** 阅读时长的可读形式：8 小时 20 分 */
export function formatMinutes(minutes: number): string {
  if (minutes <= 0) return '0 分钟'
  const hours = Math.floor(minutes / 60)
  const rest = minutes % 60
  if (hours === 0) return `${rest} 分钟`
  if (rest === 0) return `${hours} 小时`
  return `${hours} 小时 ${rest} 分`
}

/**
 * 摘录排序：按页码/位置倒序（纸质书按页号，电子书按百分比）。
 *
 * 泛型化的原因：读书页的"视图层"（`readingPageView.ts`）只需要 `locator` 与
 * `createdAt` 这两项就能排序，不必把整个 `Excerpt` 搬过去；规则本身**仍只有这一份**。
 */
export function sortExcerpts<T extends { locator: string; createdAt?: string }>(excerpts: T[]): T[] {
  const toNumber = (locator: string): number => {
    const match = locator.match(/\d+/)
    return match ? Number.parseInt(match[0], 10) : 0
  }
  return [...excerpts].sort((a, b) => {
    const diff = toNumber(b.locator) - toNumber(a.locator)
    if (diff !== 0) return diff
    return String(b.createdAt ?? '').localeCompare(String(a.createdAt ?? ''))
  })
}

/** 摘录 → 复习卡的正反面（富文本先抽纯文本，否则 HTML 标签会漏进卡片） */
export function excerptToCard(
  excerpt: Excerpt,
  bookTitle: string
): { front: string; back: string; source: string } {
  const content = toPlainText(excerpt.content, excerpt.contentFormat)
  return {
    front: excerpt.type === 'quote' ? content : `《${bookTitle}》${excerpt.locator}：${content}`,
    back: excerpt.type === 'quote' ? `出自《${bookTitle}》${excerpt.locator}` : `《${bookTitle}》`,
    source: bookTitle
  }
}

/**
 * 书内完成度 = 读完的**章** / 总章数（v2 起进度**按章节算**）。
 * 页码（读到 128/320）只作参考显示，不再参与完成度。
 *
 * "章"的判据与 `MASTER.md` §7.9 一致：**最小单元 = 没有子节点的节点**。
 * 有子节点的章只做汇总（界面上是虚线框），不计入分母——
 * 否则"父章勾了、子节没勾"会凭空把完成度抬高一截。
 * 实现直接复用 `treeProgress.leafProgress`，与学习主题那边的口径保持同一套。
 */
export function chapterProgress(nodes: ReadingNode[]): { done: number; total: number; percent: number } {
  return treeProgress(nodes)
}

/** 把任意记录规范成读书记录；无法识别时返回 null */
export function normalizeReadingRecord(input: Record<string, unknown>): ReadingRecord | null {
  const id = String(input['id'] ?? '')
  if (id === '') return null
  const base = {
    id,
    createdAt: String(input['createdAt'] ?? ''),
    updatedAt: String(input['updatedAt'] ?? ''),
    ...(typeof input['deletedAt'] === 'string' ? { deletedAt: input['deletedAt'] } : {})
  }
  const kind = input['kind']

  if (kind === 'book') {
    const tags = Array.isArray(input['tags'])
      ? (input['tags'] as unknown[])
          .filter((tag): tag is string => typeof tag === 'string')
          .map((tag) => tag.trim())
          .filter((tag) => tag !== '')
      : []
    return {
      ...base,
      kind: 'book',
      title: String(input['title'] ?? '').trim(),
      author: String(input['author'] ?? '').trim(),
      format: isBookFormat(input['format']) ? input['format'] : 'paper',
      status: isReadingStatus(input['status']) ? input['status'] : 'want',
      totalPages: clampInt(input['totalPages'], 0, 100000),
      currentPage: clampInt(input['currentPage'], 0, 100000),
      percent: clampInt(input['percent'], 0, 100),
      finishedAt: typeof input['finishedAt'] === 'string' && input['finishedAt'] !== '' ? input['finishedAt'] : null,
      rating: clampInt(input['rating'], 0, 5),
      review: String(input['review'] ?? '').trim(),
      ...(tags.length > 0 ? { tags } : {}),
      // 缺省不写：旧记录保持"没有这个字段"，即按 plain 处理（零改写）
      ...(input['contentFormat'] === 'rich' ? { contentFormat: 'rich' as const } : {})
    }
  }

  if (kind === 'progress') {
    const fromPage = clampInt(input['fromPage'], 0, 100000)
    const toPage = clampInt(input['toPage'], 0, 100000)
    const percent = clampInt(input['percent'], 0, 100)
    const nodeId = typeof input['nodeId'] === 'string' ? input['nodeId'].trim() : ''
    return {
      ...base,
      kind: 'progress',
      bookId: String(input['bookId'] ?? ''),
      date: String(input['date'] ?? ''),
      minutes: clampInt(input['minutes'], 0, 1440),
      ...(toPage > 0 ? { fromPage, toPage } : {}),
      ...(percent > 0 ? { percent } : {}),
      // 缺省不写：旧记录保持"没有这个字段"（= 书级记录，零改写）
      ...(nodeId !== '' ? { nodeId } : {})
    }
  }

  if (kind === 'excerpt') {
    return {
      ...base,
      kind: 'excerpt',
      bookId: String(input['bookId'] ?? ''),
      type: input['type'] === 'quote' ? 'quote' : 'thought',
      locator: String(input['locator'] ?? '').trim(),
      content: String(input['content'] ?? '').trim(),
      ...(input['contentFormat'] === 'rich' ? { contentFormat: 'rich' as const } : {})
    }
  }

  if (kind === 'node') {
    const parent = input['parentId']
    const parentId = typeof parent === 'string' && parent !== '' ? parent : null
    return {
      ...base,
      kind: 'node',
      ownerId: String(input['ownerId'] ?? input['bookId'] ?? ''),
      parentId: parentId === id ? null : parentId,
      order: clampInt(input['order'], 0, 100000),
      title: String(input['title'] ?? '').trim(),
      done: input['done'] === true,
      ...(input['contentFormat'] === 'rich' ? { contentFormat: 'rich' as const } : {}),
      ...(typeof input['note'] === 'string' && input['note'] !== '' ? { note: input['note'] } : {})
    }
  }

  return null
}
