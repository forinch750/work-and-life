/**
 * 树节点「移动 / 新增」落库逻辑的单测（第二轮 FEAT-006 / `docs\TASKS\02` §5.4 §六）
 *
 * 必测的两条边界（DoD 里点名了）：
 *   1. **跨 owner 移动被拒** —— 学习主题的章节不能跑到另一本书下面
 *   2. **移到自己的后代下被拒（防成环）** —— 否则那棵子树会从界面上凭空消失
 *
 * 这里除了调 `buildMovePatches`（走 tree.ts 的判据），还**独立复核**一遍
 * `canMove`：两套判据同时成立才算真的拒绝，避免"一处改了、另一处没跟上"。
 */
import { describe, expect, it } from 'vitest'
import {
  buildCreatePatch,
  buildMovePatches,
  canMove,
  nextOrderUnder,
  subtreeIds,
  type OwnedLite,
  type TreeLike
} from '../../src/shared/treeMove'

function node(
  id: string,
  parentId: string | null,
  order: number,
  extra: Partial<TreeLike> = {}
): TreeLike {
  return { id, ownerId: 'topic-1', parentId, order, title: id, done: false, ...extra }
}

/** 主题 topic-1 下的一棵三层树 + 另一棵树（book-9）的一个节点 */
function sample(): TreeLike[] {
  return [
    node('res', null, 0), // 资料（根）
    node('ch1', 'res', 0), // 章
    node('s11', 'ch1', 0), // 子章
    node('i111', 's11', 0), // 条目
    node('ch2', 'res', 1),
    node('other', null, 0, { ownerId: 'book-9' })
  ]
}

const asMoveInput = (nodes: TreeLike[]): TreeLike[] => nodes

describe('buildMovePatches 移动', () => {
  it('同级换位置：只回 parentId 与 order 两个字段，不动标题', () => {
    const outcome = buildMovePatches(asMoveInput(sample()), 'ch2', 'res', 0)
    expect(outcome.ok).toBe(true)
    const ch2 = outcome.patches.find((patch) => patch.id === 'ch2')
    expect(ch2?.patch).toEqual({ parentId: 'res', order: 0 })
    // 补丁里绝不能带上 title / done，否则会把节点的其它字段覆盖掉
    for (const patch of outcome.patches) {
      expect(Object.keys(patch.patch).sort()).toEqual(['order', 'parentId'])
    }
  })

  it('移动后同级 order 连续无空洞', () => {
    const outcome = buildMovePatches(asMoveInput(sample()), 'i111', 'ch1', 0)
    const orders = outcome.patches
      .filter((patch) => patch.patch['parentId'] === 'ch1')
      .map((patch) => Number(patch.patch['order']))
      .sort((a, b) => a - b)
    expect(orders).toEqual(orders.map((_value, index) => index))
  })

  it('把节点提为顶层（parentId 为 null）', () => {
    const outcome = buildMovePatches(asMoveInput(sample()), 's11', null, 1)
    expect(outcome.ok).toBe(true)
    expect(outcome.patches.find((patch) => patch.id === 's11')?.patch['parentId']).toBeNull()
  })

  it('**拒绝跨 owner 移动**，且一条补丁都不产出', () => {
    const outcome = buildMovePatches(asMoveInput(sample()), 'ch1', 'other', 0)
    expect(outcome.ok).toBe(false)
    expect(outcome.reason).not.toBeNull()
    expect(outcome.patches).toEqual([])
  })

  it('**拒绝移到自己的后代下**（防成环），且一条补丁都不产出', () => {
    const outcome = buildMovePatches(asMoveInput(sample()), 'res', 'i111', 0)
    expect(outcome.ok).toBe(false)
    expect(outcome.patches).toEqual([])
  })

  it('找不到节点时失败，而不是抛错', () => {
    expect(buildMovePatches(asMoveInput(sample()), '不存在', null, 0).ok).toBe(false)
    expect(buildMovePatches(asMoveInput(sample()), 'ch1', '不存在', 0).ok).toBe(false)
  })
})

describe('canMove 独立复核两条边界', () => {
  const lite: OwnedLite[] = sample().map((item) => ({
    id: item.id,
    ownerId: item.ownerId,
    parentId: item.parentId,
    order: item.order
  }))

  it('同一棵树内移动 → 允许', () => {
    expect(canMove(lite, 'ch2', 'ch1')).toEqual({ ok: true, reason: null })
    expect(canMove(lite, 'ch1', null)).toEqual({ ok: true, reason: null })
  })

  it('跨 owner → 拒绝', () => {
    const result = canMove(lite, 'ch1', 'other')
    expect(result.ok).toBe(false)
    expect(result.reason).toContain('跨')
  })

  it('反方向跨 owner 也拒绝（另一棵树不能塞进来）', () => {
    const result = canMove(lite, 'other', 'res')
    expect(result.ok).toBe(false)
    expect(result.reason).toContain('跨')
  })

  it('移到自己下面 → 拒绝', () => {
    expect(canMove(lite, 'ch1', 'ch1').ok).toBe(false)
  })

  it('移到自己的后代下 → 拒绝', () => {
    const result = canMove(lite, 'res', 'i111')
    expect(result.ok).toBe(false)
    expect(result.reason).toContain('子节点')
  })

  it('深层后代也算（res → s11 也一样拒绝）', () => {
    expect(canMove(lite, 'res', 's11').ok).toBe(false)
  })
})

describe('buildCreatePatch 新增节点', () => {
  it('写全 kind/ownerId/parentId/order/title/done，不带 id 与时间戳', () => {
    const patch = buildCreatePatch({
      ownerId: 'topic-1',
      parentId: 'res',
      order: 2,
      title: '  第 3 章  '
    })
    expect(patch).toEqual({
      kind: 'node',
      ownerId: 'topic-1',
      parentId: 'res',
      order: 2,
      title: '第 3 章',
      done: false
    })
    expect('id' in patch).toBe(false)
    expect('createdAt' in patch).toBe(false)
  })

  it('附加字段（占比 / 分组名）带上', () => {
    const patch = buildCreatePatch({
      ownerId: 'topic-1',
      parentId: null,
      order: 0,
      title: '《语法俱乐部》',
      extra: { percent: 50, resourceType: '书' }
    })
    expect(patch['percent']).toBe(50)
    expect(patch['resourceType']).toBe('书')
    expect(patch['parentId']).toBeNull()
  })

  it('新节点一定是"没勾"的（不能继承父节点的完成状态）', () => {
    const patch = buildCreatePatch({ ownerId: 'o', parentId: 'p', order: 0, title: 'x' })
    expect(patch['done']).toBe(false)
  })
})

describe('nextOrderUnder 同级末尾', () => {
  it('空父级从 0 开始', () => {
    expect(nextOrderUnder([], 'topic-1', null)).toBe(0)
  })

  it('取最大 order 加一', () => {
    const lite = sample().map((item) => ({
      id: item.id,
      ownerId: item.ownerId,
      parentId: item.parentId,
      order: item.order
    }))
    expect(nextOrderUnder(lite, 'topic-1', 'res')).toBe(2)
    expect(nextOrderUnder(lite, 'topic-1', null)).toBe(1)
  })

  it('别的 owner 的节点不参与计算（各棵树各建各的）', () => {
    const lite: OwnedLite[] = [
      { id: 'a', ownerId: 'topic-1', parentId: null, order: 0 },
      { id: 'b', ownerId: 'book-9', parentId: null, order: 7 }
    ]
    expect(nextOrderUnder(lite, 'topic-1', null)).toBe(1)
    expect(nextOrderUnder(lite, 'book-9', null)).toBe(8)
  })
})

describe('subtreeIds 删除前的整棵子树', () => {
  it('含自己与全部后代', () => {
    expect(subtreeIds(sample(), 'res').sort()).toEqual(['ch1', 'ch2', 'i111', 'res', 's11'])
  })

  it('最小单元只有自己', () => {
    expect(subtreeIds(sample(), 'i111')).toEqual(['i111'])
  })

  it('成环时不死循环', () => {
    const nodes = [node('x', 'y', 0), node('y', 'x', 0)]
    expect(() => subtreeIds(nodes, 'x')).not.toThrow()
  })
})
