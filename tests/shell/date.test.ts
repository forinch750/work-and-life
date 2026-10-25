/**
 * 阶段 2 测试：日期工具
 *
 * 首页日期、计划本周视图、复习"今天到期"判定都依赖这些函数，
 * 所以先把它们的行为固定下来。
 */
import { describe, expect, it } from 'vitest'
import {
  addDays,
  addDaysToKey,
  dateKey,
  daysBetween,
  formatDateTime,
  formatFullDate,
  formatShortDate,
  fromDateKey,
  greeting,
  isSameDay,
  relativeDayLabel,
  todayKey,
  weekKeysFor,
  weekdayLabel
} from '../../src/shared/date'

describe('dateKey / fromDateKey', () => {
  it('生成补零的 YYYY-MM-DD', () => {
    expect(dateKey(new Date(2026, 1, 14))).toBe('2026-02-14')
    expect(dateKey(new Date(2026, 0, 5))).toBe('2026-01-05')
    expect(dateKey(new Date(2026, 11, 31))).toBe('2026-12-31')
  })

  it('往返一致（本地时区不漂移）', () => {
    for (const key of ['2026-01-01', '2026-02-14', '2026-12-31']) {
      expect(dateKey(fromDateKey(key))).toBe(key)
    }
  })

  it('还原出的是当天 0 点', () => {
    const date = fromDateKey('2026-02-14')
    expect(date.getHours()).toBe(0)
    expect(date.getMinutes()).toBe(0)
    expect(date.getDate()).toBe(14)
  })
})

describe('addDaysToKey / addDays', () => {
  it('跨月正确', () => {
    expect(addDaysToKey('2026-01-31', 1)).toBe('2026-02-01')
    expect(addDaysToKey('2026-02-01', -1)).toBe('2026-01-31')
  })

  it('跨年正确', () => {
    expect(addDaysToKey('2026-12-31', 1)).toBe('2027-01-01')
    expect(addDaysToKey('2027-01-01', -1)).toBe('2026-12-31')
  })

  it('闰年 2 月正确', () => {
    expect(addDaysToKey('2028-02-28', 1)).toBe('2028-02-29')
    expect(addDaysToKey('2028-02-29', 1)).toBe('2028-03-01')
  })

  it('加 0 天不变', () => {
    expect(addDaysToKey('2026-02-14', 0)).toBe('2026-02-14')
  })

  it('Date 版本与键版本一致', () => {
    const base = fromDateKey('2026-02-14')
    expect(dateKey(addDays(base, 5))).toBe(addDaysToKey('2026-02-14', 5))
  })
})

describe('daysBetween / isSameDay', () => {
  it('计算天数差', () => {
    expect(daysBetween('2026-02-14', '2026-02-15')).toBe(1)
    expect(daysBetween('2026-02-14', '2026-02-14')).toBe(0)
    expect(daysBetween('2026-02-15', '2026-02-14')).toBe(-1)
    expect(daysBetween('2026-02-14', '2026-03-16')).toBe(30)
  })

  it('同一天判定', () => {
    expect(isSameDay(new Date(2026, 1, 14, 0, 0), new Date(2026, 1, 14, 23, 59))).toBe(true)
    expect(isSameDay(new Date(2026, 1, 14), new Date(2026, 1, 15))).toBe(false)
  })
})

describe('weekKeysFor', () => {
  it('从周一开始时返回周一到周日', () => {
    // 2026-02-14 是星期六
    const week = weekKeysFor('2026-02-14', 1)
    expect(week).toHaveLength(7)
    expect(week[0]).toBe('2026-02-09') // 周一
    expect(week[6]).toBe('2026-02-15') // 周日
  })

  it('从周日开始时返回周日到周六', () => {
    const week = weekKeysFor('2026-02-14', 7)
    expect(week[0]).toBe('2026-02-08') // 周日
    expect(week[6]).toBe('2026-02-14') // 周六
  })

  it('周日当天的归属符合两种偏好', () => {
    // 2026-02-15 是星期日
    expect(weekKeysFor('2026-02-15', 1)[0]).toBe('2026-02-09')
    expect(weekKeysFor('2026-02-15', 7)[0]).toBe('2026-02-15')
  })

  it('本周一定包含传入日期', () => {
    for (const key of ['2026-01-01', '2026-02-14', '2026-06-30', '2026-12-31']) {
      expect(weekKeysFor(key, 1)).toContain(key)
      expect(weekKeysFor(key, 7)).toContain(key)
    }
  })
})

describe('显示格式', () => {
  it('完整日期带星期', () => {
    expect(formatFullDate(new Date(2026, 1, 14))).toBe('2026年2月14日 周六')
  })

  it('简短日期', () => {
    expect(formatShortDate(new Date(2026, 1, 14))).toBe('2月14日')
    expect(formatShortDate('2026-02-14')).toBe('2月14日')
  })

  it('星期标签', () => {
    expect(weekdayLabel(new Date(2026, 1, 14))).toBe('周六')
    expect(weekdayLabel(new Date(2026, 1, 15))).toBe('周日')
  })

  it('相对今天的说法', () => {
    const now = new Date(2026, 1, 14)
    expect(relativeDayLabel('2026-02-14', now)).toBe('今天')
    expect(relativeDayLabel('2026-02-15', now)).toBe('明天')
    expect(relativeDayLabel('2026-02-13', now)).toBe('昨天')
    expect(relativeDayLabel('2026-02-12', now)).toBe('前天')
    expect(relativeDayLabel('2026-02-20', now)).toBe('2月20日')
  })

  it('问候语随时段变化', () => {
    expect(greeting(new Date(2026, 1, 14, 3))).toBe('凌晨好')
    expect(greeting(new Date(2026, 1, 14, 9))).toBe('早上好')
    expect(greeting(new Date(2026, 1, 14, 15))).toBe('下午好')
    expect(greeting(new Date(2026, 1, 14, 21))).toBe('晚上好')
  })

  it('todayKey 与 dateKey(now) 一致', () => {
    const now = new Date(2026, 1, 14, 23, 59)
    expect(todayKey(now)).toBe('2026-02-14')
  })

  it('复习历史里的时间戳显示成"哪一天几点"', () => {
    // 用本地时区构造，避免测试机时区把断言弄飘
    const local = new Date(2026, 1, 14, 8, 5).toISOString()
    expect(formatDateTime(local)).toBe('2026年2月14日 周六 08:05')
    expect(formatDateTime('2026-02-14T23:30:00')).toBe('2026年2月14日 周六 23:30')
  })

  it('非法时间戳返回空串，不往界面上写 Invalid Date', () => {
    expect(formatDateTime('')).toBe('')
    expect(formatDateTime('不是时间')).toBe('')
  })
})
