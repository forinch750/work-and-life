/**
 * 树模型纯逻辑的单测（第二轮 FEAT-006）
 *
 * 重点覆盖三类"错了会很难查"的情况：
 *   1. 环 —— 让节点成为自己后代的子节点，子树会从界面上凭空消失
 *   2. 坏数据 —— parentId 指向不存在的节点，不能让节点跟着丢
 *   3. 跨 owner —— 学习主题的节点跑到另一本书下面
 */
import { describe, expect, it } from 'vitest'
import {
  buildTree,
  depthOf,
  descendantIds,
  flattenTree,
  moveNode,
  normalizeTreeNode,
  removeSubtree,
  reorderSiblings,
  subtreeProgress,
  type TreeNode
} from '../../src/shared/tree'

function node(
  id: string,
  parentId: string | null,
  order: number,
  extra: Partial<TreeNode> = {}
): TreeNode {
  return { id, ownerId: 'topic-1', parentId, order, title: id, done: false, ...extra }
}

/** 一棵典型的三层树：
 *  第一章
 *    1.1 小节
 *      1.1.1 条目
 *    1.2 小节
 *  第二章
 */
function sampleTree(): TreeNode[] {
  return [
    node('ch1', null, 0, { title: '第一章' }),
    node('s11', 'ch1', 0, { title: '1.1 小节' }),
    node('s12', 'ch1', 1, { title: '1.2 小节' }),
    node('i111', 's11', 0, { title: '1.1.1 条目' }),
    node('ch2', null, 1, { title: '第二章' })
  ]
}

describe('buildTree 组装', () => {
  it('按层级挂好子节点', () => {
    const roots = buildTree(sampleTree())
    expect(roots.map((r) => r.id)).toEqual(['ch1', 'ch2'])
    expect(roots[0]?.children.map((c) => c.id)).toEqual(['s11', 's12'])
    expect(roots[0]?.children[0]?.children.map((c) => c.id)).toEqual(['i111'])
  })

  it('同级按 order 排序；order 相同时用 id 稳定兜底', () => {
    const nodes = [
      node('b', null, 1, { title: '乙' }),
      node('a', null, 0, { title: '甲' }),
      node('c', null, 1, { title: '丙' })
    ]
    // order 0 的排最前；order 相同的 b、c 按 id 排，与标题无关
    expect(buildTree(nodes).map((n) => n.id)).toEqual(['a', 'b', 'c'])
  })

  it('改标题不会让节点换位置（order 才是位置的权威）', () => {
    const before = [node('x', null, 0, { title: '甲' }), node('y', null, 1, { title: '乙' })]
    const after = [node('x', null, 0, { title: '乙' }), node('y', null, 1, { title: '甲' })]
    expect(buildTree(before).map((n) => n.id)).toEqual(buildTree(after).map((n) => n.id))
  })

  it('parentId 指向不存在的节点时提升为顶层（不能丢）', () => {
    const nodes = [node('orphan', '不存在', 0)]
    const roots = buildTree(nodes)
    expect(roots).toHaveLength(1)
    expect(roots[0]?.id).toBe('orphan')
    expect(roots[0]?.parentId).toBeNull()
  })

  it('成环时把环上的节点提到顶层，不能无限递归', () => {
    // a 的父是 b，b 的父又是 a
    const nodes = [node('a', 'b', 0), node('b', 'a', 0)]
    const roots = buildTree(nodes)
    expect(roots.map((r) => r.id).sort()).toEqual(['a', 'b'])
  })

  it('只组装指定 owner 的节点', () => {
    const nodes = [node('mine', null, 0), { ...node('other', null, 0), ownerId: 'book-9' }]
    const roots = buildTree(nodes, 'topic-1')
    expect(roots.map((r) => r.id)).toEqual(['mine'])
  })

  it('空输入得到空森林', () => {
    expect(buildTree([])).toEqual([])
  })
})

describe('flattenTree 摊平', () => {
  it('往返一次结构不变', () => {
    const original = sampleTree()
    const restored = flattenTree(buildTree(original))
    expect(restored.map((n) => n.id).sort()).toEqual(original.map((n) => n.id).sort())
  })

  it('父节点一定排在子节点之前（便于渲染与写盘）', () => {
    const flat = flattenTree(buildTree(sampleTree()))
    const index = new Map(flat.map((n, i) => [n.id, i]))
    for (const n of flat) {
      if (n.parentId === null) continue
      expect(index.get(n.parentId)!).toBeLessThan(index.get(n.id)!)
    }
  })

  it('摊平结果不再带 children 字段', () => {
    const flat = flattenTree(buildTree(sampleTree()))
    for (const n of flat) expect('children' in n).toBe(false)
  })
})

describe('descendantIds 与 depthOf', () => {
  it('取全部后代（不含自己）', () => {
    const ids = descendantIds(sampleTree(), 'ch1')
    expect(ids.sort()).toEqual(['i111', 's11', 's12'])
  })

  it('叶子节点没有后代', () => {
    expect(descendantIds(sampleTree(), 'i111')).toEqual([])
  })

  it('深度：顶层为 0', () => {
    const nodes = sampleTree()
    expect(depthOf(nodes, 'ch1')).toBe(0)
    expect(depthOf(nodes, 's11')).toBe(1)
    expect(depthOf(nodes, 'i111')).toBe(2)
  })

  it('成环时不会死循环', () => {
    const nodes = [node('a', 'b', 0), node('b', 'a', 0)]
    expect(() => depthOf(nodes, 'a')).not.toThrow()
  })
})

describe('moveNode 移动（防成环是关键）', () => {
  it('把节点移到另一个父级下', () => {
    const result = moveNode(sampleTree(), 's12', null, 0)
    expect(result.ok).toBe(true)
    const patch = result.patches.find((p) => p.id === 's12')
    expect(patch?.parentId).toBeNull()
  })

  it('拒绝把节点移到自己的后代下（否则子树会消失）', () => {
    const result = moveNode(sampleTree(), 'ch1', 'i111', 0)
    expect(result.ok).toBe(false)
    expect(result.reason).toContain('子节点')
    expect(result.patches).toEqual([])
  })

  it('拒绝把节点移到它自己下面', () => {
    const result = moveNode(sampleTree(), 'ch1', 'ch1', 0)
    expect(result.ok).toBe(false)
    expect(result.reason).toContain('自己')
  })

  it('拒绝跨 owner 移动', () => {
    const nodes = [...sampleTree(), { ...node('foreign', null, 0), ownerId: 'book-9' }]
    const result = moveNode(nodes, 'ch1', 'foreign', 0)
    expect(result.ok).toBe(false)
    expect(result.reason).toContain('另一个计划')
  })

  it('找不到节点或目标父级时失败，而不是抛错', () => {
    expect(moveNode(sampleTree(), '不存在', null, 0).ok).toBe(false)
    expect(moveNode(sampleTree(), 'ch1', '不存在', 0).ok).toBe(false)
  })

  it('插入位置会被夹到合法范围内', () => {
    const tooBig = moveNode(sampleTree(), 's12', null, 999)
    expect(tooBig.ok).toBe(true)
    const s12 = tooBig.patches.find((p) => p.id === 's12')
    // 顶层原有 ch1、ch2 两个（排除自己），夹到末尾即 order=2
    expect(s12?.order).toBe(2)
  })

  it('移动后同级 order 连续无空洞', () => {
    const result = moveNode(sampleTree(), 'i111', 'ch1', 0)
    expect(result.ok).toBe(true)
    const orders = result.patches.map((p) => p.order).sort((a, b) => a - b)
    expect(orders).toEqual(orders.map((_v, i) => i))
  })

  it('移动带子树的节点时，子节点仍然跟着它', () => {
    // s11 带着 i111 一起移到顶层
    const result = moveNode(sampleTree(), 's11', null, 1)
    expect(result.ok).toBe(true)
    expect(result.patches.find((p) => p.id === 's11')?.parentId).toBeNull()
    // i111 的父级没被动过
    expect(sampleTree().find((n) => n.id === 'i111')?.parentId).toBe('s11')
  })
})

describe('reorderSiblings 同级重排', () => {
  it('按给定顺序重排', () => {
    const patches = reorderSiblings(sampleTree(), 'ch1', ['s12', 's11'])
    expect(patches).toEqual([
      { id: 's12', order: 0 },
      { id: 's11', order: 1 }
    ])
  })

  it('忽略不属于该父级的 id（不能靠重排偷偷换父级）', () => {
    const patches = reorderSiblings(sampleTree(), 'ch1', ['s11', 'ch2'])
    expect(patches.map((p) => p.id)).toEqual(['s11'])
  })

  it('顶层重排也支持 parentId 为 null', () => {
    const patches = reorderSiblings(sampleTree(), null, ['ch2', 'ch1'])
    expect(patches).toEqual([
      { id: 'ch2', order: 0 },
      { id: 'ch1', order: 1 }
    ])
  })
})

describe('removeSubtree 整棵删除', () => {
  it('连同全部后代一起', () => {
    const result = removeSubtree(sampleTree(), 'ch1')
    expect(result.ids.sort()).toEqual(['ch1', 'i111', 's11', 's12'])
    expect(result.descendantCount).toBe(3)
  })

  it('叶子节点只删自己', () => {
    const result = removeSubtree(sampleTree(), 'i111')
    expect(result.ids).toEqual(['i111'])
    expect(result.descendantCount).toBe(0)
  })
})

describe('subtreeProgress 进度统计', () => {
  it('统计子树里已完成数与总数', () => {
    const nodes = sampleTree().map((n) => (n.id === 's11' ? { ...n, done: true } : n))
    expect(subtreeProgress(nodes, 'ch1')).toEqual({ done: 1, total: 4 })
    expect(subtreeProgress(nodes, 'ch2')).toEqual({ done: 0, total: 1 })
  })
})

describe('normalizeTreeNode 宽容规范化', () => {
  it('正常记录原样通过', () => {
    const result = normalizeTreeNode({
      id: 'a',
      ownerId: 'topic-1',
      parentId: 'b',
      order: 2,
      title: ' 标题 ',
      done: true
    })
    expect(result).toEqual({
      id: 'a',
      ownerId: 'topic-1',
      parentId: 'b',
      order: 2,
      title: '标题',
      done: true
    })
  })

  it('缺 id 或 ownerId 时返回 null（无法归属的节点没有意义）', () => {
    expect(normalizeTreeNode({ ownerId: 'x' })).toBeNull()
    expect(normalizeTreeNode({ id: 'a' })).toBeNull()
  })

  it('parentId 为空字符串按顶层处理', () => {
    expect(normalizeTreeNode({ id: 'a', ownerId: 'o', parentId: '' })?.parentId).toBeNull()
  })

  it('自己当自己的父级按顶层处理', () => {
    expect(normalizeTreeNode({ id: 'a', ownerId: 'o', parentId: 'a' })?.parentId).toBeNull()
  })

  it('order 非法时归零，负数也归零', () => {
    expect(normalizeTreeNode({ id: 'a', ownerId: 'o', order: 'x' })?.order).toBe(0)
    expect(normalizeTreeNode({ id: 'a', ownerId: 'o', order: -5 })?.order).toBe(0)
  })

  it('done 只有严格 true 才算完成', () => {
    expect(normalizeTreeNode({ id: 'a', ownerId: 'o', done: 'true' })?.done).toBe(false)
    expect(normalizeTreeNode({ id: 'a', ownerId: 'o', done: 1 })?.done).toBe(false)
  })
})
