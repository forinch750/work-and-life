/**
 * 复习页（DEVPLAN 阶段 5 / PRD §5.4；**第 10 块按定稿重做界面**）
 *
 * ## 布局（`MASTER.md` §7.6 那张图，照做的）
 *
 * ```
 * ┌ 左栏（永不动） ┬ 上：汇总横条（R1 防漏出口）+ 预览（信息卡 + 掌握度 + 按钮排）┐
 * │ 主题1    (3)   │ ─────────────────────────────────────────────────────────  │
 * │ 主题2    (2)   │ 中：今天到期的卡片 | 最近的复习记录（固定高，各自滚）      │
 * │ 主题3     —    │ ─────────────────────────────────────────────────────────  │
 * │ ─────────      │ 下：资料与章节树（**按内容高，随整页往下翻**）              │
 * │ 数据与设置     │     资料 → 章节 → 卡片（圆点＝到期状态，点卡片就地背卡）    │
 * └────────────────┴────────────────────────────────────────────────────────────┘
 * ```
 *
 * ## 复习的"主题" = 学习主题 + 读书的书（决定 17）
 *
 * 复用同一批顶层实体，**不另建一套**。卡片按 `topicId` / `bookId` /
 * 来源名归位（规则在 `shared/reviewPageView.ts` 的 `cardTopicKey`），
 * 一张都对不上的卡自己成一档——**任何一张卡都必须有归处**。
 *
 * ## 两个防漏出口（R1 / 决定 19、21）**一个都不许删**
 *
 * 去掉全局到期队列以后，"今天总共欠多少张"只剩两处能看见：
 *   ① 导航「复习」上的数字角标（`shell/badges.tsx`）
 *   ② 本页顶部的汇总横条（含各主题分布明细 + 「汇总复习（N）」按钮）
 * 两者都由 `dueTotalOf(buildReviewTopics(…))` 这**一个数**算出来；
 * 少一个，漏复习就又是**静默**的了。
 *
 * ## 本块只重做界面，不重写逻辑
 *
 * - **间隔算法一个字都没动**（决定：照旧，只换入口）：评分仍走 `applyGrade()`
 * - **历史裁剪照旧**：每卡最近 50 次，仍走 `historyAfterAppend()`
 * - **就地背卡的评分落库只有一个出口**：`writeGrade()`（卡片 + 历史 + 裁剪三件事一起做）
 * - 骨架、滚轮规矩、预览区 class 全部复用 08/09 块的公共件
 */
import { useCallback, useEffect, useMemo, useState } from 'react'
import { dateKey } from '../../../shared/date'
import {
  BACKLOG_THRESHOLD,
  GRADE_LABELS,
  addDaysToKey,
  applyGrade,
  backlogInfo,
  dueQueue,
  historiesOf,
  historyAfterAppend,
  historyFromOutcome,
  historyRetentionText,
  intervalHintDays,
  normalizeReviewCard,
  normalizeReviewHistory,
  summaryDistributionText,
  summaryTotalText,
  type GradeOutcome,
  type ReviewCard,
  type ReviewGrade,
  type ReviewHistory
} from '../../../shared/review'
import { effectiveIntensity, type ReviewIntensity } from '../../../shared/preferences'
import { isTopicEntered } from '../../../shared/learningPageView'
import { normalizeLearningRecord, type LearningNode } from '../../../shared/learning'
import { normalizeReadingRecord, type ReadingNode } from '../../../shared/reading'
import {
  buildReviewTopics,
  dueCardsOf,
  dueStateCounts,
  dueTotalOf,
  hiddenCount,
  hiddenTopics,
  isTopicDeletable,
  recentReviewRows,
  reviewDistributionBuckets,
  reviewTopicSources,
  reviewTreeRows,
  topicDeleteCardIds,
  topicDueBadgeText,
  topicListMetaText,
  topicPreviewTexts,
  visibleTopics,
  type ReviewTreeNode,
  type ReviewTopicSummary
} from '../../../shared/reviewPageView'
import { getDataApi } from '../../lib/dataClient'
import { notifyDataChanged } from '../../lib/dataEvents'
import { loadPreferences, saveReviewHiddenTopicIds } from '../../lib/prefsClient'
import { PageShell } from '../../shell/PageShell'
import { EmptyState } from '../../shell/EmptyState'
import { ConfirmDialog, FormDrawer, type FormValues } from '../../shell/Editors'
import { BandCard, ModuleBands } from '../../shell/ModuleBands'
import { SidebarListPortal } from '../../shell/SidebarSlot'
import { MenuButton, ContextMenu, useContextMenu, type UseContextMenuResult } from '../../shell/ContextMenu'
import { dueCardRowMenuItems, reviewTopicMenuItems, toSpecs } from '../../../shared/contextMenu'
import type { MenuItemSpec } from '../../../shared/menuItems'
import { copyText } from '../../lib/clipboard'
import { useHotkeys } from '../../lib/hotkeys'
import { ReviewTree } from './ReviewTree'

const GRADE_KEYS: Record<string, ReviewGrade> = {
  '1': 'forgot',
  '2': 'fuzzy',
  '3': 'remembered'
}

/** 「最近的复习记录」一次最多渲染多少条（总数另有说明，不靠"看得见几条"表达） */
const HISTORY_PAGE_SIZE = 30

/** 一条记录在界面上活着的判据（回收站里的不算） */
function isAlive(record: Record<string, unknown>): boolean {
  return record['deletedAt'] === undefined || record['deletedAt'] === null
}

/**
 * 待确认的「删除这个来源档」（修改 3 轮 · 2026-10）。
 *
 * 存的是**打开菜单那一刻**算好的快照（档名 + 这一档的卡片 id），不是 `summary` 对象：
 * 确认框开着期间数据可能被别处改动，快照能保证"确认后删哪些卡"与"用户看到的张数"
 * 始终是同一份。`cardIds` 来自 `reviewPageView` 的 `topicDeleteCardIds()`，
 * 页面里**没有**第二份"这张卡属于哪一档"的判断。
 */
interface TopicDeleteTarget {
  key: string
  title: string
  cardIds: string[]
}

export interface ReviewPageProps {
  /** 复习间隔强度（从设置里读，默认标准） */
  intensity?: ReviewIntensity
  /** 测试注入用：当前时间 */
  now?: Date
}

export function ReviewPage({ intensity = 'standard', now }: ReviewPageProps): React.JSX.Element {
  const today = useMemo(() => now ?? new Date(), [now])
  const todayKeyValue = dateKey(today)

  // ---- 数据 ----
  const [cards, setCards] = useState<ReviewCard[]>([])
  /**
   * 复习历史（`kind:'history'` 的记录）。
   *
   * 与 `cards` **分开存在**：历史没有正反面，混进到期队列会让"今天到期 N 张"凭空变大，
   * 复习时还会显示成一张空卡（`shared/review.ts` 的 `normalizeReviewCard` 按这条口径返回 null）。
   */
  const [histories, setHistories] = useState<ReviewHistory[]>([])
  /** 复习的"主题"来自这两个模块（学习主题 + 读书的书），加上它们各自的树 */
  const [learningTopics, setLearningTopics] = useState<Array<{ id: string; title: string }>>([])
  const [learningNodes, setLearningNodes] = useState<LearningNode[]>([])
  const [books, setBooks] = useState<Array<{ id: string; title: string }>>([])
  const [readingNodes, setReadingNodes] = useState<ReadingNode[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  // ---- 选中 / 三步走 / 只看到期 ----
  /** 左栏选中的主题 key（`topic:<id>` / `book:<id>` / `source:<来源名>`） */
  const [selectedKey, setSelectedKey] = useState<string | null>(null)
  /**
   * 三步走的第二步：「开始复习这个主题」过的那个 key。
   *
   * 「开始复习」不是路由、也不是整页替换——它只决定**下方树那一段显不显示**，
   * 预览与中区两块永远在（决定 1 / §6.7）。判定用 `isTopicEntered`
   * （与 09 块同一份实现，10/11 都照抄这三行）。
   */
  const [enteredKey, setEnteredKey] = useState<string | null>(null)
  /** 「只看到期的」：树上只留今天到期的卡 */
  const [onlyDue, setOnlyDue] = useState(false)
  /** 折叠起来的资料 / 章节（只影响显示，不影响行算法） */
  const [collapsedNodes, setCollapsedNodes] = useState<string[]>([])
  /**
   * 左栏里**被隐藏**的主题（修改 2 轮 · 2026-10）。
   *
   * 用户原话：「复习无法删除主题。」决定：**只在复习页隐藏，不删任何源数据**
   * （学习主题 / 书 / 卡片一个都不动）。存在 `app` 偏好里，跟着数据走。
   *
   * ⚠️ 这个数组**只用来过滤左栏列表**：汇总横条的总数、分布、汇总复习按钮、
   * 导航角标全部不读它——隐藏不得造成漏复习（`MASTER.md` 决定 19 / R1）。
   */
  const [hiddenTopicIds, setHiddenTopicIds] = useState<string[]>([])
  /** 「显示已隐藏(N)」开关：打开后灰显的隐藏行出现，并能就地取消隐藏 */
  const [showHiddenTopics, setShowHiddenTopics] = useState(false)
  /**
   * 待确认的「删除这个来源档」（修改 3 轮 · 2026-10）。
   *
   * 用户原话：「这个还是删不掉。」上一轮按"只在复习页隐藏它"做的最小集，
   * **从来就没有删除项** —— 这次补的是删除，但**只给来源档**
   * （`source:` 档不是实体，删它 = 把它下面的卡片一起删掉，进回收站可恢复）。
   */
  const [pendingTopicDelete, setPendingTopicDelete] = useState<TopicDeleteTarget | null>(null)

  // ---- 会话（一屏一张卡；「汇总复习」用的就是它） ----
  const [sessionIds, setSessionIds] = useState<string[] | null>(null)
  /** 本次会话已处理过的卡片 id，用于保证"评过的卡不再出现" */
  const [handledCardIds, setHandledCardIds] = useState<string[]>([])
  const [handled, setHandled] = useState(0)
  const [revealed, setRevealed] = useState(false)
  const [flash, setFlash] = useState<string | null>(null)

  // ---- 就地背卡（决定 18） ----
  /**
   * 展开的是哪张卡、是否已显示答案。
   *
   * 与"会话"是两套状态，互不影响：
   *   - 会话（`sessionIds`）= 从「汇总复习」进来，一屏一张过一遍到期的卡
   *   - 就地 = 我在树里点开某一张，就地背一下（不跳页、不进队列）
   */
  const [inlineCardId, setInlineCardId] = useState<string | null>(null)
  const [inlineRevealed, setInlineRevealed] = useState(false)

  // ---- 历史筛选 / 表单 ----
  /** 「看历史」把中区那一块筛到某一张卡（null = 看全部） */
  const [historyCardId, setHistoryCardId] = useState<string | null>(null)
  const [historyNotice, setHistoryNotice] = useState<string | null>(null)
  /** 手写新建 / 编辑复习卡（BUG-004 / 第 03 块接的「编辑」） */
  const [cardOpen, setCardOpen] = useState(false)
  const [editCard, setEditCard] = useState<ReviewCard | null>(null)
  const [cardInitial, setCardInitial] = useState<FormValues>({
    front: '',
    back: '',
    dueDate: '',
    dueTime: '',
    source: ''
  })
  /** 编辑主题（改名）：学习主题改主题名、书改书名、来源档改这批卡的来源 */
  const [topicEditOpen, setTopicEditOpen] = useState(false)
  const [topicEditTitle, setTopicEditTitle] = useState('')
  const [topicTitles, setTopicTitles] = useState<string[]>([])
  /**
   * 卡片菜单（第 03 块）：树的卡片行 `⋯` 与右键**共用这一份状态**，
   * 同屏因此只有一个浮层。菜单项内容来自 `shared/contextMenu.ts`。
   */
  const menu = useContextMenu()

  // ---------------------------------------------------------------------
  // 读数据
  // ---------------------------------------------------------------------
  const reload = useCallback(async () => {
    try {
      const [reviewRecords, learningRecords, readingRecords] = await Promise.all([
        getDataApi().list('review'),
        getDataApi().list('learning'),
        getDataApi().list('reading')
      ])
      // 左栏隐藏了哪些主题（"这个人的查看偏好"，不是卡片数据）
      const preferences = await loadPreferences()
      setHiddenTopicIds(preferences.reviewHiddenTopicIds ?? [])
      const aliveReview = (reviewRecords as unknown as Array<Record<string, unknown>>).filter(isAlive)
      setCards(
        aliveReview
          .map((record) => normalizeReviewCard(record))
          .filter((card): card is ReviewCard => card !== null && card.front !== '')
      )
      setHistories(
        aliveReview
          .map((record) => normalizeReviewHistory(record))
          .filter((entry): entry is ReviewHistory => entry !== null)
      )

      const aliveLearning = (learningRecords as unknown as Array<Record<string, unknown>>).filter(isAlive)
      const learning = aliveLearning
        .map((record) => normalizeLearningRecord(record))
        .filter((record): record is NonNullable<typeof record> => record !== null)
      setLearningTopics(
        learning
          .filter((record) => record.kind === 'topic')
          .map((record) => ({ id: record.id, title: record.title }))
          .filter((topic) => topic.title !== '')
      )
      setLearningNodes(
        learning.filter((record): record is LearningNode => record.kind === 'node')
      )

      const aliveReading = (readingRecords as unknown as Array<Record<string, unknown>>).filter(isAlive)
      const reading = aliveReading
        .map((record) => normalizeReadingRecord(record))
        .filter((record): record is NonNullable<typeof record> => record !== null)
      setBooks(
        reading
          .filter((record) => record.kind === 'book')
          .map((record) => ({ id: record.id, title: record.title }))
          .filter((book) => book.title !== '')
      )
      setReadingNodes(
        reading.filter((record): record is ReadingNode => record.kind === 'node')
      )

      setError(null)
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void reload()
  }, [reload])

  /**
   * 别的页写入了数据就跟着刷新。
   *
   * 复习页现在依赖三个模块（review 是主体，learning / reading 提供"主题与树"），
   * 任何一个变了都要重读——不然左边主题数与树会停在旧状态。
   */
  useEffect(() => {
    const handler = (): void => {
      void reload()
    }
    window.addEventListener('worklife:data-changed', handler)
    return () => window.removeEventListener('worklife:data-changed', handler)
  }, [reload])

  /** 卡片表单里"关联学习项"下拉的候选（沿用 06 块的来源下拉） */
  useEffect(() => {
    setTopicTitles(learningTopics.map((topic) => topic.title))
  }, [learningTopics])

  // ---------------------------------------------------------------------
  // 视图计算（全部走 shared/reviewPageView.ts，页面里不重算）
  // ---------------------------------------------------------------------
  const sources = useMemo(
    () => reviewTopicSources(learningTopics, books),
    [learningTopics, books]
  )
  const summaries = useMemo(
    () => buildReviewTopics(cards, sources, todayKeyValue),
    [cards, sources, todayKeyValue]
  )
  const due = useMemo(() => dueQueue(cards, todayKeyValue), [cards, todayKeyValue])
  /**
   * 汇总横条与导航角标用的**同一个数**（防漏的核心不变量）。
   *
   * `due.length` 是"到期队列"的读数，`dueTotal` 是"各主题自己的到期数相加"，
   * 两者恒等（`tests/review/reviewPageView.test.ts` 钉住）；页面上两个都写进 `data-*`，
   * 端到端验收直接比这两个读数。
   */
  const dueTotal = useMemo(() => dueTotalOf(summaries), [summaries])
  /**
   * 汇总横条的"分布"句（修改 2 轮）。
   *
   * 数据源从"按卡片的 `source` 字符串分组"换成"按复习主题"：
   * 只有这样才能把「（已隐藏）」标到**对的**那一行上。
   * 数字口径没变——Σ 分布里的张数 ≡ `dueTotal` ≡ `due.length` ≡ 导航角标。
   * 已隐藏的主题**照样在分布里**，不许凭空消失。
   */
  const distribution = useMemo(
    () => reviewDistributionBuckets(summaries, hiddenTopicIds),
    [summaries, hiddenTopicIds]
  )
  const backlog = backlogInfo(due.length)

  /** 左栏要显示的行 / 被隐藏的行 / 隐藏了几个（纯逻辑在 shared，页面里不重算） */
  const visibleTopicList = useMemo(
    () => visibleTopics(summaries, hiddenTopicIds),
    [summaries, hiddenTopicIds]
  )
  const hiddenTopicList = useMemo(
    () => hiddenTopics(summaries, hiddenTopicIds),
    [summaries, hiddenTopicIds]
  )
  const hiddenTotal = useMemo(() => hiddenCount(summaries, hiddenTopicIds), [summaries, hiddenTopicIds])

  const selected = useMemo(() => {
    if (selectedKey === null) return null
    return summaries.find((item) => item.key === selectedKey) ?? null
  }, [selectedKey, summaries])
  const entered = isTopicEntered(enteredKey, selectedKey)
  const previewTexts = selected === null ? null : topicPreviewTexts(selected)
  const stateCounts = useMemo(
    () => (selected === null ? null : dueStateCounts(selected.cards, todayKeyValue)),
    [selected, todayKeyValue]
  )

  /** 选中主题的树节点（学习主题与书各取各的那一份，口径与学习/读书页一致） */
  const treeNodes = useMemo<ReviewTreeNode[]>(() => {
    if (selected === null) return []
    if (selected.kind === 'learning') {
      return learningNodes
        .filter((node) => node.ownerId === selected.id || node.topicId === selected.id)
        .map((node) => ({
          id: node.id,
          parentId: node.parentId,
          order: node.order,
          title: node.title,
          group: node.group,
          resourceType: node.resourceType
        }))
    }
    if (selected.kind === 'book') {
      return readingNodes
        .filter((node) => node.ownerId === selected.id)
        .map((node) => ({ id: node.id, parentId: node.parentId, order: node.order, title: node.title }))
    }
    return []
  }, [selected, learningNodes, readingNodes])

  const treeRows = useMemo(
    () => reviewTreeRows(treeNodes, selected?.cards ?? [], todayKeyValue, { onlyDue }),
    [treeNodes, selected, todayKeyValue, onlyDue]
  )

  /** 节点标题（中区「今天到期的卡片」要标出"出处"） */
  const nodeTitles = useMemo(() => {
    const map = new Map<string, string>()
    for (const node of treeNodes) map.set(node.id, node.title)
    return map
  }, [treeNodes])

  /** 中区第一块：今天到期的卡片（选中主题时只看这个主题） */
  const dueCards = useMemo(
    () => (selected === null ? due : dueCardsOf(selected, todayKeyValue)),
    [selected, due, todayKeyValue]
  )
  /** 中区第二块：最近的复习记录（选中主题时只看这个主题） */
  const historyRows = useMemo(() => {
    const scope = selected === null ? undefined : selected.cards.map((card) => card.id)
    const rows = recentReviewRows(histories, cards, HISTORY_PAGE_SIZE, scope)
    if (historyCardId === null) return rows
    return rows.filter((row) => row.cardId === historyCardId)
  }, [histories, cards, selected, historyCardId])

  const cardById = useMemo(() => new Map(cards.map((card) => [card.id, card])), [cards])
  const historyFilterCard = historyCardId === null ? null : cardById.get(historyCardId) ?? null

  /**
   * 验收挂点：**卡片 → 主题** 的映射（与 `__treeParentMap` 同一类东西）。
   *
   * 端到端验收要先"点中这张卡所属的主题 → 再展开它的树"才能看到卡片行；
   * 让验收自己再算一遍归属规则等于把 `cardTopicKey` 抄第二遍，
   * 一旦规则改了就会出现"页面对了、验收还在按老规则找"的假失败。
   */
  useEffect(() => {
    const host = window as unknown as {
      __reviewCardTopics?: Record<string, string>
      __reviewTopicDue?: Record<string, number>
      __reviewTopicCards?: Record<string, number>
    }
    const mapping: Record<string, string> = {}
    const dues: Record<string, number> = {}
    const counts: Record<string, number> = {}
    for (const summary of summaries) {
      dues[summary.key] = summary.dueCount
      counts[summary.key] = summary.cardCount
      for (const card of summary.cards) mapping[card.id] = summary.key
    }
    host.__reviewCardTopics = mapping
    host.__reviewTopicDue = dues
    host.__reviewTopicCards = counts
  }, [summaries])

  // ---------------------------------------------------------------------
  // 写数据
  // ---------------------------------------------------------------------
  const notify = (text: string): void => {
    setFlash(text)
    setTimeout(() => setFlash(null), 2000)
  }

  /** 保存手写的复习卡（新建与编辑共用；`editCard` 非空时是编辑） */
  const onSubmitCard = async (values: FormValues): Promise<void> => {
    const front = (values['front'] ?? '').trim()
    if (front === '') throw new Error('正面不能为空')
    const dueDate = (values['dueDate'] ?? '').trim()
    const dueTime = (values['dueTime'] ?? '').trim()
    const source = (values['source'] ?? '').trim()

    if (editCard !== null) {
      // 编辑：只改内容与复习时间，**不动 stage / reviewCount**
      // （那两项是复习算法推进出来的，改一次内容不该把进度清零）
      await getDataApi().update('review', editCard.id, {
        front,
        back: (values['back'] ?? '').trim(),
        ...(source === '' ? {} : { source }),
        dueDate: dueDate === '' ? null : dueDate,
        // 传 null 而不是 undefined：undefined 会被 JSON 序列化整条丢掉，
        // 用户把时间清空后旧值就清不掉了（05 块的 startTime 踩过同一个坑）
        dueTime: dueTime === '' ? null : dueTime
      })
      await getDataApi().flush()
      await reload()
      notifyDataChanged('review')
      notify('已保存卡片')
      return
    }

    await getDataApi().add('review', {
      front,
      back: (values['back'] ?? '').trim(),
      source: source === '' ? '手动新建' : source,
      stage: 0,
      // 留空表示今天就要复习
      dueDate: dueDate === '' ? todayKeyValue : dueDate,
      ...(dueTime === '' ? {} : { dueTime }),
      reviewCount: 0,
      lastReviewedAt: null
    })
    await getDataApi().flush()
    await reload()
    notifyDataChanged('review')
    notify('已新建复习卡')
  }

  /** 打开"编辑卡片"表单（第 03 块右键菜单里的"编辑"） */
  const openEditCard = (card: ReviewCard): void => {
    setEditCard(card)
    setCardInitial({
      front: card.front,
      back: card.back,
      dueDate: card.dueDate ?? '',
      dueTime: card.dueTime ?? '',
      source: card.source
    })
    setCardOpen(true)
  }

  /** 删除一张卡（进回收站，不是物理删除） */
  const removeCard = async (card: ReviewCard): Promise<void> => {
    await getDataApi().remove('review', card.id)
    await getDataApi().flush()
    await reload()
    notifyDataChanged('review')
    notify('已删除，可在「数据与设置 → 回收站」里恢复')
  }

  /**
   * 设置复习时间：把到期日挪到 `days` 天之后。
   * 用 `date.ts` 的加法（与复习算法同一个日期工具），不另写一份日期逻辑。
   */
  const setCardDueInDays = async (card: ReviewCard, days: number): Promise<void> => {
    await getDataApi().update('review', card.id, { dueDate: addDaysToKey(todayKeyValue, days) })
    await getDataApi().flush()
    await reload()
    notifyDataChanged('review')
    notify(days === 0 ? '已设为今天复习' : `已设为 ${days} 天后再复习`)
  }

  const clearCardDue = async (card: ReviewCard): Promise<void> => {
    // dueDate 为 null 的语义是"今天就要复习"（见 shared/review.ts）
    await getDataApi().update('review', card.id, { dueDate: null })
    await getDataApi().flush()
    await reload()
    notifyDataChanged('review')
    notify('已清空复习时间：这张卡今天就要复习')
  }

  /**
   * 把中区「最近的复习记录」筛到某一张卡（第 03 块菜单项，第 06 块补的界面）。
   *
   * 同时更新那条说明（`review-history-notice`）：它既是给用户看的交代，
   * 也是验收的读数点（03 块的 P8-J9 一直在等它）。
   */
  const viewCardHistory = (card: ReviewCard): void => {
    const count = historiesOf(histories, card.id).length
    setHistoryCardId(card.id)
    setHistoryNotice(
      count === 0
        ? `「${card.front.slice(0, 20)}」还没有复习历史：评一次分就会记一条`
        : `已显示「${card.front.slice(0, 20)}」的 ${count} 条复习历史（每张卡只保留最近 50 次）`
    )
  }

  /**
   * 隐藏 / 取消隐藏一个主题（修改 2 轮）。
   *
   * **只写偏好里那一个数组**，不碰学习主题 / 书 / 卡片——所以这次操作
   * 对今天的到期总数、分布、汇总复习、导航角标**没有任何影响**。
   */
  const toggleTopicHidden = async (summary: ReviewTopicSummary): Promise<void> => {
    const hidden = hiddenTopicIds.includes(summary.key)
    const next = hidden
      ? hiddenTopicIds.filter((key) => key !== summary.key)
      : [...hiddenTopicIds, summary.key]
    const saved = await saveReviewHiddenTopicIds(next)
    setHiddenTopicIds(saved)
    await reload()
    notify(hidden ? `已取消隐藏「${summary.title}」` : `已隐藏「${summary.title}」（数据没动，随时能取消）`)
  }

  /**
   * 删除一个**来源档**（连带它下面的卡片；进回收站，可恢复）—— 修改 3 轮。
   *
   * ## 落库路径复用 `removeCard` 那一条
   *
   * 对每一张卡逐条 `getDataApi().remove('review', id)`，**不新写批量删的 API / IPC**：
   * 逐条删走的是已经验收过的那条路（软删除 + 回收站 + 通知），
   * 因此"删来源档"与"删一张卡"在数据层的效果完全一样，不会有一套只对批量生效的规则。
   *
   * 只 `flush()` 一次：`remove()` 只是登记，最后统一落盘就够。这里把 N 次
   * `removeCard` 的"逐条删 + 最后统一落盘"合到一起，是因为每张都
   * reload / notify 会把界面刷 N 遍、通知互相覆盖（而落库口径一字未变）。
   */
  const removeSourceTopic = async (target: TopicDeleteTarget): Promise<void> => {
    for (const cardId of target.cardIds) {
      await getDataApi().remove('review', cardId)
    }
    await getDataApi().flush()
    /**
     * 顺手清掉偏好里可能留着的这个 key。
     *
     * 不清的话：这一档先被"隐藏"、之后又从「显示已隐藏」里删掉，
     * 偏好里就留下一个已经没有行的 key；等用户再用同一个来源名新建卡片，
     * 那一档**一出现就是隐藏的**（左栏看不到，又要说"又不见了"）。
     */
    if (hiddenTopicIds.includes(target.key)) {
      const saved = await saveReviewHiddenTopicIds(
        hiddenTopicIds.filter((key) => key !== target.key)
      )
      setHiddenTopicIds(saved)
    }
    await reload()
    notifyDataChanged('review')
    /**
     * 选中态复位：选中正好是这一档时，切到第一个可见主题（一个都没有就清空）。
     *
     * 不复位的话预览区会继续显示一个已经不存在的数据（`selected` 变成 null，
     * 但"进入那一档"的标记还在），用户看到的是"删了却还在预览里"。
     */
    if (selectedKey === target.key) {
      const next = visibleTopicList.find((item) => item.key !== target.key)
      setSelectedKey(next === undefined ? null : next.key)
      setEnteredKey(null)
      setInlineCardId(null)
      setInlineRevealed(false)
    }
    setPendingTopicDelete(null)
    notify(`已删除「${target.title}」下的 ${target.cardIds.length} 张卡片，可在回收站恢复`)
  }

  /**
   * 左栏主题行的菜单项（隐藏 / 取消隐藏；**来源档**多一条「删除这个来源档」）。
   *
   * 定义在 `shared/contextMenu.ts`，这里是唯一一份。两件事都**不在页面里现算**：
   *   - 能不能删：`isTopicDeletable(summary)`（key 前缀的判断只在 `reviewPageView` 里）
   *   - 删哪些卡：`topicDeleteCardIds(summary)`（直接用 `buildReviewTopics` 的分组结果）
   */
  const topicItems = (summary: ReviewTopicSummary): MenuItemSpec[] =>
    toSpecs(
      reviewTopicMenuItems({
        hidden: hiddenTopicIds.includes(summary.key),
        onToggleHidden: () => void toggleTopicHidden(summary),
        deletable: isTopicDeletable(summary),
        cardCount: summary.cardCount,
        onDelete: () =>
          setPendingTopicDelete({
            key: summary.key,
            title: summary.title,
            cardIds: topicDeleteCardIds(summary)
          })
      })
    )

  const copyCard = async (card: ReviewCard): Promise<void> => {
    const ok = await copyText(`${card.front}\n\n${card.back}`)
    notify(ok ? '已复制卡片内容' : '复制失败：剪贴板不可用')
  }

  /**
   * 一张卡的菜单项。
   *
   * **唯一的定义来源**是 `shared/contextMenu.ts` 的 `cardMenuItems`——
   * 树里每一行、以及中区「今天到期的卡片」每一行，都调这一个函数。
   * `dueCardRowMenuItems` 只是那个定义的中区入口（0 个新增项），
   * 所以两个位置永远同步（`tests/shell/bandRowMenus.test.ts` 钉住）。
   */
  const cardItems = (card: ReviewCard): MenuItemSpec[] =>
    toSpecs(
      dueCardRowMenuItems({
        scheduled: card.dueDate !== null,
        onEdit: () => openEditCard(card),
        onDelete: () => void removeCard(card),
        onSetReviewInDays: (days) => void setCardDueInDays(card, days),
        onClearReview: () => void clearCardDue(card),
        onViewHistory: () => viewCardHistory(card),
        onCopy: () => void copyCard(card)
      })
    )

  /**
   * 评分一次并落库（会话与就地背卡**共用这一段**，**唯一出口**）。
   *
   * 三件事一起做，缺一件就会"数据与界面各说各话"：
   *   1. 卡片本身：stage / dueDate / reviewCount / lastReviewedAt
   *   2. **一条历史**（`historyFromOutcome`，applyGrade 的返回值已带齐全部字段）
   *   3. 按"每卡最近 50 次"裁剪：多出来的**硬删**（`historyAfterAppend` 给 id）
   *
   * 硬删而不是进回收站：历史裁剪是程序自己的容量管理，
   * 每评 50 次就往用户回收站里塞一批空壳，等于把回收站变垃圾场。
   */
  const writeGrade = useCallback(
    async (cardId: string, value: ReviewGrade): Promise<GradeOutcome | null> => {
      // 以主进程最新记录为准，避免连续评分时用过期的 stage
      const fresh = (await getDataApi().list('review')) as unknown as Array<Record<string, unknown>>
      const latest = fresh
        .map((record) => normalizeReviewCard(record))
        .find((card) => card?.id === cardId)
      if (!latest) return null

      // 阶段推进与间隔计算必须走已测过的 applyGrade，
      // 不在界面里重写一遍——否则两处规则会逐渐漂移。
      const outcome = applyGrade(latest, value, todayKeyValue, effectiveIntensity(intensity))
      const atISO = new Date().toISOString()

      await getDataApi().update('review', cardId, {
        stage: outcome.stageAfter,
        dueDate: outcome.dueDate,
        reviewCount: outcome.reviewCount,
        lastReviewedAt: atISO
      })

      // 历史：先写新的一条，再按"每卡 50 条"裁剪（决定 20）
      const created = (await getDataApi().add(
        'review',
        historyFromOutcome(cardId, outcome, atISO) as unknown as Record<string, unknown>
      )) as unknown as Record<string, unknown>
      const entry = normalizeReviewHistory(created)
      if (entry !== null) {
        const existing = fresh
          .map((record) => normalizeReviewHistory(record))
          .filter((item): item is ReviewHistory => item !== null)
        const { dropped } = historyAfterAppend(existing, entry)
        for (const id of dropped) {
          await getDataApi().remove('review', id, true)
        }
      }

      await getDataApi().flush()
      await reload()
      notifyDataChanged('review')
      return outcome
    },
    [intensity, reload, todayKeyValue]
  )

  /**
   * 会话队列。
   *
   * 语义（两个要求同时满足，缺一个都会出问题）：
   *   1. **已评过的卡不再出现** —— 所以会话开始时把当时的 due 快照下来，之后不重排
   *   2. **会话为空时不能被"卡死"** —— 复习期间别处可能新生成卡片（学习日志、
   *      读书摘录、备忘都能生成），如果队列永远固定在开始那一刻，用户就会看到
   *      "本轮已完"却明明还有到期卡，只能退出再进来
   *
   * 因此：先按快照顺序出卡；快照取完之后，把**会话期间新到期、且本次会话还没处理过**
   * 的卡补进来。顺序仍以快照为准，不会因为中途补卡而跳卡。
   */
  const queue = useMemo(() => {
    const handledIds = new Set(handledCardIds)
    if (sessionIds === null) return due
    const byId = new Map(cards.map((card) => [card.id, card]))
    const snapshot = sessionIds
      .filter((id) => !handledIds.has(id))
      .map((id) => byId.get(id))
      .filter((card): card is ReviewCard => card !== undefined)
    const extra = due.filter((card) => !handledIds.has(card.id) && !sessionIds.includes(card.id))
    return [...snapshot, ...extra]
  }, [sessionIds, due, cards, handledCardIds])

  const current = queue[0] ?? null
  const sessionActive = sessionIds !== null

  const flashFor = useCallback((outcome: GradeOutcome) => {
    setFlash(`${GRADE_LABELS[outcome.grade]} → ${outcome.intervalDays} 天后再考你`)
    setTimeout(() => setFlash(null), 1600)
  }, [])

  /**
   * 开始一轮「汇总复习」：**全部主题**按到期顺序逐张过（原来的全局队列，
   * 现在降级成可选入口 —— 主入口是按主题进入树里就地背卡）。
   */
  const startSession = useCallback(() => {
    setSessionIds(due.map((card) => card.id))
    setHandledCardIds([])
    setHandled(0)
    setRevealed(false)
  }, [due])

  /** 会话里评一张：评完翻下一张 */
  const grade = useCallback(
    async (value: ReviewGrade) => {
      if (!current) return
      const outcome = await writeGrade(current.id, value)
      if (outcome === null) return
      setRevealed(false)
      setHandled((count) => count + 1)
      flashFor(outcome)
      // 队列前移：移除刚评过的卡，并记下它，保证本次会话不再出现
      setSessionIds((ids) => (ids === null ? null : ids.filter((id) => id !== current.id)))
      setHandledCardIds((ids) => (ids.includes(current.id) ? ids : [...ids, current.id]))
    },
    [current, flashFor, writeGrade]
  )

  /** 就地背卡里评一张：评完留在原地（卡片与历史当场更新，方便看"下次什么时候"） */
  const gradeInline = useCallback(
    async (cardId: string, value: ReviewGrade) => {
      const outcome = await writeGrade(cardId, value)
      if (outcome === null) return
      setInlineRevealed(false)
      flashFor(outcome)
    },
    [flashFor, writeGrade]
  )

  const toggleInlineCard = useCallback((card: ReviewCard) => {
    setInlineCardId((currentId) => (currentId === card.id ? null : card.id))
    setInlineRevealed(false)
  }, [])

  const openNewCard = (): void => {
    // 先清掉"正在编辑的那张卡"，否则会变成"点新建却在改旧卡"
    setEditCard(null)
    setCardInitial({
      front: '',
      back: '',
      dueDate: todayKeyValue,
      dueTime: '',
      source: ''
    })
    setCardOpen(true)
  }

  /** 编辑主题：三种来源各写各的那个模块（复习页不复制一份编辑表单，只改名字） */
  const onSaveTopicTitle = async (values: FormValues): Promise<void> => {
    if (selected === null) throw new Error('没有选中的主题')
    const title = (values['title'] ?? '').trim()
    if (title === '') throw new Error('名字不能为空')
    if (selected.kind === 'learning') {
      await getDataApi().update('learning', selected.id, { title })
      notifyDataChanged('learning')
    } else if (selected.kind === 'book') {
      await getDataApi().update('reading', selected.id, { title })
      notifyDataChanged('reading')
    } else {
      // 来源档：这批卡片本来就是"按来源名归在一起"的，改名 = 改它们的 source
      for (const card of selected.cards) {
        await getDataApi().update('review', card.id, { source: title })
      }
      notifyDataChanged('review')
    }
    await getDataApi().flush()
    await reload()
    setSelectedKey(selected.kind === 'source' ? `source:${title}` : selected.key)
    notify('已改名')
  }

  // ---- 键盘全流程：空格显示答案；1/2/3 评分；Esc 退出 ----
  //
  // 两套状态、一套键：
  //   - **会话在手**（点过「汇总复习」）→ 键盘作用于当前那张卡
  //   - **没开会话**但树里展开了一张卡 → 键盘作用于**那张展开的卡**（就地背卡）
  //
  // ⚠️ 判断"有没有会话"必须看 `sessionIds !== null`，**不能看 `queue[0]` 在不在**：
  // `queue` 在没有会话时就是"今天到期的全部卡片"，`queue[0]` 永远非空。
  // 早先按 `current` 判断的写法会让空格去打开一张**屏幕上根本看不见**的卡（已踩过：
  // 就地背卡按空格没反应，因为焦点被分给了队列头）。
  const sessionCard = sessionIds !== null ? current : null
  /**
   * 键盘"有没有作用对象"只看**两个 id**，不看渲染出来的卡片对象。
   *
   * 为什么（第 12 块全量验收抓到的真实缺陷）：`writeGrade` 末尾会 `reload()` 重读数据，
   * 而重读完成的瞬间 `cards` 可能短暂查不到那张卡（对象被新数组替换）；
   * 早先这里用"渲染出来的那张卡"当判据，于是"评分后紧接着按下一个档位"那一下
   * **会被静默丢掉**——现象就是三档连按时第三档不落库（`P8-U7` 偶发过一次）。
   * 评分只需要卡片 id，所以判据一律用 id。
   */
  const hasKeyboardCard = sessionCard !== null || inlineCardId !== null
  const keyboardRevealed = sessionCard !== null ? revealed : inlineRevealed

  const revealKeyboardCard = useCallback(() => {
    if (sessionCard !== null) setRevealed(true)
    else if (inlineCardId !== null) setInlineRevealed(true)
  }, [inlineCardId, sessionCard])

  const gradeKeyboardCard = useCallback(
    (value: ReviewGrade) => {
      if (sessionCard !== null) {
        void grade(value)
        return
      }
      if (inlineCardId !== null) void gradeInline(inlineCardId, value)
    },
    [grade, gradeInline, inlineCardId, sessionCard]
  )

  useHotkeys([
    {
      combo: 'space',
      handler: () => {
        if (hasKeyboardCard && !keyboardRevealed) revealKeyboardCard()
      }
    },
    {
      combo: '1',
      handler: () => {
        if (hasKeyboardCard && keyboardRevealed) gradeKeyboardCard('forgot')
      }
    },
    {
      combo: '2',
      handler: () => {
        if (hasKeyboardCard && keyboardRevealed) gradeKeyboardCard('fuzzy')
      }
    },
    {
      combo: '3',
      handler: () => {
        if (hasKeyboardCard && keyboardRevealed) gradeKeyboardCard('remembered')
      }
    },
    {
      combo: 'escape',
      handler: () => {
        // 退出复习：清掉会话，进度已落盘，队列下次继续
        setSessionIds(null)
        setHandledCardIds([])
        setRevealed(false)
      }
    }
  ])

  const intensityResolved = effectiveIntensity(intensity)

  // ---------------------------------------------------------------------
  // 中区两块（§6.4：固定高度、各自内部滚）
  // ---------------------------------------------------------------------
  const sourceLabelOf = (card: ReviewCard): string => {
    const nodeTitle = card.nodeId === undefined ? '' : nodeTitles.get(card.nodeId) ?? ''
    return nodeTitle === '' ? card.source : `${card.source} · ${nodeTitle}`
  }

  const dueCard = (
    <BandCard
      title="今天到期的卡片"
      count={dueCards.length}
      testId="review-due-card"
      empty="今天没有到期的卡片。"
    >
      <ul className="band-list">
        {dueCards.map((card) => (
          <li
            key={card.id}
            className="band-list__row"
            data-testid="review-due-row"
            data-card-id={card.id}
            // 右键也能出菜单（与 `⋯` 取同一批项，第 03 块的规矩）
            onContextMenu={(event) =>
              menu.openFromEvent(event, cardItems(card), `review-due-row:${card.id}`)
            }
          >
            <span className="band-list__title" data-testid="review-due-row-front">
              {card.front}
            </span>
            {/* 出处：来源 + 挂在哪一章 */}
            <span className="band-list__tail">
              <span className="band-list__meta" data-testid="review-due-row-source">
                {sourceLabelOf(card)}
              </span>
              {/*
                `⋯` 菜单（2026-10 修订）：菜单项由 `cardItems(card)` 现算，
                与树里卡片行的 `⋯` / 右键**完全一致**（编辑 / 删除 / 设置复习时间 / 看历史）。
                删除仍走 `removeCard`（进回收站，可恢复），不新写一条路径。
              */}
              <MenuButton
                menu={menu}
                items={() => cardItems(card)}
                testId="review-due-row-menu"
                className="row-menu-button"
                label="这张卡的更多操作"
              />
            </span>
          </li>
        ))}
      </ul>
    </BandCard>
  )

  const historyCard = (
    <BandCard
      title="最近的复习记录"
      count={historyRows.length}
      testId="review-history"
      empty="还没有复习历史。评一次分就会记一条。"
    >
      {historyCardId === null ? null : (
        <p className="band-list__row" data-testid="review-history-scope">
          只看「{(historyFilterCard?.front ?? '').slice(0, 20)}」的历史
          <button
            type="button"
            className="link"
            data-testid="review-history-all"
            onClick={() => {
              setHistoryCardId(null)
              setHistoryNotice(null)
            }}
          >
            看全部
          </button>
        </p>
      )}
      <ul className="history-list" data-testid="review-history-list">
        {historyRows.map((row) => (
          <li
            key={row.id}
            className="history-row"
            data-testid="review-history-row"
            data-card-id={row.cardId}
            data-grade={row.grade}
            data-at={row.atISO}
          >
            <span className="history-row__time" data-testid="review-history-at" title={row.atFullText}>
              {row.atText}
            </span>
            <span className="history-row__front" data-testid="review-history-front">
              {row.front}
            </span>
            <span className="history-row__back" data-testid="review-history-back">
              {row.back}
            </span>
            <span className={`history-row__grade grade--${row.grade}`} data-testid="review-history-grade">
              {`${row.gradeLabel} · ${row.intervalText}`}
            </span>
          </li>
        ))}
      </ul>
    </BandCard>
  )

  // ---------------------------------------------------------------------
  // 上区预览（汇总横条 + 主题预览）
  // ---------------------------------------------------------------------
  const preview = (
    <>
      {/*
        汇总横条（R1 防漏出口）：全部主题到期的合计 + 各主题分布 + 「汇总复习（N）」。
        它把原来的"全局到期队列"降级成**可选入口** —— 不做也不会看不见欠多少。
      */}
      <section className="panel review-summary" data-testid="review-summary" data-due={due.length} data-topic-due-total={dueTotal}>
        <span className="review-summary__total" data-testid="review-summary-total">
          {summaryTotalText(due.length)}
        </span>
        <span className="review-summary__topics" data-testid="review-summary-topics">
          {distribution.length === 0 ? '没有到期卡片' : `分布：${summaryDistributionText(distribution)}`}
        </span>
        <span className="toolbar__spacer" />
        <button
          type="button"
          className="button button--primary"
          data-testid="review-summary-start"
          disabled={due.length === 0}
          onClick={startSession}
        >
          {`汇总复习（${due.length}）`}
        </button>
      </section>

      {backlog.show ? (
        <p className="notice notice--warn" data-testid="review-backlog">
          {backlog.message}
        </p>
      ) : null}

      {selected === null || previewTexts === null ? (
        sessionActive ? (
          // 汇总复习期间这上面不放"左侧选一个主题"那种提示：那是噪音
          <section className="panel review-summary" data-testid="review-session-hint">
            <span className="review-summary__total">汇总复习中（本轮还剩 {queue.length} 张）</span>
            <span className="review-summary__topics">
              空格显示答案，1 / 2 / 3 评分，Esc 随时退出（进度会保留）
            </span>
          </section>
        ) : (
          <EmptyState
            message="左侧选一个主题，这里就是它的复习预览。"
            hint="主题 = 学习主题 + 读书的书。每个主题右边的小红字是它自己的到期张数。"
            testId="review-detail-empty"
          />
        )
      ) : (
        <div className="preview" data-testid="review-detail" data-topic-key={selected.key}>
          {/* 左：这个主题的四个数（§6.3） */}
          <section className="preview__info" data-testid="review-info">
            <header className="detail__head">
              <h2 className="detail__title" data-testid="review-detail-title">
                {selected.title}
              </h2>
              <span
                className={`detail__badge${selected.dueCount > 0 ? ' detail__badge--due' : ''}`}
                data-testid="review-detail-due"
              >
                {selected.dueCount > 0 ? `${selected.dueCount} 张到期` : '已清'}
              </span>
            </header>
            <dl className="preview__facts">
              <div className="preview__fact">
                <dt>卡片总数</dt>
                <dd data-testid="review-fact-cards">{selected.cardCount} 张</dd>
              </div>
              <div className="preview__fact">
                <dt>已掌握</dt>
                <dd data-testid="review-fact-mastered">{selected.masteredPercent}%</dd>
              </div>
              <div className="preview__fact">
                <dt>上次复习</dt>
                <dd data-testid="review-fact-last">{previewTexts.lastReviewed}</dd>
              </div>
              <div className="preview__fact">
                <dt>下次到期</dt>
                <dd data-testid="review-fact-next">{previewTexts.nextDue}</dd>
              </div>
            </dl>
          </section>

          {/* 右：掌握度 + 四个按钮（§6.3） */}
          <section className="preview__main" data-testid="review-preview-main">
            <div className="progress" data-testid="review-progress">
              <div
                className="progress__bar"
                title="已掌握 ＝ Σ min(阶段, 4) ÷ (卡片张数 × 4)：阶段越高越熟"
              >
                <div
                  className="progress__fill"
                  style={{ width: `${selected.masteredPercent}%` }}
                  data-testid="review-progress-fill"
                />
              </div>
              <div className="progress__row">
                <span className="progress__value" data-testid="review-progress-value">
                  {selected.masteredPercent}%
                </span>
                <span className="progress__auto">＝ Σ min(阶段, 4) ÷ (张数 × 4)</span>
                <span className="toolbar__spacer" />
                {stateCounts === null ? null : (
                  <span className="review-legend" data-testid="review-dot-legend">
                    <span className="due-dot due-dot--due" /> {stateCounts.due}
                    <span className="due-dot due-dot--soon" /> {stateCounts.soon}
                    <span className="due-dot due-dot--later" /> {stateCounts.later}
                  </span>
                )}
              </div>
            </div>

            <div className="detail__actions">
              {/* 三步走的第二步入口：开始 / 收起都是它（决定 1、§6.7） */}
              <button
                type="button"
                className="button button--primary"
                data-testid="review-enter-topic"
                data-entered={entered ? '1' : '0'}
                onClick={() => setEnteredKey(entered ? null : selected.key)}
              >
                {entered ? '收起这个主题' : `开始复习这个主题（${selected.dueCount}）`}
              </button>
              <button
                type="button"
                className="button"
                data-testid="review-preview-new-card"
                onClick={openNewCard}
              >
                新建卡片
              </button>
              <button
                type="button"
                className="button"
                data-testid="review-edit-topic"
                onClick={() => {
                  setTopicEditTitle(selected.title)
                  setTopicEditOpen(true)
                }}
              >
                编辑
              </button>
              <button
                type="button"
                className={`chip${onlyDue ? ' chip--active' : ''}`}
                data-testid="review-only-due"
                data-active={onlyDue ? '1' : '0'}
                onClick={() => setOnlyDue((value) => !value)}
              >
                只看到期的
              </button>
            </div>
          </section>
        </div>
      )}
    </>
  )

  // ---------------------------------------------------------------------
  // 下区主体：会话 / 提示 / 树
  // ---------------------------------------------------------------------
  const sessionView = (
    <div className="review" data-testid="review-session">
      <div className="review__card" data-testid="review-card" data-card-id={current?.id ?? ''}>
        <div className="review__meta">
          <span data-testid="review-source">{current?.source}</span>
          <span>· 已复习 {current?.reviewCount} 次</span>
          <span>
            · 上次{' '}
            {current?.lastReviewedAt ? String(current.lastReviewedAt).slice(0, 10) : '从未'}
          </span>
        </div>

        <p className="review__front" data-testid="review-front">
          {current?.front}
        </p>

        {revealed ? (
          <div className="review__answer" data-testid="review-answer">
            <p className="review__back">{current?.back || '（这张卡没有写背面）'}</p>
            <div className="review__grades" data-testid="review-grades">
              {(Object.keys(GRADE_LABELS) as ReviewGrade[]).map((value, index) => (
                <button
                  key={value}
                  type="button"
                  className={`grade grade--${value}`}
                  data-testid={`review-grade-${value}`}
                  onClick={() => void grade(value)}
                >
                  <span className="grade__label">{GRADE_LABELS[value]}</span>
                  <span className="grade__hint">
                    {intervalHintDays(value, current?.stage ?? 0, intensityResolved)} 天
                  </span>
                  <span className="grade__key">{index + 1}</span>
                </button>
              ))}
            </div>
          </div>
        ) : (
          <button
            type="button"
            className="button button--primary"
            data-testid="review-reveal"
            onClick={() => setRevealed(true)}
          >
            显示答案（空格）
          </button>
        )}
      </div>

      <p className="review__progress" data-testid="review-remaining">
        本轮还剩 {queue.length} 张 · 按 Esc 可随时退出，进度会保留
      </p>
    </div>
  )

  const main: React.JSX.Element = sessionActive ? (
    current === null ? (
      <EmptyState
        message="这一轮复习完了。"
        hint={`本次复习 ${handled} 张。剩下的到期卡明天再继续。`}
        testId="review-done"
      />
    ) : (
      sessionView
    )
  ) : selected === null ? (
    <EmptyState
      message={
        due.length === 0
          ? '今天没有到期的卡片。'
          : `今天到期 ${due.length} 张，左侧选一个主题开始。`
      }
      hint="也可以点上面的「汇总复习」，按到期顺序一张张过。"
      testId={due.length === 0 ? 'review-empty' : 'review-idle'}
    />
  ) : !entered ? (
    <section className="panel panel--hint" data-testid="review-tree-locked">
      <p className="panel__hint">
        点上面「开始复习这个主题」，下方就会展开这个主题的资料 → 章节 → 卡片。
        （圆点＝到期状态：🔴 今天到期 · 🟠 快到期 · 🟢 今天不用；点卡片就地展开背卡）
      </p>
    </section>
  ) : (
    <section
      className="panel review-tree-panel"
      data-testid="review-card-tree"
      data-topic-key={selected.key}
      data-only-due={onlyDue ? '1' : '0'}
      data-rows={treeRows.length}
    >
      <header className="panel__head">
        <h3 className="panel__title">
          资料与章节（{selected.cardCount} 张卡片 · 今天到期 {selected.dueCount} 张）
        </h3>
        <span className="panel__note">
          圆点＝到期状态 · 点卡片就地背卡 · {historyRetentionText()}
        </span>
      </header>
      {treeRows.length === 0 ? (
        <p className="panel__hint" data-testid="review-tree-empty">
          {onlyDue
            ? '这个主题今天没有到期的卡片。点「只看到期的」可看全部。'
            : '这个主题还没有卡片。点上面的「新建卡片」写一张。'}
        </p>
      ) : (
        <ReviewTree
          rows={treeRows}
          collapsed={collapsedNodes}
          onToggleCollapse={(nodeId) =>
            setCollapsedNodes((currentList) =>
              currentList.includes(nodeId)
                ? currentList.filter((id) => id !== nodeId)
                : [...currentList, nodeId]
            )
          }
          expandedCardId={inlineCardId}
          revealed={inlineRevealed}
          intensity={intensityResolved}
          onToggleCard={toggleInlineCard}
          onReveal={() => setInlineRevealed(true)}
          onGrade={(card, value) => void gradeInline(card.id, value)}
          onContextMenu={(card, event) =>
            menu.openFromEvent(event, cardItems(card), `card-row:${card.id}`)
          }
          cardMenu={(card) => (
            <MenuButton
              menu={menu}
              items={() => cardItems(card)}
              testId="card-menu"
              className="row-menu-button"
            />
          )}
        />
      )}
    </section>
  )

  return (
    <PageShell
      title="复习"
      /*
        内容区吃满剩余高度 + **下区跟随整页滚**（2026-10 修订 · `MASTER.md` §7.2 / 决定 7）：
        与学习页同一套（三处必须长得一样，决定 1 / 7）。
      */
      fill
      scroll
      description={
        selected === null
          ? `${summaries.length} 个主题 · 今天到期 ${due.length} 张`
          : `${summaries.length} 个主题 · 当前：${selected.title}${entered ? ' · 已进入' : ''}`
      }
      primaryAction={
        due.length > 0
          ? { label: `开始今日复习（${due.length}）`, testId: 'review-start', onClick: startSession }
          : undefined
      }
      toolbar={
        <>
          {/* BUG-004：复习卡也能手写一张（与预览区那个按钮同一个动作） */}
          <button type="button" className="button" data-testid="review-new-card" onClick={openNewCard}>
            新建卡片
          </button>
          <span className="toolbar__spacer" />
        </>
      }
    >
      {error ? <p className="notice notice--error">读取失败：{error}</p> : null}
      {flash ? (
        <p className="notice notice--ok" data-testid="review-flash">
          {flash}
        </p>
      ) : null}
      {historyNotice !== null ? (
        <p className="notice notice--ok" data-testid="review-history-notice">
          {historyNotice}
        </p>
      ) : null}

      {/*
        左栏中段：复习的主题列表（§6.2）。
        主题 = 学习主题 + 读书的书；每项右侧显示**它自己的**到期数，已清显示「—」。
        列表用 portal 塞进侧栏，数据、选中状态、点击行为**都留在这一页**。
      */}
      <SidebarListPortal>
        <div
          className="sidebar-list"
          data-testid="review-topics"
          // 验收读数：可见几行、隐藏了几个（隐藏只影响这一栏，见 `data-total`）
          data-visible-count={visibleTopicList.length}
          data-hidden-count={hiddenTotal}
          data-show-hidden={showHiddenTopics ? '1' : '0'}
        >
          <div className="sidebar-list__head">
            <span>主题</span>
            <span className="sidebar-list__head-actions">
              {/*
                「显示已隐藏(N)」：隐藏之后**必须能恢复**——
                没有这个开关，误点一下就再也找不回那一行了（而数据其实还在）。
                N 为 0 时不显示这个开关（没隐藏就没必要占一行）。
              */}
              {hiddenTotal > 0 ? (
                <button
                  type="button"
                  className="link"
                  data-testid="review-topics-show-hidden"
                  data-shown={showHiddenTopics ? '1' : '0'}
                  title="隐藏只影响这一栏的显示，今天到期的总数不变"
                  onClick={() => setShowHiddenTopics((current) => !current)}
                >
                  {showHiddenTopics ? `收起已隐藏(${hiddenTotal})` : `显示已隐藏(${hiddenTotal})`}
                </button>
              ) : null}
              <span data-testid="review-topics-count">{summaries.length}</span>
            </span>
          </div>
          {summaries.length === 0 ? (
            <p className="sidebar-list__empty" data-testid="review-topics-empty">
              还没有主题。先去「学习」建一个主题，或在「读书」里加一本书。
            </p>
          ) : visibleTopicList.length === 0 && !showHiddenTopics ? (
            <p className="sidebar-list__empty" data-testid="review-topics-all-hidden">
              全部主题都已隐藏。点上面的「显示已隐藏」可以把它们找回来——今天的到期总数没变。
            </p>
          ) : (
            <ul className="topic-list">
              {visibleTopicList.map((summary) => (
                <TopicRow
                  key={summary.key}
                  summary={summary}
                  active={selectedKey === summary.key}
                  hidden={false}
                  menu={menu}
                  items={() => topicItems(summary)}
                  onToggleHidden={() => void toggleTopicHidden(summary)}
                  onSelect={() => {
                    setSelectedKey(summary.key)
                    // 换主题 = 回到"未进入"那一步（同一个主题再点一次不动）
                    setEnteredKey((currentKey) => (currentKey === summary.key ? currentKey : null))
                    setInlineCardId(null)
                    setInlineRevealed(false)
                  }}
                />
              ))}
              {/* 打开「显示已隐藏」后，隐藏行**灰显**回来（数据一直都在，只是没显示） */}
              {showHiddenTopics
                ? hiddenTopicList.map((summary) => (
                    <TopicRow
                      key={summary.key}
                      summary={summary}
                      active={selectedKey === summary.key}
                      hidden
                      menu={menu}
                      items={() => topicItems(summary)}
                      onToggleHidden={() => void toggleTopicHidden(summary)}
                      onSelect={() => {
                        setSelectedKey(summary.key)
                        setEnteredKey((currentKey) =>
                          currentKey === summary.key ? currentKey : null
                        )
                        setInlineCardId(null)
                        setInlineRevealed(false)
                      }}
                    />
                  ))
                : null}
            </ul>
          )}
        </div>
      </SidebarListPortal>

      {/* 三段骨架：上预览（含汇总横条）/ 中两块 / 下树（§7.6；预览与卡片不整页替换） */}
      <ModuleBands testId="review-bands" cards={[dueCard, historyCard]} preview={preview}>
        {loading ? <EmptyState message="正在读取…" /> : main}
      </ModuleBands>

      {/* 手写新建 / 编辑复习卡（BUG-004 / 第 03 块右键菜单里的"编辑"） */}
      <FormDrawer
        open={cardOpen}
        title={editCard === null ? '新建复习卡' : '编辑复习卡'}
        fields={[
          {
            kind: 'text',
            key: 'front',
            label: '正面（问题）',
            placeholder: '要考自己什么…',
            required: true,
            testId: 'review-form-front'
          },
          {
            kind: 'text',
            key: 'back',
            label: '背面（答案）',
            placeholder: '可留空，复习时再补',
            multiline: true,
            testId: 'review-form-back'
          },
          {
            kind: 'date',
            key: 'dueDate',
            label: '复习时间',
            testId: 'review-form-due',
            hint: '留空表示今天就要复习'
          },
          {
            // FEAT-007：复习时间可以定到几点（可选）。同一天到期的卡按时间先后复习。
            kind: 'time',
            key: 'dueTime',
            label: '几点复习（可选）',
            testId: 'review-form-due-time',
            hint: '只影响同一天到期的先后顺序，不改变"今天到期"的判断'
          },
          ...(topicTitles.length > 0
            ? [
                {
                  kind: 'select' as const,
                  key: 'source',
                  label: '关联学习项',
                  testId: 'review-form-source',
                  options: [
                    { value: '', label: '不关联' },
                    ...topicTitles.map((title) => ({ value: title, label: title }))
                  ]
                }
              ]
            : [])
        ]}
        initialValues={cardInitial}
        onClose={() => {
          setCardOpen(false)
          setEditCard(null)
        }}
        onSubmit={onSubmitCard}
        testId="review-form"
      />

      {/* 编辑主题（只改名字；学习主题改主题名、书改书名、来源档改这批卡的来源） */}
      <FormDrawer
        open={topicEditOpen}
        title="编辑主题名字"
        fields={[
          {
            kind: 'text',
            key: 'title',
            label: '名字',
            required: true,
            testId: 'review-edit-title'
          }
        ]}
        initialValues={{ title: topicEditTitle }}
        onClose={() => setTopicEditOpen(false)}
        onSubmit={async (values) => {
          await onSaveTopicTitle(values)
          setTopicEditOpen(false)
        }}
        testId="review-edit-form"
      />

      {/*
        删除来源档（修改 3 轮）：**二次确认**，文案写清三件事——
        哪个档、会删几张卡、能恢复（与学习页/读书页删节点同一个组件、同一个规矩）。
      */}
      <ConfirmDialog
        open={pendingTopicDelete !== null}
        title="删除这个来源档？"
        message={
          <p data-testid="review-topic-delete-summary">
            {`将删除「${pendingTopicDelete?.title ?? ''}」下的 ${
              pendingTopicDelete?.cardIds.length ?? 0
            } 张卡片。删除后可在「数据与设置 → 回收站」里恢复。`}
          </p>
        }
        confirmLabel="删除"
        danger
        onConfirm={() => {
          const target = pendingTopicDelete
          if (target !== null) void removeSourceTopic(target)
        }}
        onCancel={() => setPendingTopicDelete(null)}
        testId="review-topic-delete-dialog"
      />

      {/* 全页只放一个菜单实例：树里每行的 `⋯` 与右键都往它里面塞同一批菜单项 */}
      <ContextMenu state={menu.state} onClose={menu.close} />
    </PageShell>
  )
}

/**
 * 左栏的一个主题行（右侧那个数是**它自己的**到期数，已清显示「—」）。
 *
 * 2026-10 修订（修改 2 轮）：这一行以前是**纯展示 + 点击选中**，一个操作入口都没有
 * ——用户于是说「复习无法删除主题」。现在每行都有 `⋯` 与右键（与中区卡片行、
 * 树行同一套 `MenuButton` / `useContextMenu`）。
 *
 * 菜单项分两种（修改 3 轮）：
 *   - **隐藏这个主题 / 取消隐藏**（所有档都有，**只影响这一栏的显示**，不删任何数据）
 *   - **删除这个来源档**（只有 `source:` 档有；连带它下面的卡片一起进回收站）
 * `topic:<id>` / `book:<id>` 档是真实实体，删它等于去学习页 / 读书页删东西，
 * 所以**不出现删除项**（用户已确认）。
 *
 * `hidden` 的行以灰显出现（只在「显示已隐藏」打开时），行尾还能直接点「取消隐藏」。
 */
function TopicRow({
  summary,
  active,
  hidden,
  menu,
  items,
  onSelect,
  onToggleHidden
}: {
  summary: ReviewTopicSummary
  active: boolean
  hidden: boolean
  menu: UseContextMenuResult
  items: () => MenuItemSpec[]
  onSelect: () => void
  onToggleHidden: () => void
}): React.JSX.Element {
  return (
    <li
      className={`review-topic-row${hidden ? ' review-topic-row--hidden' : ''}`}
      data-testid="review-topic-row"
      data-topic-key={summary.key}
      data-hidden={hidden ? '1' : '0'}
      // 右键也能出菜单（与行尾 `⋯` 取同一份定义）
      onContextMenu={(event) => menu.openFromEvent(event, items(), `review-topic:${summary.key}`)}
    >
      <button
        type="button"
        className={`review-topic${active ? ' review-topic--active' : ''}${
          hidden ? ' review-topic--hidden' : ''
        }`}
        data-testid="review-topic"
        data-topic-key={summary.key}
        data-topic-kind={summary.kind}
        data-due={summary.dueCount}
        data-cards={summary.cardCount}
        data-active={active ? '1' : '0'}
        data-hidden={hidden ? '1' : '0'}
        title={hidden ? `${summary.title}（已隐藏：数据没动，随时能取消）` : summary.title}
        onClick={onSelect}
      >
        <span className="review-topic__head">
          <span className="review-topic__title">{summary.title}</span>
          <span
            className={`due-badge${summary.dueCount === 0 ? ' due-badge--zero' : ''}`}
            data-testid="review-topic-due"
          >
            {topicDueBadgeText(summary.dueCount)}
          </span>
        </span>
        <span className="review-topic__meta" data-testid="review-topic-meta">
          {topicListMetaText(summary)}
        </span>
      </button>
      {hidden ? (
        <button
          type="button"
          className="link review-topic__unhide"
          data-testid="review-topic-unhide"
          title="取消隐藏（回到左栏列表）"
          onClick={(event) => {
            event.stopPropagation()
            onToggleHidden()
          }}
        >
          取消隐藏
        </button>
      ) : null}
      <MenuButton
        menu={menu}
        items={items}
        testId="review-topic-menu"
        label="这个主题的更多操作"
        className="row-menu-button"
      />
    </li>
  )
}

/** 供测试：把键盘按键映射到评分档位 */
export function gradeFromKey(key: string): ReviewGrade | null {
  return GRADE_KEYS[key] ?? null
}

/** 供测试：积压阈值 */
export const REVIEW_BACKLOG_THRESHOLD = BACKLOG_THRESHOLD
