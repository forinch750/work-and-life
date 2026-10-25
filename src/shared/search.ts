/**
 * 全局搜索（DEVPLAN 阶段 6 / PRD §2.6）
 *
 * 跨模块搜索：计划 / 学习 / 复习 / 读书 / 备忘，结果按模块分组。
 * 纯逻辑放在共享层，界面与验收共用同一套规则。
 *
 * ## 富文本（第 04 块）：匹配前先抽纯文本
 *
 * 正文从第 04 块起可能是 HTML。若不先 `toPlainText`，会出现两种明显的错：
 *   1. 搜 `<` 或 `b` 会命中标签本身（用户搜的是内容，不是标签）
 *   2. 命中结果的标题会带着 `<p>` `<b>` 一起显示出来
 * 所以凡是"正文类"字段，一律先过 `toPlainText` 再匹配、再截断成标题。
 * `plain` 记录（含没有 `contentFormat` 的旧记录）原样返回，行为与以前完全一致。
 *
 * 注意：读书与学习是两个独立分组，互不合并、互不推荐。
 */
import { dateKey } from './date'
import { normalizePlanTask } from './plan'
import { normalizeReviewCard } from './review'
import { normalizeReadingRecord, type Book, type Excerpt } from './reading'
import { normalizeLearningRecord, type LearningLog, type LearningTopic } from './learning'
import { toPlainText } from './richText'
import { memoPlainText } from './memo'

export type SearchModule = 'plan' | 'memo' | 'learning' | 'review' | 'reading'

export const SEARCH_MODULE_LABELS: Record<SearchModule, string> = {
  plan: '计划',
  memo: '备忘',
  learning: '学习',
  review: '复习',
  reading: '读书'
}

export interface SearchHit {
  module: SearchModule
  /** 记录 id，用于跳转定位 */
  id: string
  /** 命中行的主文本 */
  title: string
  /** 附加说明（日期、来源等） */
  meta: string
}

export interface SearchGroup {
  module: SearchModule
  label: string
  hits: SearchHit[]
}

export interface SearchInput {
  plan?: Array<Record<string, unknown>>
  memo?: Array<Record<string, unknown>>
  learning?: Array<Record<string, unknown>>
  review?: Array<Record<string, unknown>>
  reading?: Array<Record<string, unknown>>
}

/** 匹配规则：忽略大小写、忽略首尾空格；空关键词不返回任何结果 */
export function matches(text: string, keyword: string): boolean {
  if (keyword === '') return false
  return text.toLowerCase().includes(keyword.toLowerCase())
}

function isAlive(record: Record<string, unknown>): boolean {
  return record['deletedAt'] === undefined || record['deletedAt'] === null
}

/** 每个模块最多显示多少条（避免一个模块刷屏） */
export const HITS_PER_MODULE = 20

export function searchAll(input: SearchInput, rawKeyword: string): SearchGroup[] {
  const keyword = rawKeyword.trim()
  if (keyword === '') return []

  const groups: SearchGroup[] = []

  // ---- 计划：搜任务标题 ----
  const planHits: SearchHit[] = []
  for (const record of input.plan ?? []) {
    if (!isAlive(record)) continue
    const task = normalizePlanTask(record)
    if (task.id === '' || task.title === '') continue
    if (!matches(task.title, keyword)) continue
    planHits.push({
      module: 'plan',
      id: task.id,
      title: task.title,
      meta: task.done ? `${task.date} · 已完成` : task.date
    })
  }
  if (planHits.length > 0) {
    groups.push({ module: 'plan', label: SEARCH_MODULE_LABELS.plan, hits: planHits.slice(0, HITS_PER_MODULE) })
  }

  // ---- 备忘：搜正文（富文本先抽纯文本） ----
  const memoHits: SearchHit[] = []
  for (const record of input.memo ?? []) {
    if (!isAlive(record)) continue
    const text = memoPlainText(record)
    if (text === '' || !matches(text, keyword)) continue
    memoHits.push({
      module: 'memo',
      id: String(record['id'] ?? ''),
      title: text.length > 80 ? `${text.slice(0, 80)}…` : text,
      meta: String(record['createdAt'] ?? '').slice(0, 10)
    })
  }
  if (memoHits.length > 0) {
    groups.push({ module: 'memo', label: SEARCH_MODULE_LABELS.memo, hits: memoHits.slice(0, HITS_PER_MODULE) })
  }

  // ---- 学习：搜主题标题与日志内容 ----
  const learningHits: SearchHit[] = []
  for (const record of input.learning ?? []) {
    if (!isAlive(record)) continue
    const normalized = normalizeLearningRecord(record)
    if (!normalized) continue
    if (normalized.kind === 'topic') {
      const topic = normalized as LearningTopic
      if (topic.title !== '' && matches(topic.title, keyword)) {
        learningHits.push({
          module: 'learning',
          id: topic.id,
          title: topic.title,
          meta: `主题 · 进度 ${topic.progress}%`
        })
      }
    } else if (normalized.kind === 'log') {
      const log = normalized as LearningLog
      // 富文本日志先抽纯文本（否则搜"b"会命中标签、标题里也会露出 <p>）
      const content = toPlainText(log.content, log.contentFormat)
      if (content !== '' && matches(content, keyword)) {
        learningHits.push({
          module: 'learning',
          id: log.id,
          title: content.length > 80 ? `${content.slice(0, 80)}…` : content,
          meta: `学习日志 · ${log.date} · ${log.minutes} 分钟`
        })
      }
    }
  }
  if (learningHits.length > 0) {
    groups.push({
      module: 'learning',
      label: SEARCH_MODULE_LABELS.learning,
      hits: learningHits.slice(0, HITS_PER_MODULE)
    })
  }

  // ---- 复习：搜正面与背面 ----
  const reviewHits: SearchHit[] = []
  for (const record of input.review ?? []) {
    if (!isAlive(record)) continue
    const card = normalizeReviewCard(record)
    if (!card || card.front === '') continue
    if (!matches(card.front, keyword) && !matches(card.back, keyword)) continue
    reviewHits.push({
      module: 'review',
      id: card.id,
      title: card.front.length > 80 ? `${card.front.slice(0, 80)}…` : card.front,
      meta: `${card.source} · 已复习 ${card.reviewCount} 次`
    })
  }
  if (reviewHits.length > 0) {
    groups.push({ module: 'review', label: SEARCH_MODULE_LABELS.review, hits: reviewHits.slice(0, HITS_PER_MODULE) })
  }

  // ---- 读书：搜书名、作者、摘录原文与想法 ----
  const readingHits: SearchHit[] = []
  for (const record of input.reading ?? []) {
    if (!isAlive(record)) continue
    const normalized = normalizeReadingRecord(record)
    if (!normalized) continue
    if (normalized.kind === 'book') {
      const book = normalized as Book
      if (book.title === '') continue
      if (matches(book.title, keyword) || matches(book.author, keyword)) {
        readingHits.push({
          module: 'reading',
          id: book.id,
          title: book.title,
          meta: `${book.author || '未填作者'} · ${book.status === 'finished' ? '读完' : book.status === 'reading' ? '在读' : '想读'}`
        })
      }
    } else if (normalized.kind === 'excerpt') {
      const excerpt = normalized as Excerpt
      // 富文本摘录先抽纯文本（与日志同理）
      const content = toPlainText(excerpt.content, excerpt.contentFormat)
      if (content === '' || !matches(content, keyword)) continue
      readingHits.push({
        module: 'reading',
        id: excerpt.id,
        title: content.length > 80 ? `${content.slice(0, 80)}…` : content,
        meta: `摘录 ${excerpt.locator}`
      })
    }
  }
  if (readingHits.length > 0) {
    groups.push({ module: 'reading', label: SEARCH_MODULE_LABELS.reading, hits: readingHits.slice(0, HITS_PER_MODULE) })
  }

  return groups
}

/** 总命中数 */
export function totalHits(groups: SearchGroup[]): number {
  return groups.reduce((sum, group) => sum + group.hits.length, 0)
}

/** 结果摘要文字 */
export function summarizeGroups(groups: SearchGroup[]): string {
  if (groups.length === 0) return '没有找到匹配的内容'
  return groups.map((group) => `${group.label} ${group.hits.length} 条`).join(' / ')
}

/** 搜索时用到的今天（便于测试注入） */
export function searchToday(now: Date = new Date()): string {
  return dateKey(now)
}
