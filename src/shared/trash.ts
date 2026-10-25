/**
 * 回收站的纯逻辑（第二轮 FEAT-009）
 *
 * 设计要点（用户已确认）：
 *   - 回收站**只针对单个条目**：某个学习主题、某本书、某条备忘不要了，先扔进去以防万一
 *   - **"清空全部数据"不属于回收站**，它是物理删除（唯一例外）
 *   - **不新增数据文件**：复用既有的软删除（remove() 只打 deletedAt 标记，
 *     记录仍留在原模块文件里，list() 过滤掉、all() 取得到）
 *     于是"恢复"只需清掉标记，天然回到原位置，不会出现两份数据不一致
 *
 * 这里只算"哪些记录在回收站里、怎么显示、哪些该清理"，不碰存储。
 */

import type { DataModule } from './modules'
import { toPlainText } from './richText'

/** 回收站保留期限的取值：7 天 / 30 天 / 永久保留 / 自定义天数 */
export const TRASH_KEEP_DAYS_OPTIONS = [7, 30, 36500] as const
/** 永久保留用的天数（约 100 年，等价于不清理） */
export const TRASH_KEEP_FOREVER_DAYS = 36500
/** 默认保留 30 天 */
export const DEFAULT_TRASH_KEEP_DAYS = 30

/** 一条回收站条目 */
export interface TrashEntry {
  module: DataModule
  id: string
  /** 删除时间（ISO） */
  deletedAt: string
  /** 数据类型的中文名，例如「学习主题」「备忘」 */
  typeLabel: string
  /** 列表里显示的主文本 */
  title: string
  /** 原位置说明，例如「学习 → 主题」 */
  origin: string
}

/** 模块 → 该模块记录的类型判别结果 */
interface TypeInfo {
  label: string
  origin: string
  /** 取显示用的标题 */
  title: (record: Record<string, unknown>) => string
}

/**
 * 正文类记录的回收站标题。
 *
 * 第 04 块起正文可能是富文本 HTML，直接取原文会让回收站里显示
 * `<p>第一行</p>` 这种东西。所以先抽纯文本（plain 记录原样返回）。
 */
function plainTitle(record: Record<string, unknown>, key: string): string {
  return toPlainText(record[key], record['contentFormat'])
}

const LEARNING: Record<string, TypeInfo> = {
  topic: {
    label: '学习主题',
    origin: '学习 → 主题',
    title: (r) => String(r['title'] ?? '')
  },
  resource: {
    label: '学习资料',
    origin: '学习 → 资料',
    title: (r) => String(r['name'] ?? '')
  },
  log: {
    label: '学习日志',
    origin: '学习 → 学习日志',
    title: (r) => plainTitle(r, 'content')
  },
  node: {
    label: '章节节点',
    origin: '学习 → 章节',
    title: (r) => String(r['title'] ?? '')
  }
}

const READING: Record<string, TypeInfo> = {
  book: { label: '书籍', origin: '读书 → 书架', title: (r) => String(r['title'] ?? '') },
  progress: {
    label: '阅读记录',
    origin: '读书 → 阅读记录',
    title: (r) => String(r['date'] ?? '')
  },
  excerpt: {
    label: '摘录',
    origin: '读书 → 摘录',
    title: (r) => plainTitle(r, 'content')
  },
  node: { label: '章节节点', origin: '读书 → 章节', title: (r) => String(r['title'] ?? '') }
}

const FALLBACK: TypeInfo = {
  label: '条目',
  origin: '未知位置',
  title: (r) => String(r['id'] ?? '')
}

/**
 * 判断一条记录在回收站里叫什么、原来在哪、标题是什么。
 *
 * 各模块的记录形状不同（kind / 有无 title），所以按模块分别判别；
 * 无法判别时退回通用文案，而不是丢弃——回收站里宁可显示得粗糙，也不能少东西。
 */
export function describeEntry(module: DataModule, record: Record<string, unknown>): TypeInfo {
  const kind = String(record['kind'] ?? '')

  if (module === 'learning') return LEARNING[kind] ?? FALLBACK
  if (module === 'reading') return READING[kind] ?? FALLBACK
  if (module === 'plan') {
    return { label: '任务', origin: '计划', title: (r) => String(r['title'] ?? '') }
  }
  if (module === 'memo') {
    return { label: '备忘', origin: '备忘录', title: (r) => plainTitle(r, 'text') }
  }
  if (module === 'review') {
    return { label: '复习卡', origin: '复习', title: (r) => String(r['front'] ?? '') }
  }
  return FALLBACK
}

/** 已删除的记录（deletedAt 有值） */
export function isDeleted(record: Record<string, unknown>): boolean {
  const value = record['deletedAt']
  return typeof value === 'string' && value !== ''
}

/** 把一条记录转成回收站条目；未删除则返回 null */
export function toTrashEntry(
  module: DataModule,
  record: Record<string, unknown>
): TrashEntry | null {
  if (!isDeleted(record)) return null
  const info = describeEntry(module, record)
  const rawTitle = info.title(record).trim()
  const title = rawTitle === '' ? '（无标题）' : rawTitle.length > 60 ? `${rawTitle.slice(0, 60)}…` : rawTitle
  return {
    module,
    id: String(record['id'] ?? ''),
    deletedAt: String(record['deletedAt']),
    typeLabel: info.label,
    title,
    origin: info.origin
  }
}

/**
 * 汇总各模块的已删除记录，按删除时间倒序（最近删的在最上面）。
 * input 的键是模块名，值是该模块的全部记录（含已删除）。
 */
export function collectTrash(
  input: Partial<Record<DataModule, Array<Record<string, unknown>>>>
): TrashEntry[] {
  const entries: TrashEntry[] = []
  for (const [module, records] of Object.entries(input)) {
    if (!Array.isArray(records)) continue
    for (const record of records) {
      const entry = toTrashEntry(module as DataModule, record)
      if (entry !== null && entry.id !== '') entries.push(entry)
    }
  }
  return entries.sort((a, b) => (a.deletedAt < b.deletedAt ? 1 : a.deletedAt > b.deletedAt ? -1 : 0))
}

/**
 * 算出哪些条目已经超过保留期限，应当彻底删除。
 *
 * keepDays 为 TRASH_KEEP_FOREVER_DAYS（或更大）时视为永久保留，返回空数组。
 * 删除时间无法解析的记录**不清理**——宁可留着，也不要因为一个坏字段就把数据删掉。
 */
export function expiredEntries(entries: TrashEntry[], keepDays: number, now: Date): TrashEntry[] {
  if (keepDays >= TRASH_KEEP_FOREVER_DAYS) return []
  if (keepDays <= 0) return entries
  const cutoff = now.getTime() - keepDays * 24 * 60 * 60 * 1000
  return entries.filter((entry) => {
    const at = Date.parse(entry.deletedAt)
    if (Number.isNaN(at)) return false
    return at < cutoff
  })
}

/** 保留期限的中文说明，供设置页与确认弹窗使用 */
export function keepDaysLabel(keepDays: number): string {
  if (keepDays >= TRASH_KEEP_FOREVER_DAYS) return '永久保留'
  return `${keepDays} 天`
}

/** 回收站的空状态文案 */
export function emptyTrashHint(): string {
  return '回收站是空的。删除的内容会先放到这里，确认不需要了再彻底删除。'
}
