/**
 * 「设置复习时间」的纯逻辑单测（第二轮 FEAT-001 / `docs\TASKS\03`）
 *
 * 为什么单独测：`reviewAt` / `reviewTime` 是第 03 块给**任务**新增的两个可选字段
 * （右键菜单里的"设置复习时间"用它）。两个坑必须钉住：
 *
 *   1. **旧任务零改写**：没有这两个字段的记录读进来不能凭空多出字段
 *   2. **清空要真的清掉**：界面上传的是 `null`（不是 `undefined`）——
 *      `undefined` 会被 JSON 序列化整条丢掉，旧值就清不掉了（已踩过）
 */
import { describe, expect, it } from 'vitest'
import {
  UNSCHEDULED,
  isDueForReview,
  normalizePlanTask,
  reviewTimeLabel,
  taskReviewPatch
} from '../../src/shared/plan'

const TODAY = '2026-10-11'

function task(extra: Record<string, unknown> = {}): ReturnType<typeof normalizePlanTask> {
  return normalizePlanTask({
    id: 'p1',
    createdAt: '2026-10-01T00:00:00.000Z',
    updatedAt: '2026-10-01T00:00:00.000Z',
    title: '背单词',
    date: TODAY,
    timeSlot: 'none',
    recurrence: 'none',
    done: false,
    carriedOver: 0,
    doneAt: null,
    ...extra
  })
}

describe('taskReviewPatch：设置与清空复习时间', () => {
  it('0 天 = 今天', () => {
    expect(taskReviewPatch(TODAY, 0)).toEqual({ reviewAt: TODAY, reviewTime: '09:00' })
  })

  it('1 / 3 / 7 天按时区本地日期往后推（跨月也要对）', () => {
    expect(taskReviewPatch(TODAY, 1).reviewAt).toBe('2026-10-12')
    expect(taskReviewPatch(TODAY, 3).reviewAt).toBe('2026-10-14')
    expect(taskReviewPatch(TODAY, 7).reviewAt).toBe('2026-10-18')
    // 跨月：10-31 + 1 天 = 11-01
    expect(taskReviewPatch('2026-10-31', 1).reviewAt).toBe('2026-11-01')
  })

  it('清空时两个字段一起清（不留半截状态）', () => {
    expect(taskReviewPatch(TODAY, null)).toEqual({ reviewAt: undefined, reviewTime: undefined })
  })

  it('时刻格式不合法时回落到 09:00，不把脏值写进数据', () => {
    expect(taskReviewPatch(TODAY, 3, '25:00').reviewTime).toBe('09:00')
    expect(taskReviewPatch(TODAY, 3, 'abc').reviewTime).toBe('09:00')
    expect(taskReviewPatch(TODAY, 3, '21:30').reviewTime).toBe('21:30')
  })

  it('负数天数按 0 处理（不能把复习时间设到昨天去）', () => {
    expect(taskReviewPatch(TODAY, -5).reviewAt).toBe(TODAY)
  })
})

describe('normalizePlanTask：旧记录零改写', () => {
  it('没有 reviewAt / reviewTime 的任务读进来不会凭空多出这两个字段', () => {
    const plain = task()
    expect('reviewAt' in plain).toBe(false)
    expect('reviewTime' in plain).toBe(false)
  })

  it('写了 reviewAt 就能读出来', () => {
    const withReview = task({ reviewAt: '2026-10-14', reviewTime: '21:30' })
    expect(withReview.reviewAt).toBe('2026-10-14')
    expect(withReview.reviewTime).toBe('21:30')
  })

  it('清空后留下的 null 被丢掉，字段等于不存在（界面据此判断"没设"）', () => {
    const cleared = task({ reviewAt: null, reviewTime: null })
    expect(cleared.reviewAt).toBeUndefined()
    expect(cleared.reviewTime).toBeUndefined()
  })

  it('reviewTime 格式不合法时丢掉，但 reviewAt 仍然保留', () => {
    const bad = task({ reviewAt: '2026-10-14', reviewTime: '9:00' })
    expect(bad.reviewAt).toBe('2026-10-14')
    expect(bad.reviewTime).toBeUndefined()
  })

  it('reviewAt 是空串等价于没设', () => {
    expect(task({ reviewAt: '' }).reviewAt).toBeUndefined()
  })

  it('这两个字段不影响别的字段的解析', () => {
    const t = task({ reviewAt: '2026-10-14', date: UNSCHEDULED })
    expect(t.date).toBe(UNSCHEDULED)
    expect(t.done).toBe(false)
  })
})

describe('isDueForReview：什么时候算"该复习了"', () => {
  it('没设复习时间永远不算到期', () => {
    expect(isDueForReview(task(), TODAY)).toBe(false)
  })

  it('就是今天 → 到期', () => {
    expect(isDueForReview(task({ reviewAt: TODAY }), TODAY)).toBe(true)
  })

  it('已经过了那天 → 还算到期（不能因为过了一天就永远不再提醒）', () => {
    expect(isDueForReview(task({ reviewAt: '2026-10-01' }), TODAY)).toBe(true)
  })

  it('还没到 → 不到期', () => {
    expect(isDueForReview(task({ reviewAt: '2026-10-12' }), TODAY)).toBe(false)
  })
})

describe('reviewTimeLabel：行上显示什么', () => {
  it('没设复习时间 → 不显示（null）', () => {
    expect(reviewTimeLabel(task(), TODAY)).toBeNull()
  })

  it('到期时写"该复习了"', () => {
    expect(reviewTimeLabel(task({ reviewAt: TODAY }), TODAY)).toBe('该复习了')
    expect(reviewTimeLabel(task({ reviewAt: '2026-10-01' }), TODAY)).toBe('该复习了')
  })

  it('未到期时写日期，带时刻', () => {
    expect(reviewTimeLabel(task({ reviewAt: '2026-10-14', reviewTime: '21:30' }), TODAY)).toBe(
      '复习 10-14 21:30'
    )
  })

  it('只有日期没有时刻时也不多一个空格', () => {
    expect(reviewTimeLabel(task({ reviewAt: '2026-10-14' }), TODAY)).toBe('复习 10-14')
  })
})
