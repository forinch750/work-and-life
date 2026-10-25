/**
 * 月视图的网格纯逻辑（第 05 块 · 日历三档）
 *
 * **这里只有纯函数**：给定"锚点日期 + 每周从周几开始"，算出 7 列 × 5~6 行的网格。
 * 不含 React、不读 DOM、不碰数据文件 —— 所以能在 `environment: 'node'` 下直接单测
 * （`vitest` 没有 jsdom，界面行为交给端到端验收）。
 *
 * 两条必须守住的规则：
 *   1. 日期一律走 `src/shared/date.ts`（不自己拼 `YYYY-MM-DD`，不重写第二份日期逻辑）
 *   2. 补位的格子要**如实标出"不属于本月"**（`inMonth: false`），
 *      否则界面会把上个月的 31 号当成这个月的任务日
 */
import {
  addDaysToKey,
  dayOfKey,
  monthOfKey,
  monthStartKey,
  weekKeysFor,
  weekdayHeaders,
  yearOfKey,
  type WeekStart
} from '../../../shared/date'

/** 月视图**最多** 6 行（31 天的月份 + 首尾补位确实需要 6 行；能 5 行就 5 行） */
export const MONTH_GRID_MAX_ROWS = 6

/** 一格里最多列几条任务标题；超出的显示"还有 N 项…"（已定：Q3） */
export const MONTH_CELL_MAX_TASKS = 3

/** 网格里的一格 */
export interface MonthCell {
  /** YYYY-MM-DD */
  key: string
  /** 日期号（1–31） */
  day: number
  /** 是否属于当前这个月（首行/末行的补位格是 false） */
  inMonth: boolean
}

export interface MonthGrid {
  /** 网格所属的年份 */
  year: number
  /** 网格所属的月份（1–12） */
  month: number
  /** 6 行 × 7 列，行优先 */
  weeks: MonthCell[][]
  /** 这个月有多少天 */
  dayCount: number
}

/**
 * 某年某月的网格。
 *
 * 行数**最多 6 行**（`MONTH_GRID_MAX_ROWS`），能 5 行就 5 行：
 * 末行整行都是下个月的补位时把它去掉 —— 否则每个月下面都挂着一条空行，
 * 看起来像"这个月有 6 周"。5 行还是 6 行由 1 号是周几决定（由纯函数算，界面不管）。
 */
export function monthGrid(year: number, month: number, weekStart: WeekStart = 1): MonthGrid {
  const first = monthStartKey(year, month)
  // 第一格 = 包含 1 号的那一周的第一天（weekStart 偏好在这里生效）
  const firstCell = weekKeysFor(first, weekStart)[0] ?? first
  const weeks: MonthCell[][] = []
  let cursor = firstCell

  for (let row = 0; row < MONTH_GRID_MAX_ROWS; row += 1) {
    const week: MonthCell[] = []
    for (let column = 0; column < 7; column += 1) {
      const key = cursor
      const cellYear = yearOfKey(key)
      const cellMonth = monthOfKey(key)
      week.push({
        key,
        day: dayOfKey(key),
        inMonth: cellYear === year && cellMonth === month
      })
      cursor = addDaysToKey(key, 1)
    }
    weeks.push(week)
  }

  // 末行全是下个月的补位 → 去掉（保留至少一行，避免空网格）
  while (weeks.length > 1 && (weeks[weeks.length - 1] ?? []).every((cell) => !cell.inMonth)) {
    weeks.pop()
  }

  return {
    year,
    month,
    weeks,
    dayCount: weeks.flat().filter((cell) => cell.inMonth).length
  }
}

/**
 * 从"锚点日期"取月网格：翻月只改锚点，网格每次都按锚点重算。
 * 这样"看过 1 月 31 日、再翻到 2 月"这种事由 `addMonthsToKey` 负责收敛，界面不管月末。
 */
export function monthGridFor(anchorKey: string, weekStart: WeekStart = 1): MonthGrid {
  return monthGrid(yearOfKey(anchorKey), monthOfKey(anchorKey), weekStart)
}

/**
 * 表头：按 weekStart 决定列序（周一开头 / 周日开头）。
 *
 * 直接取 `date.ts` 的 `weekdayHeaders` —— 周几叫什么、列序怎么排，
 * 全项目只有那一份定义（日历里不另写，也不放日期字面量当锚点）。
 */
export function monthWeekdayHeaders(weekStart: WeekStart = 1): string[] {
  return weekdayHeaders(weekStart)
}

/**
 * 一格里最多显示几条、还剩几条。
 *
 * 单独的纯函数是为了让"还有 N 项…"的 N 与界面显示的一定相同
 * （各写一份 `slice(0, 3)` 迟早会漂）。
 */
export interface MonthCellOverflow {
  /** 真正列出来的条数 */
  shown: number
  /** 没列出来的条数；0 表示不需要显示"还有 N 项…" */
  hidden: number
  /** 是否要显示那句"还有 N 项…" */
  showMore: boolean
}

export function monthCellOverflow(total: number, max = MONTH_CELL_MAX_TASKS): MonthCellOverflow {
  const safeTotal = Math.max(0, Math.trunc(total))
  const shown = Math.min(safeTotal, Math.max(0, Math.trunc(max)))
  const hidden = safeTotal - shown
  return { shown, hidden, showMore: hidden > 0 }
}
