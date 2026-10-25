/**
 * 阶段 4 测试：首页今日计划的取数规则
 *
 * 直接对应 PRD §10.4：
 *   D2 今日计划最多显示 3 项；超过 3 项时出现"还有 N 项"
 *   D6 三项都为 0 时关注卡整块不显示（关注卡数据由这里提供）
 *
 * **修改 6 轮改写了两条既有断言的口径**（行为被推翻，不是放宽）：
 *   旧口径：首页今日计划 = 逾期 + 今天，逾期排前面（"与计划页一致"）
 *   新口径：首页今日计划 = **只今天**；逾期一条都不进来，归「需要你的关注」那张卡
 * 判据没有变松：新口径下还额外断言了"逾期那条的标题一次都不出现"。
 */
import { describe, expect, it } from 'vitest'
import type { RecordEnvelope } from '../../src/shared/types'
import { HOME_TODAY_LIMIT, selectHomePlan } from '../../src/renderer/modules/home/selectHomePlan'

const TODAY = '2026-02-14'
const YESTERDAY = '2026-02-13'

let seq = 0
function record(overrides: Record<string, unknown> = {}): RecordEnvelope {
  seq += 1
  return {
    id: `r${seq}`,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    title: `任务 ${seq}`,
    date: TODAY,
    timeSlot: 'none',
    recurrence: 'none',
    done: false,
    carriedOver: 0,
    doneAt: null,
    ...overrides
  } as RecordEnvelope
}

describe('selectHomePlan（对应 D2）', () => {
  it('上限是 3 项', () => {
    expect(HOME_TODAY_LIMIT).toBe(3)
  })

  it('不超过 3 项时不显示"还有 N 项"', () => {
    const result = selectHomePlan([record(), record(), record()], TODAY)
    expect(result.visible).toHaveLength(3)
    expect(result.hiddenCount).toBe(0)
  })

  it('超过 3 项时只显示 3 项，其余计入 hiddenCount', () => {
    const records = [record(), record(), record(), record(), record(), record(), record()]
    const result = selectHomePlan(records, TODAY)
    expect(result.visible).toHaveLength(3)
    expect(result.hiddenCount).toBe(4)
  })

  // ---- 修改 6 轮：首页清单**只含今天的**（原来这条断言的是"逾期排最前"） ----
  it('逾期任务一条都不进首页清单（只含今天的）', () => {
    const result = selectHomePlan(
      [
        record({ title: '昨天的事一', date: YESTERDAY }),
        record({ title: '昨天的事二', date: '2026-02-12' }),
        record({ title: '今天的事' })
      ],
      TODAY
    )
    expect(result.visible).toHaveLength(1)
    expect(result.visible[0]?.title).toBe('今天的事')
    expect(result.visible.map((task) => task.title)).not.toContain('昨天的事一')
    expect(result.visible.map((task) => task.title)).not.toContain('昨天的事二')
    // 逾期条数仍然数得出来（关注卡要用），只是不在这份清单里
    expect(result.overdue).toBe(2)
    expect(result.hiddenCount).toBe(0)
  })

  it('"还有 N 项"按今天的条数算，逾期不计入（原口径是"逾期 + 今天一起算进 3 项"）', () => {
    const records = [
      record({ title: '逾期1', date: '2026-02-12' }),
      record({ title: '逾期2', date: YESTERDAY }),
      record({ title: '今天1' }),
      record({ title: '今天2' }),
      record({ title: '今天3' }),
      record({ title: '今天4' }),
      record({ title: '今天5' })
    ]
    const result = selectHomePlan(records, TODAY)
    expect(result.visible.map((task) => task.title)).toEqual(['今天1', '今天2', '今天3'])
    expect(result.hiddenCount).toBe(2)
    expect(result.overdue).toBe(2)
  })

  it('今天一条没有时清单为空（逾期再多也不算、不崩）', () => {
    const result = selectHomePlan(
      [record({ title: '逾期一', date: '2026-02-12' }), record({ title: '逾期二', date: YESTERDAY })],
      TODAY
    )
    expect(result.visible).toEqual([])
    expect(result.hiddenCount).toBe(0)
    expect(result.overdue).toBe(2)
  })

  it('已完成、未来、待安排都不进首页今日计划', () => {
    const result = selectHomePlan(
      [
        record({ done: true, doneAt: '2026-02-14T09:00:00.000Z' }),
        record({ date: '2026-03-01' }),
        record({ date: 'unscheduled' })
      ],
      TODAY
    )
    expect(result.visible).toHaveLength(0)
    expect(result.hiddenCount).toBe(0)
  })

  it('软删除的记录不计入', () => {
    const result = selectHomePlan(
      [record(), record({ deletedAt: '2026-02-14T00:00:00.000Z' })],
      TODAY
    )
    expect(result.visible).toHaveLength(1)
  })

  it('缺少标题或 id 的记录被忽略（脏数据不该让首页崩）', () => {
    const result = selectHomePlan(
      [record({ title: '' }), record({ id: '' }), record({ title: '正常' })],
      TODAY
    )
    expect(result.visible).toHaveLength(1)
    expect(result.visible[0]?.title).toBe('正常')
  })

  it('空数据不会抛错', () => {
    expect(() => selectHomePlan([], TODAY)).not.toThrow()
    expect(selectHomePlan([], TODAY).visible).toEqual([])
  })
})
