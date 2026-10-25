/**
 * 树界面的**纯逻辑**单测（第二轮 FEAT-006 / `docs\TASKS\02` §6.2）
 *
 *   1. `assembleRows` —— 平铺记录 → 要渲染的行（层级、同级下标、汇总/最小单元）
 *      容错口径必须与 `tree.ts` 的 `buildTree` 一致：坏数据不能让树消失
 *   2. `isRowVisible` —— 折叠之后子孙必须藏起来
 *   3. `resolveDropTarget` —— 拖拽落点 → `{ parentId, index }`
 *      "上/下边＝同级前后、行中间＝变成子节点"的语义只在这里定义一次
 *
 * React 组件本身的行为（点勾、折叠、就地展开）由端到端验收覆盖：
 * vitest 是 `environment: 'node'`，**不引入 jsdom / testing-library**。
 */
import { describe, expect, it } from 'vitest'
import {
  asTreeNodes,
  assembleRows,
  isRowVisible,
  resolveDropTarget,
  type TreeViewItem
} from '../../src/shared/treeView'

function item(id: string, parentId: string | null, order: number, extra: Partial<TreeViewItem> = {}): TreeViewItem {
  return { id, parentId, order, title: id, done: false, ...extra }
}

/** 资料 → 章 → 子章 → 条目 的四层树 */
function sample(): TreeViewItem[] {
  return [
    item('res', null, 0),
    item('ch1', 'res', 0),
    item('s11', 'ch1', 0),
    item('i111', 's11', 0),
    item('ch2', 'res', 1)
  ]
}

describe('assembleRows 平铺 → 渲染行', () => {
  it('按层级展开，深度从 0 起', () => {
    const rows = assembleRows(sample())
    expect(rows.map((row) => row.item.id)).toEqual(['res', 'ch1', 's11', 'i111', 'ch2'])
    expect(rows.map((row) => row.depth)).toEqual([0, 1, 2, 3, 1])
  })

  it('有子节点的算汇总，没有的算最小单元', () => {
    const rows = assembleRows(sample())
    const summaryOf = (id: string): boolean =>
      rows.find((row) => row.item.id === id)?.summary === true
    expect(summaryOf('res')).toBe(true)
    expect(summaryOf('ch1')).toBe(true)
    expect(summaryOf('s11')).toBe(true)
    expect(summaryOf('i111')).toBe(false)
    expect(summaryOf('ch2')).toBe(false)
  })

  it('同级按 order 排序，order 相同用 id 兜底（与 tree.ts 同规则）', () => {
    const rows = assembleRows([
      item('b', null, 1, { title: '乙' }),
      item('a', null, 0, { title: '甲' }),
      item('c', null, 1, { title: '丙' })
    ])
    expect(rows.map((row) => row.item.id)).toEqual(['a', 'b', 'c'])
  })

  it('同级下标连续，用于"上下移一位"', () => {
    const rows = assembleRows(sample())
    const ch1 = rows.find((row) => row.item.id === 'ch1')
    const ch2 = rows.find((row) => row.item.id === 'ch2')
    expect(ch1?.index).toBe(0)
    expect(ch2?.index).toBe(1)
    expect(ch1?.childCount).toBe(1)
  })

  it('父级不存在时提到顶层（坏数据不能让节点消失）', () => {
    const rows = assembleRows([item('orphan', '不存在', 0)])
    expect(rows).toHaveLength(1)
    expect(rows[0]?.depth).toBe(0)
    expect(rows[0]?.parentId).toBeNull()
  })

  it('成环时把环上的节点提到顶层，且不会无限递归', () => {
    const rows = assembleRows([item('a', 'b', 0), item('b', 'a', 0)])
    expect(rows.map((row) => row.item.id).sort()).toEqual(['a', 'b'])
    expect(rows.every((row) => row.depth === 0)).toBe(true)
  })

  it('三层以上的环也不会漏节点', () => {
    const rows = assembleRows([item('a', 'c', 0), item('b', 'a', 0), item('c', 'b', 0)])
    expect(rows).toHaveLength(3)
  })

  it('空输入得到空行', () => {
    expect(assembleRows([])).toEqual([])
  })

  it('层数不限：1.1.1.1 也能组装出来', () => {
    const nodes = [item('l1', null, 0)]
    for (let level = 2; level <= 8; level += 1) {
      nodes.push(item(`l${level}`, `l${level - 1}`, 0))
    }
    const rows = assembleRows(nodes)
    expect(rows).toHaveLength(8)
    expect(rows[7]?.depth).toBe(7)
  })
})

describe('resolveDropTarget 拖拽落点', () => {
  it('行中间 → 变成目标的子节点，排在现有子节点之后', () => {
    expect(resolveDropTarget(sample(), 'ch2', 'ch1', 'onto')).toEqual({
      parentId: 'ch1',
      index: 1
    })
  })

  it('行上边 → 与目标同级，插到它前面', () => {
    expect(resolveDropTarget(sample(), 'ch2', 'ch1', 'before')).toEqual({
      parentId: 'res',
      index: 0
    })
  })

  it('行下边 → 与目标同级，插到它后面', () => {
    expect(resolveDropTarget(sample(), 'ch2', 'ch1', 'after')).toEqual({
      parentId: 'res',
      index: 1
    })
  })

  it('拖到自己身上 → 返回 null（调用方据此不写盘）', () => {
    expect(resolveDropTarget(sample(), 'ch1', 'ch1', 'onto')).toBeNull()
  })

  it('目标不存在 → 返回 null', () => {
    expect(resolveDropTarget(sample(), 'ch1', '不存在', 'onto')).toBeNull()
  })

  it('计算下标时把自己排除，避免"插到自己前面"这种空操作', () => {
    // 把 ch2 拖到 ch1 下边：res 下排除 ch2 后只剩 ch1，所以插到下标 1（末尾）
    expect(resolveDropTarget(sample(), 'ch2', 'ch1', 'after')).toEqual({
      parentId: 'res',
      index: 1
    })
  })

  it('顶层之间拖动：parentId 为 null', () => {
    const nodes = [item('a', null, 0), item('b', null, 1), item('c', null, 2)]
    expect(resolveDropTarget(nodes, 'c', 'a', 'before')).toEqual({ parentId: null, index: 0 })
    expect(resolveDropTarget(nodes, 'c', 'a', 'after')).toEqual({ parentId: null, index: 1 })
  })
})

describe('isRowVisible 折叠后的可见性', () => {
  const nodes = sample()
  const byId = new Map(nodes.map((node) => [node.id, node]))

  it('默认全部可见（顶层都算可见）', () => {
    expect(isRowVisible(byId, nodes[0]!, new Set())).toBe(true)
  })

  it('父节点没展开时，子孙藏起来', () => {
    const expanded = new Set<string>()
    // res 没展开 → ch1 不可见
    expect(isRowVisible(byId, nodes[1]!, expanded)).toBe(false)
  })

  it('父节点展开后可见；祖父没展开时仍然藏起来', () => {
    const expanded = new Set(['res'])
    expect(isRowVisible(byId, nodes[1]!, expanded)).toBe(true)
    // s11 的父是 ch1，ch1 还没展开 → 藏
    expect(isRowVisible(byId, nodes[2]!, expanded)).toBe(false)
    expect(isRowVisible(byId, nodes[2]!, new Set(['res', 'ch1']))).toBe(true)
  })

  it('父级不存在（坏数据已被提到顶层）时照常显示', () => {
    const orphan = item('orphan', '不存在', 0)
    expect(isRowVisible(new Map([[orphan.id, orphan]]), orphan, new Set())).toBe(true)
  })

  it('成环时不会死循环', () => {
    const a = item('a', 'b', 0)
    const b = item('b', 'a', 0)
    const map = new Map([
      [a.id, a],
      [b.id, b]
    ])
    expect(() => isRowVisible(map, a, new Set())).not.toThrow()
  })
})

describe('asTreeNodes 喂给 tree.ts 的形状', () => {
  it('补上 ownerId，其余字段原样', () => {
    const nodes = asTreeNodes([item('a', null, 0, { title: '第一章', done: true })], 'topic-1')
    expect(nodes).toEqual([
      { id: 'a', ownerId: 'topic-1', parentId: null, order: 0, title: '第一章', done: true }
    ])
  })
})
