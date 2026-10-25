/**
 * 年视图的网格纯逻辑（第 05 块 · 日历三档）
 *
 * 年视图 = 4 列 × 3 行 = **恒为 12 个月**，每个月显示**两个数**：
 *   1. 该月任务数（"N 项"）
 *   2. 完成率（进度条 = 完成率，绿色）
 *
 * ⚠️ 两个数是**脱钩**的（已定 Q4）：10 月任务最多但完成率可能只有一半，
 * 进度条只走一半 —— 这是刻意的，看的是"这个月做完了几成"。
 */
import { monthOfKey, monthStartKey, yearOfKey } from '../../../shared/date'
import { UNSCHEDULED, type PlanTask } from '../../../shared/plan'

/** 一年恒为 12 个月 */
export const YEAR_MONTHS: number[] = Array.from({ length: 12 }, (_, index) => index + 1)

/** 年视图的列数（4 列 × 3 行） */
export const YEAR_COLUMNS = 4

export interface YearMonthCell {
  /** 1–12 */
  month: number
  /** 该月第一天的日期键（点它跳到那个月的月视图时用得着） */
  startKey: string
  /** 该月任务数 */
  total: number
  /** 该月已完成数 */
  done: number
  /** 完成率 0–100（整数百分比）；没有任务时为 0 */
  rate: number
}

/**
 * 某个月的任务数 / 完成数 / 完成率。
 *
 * "任务数"按**排期在这个月**算；"待安排"（`UNSCHEDULED`）不属于任何一个月，
 * 所以不参与 —— 否则每个月的数字都会凭空多出同一批待安排任务。
 *
 * **放弃的任务整条跳过（分子与分母都不算）**（修改 4 轮 §7.2 第 3 条）。
 * 这一条最容易做漏：只把放弃的从 `done` 分子里排掉、却没从 `total` 分母里排，
 * 完成率会**下降**（"我放弃了 5 项，完成率反而掉了"），与"彻底退出统计"直接矛盾。
 * 端到端 `P8-Z6` 就是专门守它的。
 */
export function monthTaskStats(
  tasks: PlanTask[],
  year: number,
  month: number
): { total: number; done: number; rate: number } {
  let total = 0
  let done = 0
  for (const task of tasks) {
    if (task.abandoned === true) continue
    if (task.date === UNSCHEDULED || task.date === '') continue
    if (yearOfKey(task.date) !== year || monthOfKey(task.date) !== month) continue
    total += 1
    if (task.done) done += 1
  }
  return { total, done, rate: completionRate(done, total) }
}

/** 完成率（整数百分比）：0/0 记 0%，其余四舍五入 */
export function completionRate(done: number, total: number): number {
  if (total <= 0) return 0
  const safeDone = Math.min(Math.max(0, Math.trunc(done)), Math.trunc(total))
  return Math.round((safeDone / Math.trunc(total)) * 100)
}

/** 整年的 12 个月 */
export function yearGrid(tasks: PlanTask[], year: number): YearMonthCell[] {
  return YEAR_MONTHS.map((month) => {
    const stats = monthTaskStats(tasks, year, month)
    return {
      month,
      startKey: monthStartKey(year, month),
      total: stats.total,
      done: stats.done,
      rate: stats.rate
    }
  })
}

/** 从锚点日期取年视图 */
export function yearGridFor(tasks: PlanTask[], anchorKey: string): { year: number; months: YearMonthCell[] } {
  const year = yearOfKey(anchorKey)
  return { year, months: yearGrid(tasks, year) }
}
