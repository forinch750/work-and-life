/**
 * 日历上任务条的"状态色"（修改 7 轮从 `CalendarPage.tsx` 抽出来的纯逻辑）
 *
 * 为什么要单独一个文件：`vitest` 是 `environment: 'node'`（没有 jsdom），
 * `.tsx` 里的函数测不到。而"标了「未完成」的日历任务**不能**标成逾期红"
 * 是 `修改-7.md` §六 明确要求**单测**钉住的一条，只能把它搬到纯 `.ts` 里。
 *
 * 三档：
 *   - `done`    已完成 → 绿
 *   - `overdue` **计入逾期的**（`countsAsOverdue`）→ 红
 *   - `todo`    其余（**包括**手动标了「未完成」的）→ 蓝
 *
 * ⚠️ 这里必须用 `countsAsOverdue` 而**不是** `isOverdue`：
 * 用户原话「标记未完成不显示逾期」——被标记的任务在日历上**照旧画出来**
 * （日期不变，`修改-7.md` §三），只是不再标成逾期红。
 * 若这里用 `isOverdue`，日历上它仍是红的，等于口径只改了一半。
 */
import type { PlanTask } from '../../../shared/plan'
import { countsAsOverdue } from '../../../shared/planLogic'

/** 任务条的状态：待办=蓝 / 已完成=绿 / 逾期=红 */
export type BarState = 'todo' | 'done' | 'overdue'

export function barStateOf(task: PlanTask, todayKey: string): BarState {
  if (task.done) return 'done'
  if (countsAsOverdue(task, todayKey)) return 'overdue'
  return 'todo'
}
