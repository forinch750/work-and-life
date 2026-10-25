/**
 * 第 06 块测试：复习历史 / 复习时间 / 间隔算法保持原样
 *
 * 对应 `docs\TASKS\06` §6.2 的四行：
 *   - 历史裁剪：每卡**恒为最近 50 次**，写第 51 次后最早的被丢弃
 *   - 历史字段完整：`at` / `grade` / `stageBefore` / `stageAfter` / `dueDateAfter` 都在
 *   - `dueTime` 排序：设了 `dueTime` 后到期顺序仍正确（不破坏原升序）
 *   - 间隔算法：三档 + 阶梯（7/14/30/60/120）× 强度系数（1.5 / 1 / 0.6）
 *
 * 最后一段"间隔算法没有被改动"是**防止误改**的：断言里写死的是验收表上的数字，
 * 不是用公式再算一遍（用公式算的测试改算法时会跟着一起变，等于没测）。
 */
import { describe, expect, it } from 'vitest'
import {
  BASE_INTERVALS,
  HISTORY_KEEP_LIMIT,
  REMEMBERED_LADDER,
  addDaysToKey,
  applyGrade,
  dueQueue,
  historyAfterAppend,
  historyFromOutcome,
  historyOverflowIds,
  historyRetentionText,
  historiesOf,
  nextIntervalDays,
  normalizeReviewCard,
  normalizeReviewHistory,
  type ReviewCard,
  type ReviewHistory
} from '../../src/shared/review'

const TODAY = '2026-02-14'

/** 造一张卡 */
function card(overrides: Partial<ReviewCard> = {}): ReviewCard {
  return {
    id: 'card-1',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    front: '正面',
    back: '答案',
    source: '测试',
    stage: 0,
    dueDate: null,
    reviewCount: 0,
    lastReviewedAt: null,
    ...overrides
  }
}

/** 造一条历史 */
function history(overrides: Partial<ReviewHistory> = {}): ReviewHistory {
  return {
    id: 'h-1',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    kind: 'history',
    cardId: 'card-1',
    at: '2026-01-01T00:00:00.000Z',
    grade: 'forgot',
    stageBefore: 0,
    stageAfter: 0,
    dueDateAfter: '2026-01-02',
    ...overrides
  }
}

/** 第 n 次评分的时间（保证严格递增，便于断言"最早的被丢弃"） */
function atOf(index: number): string {
  return new Date(Date.UTC(2026, 0, 1, 0, 0, index)).toISOString()
}

describe('历史裁剪（决定 20：每卡只保留最近 50 次）', () => {
  it('上限是 50 条，界面提示与常量一致', () => {
    expect(HISTORY_KEEP_LIMIT).toBe(50)
    expect(historyRetentionText()).toContain('50')
  })

  it('写第 51 次后，最早的那条被丢弃，总数恒为 50', () => {
    let histories: ReviewHistory[] = []
    const written: string[] = []

    for (let index = 0; index < HISTORY_KEEP_LIMIT + 1; index += 1) {
      const entry = history({ id: `h-${index}`, at: atOf(index) })
      written.push(entry.id)
      const outcome = historyAfterAppend(histories, entry)
      // 落库动作：把被裁掉的删掉（页面就是这么做的）
      const dropped = new Set(outcome.dropped)
      histories = [...histories.filter((item) => !dropped.has(item.id)), entry]
      expect(histories.length).toBeLessThanOrEqual(HISTORY_KEEP_LIMIT)
    }

    expect(histories).toHaveLength(HISTORY_KEEP_LIMIT)
    const kept = historiesOf(histories, 'card-1').map((item) => item.id)
    // 第 1 次（h-0）应被丢弃，最新的一条（h-50）必须在
    expect(kept).not.toContain('h-0')
    expect(kept).toContain(`h-${HISTORY_KEEP_LIMIT}`)
    expect(kept[0]).toBe(`h-${HISTORY_KEEP_LIMIT}`)
    expect(kept).toHaveLength(HISTORY_KEEP_LIMIT)
  })

  it('historyOverflowIds 只按时间排序后裁掉最早的那些（最新在前）', () => {
    const list = Array.from({ length: HISTORY_KEEP_LIMIT + 2 }, (_, index) =>
      history({ id: `h-${index}`, at: atOf(index) })
    )
    const dropped = historyOverflowIds(list)
    expect(dropped).toHaveLength(2)
    expect(dropped.sort()).toEqual(['h-0', 'h-1'])
  })

  it('不超过上限时一条都不删', () => {
    const list = Array.from({ length: HISTORY_KEEP_LIMIT }, (_, index) =>
      history({ id: `h-${index}`, at: atOf(index) })
    )
    expect(historyOverflowIds(list)).toEqual([])
    expect(historyAfterAppend(list.slice(0, -1), list[list.length - 1]!).dropped).toEqual([])
  })

  it('裁剪按卡分开算：另一张卡的 50 条不会把这张卡的历史挤掉', () => {
    const other = Array.from({ length: HISTORY_KEEP_LIMIT }, (_, index) =>
      history({ id: `other-${index}`, cardId: 'card-2', at: atOf(index) })
    )
    const mine = Array.from({ length: HISTORY_KEEP_LIMIT - 1 }, (_, index) =>
      history({ id: `mine-${index}`, cardId: 'card-1', at: atOf(index) })
    )
    const outcome = historyAfterAppend(
      [...other, ...mine],
      history({ id: 'mine-new', cardId: 'card-1', at: atOf(HISTORY_KEEP_LIMIT) })
    )
    expect(outcome.dropped).toEqual([])
    expect(outcome.kept).toHaveLength(HISTORY_KEEP_LIMIT)
  })
})

describe('历史字段完整（BUG-008）', () => {
  it('由 applyGrade 的结果构造历史：五个字段一个不少', () => {
    const outcome = applyGrade(card({ stage: 2 }), 'remembered', TODAY, 'standard')
    const entry = historyFromOutcome('card-1', outcome, '2026-02-14T08:30:00.000Z')

    expect(entry.kind).toBe('history')
    expect(entry.cardId).toBe('card-1')
    expect(entry.at).toBe('2026-02-14T08:30:00.000Z')
    expect(entry.grade).toBe('remembered')
    expect(entry.stageBefore).toBe(2)
    expect(entry.stageAfter).toBe(outcome.stageAfter)
    expect(entry.dueDateAfter).toBe(outcome.dueDate)
    expect(entry.dueDateAfter).toBe(addDaysToKey(TODAY, outcome.intervalDays))
  })

  it('落库后再读回来，字段仍然完整（normalizeReviewHistory）', () => {
    const outcome = applyGrade(card({ stage: 0 }), 'forgot', TODAY, 'standard')
    const input = historyFromOutcome('card-9', outcome, '2026-02-14T09:00:00.000Z')
    const parsed = normalizeReviewHistory({
      ...input,
      id: 'hist-9',
      createdAt: '2026-02-14T09:00:00.000Z',
      updatedAt: '2026-02-14T09:00:00.000Z'
    })

    expect(parsed).not.toBeNull()
    expect(parsed?.cardId).toBe('card-9')
    expect(parsed?.at).toBe('2026-02-14T09:00:00.000Z')
    expect(parsed?.grade).toBe('forgot')
    expect(parsed?.stageBefore).toBe(0)
    expect(parsed?.stageAfter).toBe(0)
    expect(parsed?.dueDateAfter).toBe(addDaysToKey(TODAY, 1))
  })

  it('历史记录不会被当成卡片（否则到期数会凭空变大）', () => {
    expect(normalizeReviewCard({ id: 'h', kind: 'history', cardId: 'c' })).toBeNull()
    expect(normalizeReviewHistory({ id: 'c', front: '这是一张卡' })).toBeNull()
  })

  it('historiesOf 只取这张卡的，并按时间倒序', () => {
    const list = [
      history({ id: 'a', at: atOf(1) }),
      history({ id: 'b', at: atOf(3) }),
      history({ id: 'c', cardId: 'card-2', at: atOf(2) }),
      history({ id: 'd', at: atOf(2) })
    ]
    expect(historiesOf(list, 'card-1').map((item) => item.id)).toEqual(['b', 'd', 'a'])
  })
})

describe('dueTime 排序（FEAT-007：不破坏原升序）', () => {
  it('同一天到期、都设了时间：按时间的先后', () => {
    const queue = dueQueue(
      [
        card({ id: 'late', dueDate: TODAY, dueTime: '20:00', createdAt: '2026-01-01T00:00:00.000Z' }),
        card({ id: 'early', dueDate: TODAY, dueTime: '08:00', createdAt: '2026-02-01T00:00:00.000Z' })
      ],
      TODAY
    )
    expect(queue.map((item) => item.id)).toEqual(['early', 'late'])
  })

  it('到期日的升序仍然优先于时间', () => {
    const queue = dueQueue(
      [
        card({ id: 'tomorrowEarly', dueDate: addDaysToKey(TODAY, 1), dueTime: '00:10' }),
        card({ id: 'todayLate', dueDate: TODAY, dueTime: '23:59' }),
        card({ id: 'overdue', dueDate: addDaysToKey(TODAY, -3), dueTime: '12:00' })
      ],
      TODAY
    )
    expect(queue.map((item) => item.id)).toEqual(['overdue', 'todayLate'])
  })

  it('没设时间的老卡仍按创建时间排（行为不变）', () => {
    const queue = dueQueue(
      [
        card({ id: 'later', dueDate: TODAY, createdAt: '2026-02-01T00:00:00.000Z' }),
        card({ id: 'earlier', dueDate: TODAY, createdAt: '2026-01-01T00:00:00.000Z' }),
        card({ id: 'timed', dueDate: TODAY, dueTime: '06:00', createdAt: '2026-02-10T00:00:00.000Z' })
      ],
      TODAY
    )
    // 一张有时间、两张没有：不定"谁先"，只要求"没时间的两张之间保持创建时间升序"，
    // 且整条队列的到期日升序不被破坏（这是 05 块之前的既有契约）
    expect(queue.filter((item) => item.dueTime === undefined).map((item) => item.id)).toEqual([
      'earlier',
      'later'
    ])
    expect(queue.every((item) => item.dueDate === TODAY)).toBe(true)
  })

  it('设了 dueTime 不影响"今天到期"的判断（只管排序与展示）', () => {
    const queue = dueQueue(
      [card({ id: 'tonight', dueDate: TODAY, dueTime: '23:30' })],
      TODAY
    )
    expect(queue).toHaveLength(1)
    const future = dueQueue(
      [card({ id: 'tomorrow', dueDate: addDaysToKey(TODAY, 1), dueTime: '00:00' })],
      TODAY
    )
    expect(future).toHaveLength(0)
  })
})

describe('间隔算法没有被改动（决定：照旧，只换入口）', () => {
  it('基础间隔：忘了 1 天 / 有点模糊 3 天 / 记住了 7 天起', () => {
    expect(BASE_INTERVALS.forgot).toBe(1)
    expect(BASE_INTERVALS.fuzzy).toBe(3)
    expect(BASE_INTERVALS.remembered).toBe(7)
    expect(REMEMBERED_LADDER).toEqual([7, 14, 30, 60, 120])
  })

  it('标准强度：阶梯正好是 7 / 14 / 30 / 60 / 120', () => {
    expect([0, 1, 2, 3, 4].map((stage) => nextIntervalDays('remembered', stage, 'standard'))).toEqual([
      7, 14, 30, 60, 120
    ])
    expect(nextIntervalDays('forgot', 0, 'standard')).toBe(1)
    expect(nextIntervalDays('fuzzy', 0, 'standard')).toBe(3)
  })

  it('宽松 ×1.5：1/3/7/14/30/60/120 各自放大后取整', () => {
    expect(nextIntervalDays('forgot', 0, 'relaxed')).toBe(2)
    expect(nextIntervalDays('fuzzy', 0, 'relaxed')).toBe(5)
    expect([0, 1, 2, 3, 4].map((stage) => nextIntervalDays('remembered', stage, 'relaxed'))).toEqual([
      11, 21, 45, 90, 180
    ])
  })

  it('密集 ×0.6：间隔更短，且任何一档都不小于 1 天', () => {
    expect(nextIntervalDays('forgot', 0, 'intense')).toBe(1)
    expect(nextIntervalDays('fuzzy', 0, 'intense')).toBe(2)
    expect([0, 1, 2, 3, 4].map((stage) => nextIntervalDays('remembered', stage, 'intense'))).toEqual([
      4, 8, 18, 36, 72
    ])
    for (const stage of [0, 1, 2, 3, 4]) {
      for (const grade of ['forgot', 'fuzzy', 'remembered'] as const) {
        expect(nextIntervalDays(grade, stage, 'intense')).toBeGreaterThanOrEqual(1)
      }
    }
  })

  it('applyGrade 的到期日 = 今天 + 间隔（三次评分走过的路一样）', () => {
    const outcome = applyGrade(card({ stage: 1, reviewCount: 4 }), 'remembered', TODAY, 'standard')
    expect(outcome.stageBefore).toBe(1)
    expect(outcome.stageAfter).toBe(2)
    expect(outcome.intervalDays).toBe(30)
    expect(outcome.dueDate).toBe(addDaysToKey(TODAY, 30))
    expect(outcome.reviewCount).toBe(5)
  })
})
