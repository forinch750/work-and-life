/**
 * 修改 5 轮测试：取消自动顺延 + 「把某一天没做完的移到另一天」+ 手动「未完成」标记
 *
 * ## 用户原话（按时间）
 *
 *   ① 「未完成的任务会不会主动移到今天？这个我要改成手动。」
 *   ② 「然后未完成要手动标记，标记后就显示未完成就行。」
 *   ③ 「不要把之前的都移动，我只要算定天数的。」
 *   ④ 「我想要指定第几年几月未完成的，移动到指定某一天，然后我手动标记未完成的不移动。」
 *   ⑤ 「我要把**某一天**未完成的移动到**指定的某一天**。」
 *
 * 定稿是 ⑤：**源和目标是"某一天"，不是"年 + 月"**。
 *
 * ## 这一组钉住的三类东西
 *
 *   A. **数据形状**：`held?: boolean`（可选）→ 旧记录零改写、没有迁移；
 *      `normalizePlanTask` 强保证 `done / abandoned ⇒ held 清掉`；
 *      `isHeld` / `isMoveEligible` 的宽容读盘与筛选口径
 *   B. **批量移动的筛选**：只搬「源日期那一天 + 未完成 + 非放弃 + 非钉住 + 非重复」，
 *      相邻日期 / 其它日期一条都不动；预览数量 == 实际搬走的数量
 *   C. **两个语义别混**（**修改 7 轮整体反转了这个 describe**）：
 *      钉住的任务**不算逾期**（页头 / 红点 / 关注卡 / 日历色都不数它），
 *      但它**仍然看得见**（「全部」视图的「已标未完成」组），
 *      而且「今天 / 本周」的数字与完成率分母**仍然算它**；
 *      逐条「移动到指定日期」**不受 held 限制**
 *
 * vitest 是 `environment: 'node'`（没有 jsdom），所以测的都是纯函数；
 * DOM 上的标签 / 菜单点击 / 面板流程交给端到端 `P8-P1` ~ `P8-T8`。
 */
import { describe, expect, it } from 'vitest'
import type { RecordEnvelope } from '../../src/shared/types'
import {
  PLAN_TASK_STATE_LABELS,
  UNSCHEDULED,
  isHeld,
  isMoveEligible,
  normalizePlanTask,
  planTaskStateOf,
  type PlanTask
} from '../../src/shared/plan'
import {
  DATE_MOVE_EMPTY_REASON,
  DATE_MOVE_SAME_DAY_REASON,
  computeCarryover,
  countForHeader,
  countsAsOverdue,
  dateMoveConfirmLabel,
  dateMovePreviewText,
  dateMovedNotice,
  groupForToday,
  isOverdue,
  planDateMove,
  taskDateMovePatch
} from '../../src/shared/planLogic'
import { computeBadges } from '../../src/shared/badges'
import { monthTaskStats } from '../../src/renderer/modules/calendar/yearGrid'
import { barStateOf } from '../../src/renderer/modules/calendar/barState'
import { selectHomePlan } from '../../src/renderer/modules/home/selectHomePlan'
import {
  TASK_HOLD_HINT,
  TASK_HOLD_LABEL,
  TASK_MOVE_TO_LABEL,
  TASK_UNHOLD_LABEL,
  menuItemIds,
  taskMenuItems,
  type TaskMenuContext
} from '../../src/shared/contextMenu'

const TODAY = '2026-03-15'
const TARGET = '2026-10-25'
const WEEK = [
  '2026-03-09',
  '2026-03-10',
  '2026-03-11',
  '2026-03-12',
  '2026-03-13',
  '2026-03-14',
  '2026-03-15'
]

let seq = 0
function task(partial: Partial<PlanTask> = {}): PlanTask {
  seq += 1
  return {
    id: partial.id ?? `h${seq}`,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    title: partial.title ?? `任务 ${seq}`,
    date: partial.date ?? TODAY,
    timeSlot: partial.timeSlot ?? 'none',
    recurrence: partial.recurrence ?? 'none',
    done: partial.done ?? false,
    carriedOver: partial.carriedOver ?? 0,
    doneAt: partial.doneAt ?? null,
    ...(partial.abandoned === true ? { abandoned: true } : {}),
    ...(partial.held === true ? { held: true } : {}),
    ...(partial.seriesId === undefined ? {} : { seriesId: partial.seriesId })
  }
}

/** 把 `planDateMove` 的结论"真的落到数据上"（模拟页面逐条 `patchTask` 那一步） */
function applyDateMove(tasks: PlanTask[], source: string, target: string): PlanTask[] {
  const preview = planDateMove(tasks, source, target)
  const movedIds = new Map(preview.movable.map((item) => [item.id, taskDateMovePatch(item, target)]))
  return tasks.map((item) => {
    const patch = movedIds.get(item.id)
    return patch === undefined ? item : { ...item, ...patch }
  })
}

/**
 * 造一条**原始记录**（与磁盘上的形状一致）。
 *
 * 给 `computeBadges`（读 `Record<string, unknown>`）与 `selectHomePlan`
 * （读 `RecordEnvelope[]`）用 —— 两者吃的都是"还没 normalize 的裸记录"，
 * 这样测的才是"真从数据一路算下来"，而不是先自己规范一遍再喂进去。
 */
function planRecord(overrides: Record<string, unknown> = {}): RecordEnvelope {
  return {
    id: 'rec-1',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    title: '记录任务',
    date: TODAY,
    timeSlot: 'none',
    recurrence: 'none',
    done: false,
    carriedOver: 0,
    doneAt: null,
    ...overrides
  } as RecordEnvelope
}

// ===========================================================================
// A. 数据形状：held 是可选字段、互斥强保证、旧记录零改写
// ===========================================================================

describe('isHeld / isMoveEligible：宽容读盘', () => {
  it('isHeld 只认严格的 true（缺省 = 没钉住）', () => {
    expect(isHeld({ held: true })).toBe(true)
    expect(isHeld({ held: false })).toBe(false)
    expect(isHeld({})).toBe(false)
    expect(isHeld({ held: 'yes' as unknown as boolean })).toBe(false)
  })

  it('isMoveEligible：源日期那一天、未完成、非放弃、非钉住、非重复 → 会搬', () => {
    expect(isMoveEligible(task({ date: TODAY }), TODAY)).toBe(true)
  })

  it('isMoveEligible：五类"不搬"逐条否掉（少一条就等于没做筛）', () => {
    // ① 不是源日期那一天
    expect(isMoveEligible(task({ date: '2026-03-14' }), TODAY)).toBe(false)
    // ② 已完成
    expect(isMoveEligible(task({ date: TODAY, done: true }), TODAY)).toBe(false)
    // ③ 已放弃
    expect(isMoveEligible(task({ date: TODAY, abandoned: true }), TODAY)).toBe(false)
    // ④ 已钉住（本轮新增的关键排除）
    expect(isMoveEligible(task({ date: TODAY, held: true }), TODAY)).toBe(false)
    // ⑤ 重复任务
    expect(isMoveEligible(task({ date: TODAY, recurrence: 'daily' }), TODAY)).toBe(false)
    // 待安排天然不等于任何具体日期
    expect(isMoveEligible(task({ date: UNSCHEDULED }), TODAY)).toBe(false)
  })
})

describe('normalizePlanTask：held 与 done / abandoned 互斥（强保证）', () => {
  it('done:true 时 held 被清掉', () => {
    const result = normalizePlanTask({
      id: 'x',
      title: '做完了还带着钉住',
      date: TODAY,
      done: true,
      held: true
    })
    expect(result.done).toBe(true)
    expect(result.held).toBeUndefined()
    expect('held' in result).toBe(false)
    expect(planTaskStateOf(result)).toBe('done')
  })

  it('abandoned:true 时 held 被清掉（放弃与"别搬我"不在同一个讨论里）', () => {
    const result = normalizePlanTask({
      id: 'y',
      title: '放弃了还带着钉住',
      date: TODAY,
      abandoned: true,
      held: true
    })
    expect(result.abandoned).toBe(true)
    expect(result.held).toBeUndefined()
    expect(planTaskStateOf(result)).toBe('abandoned')
  })

  it('done / abandoned 同时为 true（坏数据）时 held 同样被清掉', () => {
    const result = normalizePlanTask({ id: 'z', title: '坏数据', done: true, abandoned: true, held: true })
    expect(result.held).toBeUndefined()
  })

  it('未完成 + held:true → 保留下来，且三态仍是 pending', () => {
    const result = normalizePlanTask({ id: 'k', title: '还没做', date: TODAY, held: true })
    expect(result.held).toBe(true)
    expect(planTaskStateOf(result)).toBe('pending')
  })

  it('held:false 与没有该字段等价（都不会写出这个键）', () => {
    const explicitFalse = normalizePlanTask({ id: 'f', title: '没钉住', held: false })
    const missing = normalizePlanTask({ id: 'm', title: '没钉住' })
    expect('held' in explicitFalse).toBe(false)
    expect('held' in missing).toBe(false)
  })

  it('旧记录（完全没有 held 字段）读进来 = 未钉住，且字段没有被补写', () => {
    const legacy = {
      id: 'legacy-held-1',
      title: '修改 5 轮之前建的任务',
      date: '2026-03-10',
      timeSlot: 'morning',
      recurrence: 'none',
      done: false,
      carriedOver: 2,
      doneAt: null,
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-02T00:00:00.000Z'
    }
    const result = normalizePlanTask(legacy)
    expect(isHeld(result)).toBe(false)
    expect('held' in result).toBe(false)
    // **零改写**：其它字段一个都没动（不需要注册迁移）
    expect(result).toMatchObject({
      id: 'legacy-held-1',
      title: '修改 5 轮之前建的任务',
      date: '2026-03-10',
      timeSlot: 'morning',
      done: false,
      carriedOver: 2,
      doneAt: null
    })
  })

  it('规范化是幂等的：反复读同一条钉住的记录，结果不变', () => {
    const once = normalizePlanTask({ id: 'p', title: '反复读', date: TODAY, held: true })
    const twice = normalizePlanTask(once as unknown as Record<string, unknown>)
    expect(twice).toEqual(once)
  })
})

// ===========================================================================
// B. 批量移动的筛选（修改 5 轮的主体）
// ===========================================================================

describe('planDateMove：只搬「源日期那一天 + 未完成 + 非放弃 + 非钉住 + 非重复」', () => {
  it('五类"不搬"+ 一类"搬"放在同一批里，只有那一类被选中', () => {
    const movable = task({ id: 'movable', date: TODAY })
    const otherDay = task({ id: 'other-day', date: '2026-03-14' })
    const doneTask = task({ id: 'done', date: TODAY, done: true })
    const abandonedTask = task({ id: 'abandoned', date: TODAY, abandoned: true })
    const heldTask = task({ id: 'held', date: TODAY, held: true })
    const repeating = task({ id: 'repeating', date: TODAY, recurrence: 'daily' })
    const unscheduled = task({ id: 'unscheduled', date: UNSCHEDULED })

    const preview = planDateMove(
      [movable, otherDay, doneTask, abandonedTask, heldTask, repeating, unscheduled],
      TODAY,
      TARGET
    )

    expect(preview.movable.map((item) => item.id)).toEqual(['movable'])
    expect(preview.canMove).toBe(true)
    expect(preview.reason).toBeNull()
  })

  it('只选源日期那一天：相邻日期（前一天 / 后一天）一条都不动', () => {
    const before = task({ id: 'before', date: '2026-03-14' })
    const onDay = task({ id: 'on-day', date: TODAY })
    const after = task({ id: 'after', date: '2026-03-16' })
    const preview = planDateMove([before, onDay, after], TODAY, TARGET)
    expect(preview.movable.map((item) => item.id)).toEqual(['on-day'])
  })

  it('源日期可以是未来：把未来某天的事提前搬到今天也算数', () => {
    const future = task({ id: 'future', date: '2026-09-01' })
    const preview = planDateMove([future], '2026-09-01', TODAY)
    expect(preview.movable.map((item) => item.id)).toEqual(['future'])
    expect(preview.canMove).toBe(true)
  })

  it('预览数量 == 实际移动数量（同一个函数算，不会两处漂移）', () => {
    const batch = [
      task({ id: 'a', date: TODAY }),
      task({ id: 'b', date: TODAY }),
      task({ id: 'c', date: TODAY }),
      task({ id: 'd', date: TODAY, held: true }),
      task({ id: 'e', date: TODAY, done: true }),
      task({ id: 'f', date: '2026-03-16' })
    ]
    const preview = planDateMove(batch, TODAY, TARGET)
    expect(preview.movable).toHaveLength(3)

    const after = applyDateMove(batch, TODAY, TARGET)
    const actuallyMoved = after.filter((item, index) => item.date !== batch[index]?.date)
    expect(actuallyMoved.map((item) => item.id)).toEqual(preview.movable.map((item) => item.id))
    expect(actuallyMoved).toHaveLength(preview.movable.length)
  })

  it('移动后：只有源日期那几条换了日期，其它日期 / 已完成 / 已放弃 / 钉住的原地不动', () => {
    const batch = [
      task({ id: 'a', date: TODAY }),
      task({ id: 'b', date: TODAY, held: true }),
      task({ id: 'c', date: TODAY, done: true }),
      task({ id: 'd', date: TODAY, abandoned: true }),
      task({ id: 'e', date: '2026-03-14' }),
      task({ id: 'f', date: TODAY, recurrence: 'weekly' })
    ]
    const after = applyDateMove(batch, TODAY, TARGET)
    const byId = new Map(after.map((item) => [item.id, item.date]))
    expect(byId.get('a')).toBe(TARGET)
    expect(byId.get('b')).toBe(TODAY) // 钉住的没被搬走（★核心）
    expect(byId.get('c')).toBe(TODAY)
    expect(byId.get('d')).toBe(TODAY)
    expect(byId.get('e')).toBe('2026-03-14')
    expect(byId.get('f')).toBe(TODAY)
  })

  it('源日期 === 目标日期 → 不可移动，并给出"同一天"的原因', () => {
    const preview = planDateMove([task({ date: TODAY })], TODAY, TODAY)
    expect(preview.canMove).toBe(false)
    expect(preview.reason).toBe(DATE_MOVE_SAME_DAY_REASON)
    expect(DATE_MOVE_SAME_DAY_REASON).toBe('源和目标不能是同一天')
  })

  it('那一天没有可移动的任务 → 0 项、不可移动（原因写清楚）', () => {
    const none = planDateMove(
      [task({ date: '2026-03-14' }), task({ date: TODAY, held: true })],
      TODAY,
      TARGET
    )
    expect(none.movable).toHaveLength(0)
    expect(none.canMove).toBe(false)
    expect(none.reason).toBe(DATE_MOVE_EMPTY_REASON)
    expect(DATE_MOVE_EMPTY_REASON).toBe('这一天没有可移动的未完成任务')
  })

  it('空数据也不炸（新装 / 刚清空数据时打开面板就是这种情形）', () => {
    const preview = planDateMove([], TODAY, TARGET)
    expect(preview.movable).toHaveLength(0)
    expect(preview.canMove).toBe(false)
  })
})

describe('taskDateMovePatch / carriedOver：每次移动 +1（不是按天数）', () => {
  it('一次移动 carriedOver +1', () => {
    expect(taskDateMovePatch({ carriedOver: 0 }, TARGET)).toEqual({ date: TARGET, carriedOver: 1 })
    expect(taskDateMovePatch({ carriedOver: 3 }, TARGET)).toEqual({ date: TARGET, carriedOver: 4 })
  })

  it('搬得越远也不多加：3 天前与 3 个月前都是 +1', () => {
    const near = task({ carriedOver: 0, date: '2026-03-14' })
    const far = task({ carriedOver: 0, date: '2025-12-01' })
    expect(taskDateMovePatch(near, TODAY).carriedOver).toBe(1)
    expect(taskDateMovePatch(far, TODAY).carriedOver).toBe(1)
  })

  it('批量搬完，每条的 carriedOver 都是 +1（不是"只加一次"也不是"按天数"）', () => {
    const batch = [
      task({ id: 'a', date: TODAY, carriedOver: 0 }),
      task({ id: 'b', date: TODAY, carriedOver: 2 }),
      task({ id: 'c', date: TODAY, carriedOver: 9 })
    ]
    const after = applyDateMove(batch, TODAY, TARGET)
    expect(after.map((item) => item.carriedOver)).toEqual([1, 3, 10])
  })

  it('逐条移动与批量移动用的是同一个补丁函数（口径不会分叉）', () => {
    const single = task({ carriedOver: 5 })
    const patch = taskDateMovePatch(single, '2026-04-01')
    const preview = planDateMove([single], single.date, '2026-04-01')
    expect(taskDateMovePatch(preview.movable[0] as PlanTask, '2026-04-01')).toEqual(patch)
  })
})

describe('提示与按钮文案（改准，不再说"昨天没做完的"）', () => {
  it('预览文案带源日期与数量', () => {
    const preview = planDateMove(
      [task({ date: '2026-03-15' }), task({ date: '2026-03-15' })],
      '2026-03-15',
      TARGET
    )
    expect(dateMovePreviewText(preview)).toBe('2026-03-15 有 2 项未完成任务可移动')
  })

  it('确认按钮的数字跟着预览走', () => {
    const preview = planDateMove([task({ date: TODAY })], TODAY, TARGET)
    expect(dateMoveConfirmLabel(preview)).toBe('移动这 1 项')
    expect(dateMoveConfirmLabel(planDateMove([], TODAY, TARGET))).toBe('移动这 0 项')
  })

  it('移动后的提示带源日期与目标日期（旧文案"昨天没做完的"是个错的说法）', () => {
    const notice = dateMovedNotice('2026-03-15', '2026-10-25', 5)
    expect(notice).toBe('已把 2026-03-15 的 5 项未完成任务移到 2026-10-25')
    // 钉住：这句里不许再出现"昨天"
    expect(notice).not.toContain('昨天')
  })
})

// ===========================================================================
// C. 两个语义别混：held **不算逾期**（统计与提醒），但仍然**看得见**；
//    逐条移动不受 held 限制
//
// **修改 7 轮把这个 describe 整体反转了**（改写，不是删测试）：
//   旧口径（`修改-5.md` §四）：held **仍然算逾期** —— 页头数它、逾期组里也有它
//   新口径（`修改-7.md` §三）：held **不算逾期**（页头 / 工具栏提示 / 导航红点 /
//                              首页关注卡 / 日历逾期色都不数它），
//                              但它从「逾期」组挪到「已标未完成」组，仍然看得见；
//                              「今天 / 本周」的数字与完成率分母**仍然算它**
//   判据没有变松：除了"不算逾期"，还同时钉住"仍然看得见"与"分母仍算"。
// ===========================================================================

describe('held 不算逾期，但仍然看得见（修改 7 轮反转 ★这一条最容易被做错）', () => {
  it('isOverdue 对钉住的任务**仍然为 true**（显示口径，一个字没改）', () => {
    const overdue = task({ date: '2026-03-10' })
    expect(isOverdue(overdue, TODAY)).toBe(true)
    expect(isOverdue({ ...overdue, held: true }, TODAY)).toBe(true)
  })

  it('countsAsOverdue 对钉住的任务为 false（统计与提醒口径）', () => {
    const overdue = task({ date: '2026-03-10' })
    expect(countsAsOverdue(overdue, TODAY)).toBe(true)
    expect(countsAsOverdue({ ...overdue, held: true }, TODAY)).toBe(false)
  })

  it('对照组：已放弃的**两个口径都不算**（三者语义各不同，别合并）', () => {
    const overdue = task({ date: '2026-03-10' })
    expect(isOverdue({ ...overdue, abandoned: true }, TODAY)).toBe(false)
    expect(countsAsOverdue({ ...overdue, abandoned: true }, TODAY)).toBe(false)
  })

  it('页头「逾期 N 项」**不数**钉住的；「今天 / 本周」**仍然数**它（用户确认的边界）', () => {
    const counts = countForHeader(
      [
        task({ id: 'plain', date: '2026-03-10' }),
        task({ id: 'held', date: '2026-03-10', held: true }),
        task({ id: 'abandoned', date: '2026-03-10', abandoned: true }),
        task({ id: 'today', date: TODAY }),
        task({ id: 'held-today', date: TODAY, held: true })
      ],
      TODAY,
      WEEK
    )
    // 逾期 = 只有普通那 1 条（钉住的两条都不再数）；
    // 今天 = 普通 1 + 钉住 1；本周 = 这周里的 4 条（放弃那条不数，钉住那两条仍数）。
    // ⚠️ "逾期"排它、"今天 / 本周"含它 —— 两个方向不同，别合并处理。
    expect(counts).toEqual({ overdue: 1, today: 2, week: 4 })
  })

  it('钉住的任务在「已标未完成」组里，**不在「逾期」组**（页头数字与行数因此不矛盾）', () => {
    const groups = groupForToday(
      [
        task({ id: 'plain', date: '2026-03-10' }),
        task({ id: 'held', date: '2026-03-10', held: true }),
        task({ id: 'held-today', date: TODAY, held: true })
      ],
      TODAY
    )
    expect(groups.overdue.map((item) => item.id)).toEqual(['plain'])
    expect(groups.held.map((item) => item.id)).toEqual(['held', 'held-today'])
    // 「今天 / 接下来」里一条都没有它 —— 于是「今天」视图是 0 行
    expect(groups.today).toHaveLength(0)
    expect(groups.upcoming).toHaveLength(0)
  })

  it('页头「逾期 0」与「逾期」组 0 行不矛盾（数量与行数同一个来源）', () => {
    const only = [task({ id: 'held', date: '2026-03-10', held: true })]
    expect(countForHeader(only, TODAY, WEEK).overdue).toBe(0)
    expect(groupForToday(only, TODAY).overdue).toHaveLength(0)
    expect(groupForToday(only, TODAY).held).toHaveLength(1)
  })

  it('导航红点不因 held 亮起（badges.planOverdue 为 false）', () => {
    const heldOnly = computeBadges([planRecord({ date: '2026-03-10', held: true })], [], TODAY)
    expect(heldOnly.planOverdue).toBe(false)
    // 对照：普通逾期照旧亮
    expect(computeBadges([planRecord({ date: '2026-03-10' })], [], TODAY).planOverdue).toBe(true)
    // 对照：already 放弃的不亮（两条口径一致）
    expect(computeBadges([planRecord({ date: '2026-03-10', abandoned: true })], [], TODAY).planOverdue).toBe(false)
  })

  it('日历上钉住的任务**照旧画出来**，但不标逾期色（`barStateOf` = todo）', () => {
    const overdueTask = task({ date: '2026-03-10' })
    expect(barStateOf(overdueTask, TODAY)).toBe('overdue')
    expect(barStateOf({ ...overdueTask, held: true }, TODAY)).toBe('todo')
    // 日期没变：它的日期仍是原来那一天（日历照旧把它画在那一天）
    expect(task({ date: '2026-03-10', held: true }).date).toBe('2026-03-10')
    // 对照：已完成 / 已放弃 不参与逾期色
    expect(barStateOf({ ...overdueTask, done: true }, TODAY)).toBe('done')
    expect(barStateOf({ ...overdueTask, abandoned: true }, TODAY)).toBe('todo')
  })

  it('取消「未完成」标记后**立刻回到逾期**（往返可用，不是单向门）', () => {
    const overdue = task({ id: 'back', date: '2026-03-10' })
    const held = { ...overdue, held: true as const }
    const unheld = normalizePlanTask({ ...held, held: false } as unknown as Record<string, unknown>)
    expect(countsAsOverdue(held, TODAY)).toBe(false)
    expect(countsAsOverdue(unheld, TODAY)).toBe(true)
    expect(groupForToday([held], TODAY).overdue).toHaveLength(0)
    expect(groupForToday([unheld], TODAY).overdue.map((item) => item.id)).toEqual(['back'])
    expect(groupForToday([unheld], TODAY).held).toHaveLength(0)
  })

  it('完成率分母**仍然包含** held：1 完成 + 1 held → 50%（不是 100%）★这是本功能的目的', () => {
    const doneTask = task({ id: 'done-one', date: '2026-03-10', done: true, doneAt: '2026-03-10T09:00:00.000Z' })
    const heldTask = task({ id: 'held-one', date: '2026-03-11', held: true })
    expect(monthTaskStats([doneTask, heldTask], 2026, 3)).toEqual({ total: 2, done: 1, rate: 50 })
  })

  it('对照必须相反：1 完成 + 1 **放弃** → 100%（放弃退出分母）', () => {
    const doneTask = task({ id: 'done-two', date: '2026-03-10', done: true, doneAt: '2026-03-10T09:00:00.000Z' })
    const abandonedTask = task({ id: 'abandoned-one', date: '2026-03-11', abandoned: true })
    expect(monthTaskStats([doneTask, abandonedTask], 2026, 3)).toEqual({ total: 1, done: 1, rate: 100 })
  })

  it('首页「今日计划」不含 held（哪怕它的日期就是今天），逾期数也不数它', () => {
    const result = selectHomePlan(
      [
        planRecord({ id: 'today-plain', title: '今天正常', date: TODAY }),
        planRecord({ id: 'today-held', title: '今天但标了未完成', date: TODAY, held: true }),
        planRecord({ id: 'overdue-plain', title: '普通逾期', date: '2026-03-10' }),
        planRecord({ id: 'overdue-held', title: '逾期的钉住', date: '2026-03-11', held: true })
      ],
      TODAY
    )
    expect(result.visible.map((item) => item.id)).toEqual(['today-plain'])
    expect(result.visible.map((item) => item.title)).not.toContain('今天但标了未完成')
    // 关注卡用的 overdue 数：只有普通那 1 条（held 不再催）
    expect(result.overdue).toBe(1)
  })
})

describe('逐条移动不受 held 限制（用户单独点它就是要动这一条）', () => {
  it('钉住的任务照样能算出"移动到指定日期"的补丁', () => {
    const held = task({ date: TODAY, held: true, carriedOver: 0 })
    const patch = taskDateMovePatch(held, TARGET)
    expect(patch).toEqual({ date: TARGET, carriedOver: 1 })
  })

  it('批量移动不搬它、逐条移动搬得动 —— 两条路互不影响', () => {
    const held = task({ id: 'held', date: TODAY, held: true })
    expect(planDateMove([held], TODAY, TARGET).movable).toHaveLength(0)
    const after = { ...held, ...taskDateMovePatch(held, TARGET) }
    expect(after.date).toBe(TARGET)
    // 逐条搬运不改 held：它还是"未完成"
    expect(isHeld(after)).toBe(true)
  })

  it('搬完之后它仍在新的那一天被批量移动排除（held 语义不因搬动而失效）', () => {
    const held = task({ id: 'held', date: TODAY, held: true })
    const after = { ...held, ...taskDateMovePatch(held, TARGET) }
    expect(planDateMove([after], TARGET, '2026-11-01').movable).toHaveLength(0)
  })
})

// ===========================================================================
// D. 自动顺延没了，但 computeCarryover 本身保留（只不再自动调）
// ===========================================================================

describe('computeCarryover 仍然存在、逻辑没改（只是没有人自动调它了）', () => {
  it('仍然把"过去日期 + 未完成 + 非重复 + 非放弃"算成要顺延的', () => {
    const { moved } = computeCarryover(
      [task({ id: 'a', date: '2026-03-10' }), task({ id: 'b', date: TODAY })],
      TODAY
    )
    expect(moved.map((item) => item.id)).toEqual(['a'])
    expect(moved[0]).toMatchObject({ from: '2026-03-10', to: TODAY, carriedOver: 1 })
  })

  it('⚠️ 它对 held **不做**排除（这是刻意的：这一轮没改它的逻辑）', () => {
    const { moved } = computeCarryover([task({ id: 'held', date: '2026-03-10', held: true })], TODAY)
    // 只要"手动调一次顺延"，钉住的那条照样会被搬——它与批量移动是两条不同的路
    expect(moved.map((item) => item.id)).toEqual(['held'])
  })
})

// ===========================================================================
// E. 行上菜单：条件项「标记未完成 / 取消未完成标记」+「移动到指定日期…」
// ===========================================================================

function menuContext(overrides: Partial<TaskMenuContext> = {}): TaskMenuContext {
  const noop = (): void => undefined
  return {
    done: false,
    abandoned: false,
    held: false,
    recurrence: 'none',
    timeSlot: 'none',
    reviewScheduled: false,
    today: TODAY,
    tomorrow: '2026-03-16',
    onEdit: noop,
    onDelete: noop,
    onDuplicate: noop,
    onToggleDone: noop,
    onToggleAbandon: noop,
    onAdjustTime: noop,
    onChangeSlot: noop,
    onChangeRecurrence: noop,
    onSetReviewInDays: noop,
    onClearReview: noop,
    onMoveTo: noop,
    onToggleHold: noop,
    onMoveToDate: noop,
    ...overrides
  }
}

describe('taskMenuItems：held 那两项是条件项，且只长在"未完成"的任务上', () => {
  it('未完成 + 未钉住 → 有「标记未完成（不自动搬动）」，没有「取消未完成标记」', () => {
    const defs = taskMenuItems(menuContext())
    const ids = menuItemIds(defs)
    expect(ids).toContain('task-hold')
    expect(ids).not.toContain('task-unhold')
    const hold = defs.find((def) => def.id === 'task-hold')
    expect(hold?.label).toBe(TASK_HOLD_LABEL)
    expect(TASK_HOLD_LABEL).toBe('标记未完成（不自动搬动）')
    // 点之前就说清后果
    expect(hold?.hint).toBe(TASK_HOLD_HINT)
    expect(TASK_HOLD_HINT).toBe('批量移动会跳过它')
    // 不是破坏性操作
    expect(hold?.danger).toBeUndefined()
  })

  it('未完成 + 已钉住 → 换成「取消未完成标记」，也不再带 hint', () => {
    const defs = taskMenuItems(menuContext({ held: true }))
    const ids = menuItemIds(defs)
    expect(ids).toContain('task-unhold')
    expect(ids).not.toContain('task-hold')
    const unhold = defs.find((def) => def.id === 'task-unhold')
    expect(unhold?.label).toBe(TASK_UNHOLD_LABEL)
    expect(TASK_UNHOLD_LABEL).toBe('取消未完成标记')
    expect(unhold?.hint).toBeUndefined()
    expect(unhold?.danger).toBeUndefined()
  })

  it('已完成 / 已放弃的任务上，这两项一条都不出现', () => {
    for (const overrides of [{ done: true }, { abandoned: true }, { done: true, abandoned: true }]) {
      const ids = menuItemIds(taskMenuItems(menuContext(overrides)))
      expect(ids, JSON.stringify(overrides)).not.toContain('task-hold')
      expect(ids, JSON.stringify(overrides)).not.toContain('task-unhold')
      // 「移动到指定日期…」同样只长在未完成的任务上
      expect(ids, JSON.stringify(overrides)).not.toContain('task-move-to')
    }
  })

  it('未完成的任务上一定有「移动到指定日期…」，文案用省略号那种写法', () => {
    const defs = taskMenuItems(menuContext())
    const moveTo = defs.find((def) => def.id === 'task-move-to')
    expect(moveTo?.label).toBe(TASK_MOVE_TO_LABEL)
    expect(TASK_MOVE_TO_LABEL).toBe('移动到指定日期…')
  })

  it('两个 id 永不同时出现（同一次只出现一条）', () => {
    for (const held of [false, true]) {
      const ids = menuItemIds(taskMenuItems(menuContext({ held })))
      expect(ids.includes('task-hold') && ids.includes('task-unhold')).toBe(false)
    }
  })

  it('点它们走的是各自的回调（标记走 onToggleHold，逐条移动走 onMoveToDate）', () => {
    const calls: string[] = []
    const defs = taskMenuItems(
      menuContext({
        onToggleHold: () => calls.push('hold'),
        onMoveToDate: () => calls.push('move-to-date')
      })
    )
    defs.find((def) => def.id === 'task-hold')?.callbacks()
    defs.find((def) => def.id === 'task-move-to')?.callbacks()
    expect(calls).toEqual(['hold', 'move-to-date'])
  })

  it('「删除」仍是"操作段"的最后一项（新加的两项排在它前面）', () => {
    const ids = menuItemIds(taskMenuItems(menuContext()))
    const head = ids.filter(
      (id) =>
        !id.startsWith('task-review-') && !id.startsWith('task-slot-') && !id.startsWith('task-recurrence-')
    )
    expect(head[head.length - 1]).toBe('task-delete')
    expect(head.indexOf('task-hold')).toBeLessThan(head.indexOf('task-abandon'))
  })

  it('行上那个标签的文字就是「未完成」（不发明"已钉住"这种词）', () => {
    expect(PLAN_TASK_STATE_LABELS.pending).toBe('未完成')
  })
})
