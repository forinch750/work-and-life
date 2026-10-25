/**
 * 复习页的**视图计算**（第 10 块 · `MASTER.md` §7.6 + §14 决定 17–21）
 *
 * 这里只放**纯函数**：进来的是记录数组，出去的是界面上直接显示的那几个字符串、数字与行。
 *
 * ## 为什么另起一份，而不是写在页面里
 *
 * 1. **间隔算法与到期队列不许重写**。三档间隔（1 / 3 / 7→14→30→60→120 × 强度系数）
 *    在第 06 块就落在 `src\shared\review.ts`；本文件**一行算法都没有**，
 *    到期判定转调 `isDue`、队列转调 `dueQueue`、评分转调 `applyGrade`。
 * 2. **vitest 是 `environment: 'node'`**（没有 jsdom、也不许引 jsdom）：
 *    组件行为交给端到端验收（`src\main\verify\phase8.ts` 的 P8-U*），
 *    能单测的只有"算出来的数对不对"，所以算的部分必须从组件里搬出来。
 *
 * ## 本块最关键的一条不变量（防漏的核心）
 *
 * ```
 * Σ（各主题自己的到期数） === 今天到期的总数 === 导航角标
 * ```
 *
 * 去掉全局到期队列以后，"今天总共欠多少张"只剩两个出口能看见：
 * ① 导航角标 ② 复习页顶部汇总横条。两条必须由**同一个数**算出来，
 * 否则漏复习就是**静默**的（决定 19 / 21）。`buildReviewTopics()` 是唯一出口，
 * `tests\review\reviewPageView.test.ts` 里钉住了这条等式。
 *
 * ## 复习的"主题"是什么（决定 17）
 *
 * **学习主题 + 读书的书**，复用同一批顶层实体，**不另建一套**：
 *
 * | 卡片 | 归到哪个主题 |
 * |---|---|
 * | 有 `topicId` 且能对上学习主题 | 那个学习主题 |
 * | 有 `bookId` 且能对上书 | 那本书 |
 * | `source` 正好等于某个主题 / 书的名字 | 那个主题（老卡片只有 source，靠这条归位） |
 * | 都对不上 | 按 `source` 单独成一档（**不许丢**：丢了就是静默漏复习） |
 */

import { addDaysToKey, dateKey, daysBetween, formatDateTime } from './date'
import {
  GRADE_LABELS,
  REMEMBERED_LADDER,
  dueQueue,
  isDue,
  type ReviewCard,
  type ReviewGrade,
  type ReviewHistory,
  type ReviewTopicBucket
} from './review'

/** 复习主题的来源：学习主题 / 读书的书 / 只剩来源名的卡片 */
export type ReviewTopicKind = 'learning' | 'book' | 'source'

/** 一个可以当"复习主题"的顶层实体 */
export interface ReviewTopicSource {
  kind: ReviewTopicKind
  /** 学习主题 id / 书 id / 来源名（`source` 档用它当 id） */
  id: string
  title: string
}

/** 带稳定 key 的主题来源（key 同时用在界面的 `data-topic-key` 上） */
export interface ReviewTopicRef extends ReviewTopicSource {
  key: string
}

/** 主题的稳定 key：`topic:<id>` / `book:<id>` / `source:<来源名>` */
export function reviewTopicKey(kind: ReviewTopicKind, id: string): string {
  const prefix = kind === 'learning' ? 'topic' : kind === 'book' ? 'book' : 'source'
  return `${prefix}:${id}`
}

/**
 * 拼出"可以当复习主题"的那批顶层实体：**学习主题 + 读书的书**。
 *
 * 顺序固定（先学习主题、再书，各自按标题排），因为侧栏列表的顺序一乱，
 * 用户就会以为"数字在变"（05 块 topicDistribution 踩过同一个坑）。
 */
export function reviewTopicSources(
  learningTopics: Array<{ id: string; title: string }>,
  books: Array<{ id: string; title: string }>
): ReviewTopicRef[] {
  const byTitle = (a: { title: string }, b: { title: string }): number =>
    a.title.localeCompare(b.title, 'zh-Hans-CN')
  const topics = learningTopics
    .filter((topic) => topic.id !== '' && topic.title !== '')
    .slice()
    .sort(byTitle)
    .map((topic) => ({ ...topicRef('learning', topic.id, topic.title) }))
  const shelf = books
    .filter((book) => book.id !== '' && book.title !== '')
    .slice()
    .sort(byTitle)
    .map((book) => topicRef('book', book.id, book.title))
  return [...topics, ...shelf]
}

function topicRef(kind: ReviewTopicKind, id: string, title: string): ReviewTopicRef {
  return { kind, id, title, key: reviewTopicKey(kind, id) }
}

/**
 * 一张卡归到哪个主题（决定 17 的落库口径，见文件头那张表）。
 *
 * 最后那条兜底很重要：**任何一张卡都必须有归处**。
 * 一旦某张卡既没有 topicId / bookId、来源又对不上任何主题，
 * 它就会从"各主题到期数之和"里消失——那正是本块要防的静默漏复习。
 */
export function cardTopicKey(card: ReviewCard, sources: ReviewTopicRef[]): string {
  if (card.topicId !== undefined && card.topicId !== '') {
    const hit = sources.find((item) => item.kind === 'learning' && item.id === card.topicId)
    if (hit !== undefined) return hit.key
  }
  if (card.bookId !== undefined && card.bookId !== '') {
    const hit = sources.find((item) => item.kind === 'book' && item.id === card.bookId)
    if (hit !== undefined) return hit.key
  }
  const source = (card.source ?? '').trim()
  const byName = sources.find((item) => item.title === source && item.kind !== 'source')
  if (byName !== undefined) return byName.key
  return reviewTopicKey('source', source === '' ? '未标注来源' : source)
}

/** 侧栏一行 + 预览区要用的全部读数（都是"这个主题自己的"） */
export interface ReviewTopicSummary {
  key: string
  kind: ReviewTopicKind
  id: string
  title: string
  /** 这个主题下的卡片总数 */
  cardCount: number
  /** 今天到期的张数（**该主题自己的**；已清就是 0） */
  dueCount: number
  /** 已掌握 %（按阶段换算，见 `masteredPercent`） */
  masteredPercent: number
  /** 上次复习的日期 YYYY-MM-DD；从没复习过是空串 */
  lastReviewedAt: string
  /** 下次到期的日期（最紧的那张）；没有卡片是空串 */
  nextDueDate: string
  /** 属于这个主题的卡片（到期队列顺序，稳定） */
  cards: ReviewCard[]
}

/**
 * 把全部卡片按主题聚起来。
 *
 * **`Σ dueCount` 必须等于 `dueQueue(cards, todayKey).length`** ——
 * 这条不变量是本块防漏的核心，单测钉住（§7.2 第一条）。
 * 为了让它必然成立，这里只做"每张卡恰好进一个桶"的分组，不额外筛掉任何卡。
 */
export function buildReviewTopics(
  cards: ReviewCard[],
  sources: ReviewTopicRef[],
  todayKey: string
): ReviewTopicSummary[] {
  const ordered = dueQueue(cards, todayKey)
  const rank = new Map(ordered.map((card, index) => [card.id, index]))
  const buckets = new Map<string, ReviewCard[]>()
  const meta = new Map<string, ReviewTopicRef>()

  // 先给所有"真实存在"的主题占位：一张卡都没有的主题也要出现在左栏（到期数显示「—」）
  for (const source of sources) {
    buckets.set(source.key, [])
    meta.set(source.key, source)
  }

  for (const card of cards) {
    const key = cardTopicKey(card, sources)
    const list = buckets.get(key)
    if (list === undefined) {
      // 来源档：卡片既没有 topicId / bookId，来源又对不上任何主题（老卡片就是这种）
      const name = (card.source ?? '').trim() === '' ? '未标注来源' : card.source.trim()
      buckets.set(key, [card])
      meta.set(key, { kind: 'source', id: name, title: name, key })
    } else {
      list.push(card)
    }
  }

  const summaries: ReviewTopicSummary[] = []
  for (const [key, list] of buckets) {
    const source = meta.get(key)
    if (source === undefined) continue
    const sorted = list
      .slice()
      .sort((a, b) => (rank.get(a.id) ?? Number.MAX_SAFE_INTEGER) - (rank.get(b.id) ?? Number.MAX_SAFE_INTEGER))
    summaries.push({
      key,
      kind: source.kind,
      id: source.id,
      title: source.title,
      cardCount: sorted.length,
      dueCount: sorted.filter((card) => isDue(card, todayKey)).length,
      masteredPercent: masteredPercent(sorted),
      lastReviewedAt: lastReviewedDateOf(sorted),
      nextDueDate: nextDueDateOf(sorted, todayKey),
      cards: sorted
    })
  }

  return summaries
}

/** 各主题到期数之和 —— 汇总横条与导航角标用的**就是这一个数** */
export function dueTotalOf(summaries: ReviewTopicSummary[]): number {
  return summaries.reduce((sum, item) => sum + item.dueCount, 0)
}

// ---------------------------------------------------------------------------
// 左栏的"隐藏这个主题"（修改 2 轮 · 2026-10）
//
// 用户原话：「复习无法删除主题。」复习的"主题"可能是学习主题、读书的书，
// 也可能是**来源档**（卡片原来的主题/书已经不存在时按来源名自成一档）——
// 来源档不是真实实体，没法用"删学习主题"的方式处置。用户已确认：
// **只在复习页把它隐藏，不删任何源数据**（学习主题 / 书 / 卡片一个都不动）。
//
// ## ⚠️ 隐藏**绝不能**造成漏复习（`MASTER.md` 决定 19 / R1）
//
// 所以这一节的函数**只做一件事：过滤左栏要显示的那几行**。
// 下面这些口径一个字都不许改，一条单测都不许放宽：
//
//   - `dueTotalOf(summaries)` 仍然用**全部** summaries → 汇总横条总数不变
//   - `dueQueue(cards, today)` / 「汇总复习（N）」仍然用**全部**到期卡 → 不漏
//   - `computeBadges(...)`（导航角标）仍然看全部卡片 → 与横条是同一个数
//   - 分布明细里被隐藏的主题**照样出现**，只是后面多一个「（已隐藏）」
//
// 换成人话：**左栏可以少几行，今天欠多少张一个字都不能少。**
// ---------------------------------------------------------------------------

/** 这个主题此刻是不是被隐藏了（`hiddenIds` 里存的是主题的稳定 key） */
export function isTopicHidden(summary: ReviewTopicSummary, hiddenIds: string[]): boolean {
  return hiddenIds.includes(summary.key)
}

/**
 * 左栏**要显示**的主题（= 全部主题 − 已隐藏）。
 *
 * 顺序保持 `buildReviewTopics` 给的原顺序，不做二次排序：
 * 顺序一乱用户就会以为"数字在变"（05 块 topicDistribution 踩过同一个坑）。
 */
export function visibleTopics(
  summaries: ReviewTopicSummary[],
  hiddenIds: string[]
): ReviewTopicSummary[] {
  if (hiddenIds.length === 0) return summaries
  return summaries.filter((summary) => !isTopicHidden(summary, hiddenIds))
}

/** 左栏里被隐藏的那几行（打开「显示已隐藏」时灰显出现） */
export function hiddenTopics(
  summaries: ReviewTopicSummary[],
  hiddenIds: string[]
): ReviewTopicSummary[] {
  if (hiddenIds.length === 0) return []
  return summaries.filter((summary) => isTopicHidden(summary, hiddenIds))
}

/**
 * 真正被隐藏了几个主题。
 *
 * 为什么不是 `hiddenIds.length`：偏好里可能留着**已经被删掉**的主题 id
 * （隐藏了一个主题、之后又把那个学习主题删了）。那种 id 没有对应的行，
 * 不该让开关上的数字虚高。
 */
export function hiddenCount(summaries: ReviewTopicSummary[], hiddenIds: string[]): number {
  if (hiddenIds.length === 0) return 0
  return hiddenTopics(summaries, hiddenIds).length
}

// ---------------------------------------------------------------------------
// 左栏"删除这个来源档"（修改 3 轮 · 2026-10）
//
// 用户原话：「这个还是删不掉。」（截图指左栏那个叫「手动新建」的主题）
//
// ## 为什么只有"来源档"能删
//
// 左栏的"主题"有三类（见文件头那张表）：
//
//   | key 前缀 | 是什么 | 有没有源数据 |
//   |---|---|---|
//   | `topic:<id>` | 一个学习主题 | 有（在 `learning` 模块里）|
//   | `book:<id>`  | 一本书 | 有（在 `reading` 模块里）|
//   | `source:<来源名>` | **来源档**：卡片没有 topicId / bookId 时按 `source` 名自成一档 | **没有** |
//
// 前两类对应的**是**真实实体，删它等于去学习页 / 读书页删东西 —— 语义重，
// 不该在复习页做（用户已确认：`topic:` / `book:` 档仍然只能隐藏）。
// 来源档**不是任何实体**，它只是"这一批卡片按来源名的归类"标签，所以
// "删它"的唯一含义就是**把它下面的卡片一起删掉**（进回收站，可恢复）。
//
// ## 判定只在这里做一次
//
// `deletable` 由页面调 `isTopicDeletable()` 算好传给菜单，
// **`shared/contextMenu.ts` 里不许再解析一遍 key** —— 一处判断、两处用，
// 迟早漂移到"菜单里有删除、点了却什么也没删"（或反过来）。
// key 的格式本来就定义在本文件（`reviewTopicKey`），判断跟着它走。
// ---------------------------------------------------------------------------

/** 来源档的 key 前缀（`reviewTopicKey('source', 名字)` 拼出来的就是它） */
export const SOURCE_TOPIC_PREFIX = 'source:'

/**
 * 左栏这一档能不能删（只有**来源档**能删）。
 *
 * 传整个 summary 而不是裸 key：调用方（复习页）手上就是 summary，
 * 让它自己去 `.key.startsWith(…)` 等于把 key 的格式抄第二遍。
 */
export function isTopicDeletable(summary: ReviewTopicSummary): boolean {
  return summary.key.startsWith(SOURCE_TOPIC_PREFIX)
}

/**
 * 删一个来源档要删哪些卡片 —— **直接取分组结果**，一张都不许在页面里重算。
 *
 * `summary.cards` 是 `buildReviewTopics()` 分出来的那一桶（`cardTopicKey` 的
 * 归属规则只在那里实现一次）。页面若自己再判断"这张卡算不算这一档"，
 * 就会与左栏显示的那一行对不上：表现是"删了但那一档还在"或"多删了别的档的卡"。
 */
export function topicDeleteCardIds(summary: ReviewTopicSummary): string[] {
  return summary.cards.map((card) => card.id)
}

/**
 * 汇总横条那句"分布"的数据源：**按复习主题**（不是按 `card.source` 的原始字符串）。
 *
 * 为什么要换数据源：以前是按卡片自己的 `source` 分组，于是"哪个桶对应左栏哪一行"
 * 只能靠名字猜——一旦要标「（已隐藏）」，就会标到错的桶上。
 * 现在直接用 `summaries`（每个主题的 `dueCount` 就是它自己的到期张数），
 * 于是：**Σ 分布里的数字 ≡ 各主题到期数之和 ≡ 汇总总数**，天然对得上。
 *
 * 已隐藏的主题**照样在列表里**（只多一个 `hidden: true` 标注）——不许凭空消失。
 */
export function reviewDistributionBuckets(
  summaries: ReviewTopicSummary[],
  hiddenIds: string[] = []
): ReviewTopicBucket[] {
  return summaries
    .filter((summary) => summary.dueCount > 0)
    .map((summary) => ({
      topic: summary.title,
      count: summary.dueCount,
      ...(isTopicHidden(summary, hiddenIds) ? { hidden: true } : {})
    }))
    .sort((a, b) =>
      a.count === b.count ? a.topic.localeCompare(b.topic, 'zh-Hans-CN') : b.count - a.count
    )
}

/** 掌握度的最高档：记住了走 7→14→30→60→120，走到头（stage 4）算"已掌握" */
export const MASTERED_STAGE = REMEMBERED_LADDER.length - 1

/**
 * 已掌握 %：Σ min(阶段, 4) / (张数 × 4)。
 *
 * 口径看一眼就懂：新卡（阶段 0）0%，背到阶梯顶端（阶段 4）100%。
 * 不按"评过几次"算——次数多不代表记得住，阶段才是算法给出的状态。
 */
export function masteredPercent(cards: ReviewCard[]): number {
  if (cards.length === 0) return 0
  const sum = cards.reduce(
    (total, card) => total + Math.min(MASTERED_STAGE, Math.max(0, Math.trunc(card.stage))),
    0
  )
  return Math.round((sum / (cards.length * MASTERED_STAGE)) * 100)
}

/** 上次复习的日期（取这组卡里最晚的一次）；从没复习过返回空串 */
export function lastReviewedDateOf(cards: ReviewCard[]): string {
  let latest = ''
  for (const card of cards) {
    const at = card.lastReviewedAt
    if (typeof at !== 'string' || at === '') continue
    if (at > latest) latest = at
  }
  if (latest === '') return ''
  const date = new Date(latest)
  if (Number.isNaN(date.getTime())) return ''
  return dateKey(date)
}

/** 下次到期的日期（取最紧的那张；`dueDate === null` 表示今天）；没有卡片返回空串 */
export function nextDueDateOf(cards: ReviewCard[], todayKey: string): string {
  if (cards.length === 0) return ''
  let earliest: string | null = null
  for (const card of cards) {
    const value = card.dueDate === null ? todayKey : card.dueDate
    if (earliest === null || value < earliest) earliest = value
  }
  return earliest ?? ''
}

/** 预览区那两行：上次复习 / 下次到期 */
export interface ReviewPreviewTexts {
  /** `2026-10-08` 或「从未」 */
  lastReviewed: string
  /** 「今天（3 张）」/「2026-10-20」/「—」 */
  nextDue: string
}

export function topicPreviewTexts(summary: ReviewTopicSummary): ReviewPreviewTexts {
  const lastReviewed = summary.lastReviewedAt === '' ? '从未' : summary.lastReviewedAt
  let nextDue = '—'
  if (summary.cardCount > 0) {
    if (summary.dueCount > 0) nextDue = `今天（${summary.dueCount} 张）`
    else if (summary.nextDueDate !== '') nextDue = summary.nextDueDate
  }
  return { lastReviewed, nextDue }
}

/** 左栏主题行的副标题：`12 张 · 已掌握 58%` */
export function topicListMetaText(summary: ReviewTopicSummary): string {
  return `${summary.cardCount} 张 · 已掌握 ${summary.masteredPercent}%`
}

/** 侧栏右侧那个属于**这个主题自己**的到期数；已清时显示「—」 */
export function topicDueBadgeText(dueCount: number): string {
  return dueCount > 0 ? String(dueCount) : '—'
}

// ---------------------------------------------------------------------------
// 卡片行的到期状态（三色圆点）
// ---------------------------------------------------------------------------

/** 卡片行的三种状态：今天到期 / 快到期 / 今天不用 */
export type CardDueState = 'due' | 'soon' | 'later'

export const CARD_STATE_LABELS: Record<CardDueState, string> = {
  due: '今天到期',
  soon: '快到期',
  later: '今天不用'
}

/** "快到期"的范围：今天之后多少天以内算快到期 */
export const SOON_DAYS = 3

/**
 * 三态判定（§6.2 / §7.3 的新增单测项之一）。
 *
 *   - `due`   今天到期（`dueDate === null` 或 `dueDate <= 今天`，含逾期）
 *   - `soon`  今天之后 `SOON_DAYS` 天以内
 *   - `later` 更远
 */
export function cardDueState(card: ReviewCard, todayKey: string, soonDays = SOON_DAYS): CardDueState {
  if (isDue(card, todayKey)) return 'due'
  const limit = addDaysToKey(todayKey, Math.max(0, Math.trunc(soonDays)))
  if ((card.dueDate ?? '') !== '' && String(card.dueDate) <= limit) return 'soon'
  return 'later'
}

export interface DueStateCounts {
  due: number
  soon: number
  later: number
}

/** 一组卡片里三态各有多少张（图例与验收读数用） */
export function dueStateCounts(cards: ReviewCard[], todayKey: string): DueStateCounts {
  const counts: DueStateCounts = { due: 0, soon: 0, later: 0 }
  for (const card of cards) counts[cardDueState(card, todayKey)] += 1
  return counts
}

// ---------------------------------------------------------------------------
// 中区第二块：最近的复习记录（日期 / 卡片 / 评分 → 下次间隔）
// ---------------------------------------------------------------------------

/** 一条"最近复习记录"要显示的四样东西 */
export interface ReviewHistoryRow {
  id: string
  cardId: string
  /** 卡片正面（卡片已删时是「（这张卡已删除）」） */
  front: string
  /** 卡片背面 */
  back: string
  atISO: string
  /** 记录列表里那一格：`10-08 17:00`（半屏宽的卡片放不下"2026年10月8日 周五"） */
  atText: string
  /** 完整时间：`2026年10月8日 周五 17:00`（悬停提示用） */
  atFullText: string
  grade: ReviewGrade
  gradeLabel: string
  /** 这次评分给出的间隔（天）= 下次到期日 − 评分当天 */
  intervalDays: number
  /** `30 天后` */
  intervalText: string
}

/**
 * 记录列表那一格的时间：`10-08 17:00`。
 *
 * 为什么不用 `formatDateTime`（"2026年10月8日 周五 17:00"）：中区卡片只有半屏宽，
 * 那一格会被挤成两行，四列就对不齐了（样式上已实测）。完整时间仍留在
 * `atFullText` 里，作为行的 `title`。
 */
export function shortDateTime(iso: string): string {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return ''
  const pad = (value: number): string => `${value}`.padStart(2, '0')
  return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

/**
 * 一次评分给出的间隔天数。
 *
 * 直接由 `dueDateAfter − dateKey(at)` 算：这正是"下次间隔"的**事实**，
 * 不用再去反推强度系数（反推会把规则抄第二遍）。
 */
export function historyIntervalDays(entry: ReviewHistory): number {
  const parsed = new Date(entry.at)
  if (Number.isNaN(parsed.getTime())) return 0
  if (entry.dueDateAfter === '') return 0
  return Math.max(0, daysBetween(dateKey(parsed), entry.dueDateAfter))
}

/**
 * 最近的复习记录（按 `at` 倒序）。
 *
 * `cardIds` 传了就只看这些卡的记录（= 当前选中主题）；不传就是全部。
 */
export function recentReviewRows(
  histories: ReviewHistory[],
  cards: ReviewCard[],
  limit = 30,
  cardIds?: string[]
): ReviewHistoryRow[] {
  const byId = new Map(cards.map((card) => [card.id, card]))
  const scope = cardIds === undefined ? null : new Set(cardIds)
  return histories
    .filter((entry) => scope === null || scope.has(entry.cardId))
    .slice()
    .sort((a, b) => String(b.at).localeCompare(String(a.at)))
    .slice(0, Math.max(0, Math.trunc(limit)))
    .map((entry) => {
      const card = byId.get(entry.cardId)
      const intervalDays = historyIntervalDays(entry)
      return {
        id: entry.id,
        cardId: entry.cardId,
        front: card?.front ?? '（这张卡已删除）',
        back: card?.back ?? '',
        atISO: entry.at,
        atText: shortDateTime(entry.at),
        atFullText: formatDateTime(entry.at),
        grade: entry.grade,
        gradeLabel: GRADE_LABELS[entry.grade],
        intervalDays,
        intervalText: `${intervalDays} 天后`
      }
    })
}

// ---------------------------------------------------------------------------
// 下区：树 = 资料 → 章节 → 卡片（卡片是最小单元）
// ---------------------------------------------------------------------------

/** 树的输入节点（学习 `LearningNode` / 读书 `ReadingNode` 都满足） */
export interface ReviewTreeNode {
  id: string
  parentId: string | null
  order: number
  title: string
  /** 资料的分组名（学习资料才有） */
  group?: string
  /** 资料的类型（书 / 视频 / 课程 / 文档） */
  resourceType?: string
}

/** 树的一行 */
export interface ReviewTreeRow {
  /** 稳定 key（`node:<id>` / `card:<id>`） */
  key: string
  kind: 'material' | 'chapter' | 'card'
  /** 缩进层级（资料 = 0） */
  depth: number
  /** 节点 id 或卡片 id */
  id: string
  title: string
  /** 资料行的「分组 · 类型」标签 */
  badge: string
  /** 资料 / 章节行：子树里今天到期的张数 */
  dueCount: number
  /** 资料行：子树里的卡片总数 */
  cardCount: number
  /** 卡片行：这就是那张卡 */
  card: ReviewCard | null
  /** 卡片行：三态圆点 */
  state: CardDueState | null
}

export interface ReviewTreeOptions {
  /** 「只看到期的」：只留今天到期的卡，以及还能落到卡的空节点不要 */
  onlyDue?: boolean
}

const byOrderThenTitle = (a: ReviewTreeNode, b: ReviewTreeNode): number =>
  a.order !== b.order ? a.order - b.order : a.title.localeCompare(b.title, 'zh-Hans-CN')

/** 卡片行的排序：先按到期日（拖得越久越先），同日按创建时间（与 `dueQueue` 同口径） */
const dueOrder = (a: ReviewCard, b: ReviewCard): number => {
  const hasA = a.dueDate !== null
  const hasB = b.dueDate !== null
  if (hasA !== hasB) return hasA ? -1 : 1
  const dateA = a.dueDate ?? ''
  const dateB = b.dueDate ?? ''
  if (dateA !== dateB) return dateA < dateB ? -1 : 1
  return String(a.createdAt).localeCompare(String(b.createdAt))
}

/** 资料行的标签：`教材 · 书`；两项相同只写一个 */
export function materialLabel(node: ReviewTreeNode): string {
  const group = (node.group ?? '').trim()
  const type = (node.resourceType ?? '').trim()
  if (group !== '' && type !== '' && group !== type) return `${group} · ${type}`
  return group !== '' ? group : type
}

/**
 * 组装树行（**纯函数**，端到端验收靠它算出来的行数/层级对账）。
 *
 * 规矩：
 *   - 资料（`parentId === null`）是根；章节按 `order` 排；层数不限
 *   - 卡片挂在 `card.nodeId` 对应的节点下面；**挂不上节点**的卡（老卡片没有 `nodeId`）
 *     放在最后一层（`depth 0`）逐张列出 —— 不许因为"挂不上"就看不见
 *   - 资料 / 章节行标出**子树里今天到期的张数**
 *   - `onlyDue` 时只留今天到期的卡；一张到期卡都没有的节点整段隐藏
 */
export function reviewTreeRows(
  nodes: ReviewTreeNode[],
  cards: ReviewCard[],
  todayKey: string,
  options: ReviewTreeOptions = {}
): ReviewTreeRow[] {
  const onlyDue = options.onlyDue === true
  const nodeIds = new Set(nodes.map((node) => node.id))
  const visibleCards = onlyDue ? cards.filter((card) => isDue(card, todayKey)) : cards
  const compare = dueOrder

  const childNodes = new Map<string | null, ReviewTreeNode[]>()
  for (const node of nodes) {
    const parent = node.parentId !== null && nodeIds.has(node.parentId) ? node.parentId : null
    const list = childNodes.get(parent) ?? []
    list.push(node)
    childNodes.set(parent, list)
  }
  for (const list of childNodes.values()) list.sort(byOrderThenTitle)

  /** 卡片按挂载节点分组：挂不上的收在 `unfiled` */
  const cardsOfNode = new Map<string, ReviewCard[]>()
  const unfiled: ReviewCard[] = []
  for (const card of visibleCards) {
    const nodeId = card.nodeId ?? ''
    if (nodeId !== '' && nodeIds.has(nodeId)) {
      const list = cardsOfNode.get(nodeId) ?? []
      list.push(card)
      cardsOfNode.set(nodeId, list)
    } else {
      unfiled.push(card)
    }
  }
  for (const list of cardsOfNode.values()) list.sort(compare)
  unfiled.sort(compare)

  const subtreeIds = (node: ReviewTreeNode): string[] => {
    const out: string[] = [node.id]
    const stack = [node]
    while (stack.length > 0) {
      const current = stack.pop()
      if (current === undefined) continue
      for (const child of childNodes.get(current.id) ?? []) {
        out.push(child.id)
        stack.push(child)
      }
    }
    return out
  }

  /** 子树里的卡片（含挂在自己身上的）——`visibleCards` 已按 onlyDue 筛过 */
  const cardsUnder = (node: ReviewTreeNode): ReviewCard[] => {
    const ids = new Set(subtreeIds(node))
    return visibleCards.filter((card) => (card.nodeId ?? '') !== '' && ids.has(String(card.nodeId)))
  }

  const rows: ReviewTreeRow[] = []
  const walk = (node: ReviewTreeNode, depth: number): void => {
    const under = cardsUnder(node)
    const dueUnder = under.filter((card) => isDue(card, todayKey)).length
    const own = cardsOfNode.get(node.id) ?? []
    // 「只看到期的」：整段一张到期卡都没有时不出现（否则树上全是空壳，等于没筛）
    if (onlyDue && dueUnder === 0) return
    rows.push({
      key: `node:${node.id}`,
      kind: depth === 0 ? 'material' : 'chapter',
      depth,
      id: node.id,
      title: node.title,
      badge: depth === 0 ? materialLabel(node) : '',
      dueCount: dueUnder,
      cardCount: under.length,
      card: null,
      state: null
    })
    for (const child of childNodes.get(node.id) ?? []) walk(child, depth + 1)
    for (const card of own) {
      rows.push({
        key: `card:${card.id}`,
        kind: 'card',
        depth: depth + 1,
        id: card.id,
        title: card.front,
        badge: '',
        dueCount: 0,
        cardCount: 0,
        card,
        state: cardDueState(card, todayKey)
      })
    }
  }

  for (const root of childNodes.get(null) ?? []) walk(root, 0)
  for (const card of unfiled) {
    rows.push({
      key: `card:${card.id}`,
      kind: 'card',
      depth: 0,
      id: card.id,
      title: card.front,
      badge: '',
      dueCount: 0,
      cardCount: 0,
      card,
      state: cardDueState(card, todayKey)
    })
  }

  return rows
}

/** 这个主题下有没有资料/章节（没有时树上就是一层卡片，得给一句说明） */
export function hasTreeNodes(nodes: ReviewTreeNode[]): boolean {
  return nodes.some((node) => node.id !== '')
}

/** 今天到期的卡片（**本周主题内**，按到期顺序）——中区第一块 */
export function dueCardsOf(summary: ReviewTopicSummary, todayKey: string): ReviewCard[] {
  return summary.cards.filter((card) => isDue(card, todayKey))
}
