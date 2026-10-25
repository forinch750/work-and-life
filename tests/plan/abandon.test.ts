/**
 * 修改 4 轮测试：计划任务的第三态「放弃」
 *
 * ## 用户原话
 *
 * 「计划，我要能**手动添加未完成和放弃两个选项**（和逾期功能不相关）。」
 *
 * 已确认的两个决定（`修改-4.md` §4）：
 *   1. 三态：未完成 / 已完成 / **放弃**（不是在现有基础上加个开关）
 *   2. 放弃**彻底退出统计与顺延**：不算逾期、不再自动顺延、不计入完成率；
 *      单独一组「已放弃」收着，但在「全部」里查得到、能恢复
 *
 * ## 这一组钉住的三类东西
 *
 *   A. **数据形状**：`abandoned?: boolean`（可选）→ 旧记录零改写、没有迁移；
 *      `normalizePlanTask` 强保证 `abandoned ⇒ done === false`；
 *      `planTaskStateOf` 三态派生正确
 *   B. **退出统计的五处**：逾期 / 顺延 / 完成率（**分母**）/ 页头三处统计 / 列表分组
 *   C. **重复任务**：放弃之后不再生成下一次
 *
 * vitest 是 `environment: 'node'`（没有 jsdom），所以测的都是纯函数；
 * DOM 上的灰显、标签、`data-state` 与菜单点击交给端到端 `P8-Z3` ~ `P8-Z6`。
 */
import { describe, expect, it } from 'vitest'
import {
  PLAN_TASK_STATE_LABELS,
  UNSCHEDULED,
  isAbandoned,
  normalizePlanTask,
  planTaskStateOf,
  type PlanTask
} from '../../src/shared/plan'
import {
  computeCarryover,
  countForHeader,
  expandRecurrenceForDay,
  groupForToday,
  isOverdue,
  partitionAbandoned
} from '../../src/shared/planLogic'
import { monthTaskStats } from '../../src/renderer/modules/calendar/yearGrid'
import { taskMenuItems, menuItemIds } from '../../src/shared/contextMenu'

const TODAY = '2026-02-14'
const WEEK = [
  '2026-02-09',
  '2026-02-10',
  '2026-02-11',
  '2026-02-12',
  '2026-02-13',
  '2026-02-14',
  '2026-02-15'
]

let seq = 0
function task(partial: Partial<PlanTask> = {}): PlanTask {
  seq += 1
  return {
    id: partial.id ?? `a${seq}`,
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
    ...(partial.note ? { note: partial.note } : {}),
    ...(partial.seriesId ? { seriesId: partial.seriesId } : {})
  }
}

// ===========================================================================
// A. 数据形状
// ===========================================================================

describe('planTaskStateOf：三态派生（唯一一处把 done / abandoned 翻成状态）', () => {
  it('未放弃 + 未完成 = pending', () => {
    expect(planTaskStateOf({ done: false })).toBe('pending')
    expect(planTaskStateOf({ done: false, abandoned: false })).toBe('pending')
  })

  it('未放弃 + 已完成 = done', () => {
    expect(planTaskStateOf({ done: true })).toBe('done')
    expect(planTaskStateOf({ done: true, abandoned: false })).toBe('done')
  })

  it('放弃 = abandoned（不管 done 是什么）', () => {
    expect(planTaskStateOf({ done: false, abandoned: true })).toBe('abandoned')
    // 坏数据（两个都为 true）也按"已放弃"算，与 normalizePlanTask 的强制结果一致
    expect(planTaskStateOf({ done: true, abandoned: true })).toBe('abandoned')
  })

  it('三态的文案唯一一份', () => {
    expect(PLAN_TASK_STATE_LABELS).toEqual({
      pending: '未完成',
      done: '已完成',
      abandoned: '已放弃'
    })
  })

  it('isAbandoned 只认严格的 true（宽容读盘）', () => {
    expect(isAbandoned({ abandoned: true })).toBe(true)
    expect(isAbandoned({ abandoned: false })).toBe(false)
    expect(isAbandoned({})).toBe(false)
    expect(isAbandoned({ abandoned: 'yes' as unknown as boolean })).toBe(false)
  })
})

describe('normalizePlanTask：互斥强保证 + 旧记录零改写', () => {
  it('abandoned:true 时 done 被强制为 false、doneAt 被清空', () => {
    const result = normalizePlanTask({
      id: 'x',
      title: '两个都为 true 的坏数据',
      done: true,
      doneAt: '2026-02-14T09:00:00.000Z',
      abandoned: true,
      updatedAt: '2026-02-14T10:00:00.000Z'
    })
    expect(result.abandoned).toBe(true)
    expect(result.done).toBe(false)
    expect(result.doneAt).toBeNull()
    // 三态派生也必然是 abandoned
    expect(planTaskStateOf(result)).toBe('abandoned')
  })

  it('abandoned:false 与没有该字段等价（都不会写出这个键）', () => {
    const explicitFalse = normalizePlanTask({ id: 'y', title: '没放弃', abandoned: false, done: true })
    const missing = normalizePlanTask({ id: 'z', title: '没放弃', done: true })
    expect('abandoned' in explicitFalse).toBe(false)
    expect('abandoned' in missing).toBe(false)
    expect(explicitFalse.done).toBe(true)
    expect(missing.done).toBe(true)
  })

  it('旧记录（完全没有 abandoned 字段）读进来 = 未放弃，且字段没有被补写', () => {
    const legacy = {
      id: 'legacy-1',
      title: '修改 3 轮之前建的任务',
      date: '2026-02-10',
      timeSlot: 'morning',
      recurrence: 'none',
      done: false,
      carriedOver: 2,
      doneAt: null,
      note: '旧备注',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-02T00:00:00.000Z'
    }
    const result = normalizePlanTask(legacy)
    expect(planTaskStateOf(result)).toBe('pending')
    expect(result.abandoned).toBeUndefined()
    // **零改写**：其它字段一个都没动（不需要注册迁移）
    expect(result).toMatchObject({
      id: 'legacy-1',
      title: '修改 3 轮之前建的任务',
      date: '2026-02-10',
      timeSlot: 'morning',
      done: false,
      carriedOver: 2,
      doneAt: null,
      note: '旧备注'
    })
  })

  it('规范化是幂等的：反复读同一条放弃记录，结果不变', () => {
    const once = normalizePlanTask({ id: 'q', title: '反复读', abandoned: true, done: true })
    const twice = normalizePlanTask(once as unknown as Record<string, unknown>)
    expect(twice).toEqual(once)
  })
})

// ===========================================================================
// B. 「放弃」退出的五处（少一处就等于没做）
// ===========================================================================

describe('第 1 处 · 逾期：放弃的任务永不算逾期', () => {
  it('昨天没做的任务算逾期，放弃之后不算', () => {
    const overdue = task({ id: 'o1', date: '2026-02-10' })
    expect(isOverdue(overdue, TODAY)).toBe(true)
    expect(isOverdue({ ...overdue, abandoned: true }, TODAY)).toBe(false)
  })

  it('放弃的「待安排」任务同样不逾期（本来也不算，口径一致）', () => {
    expect(isOverdue(task({ date: UNSCHEDULED, abandoned: true }), TODAY)).toBe(false)
  })
})

describe('第 2 处 · 顺延：放弃的任务不参与自动顺延', () => {
  it('computeCarryover 不会把放弃的任务搬回今天', () => {
    const pending = task({ id: 'keep', date: '2026-02-10' })
    const abandoned = task({ id: 'gone', date: '2026-02-10', abandoned: true })
    const { moved } = computeCarryover([pending, abandoned], TODAY)
    expect(moved.map((item) => item.id)).toEqual(['keep'])
  })

  it('全部放弃时一次顺延都不会发生', () => {
    const { moved } = computeCarryover(
      [task({ date: '2026-02-01', abandoned: true }), task({ date: '2026-02-05', abandoned: true })],
      TODAY
    )
    expect(moved).toHaveLength(0)
  })
})

describe('第 3 处 · 完成率：**分母排除放弃**（最容易做漏的一条）', () => {
  it('造 1 完成 + 1 未完成 = 50%；再放弃一项后仍是 50%（不是 33%）', () => {
    const base = [task({ id: 'd', date: '2026-02-03', done: true }), task({ id: 'p', date: '2026-02-04' })]
    const before = monthTaskStats(base, 2026, 2)
    expect(before).toEqual({ total: 2, done: 1, rate: 50 })

    const withAbandoned = [...base, task({ id: 'a', date: '2026-02-05', abandoned: true })]
    const after = monthTaskStats(withAbandoned, 2026, 2)
    // **分子分母都不算它**：total 仍是 2、rate 仍是 50%
    expect(after).toEqual({ total: 2, done: 1, rate: 50 })
    // 如果只排分子不排分母，就会退化成 33%（"我放弃了，完成率反而掉了"）——这里钉死不是那样
    expect(after.rate).not.toBe(33)
    expect(after.total).not.toBe(3)
  })

  it('按文档口径：1 完成 + 1 放弃 → 完成率 100%（分母只剩 1 项）', () => {
    const stats = monthTaskStats(
      [task({ id: 'd', date: '2026-02-03', done: true }), task({ id: 'a', date: '2026-02-04', abandoned: true })],
      2026,
      2
    )
    expect(stats).toEqual({ total: 1, done: 1, rate: 100 })
  })

  it('整月都放弃 → 该月 0 项、0%（不是 0 项却显示 33% 那种自相矛盾）', () => {
    const stats = monthTaskStats(
      [task({ date: '2026-02-03', abandoned: true }), task({ date: '2026-02-04', abandoned: true })],
      2026,
      2
    )
    expect(stats).toEqual({ total: 0, done: 0, rate: 0 })
  })

  it('放弃的任务不计入它所在的那一个月以外的地方（月份边界不变）', () => {
    const stats = monthTaskStats([task({ date: '2026-03-03', abandoned: true })], 2026, 2)
    expect(stats.total).toBe(0)
  })
})

describe('第 4 处 · 页头统计：逾期 / 今天 / 本周三处都不含放弃', () => {
  it('三处统计都跳过放弃的任务', () => {
    const counts = countForHeader(
      [
        task({ id: 'overdue', date: '2026-02-10' }), // 逾期且在周内
        task({ id: 'today', date: TODAY }),
        task({ id: 'week', date: '2026-02-15' }),
        // 下面三条都是"放弃"，一条都不该数进去
        task({ id: 'a-overdue', date: '2026-02-10', abandoned: true }),
        task({ id: 'a-today', date: TODAY, abandoned: true }),
        task({ id: 'a-week', date: '2026-02-15', abandoned: true })
      ],
      TODAY,
      WEEK
    )
    expect(counts).toEqual({ overdue: 1, today: 1, week: 3 })
  })

  it('全部放弃 → 三个数都是 0', () => {
    const counts = countForHeader(
      [
        task({ date: '2026-02-10', abandoned: true }),
        task({ date: TODAY, abandoned: true }),
        task({ date: '2026-02-15', abandoned: true })
      ],
      TODAY,
      WEEK
    )
    expect(counts).toEqual({ overdue: 0, today: 0, week: 0 })
  })
})

describe('第 5 处 · 列表分组：今天 / 本周不显示放弃的，「全部」里单独一组', () => {
  it('放弃的任务不进 groupForToday 的任何一组', () => {
    const groups = groupForToday(
      [
        task({ id: 'overdue', date: '2026-02-10' }),
        task({ id: 'today', date: TODAY }),
        task({ id: 'future', date: '2026-03-01' }),
        task({ id: 'none', date: UNSCHEDULED }),
        task({ id: 'done', date: TODAY, done: true, doneAt: '2026-02-14T09:00:00.000Z' }),
        // 四种"位置"都放弃一遍：一条都不该出现
        task({ id: 'a-overdue', date: '2026-02-10', abandoned: true }),
        task({ id: 'a-today', date: TODAY, abandoned: true }),
        task({ id: 'a-future', date: '2026-03-01', abandoned: true }),
        task({ id: 'a-none', date: UNSCHEDULED, abandoned: true })
      ],
      TODAY
    )
    expect(groups.overdue.map((item) => item.id)).toEqual(['overdue'])
    expect(groups.today.map((item) => item.id)).toEqual(['today'])
    expect(groups.upcoming.map((item) => item.id)).toEqual(['future'])
    expect(groups.unscheduled.map((item) => item.id)).toEqual(['none'])
    expect(groups.doneToday.map((item) => item.id)).toEqual(['done'])
  })

  it('partitionAbandoned 分出「全部」视图要的两拨（放弃的没丢，能查到）', () => {
    const split = partitionAbandoned([
      task({ id: 'a', date: '2026-02-10' }),
      task({ id: 'b', date: '2026-02-11', abandoned: true }),
      task({ id: 'c', date: '2026-02-12', done: true }),
      task({ id: 'd', date: TODAY, abandoned: true })
    ])
    expect(split.active.map((item) => item.id)).toEqual(['a', 'c'])
    expect(split.abandoned.map((item) => item.id)).toEqual(['b', 'd'])
  })

  it('没有放弃的任务时「已放弃」这一组是空的（界面就不画它）', () => {
    const split = partitionAbandoned([task({ id: 'a' }), task({ id: 'b', done: true })])
    expect(split.abandoned).toHaveLength(0)
    expect(split.active).toHaveLength(2)
  })
})

// ===========================================================================
// C. 重复任务
// ===========================================================================

describe('重复任务：放弃之后不再生成下一次（§7.3）', () => {
  const template = task({
    id: 'series-1',
    title: '每天背单词',
    recurrence: 'daily',
    date: '2026-02-01',
    seriesId: 'series-1'
  })

  it('没放弃的重复任务照常展开出今天这一条', () => {
    const result = expandRecurrenceForDay([template], [], TODAY)
    expect(result).toHaveLength(1)
    expect(result[0]).toMatchObject({ seriesId: 'series-1', date: TODAY, done: false })
  })

  it('放弃了的不再展开 —— 今天放弃，明天不会自己冒出来', () => {
    const abandoned = { ...template, abandoned: true }
    expect(expandRecurrenceForDay([abandoned], [], TODAY)).toHaveLength(0)
    // 后天也一样（不是"只挡一天"）
    expect(expandRecurrenceForDay([abandoned], [], '2026-02-20')).toHaveLength(0)
  })

  it('同一批里只挡住放弃的那一条，别的重复任务照旧', () => {
    const daily = task({ id: 'daily', title: '晨会', recurrence: 'daily', date: '2026-02-01' })
    const abandoned = task({
      id: 'gone',
      title: '不做了',
      recurrence: 'daily',
      date: '2026-02-01',
      abandoned: true
    })
    const result = expandRecurrenceForDay([daily, abandoned], [], TODAY)
    expect(result.map((item) => item.seriesId)).toEqual(['daily'])
  })

  it('重复任务本来就不参与顺延（放弃与否都一样），不是靠 abandoned 才不重复', () => {
    const { moved } = computeCarryover(
      [task({ recurrence: 'daily', date: '2026-02-01' }), task({ recurrence: 'daily', date: '2026-02-01', abandoned: true })],
      TODAY
    )
    expect(moved).toHaveLength(0)
  })
})

// ===========================================================================
// 行上菜单：条件项「放弃这项 / 恢复为未完成」
// ===========================================================================

function menuContext(overrides: Record<string, unknown> = {}): Parameters<typeof taskMenuItems>[0] {
  const noop = (): void => undefined
  return {
    done: false,
    abandoned: false,
    held: false,
    recurrence: 'none',
    timeSlot: 'none',
    reviewScheduled: false,
    today: TODAY,
    tomorrow: '2026-02-15',
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
  } as Parameters<typeof taskMenuItems>[0]
}

describe('taskMenuItems：第三态是条件项（与 node-mark-done / node-mark-undone 同一套写法）', () => {
  it('未放弃 → 有「放弃这项」（危险项 + 分隔线），没有「恢复为未完成」', () => {
    const defs = taskMenuItems(menuContext())
    const ids = menuItemIds(defs)
    expect(ids).toContain('task-abandon')
    expect(ids).not.toContain('task-restore')
    const abandon = defs.find((def) => def.id === 'task-abandon')
    expect(abandon?.label).toBe('放弃这项')
    expect(abandon?.danger).toBe(true)
    expect(abandon?.separator).toBe(true)
  })

  it('已放弃 → 有「恢复为未完成」，没有「放弃这项」', () => {
    const defs = taskMenuItems(menuContext({ abandoned: true }))
    const ids = menuItemIds(defs)
    expect(ids).toContain('task-restore')
    expect(ids).not.toContain('task-abandon')
    const restore = defs.find((def) => def.id === 'task-restore')
    expect(restore?.label).toBe('恢复为未完成')
    // 恢复不是危险操作（数据还在，只是回到未完成）
    expect(restore?.danger).toBeUndefined()
  })

  it('两个 id 永不同时出现（同一次只出现一条，不会出现两个项映射到同一个动作）', () => {
    for (const abandoned of [false, true]) {
      const ids = menuItemIds(taskMenuItems(menuContext({ abandoned })))
      expect(ids.includes('task-abandon') && ids.includes('task-restore')).toBe(false)
    }
  })

  it('点「放弃这项」走的是同一个回调（onToggleAbandon）', () => {
    const received: string[] = []
    const defs = taskMenuItems(
      menuContext({ onToggleAbandon: () => received.push('toggle') })
    )
    defs.find((def) => def.id === 'task-abandon')?.callbacks()
    expect(received).toEqual(['toggle'])
    const restoreDefs = taskMenuItems(
      menuContext({ abandoned: true, onToggleAbandon: () => received.push('restore') })
    )
    restoreDefs.find((def) => def.id === 'task-restore')?.callbacks()
    expect(received).toEqual(['toggle', 'restore'])
  })

  it('「删除」仍是"操作段"的最后一项（放弃排在它前面，不抢"最危险"的位置）', () => {
    const ids = menuItemIds(taskMenuItems(menuContext()))
    // 后面还会追加"分组菜单"（设置复习时间 / 时段 / 重复），这里只看前面那一段操作
    const head = ids.filter(
      (id) =>
        !id.startsWith('task-review-') &&
        !id.startsWith('task-slot-') &&
        !id.startsWith('task-recurrence-')
    )
    expect(head[head.length - 1]).toBe('task-delete')
    expect(head.indexOf('task-abandon')).toBeLessThan(head.indexOf('task-delete'))
    expect(head.indexOf('task-restore')).toBe(-1)
  })
})
