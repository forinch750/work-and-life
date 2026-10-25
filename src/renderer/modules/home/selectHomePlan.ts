/**
 * 首页今日计划的取数规则（DEVPLAN 阶段 4 / PRD §3；修改 6 轮改成"只今天"）
 *
 * 单独成文件（而不是写在 HomePage.tsx 里）的理由：
 * 这是纯逻辑，可以被单元测试直接覆盖，不需要 JSX 环境。
 *
 * ## 修改 6 轮：清单**只含今天的任务**
 *
 * 用户原话：「今日计划不要显示昨天的计划（未移动）」。
 * 旧口径故意把逾期排在今天前面（"与计划页一致"），于是首页「今日计划」里
 * 会混进带「昨天」标签的任务——用户不要这个。
 *
 * 现在逾期**完全不进**这份清单，它们的去处是「需要你的关注」里那张
 * `逾期未完成` 关注卡（PRD §3 规定的固定三张卡之一，**不许删**）。
 *
 * ## 修改 7 轮：标了「未完成」的也**不出现**在首页
 *
 * 就算它的日期正好是今天也不出现（`修改-7.md` §三 那张表第 4 行）。
 * 被标记的任务只在计划页「全部」视图的「**已标未完成（N）**」组里看得见。
 */
import type { RecordEnvelope } from '../../../shared/types'
import { isHeld, normalizePlanTask, type PlanTask } from '../../../shared/plan'
import { groupForToday } from '../../../shared/planLogic'

/** 首页今日计划最多显示几项 */
export const HOME_TODAY_LIMIT = 3

export interface HomePlanSelection {
  /** 首页要显示的条目（**只含今天**） */
  visible: PlanTask[]
  /** 被收起的条数（用于"还有 N 项"，按**今天**的条数算） */
  hiddenCount: number
  /**
   * 逾期的条数。
   *
   * ⚠️ 它**不在** `visible` 里（修改 6 轮）：首页今日计划只列今天安排的，
   * 逾期归「需要你的关注」那张 `逾期未完成` 卡。这个字段只给调试/关注卡核对用。
   */
  overdue: number
}

/** 把原始记录规范成任务列表（过滤软删除与脏数据） */
export function toTaskList(records: RecordEnvelope[]): PlanTask[] {
  return records
    .filter((record) => record.deletedAt === undefined || record.deletedAt === null)
    .map((record: RecordEnvelope) => normalizePlanTask(record as unknown as Record<string, unknown>))
    .filter((task: PlanTask) => task.id !== '' && task.title !== '')
}

/**
 * 从原始记录算出首页今日计划。
 *
 * **只取"今天"那一组**（修改 6 轮）：逾期一条都不进来，
 * 所以 `visible` / `hiddenCount` 都按今天的条数算。
 *
 * **手动标了「未完成」的一条也不进**（修改 7 轮）：哪怕它的日期就是今天。
 * 分组那边已经把 `held` 拆进单独一组了，这里再显式挡一道 —— 这条口径
 * 用户确认过两次（首页「今日计划」不出现它），别让它从分组改动里漏回来。
 */
export function selectHomePlan(
  records: RecordEnvelope[],
  todayKey: string,
  limit = HOME_TODAY_LIMIT
): HomePlanSelection {
  const groups = groupForToday(toTaskList(records), todayKey)
  const all = groups.today.filter((task) => !isHeld(task))
  return {
    visible: all.slice(0, limit),
    hiddenCount: Math.max(0, all.length - limit),
    // 逾期数与「关注卡 / 页头 / 红点」同一个口径：`groups.overdue` 已排除 held
    // （页头「逾期 N 项」看 `countForHeader`，"今天 / 本周"那两个数仍含 held）
    overdue: groups.overdue.length
  }
}
