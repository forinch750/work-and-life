/**
 * 树进度模型与缩进规则的单测（第二轮 FEAT-006 / `docs\TASKS\02` §5.2 §5.3）
 *
 * 覆盖的都是"错了会很难查、手点也未必发现"的情况：
 *   1. 汇总节点混进分母 —— 进度会凭空偏高
 *   2. 占比忘归一化 —— 用户填 5/3/2 与填 50/30/20 结果不一致
 *   3. 缩进规则 —— 第 5 层起必须收窄到 12px，否则深层文字被挤没
 *   4. 空树 / 单节点 / 全是汇总节点 —— 不能崩，也不能返回 NaN
 *
 * 环境是 `environment: 'node'`（没有 jsdom），所以 React 组件行为
 * 交给端到端验收（`src\main\verify\phase8.ts`），这里只测纯逻辑。
 */
import { describe, expect, it } from 'vitest'
import {
  INDENT_BASE,
  INDENT_NARROW,
  clampShare,
  descendantIdsOf,
  indentForDepth,
  isMinimalUnit,
  leafIds,
  leafProgress,
  progressText,
  shareOf,
  sharePercent,
  topicProgress,
  treeProgress,
  type TreeProgressItem
} from '../../src/shared/treeProgress'

function item(
  id: string,
  parentId: string | null,
  done = false,
  extra: Partial<TreeProgressItem> = {}
): TreeProgressItem {
  return { id, parentId, done, ...extra }
}

/**
 * §7.9 的实测例：
 *   资料A 占比 50，内部 3/7 完成
 *   资料B 占比 30，内部 0/2 完成
 *   资料C 占比 20，内部 2/2 完成
 */
function sample(): TreeProgressItem[] {
  return [
    item('A', null), // 资料（根）
    item('A1', 'A'), // 章（有子 → 汇总，不计数）
    item('A1a', 'A1', true), // 最小单元
    item('A1b', 'A1', true),
    item('A1c', 'A1', false),
    item('A2', 'A', true), // 最小单元
    item('A3', 'A', false),
    item('A4', 'A', true),
    item('B', null),
    item('B1', 'B', false),
    item('B2', 'B', false),
    item('C', null),
    item('C1', 'C', true),
    item('C2', 'C', true)
  ]
}

describe('indentForDepth 缩进规则（第 5 层起收窄到 12px）', () => {
  it('第 1–4 层每层 20px', () => {
    expect(indentForDepth(0)).toBe(0)
    expect(indentForDepth(1)).toBe(20)
    expect(indentForDepth(2)).toBe(40)
    expect(indentForDepth(3)).toBe(60)
    expect(indentForDepth(4)).toBe(80)
  })

  it('第 5 层起每层 12px（不砍层级）', () => {
    expect(indentForDepth(5)).toBe(92)
    expect(indentForDepth(6)).toBe(104)
    expect(indentForDepth(7)).toBe(116)
  })

  it('层数不限：第 20 层仍然算得出缩进且比第 19 层更深', () => {
    expect(indentForDepth(19)).toBeLessThan(indentForDepth(20))
    expect(indentForDepth(20)).toBeLessThan(indentForDepth(21))
  })

  it('收窄之后每一层的增量确实变小了', () => {
    const wideStep = indentForDepth(4) - indentForDepth(3)
    const narrowStep = indentForDepth(5) - indentForDepth(4)
    expect(wideStep).toBe(INDENT_BASE)
    expect(narrowStep).toBe(INDENT_NARROW)
    expect(narrowStep).toBeLessThan(wideStep)
  })

  it('非法深度不会返回 NaN 或负数', () => {
    expect(indentForDepth(-3)).toBe(0)
    expect(indentForDepth(2.7)).toBe(40)
  })
})

describe('clampShare / shareOf 占比', () => {
  it('任意正数都合法（用户填多少就是多少）', () => {
    expect(clampShare(50)).toBe(50)
    expect(clampShare(5)).toBe(5)
    expect(clampShare(0.5)).toBe(0.5)
    expect(clampShare('30')).toBe(30)
  })

  it('负数、非数字、空值都不合法', () => {
    expect(clampShare(-1)).toBeUndefined()
    expect(clampShare('abc')).toBeUndefined()
    expect(clampShare('')).toBeUndefined()
    expect(clampShare(null)).toBeUndefined()
    expect(clampShare(Number.NaN)).toBeUndefined()
  })

  it('没填或填 0 时按 1 计（没设占比的资料之间等权）', () => {
    expect(shareOf({})).toBe(1)
    expect(shareOf({ percent: 0 })).toBe(1)
    expect(shareOf({ percent: 7 })).toBe(7)
  })
})

describe('leafIds / isMinimalUnit 最小单元的判定', () => {
  it('没有子节点的才是最小单元', () => {
    const leaves = leafIds(sample())
    expect(leaves.has('A')).toBe(false) // 有子节点 → 汇总
    expect(leaves.has('A1')).toBe(false) // 有子节点 → 汇总
    expect(leaves.has('A1a')).toBe(true)
    expect(leaves.has('C')).toBe(false)
    expect(leaves.has('C1')).toBe(true)
  })

  it('父级不存在的孤儿节点自己就是最小单元（不能因为坏数据漏掉）', () => {
    const nodes = [item('orphan', '不存在')]
    expect(leafIds(nodes).has('orphan')).toBe(true)
    expect(isMinimalUnit(nodes, 'orphan')).toBe(true)
  })
})

describe('leafProgress 内部完成度（只算最小单元）', () => {
  it('汇总节点不参与计数', () => {
    const nodes = sample()
    // A 下最小单元 6 个：A1a A1b A1c A2 A3 A4；其中完成的是 A1a A1b A2 A4 = 4 个
    expect(leafProgress(nodes, 'A')).toEqual({ done: 4, total: 6, percent: 67 })
  })

  it('父节点自己勾了也不算数（它只是汇总）', () => {
    const nodes = [item('P', null, true), item('C1', 'P', false)]
    expect(leafProgress(nodes, 'P')).toEqual({ done: 0, total: 1, percent: 0 })
  })

  it('没有子节点的节点就是它自己', () => {
    expect(leafProgress(sample(), 'A1a')).toEqual({ done: 1, total: 1, percent: 100 })
  })

  it('全是汇总节点（没有最小单元）时取 0 而不是 NaN', () => {
    // 成环的坏数据：两个节点互为父子，谁也不在"无子节点"里
    const nodes = [item('x', 'y'), item('y', 'x')]
    expect(leafProgress(nodes, 'x')).toEqual({ done: 0, total: 0, percent: 0 })
  })

  it('找不到的 id 不会抛错', () => {
    expect(leafProgress(sample(), '不存在')).toEqual({ done: 0, total: 0, percent: 0 })
  })
})

describe('treeProgress 整棵树的最小单元统计', () => {
  it('只数最小单元', () => {
    // 最小单元：A1a A1b A1c A2 A3 A4 B1 B2 C1 C2 = 10 个，其中完成 6 个
    expect(treeProgress(sample())).toEqual({ done: 6, total: 10, percent: 60 })
  })

  it('空树取 0', () => {
    expect(treeProgress([])).toEqual({ done: 0, total: 0, percent: 0 })
  })

  it('单节点：勾了就是 100%', () => {
    expect(treeProgress([item('only', null, true)])).toEqual({ done: 1, total: 1, percent: 100 })
    expect(treeProgress([item('only', null, false)])).toEqual({ done: 0, total: 1, percent: 0 })
  })
})

describe('topicProgress 主题进度（占比自动归一化）', () => {
  const nodes = sample()
  const roots = [
    { id: 'A', parentId: null, done: false, percent: 50 },
    { id: 'B', parentId: null, done: false, percent: 30 },
    { id: 'C', parentId: null, done: false, percent: 20 }
  ]

  it('§7.9 的实测例：50/30/20 与 43%/0%/100% → 42%', () => {
    // 本样本的内部完成度：A=67%（4/6）、B=0%、C=100%
    // (50×67 + 30×0 + 20×100) ÷ 100 = 53.5 → 54
    // 文档里那个 42% 用的是"43%"那组数，下面单独再对一次
    expect(topicProgress(nodes, roots)).toBe(54)
  })

  it('文档原例：占比 50/30/20，内部 43%/0%/100% → 42%', () => {
    // 直接构造 43% 的内部完成度：100 个最小单元里 43 个完成
    const many: TreeProgressItem[] = [item('A', null), item('B', null), item('C', null)]
    for (let i = 0; i < 100; i += 1) many.push(item(`a${i}`, 'A', i < 43))
    many.push(item('b1', 'B', false))
    many.push(item('c1', 'C', true))
    const result = topicProgress(many, [
      { id: 'A', parentId: null, done: false, percent: 50 },
      { id: 'B', parentId: null, done: false, percent: 30 },
      { id: 'C', parentId: null, done: false, percent: 20 }
    ])
    expect(result).toBe(42)
  })

  it('占比自动归一化：填 5/3/2 与填 50/30/20 结果一致', () => {
    const big = topicProgress(nodes, roots)
    const small = topicProgress(nodes, [
      { id: 'A', parentId: null, done: false, percent: 5 },
      { id: 'B', parentId: null, done: false, percent: 3 },
      { id: 'C', parentId: null, done: false, percent: 2 }
    ])
    expect(small).toBe(big)
  })

  it('不必凑满 100：填 1/1/1 就是等权平均', () => {
    const equal = topicProgress(nodes, [
      { id: 'A', parentId: null, done: false, percent: 1 },
      { id: 'B', parentId: null, done: false, percent: 1 },
      { id: 'C', parentId: null, done: false, percent: 1 }
    ])
    // (67 + 0 + 100) / 3 = 55.67 → 56
    expect(equal).toBe(56)
  })

  it('一份资料独占全部占比时，主题进度就是它自己的完成度', () => {
    const single = [item('A', null), item('A1', 'A', true), item('A2', 'A', false)]
    expect(topicProgress(single, [{ id: 'A', parentId: null, done: false, percent: 50 }])).toBe(50)
  })

  it('空树 / 没有任何资料 → 0（不是 NaN）', () => {
    expect(topicProgress([], [])).toBe(0)
    expect(topicProgress([], [{ id: 'x', parentId: null, done: false, percent: 50 }])).toBe(0)
  })

  it('全是汇总节点（没有最小单元）→ 0', () => {
    const nodes2 = [item('P', null), item('C1', 'P', true)]
    // C1 是最小单元，勾了 → 100；这里验证"父节点自己不算"
    expect(topicProgress(nodes2, [{ id: 'P', parentId: null, done: false, percent: 3 }])).toBe(100)
  })
})

describe('progressText 资料行的两个数字', () => {
  it('按 §5.2 的格式输出占比与已学', () => {
    const nodes = sample()
    const text = progressText(50, [50, 30, 20], leafProgress(nodes, 'A'))
    expect(text).toBe('占比 50% · 已学 67%（4/6）')
  })

  it('占比归一化后显示：填 5/3/2 时第一份显示 50%', () => {
    expect(sharePercent(5, [5, 3, 2])).toBe(50)
    expect(sharePercent(3, [5, 3, 2])).toBe(30)
    expect(sharePercent(2, [5, 3, 2])).toBe(20)
  })

  it('占比之和为 0 时取 0，不返回 NaN', () => {
    expect(sharePercent(5, [0, 0])).toBe(0)
    expect(sharePercent(5, [])).toBe(0)
  })

  it('没有最小单元时显示 0/0', () => {
    expect(progressText(1, [1], { done: 0, total: 0, percent: 0 })).toBe('占比 100% · 已学 0%（0/0）')
  })
})

describe('descendantIdsOf 后代收集', () => {
  it('收集全部后代（不含自己）', () => {
    expect(descendantIdsOf(sample(), 'A').sort()).toEqual(['A1', 'A1a', 'A1b', 'A1c', 'A2', 'A3', 'A4'])
  })

  it('最小单元没有后代', () => {
    expect(descendantIdsOf(sample(), 'A1a')).toEqual([])
  })

  it('成环时不死循环', () => {
    const nodes = [item('x', 'y'), item('y', 'x')]
    expect(() => descendantIdsOf(nodes, 'x')).not.toThrow()
  })
})
