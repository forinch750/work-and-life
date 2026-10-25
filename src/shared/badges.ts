/**
 * 导航角标数据（DEVPLAN 阶段 5 / PRD §2.2；第 10 块抽到共享层）
 *
 * 只给"复习"数字角标（今日到期张数）与"计划"红点（有逾期任务），
 * 其它模块一律不加，避免界面到处是提醒。
 *
 * ## 为什么从 `renderer\shell\badges.tsx` 搬到 `shared\`
 *
 * 第 10 块要钉一条不变量：**导航角标 = 复习页汇总横条的总数**。
 * 角标的算法若只藏在 `.tsx` 里，单测（`environment: 'node'`，不引 jsdom）
 * 就只能"照抄一遍"再比对——那等于自己证明自己。
 * 搬成纯函数以后，单测能**真的调它**，与复习页的 `dueTotalOf()` 对同一个数。
 *
 * 界面那一半（Context / Provider）仍留在 `renderer\shell\badges.tsx`，
 * 它只负责把这里算出来的东西发下去。
 */
import { normalizePlanTask } from './plan'
import { countsAsOverdue } from './planLogic'
import { dueQueue, normalizeReviewCard, type ReviewCard } from './review'

export interface BadgeState {
  /** 今日到期复习张数 */
  reviewDue: number
  /** 计划里是否有逾期任务（**不含**手动标了「未完成」的，见修改 7 轮） */
  planOverdue: boolean
}

export const EMPTY_BADGES: BadgeState = { reviewDue: 0, planOverdue: false }

/** 从原始记录算出角标状态（纯函数，便于单测） */
export function computeBadges(
  planRecords: Array<Record<string, unknown>>,
  reviewRecords: Array<Record<string, unknown>>,
  todayKey: string
): BadgeState {
  const cards = reviewRecords
    .filter((record) => record['deletedAt'] === undefined || record['deletedAt'] === null)
    .map((record) => normalizeReviewCard(record))
    .filter((card): card is ReviewCard => card !== null && card.front !== '')

  const tasks = planRecords
    .filter((record) => record['deletedAt'] === undefined || record['deletedAt'] === null)
    .map((record) => normalizePlanTask(record))
    .filter((task) => task.id !== '' && task.title !== '')

  return {
    reviewDue: dueQueue(cards, todayKey).length,
    /**
     * 修改 7 轮：红点改用 **统计口径**（`countsAsOverdue`）。
     *
     * 用户原话：「标记未完成不显示逾期。」——手动标了「未完成」的任务不再催，
     * 所以只有它的时候导航「计划」**不该**亮红点。
     * 这与页头「逾期 N 项」、首页关注卡、日历逾期色是同一个口径（一处定义、四处受益）。
     */
    planOverdue: tasks.some((task) => countsAsOverdue(task, todayKey))
  }
}
