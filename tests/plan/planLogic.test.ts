/**
 * 阶段 4 测试：计划模块纯逻辑
 *
 * 直接对应 PRD §10.5（E1–E6）：
 *   E2 勾选完成后沉到已完成区
 *   E3 周视图拖拽改期
 *   E4 重复任务次日重现、昨日记录保留
 *   E5 昨天未完成的任务今天自动出现并显示"已顺延 1 次"
 *   E6 逾期任务置顶并标红（排序与标记由这里保证）
 */
import { describe, expect, it } from 'vitest'
import {
  UNSCHEDULED,
  normalizePlanTask,
  timeSlotWeight,
  type PlanTask
} from '../../src/shared/plan'
import {
  carryoverLabel,
  computeCarryover,
  countForHeader,
  expandRecurrenceForDay,
  groupByDate,
  groupForToday,
  isOverdue,
  isToday,
  nextOccurrenceDate,
  recurrenceHitsOn,
  reschedulePatch
} from '../../src/shared/planLogic'

const TODAY = '2026-02-14'

let seq = 0
function task(partial: Partial<PlanTask> = {}): PlanTask {
  seq += 1
  return {
    id: partial.id ?? `t${seq}`,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    title: partial.title ?? `任务 ${seq}`,
    date: partial.date ?? TODAY,
    timeSlot: partial.timeSlot ?? 'none',
    recurrence: partial.recurrence ?? 'none',
    done: partial.done ?? false,
    carriedOver: partial.carriedOver ?? 0,
    doneAt: partial.doneAt ?? null,
    ...(partial.deletedAt ? { deletedAt: partial.deletedAt } : {}),
    ...(partial.note ? { note: partial.note } : {}),
    ...(partial.seriesId ? { seriesId: partial.seriesId } : {})
  }
}

describe('normalizePlanTask', () => {
  it('补齐缺失字段并把非法值回退', () => {
    const result = normalizePlanTask({ id: 'a', title: ' 交周报 ', createdAt: 'x', updatedAt: 'y' })
    expect(result.title).toBe('交周报')
    expect(result.date).toBe(UNSCHEDULED)
    expect(result.timeSlot).toBe('none')
    expect(result.recurrence).toBe('none')
    expect(result.done).toBe(false)
    expect(result.carriedOver).toBe(0)
    expect(result.doneAt).toBeNull()
  })

  it('非法时段与重复规则回退到默认', () => {
    const result = normalizePlanTask({ timeSlot: '深夜', recurrence: '每两小时' })
    expect(result.timeSlot).toBe('none')
    expect(result.recurrence).toBe('none')
  })

  it('负数顺延次数会被夹到 0', () => {
    expect(normalizePlanTask({ carriedOver: -3 }).carriedOver).toBe(0)
  })

  it('完成但没写 doneAt 时用 updatedAt 兜底', () => {
    const result = normalizePlanTask({ done: true, updatedAt: '2026-02-14T10:00:00.000Z' })
    expect(result.doneAt).toBe('2026-02-14T10:00:00.000Z')
  })

  it('空字符串的备注与项目不会被写入', () => {
    const result = normalizePlanTask({ note: '', projectId: '' })
    expect(result.note).toBeUndefined()
    expect(result.projectId).toBeUndefined()
  })
})

describe('timeSlotWeight', () => {
  it('排序为 上午 → 下午 → 晚上 → 全天', () => {
    expect(timeSlotWeight('morning')).toBeLessThan(timeSlotWeight('afternoon'))
    expect(timeSlotWeight('afternoon')).toBeLessThan(timeSlotWeight('evening'))
    expect(timeSlotWeight('evening')).toBeLessThan(timeSlotWeight('none'))
  })
})

describe('isOverdue / isToday', () => {
  it('昨天未完成算逾期', () => {
    expect(isOverdue(task({ date: '2026-02-13' }), TODAY)).toBe(true)
  })

  it('已完成不算逾期，哪怕日期在过去', () => {
    expect(isOverdue(task({ date: '2026-02-13', done: true }), TODAY)).toBe(false)
  })

  it('今天与未来的不算逾期', () => {
    expect(isOverdue(task({ date: TODAY }), TODAY)).toBe(false)
    expect(isOverdue(task({ date: '2026-02-20' }), TODAY)).toBe(false)
  })

  it('"待安排"不算逾期', () => {
    expect(isOverdue(task({ date: UNSCHEDULED }), TODAY)).toBe(false)
  })

  it('isToday 只认当天', () => {
    expect(isToday(task({ date: TODAY }), TODAY)).toBe(true)
    expect(isToday(task({ date: '2026-02-13' }), TODAY)).toBe(false)
  })
})

describe('computeCarryover（对应 E5）', () => {
  it('把昨天未完成的任务挪到今天，顺延次数 +1', () => {
    const result = computeCarryover([task({ id: 'a', date: '2026-02-13' })], TODAY)
    expect(result.moved).toEqual([
      { id: 'a', from: '2026-02-13', to: TODAY, carriedOver: 1 }
    ])
  })

  it('多次顺延会累加计数（对应显示"已顺延 3 次"）', () => {
    const result = computeCarryover([task({ id: 'a', date: '2026-02-10', carriedOver: 3 })], TODAY)
    expect(result.moved[0]?.carriedOver).toBe(4)
  })

  it('已完成的任务不顺延', () => {
    const result = computeCarryover([task({ date: '2026-02-13', done: true })], TODAY)
    expect(result.moved).toHaveLength(0)
  })

  it('重复任务不参与顺延（避免与周期重现打架）', () => {
    const result = computeCarryover([task({ date: '2026-02-13', recurrence: 'daily' })], TODAY)
    expect(result.moved).toHaveLength(0)
  })

  it('今天与未来的任务不顺延', () => {
    const result = computeCarryover(
      [task({ date: TODAY }), task({ date: '2026-03-01' })],
      TODAY
    )
    expect(result.moved).toHaveLength(0)
  })

  it('"待安排"的任务不顺延（它本来就没排期）', () => {
    const result = computeCarryover([task({ date: UNSCHEDULED })], TODAY)
    expect(result.moved).toHaveLength(0)
  })

  it('一次能处理多条，且互不影响', () => {
    const result = computeCarryover(
      [
        task({ id: 'a', date: '2026-02-12' }),
        task({ id: 'b', date: '2026-02-13', carriedOver: 2 }),
        task({ id: 'c', date: TODAY }),
        task({ id: 'd', date: '2026-02-11', done: true })
      ],
      TODAY
    )
    expect(result.moved.map((item) => item.id).sort()).toEqual(['a', 'b'])
    expect(result.moved.find((item) => item.id === 'b')?.carriedOver).toBe(3)
  })
})

describe('recurrenceHitsOn（对应 E4）', () => {
  it('每天：起点及之后每天命中', () => {
    expect(recurrenceHitsOn('daily', '2026-02-01', '2026-02-01')).toBe(true)
    expect(recurrenceHitsOn('daily', '2026-02-01', '2026-02-14')).toBe(true)
  })

  it('每天：起点之前不命中', () => {
    expect(recurrenceHitsOn('daily', '2026-02-10', '2026-02-09')).toBe(false)
  })

  it('每周：相隔 7 的整数倍命中', () => {
    expect(recurrenceHitsOn('weekly', '2026-02-07', '2026-02-07')).toBe(true)
    expect(recurrenceHitsOn('weekly', '2026-02-07', '2026-02-14')).toBe(true)
    expect(recurrenceHitsOn('weekly', '2026-02-07', '2026-02-21')).toBe(true)
    expect(recurrenceHitsOn('weekly', '2026-02-07', '2026-02-10')).toBe(false)
  })

  it('每月：日期号相同命中', () => {
    expect(recurrenceHitsOn('monthly', '2026-01-15', '2026-02-15')).toBe(true)
    expect(recurrenceHitsOn('monthly', '2026-01-15', '2026-03-15')).toBe(true)
    expect(recurrenceHitsOn('monthly', '2026-01-15', '2026-02-16')).toBe(false)
  })

  it('不重复：只有当天命中', () => {
    expect(recurrenceHitsOn('none', '2026-02-14', '2026-02-14')).toBe(true)
    expect(recurrenceHitsOn('none', '2026-02-14', '2026-02-15')).toBe(false)
  })
})

describe('expandRecurrenceForDay（对应 E4：次日重现且昨日记录保留）', () => {
  const template = task({
    id: 'series-1',
    title: '晨会',
    recurrence: 'daily',
    date: '2026-02-01',
    seriesId: 'series-1'
  })

  it('未勾选的日期展开成待办', () => {
    const result = expandRecurrenceForDay([template], [], TODAY)
    expect(result).toHaveLength(1)
    expect(result[0]).toMatchObject({ seriesId: 'series-1', date: TODAY, done: false })
  })

  it('已勾选的日期展开成已完成', () => {
    const completion = task({
      id: 'c1',
      title: '晨会',
      recurrence: 'none',
      date: TODAY,
      done: true,
      seriesId: 'series-1'
    })
    const result = expandRecurrenceForDay([template], [completion], TODAY)
    expect(result[0]?.done).toBe(true)
  })

  it('别的日期的完成记录不会影响今天', () => {
    const yesterdayDone = task({
      id: 'c0',
      date: '2026-02-13',
      done: true,
      seriesId: 'series-1'
    })
    const result = expandRecurrenceForDay([template], [yesterdayDone], TODAY)
    expect(result[0]?.done).toBe(false)
  })

  it('起点之前的日子不展开', () => {
    expect(expandRecurrenceForDay([template], [], '2026-01-20')).toHaveLength(0)
  })

  it('不重复的任务不参与展开', () => {
    const plain = task({ recurrence: 'none', date: TODAY })
    expect(expandRecurrenceForDay([plain], [], TODAY)).toHaveLength(0)
  })

  it('没有 seriesId 时用模板自己的 id 作为系列标识', () => {
    const noSeries = task({ id: 'x1', recurrence: 'weekly', date: '2026-02-07' })
    const result = expandRecurrenceForDay([noSeries], [], TODAY)
    expect(result[0]?.seriesId).toBe('x1')
  })
})

describe('groupForToday（对应 E2 / E6）', () => {
  it('逾期排在最前，且顺序在分组结构里就固定下来', () => {
    const groups = groupForToday(
      [
        task({ id: 'today', date: TODAY }),
        task({ id: 'old', date: '2026-02-01' }),
        task({ id: 'future', date: '2026-03-01' }),
        task({ id: 'none', date: UNSCHEDULED }),
        task({ id: 'done', date: TODAY, done: true, doneAt: '2026-02-14T09:00:00.000Z' })
      ],
      TODAY
    )
    expect(groups.overdue.map((t) => t.id)).toEqual(['old'])
    expect(groups.today.map((t) => t.id)).toEqual(['today'])
    expect(groups.upcoming.map((t) => t.id)).toEqual(['future'])
    expect(groups.unscheduled.map((t) => t.id)).toEqual(['none'])
    expect(groups.doneToday.map((t) => t.id)).toEqual(['done'])
  })

  it('逾期按日期升序：拖得越久越靠前', () => {
    const groups = groupForToday(
      [
        task({ id: 'recent', date: '2026-02-13' }),
        task({ id: 'ancient', date: '2026-01-01' }),
        task({ id: 'middle', date: '2026-02-05' })
      ],
      TODAY
    )
    expect(groups.overdue.map((t) => t.id)).toEqual(['ancient', 'middle', 'recent'])
  })

  it('今天的任务按时段排序：上午 → 下午 → 晚上 → 全天', () => {
    const groups = groupForToday(
      [
        task({ id: 'none', timeSlot: 'none' }),
        task({ id: 'evening', timeSlot: 'evening' }),
        task({ id: 'morning', timeSlot: 'morning' }),
        task({ id: 'afternoon', timeSlot: 'afternoon' })
      ],
      TODAY
    )
    expect(groups.today.map((t) => t.id)).toEqual(['morning', 'afternoon', 'evening', 'none'])
  })

  it('过去已完成的任务不进今天视图（避免越用越长）', () => {
    const groups = groupForToday(
      [task({ date: '2026-02-10', done: true, doneAt: '2026-02-10T09:00:00.000Z' })],
      TODAY
    )
    expect(groups.overdue).toHaveLength(0)
    expect(groups.today).toHaveLength(0)
    expect(groups.upcoming).toHaveLength(0)
    expect(groups.doneToday).toHaveLength(0)
  })

  it('已完成的"待安排"任务不显示', () => {
    const groups = groupForToday([task({ date: UNSCHEDULED, done: true })], TODAY)
    expect(groups.unscheduled).toHaveLength(0)
  })

  it('今天已完成按完成时间倒序（最近完成的在上面）', () => {
    const groups = groupForToday(
      [
        task({ id: 'early', date: TODAY, done: true, doneAt: '2026-02-14T08:00:00.000Z' }),
        task({ id: 'late', date: TODAY, done: true, doneAt: '2026-02-14T20:00:00.000Z' })
      ],
      TODAY
    )
    expect(groups.doneToday.map((t) => t.id)).toEqual(['late', 'early'])
  })
})

describe('groupByDate（周视图用）', () => {
  it('按日期键分组', () => {
    const map = groupByDate([
      task({ id: 'a', date: '2026-02-09' }),
      task({ id: 'b', date: '2026-02-09' }),
      task({ id: 'c', date: '2026-02-10' })
    ])
    expect(map.get('2026-02-09')).toHaveLength(2)
    expect(map.get('2026-02-10')).toHaveLength(1)
    expect(map.get('2026-02-11')).toBeUndefined()
  })
})

describe('countForHeader', () => {
  it('统计逾期、今天、本周（不含已完成与待安排）', () => {
    const week = [
      '2026-02-09',
      '2026-02-10',
      '2026-02-11',
      '2026-02-12',
      '2026-02-13',
      '2026-02-14',
      '2026-02-15'
    ]
    const counts = countForHeader(
      [
        task({ date: '2026-02-10' }), // 逾期且在周内
        task({ date: TODAY }),
        task({ date: '2026-02-15' }), // 未来但在本周
        task({ date: '2026-03-01' }), // 下周
        task({ date: TODAY, done: true }),
        task({ date: UNSCHEDULED })
      ],
      TODAY,
      week
    )
    expect(counts.overdue).toBe(1)
    expect(counts.today).toBe(1)
    expect(counts.week).toBe(3)
  })
})

describe('carryoverLabel', () => {
  it('顺延过才提示', () => {
    expect(carryoverLabel(task({ carriedOver: 0 }))).toBeNull()
    expect(carryoverLabel(task({ carriedOver: 1 }))).toBe('已顺延 1 次')
    expect(carryoverLabel(task({ carriedOver: 3 }))).toBe('已顺延 3 次')
  })
})

describe('reschedulePatch / nextOccurrenceDate', () => {
  it('改期补丁只带日期与更新时间', () => {
    expect(reschedulePatch('2026-02-20', 'now')).toEqual({
      date: '2026-02-20',
      updatedAt: 'now'
    })
  })

  it('按周期推算下一次日期', () => {
    expect(nextOccurrenceDate('daily', TODAY)).toBe('2026-02-15')
    expect(nextOccurrenceDate('weekly', TODAY)).toBe('2026-02-21')
    expect(nextOccurrenceDate('monthly', TODAY)).toBe('2026-03-16')
    expect(nextOccurrenceDate('none', TODAY)).toBe(TODAY)
  })
})
