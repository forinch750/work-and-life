/**
 * 周视图的网格纯逻辑（第 05 块 · 日历三档）
 *
 * 三件事都在这里定死，界面只负责画：
 *   1. **列** = 一周 7 天（列序由 `weekStart` 偏好决定，走 `date.ts` 的 `weekKeysFor`）
 *   2. **行** = **完整 24 小时（00:00 ~ 23:00）**，`WEEK_HOURS.length` 恒为 24
 *   3. **任务落格规则**（§5.7）：有 `startTime` 落小时格；只有 `timeSlot` 或都没有落"全天"行
 *
 * 为什么单独抽出来：`vitest` 是 `environment: 'node'`，没有 jsdom，
 * 界面里写多少 `slice()` 都验不到；抽成纯函数就能直接钉住
 * "跨月 / 跨年 / 两种 weekStart / 24 行 / 四种落格组合"。
 */
import { weekKeysFor, type WeekStart } from '../../../shared/date'
import { isTimeOfDay, type PlanTask } from '../../../shared/plan'

/** 一行的代表：从 0 到 23，**一个都不少**（已定：Q1 完整 24 小时） */
export const WEEK_HOURS: number[] = Array.from({ length: 24 }, (_, hour) => hour)

/** 打开周视图时自动滚到的小时（不滚的话一进来看到的是半夜） */
export const WEEK_SCROLL_TO_HOUR = 8

/** 每小时行高（px）；滚动定位与渲染都用这一个常量，免得两处对不上 */
export const WEEK_HOUR_HEIGHT = 44

/** 时刻的两位标签：08:00 */
export function hourLabel(hour: number): string {
  return `${`${hour}`.padStart(2, '0')}:00`
}

/** 全部 24 个时刻标签，顺序 00:00 → 23:00 */
export function weekHourLabels(): string[] {
  return WEEK_HOURS.map((hour) => hourLabel(hour))
}

/**
 * 把 `startTime`（"HH:mm"）落到哪一行。
 *
 * 非法值一律当"没有具体时间"，落到"全天"行 —— 界面永远不该因为
 * 一条脏数据就把它画到 00:00。
 */
export function hourOfStartTime(startTime?: string): number | null {
  if (!isTimeOfDay(startTime)) return null
  const hour = Number.parseInt(startTime.slice(0, 2), 10)
  return Number.isInteger(hour) && hour >= 0 && hour <= 23 ? hour : null
}

/** 打开周视图时应当滚动到的像素位置 */
export function initialScrollTop(hourHeight = WEEK_HOUR_HEIGHT): number {
  return WEEK_SCROLL_TO_HOUR * hourHeight
}

export type SlotPlacement =
  /** 落在小时格；`hour` 是 0–23 */
  | { kind: 'hour'; hour: number }
  /** 落在顶部的"全天"行 */
  | { kind: 'allday' }

/**
 * 落格规则（§5.7 的四种组合，逐条对上）：
 *
 *   只有 timeSlot   → 全天行（显示"上午"）
 *   只有 startTime  → 对应小时格
 *   两个都有        → **优先按 startTime** 落小时格，"时段"仅作参考
 *   都没有          → 全天行
 */
export function placementOf(task: Pick<PlanTask, 'startTime' | 'endTime' | 'timeSlot'>): SlotPlacement {
  const hour = hourOfStartTime(task.startTime)
  if (hour !== null) return { kind: 'hour', hour }
  return { kind: 'allday' }
}

export interface WeekDay {
  /** YYYY-MM-DD */
  key: string
}

export interface WeekGrid {
  /** 7 天的日期键，顺序即列序 */
  days: WeekDay[]
  /** 24 个小时行 */
  hours: number[]
}

/** 给定锚点日期与 weekStart，算出这一周的 7 列与 24 行 */
export function weekGrid(anchorKey: string, weekStart: WeekStart = 1): WeekGrid {
  return {
    days: weekKeysFor(anchorKey, weekStart).map((key) => ({ key })),
    hours: [...WEEK_HOURS]
  }
}

/** 把一批任务按"哪一天、哪一行"分好 */
export interface WeekLayout {
  /** `${dateKey}|allday` 或 `${dateKey}|${hour}` → 该格里的任务 */
  cells: Map<string, PlanTask[]>
}

/** 格子的键（全天行与小时行不共用键，避免"全天"和"00:00"撞在一起） */
export function weekCellKey(dateKey: string, placement: SlotPlacement): string {
  return placement.kind === 'allday' ? `${dateKey}|allday` : `${dateKey}|${placement.hour}`
}

/**
 * 一周内的任务分格。
 *
 * `includedDates` 之外的日期一律不进网格（周视图只画这一周）；
 * 同格内按开始时间→时段→标题排序，保证每次渲染顺序一致。
 */
export function layoutWeek(tasks: PlanTask[], includedDates: string[]): WeekLayout {
  const allowed = new Set(includedDates)
  const cells = new Map<string, PlanTask[]>()
  for (const task of tasks) {
    if (!allowed.has(task.date)) continue
    const placement = placementOf(task)
    const key = weekCellKey(task.date, placement)
    const list = cells.get(key) ?? []
    list.push(task)
    cells.set(key, list)
  }
  for (const list of cells.values()) {
    list.sort((a, b) => {
      const hourA = hourOfStartTime(a.startTime)
      const hourB = hourOfStartTime(b.startTime)
      if (hourA !== null && hourB !== null && hourA !== hourB) return hourA - hourB
      if (hourA === null && hourB !== null) return -1
      if (hourA !== null && hourB === null) return 1
      const timeA = a.startTime ?? ''
      const timeB = b.startTime ?? ''
      if (timeA !== timeB) return timeA < timeB ? -1 : 1
      return a.title.localeCompare(b.title, 'zh-Hans-CN')
    })
  }
  return { cells }
}
