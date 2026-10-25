/**
 * 计划模块的数据模型（DEVPLAN 阶段 4 / PRD §5.2）
 *
 * 字段与 PRD 一一对应：
 *   标题、日期（某天 / 待安排）、时段、重复、备注、所属项目（第二版启用）、完成、顺延次数
 *
 * v2 新增两个**可选**字段 `startTime` / `endTime`（"HH:mm"），供小时级日历使用。
 * 它们与既有的 `timeSlot` **共存不覆盖**：
 *   只有 timeSlot   → 落在周视图顶部的"全天"行（显示"上午"）
 *   只有 startTime  → 落在对应小时格
 *   两个都有        → 优先按 startTime 落小时格，"时段"仅作参考
 *   都没有          → 落在"全天"行
 */
import type { ContentFormat } from './richText'
// 日期一律走既有解析（`MASTER.md` §10.4 不硬编码 / 不重写第二份日期逻辑）
import { addDaysToKey } from './date'

/** 时段：不精确到几点，只分上午/下午/晚上 */
export type TimeSlot = 'none' | 'morning' | 'afternoon' | 'evening'

/** 重复规则 */
export type RecurrenceType = 'none' | 'daily' | 'weekly' | 'monthly'

export const TIME_SLOT_LABELS: Record<TimeSlot, string> = {
  none: '全天',
  morning: '上午',
  afternoon: '下午',
  evening: '晚上'
}

export const RECURRENCE_LABELS: Record<RecurrenceType, string> = {
  none: '不重复',
  daily: '每天',
  weekly: '每周',
  monthly: '每月'
}

/** 待安排：不排期的任务用这个日期值 */
export const UNSCHEDULED = 'unscheduled'

export interface PlanTask {
  id: string
  createdAt: string
  updatedAt: string
  deletedAt?: string
  title: string
  /** YYYY-MM-DD，或 UNSCHEDULED */
  date: string
  timeSlot: TimeSlot
  recurrence: RecurrenceType
  done: boolean
  /** 被自动顺延的次数，用于条目上显示"已顺延 N 次" */
  carriedOver: number
  /** 已完成的时间（ISO），未完成时为 null */
  doneAt: string | null
  note?: string
  /** 备注正文的格式标记：缺省即 plain（旧数据零改写），新记录写 rich */
  noteFormat?: ContentFormat
  /** 开始时间 "HH:mm"（可选）；与 timeSlot 共存不覆盖 */
  startTime?: string
  /** 结束时间 "HH:mm"（可选）；必须晚于 startTime */
  endTime?: string
  /**
   * 「这件事我要再复习一遍」的那一天（YYYY-MM-DD，可选）。
   *
   * 第 03 块加的**可选**字段（右键菜单的"设置复习时间"用它）：
   * 与复习卡的 `dueDate` 分开存——任务是日程，卡片是复习队列，
   * 两者的到期语义不能混（混了会让"今日到期多少张卡"凭空变化）。
   * 语义只有一条：**到了这一天，这条任务会自己回到"今天"这一组**，
   * 由 `planLogic.ts` 的 `isDueForReview` / `reviewCarryoverDate` 判定。
   * 缺省即没有复习时间，旧记录零改写。
   */
  reviewAt?: string
  /** 复习时间的时刻 "HH:mm"（可选；与复习卡的 dueTime 同格式） */
  reviewTime?: string
  /** 所属项目（第二版启用，第一版一律留空） */
  projectId?: string
  /** 重复任务：该任务属于哪个系列（同系列共享 seriesId） */
  seriesId?: string
  /**
   * **放弃**：手动标记"这件事我不做了"（修改 4 轮加的**可选**字段）。
   *
   * 为什么不是把 `done: boolean` 换成三态字符串：那会牵动逾期、顺延、
   * 完成率、分组与大量既有断言，收益不成正比。这里保留 `done` 的语义
   * （`done === true` 永远是"已完成"），三态由 `planTaskStateOf()` **派生**：
   *
   *   abandoned === true            → 'abandoned'（已放弃）
   *   abandoned !== true && done    → 'done'（已完成）
   *   否则                          → 'pending'（未完成）
   *
   * **与 `done` 互斥**，由 `normalizePlanTask` 强保证（放弃 ⇒ done 强制 false）。
   * 缺省即"没放弃"——旧记录零改写，**不需要注册迁移**；数据里也不存 state 字符串
   * （派生即可，避免两处真值）。
   */
  abandoned?: boolean
  /**
   * 「未完成，而且**别批量搬我**」——用户**手动**打的标记（修改 5 轮加的**可选**字段）。
   *
   * 用户原话：「未完成要手动标记，标记后就显示未完成就行」
   *          「我手动标记未完成的不移动（除非我手动移动）」。
   *
   * ## 与「已放弃」的区别（这一条最要紧，别合并成一个开关）
   *
   *   已放弃（`abandoned`）= 我**不做**这件事了 → 退出逾期 / 完成率 / 页头三处统计
   *   未完成 + 钉住（`held`）= 我**确实还没做**，只是别自动搬我 → **仍然算逾期**
   *
   * 所以 `held` **不**参与逾期判定，只在「批量移动」里当排除条件（见
   * `planLogic.planDateMove`）。把它做成"变相放弃"会违背用户那句话说的一半。
   *
   * ## 互斥（由 `normalizePlanTask` 强保证）
   *
   *   done === true      ⇒ held 清掉
   *   abandoned === true ⇒ held 清掉
   *   held 只出现在"未完成"的任务上
   *
   * 缺省即"没钉住"——旧记录零改写，**不需要注册迁移**（与 `abandoned` 同一套做法）。
   */
  held?: boolean
}

/**
 * 这条任务是不是被手动标成了「未完成」（宽容：只有严格的 `true` 才算）。
 *
 * 名字叫 `isHeld` 只是代码里的叫法；**界面上那两个字是「未完成」**
 * （用户原话："标记后就显示未完成就行"，不要发明"已钉住"这种词）。
 */
export function isHeld(task: Pick<PlanTask, 'held'>): boolean {
  return task.held === true
}

/**
 * 这条任务会不会被「把某一天没做完的移到另一天」那条批量移动搬走？
 *
 * 判据（**逐条**，`修改-5.md` §6.3 的移动规则原文）：
 *
 *   ✅ task.date === 选中的"源日期"   ← 精确到天，不是年月（比较日期字符串即可）
 *   ✅ done !== true
 *   ✅ abandoned !== true
 *   ✅ held !== true                 ← 手动标了「未完成」的不搬
 *   ✅ recurrence === 'none'         ← 重复任务不搬（与既有顺延口径一致）
 *
 * 「待安排」（`UNSCHEDULED`）天然不等于任何具体日期，因此自动被第一条排除。
 *
 * ⚠️ **只在这一处**当排除条件用。特别是 `isOverdue` 里**不许**排除 `held`：
 * 钉住 = "别自动搬我"，不是"当我不做这件事"（见 `修改-5.md` §四）。
 */
export function isMoveEligible(task: PlanTask, sourceDateKey: string): boolean {
  if (task.date !== sourceDateKey) return false
  if (task.done) return false
  if (isAbandoned(task)) return false
  if (isHeld(task)) return false
  if (task.recurrence !== 'none') return false
  return true
}

/**
 * 任务的三态（**派生**，不落库）。
 *
 * 用户原话（修改 4 轮）：「我要能**手动添加未完成和放弃两个选项**（和逾期功能不相关）」。
 * 「放弃」是**独立的手动状态**：不算逾期、不再自动顺延、不计入完成率，
 * 且能在「全部」里查到并恢复成未完成。
 */
export type PlanTaskState = 'pending' | 'done' | 'abandoned'

export const PLAN_TASK_STATE_LABELS: Record<PlanTaskState, string> = {
  pending: '未完成',
  done: '已完成',
  abandoned: '已放弃'
}

/** 这条任务是不是被放弃了（宽容：只有严格的 `true` 才算） */
export function isAbandoned(task: Pick<PlanTask, 'abandoned'>): boolean {
  return task.abandoned === true
}

/**
 * 三态派生：**唯一一处**把 `done` / `abandoned` 翻成状态的地方。
 *
 * 顺序有意如此：**先看放弃**。这样即使数据被外面的工具写坏
 * （`done` 与 `abandoned` 同时为 true），界面也按"已放弃"显示，
 * 与 `normalizePlanTask` 的强制结果一致，不会出现两处说法不同。
 */
export function planTaskStateOf(task: Pick<PlanTask, 'done' | 'abandoned'>): PlanTaskState {
  if (isAbandoned(task)) return 'abandoned'
  return task.done ? 'done' : 'pending'
}

/** "HH:mm" 的格式检查：00:00 ~ 23:59 */
export function isTimeOfDay(value: unknown): value is string {
  return typeof value === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(value)
}

/** 把 "HH:mm" 折算成当天的分钟数；非法值返回 null */
export function minutesOfDay(value: unknown): number | null {
  if (!isTimeOfDay(value)) return null
  const [hour, minute] = value.split(':').map((part) => Number.parseInt(part, 10))
  return (hour ?? 0) * 60 + (minute ?? 0)
}

/**
 * 时间区间的校验：`endTime` 必须**晚于** `startTime`。
 * 只填一个时另一个可空（表示"只记开始"或"到几点为止"）。
 */
export function isValidTimeRange(startTime?: string, endTime?: string): boolean {
  const start = minutesOfDay(startTime)
  const end = minutesOfDay(endTime)
  if (start === null || end === null) return true
  return end > start
}

/** 不合法的原因（合法时返回 null），供表单直接显示 */
export function timeRangeError(startTime?: string, endTime?: string): string | null {
  if (startTime !== undefined && startTime !== '' && !isTimeOfDay(startTime)) return '开始时间格式应为 HH:mm'
  if (endTime !== undefined && endTime !== '' && !isTimeOfDay(endTime)) return '结束时间格式应为 HH:mm'
  const start = minutesOfDay(startTime)
  const end = minutesOfDay(endTime)
  if (start !== null && end !== null && end <= start) return '结束时间必须晚于开始时间'
  return null
}

/**
 * 把时间区间规范化成可落库的补丁：非法的一律丢掉，不写进数据。
 * 这样"改任务时间"这条路径不会因为界面漏校验而存下矛盾的时间段。
 */
export function normalizeTimeRange(
  startTime: unknown,
  endTime: unknown
): { startTime?: string; endTime?: string } {
  const start = isTimeOfDay(startTime) ? startTime : undefined
  const end = isTimeOfDay(endTime) ? endTime : undefined
  if (start !== undefined && end !== undefined && !isValidTimeRange(start, end)) {
    // 区间矛盾时保留开始时间——它才是"任务几点开始"的主信息
    return { startTime: start }
  }
  return {
    ...(start !== undefined ? { startTime: start } : {}),
    ...(end !== undefined ? { endTime: end } : {})
  }
}

export function isTimeSlot(value: unknown): value is TimeSlot {
  return value === 'none' || value === 'morning' || value === 'afternoon' || value === 'evening'
}

export function isRecurrence(value: unknown): value is RecurrenceType {
  return value === 'none' || value === 'daily' || value === 'weekly' || value === 'monthly'
}

/** 排序用的时段权重：上午 → 下午 → 晚上 → 全天 */
export function timeSlotWeight(slot: TimeSlot): number {
  switch (slot) {
    case 'morning':
      return 0
    case 'afternoon':
      return 1
    case 'evening':
      return 2
    default:
      return 3
  }
}

/**
 * 日历上显示的时间标签。
 * 有具体时间就显示时间（`10:00` / `10:00–11:30`）；
 * 只有时段就显示时段名（`上午`）；都没有就是"全天"。
 * 两者都有时**时间优先**（时段仅作参考）。
 */
export function timeLabel(task: Pick<PlanTask, 'startTime' | 'endTime' | 'timeSlot'>): string {
  const start = isTimeOfDay(task.startTime) ? task.startTime : null
  const end = isTimeOfDay(task.endTime) ? task.endTime : null
  if (start !== null) return end !== null && isValidTimeRange(start, end) ? `${start}–${end}` : start
  return TIME_SLOT_LABELS[task.timeSlot] ?? TIME_SLOT_LABELS.none
}

/** 把任意记录规范成 PlanTask（数据来自磁盘或导入文件，必须宽容） */
export function normalizePlanTask(input: Record<string, unknown>): PlanTask {
  const date = typeof input['date'] === 'string' && input['date'] !== '' ? input['date'] : UNSCHEDULED
  /**
   * `abandoned` 与 `done` **互斥**，这里强保证（`MASTER.md` §5.2 修改 4 轮）：
   *
   *   放弃 ⇒ done 强制 false，doneAt 一并清空
   *
   * 顺序不能反过来：先读 done 再被 abandoned 覆盖，否则"两个都为 true"的坏数据
   * 会漏到界面上（菜单同时出「恢复」和「标记未完成」这种矛盾态）。
   */
  const abandoned = input['abandoned'] === true
  const done = !abandoned && input['done'] === true
  /**
   * `held`（手动标「未完成」）与 `done` / `abandoned` **互斥**，这里强保证
   * （`修改-5.md` §四）：
   *
   *   done === true      ⇒ held 清掉（做完了就不再是"还没做"）
   *   abandoned === true ⇒ held 清掉（放弃了就不在搬不搬的讨论里）
   *
   * 只在"未完成"时才写这个字段（`...(held ? { held: true } : {})`），
   * 与 `abandoned` 同一套做法：旧记录读进来 = 没钉住，**零改写、不迁移**。
   */
  const held = !abandoned && !done && input['held'] === true
  const range = normalizeTimeRange(input['startTime'], input['endTime'])
  const reviewAt = typeof input['reviewAt'] === 'string' && input['reviewAt'] !== '' ? input['reviewAt'] : undefined
  return {
    id: String(input['id'] ?? ''),
    createdAt: String(input['createdAt'] ?? ''),
    updatedAt: String(input['updatedAt'] ?? ''),
    ...(typeof input['deletedAt'] === 'string' ? { deletedAt: input['deletedAt'] } : {}),
    title: String(input['title'] ?? '').trim(),
    date,
    timeSlot: isTimeSlot(input['timeSlot']) ? input['timeSlot'] : 'none',
    recurrence: isRecurrence(input['recurrence']) ? input['recurrence'] : 'none',
    done,
    carriedOver: Number.isFinite(input['carriedOver']) ? Math.max(0, Number(input['carriedOver'])) : 0,
    doneAt: abandoned
      ? null
      : typeof input['doneAt'] === 'string'
        ? input['doneAt']
        : done
          ? String(input['updatedAt'] ?? '')
          : null,
    ...(typeof input['note'] === 'string' && input['note'] !== '' ? { note: input['note'] } : {}),
    ...(input['noteFormat'] === 'rich' ? { noteFormat: 'rich' as const } : {}),
    ...range,
    ...(reviewAt === undefined ? {} : { reviewAt }),
    ...(isTimeOfDay(input['reviewTime']) ? { reviewTime: input['reviewTime'] } : {}),
    ...(typeof input['projectId'] === 'string' && input['projectId'] !== ''
      ? { projectId: input['projectId'] }
      : {}),
    ...(typeof input['seriesId'] === 'string' && input['seriesId'] !== ''
      ? { seriesId: input['seriesId'] }
      : {}),
    // 只有 true 才写这个字段：旧记录（没有它）= 没放弃，**零改写、不迁移**
    ...(abandoned ? { abandoned: true } : {}),
    // 同上：只有 true 才写，且已被上面挡住"已完成 / 已放弃"两种情形
    ...(held ? { held: true } : {})
  }
}

/**
 * 「设置复习时间」的落库补丁（右键菜单与验收都走这一个函数，不各写一份）。
 *
 * `days` 为距今天数：0 = 今天、1 = 明天、3 / 7 天后……
 * `days` 为 null 表示**清空**复习时间（三个字段一起清掉，避免留下半截状态）。
 */
export function taskReviewPatch(
  todayKey: string,
  days: number | null,
  timeOfDay = '09:00'
): Pick<PlanTask, 'reviewAt' | 'reviewTime'> {
  if (days === null) return { reviewAt: undefined, reviewTime: undefined }
  return {
    reviewAt: addDaysToKey(todayKey, Math.max(0, days)),
    reviewTime: isTimeOfDay(timeOfDay) ? timeOfDay : '09:00'
  }
}

/**
 * 这条任务今天到期复习吗？
 *
 * 语义只在"今天"这一档上生效：到了 `reviewAt` 当天（或已经过了那天），
 * 这条任务会自己回到"今天"分组里，顺延由 `planLogic.computeCarryover` 的
 * 调用方按同一个日期判定复用。
 */
export function isDueForReview(task: PlanTask, todayKey: string): boolean {
  if (task.reviewAt === undefined || task.reviewAt === '') return false
  return task.reviewAt <= todayKey
}

/**
 * 任务行上那句"复习时间"的显示文案。
 *
 * 到期（或已过）时写成"该复习了"，否则写日期（`10-14 09:00`）。
 * 没有设复习时间就返回 null，界面上什么都不显示——**旧任务零影响**。
 */
export function reviewTimeLabel(task: PlanTask, todayKey: string): string | null {
  if (task.reviewAt === undefined || task.reviewAt === '') return null
  const time = task.reviewTime !== undefined && task.reviewTime !== '' ? ` ${task.reviewTime}` : ''
  if (isDueForReview(task, todayKey)) return '该复习了'
  return `复习 ${task.reviewAt.slice(5)}${time}`
}
