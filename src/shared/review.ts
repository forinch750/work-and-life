/**
 * 复习卡模型与间隔算法（DEVPLAN 阶段 5 / PRD §5.4）
 *
 * 只有三个评分档，按钮上直接写"下次什么时候再考你"：
 *   忘了     → 1 天
 *   有点模糊 → 3 天
 *   记住了   → 7 天起逐级放大
 *
 * 三档间隔会按设置里的"复习间隔强度"整体缩放：
 *   宽松 ×1.5（间隔更长，复习更少）
 *   标准 ×1.0
 *   密集 ×0.6（间隔更短，复习更勤）
 *
 * v2 新增（都是**可选**字段，旧卡片零改写）：
 *   - `dueTime`：卡片也能定到具体时间（"HH:mm"）
 *   - `topicId` / `nodeId`：卡片能归属到**主题**与**章节**
 *   - 另一种记录 `kind: 'history'`：复习历史（每张卡保留最近 50 次）
 */
import type { BaseRecord } from './types'
import type { ReviewIntensity } from './preferences'
import { intensityMultiplier } from './preferences'
import { isTimeOfDay } from './plan'

/** 评分档位 */
export type ReviewGrade = 'forgot' | 'fuzzy' | 'remembered'

export const GRADE_LABELS: Record<ReviewGrade, string> = {
  forgot: '忘了',
  fuzzy: '有点模糊',
  remembered: '记住了'
}

export function isReviewGrade(value: unknown): value is ReviewGrade {
  return value === 'forgot' || value === 'fuzzy' || value === 'remembered'
}

/** 各档的基础间隔（天） */
export const BASE_INTERVALS: Record<ReviewGrade, number> = {
  forgot: 1,
  fuzzy: 3,
  remembered: 7
}

/** "记住了"多次之后，间隔逐级放大到这些天数 */
export const REMEMBERED_LADDER = [7, 14, 30, 60, 120]

/** 卡片状态里的阶段编号（stage）对应到阶梯的位置 */
export interface ReviewCard extends BaseRecord {
  /**
   * 记录种类。v1 的旧卡片**没有这个字段**，因此是可选；
   * 缺省即按卡片处理（零改写）。只有 `'history'` 是另一种记录。
   */
  kind?: 'card'
  front: string
  back: string
  /** 来源描述，例如"英语长难句"或"备忘" */
  source: string
  /** 连续记住的层数，0 表示新卡或刚忘过 */
  stage: number
  /** 下次到期日 YYYY-MM-DD；null 表示今天就要复习 */
  dueDate: string | null
  /** 下次到期时间 "HH:mm"（可选）；只管排序展示，不参与到期日判断 */
  dueTime?: string
  reviewCount: number
  lastReviewedAt: string | null
  /** 归属的学习主题 id（可选） */
  topicId?: string
  /** 归属的章节节点 id（可选，配合 topicId 定位到"哪一节"） */
  nodeId?: string
  /** 归属的书 id（可选；读书生成的卡片用它归属到书） */
  bookId?: string
}

/**
 * 一条复习历史（v2 新增的第二种 review 记录）。
 *
 * 字段与 `GradeOutcome`（applyGrade 的返回值）一一对应：
 *   评分一次 → 落一条历史 → 复习页的"历史"分区按 `at` 倒序显示
 *
 * 粒度已定：**每张卡保留最近 50 次**，更早的自动丢弃
 * （全量会无限增长；50 次足够看出"背了几遍、哪个档位反复出现"）。
 */
export interface ReviewHistory extends BaseRecord {
  kind: 'history'
  /** 评的是哪张卡 */
  cardId: string
  /** 评分时刻（ISO） */
  at: string
  grade: ReviewGrade
  stageBefore: number
  stageAfter: number
  /** 评分后的下次到期日 YYYY-MM-DD */
  dueDateAfter: string
}

export type ReviewRecord = ReviewCard | ReviewHistory

/** 每张卡保留的历史条数上限 */
export const HISTORY_KEEP_LIMIT = 50

export function isReviewCard(record: ReviewRecord): record is ReviewCard {
  return record.kind !== 'history'
}
export function isReviewHistory(record: ReviewRecord): record is ReviewHistory {
  return record.kind === 'history'
}

/** 计算下一次间隔天数 */
export function nextIntervalDays(
  grade: ReviewGrade,
  stage: number,
  intensity: ReviewIntensity = 'standard'
): number {
  const multiplier = intensityMultiplier(intensity)
  if (grade === 'forgot') {
    return Math.max(1, Math.round(BASE_INTERVALS.forgot * multiplier))
  }
  if (grade === 'fuzzy') {
    return Math.max(1, Math.round(BASE_INTERVALS.fuzzy * multiplier))
  }
  // 记住了：按 stage 在阶梯上取，越往后间隔越长
  const index = Math.min(REMEMBERED_LADDER.length - 1, Math.max(0, stage))
  const base = REMEMBERED_LADDER[index] ?? BASE_INTERVALS.remembered
  return Math.max(1, Math.round(base * multiplier))
}

/** 评分后的阶段推进 */
export function nextStage(grade: ReviewGrade, stage: number): number {
  if (grade === 'forgot') return 0
  if (grade === 'fuzzy') return Math.max(0, stage)
  return Math.min(REMEMBERED_LADDER.length - 1, stage + 1)
}

export interface GradeOutcome {
  grade: ReviewGrade
  /** 本次评分的阶段值（评分前） */
  stageBefore: number
  /** 推进后的阶段 */
  stageAfter: number
  /** 间隔天数 */
  intervalDays: number
  /** 下次到期日 */
  dueDate: string
  /** 复习次数（含本次） */
  reviewCount: number
}

/** 加上若干天，返回 YYYY-MM-DD（本地时区） */
export function addDaysToKey(key: string, days: number): string {
  const [year, month, day] = key.split('-').map((part) => Number.parseInt(part, 10))
  const date = new Date(year ?? 1970, (month ?? 1) - 1, day ?? 1)
  date.setDate(date.getDate() + days)
  const pad = (value: number): string => `${value}`.padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

/**
 * 走一次评分：给出阶段、间隔、下次到期日与复习次数。
 * 这是复习模块的核心规则，必须精确可测。
 */
export function applyGrade(
  card: Pick<ReviewCard, 'stage' | 'reviewCount'>,
  grade: ReviewGrade,
  todayKey: string,
  intensity: ReviewIntensity = 'standard'
): GradeOutcome {
  const stageBefore = Math.max(0, card.stage)
  const stageAfter = nextStage(grade, stageBefore)
  const intervalDays = nextIntervalDays(grade, stageAfter, intensity)
  return {
    grade,
    stageBefore,
    stageAfter,
    intervalDays,
    dueDate: addDaysToKey(todayKey, intervalDays),
    reviewCount: Math.max(0, card.reviewCount) + 1
  }
}

/** 按钮上直接显示的提示：下次什么时候再考你 */
export function intervalHintDays(
  grade: ReviewGrade,
  stage: number,
  intensity: ReviewIntensity = 'standard'
): number {
  return nextIntervalDays(grade, nextStage(grade, stage), intensity)
}

/** 卡片今天是否到期 */
export function isDue(card: ReviewCard, todayKey: string): boolean {
  if (card.dueDate === null) return true
  return card.dueDate <= todayKey
}

/**
 * 到期队列：先按到期日升序（拖得越久的越先复习），
 * 到期日为 null 的卡片视为"新卡/今天可做"，排在已逾期卡之后，
 * 同类之间按创建时间升序（老卡优先）。
 *
 * 第 06 块补的一条：**同一天到期、且都设了具体时间**时按 `dueTime` 先后
 * （"08:00 的比 20:00 的先复习"）。只在两边都有时间时才比 ——
 * 这样"没设时间"的老卡仍然按创建时间排，原来的顺序一点没变。
 */
export function dueQueue(cards: ReviewCard[], todayKey: string): ReviewCard[] {
  return cards
    .filter((card) => isDue(card, todayKey))
    .sort((a, b) => {
      const hasA = a.dueDate !== null
      const hasB = b.dueDate !== null
      if (hasA !== hasB) return hasA ? -1 : 1
      const dateA = a.dueDate ?? ''
      const dateB = b.dueDate ?? ''
      if (dateA !== dateB) return dateA < dateB ? -1 : 1
      const timeA = a.dueTime ?? ''
      const timeB = b.dueTime ?? ''
      if (timeA !== '' && timeB !== '' && timeA !== timeB) return timeA < timeB ? -1 : 1
      return String(a.createdAt).localeCompare(String(b.createdAt))
    })
}

/** 积压阈值：超过这个数量给出"建议今天只做 N 张"的提示 */
export const BACKLOG_THRESHOLD = 50
export const BACKLOG_SUGGESTION = 20

/** 汇总横条里"各主题分布"的一行 */
export interface ReviewTopicBucket {
  /** 主题名（就是卡片的来源，例如"英语长难句"/"备忘"） */
  topic: string
  /** 该主题今天到期的张数 */
  count: number
  /**
   * 这个主题在左栏里是**已隐藏**的（修改 2 轮）。
   *
   * **只影响显示的标注，不影响 count**：隐藏只是"左栏别给我看这一行"，
   * 今天欠多少张必须照旧算它——否则用户会以为自己清完了，漏复习就变成静默的
   * （`MASTER.md` 决定 19 / R1）。
   */
  hidden?: boolean
}

/**
 * 今天到期的卡按主题分布（已定决定 19 的防漏出口之一）。
 *
 * 去掉全局到期队列后，"今天总共欠多少张、都欠在哪些主题上"必须有地方能看，
 * 否则漏复习是**静默**的。排序固定为"张数多的在前，同数量按名字"，
 * 这样每次渲染顺序一致（顺序乱跳会让人以为数字在变）。
 */
export function topicDistribution(cards: ReviewCard[], todayKey: string): ReviewTopicBucket[] {
  const due = dueQueue(cards, todayKey)
  const counts = new Map<string, number>()
  for (const card of due) {
    const topic = card.source === '' ? '未标注来源' : card.source
    counts.set(topic, (counts.get(topic) ?? 0) + 1)
  }
  return Array.from(counts.entries())
    .map(([topic, count]) => ({ topic, count }))
    .sort((a, b) => (a.count === b.count ? a.topic.localeCompare(b.topic, 'zh-Hans-CN') : b.count - a.count))
}

/** 汇总横条的总句："今天到期 N 张（全部主题合计）" */
export function summaryTotalText(total: number): string {
  return `今天到期 ${Math.max(0, Math.trunc(total))} 张（全部主题合计）`
}

/** 汇总横条的分布句："而对方 3 张 · 热力学 2 张"；没有到期卡时为空串 */
export function summaryDistributionText(buckets: ReviewTopicBucket[]): string {
  return buckets
    .map((bucket) => `${bucket.topic} ${bucket.count} 张${bucket.hidden === true ? '（已隐藏）' : ''}`)
    .join(' · ')
}

export interface BacklogInfo {
  show: boolean
  total: number
  suggestion: number
  message: string
}

export function backlogInfo(total: number): BacklogInfo {
  const show = total > BACKLOG_THRESHOLD
  return {
    show,
    total,
    suggestion: BACKLOG_SUGGESTION,
    message: show
      ? `积压较多（${total} 张），建议今天只做 ${BACKLOG_SUGGESTION} 张`
      : ''
  }
}

/**
 * 把任意记录规范成复习卡。
 *
 * **`kind: 'history'` 的记录必须返回 null**：历史不是卡片，
 * 混进到期队列会让"今天到期 N 张"凭空变大，而且历史没有正反面，
 * 复习时会显示成一张空卡。历史请走 `normalizeReviewHistory`。
 */
export function normalizeReviewCard(input: Record<string, unknown>): ReviewCard | null {
  if (input['kind'] === 'history') return null
  const id = String(input['id'] ?? '')
  if (id === '') return null
  const stage = Number.isFinite(input['stage']) ? Math.max(0, Number(input['stage'])) : 0
  const due = input['dueDate']
  return {
    id,
    createdAt: String(input['createdAt'] ?? ''),
    updatedAt: String(input['updatedAt'] ?? ''),
    ...(typeof input['deletedAt'] === 'string' ? { deletedAt: input['deletedAt'] } : {}),
    front: String(input['front'] ?? '').trim(),
    back: String(input['back'] ?? ''),
    source: String(input['source'] ?? '').trim() || '未标注来源',
    stage,
    dueDate: typeof due === 'string' && due !== '' ? due : null,
    ...(isTimeOfDay(input['dueTime']) ? { dueTime: input['dueTime'] } : {}),
    reviewCount: Number.isFinite(input['reviewCount']) ? Math.max(0, Number(input['reviewCount'])) : 0,
    lastReviewedAt: typeof input['lastReviewedAt'] === 'string' ? input['lastReviewedAt'] : null,
    ...(typeof input['topicId'] === 'string' && input['topicId'] !== ''
      ? { topicId: input['topicId'] }
      : {}),
    ...(typeof input['nodeId'] === 'string' && input['nodeId'] !== ''
      ? { nodeId: input['nodeId'] }
      : {}),
    ...(typeof input['bookId'] === 'string' && input['bookId'] !== ''
      ? { bookId: input['bookId'] }
      : {})
  }
}

/** 把任意记录规范成复习历史；不是历史时返回 null */
export function normalizeReviewHistory(input: Record<string, unknown>): ReviewHistory | null {
  if (input['kind'] !== 'history') return null
  const id = String(input['id'] ?? '')
  const cardId = String(input['cardId'] ?? '')
  if (id === '' || cardId === '') return null
  return {
    id,
    createdAt: String(input['createdAt'] ?? ''),
    updatedAt: String(input['updatedAt'] ?? ''),
    ...(typeof input['deletedAt'] === 'string' ? { deletedAt: input['deletedAt'] } : {}),
    kind: 'history',
    cardId,
    at: String(input['at'] ?? ''),
    grade: isReviewGrade(input['grade']) ? input['grade'] : 'fuzzy',
    stageBefore: Number.isFinite(input['stageBefore']) ? Math.max(0, Number(input['stageBefore'])) : 0,
    stageAfter: Number.isFinite(input['stageAfter']) ? Math.max(0, Number(input['stageAfter'])) : 0,
    dueDateAfter: String(input['dueDateAfter'] ?? '')
  }
}

/** 把任意记录规范成复习记录（卡片或历史） */
export function normalizeReviewRecord(input: Record<string, unknown>): ReviewRecord | null {
  if (input['kind'] === 'history') return normalizeReviewHistory(input)
  const card = normalizeReviewCard(input)
  return card === null ? null : { ...card, kind: 'card' }
}

/** 由一次评分结果构造历史记录（applyGrade 的返回值已经带齐全部字段） */
export function historyFromOutcome(
  cardId: string,
  outcome: GradeOutcome,
  atISO: string
): Omit<ReviewHistory, 'id' | 'createdAt' | 'updatedAt'> & { kind: 'history' } {
  return {
    kind: 'history',
    cardId,
    at: atISO,
    grade: outcome.grade,
    stageBefore: outcome.stageBefore,
    stageAfter: outcome.stageAfter,
    dueDateAfter: outcome.dueDate
  }
}

/**
 * 裁剪某张卡的历史：只保留**最近** HISTORY_KEEP_LIMIT 条。
 * 返回要删掉的 id；空数组表示不用删。
 */
export function historyOverflowIds(histories: ReviewHistory[]): string[] {
  if (histories.length <= HISTORY_KEEP_LIMIT) return []
  const sorted = [...histories].sort((a, b) => String(b.at).localeCompare(String(a.at)))
  return sorted.slice(HISTORY_KEEP_LIMIT).map((item) => item.id)
}

/** 某张卡的历史按时间倒序（最近的在最前） */
export function historiesOf(histories: ReviewHistory[], cardId: string): ReviewHistory[] {
  return histories
    .filter((item) => item.cardId === cardId)
    .sort((a, b) => String(b.at).localeCompare(String(a.at)))
}

/**
 * 追加一条历史之后的裁剪结果（决定 20：每卡保留最近 50 次）。
 *
 * 页面只需要两件事：`kept`（这张卡现在留下的历史，最新在前）与
 * `dropped`（要**真的删掉**的 id 列表）。
 *
 * 为什么把"追加 + 裁剪"收在一个纯函数里：裁剪是"每卡 50 条"这条规则的唯一出口，
 * 界面里再写一遍 `slice(50)` 就会在下次改规则时漂成两个数。
 * 返回的 `dropped` 交给调用方硬删（不进回收站）——
 * 复习历史的裁剪是程序自己的容量管理，不该把用户回收站塞满。
 */
export function historyAfterAppend(
  existing: ReviewHistory[],
  entry: ReviewHistory
): { kept: ReviewHistory[]; dropped: string[] } {
  const forCard = historiesOf([...existing, entry], entry.cardId)
  const dropped = historyOverflowIds(forCard)
  const droppedSet = new Set(dropped)
  return {
    kept: forCard.filter((item) => !droppedSet.has(item.id)),
    dropped
  }
}

/** 复习历史的分区标题上那一行说明（界面与单测共用，别各写一份） */
export function historyRetentionText(): string {
  return `每张卡只保留最近 ${HISTORY_KEEP_LIMIT} 次`
}
