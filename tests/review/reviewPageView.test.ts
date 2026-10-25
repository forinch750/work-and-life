/**
 * 第 10 块测试：复习页的视图计算（`MASTER.md` §7.6 + §14 决定 17–21）
 *
 * 这里钉四条（`docs\TASKS\10` §7.2 要求的四行）：
 *
 * 1. **各主题到期数相加 = 汇总横条的总数** —— 防漏的核心不变量
 * 2. **导航角标 = 汇总横条的总数** —— 两个出口必须是同一个数
 * 3. **到期状态圆点的三态判定** —— 今天到期 / 快到期 / 今天不用
 * 4. **间隔算法没有被改动** —— 本块只换入口，1/3/7→14→30→60→120 × 强度系数照旧
 *
 * 外加：已掌握%、预览两行、最近复习记录、树行组装（资料 → 章节 → 卡片）。
 *
 * vitest 是 `environment: 'node'`（没有 jsdom），所以这里一律测纯函数；
 * 组件行为交给端到端验收（`src\main\verify\phase8.ts` 的 P8-U*）。
 */
import { describe, expect, it } from 'vitest'
import {
  CARD_STATE_LABELS,
  MASTERED_STAGE,
  SOON_DAYS,
  buildReviewTopics,
  cardDueState,
  cardTopicKey,
  dueCardsOf,
  dueStateCounts,
  dueTotalOf,
  hiddenCount,
  hiddenTopics,
  isTopicDeletable,
  isTopicHidden,
  masteredPercent,
  materialLabel,
  recentReviewRows,
  reviewDistributionBuckets,
  reviewTopicKey,
  reviewTopicSources,
  reviewTreeRows,
  topicDeleteCardIds,
  topicDueBadgeText,
  topicListMetaText,
  topicPreviewTexts,
  visibleTopics,
  type ReviewTreeNode,
  type ReviewTopicRef
} from '../../src/shared/reviewPageView'
import { computeBadges } from '../../src/shared/badges'
import { addDaysToKey } from '../../src/shared/date'
import {
  applyGrade,
  dueQueue,
  normalizeReviewCard,
  type ReviewCard,
  type ReviewGrade,
  type ReviewHistory
} from '../../src/shared/review'
import type { ReviewIntensity } from '../../src/shared/preferences'

const TODAY = '2026-10-10'
const YESTERDAY = addDaysToKey(TODAY, -1)
const SOON = addDaysToKey(TODAY, 2)
const FAR = addDaysToKey(TODAY, 30)

let seq = 0
function card(overrides: Partial<ReviewCard> = {}): ReviewCard {
  seq += 1
  return {
    id: overrides.id ?? `c${seq}`,
    createdAt: overrides.createdAt ?? `2026-01-01T00:00:0${seq % 10}.000Z`,
    updatedAt: '2026-01-01T00:00:00.000Z',
    front: overrides.front ?? `问题 ${seq}`,
    back: overrides.back ?? '答案',
    source: overrides.source ?? '而对方',
    stage: overrides.stage ?? 0,
    dueDate: overrides.dueDate === undefined ? TODAY : overrides.dueDate,
    reviewCount: overrides.reviewCount ?? 0,
    lastReviewedAt: overrides.lastReviewedAt ?? null,
    ...(overrides.dueTime !== undefined ? { dueTime: overrides.dueTime } : {}),
    ...(overrides.topicId !== undefined ? { topicId: overrides.topicId } : {}),
    ...(overrides.nodeId !== undefined ? { nodeId: overrides.nodeId } : {}),
    ...(overrides.bookId !== undefined ? { bookId: overrides.bookId } : {})
  }
}

const SOURCES: ReviewTopicRef[] = reviewTopicSources(
  [
    { id: 'topic-a', title: '而对方' },
    { id: 'topic-b', title: '热力学' }
  ],
  [{ id: 'book-1', title: '语法俱乐部' }]
)

// ---------------------------------------------------------------------------
// ① 到期数聚合：各主题自己的到期数相加 = 汇总总数（防漏的核心不变量）
// ---------------------------------------------------------------------------

describe('各主题到期数之和 = 汇总横条的总数（防漏的核心不变量）', () => {
  it('学习主题 / 读书的书 / 只剩来源名的卡片，三档都算进去，一张都不许丢', () => {
    const cards = [
      card({ source: '而对方', dueDate: TODAY }),
      card({ source: '而对方', dueDate: YESTERDAY }), // 逾期也算今天到期
      card({ topicId: 'topic-b', source: '热力学', dueDate: TODAY }),
      card({ bookId: 'book-1', source: '语法俱乐部', dueDate: TODAY }),
      card({ source: '手写卡', dueDate: TODAY }), // 对不上任何主题 → 自己成一档
      card({ source: '而对方', dueDate: FAR }) // 没到期
    ]
    const summaries = buildReviewTopics(cards, SOURCES, TODAY)

    // 不变量：各主题到期数相加 === 到期队列长度
    expect(dueTotalOf(summaries)).toBe(dueQueue(cards, TODAY).length)
    expect(dueTotalOf(summaries)).toBe(5)
    // 每一张卡都恰好落在一个主题里（总数对得上 = 没有重复计，也没有漏掉）
    expect(summaries.reduce((sum, item) => sum + item.cardCount, 0)).toBe(cards.length)
  })

  it('一张卡都没有的主题也在（到期数显示「—」），不能因为它空就从左栏消失', () => {
    const summaries = buildReviewTopics([card({ source: '手写卡' })], SOURCES, TODAY)
    const titles = summaries.map((item) => item.title)
    expect(titles).toContain('而对方')
    expect(titles).toContain('热力学')
    expect(titles).toContain('语法俱乐部')
    const empty = summaries.filter((item) => item.cardCount === 0)
    expect(empty.length).toBe(3)
    for (const item of empty) expect(topicDueBadgeText(item.dueCount)).toBe('—')
  })

  it('有卡片但今天没到期的主题：到期数是 0，显示「—」', () => {
    const summaries = buildReviewTopics(
      [card({ source: '语法俱乐部', bookId: 'book-1', dueDate: FAR })],
      SOURCES,
      TODAY
    )
    const book = summaries.find((item) => item.key === reviewTopicKey('book', 'book-1'))
    expect(book?.cardCount).toBe(1)
    expect(book?.dueCount).toBe(0)
    expect(topicDueBadgeText(book?.dueCount ?? -1)).toBe('—')
  })

  it('随机一组卡：不变量恒成立（重复来源、无来源、跨主题混排）', () => {
    const cards = [
      card({ source: '而对方', dueDate: TODAY }),
      card({ source: '而对方', dueDate: TODAY }),
      card({ source: '而对方', dueDate: YESTERDAY }),
      card({ source: '热力学', topicId: 'topic-b', dueDate: TODAY }),
      card({ source: '热力学', dueDate: null }),
      card({ source: '语法俱乐部', bookId: 'book-1', dueDate: TODAY }),
      card({ source: '无主来源', dueDate: TODAY }),
      card({ source: '无主来源', dueDate: FAR }),
      card({ source: '无主来源', dueDate: FAR })
    ]
    const summaries = buildReviewTopics(cards, SOURCES, TODAY)
    expect(dueTotalOf(summaries)).toBe(dueQueue(cards, TODAY).length)
    expect(summaries.reduce((sum, item) => sum + item.cardCount, 0)).toBe(cards.length)
  })
})

// ---------------------------------------------------------------------------
// ② 导航角标 = 汇总横条的总数
// ---------------------------------------------------------------------------

describe('导航「复习」角标与汇总横条是同一个数', () => {
  it('角标（computeBadges）=== 各主题到期数之和', () => {
    const raw: Array<Record<string, unknown>> = [
      { id: 'r1', front: '甲', source: '而对方', stage: 0, dueDate: TODAY, reviewCount: 0 },
      { id: 'r2', front: '乙', source: '热力学', topicId: 'topic-b', stage: 1, dueDate: YESTERDAY, reviewCount: 0 },
      { id: 'r3', front: '丙', source: '语法俱乐部', bookId: 'book-1', stage: 0, dueDate: TODAY, reviewCount: 0 },
      { id: 'r4', front: '丁', source: '手写卡', stage: 0, dueDate: TODAY, reviewCount: 0 },
      { id: 'r5', front: '戊', source: '而对方', stage: 3, dueDate: FAR, reviewCount: 0 },
      // 历史记录混在里面：既不是卡片，也不该被算成"到期"
      { id: 'h1', kind: 'history', cardId: 'r1', at: '2026-10-01T00:00:00.000Z', grade: 'fuzzy', stageBefore: 0, stageAfter: 0, dueDateAfter: TODAY }
    ]
    const cards = raw
      .map((record) => normalizeReviewCard(record))
      .filter((item): item is ReviewCard => item !== null && item.front !== '')
    const summaries = buildReviewTopics(cards, SOURCES, TODAY)

    const badge = computeBadges([], raw, TODAY)
    expect(badge.reviewDue).toBe(dueTotalOf(summaries))
    expect(badge.reviewDue).toBe(4)
  })

  it('角标只看今天到期：都清了就是 0（导航不显示角标）', () => {
    const raw = [{ id: 'r1', front: '甲', source: '而对方', stage: 2, dueDate: FAR, reviewCount: 1 }]
    const cards = raw
      .map((record) => normalizeReviewCard(record))
      .filter((item): item is ReviewCard => item !== null)
    expect(dueTotalOf(buildReviewTopics(cards, SOURCES, TODAY))).toBe(0)
    expect(computeBadges([], raw, TODAY).reviewDue).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// ③ 卡片行的三态圆点
// ---------------------------------------------------------------------------

describe('到期状态圆点：今天到期 / 快到期 / 今天不用', () => {
  it('今天、昨天、从没定过时间 → 今天到期', () => {
    expect(cardDueState(card({ dueDate: TODAY }), TODAY)).toBe('due')
    expect(cardDueState(card({ dueDate: YESTERDAY }), TODAY)).toBe('due')
    expect(cardDueState(card({ dueDate: null }), TODAY)).toBe('due')
  })

  it(`今天之后 ${SOON_DAYS} 天以内 → 快到期（第 ${SOON_DAYS + 1} 天起就"今天不用"）`, () => {
    for (let offset = 1; offset <= SOON_DAYS; offset += 1) {
      expect(cardDueState(card({ dueDate: addDaysToKey(TODAY, offset) }), TODAY)).toBe('soon')
    }
    expect(cardDueState(card({ dueDate: addDaysToKey(TODAY, SOON_DAYS + 1) }), TODAY)).toBe('later')
    expect(cardDueState(card({ dueDate: FAR }), TODAY)).toBe('later')
  })

  it('三态各有中文标签，且统计口径与逐个判定一致', () => {
    const cards = [
      card({ dueDate: TODAY }),
      card({ dueDate: YESTERDAY }),
      card({ dueDate: SOON }),
      card({ dueDate: FAR })
    ]
    const counts = dueStateCounts(cards, TODAY)
    expect(counts).toEqual({ due: 2, soon: 1, later: 1 })
    expect(counts.due + counts.soon + counts.later).toBe(cards.length)
    expect(CARD_STATE_LABELS.due).toBe('今天到期')
    expect(CARD_STATE_LABELS.soon).toBe('快到期')
    expect(CARD_STATE_LABELS.later).toBe('今天不用')
  })
})

// ---------------------------------------------------------------------------
// ④ 间隔算法回归：本块**没有改动**算法
// ---------------------------------------------------------------------------

describe('间隔算法照旧（本块只换入口，没动算法）', () => {
  const intensities: ReviewIntensity[] = ['relaxed', 'standard', 'intense']

  it('忘了 1 天 / 有点模糊 3 天（标准强度），按强度系数整体缩放', () => {
    expect(applyGrade({ stage: 0, reviewCount: 0 }, 'forgot', TODAY, 'standard').intervalDays).toBe(1)
    expect(applyGrade({ stage: 0, reviewCount: 0 }, 'fuzzy', TODAY, 'standard').intervalDays).toBe(3)
    // 宽松 ×1.5 → 1.5 → 四舍五入 2；密集 ×0.6 → 0.6 → 1（不小于 1 天）
    expect(applyGrade({ stage: 3, reviewCount: 0 }, 'forgot', TODAY, 'relaxed').intervalDays).toBe(2)
    expect(applyGrade({ stage: 3, reviewCount: 0 }, 'forgot', TODAY, 'intense').intervalDays).toBe(1)
    expect(applyGrade({ stage: 3, reviewCount: 0 }, 'fuzzy', TODAY, 'relaxed').intervalDays).toBe(5)
    expect(applyGrade({ stage: 3, reviewCount: 0 }, 'fuzzy', TODAY, 'intense').intervalDays).toBe(2)
  })

  it('记住了按阶梯放大：14 → 30 → 60 → 120（之后停在 120）', () => {
    // 注意口径：`applyGrade` 取的是**推进后**阶段上的阶梯值，
    // 所以新卡（阶段 0）第一次"记住了"是阶梯第 1 项 = 14 天。
    // 这是 06 块就有的实现，本块**没有改**（决定：间隔算法照旧，只换入口）。
    const ladder = [14, 30, 60, 120, 120]
    ladder.forEach((expected, index) => {
      const outcome = applyGrade({ stage: index, reviewCount: 0 }, 'remembered', TODAY, 'standard')
      expect(outcome.intervalDays).toBe(expected)
      expect(outcome.stageAfter).toBe(Math.min(4, index + 1))
    })
  })

  it('强度系数整体缩放（宽松 ×1.5 / 标准 ×1 / 密集 ×0.6）', () => {
    const table: Record<ReviewIntensity, number[]> = {
      relaxed: [21, 45, 90, 180, 180],
      standard: [14, 30, 60, 120, 120],
      intense: [8, 18, 36, 72, 72]
    }
    for (const intensity of intensities) {
      for (const stage of [0, 1, 2, 3, 4]) {
        const outcome = applyGrade({ stage, reviewCount: 0 }, 'remembered', TODAY, intensity)
        expect(outcome.intervalDays).toBe(table[intensity]?.[stage])
      }
    }
  })

  it('阶段推进：忘了回到 0、模糊停在原地、记住了 +1（封顶 4）', () => {
    const base: Array<{ grade: ReviewGrade; from: number; after: number }> = [
      { grade: 'forgot', from: 0, after: 0 },
      { grade: 'forgot', from: 3, after: 0 },
      { grade: 'fuzzy', from: 0, after: 0 },
      { grade: 'fuzzy', from: 2, after: 2 },
      { grade: 'remembered', from: 0, after: 1 },
      { grade: 'remembered', from: 4, after: 4 }
    ]
    for (const row of base) {
      expect(applyGrade({ stage: row.from, reviewCount: 5 }, row.grade, TODAY, 'standard').stageAfter).toBe(
        row.after
      )
    }
  })

  it('下次到期日 = 今天 + 间隔天数（同一个日期工具）', () => {
    const outcome = applyGrade({ stage: 2, reviewCount: 0 }, 'remembered', TODAY, 'standard')
    expect(outcome.dueDate).toBe(addDaysToKey(TODAY, outcome.intervalDays))
  })
})

// ---------------------------------------------------------------------------
// 已掌握 % / 预览两行 / 左栏副标题
// ---------------------------------------------------------------------------

describe('已掌握 % 与预览区那几行', () => {
  it('已掌握 = Σ min(阶段, 4) / (张数 × 4)：新卡 0%、背到顶 100%', () => {
    expect(masteredPercent([])).toBe(0)
    expect(masteredPercent([card({ stage: 0 }), card({ stage: 0 })])).toBe(0)
    expect(masteredPercent([card({ stage: MASTERED_STAGE }), card({ stage: MASTERED_STAGE })])).toBe(100)
    expect(masteredPercent([card({ stage: 0 }), card({ stage: 4 })])).toBe(50)
    expect(masteredPercent([card({ stage: 1 }), card({ stage: 0 }), card({ stage: 0 }), card({ stage: 0 })])).toBe(6)
  })

  it('上次复习取这组卡里最晚的一次；从没复习过是「从未」', () => {
    const summaries = buildReviewTopics(
      [
        card({ source: '而对方', lastReviewedAt: '2026-10-08T09:00:00.000Z' }),
        card({ source: '而对方', lastReviewedAt: '2026-10-09T09:00:00.000Z' })
      ],
      SOURCES,
      TODAY
    )
    const topic = summaries.find((item) => item.key === reviewTopicKey('learning', 'topic-a'))
    expect(topic?.lastReviewedAt).toBe('2026-10-09')
    expect(topicPreviewTexts(topic!).lastReviewed).toBe('2026-10-09')

    const empty = summaries.find((item) => item.key === reviewTopicKey('learning', 'topic-b'))
    expect(topicPreviewTexts(empty!).lastReviewed).toBe('从未')
  })

  it('下次到期：有到期卡写「今天（N 张）」，否则写最近的那一天，没卡写「—」', () => {
    const withDue = buildReviewTopics(
      [card({ source: '而对方', dueDate: TODAY }), card({ source: '而对方', dueDate: FAR })],
      SOURCES,
      TODAY
    ).find((item) => item.key === reviewTopicKey('learning', 'topic-a'))
    expect(topicPreviewTexts(withDue!).nextDue).toBe('今天（1 张）')

    const noDue = buildReviewTopics(
      [card({ source: '而对方', dueDate: FAR })],
      SOURCES,
      TODAY
    ).find((item) => item.key === reviewTopicKey('learning', 'topic-a'))
    expect(topicPreviewTexts(noDue!).nextDue).toBe(FAR)

    const noCards = buildReviewTopics([], SOURCES, TODAY).find(
      (item) => item.key === reviewTopicKey('learning', 'topic-a')
    )
    expect(topicPreviewTexts(noCards!).nextDue).toBe('—')
  })

  it('左栏副标题：`12 张 · 已掌握 58%`', () => {
    const summaries = buildReviewTopics(
      [card({ source: '而对方', stage: 4 }), card({ source: '而对方', stage: 0 })],
      SOURCES,
      TODAY
    )
    const topic = summaries.find((item) => item.key === reviewTopicKey('learning', 'topic-a'))
    expect(topicListMetaText(topic!)).toBe('2 张 · 已掌握 50%')
  })
})

// ---------------------------------------------------------------------------
// 主题归属（决定 17）：卡片怎么归到"学习主题 + 读书的书"
// ---------------------------------------------------------------------------

describe('卡片归到哪个主题', () => {
  it('topicId / bookId 优先；对不上时按来源名归位；都对不上自成来源档', () => {
    expect(cardTopicKey(card({ topicId: 'topic-b', source: '随便写' }), SOURCES)).toBe(
      reviewTopicKey('learning', 'topic-b')
    )
    expect(cardTopicKey(card({ bookId: 'book-1' }), SOURCES)).toBe(reviewTopicKey('book', 'book-1'))
    // 老卡片没有 topicId，只有来源名
    expect(cardTopicKey(card({ source: '而对方' }), SOURCES)).toBe(reviewTopicKey('learning', 'topic-a'))
    expect(cardTopicKey(card({ source: '语法俱乐部' }), SOURCES)).toBe(reviewTopicKey('book', 'book-1'))
    // 都对不上 → 来源档（不许丢）
    expect(cardTopicKey(card({ source: '手写卡' }), SOURCES)).toBe(reviewTopicKey('source', '手写卡'))
    expect(cardTopicKey(card({ source: '' }), SOURCES)).toBe(reviewTopicKey('source', '未标注来源'))
  })

  it('topicId 指向一个已经删掉的主题时退回来源档，不丢卡', () => {
    const key = cardTopicKey(card({ topicId: 'topic-gone', source: '热力学' }), SOURCES)
    expect(key).toBe(reviewTopicKey('learning', 'topic-b'))
  })
})

// ---------------------------------------------------------------------------
// 中区两块：今天到期的卡片 / 最近的复习记录
// ---------------------------------------------------------------------------

describe('今天到期的卡片（中区第一块）', () => {
  it('只列今天到期的，且按到期顺序（逾期越久越靠前）', () => {
    const cards = [
      card({ source: '而对方', dueDate: TODAY, front: '今天' }),
      card({ source: '而对方', dueDate: addDaysToKey(TODAY, -5), front: '拖了五天' }),
      card({ source: '而对方', dueDate: FAR, front: '还早' })
    ]
    const topic = buildReviewTopics(cards, SOURCES, TODAY).find(
      (item) => item.key === reviewTopicKey('learning', 'topic-a')
    )
    const due = dueCardsOf(topic!, TODAY)
    expect(due.map((item) => item.front)).toEqual(['拖了五天', '今天'])
    expect(due.length).toBe(dueQueue(cards, TODAY).length)
  })
})

describe('最近的复习记录（中区第二块）', () => {
  function history(overrides: Partial<ReviewHistory> = {}): ReviewHistory {
    seq += 1
    return {
      id: overrides.id ?? `h${seq}`,
      createdAt: '2026-10-01T00:00:00.000Z',
      updatedAt: '2026-10-01T00:00:00.000Z',
      kind: 'history',
      cardId: overrides.cardId ?? 'c1',
      at: overrides.at ?? `2026-10-0${seq % 9}T09:00:00.000Z`,
      grade: overrides.grade ?? 'remembered',
      stageBefore: overrides.stageBefore ?? 1,
      stageAfter: overrides.stageAfter ?? 2,
      dueDateAfter: overrides.dueDateAfter ?? TODAY
    }
  }

  it('按时间倒序，一行给齐：日期 / 卡片 / 评分 → 下次间隔', () => {
    const cards = [card({ id: 'c1', front: '位与字节', back: '位是信息的最小单位' })]
    const rows = recentReviewRows(
      [
        history({ cardId: 'c1', at: '2026-10-01T09:00:00.000Z', grade: 'forgot', dueDateAfter: '2026-10-02' }),
        history({ cardId: 'c1', at: '2026-10-08T09:00:00.000Z', grade: 'remembered', dueDateAfter: '2026-11-07' })
      ],
      cards
    )
    expect(rows.length).toBe(2)
    expect(rows[0]?.atISO).toBe('2026-10-08T09:00:00.000Z')
    expect(rows[0]?.front).toBe('位与字节')
    expect(rows[0]?.back).toBe('位是信息的最小单位')
    expect(rows[0]?.gradeLabel).toBe('记住了')
    expect(rows[0]?.intervalDays).toBe(30)
    expect(rows[0]?.intervalText).toBe('30 天后')
    expect(rows[1]?.intervalDays).toBe(1)
    // 列表那一格是紧凑时间（`10-08 17:00`），完整时间另存在 atFullText 里当悬停提示
    expect(rows[0]?.atText).toMatch(/^\d{2}-\d{2} \d{2}:\d{2}$/)
    expect(rows[0]?.atFullText).toContain('2026年10月8日')
  })

  it('间隔与 applyGrade 给的是同一个数（记录不是另算一遍）', () => {
    const outcome = applyGrade({ stage: 1, reviewCount: 0 }, 'remembered', TODAY, 'standard')
    const rows = recentReviewRows(
      [
        history({
          cardId: 'c1',
          at: `${TODAY}T09:00:00.000Z`,
          grade: 'remembered',
          dueDateAfter: outcome.dueDate
        })
      ],
      [card({ id: 'c1' })]
    )
    expect(rows[0]?.intervalDays).toBe(outcome.intervalDays)
  })

  it('可以只看某些卡（选中主题）；卡片删了也照样显示这一条', () => {
    const cards = [card({ id: 'c1', front: '还在' })]
    const rows = recentReviewRows(
      [
        history({ cardId: 'c1', at: '2026-10-08T09:00:00.000Z' }),
        history({ cardId: 'c9', at: '2026-10-09T09:00:00.000Z' })
      ],
      cards,
      30,
      ['c1']
    )
    expect(rows.length).toBe(1)
    expect(rows[0]?.front).toBe('还在')

    const all = recentReviewRows(
      [
        history({ cardId: 'c1', at: '2026-10-08T09:00:00.000Z' }),
        history({ cardId: 'c9', at: '2026-10-09T09:00:00.000Z' })
      ],
      cards
    )
    expect(all[0]?.front).toBe('（这张卡已删除）')
  })

  it('超过上限只留最近的', () => {
    const items = Array.from({ length: 40 }, (_, index) =>
      history({ cardId: 'c1', at: `2026-09-${String((index % 9) + 1).padStart(2, '0')}T09:00:0${index % 10}.000Z` })
    )
    expect(recentReviewRows(items, [card({ id: 'c1' })], 5).length).toBe(5)
  })
})

// ---------------------------------------------------------------------------
// 下区：树 = 资料 → 章节 → 卡片
// ---------------------------------------------------------------------------

describe('树的组装（资料 → 章节 → 卡片）', () => {
  const nodes: ReviewTreeNode[] = [
    { id: 'm1', parentId: null, order: 0, title: '的的', group: '教材', resourceType: '书' },
    { id: 'ch1', parentId: 'm1', order: 0, title: '第一章' },
    { id: 'sec1', parentId: 'ch1', order: 0, title: '1.1' },
    { id: 'm2', parentId: null, order: 1, title: '发', group: '参考', resourceType: '书' }
  ]

  it('资料是根、章节按 order、卡片挂在 nodeId 上（深度逐层 +1）', () => {
    const cards = [
      card({ id: 'k1', front: '位与字节', nodeId: 'sec1', dueDate: TODAY }),
      card({ id: 'k2', front: '主存', nodeId: 'sec1', dueDate: FAR }),
      card({ id: 'k3', front: '引论', nodeId: 'ch1', dueDate: TODAY })
    ]
    const rows = reviewTreeRows(nodes, cards, TODAY)
    expect(rows.map((row) => `${row.kind}:${row.depth}:${row.title}`)).toEqual([
      'material:0:的的',
      'chapter:1:第一章',
      'chapter:2:1.1',
      'card:3:位与字节',
      'card:3:主存',
      'card:2:引论',
      'material:0:发'
    ])
    // 到期张数按子树汇总
    const material = rows[0]
    expect(material?.dueCount).toBe(2)
    expect(material?.cardCount).toBe(3)
    expect(rows.find((row) => row.id === 'm2')?.dueCount).toBe(0)
    // 卡片行带三态
    expect(rows.find((row) => row.id === 'k1')?.state).toBe('due')
    expect(rows.find((row) => row.id === 'k2')?.state).toBe('later')
  })

  it('挂不上节点的老卡片照样出现（放在零层），一张都不能丢', () => {
    const cards = [
      card({ id: 'k1', front: '挂了节点', nodeId: 'sec1' }),
      card({ id: 'k2', front: '没挂节点' })
    ]
    const rows = reviewTreeRows(nodes, cards, TODAY)
    const cardRows = rows.filter((row) => row.kind === 'card')
    expect(cardRows.map((row) => row.id).sort()).toEqual(['k1', 'k2'])
    const unfiled = cardRows.find((row) => row.id === 'k2')
    expect(unfiled?.depth).toBe(0)
  })

  it('没有资料时树上就只有卡片（读书/手写卡的情形）', () => {
    const rows = reviewTreeRows([], [card({ id: 'k1', front: '手写' })], TODAY)
    expect(rows.length).toBe(1)
    expect(rows[0]?.kind).toBe('card')
  })

  it('「只看到期的」：没到期的卡与整段空壳都收起来', () => {
    const cards = [
      card({ id: 'k1', front: '到期', nodeId: 'sec1', dueDate: TODAY }),
      card({ id: 'k2', front: '还早', nodeId: 'sec1', dueDate: FAR }),
      card({ id: 'k3', front: '没挂', dueDate: TODAY })
    ]
    const rows = reviewTreeRows(nodes, cards, TODAY, { onlyDue: true })
    const cardRows = rows.filter((row) => row.kind === 'card')
    expect(cardRows.map((row) => row.id)).toEqual(['k1', 'k3'])
    // 「发」下面一张到期卡都没有 → 整段不出现
    expect(rows.some((row) => row.id === 'm2')).toBe(false)
  })

  it('资料行的标签：分组 · 类型（两项相同只写一个）', () => {
    expect(materialLabel({ id: 'x', parentId: null, order: 0, title: 't', group: '教材', resourceType: '书' })).toBe(
      '教材 · 书'
    )
    expect(materialLabel({ id: 'x', parentId: null, order: 0, title: 't', resourceType: '书' })).toBe('书')
    expect(materialLabel({ id: 'x', parentId: null, order: 0, title: 't' })).toBe('')
  })
})

// ---------------------------------------------------------------------------
// ⑥ 左栏"隐藏这个主题"（修改 2 轮 · 2026-10）
//
// 用户原话：「复习无法删除主题。」决定：**只在复习页隐藏，不删任何源数据**。
//
// 这一节最重要的不是"隐藏能不能藏住"，而是**隐藏不许造成漏复习**
// （`MASTER.md` 决定 19 / R1）：汇总横条的总数、分布、汇总复习按钮、导航角标
// 在隐藏前后必须**一个数都不变**。所以下面每一条"过滤"断言旁边，
// 都配一条"总数没变"的断言。
// ---------------------------------------------------------------------------

/** 一个三主题的样本：learning / book / source 三种档位都齐 */
function hiddenSample(): { cards: ReviewCard[]; summaries: ReturnType<typeof buildReviewTopics> } {
  const cards = [
    card({ id: 'a1', source: '而对方', dueDate: TODAY }),
    card({ id: 'a2', source: '而对方', dueDate: TODAY }),
    card({ id: 'b1', source: '热力学', topicId: 'topic-b', dueDate: TODAY }),
    card({ id: 'c1', source: '语法俱乐部', bookId: 'book-1', dueDate: TODAY }),
    card({ id: 'd1', source: '手写卡（主题已经删了）', dueDate: TODAY })
  ]
  return { cards, summaries: buildReviewTopics(cards, SOURCES, TODAY) }
}

describe('左栏隐藏主题：只影响显示，不影响任何数字（防漏）', () => {
  it('visibleTopics / hiddenTopics / hiddenCount 各就各位', () => {
    const { summaries } = hiddenSample()
    const hideKey = reviewTopicKey('learning', 'topic-a')
    const visible = visibleTopics(summaries, [hideKey])
    const hidden = hiddenTopics(summaries, [hideKey])
    expect(visible.some((item) => item.key === hideKey)).toBe(false)
    expect(hidden.map((item) => item.key)).toEqual([hideKey])
    expect(hiddenCount(summaries, [hideKey])).toBe(1)
    // 可见 + 已隐藏 = 全部（一行都没丢）
    expect(visible.length + hidden.length).toBe(summaries.length)
  })

  it('不隐藏时原样返回（不新建数组顺序也不变）', () => {
    const { summaries } = hiddenSample()
    expect(visibleTopics(summaries, [])).toBe(summaries)
    expect(hiddenTopics(summaries, [])).toEqual([])
    expect(hiddenCount(summaries, [])).toBe(0)
  })

  it('偏好里留着"已经被删掉的主题 id"时，不虚报隐藏数', () => {
    const { summaries } = hiddenSample()
    const gone = reviewTopicKey('learning', '主题已被删除')
    expect(hiddenCount(summaries, [gone])).toBe(0)
    // 但它也不算"可见"——只是没有对应的行
    expect(visibleTopics(summaries, [gone]).length).toBe(summaries.length)
  })

  it('隐藏任意主题后：汇总总数、导航角标、汇总复习张数一个都不变（★防漏）', () => {
    const { cards, summaries } = hiddenSample()
    const before = {
      total: dueTotalOf(summaries),
      badge: computeBadges([], cards as unknown as Array<Record<string, unknown>>, TODAY).reviewDue,
      queue: dueQueue(cards, TODAY).length
    }
    // 三个数在隐藏之前本来就相等
    expect(before.total).toBe(before.badge)
    expect(before.total).toBe(before.queue)

    const hideKeys = summaries.map((item) => item.key) // 全部隐藏，最狠的情形
    const visible = visibleTopics(summaries, hideKeys)
    const hidden = hiddenTopics(summaries, hideKeys)
    expect(visible.length).toBe(0)
    expect(hidden.length).toBe(summaries.length)

    // 左栏可见主题之和 + 已隐藏主题之和 = 汇总总数（**改写后的新口径**）
    const sumOf = (list: ReturnType<typeof visibleTopics>): number =>
      list.reduce((sum, item) => sum + item.dueCount, 0)
    expect(sumOf(visible) + sumOf(hidden)).toBe(before.total)

    // 而三个"防漏"的数字一个都没动（它们根本不读隐藏列表）
    expect(dueTotalOf(summaries)).toBe(before.total)
    expect(computeBadges([], cards as unknown as Array<Record<string, unknown>>, TODAY).reviewDue).toBe(before.badge)
    expect(dueQueue(cards, TODAY).length).toBe(before.queue)
  })

  it('「汇总复习」用的到期队列仍然包含被隐藏主题的卡（★防漏：不漏）', () => {
    const { cards, summaries } = hiddenSample()
    const hideKey = reviewTopicKey('learning', 'topic-a')
    const hiddenCards = hiddenTopics(summaries, [hideKey]).flatMap((item) => item.cards)
    const queue = dueQueue(cards, TODAY)
    expect(hiddenCards.length).toBeGreaterThan(0)
    for (const item of hiddenCards) {
      expect(queue.some((entry) => entry.id === item.id), item.id).toBe(true)
    }
  })

  it('分布明细：被隐藏的主题**还在**，只是多一个「（已隐藏）」', () => {
    const { summaries } = hiddenSample()
    const hideKey = reviewTopicKey('learning', 'topic-a')
    const buckets = reviewDistributionBuckets(summaries, [hideKey])
    const hiddenOne = buckets.find((bucket) => bucket.topic === '而对方')
    expect(hiddenOne?.count).toBe(2)
    expect(hiddenOne?.hidden).toBe(true)
    // 其它主题不受牵连
    expect(buckets.find((bucket) => bucket.topic === '热力学')?.hidden).toBeUndefined()
    // 分布里数字之和 = 汇总总数（隐藏前后都不变）
    expect(buckets.reduce((sum, bucket) => sum + bucket.count, 0)).toBe(dueTotalOf(summaries))
  })

  it('分布明细按"张数多的在前、同数按名字"排（顺序不许乱跳）', () => {
    const { summaries } = hiddenSample()
    const topics = reviewDistributionBuckets(summaries).map((bucket) => bucket.topic)
    expect(topics[0]).toBe('而对方') // 2 张，最多
    const rest = topics.slice(1)
    expect(rest).toEqual(rest.slice().sort((a, b) => a.localeCompare(b, 'zh-Hans-CN')))
  })

  it('一张到期卡都没有的主题不进分布（与旧口径一致）', () => {
    const summaries = buildReviewTopics([card({ source: '语法俱乐部', bookId: 'book-1', dueDate: FAR })], SOURCES, TODAY)
    expect(reviewDistributionBuckets(summaries)).toEqual([])
  })

  it('isTopicHidden 只认 key（`topic:` / `book:` / `source:` 三档都认）', () => {
    const { summaries } = hiddenSample()
    const sourceKey = reviewTopicKey('source', '手写卡（主题已经删了）')
    const summary = summaries.find((item) => item.key === sourceKey)
    expect(summary).toBeDefined()
    expect(isTopicHidden(summary as (typeof summaries)[number], [sourceKey])).toBe(true)
    expect(isTopicHidden(summary as (typeof summaries)[number], [])).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// ⑦ 左栏"删除这个来源档"（修改 3 轮 · 2026-10）
//
// 用户原话：「这个还是删不掉。」决定：**只给来源档加删除**
// （删它 = 把它下面的卡片一起删掉，进回收站可恢复）；
// `topic:` / `book:` 档是真实实体，仍然只能隐藏。
//
// 这一节钉住两件事：
//   1. 哪一档能删 —— 判定只在 `isTopicDeletable()` 一处（不在菜单里再解析 key）
//   2. 删哪些卡 —— 直接取 `buildReviewTopics()` 的分组结果，
//      **删一个来源档只删这一档的卡**，别的档一张不动
// ---------------------------------------------------------------------------

/** 两个来源档各一堆卡：`source:A` 两张、`source:B` 一张（都用不上任何学习主题 / 书） */
function sourceSample(): ReviewCard[] {
  return [
    card({ id: 'a1', source: '来源甲', dueDate: TODAY }),
    card({ id: 'a2', source: '来源甲', dueDate: TODAY }),
    card({ id: 'b1', source: '来源乙', dueDate: TODAY })
  ]
}

describe('左栏删除来源档：只删这一档的卡，别的档一张不动', () => {
  it('三档的可删性：`source:` 可删，`topic:` / `book:` 不可删', () => {
    const { summaries } = hiddenSample()
    const find = (kind: 'learning' | 'book' | 'source', id: string): (typeof summaries)[number] =>
      summaries.find((item) => item.key === reviewTopicKey(kind, id)) as (typeof summaries)[number]
    // 这一行就是 `hiddenSample()` 里那个"主题已经删了、只剩来源名"的档
    expect(isTopicDeletable(find('source', '手写卡（主题已经删了）'))).toBe(true)
    expect(isTopicDeletable(find('learning', 'topic-a'))).toBe(false)
    expect(isTopicDeletable(find('book', 'book-1'))).toBe(false)
  })

  it('`topicDeleteCardIds()` 取的就是这一档的分组结果（不重算归属）', () => {
    const cards = sourceSample()
    const summaries = buildReviewTopics(cards, SOURCES, TODAY)
    const sourceA = summaries.find((item) => item.key === reviewTopicKey('source', '来源甲'))
    expect(sourceA).toBeDefined()
    expect(topicDeleteCardIds(sourceA as (typeof summaries)[number]).sort()).toEqual(['a1', 'a2'])
    // 与左栏那一行显示的卡片总数一致（同一份分组结果）
    expect(topicDeleteCardIds(sourceA as (typeof summaries)[number]).length).toBe(
      (sourceA as (typeof summaries)[number]).cardCount
    )
  })

  it('删掉来源甲之后：来源甲那一档消失，来源乙的 1 张还在（只删这一档）', () => {
    const cards = sourceSample()
    const before = buildReviewTopics(cards, SOURCES, TODAY)
    const sourceA = before.find((item) => item.key === reviewTopicKey('source', '来源甲'))
    expect(sourceA).toBeDefined()

    const doomed = new Set(topicDeleteCardIds(sourceA as (typeof before)[number]))
    const after = buildReviewTopics(
      cards.filter((item) => !doomed.has(item.id)),
      SOURCES,
      TODAY
    )

    // 来源甲那一档整个不见了
    expect(after.some((item) => item.key === reviewTopicKey('source', '来源甲'))).toBe(false)
    // 来源乙还在，且仍是 1 张
    const sourceB = after.find((item) => item.key === reviewTopicKey('source', '来源乙'))
    expect(sourceB?.cardCount).toBe(1)
    expect(sourceB?.cards.map((item) => item.id)).toEqual(['b1'])
    // 别的档（学习主题 / 书）一个都没少
    expect(after.length).toBe(before.length - 1)
  })

  it('删一个来源档不会动到别的档的卡片（学习主题 / 书各一张都不许少）', () => {
    const cards = [
      card({ id: 'a1', source: '来源甲', dueDate: TODAY }),
      card({ id: 't1', source: '热力学', topicId: 'topic-b', dueDate: TODAY }),
      card({ id: 'k1', source: '语法俱乐部', bookId: 'book-1', dueDate: TODAY })
    ]
    const before = buildReviewTopics(cards, SOURCES, TODAY)
    const sourceA = before.find((item) => item.key === reviewTopicKey('source', '来源甲'))
    const doomed = new Set(
      topicDeleteCardIds(sourceA as (typeof before)[number])
    )
    expect(doomed.size).toBe(1)

    const after = buildReviewTopics(
      cards.filter((item) => !doomed.has(item.id)),
      SOURCES,
      TODAY
    )
    const topicB = after.find((item) => item.key === reviewTopicKey('learning', 'topic-b'))
    const bookOne = after.find((item) => item.key === reviewTopicKey('book', 'book-1'))
    expect(topicB?.cards.map((item) => item.id)).toEqual(['t1'])
    expect(bookOne?.cards.map((item) => item.id)).toEqual(['k1'])
  })
})
