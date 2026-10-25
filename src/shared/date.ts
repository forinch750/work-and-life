/**
 * 日期工具（DEVPLAN 阶段 2 起共用）
 *
 * 全部基于本地时区，不引入任何第三方日期库：
 * 这里只用到"日"粒度，自己算比引依赖更可控，也更容易测。
 */

export type WeekStart = 1 | 7

function pad(value: number): string {
  return `${value}`.padStart(2, '0')
}

/** 本地日期键：YYYY-MM-DD */
export function dateKey(date: Date): string {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

/** 从日期键还原成当天 00:00 的 Date */
export function fromDateKey(key: string): Date {
  const [year, month, day] = key.split('-').map((part) => Number.parseInt(part, 10))
  return new Date(year ?? 1970, (month ?? 1) - 1, day ?? 1)
}

export function isSameDay(a: Date, b: Date): boolean {
  return dateKey(a) === dateKey(b)
}

export function todayKey(now: Date = new Date()): string {
  return dateKey(now)
}

/** 在日期键上加减天数 */
export function addDaysToKey(key: string, days: number): string {
  const date = fromDateKey(key)
  date.setDate(date.getDate() + days)
  return dateKey(date)
}

export function addDays(date: Date, days: number): Date {
  const next = new Date(date.getTime())
  next.setDate(next.getDate() + days)
  return next
}

/** 两个日期键相差的天数（b - a） */
export function daysBetween(a: string, b: string): number {
  const start = fromDateKey(a).getTime()
  const end = fromDateKey(b).getTime()
  return Math.round((end - start) / (24 * 60 * 60 * 1000))
}

// ---------------------------------------------------------------------------
// 月 / 年粒度（日历三档用）
//
// 统一走 Date 的本地时区运算，与上面几支保持同一套口径：
// 不给调用方留"自己拼日期字符串"的余地（那样闰年与月末就会各写一份规则）。
// ---------------------------------------------------------------------------

/** 日期键的年份 */
export function yearOfKey(key: string): number {
  return fromDateKey(key).getFullYear()
}

/** 日期键的月份（1–12） */
export function monthOfKey(key: string): number {
  return fromDateKey(key).getMonth() + 1
}

/** 日期键的日期号（1–31） */
export function dayOfKey(key: string): number {
  return fromDateKey(key).getDate()
}

/**
 * 某个月有多少天。
 * `month` 取 1–12；越界会被 Date 自己进位（与 `fromDateKey` 同一套宽容策略），
 * 但月视图只喂合法值，这里不为越界单独写分支。
 */
export function daysInMonth(year: number, month: number): number {
  // 下个月的第 0 天 = 这个月的最后一天
  return new Date(year, month, 0).getDate()
}

/** 某年某月的第一天（YYYY-MM-01） */
export function monthStartKey(year: number, month: number): string {
  return dateKey(new Date(year, month - 1, 1))
}

/** 在日期键上加减月数；目标月没有这一天时收敛到月末（1 月 31 日 + 1 月 → 2 月 28/29 日） */
export function addMonthsToKey(key: string, months: number): string {
  const date = fromDateKey(key)
  const day = date.getDate()
  const year = date.getFullYear()
  // 先落到目标月的 1 号，看看这个月有多少天（Date 会自己进位，不必手算年月）
  const probe = new Date(year, date.getMonth() + months, 1)
  const lastDay = daysInMonth(probe.getFullYear(), probe.getMonth() + 1)
  return dateKey(new Date(probe.getFullYear(), probe.getMonth(), Math.min(day, lastDay)))
}

/** 在日期键上加减年数（2 月 29 日 → 平年 2 月 28 日） */
export function addYearsToKey(key: string, years: number): string {
  return addMonthsToKey(key, years * 12)
}

/** 某月的中文短标记：10月 */
export function formatMonthLabel(year: number, month: number): string {
  return `${year}年${month}月`
}

const WEEKDAY_LABELS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六']

export function weekdayLabel(date: Date): string {
  return WEEKDAY_LABELS[date.getDay()] ?? ''
}

/**
 * 一周七天的表头（已按 `weekStart` 排好列序）。
 *
 * `weekStart` 是"每周从周几开始"的偏好：1 = 周一开头，7 = 周日开头。
 * 标签只有这一份（`WEEKDAY_LABELS`），日历的表头也走它 ——
 * 否则"周几叫什么"迟早会在两个地方写出不同的字。
 */
export function weekdayHeaders(weekStart: WeekStart = 1): string[] {
  const order = weekStart === 1 ? [1, 2, 3, 4, 5, 6, 0] : [0, 1, 2, 3, 4, 5, 6]
  return order.map((index) => WEEKDAY_LABELS[index] ?? '')
}

/** 中文日期显示：2026年2月14日 星期六 */
export function formatFullDate(date: Date): string {
  return `${date.getFullYear()}年${date.getMonth() + 1}月${date.getDate()}日 ${weekdayLabel(date)}`
}

/** 简短日期显示：2月14日 */
export function formatShortDate(dateOrKey: Date | string): string {
  const date = typeof dateOrKey === 'string' ? fromDateKey(dateOrKey) : dateOrKey
  return `${date.getMonth() + 1}月${date.getDate()}日`
}

/**
 * ISO 时间戳 → `2026年2月14日 15:30`（本地时区）。
 *
 * 复习历史里存的是 `at`（ISO 字符串），界面上要显示成"哪一天几点评的"。
 * 非法/空输入返回空串——宁可这一格空着，也不要往界面上写 `Invalid Date`。
 */
export function formatDateTime(iso: string): string {
  if (typeof iso !== 'string' || iso.trim() === '') return ''
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return ''
  const pad = (value: number): string => `${value}`.padStart(2, '0')
  return `${formatFullDate(date)} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

/** 相对今天的说法：今天 / 昨天 / 明天 / 2月14日 */
export function relativeDayLabel(key: string, now: Date = new Date()): string {
  const diff = daysBetween(todayKey(now), key)
  if (diff === 0) return '今天'
  if (diff === 1) return '明天'
  if (diff === -1) return '昨天'
  if (diff === -2) return '前天'
  return formatShortDate(key)
}

/** 根据"每周从周几开始"的偏好，返回包含指定日期的那一周（7 个日期键） */
export function weekKeysFor(key: string, weekStart: WeekStart = 1): string[] {
  const date = fromDateKey(key)
  const current = date.getDay() === 0 ? 7 : date.getDay() // 1=周一 … 7=周日
  const offset = weekStart === 1 ? current - 1 : current % 7
  const start = addDays(date, -offset)
  return Array.from({ length: 7 }, (_, index) => dateKey(addDays(start, index)))
}

/** 按问候语时段返回：早上好 / 下午好 / 晚上好 */
export function greeting(now: Date = new Date()): string {
  const hour = now.getHours()
  if (hour < 6) return '凌晨好'
  if (hour < 12) return '早上好'
  if (hour < 18) return '下午好'
  return '晚上好'
}
