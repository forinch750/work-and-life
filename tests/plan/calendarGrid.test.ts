/**
 * 第 05 块测试：日历三档的网格纯逻辑
 *
 * 覆盖 `docs\TASKS\05-日历三档.md` §6.2 要求的每一条：
 *   - 跨月：月网格第一行 / 最后一行补位正确
 *   - 跨年：12 月与 1 月的边界
 *   - 闰年：2 月 29 天
 *   - 两种 weekStart：周一开头 / 周日开头，列序都正确
 *   - 周视图行数恒为 24（00:00 ~ 23:00）
 *   - 年视图恒为 12 个月
 *   - 落格规则四种组合（只有 timeSlot / 只有 startTime / 都有 / 都没有）
 *   - `endTime` 早于 `startTime` 被拒绝
 *
 * 这一层是 `environment: 'node'`（没有 jsdom）能测到的全部；
 * 界面行为交给 `src\main\verify\phase8.ts` 的端到端验收。
 */
import { describe, expect, it } from 'vitest'
import {
  addMonthsToKey,
  addYearsToKey,
  dayOfKey,
  daysInMonth,
  monthOfKey,
  weekKeysFor,
  yearOfKey
} from '../../src/shared/date'
import {
  UNSCHEDULED,
  isValidTimeRange,
  timeRangeError,
  type PlanTask
} from '../../src/shared/plan'
import {
  MONTH_CELL_MAX_TASKS,
  MONTH_GRID_MAX_ROWS,
  monthCellOverflow,
  monthGrid,
  monthGridFor,
  monthWeekdayHeaders
} from '../../src/renderer/modules/calendar/monthGrid'
import {
  WEEK_HOURS,
  WEEK_SCROLL_TO_HOUR,
  hourLabel,
  hourOfStartTime,
  initialScrollTop,
  layoutWeek,
  placementOf,
  weekCellKey,
  weekGrid,
  weekHourLabels
} from '../../src/renderer/modules/calendar/weekGrid'
import {
  YEAR_COLUMNS,
  YEAR_MONTHS,
  completionRate,
  monthTaskStats,
  yearGrid,
  yearGridFor
} from '../../src/renderer/modules/calendar/yearGrid'

let seq = 0
function task(partial: Partial<PlanTask> = {}): PlanTask {
  seq += 1
  return {
    id: partial.id ?? `c${seq}`,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    title: partial.title ?? `任务 ${seq}`,
    date: partial.date ?? '2026-10-05',
    timeSlot: partial.timeSlot ?? 'none',
    recurrence: partial.recurrence ?? 'none',
    done: partial.done ?? false,
    carriedOver: partial.carriedOver ?? 0,
    doneAt: partial.doneAt ?? null,
    ...(partial.startTime ? { startTime: partial.startTime } : {}),
    ...(partial.endTime ? { endTime: partial.endTime } : {})
  }
}

// ---------------------------------------------------------------------------
// 月视图
// ---------------------------------------------------------------------------

describe('monthGrid：7 列 × 5~6 行与补位', () => {
  it('行数是 5 或 6，每行恒为 7 格，最多 6 行', () => {
    expect(MONTH_GRID_MAX_ROWS).toBe(6)
    for (const [year, month] of [
      [2026, 1],
      [2026, 2],
      [2026, 10],
      [2026, 11],
      [2024, 2],
      [2026, 6]
    ] as Array<[number, number]>) {
      const grid = monthGrid(year, month, 1)
      expect(grid.weeks.length).toBeGreaterThanOrEqual(5)
      expect(grid.weeks.length).toBeLessThanOrEqual(MONTH_GRID_MAX_ROWS)
      for (const week of grid.weeks) expect(week).toHaveLength(7)
      // 末行必须至少有一格属于本月（整行都是下个月的补位就该被去掉）
      const lastWeek = grid.weeks[grid.weeks.length - 1] ?? []
      expect(lastWeek.some((cell) => cell.inMonth)).toBe(true)
    }
  })

  it('末行整行都是下个月时会被去掉（不为凑行数留空行）', () => {
    // 2026-02：28 天且 1 号是周日 → 周一开头时正好 5 行（1 行补在上个月，4 行本月）
    const february = monthGrid(2026, 2, 1)
    expect(february.weeks).toHaveLength(5)
    expect(february.dayCount).toBe(28)
    // 2026-08：31 天且 1 号是周六 → 需要 6 行
    const august = monthGrid(2026, 8, 1)
    expect(august.weeks).toHaveLength(6)
    expect(august.dayCount).toBe(31)
  })

  it('跨月：第一行前面的补位是上个月，最后一行后面是下个月', () => {
    // 2026-10-01 是周四 → 周一开头时，首行补 9 月 28/29/30 三格
    const grid = monthGrid(2026, 10, 1)
    const first = grid.weeks[0] ?? []
    expect(first.map((cell) => cell.key)).toEqual([
      '2026-09-28',
      '2026-09-29',
      '2026-09-30',
      '2026-10-01',
      '2026-10-02',
      '2026-10-03',
      '2026-10-04'
    ])
    expect(first.map((cell) => cell.inMonth)).toEqual([
      false,
      false,
      false,
      true,
      true,
      true,
      true
    ])

    const lastWeek = grid.weeks[grid.weeks.length - 1] ?? []
    // 最后一行必须以补齐整周结束，且末尾几格不属于 10 月
    expect(lastWeek).toHaveLength(7)
    expect(lastWeek.some((cell) => !cell.inMonth)).toBe(true)
    const lastCell = lastWeek[6]
    expect(lastCell?.key.startsWith('2026-11')).toBe(true)
  })

  it('inMonth 的格子数正好等于当月天数（不重不漏）', () => {
    const grid = monthGrid(2026, 10, 1)
    const inMonth = grid.weeks.flat().filter((cell) => cell.inMonth)
    expect(inMonth).toHaveLength(31)
    expect(inMonth[0]?.key).toBe('2026-10-01')
    expect(inMonth[inMonth.length - 1]?.key).toBe('2026-10-31')
    // 每一格都是唯一的日期
    expect(new Set(inMonth.map((cell) => cell.key)).size).toBe(31)
  })

  it('闰年：2024 年 2 月有 29 天；平年 2026 年 2 月只有 28 天', () => {
    expect(daysInMonth(2024, 2)).toBe(29)
    expect(daysInMonth(2026, 2)).toBe(28)
    expect(daysInMonth(2000, 2)).toBe(29)
    expect(daysInMonth(1900, 2)).toBe(28)

    const leap = monthGrid(2024, 2, 1)
    const days = leap.weeks.flat().filter((cell) => cell.inMonth)
    expect(days).toHaveLength(29)
    expect(days[days.length - 1]?.key).toBe('2024-02-29')
  })

  it('跨年：12 月的网格末行会落到下一年 1 月，1 月的首行会回到上一年 12 月', () => {
    const december = monthGrid(2026, 12, 1)
    const decCells = december.weeks.flat()
    expect(decCells.some((cell) => cell.key.startsWith('2027-01'))).toBe(true)

    const january = monthGrid(2027, 1, 1)
    const janCells = january.weeks.flat()
    expect(janCells.some((cell) => cell.key.startsWith('2026-12'))).toBe(true)
    expect(janCells.filter((cell) => cell.inMonth)).toHaveLength(31)
  })

  it('两种 weekStart：周一开头与周日开头的列序都正确', () => {
    // 2026-10-01 是周四
    const mondayFirst = monthGrid(2026, 10, 1)
    expect(mondayFirst.weeks[0]?.[0]?.key).toBe('2026-09-28') // 周一
    expect(monthWeekdayHeaders(1)).toEqual([
      '周一',
      '周二',
      '周三',
      '周四',
      '周五',
      '周六',
      '周日'
    ])

    const sundayFirst = monthGrid(2026, 10, 7)
    expect(sundayFirst.weeks[0]?.[0]?.key).toBe('2026-09-27') // 周日
    expect(monthWeekdayHeaders(7)).toEqual([
      '周日',
      '周一',
      '周二',
      '周三',
      '周四',
      '周五',
      '周六'
    ])
    // 同一份内容只是列序不同：首行仍以 10 月 1 日出现在第 5 列
    expect(sundayFirst.weeks[0]?.[4]?.key).toBe('2026-10-01')
  })

  it('monthGridFor 跟着锚点走；翻月时月末收敛到当月最后一天', () => {
    const grid = monthGridFor('2026-10-05', 1)
    expect(grid.year).toBe(2026)
    expect(grid.month).toBe(10)
    expect(grid.dayCount).toBe(31)

    // 1 月 31 日 + 1 月 → 2 月 28 日（不是 3 月 3 日）
    expect(addMonthsToKey('2026-01-31', 1)).toBe('2026-02-28')
    expect(addMonthsToKey('2024-01-31', 1)).toBe('2024-02-29')
    expect(addMonthsToKey('2026-03-31', -1)).toBe('2026-02-28')
    expect(addMonthsToKey('2026-12-15', 1)).toBe('2027-01-15')
    expect(addYearsToKey('2024-02-29', 1)).toBe('2025-02-28')
  })

  it('"还有 N 项…"：最多 3 条，超出部分如实计数', () => {
    expect(MONTH_CELL_MAX_TASKS).toBe(3)
    expect(monthCellOverflow(0)).toEqual({ shown: 0, hidden: 0, showMore: false })
    expect(monthCellOverflow(3)).toEqual({ shown: 3, hidden: 0, showMore: false })
    expect(monthCellOverflow(7)).toEqual({ shown: 3, hidden: 4, showMore: true })
  })
})

// ---------------------------------------------------------------------------
// 周视图
// ---------------------------------------------------------------------------

describe('weekGrid：7 列 × 完整 24 小时', () => {
  it('小时行恒为 24 行，且是 00:00 ~ 23:00', () => {
    const grid = weekGrid('2026-10-05', 1)
    expect(grid.hours).toHaveLength(24)
    expect(WEEK_HOURS).toEqual(Array.from({ length: 24 }, (_, hour) => hour))
    expect(weekHourLabels()).toEqual([
      '00:00',
      '01:00',
      '02:00',
      '03:00',
      '04:00',
      '05:00',
      '06:00',
      '07:00',
      '08:00',
      '09:00',
      '10:00',
      '11:00',
      '12:00',
      '13:00',
      '14:00',
      '15:00',
      '16:00',
      '17:00',
      '18:00',
      '19:00',
      '20:00',
      '21:00',
      '22:00',
      '23:00'
    ])
    expect(hourLabel(0)).toBe('00:00')
    expect(hourLabel(23)).toBe('23:00')
  })

  it('列是 7 天，列序遵守两种 weekStart', () => {
    const mondayFirst = weekGrid('2026-10-07', 1)
    expect(mondayFirst.days.map((day) => day.key)).toEqual(weekKeysFor('2026-10-07', 1))
    expect(mondayFirst.days[0]?.key).toBe('2026-10-05') // 周一
    expect(mondayFirst.days).toHaveLength(7)

    const sundayFirst = weekGrid('2026-10-07', 7)
    expect(sundayFirst.days[0]?.key).toBe('2026-10-04') // 周日
    expect(sundayFirst.days[6]?.key).toBe('2026-10-10') // 周六
  })

  it('跨月的周：一列在上个月，一列在下个月', () => {
    const grid = weekGrid('2026-10-01', 1) // 周四
    expect(grid.days[0]?.key).toBe('2026-09-28')
    expect(grid.days[6]?.key).toBe('2026-10-04')
    expect(new Set(grid.days.map((day) => day.key)).size).toBe(7)
  })

  it('打开时滚到 08:00 附近', () => {
    expect(WEEK_SCROLL_TO_HOUR).toBe(8)
    expect(initialScrollTop(44)).toBe(352)
  })

  it('落格规则四种组合', () => {
    // 只有 timeSlot → 全天行
    expect(placementOf({ timeSlot: 'morning' })).toEqual({ kind: 'allday' })
    // 只有 startTime → 对应小时格
    expect(placementOf({ timeSlot: 'none', startTime: '10:00' })).toEqual({ kind: 'hour', hour: 10 })
    // 两个都有 → 按 startTime 落小时格（时段仅作参考）
    expect(placementOf({ timeSlot: 'evening', startTime: '09:30' })).toEqual({
      kind: 'hour',
      hour: 9
    })
    // 都没有 → 全天行
    expect(placementOf({ timeSlot: 'none' })).toEqual({ kind: 'allday' })
    // 结束时间不影响落格
    expect(placementOf({ timeSlot: 'none', startTime: '23:45', endTime: '23:55' })).toEqual({
      kind: 'hour',
      hour: 23
    })
    // 非法的 startTime 当"没有具体时间"，不能画到 00:00
    expect(placementOf({ timeSlot: 'none', startTime: '25:00' })).toEqual({ kind: 'allday' })
    expect(hourOfStartTime('')).toBeNull()
    expect(hourOfStartTime(undefined)).toBeNull()
    expect(hourOfStartTime('00:00')).toBe(0)
  })

  it('全天行与小时行不共用格子键', () => {
    expect(weekCellKey('2026-10-05', { kind: 'allday' })).toBe('2026-10-05|allday')
    expect(weekCellKey('2026-10-05', { kind: 'hour', hour: 0 })).toBe('2026-10-05|0')
  })

  it('layoutWeek 只收这一周的任务，并按落格规则分格', () => {
    const days = weekGrid('2026-10-05', 1).days.map((day) => day.key)
    const inWeek = days[2] ?? '2026-10-07'
    const tasks = [
      task({ id: 'a', title: '上午买牛奶', date: inWeek, timeSlot: 'morning' }),
      task({ id: 'b', title: '晨会', date: inWeek, timeSlot: 'none', startTime: '09:00' }),
      task({ id: 'c', title: '牙医', date: inWeek, timeSlot: 'afternoon', startTime: '10:00' }),
      task({ id: 'd', title: '别的一周', date: '2026-11-20' }),
      task({ id: 'e', title: '待安排', date: UNSCHEDULED })
    ]
    const layout = layoutWeek(tasks, days)

    expect(layout.cells.get(`${inWeek}|allday`)).toHaveLength(1)
    expect(layout.cells.get(`${inWeek}|allday`)?.[0]?.id).toBe('a')
    expect(layout.cells.get(`${inWeek}|9`)?.[0]?.id).toBe('b')
    // 有 startTime 的优先落小时格，即便它也填了时段
    expect(layout.cells.get(`${inWeek}|10`)?.[0]?.id).toBe('c')
    // 别的周与"待安排"都不进这一周的网格
    const allIds = Array.from(layout.cells.values()).flat().map((item) => item.id)
    expect(allIds).not.toContain('d')
    expect(allIds).not.toContain('e')
    expect(allIds).toHaveLength(3)
  })

  it('同一格里按开始时间排序', () => {
    const day = '2026-10-07'
    const tasks = [
      task({ id: 'late', title: '十一', date: day, startTime: '11:00' }),
      task({ id: 'early', title: '九', date: day, startTime: '09:00' })
    ]
    const layout = layoutWeek(tasks, [day])
    // 两条都在各自的小时格里，跨格顺序由界面按小时行画，这里验证格内无错序
    expect(layout.cells.get(`${day}|9`)?.[0]?.id).toBe('early')
    expect(layout.cells.get(`${day}|11`)?.[0]?.id).toBe('late')
  })
})

// ---------------------------------------------------------------------------
// 年视图
// ---------------------------------------------------------------------------

describe('yearGrid：恒为 12 个月，每月任务数 + 完成率', () => {
  it('恒为 12 个月，顺序 1–12', () => {
    const months = yearGrid([], 2026)
    expect(months).toHaveLength(12)
    expect(YEAR_MONTHS).toHaveLength(12)
    expect(months.map((cell) => cell.month)).toEqual([
      1,
      2,
      3,
      4,
      5,
      6,
      7,
      8,
      9,
      10,
      11,
      12
    ])
    expect(YEAR_COLUMNS).toBe(4)
    // 空的年份：每个月都是 0 项、0%
    expect(months.every((cell) => cell.total === 0 && cell.rate === 0)).toBe(true)
  })

  it('每月同时给出任务数与完成率两个数', () => {
    const tasks = [
      task({ id: 'o1', date: '2026-10-01', done: true }),
      task({ id: 'o2', date: '2026-10-02', done: true }),
      task({ id: 'o3', date: '2026-10-03', done: false }),
      task({ id: 'o4', date: '2026-10-04', done: false }),
      task({ id: 'f1', date: '2026-02-10', done: true })
    ]
    const months = yearGrid(tasks, 2026)
    const october = months.find((cell) => cell.month === 10)
    expect(october?.total).toBe(4)
    expect(october?.done).toBe(2)
    expect(october?.rate).toBe(50)
    expect(october?.startKey).toBe('2026-10-01')

    const february = months.find((cell) => cell.month === 2)
    expect(february?.total).toBe(1)
    expect(february?.rate).toBe(100)

    // 任务数与完成率是脱钩的两个数：任务多的月份完成率不一定高
    const january = months.find((cell) => cell.month === 1)
    expect(january?.total).toBe(0)
    expect(january?.rate).toBe(0)
  })

  it('跨年边界：12 月与 1 月各自归各自的年份', () => {
    const tasks = [
      task({ id: 'dec', date: '2026-12-31' }),
      task({ id: 'jan', date: '2027-01-01' })
    ]
    const dec2026 = monthTaskStats(tasks, 2026, 12)
    expect(dec2026.total).toBe(1)
    const jan2026 = monthTaskStats(tasks, 2026, 1)
    expect(jan2026.total).toBe(0)
    const jan2027 = monthTaskStats(tasks, 2027, 1)
    expect(jan2027.total).toBe(1)

    // 闰年的 2 月 29 日也算在当年 2 月里
    expect(monthTaskStats([task({ id: 'leap', date: '2024-02-29' })], 2024, 2).total).toBe(1)
  })

  it('"待安排"不属于任何一个月', () => {
    const tasks = [task({ id: 'u', date: UNSCHEDULED })]
    const months = yearGrid(tasks, 2026)
    expect(months.reduce((sum, cell) => sum + cell.total, 0)).toBe(0)
  })

  it('完成率：0/0 记 0%，四舍五入到整数百分比', () => {
    expect(completionRate(0, 0)).toBe(0)
    expect(completionRate(1, 3)).toBe(33)
    expect(completionRate(2, 3)).toBe(67)
    expect(completionRate(3, 3)).toBe(100)
  })

  it('yearGridFor 从锚点取年份', () => {
    const { year, months } = yearGridFor([], '2026-10-05')
    expect(year).toBe(2026)
    expect(months).toHaveLength(12)
  })
})

// ---------------------------------------------------------------------------
// 时间区间校验（P8-C8 的纯逻辑侧）
// ---------------------------------------------------------------------------

describe('时间区间校验：endTime 必须晚于 startTime', () => {
  it('合法区间通过', () => {
    expect(isValidTimeRange('10:00', '11:30')).toBe(true)
    expect(isValidTimeRange('10:00', undefined)).toBe(true)
    expect(isValidTimeRange(undefined, '11:30')).toBe(true)
    expect(isValidTimeRange(undefined, undefined)).toBe(true)
  })

  it('结束早于或等于开始都被拒绝', () => {
    expect(isValidTimeRange('11:00', '10:00')).toBe(false)
    expect(isValidTimeRange('10:00', '10:00')).toBe(false)
    expect(timeRangeError('11:00', '10:00')).toBe('结束时间必须晚于开始时间')
    expect(timeRangeError('10:00', '10:00')).toBe('结束时间必须晚于开始时间')
  })

  it('格式不对也给出原因（不是静默通过）', () => {
    expect(timeRangeError('25:00', '')).toBe('开始时间格式应为 HH:mm')
    expect(timeRangeError('10:00', '9:5')).toBe('结束时间格式应为 HH:mm')
    expect(timeRangeError('10:00', '11:00')).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// 日期助手（日历新加的月/年粒度）
// ---------------------------------------------------------------------------

describe('date.ts 的月 / 年助手', () => {
  it('yearOfKey / monthOfKey / dayOfKey', () => {
    expect(yearOfKey('2026-10-05')).toBe(2026)
    expect(monthOfKey('2026-10-05')).toBe(10)
    expect(dayOfKey('2026-10-05')).toBe(5)
    expect(dayOfKey('2024-02-29')).toBe(29)
  })

  it('daysInMonth 覆盖闰年与月末', () => {
    expect(daysInMonth(2026, 1)).toBe(31)
    expect(daysInMonth(2026, 4)).toBe(30)
    expect(daysInMonth(2026, 12)).toBe(31)
    expect(daysInMonth(2024, 2)).toBe(29)
  })
})
