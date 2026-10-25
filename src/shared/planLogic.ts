/**
 * 计划模块的纯逻辑（DEVPLAN 阶段 4）
 *
 * 放在这里的都是"能脱离界面单独验证"的规则：
 *   1. 逾期判定
 *   2. 未完成自动顺延（PRD §5.2 关键规则①）
 *   3. 重复任务的展开（关键规则④的配套）
 *   4. 排序与分组
 */
import { addDaysToKey, daysBetween } from './date'
import {
  UNSCHEDULED,
  isAbandoned,
  isHeld,
  isMoveEligible,
  timeSlotWeight,
  type PlanTask,
  type RecurrenceType
} from './plan'

/**
 * 任务是否逾期：有排期、未完成、日期早于今天。
 *
 * **放弃的任务永不算逾期**（修改 4 轮·决定 2）。用户说的是"别再拿它算逾期"，
 * 所以这里直接早退——而不是让各调用方各自再过滤一遍。
 *
 * ## ⚠️ 这是「显示口径」，不是「统计口径」（修改 7 轮把两者拆开）
 *
 * 手动标了「未完成」（`held`）的任务**在这里仍然算逾期**（`修改-7.md` §四）。
 * 它只是"别催我、也别搬我"，不是"我不做这件事"：
 *
 *   - `isOverdue` = **显示口径**：日期过了还没做就落在「逾期」那一组里
 *     ——`held` 也算，否则它既不是"逾期"也不是"今天"，会从「今天」视图里**凭空消失**
 *   - `countsAsOverdue` = **统计口径**：页头数字 / 导航红点 / 首页关注卡 /
 *     日历逾期色都读它，`held` 不在里面（用户：「标记未完成不显示逾期」）
 *
 * **改这个函数之前先看 `修改-7.md` §五**：它一个字都不许改。
 */
export function isOverdue(task: PlanTask, todayKey: string): boolean {
  if (isAbandoned(task)) return false
  if (task.done) return false
  if (task.date === UNSCHEDULED) return false
  return daysBetween(task.date, todayKey) > 0
}

/**
 * 是否计入"逾期"的**统计与提醒**（页头数字 / 导航红点 / 首页关注卡 / 日历逾期色）。
 *
 * 修改 7 轮新增。用户原话：「标记未完成不显示逾期。」
 *
 * 与 `isOverdue` 的分工（**别合并成一个**）：
 *   - `isOverdue` = **显示口径**：日期过了还没做就显示在「逾期」那一组里（`held` 也算）
 *   - `countsAsOverdue` = **统计口径**：`held`（用户手动标了"未完成"）不再催
 *
 * 分成两个而不是改一个，是因为直接用 `isOverdue` 的地方既有"分组"也有"计数"；
 * 只改一个会让被标记的任务从列表里消失（`修改-7.md` §四）。
 *
 * ⚠️ **但它仍然算「今天 / 本周」的统计数字与完成率分母**：那是用户第三次确认的
 * 边界（"数字仍算，只是不显示"）。这个标记存在的目的就是让执行率真实反映
 * "我确实没做完"——把它从分母排掉等于把执行率算高（见 `P8-T5`）。
 */
export function countsAsOverdue(task: PlanTask, todayKey: string): boolean {
  return isOverdue(task, todayKey) && !isHeld(task)
}

/** 任务是否属于今天 */
export function isToday(task: PlanTask, todayKey: string): boolean {
  return task.date === todayKey
}

export interface CarryoverResult {
  /** 需要顺延的任务（原样返回，由调用方决定怎么写回） */
  moved: Array<{ id: string; from: string; to: string; carriedOver: number }>
}

/**
 * 计算需要顺延的任务。
 *
 * 规则：
 *   - 只看"已排期、未完成、日期早于今天"的任务
 *   - **放弃的任务不参与顺延**（修改 4 轮·决定 2）：用户放弃这件事了，
 *     就不该第二天自己跑回"今天"，否则"放弃"等于无效
 *   - 重复任务不参与顺延：它自己会按周期重新出现，顺延会把昨天的实例搬到今天，造成重复
 *   - "待安排"的任务不参与顺延
 *   - 顺延次数逐次累加
 */
export function computeCarryover(tasks: PlanTask[], todayKey: string): CarryoverResult {
  const moved: CarryoverResult['moved'] = []
  for (const task of tasks) {
    if (isAbandoned(task)) continue
    if (task.done) continue
    if (task.recurrence !== 'none') continue
    if (task.date === UNSCHEDULED) continue
    if (daysBetween(task.date, todayKey) <= 0) continue
    moved.push({
      id: task.id,
      from: task.date,
      to: todayKey,
      carriedOver: task.carriedOver + 1
    })
  }
  return { moved }
}

// ===========================================================================
// 「把某一天没做完的移到另一天」（修改 5 轮 · `修改-5.md` §6.3）
//
// 用户原话：「我要把**某一天**未完成的移动到**指定的某一天**。」
//
// 与上面那个 `computeCarryover` 的分工（**别把两者合并**）：
//   - `computeCarryover`：源固定是"今天"、目标是"所有过去日期" —— 以前**自动跑**，
//     这一轮起**不再自动调用**，函数本身保留（既有单测与 `abandon.test.ts` 还在用）
//   - `planDateMove`：源是用户挑的**某一天**、目标是用户挑的**某一天**，**只手动**
// ===========================================================================

/** 源日期与目标日期是同一天时的说明（界面直接显示，测试直接比对） */
export const DATE_MOVE_SAME_DAY_REASON = '源和目标不能是同一天'
/** 那一天没有可移动的任务时的说明 */
export const DATE_MOVE_EMPTY_REASON = '这一天没有可移动的未完成任务'

/** 「某一天 → 某一天」这次移动的预览（数量、能不能按、为什么不能） */
export interface DateMovePreview {
  /** 源日期（YYYY-MM-DD） */
  source: string
  /** 目标日期（YYYY-MM-DD） */
  target: string
  /** 会被搬走的那几条（预览数量 = `movable.length`，点下去搬的也是这一批） */
  movable: PlanTask[]
  /** 此刻能不能按下确认（源=目标、或那一天没有可移动的任务时为 false） */
  canMove: boolean
  /** 不能移动的原因；能移动时为 null（界面直接显示这句话） */
  reason: string | null
}

/**
 * 算出"把 sourceKey 这一天的未完成任务移到 targetKey"会动哪些任务。
 *
 * **筛选条件只有一处**：`plan.isMoveEligible`（精确到天 + 未完成 + 非放弃 + 非钉住 + 非重复）。
 * 界面拿到的预览数量与实际搬走的数量因此不可能对不上——两边都读这一个函数。
 *
 * 源日期可以是**过去、今天、未来**任意一天（用户可能把未来某天的事提前做）。
 */
export function planDateMove(
  tasks: PlanTask[],
  sourceKey: string,
  targetKey: string
): DateMovePreview {
  const movable = tasks.filter((task) => isMoveEligible(task, sourceKey))
  const reason =
    sourceKey === targetKey
      ? DATE_MOVE_SAME_DAY_REASON
      : movable.length === 0
        ? DATE_MOVE_EMPTY_REASON
        : null
  return { source: sourceKey, target: targetKey, movable, canMove: reason === null, reason }
}

/**
 * 一条任务"被搬到某一天"要写的补丁（**批量移动与逐条移动共用这一个**）。
 *
 * `carriedOver` 仍是 **+1**（不是按逾期天数）：它的语义是"被搬过几次"，
 * 按天数会出现「已顺延 90 次」那种荒谬显示（`修改-5.md` §6.6）。
 */
export function taskDateMovePatch(
  task: Pick<PlanTask, 'carriedOver'>,
  targetKey: string
): { date: string; carriedOver: number } {
  return { date: targetKey, carriedOver: task.carriedOver + 1 }
}

/** 面板里的实时预览：`2026-03-15 有 5 项未完成任务可移动` */
export function dateMovePreviewText(preview: DateMovePreview): string {
  return `${preview.source} 有 ${preview.movable.length} 项未完成任务可移动`
}

/** 确认按钮的文案：`移动这 5 项`（数字跟着预览走） */
export function dateMoveConfirmLabel(preview: DateMovePreview): string {
  return `移动这 ${preview.movable.length} 项`
}

/**
 * 移动完成后的提示（`data-testid="carryover-notice"` 那一句）。
 *
 * 刻意带**源日期与目标日期**：以前那句写的是"已把 N 项**昨天**没做完的任务挪到今天"，
 * 与实际搬的范围不符（旧逻辑搬的是所有过去日期）；这一轮改准。
 */
export function dateMovedNotice(sourceKey: string, targetKey: string, count: number): string {
  return `已把 ${sourceKey} 的 ${count} 项未完成任务移到 ${targetKey}`
}

/**
 * 判断某个重复任务是否应当在指定日期出现。
 *
 * 判据基于"系列起点"（首次创建那天）：
 *   - 每天：起点之后每天都有
 *   - 每周：与起点相隔 7 的整数倍
 *   - 每月：与起点同一天（日期号相同）
 */
export function recurrenceHitsOn(
  recurrence: RecurrenceType,
  seriesStartKey: string,
  targetKey: string
): boolean {
  if (recurrence === 'none') return seriesStartKey === targetKey
  const diff = daysBetween(seriesStartKey, targetKey)
  if (diff < 0) return false
  if (recurrence === 'daily') return true
  if (recurrence === 'weekly') return diff % 7 === 0
  // 每月：日期号相同（不处理"31 号在 2 月"这类边界，第一版按日期号匹配）
  const startDay = Number.parseInt(seriesStartKey.slice(8, 10), 10)
  const targetDay = Number.parseInt(targetKey.slice(8, 10), 10)
  return startDay === targetDay
}

/**
 * 生成某天的重复任务实例描述（虚拟实例，不落盘）。
 * 真正的落盘发生在用户勾选完成时——只为那一天生成一条记录。
 */
export interface RecurrenceOccurrence {
  seriesId: string
  title: string
  date: string
  timeSlot: PlanTask['timeSlot']
  done: boolean
}

/**
 * 把"重复任务模板 + 已完成记录"展开成某天的任务清单。
 *
 * 设计取舍：
 *   - 重复任务本身是一条记录（模板），日期记在 seriesStart
 *   - 用户勾选完成后，为该日期生成一条 done 记录（seriesId 相同）
 *   - 展开时把未勾选的日期补成"待办"，已勾选的日期保留为"已完成"
 * 这样既不会每天都写一条记录，也不会丢掉"哪天做过了"。
 */
export function expandRecurrenceForDay(
  templates: PlanTask[],
  completions: PlanTask[],
  dayKey: string
): RecurrenceOccurrence[] {
  const result: RecurrenceOccurrence[] = []
  for (const template of templates) {
    if (template.recurrence === 'none') continue
    /**
     * **放弃的重复任务不再生成下一次**（修改 4 轮 §7.3）。
     *
     * 这一处就是"生成下一次"的唯一入口：重复任务本身只是一条模板记录，
     * 每天要出现的那一条是这里按 `recurrenceHitsOn` 展开出来的（不落盘）。
     * 所以在这里排除 = 今天放弃之后，明天不会再冒出来；不排除就等于放弃无效。
     */
    if (isAbandoned(template)) continue
    if (!recurrenceHitsOn(template.recurrence, template.date, dayKey)) continue
    const seriesId = template.seriesId ?? template.id
    const done = completions.some(
      (item) => item.seriesId === seriesId && item.date === dayKey && item.done
    )
    result.push({
      seriesId,
      title: template.title,
      date: dayKey,
      timeSlot: template.timeSlot,
      done
    })
  }
  return result
}

export interface DayGroups {
  overdue: PlanTask[]
  /**
   * 手动标了「未完成」（`held`）的任务（修改 7 轮新增的第五组）。
   *
   * 只做一件事：让「全部」视图有一组「**已标未完成（N）**」把它们收着——
   * 这一组是**唯一能看见它们的地方**（「今天 / 本周」都不显示、首页也不显示），
   * 所以不新增这一组的话，用户一按「标记未完成」那些任务就凭空消失了。
   */
  held: PlanTask[]
  today: PlanTask[]
  upcoming: PlanTask[]
  unscheduled: PlanTask[]
  doneToday: PlanTask[]
}

/**
 * 把任务按"今天视图"的需要分组。
 *
 * 已经过去且已完成的旧任务不进任何分组（它们属于"全部"视图），
 * 否则今天视图会越用越长。
 *
 * **放弃的任务不进任何一组**（修改 4 轮 §7.2 第 5 条）：它们只在「全部」视图里
 * 单独一组「已放弃（N）」收着（见 `partitionAbandoned`），
 * 所以"今天 / 本周"里看不到放弃的任务，也不会被算成逾期。
 *
 * **手动标了「未完成」（`held`）的单独一组**（修改 7 轮 §四 4.2）：
 * 从 `overdue` 里拆出来，否则会出现"页头写「逾期 0 项」，而逾期组里却列着 2 行"。
 * 它们**不进** `overdue / today / upcoming` 任何一组 —— 于是「今天」视图里
 * 一行都看不到它（用户第二次确认的边界），而「全部」视图的新分组里看得见。
 */
export function groupForToday(tasks: PlanTask[], todayKey: string): DayGroups {
  const groups: DayGroups = {
    overdue: [],
    held: [],
    today: [],
    upcoming: [],
    unscheduled: [],
    doneToday: []
  }

  for (const task of tasks) {
    if (isAbandoned(task)) continue
    if (task.date === UNSCHEDULED) {
      if (!task.done) groups.unscheduled.push(task)
      continue
    }
    /**
     * 标记了「未完成」的先拦下来（修改 7 轮）。
     *
     * 顺序有意放在逾期之前：它**不再进逾期组**（页头不数它，列表也别出现
     * "逾期 0 项却有 2 行"），但也不能因此掉进「今天 / 接下来」——
     * 它应当只在「全部」视图的新分组里出现。
     * `!task.done` 是兜底：`normalizePlanTask` 已经保证 done ⇒ held 清掉。
     */
    if (isHeld(task) && !task.done) {
      groups.held.push(task)
      continue
    }
    if (isOverdue(task, todayKey)) {
      groups.overdue.push(task)
      continue
    }
    if (task.date === todayKey) {
      if (task.done) groups.doneToday.push(task)
      else groups.today.push(task)
      continue
    }
    // 未来的任务
    if (!task.done) groups.upcoming.push(task)
  }

  const bySlotThenTitle = (a: PlanTask, b: PlanTask): number => {
    const slot = timeSlotWeight(a.timeSlot) - timeSlotWeight(b.timeSlot)
    if (slot !== 0) return slot
    return a.title.localeCompare(b.title, 'zh-Hans-CN')
  }

  groups.overdue.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : bySlotThenTitle(a, b)))
  groups.held.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : bySlotThenTitle(a, b)))
  groups.today.sort(bySlotThenTitle)
  groups.upcoming.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : bySlotThenTitle(a, b)))
  groups.unscheduled.sort(bySlotThenTitle)
  groups.doneToday.sort((a, b) => String(b.doneAt ?? '').localeCompare(String(a.doneAt ?? '')))

  return groups
}

/** 周视图：把任务按日期键分组 */
export function groupByDate(tasks: PlanTask[]): Map<string, PlanTask[]> {
  const map = new Map<string, PlanTask[]>()
  for (const task of tasks) {
    const list = map.get(task.date) ?? []
    list.push(task)
    map.set(task.date, list)
  }
  return map
}

/** 页头统计：逾期 N 项 · 今天 N 项 · 本周 N 项 */
export interface PlanCounts {
  overdue: number
  today: number
  week: number
}

/**
 * 页头统计：逾期 N 项 · 今天 N 项 · 本周 N 项。
 *
 * **三处都不含放弃的任务**（修改 4 轮 §7.2 第 4 条）。注意这里是一处提前跳过，
 * 三处统计因此同时受益；如果只在 `isOverdue` 里挡，今天 / 本周这两处仍会数进去。
 *
 * ## 修改 7 轮：逾期这一处改用 `countsAsOverdue`（**只有这一处**）
 *
 * 用户第三次确认的边界是"**数字仍算、只是不显示**"：
 *   - 「逾期 N 项」→ **不数** `held`（用户：「标记未完成不显示逾期」）
 *   - 「今天 N 项」「本周 N 项」→ **仍然数** `held`
 *
 * ⚠️ **两个方向不同，别合并处理**。为了让"今天 / 本周"看起来与行数一致，
 * 把这两处也排掉 `held` 会推翻用户明确确认过的口径（`修改-7.md` §三）。
 */
export function countForHeader(
  tasks: PlanTask[],
  todayKey: string,
  weekKeys: string[]
): PlanCounts {
  const weekSet = new Set(weekKeys)
  let overdue = 0
  let today = 0
  let week = 0
  for (const task of tasks) {
    if (isAbandoned(task)) continue
    if (task.done) continue
    if (task.date === UNSCHEDULED) continue
    // 逾期用"统计口径"（held 不算）；今天 / 本周仍是"含 held"的原口径
    if (countsAsOverdue(task, todayKey)) overdue += 1
    if (task.date === todayKey) today += 1
    if (weekSet.has(task.date)) week += 1
  }
  return { overdue, today, week }
}

/**
 * 计划页工具栏里那条「N 项逾期」内联提示该不该显示（修改 6 轮）。
 *
 * 用户原话：「这个提醒放在上面按个框框里，然后可以关闭。」
 * 定的口径是"**当天不再出现**"：
 *
 *   显示 = 逾期 > 0 且 关掉的那一天 !== 今天
 *
 * 两个边界都是刻意的：
 *   - `overdue === 0` → **不显示**（哪怕从没关过；没有逾期还冒一条提示是噪音）
 *   - `dismissedOn === 今天` → **不显示**；`dismissedOn === 昨天` → **显示**
 *     （"第二天自动回来"靠的就是这一次朴素比较，**不需要任何定时器**）
 *
 * ⚠️ 它**只**管这条提示：页头的「逾期 N 项」统计、导航红点、首页关注卡
 * 都不读它（关掉的只是提示，不是提醒能力）。
 *
 * 放在纯逻辑里（而不是写在组件里），是为了能用 `vitest` 直接覆盖按天失效这条。
 */
export function shouldShowOverdueHint(
  overdueCount: number,
  dismissedOn: string | undefined,
  todayKey: string
): boolean {
  if (!Number.isFinite(overdueCount) || overdueCount <= 0) return false
  return dismissedOn !== todayKey
}

/**
 * 把任务分成"还在账上"与"已放弃"两份（「全部」视图的分组用）。
 *
 * 为什么单独一个函数：视图分组与页头统计必须是**同一个口径**
 * （放弃 = 从统计里退出），两处各写一份 filter 迟早漂移。
 * 顺序保持传入顺序，排序由调用方决定（"全部"按日期排）。
 */
export function partitionAbandoned(tasks: PlanTask[]): {
  active: PlanTask[]
  abandoned: PlanTask[]
} {
  const active: PlanTask[] = []
  const abandoned: PlanTask[] = []
  for (const task of tasks) {
    if (isAbandoned(task)) abandoned.push(task)
    else active.push(task)
  }
  return { active, abandoned }
}

/**
 * 顺延预警文案。
 * 这是"给你自己的预警信号，不是惩罚"——所以用陈述语气，不带感叹号。
 */
export function carryoverLabel(task: PlanTask): string | null {
  if (task.carriedOver <= 0) return null
  return `已顺延 ${task.carriedOver} 次`
}

/** 把任务移到另一天（拖拽改期用）：返回补丁对象 */
export function reschedulePatch(
  targetDateKey: string,
  nowIso: string
): { date: string; updatedAt: string } {
  return { date: targetDateKey, updatedAt: nowIso }
}

/** 明天/下周等快捷键要用的目标日期（重复任务改期时按周期推算） */
export function nextOccurrenceDate(
  recurrence: RecurrenceType,
  fromKey: string
): string {
  switch (recurrence) {
    case 'daily':
      return addDaysToKey(fromKey, 1)
    case 'weekly':
      return addDaysToKey(fromKey, 7)
    case 'monthly':
      return addDaysToKey(fromKey, 30)
    default:
      return fromKey
  }
}
