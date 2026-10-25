/**
 * 阶段 5 测试：复习间隔算法（PRD §5.4 / §10.7 G2–G6）
 *
 * 这是复习模块的核心规则：三档评分 → 阶段推进 → 下次到期日。
 * 算法错了，整个复习模块就失去意义，所以这里要测得足够细。
 */
import { describe, expect, it } from 'vitest'
import {
  BACKLOG_SUGGESTION,
  BACKLOG_THRESHOLD,
  BASE_INTERVALS,
  REMEMBERED_LADDER,
  addDaysToKey,
  applyGrade,
  backlogInfo,
  dueQueue,
  intervalHintDays,
  isDue,
  nextIntervalDays,
  nextStage,
  normalizeReviewCard,
  type ReviewCard
} from '../../src/shared/review'

const TODAY = '2026-02-14'

function card(overrides: Partial<ReviewCard> = {}): ReviewCard {
  return {
    id: 'c1',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    front: '问题',
    back: '答案',
    source: '测试',
    stage: 0,
    dueDate: null,
    reviewCount: 0,
    lastReviewedAt: null,
    ...overrides
  }
}

describe('addDaysToKey（复习模块自带的日期加法）', () => {
  it('跨月正确', () => {
    expect(addDaysToKey('2026-01-31', 1)).toBe('2026-02-01')
    expect(addDaysToKey('2026-02-01', -1)).toBe('2026-01-31')
  })

  it('跨年正确', () => {
    expect(addDaysToKey('2026-12-31', 1)).toBe('2027-01-01')
  })

  it('闰年 2 月正确', () => {
    expect(addDaysToKey('2028-02-28', 1)).toBe('2028-02-29')
  })

  it('加 0 天不变', () => {
    expect(addDaysToKey(TODAY, 0)).toBe(TODAY)
  })
})

describe('nextStage', () => {
  it('忘了：回到 0 层', () => {
    expect(nextStage('forgot', 0)).toBe(0)
    expect(nextStage('forgot', 3)).toBe(0)
  })

  it('有点模糊：停在原层', () => {
    expect(nextStage('fuzzy', 0)).toBe(0)
    expect(nextStage('fuzzy', 2)).toBe(2)
  })

  it('记住了：往上走一层', () => {
    expect(nextStage('remembered', 0)).toBe(1)
    expect(nextStage('remembered', 1)).toBe(2)
  })

  it('记住了：不会超过阶梯上限', () => {
    expect(nextStage('remembered', REMEMBERED_LADDER.length - 1)).toBe(
      REMEMBERED_LADDER.length - 1
    )
    expect(nextStage('remembered', 99)).toBe(REMEMBERED_LADDER.length - 1)
  })

  it('负数层级被夹到 0', () => {
    expect(nextStage('fuzzy', -5)).toBe(0)
  })
})

describe('nextIntervalDays', () => {
  it('标准强度下三档分别是 1 / 3 / 7 天（新卡）', () => {
    expect(nextIntervalDays('forgot', 0, 'standard')).toBe(BASE_INTERVALS.forgot)
    expect(nextIntervalDays('fuzzy', 0, 'standard')).toBe(BASE_INTERVALS.fuzzy)
    // 新卡"记住了" → 阶段变 1 → 取阶梯第 1 项 = 14？不，阶梯按推进后的阶段取
    expect(nextIntervalDays('remembered', 1, 'standard')).toBe(REMEMBERED_LADDER[1])
  })

  it('"记住了"随阶段逐级放大', () => {
    const intervals = REMEMBERED_LADDER.map((_, index) =>
      nextIntervalDays('remembered', index, 'standard')
    )
    for (let index = 1; index < intervals.length; index += 1) {
      expect(intervals[index]!).toBeGreaterThan(intervals[index - 1]!)
    }
  })

  it('宽松档间隔更长，密集档间隔更短', () => {
    for (const grade of ['forgot', 'fuzzy', 'remembered'] as const) {
      const standard = nextIntervalDays(grade, 1, 'standard')
      expect(nextIntervalDays(grade, 1, 'relaxed')).toBeGreaterThanOrEqual(standard)
      expect(nextIntervalDays(grade, 1, 'intense')).toBeLessThanOrEqual(standard)
    }
  })

  it('任何档位都不会小于 1 天', () => {
    for (const grade of ['forgot', 'fuzzy', 'remembered'] as const) {
      for (const intensity of ['standard', 'relaxed', 'intense'] as const) {
        for (const stage of [0, 1, 5, 99]) {
          expect(nextIntervalDays(grade, stage, intensity)).toBeGreaterThanOrEqual(1)
        }
      }
    }
  })

  it('阶段越界不会取到 undefined', () => {
    expect(Number.isFinite(nextIntervalDays('remembered', 999, 'standard'))).toBe(true)
    expect(Number.isFinite(nextIntervalDays('remembered', -1, 'standard'))).toBe(true)
  })
})

describe('applyGrade（G2：按 1/2/3 记录选择并翻下一张）', () => {
  it('忘了：阶段归零、间隔 1 天、复习次数 +1', () => {
    const result = applyGrade({ stage: 3, reviewCount: 5 }, 'forgot', TODAY)
    expect(result.stageAfter).toBe(0)
    expect(result.intervalDays).toBe(1)
    expect(result.dueDate).toBe('2026-02-15')
    expect(result.reviewCount).toBe(6)
    expect(result.stageBefore).toBe(3)
  })

  it('有点模糊：阶段不变、间隔 3 天', () => {
    const result = applyGrade({ stage: 2, reviewCount: 1 }, 'fuzzy', TODAY)
    expect(result.stageAfter).toBe(2)
    expect(result.intervalDays).toBe(3)
    expect(result.dueDate).toBe('2026-02-17')
  })

  it('记住了：阶段 +1、间隔按阶梯放大', () => {
    const result = applyGrade({ stage: 0, reviewCount: 0 }, 'remembered', TODAY)
    expect(result.stageAfter).toBe(1)
    expect(result.intervalDays).toBe(REMEMBERED_LADDER[1])
    expect(result.dueDate).toBe(addDaysToKey(TODAY, REMEMBERED_LADDER[1]!))
    expect(result.reviewCount).toBe(1)
  })

  it('连续记住：间隔单调不减', () => {
    let stage = 0
    let previous = 0
    for (let round = 0; round < 6; round += 1) {
      const result = applyGrade({ stage, reviewCount: round }, 'remembered', TODAY)
      expect(result.intervalDays).toBeGreaterThanOrEqual(previous)
      previous = result.intervalDays
      stage = result.stageAfter
    }
  })

  it('复习次数从非法值开始也不会算错', () => {
    expect(applyGrade({ stage: 0, reviewCount: -3 }, 'fuzzy', TODAY).reviewCount).toBe(1)
  })
})

describe('intervalHintDays（按钮上写"下次什么时候再考你"）', () => {
  it('与真正执行评分后的间隔一致', () => {
    for (const grade of ['forgot', 'fuzzy', 'remembered'] as const) {
      for (const stage of [0, 1, 3]) {
        const hint = intervalHintDays(grade, stage, 'standard')
        const actual = applyGrade({ stage, reviewCount: 0 }, grade, TODAY, 'standard').intervalDays
        expect(hint).toBe(actual)
      }
    }
  })

  it('三档提示天数满足 忘了 < 模糊 < 记住', () => {
    const forgot = intervalHintDays('forgot', 0, 'standard')
    const fuzzy = intervalHintDays('fuzzy', 0, 'standard')
    const remembered = intervalHintDays('remembered', 0, 'standard')
    expect(forgot).toBeLessThan(fuzzy)
    expect(fuzzy).toBeLessThan(remembered)
  })
})

describe('isDue', () => {
  it('到期日为 null 视为今天就要复习', () => {
    expect(isDue(card({ dueDate: null }), TODAY)).toBe(true)
  })

  it('到期日早于或等于今天都算到期', () => {
    expect(isDue(card({ dueDate: '2026-02-13' }), TODAY)).toBe(true)
    expect(isDue(card({ dueDate: TODAY }), TODAY)).toBe(true)
  })

  it('未来的到期日不算', () => {
    expect(isDue(card({ dueDate: '2026-02-20' }), TODAY)).toBe(false)
  })
})

describe('dueQueue（G6：今日到期队列）', () => {
  it('只取到期的卡（未排期的也算今天可做）', () => {
    const queue = dueQueue(
      [
        card({ id: 'a', dueDate: '2026-02-10' }),
        card({ id: 'b', dueDate: '2026-03-01' }),
        card({ id: 'c', dueDate: null })
      ],
      TODAY
    )
    expect(queue.map((item) => item.id)).toEqual(['a', 'c'])
  })

  it('已逾期的排在未排期之前，逾期越久越先复习', () => {
    const queue = dueQueue(
      [
        card({ id: 'recent', dueDate: '2026-02-13' }),
        card({ id: 'old', dueDate: '2026-01-01' }),
        card({ id: 'new', dueDate: null })
      ],
      TODAY
    )
    expect(queue.map((item) => item.id)).toEqual(['old', 'recent', 'new'])
  })

  it('全都是未排期时按创建时间升序（老卡优先）', () => {
    const queue = dueQueue(
      [
        card({ id: 'later', dueDate: null, createdAt: '2026-02-01T00:00:00.000Z' }),
        card({ id: 'earlier', dueDate: null, createdAt: '2026-01-01T00:00:00.000Z' })
      ],
      TODAY
    )
    expect(queue.map((item) => item.id)).toEqual(['earlier', 'later'])
  })

  it('同日到期按创建时间升序', () => {
    const queue = dueQueue(
      [
        card({ id: 'later', dueDate: TODAY, createdAt: '2026-02-01T00:00:00.000Z' }),
        card({ id: 'earlier', dueDate: TODAY, createdAt: '2026-01-01T00:00:00.000Z' })
      ],
      TODAY
    )
    expect(queue.map((item) => item.id)).toEqual(['earlier', 'later'])
  })
})

describe('backlogInfo（G 积压提示：> 50 张时给出建议）', () => {
  it('不超过阈值时不提示', () => {
    expect(backlogInfo(0).show).toBe(false)
    expect(backlogInfo(BACKLOG_THRESHOLD).show).toBe(false)
  })

  it('超过阈值时提示并给出建议数量', () => {
    const info = backlogInfo(BACKLOG_THRESHOLD + 1)
    expect(info.show).toBe(true)
    expect(info.suggestion).toBe(BACKLOG_SUGGESTION)
    expect(info.message).toContain(String(BACKLOG_THRESHOLD + 1))
    expect(info.message).toContain(String(BACKLOG_SUGGESTION))
  })

  it('建议数量小于阈值（否则提示没有意义）', () => {
    expect(BACKLOG_SUGGESTION).toBeLessThan(BACKLOG_THRESHOLD)
  })
})

describe('normalizeReviewCard', () => {
  it('补齐缺失字段', () => {
    const result = normalizeReviewCard({ id: 'x', front: ' 问题 ' })
    expect(result?.front).toBe('问题')
    expect(result?.back).toBe('')
    expect(result?.source).toBe('未标注来源')
    expect(result?.stage).toBe(0)
    expect(result?.dueDate).toBeNull()
    expect(result?.reviewCount).toBe(0)
  })

  it('没有 id 的记录被丢弃', () => {
    expect(normalizeReviewCard({ front: '无 id' })).toBeNull()
  })

  it('非法 stage 与 reviewCount 回退到 0', () => {
    const result = normalizeReviewCard({ id: 'x', stage: -5, reviewCount: 'abc' })
    expect(result?.stage).toBe(0)
    expect(result?.reviewCount).toBe(0)
  })

  it('空字符串的 dueDate 视为 null', () => {
    expect(normalizeReviewCard({ id: 'x', dueDate: '' })?.dueDate).toBeNull()
  })
})
