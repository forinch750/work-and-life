/**
 * 进度模型的**公共实现**回归单测（第 08 块 §5.5 / §6.2）
 *
 * 为什么单独一份（`treeProgress.test.ts` 已经测了细节）：
 *
 * 02 块把 §7.9 的算法实现过一次，三处界面（学习 / 复习 / 读书）都要用它。
 * 08 块的要求是——**统一到一处实现，别再各写一遍**，并且拿"原公式"做回归保护：
 * 谁以后图快在页面里另写一段进度计算，只要与这份参考实现算出来的数不一样，这里就会红。
 *
 * 参考实现 `referenceTopicProgress` 是**照着 `MASTER.md` §7.9 的文字**直接写的，
 * 不复用被测代码的任何一行 —— 它自己独立地数"最小单元"、独立地加权归一化。
 *
 * 环境是 `environment: 'node'`（没有 jsdom）：纯逻辑在这里测，
 * 组件行为交给端到端验收（`src\main\verify\phase8.ts` 的 P8-L1…）。
 */
import { describe, expect, it } from 'vitest'
import {
  leafIds,
  leafProgress,
  progressText,
  shareOf,
  sharePercent,
  topicProgress,
  treeProgress,
  type TreeProgressItem
} from '../../src/shared/treeProgress'
import { chapterProgress, type ReadingNode } from '../../src/shared/reading'

type Node = TreeProgressItem & { percent?: number }

function item(
  id: string,
  parentId: string | null,
  done = false,
  percent?: number
): Node {
  return percent === undefined ? { id, parentId, done } : { id, parentId, done, percent }
}

// ===========================================================================
// 照 §7.9 的文字独立写一遍（回归基准，**不许**调用被测实现）
// ===========================================================================

/**
 * 资料内部完成度 = 已完成最小单元 / 最小单元总数。
 *
 * "最小单元 = 没有子节点的节点"：这里直接数"该子树里没有孩子的节点"，
 * 与实现里那套 `leafIds` 无关。
 */
function referenceLeafProgress(
  items: Node[],
  id: string
): { done: number; total: number; percent: number } {
  const childrenOf = new Map<string, Node[]>()
  for (const node of items) {
    if (node.parentId === null) continue
    const list = childrenOf.get(node.parentId) ?? []
    list.push(node)
    childrenOf.set(node.parentId, list)
  }
  let done = 0
  let total = 0
  const stack: string[] = [id]
  const seen = new Set<string>()
  while (stack.length > 0) {
    const current = stack.pop()
    if (current === undefined || seen.has(current)) continue
    seen.add(current)
    const children = childrenOf.get(current) ?? []
    if (children.length === 0) {
      const node = items.find((candidate) => candidate.id === current)
      if (node === undefined) continue
      total += 1
      if (node.done) done += 1
      continue
    }
    for (const child of children) stack.push(child.id)
  }
  return { done, total, percent: total === 0 ? 0 : Math.round((done / total) * 100) }
}

/** 主题进度 = Σ(占比 × 资料内部完成度) ÷ Σ占比（占比自动归一化） */
function referenceTopicProgress(items: Node[], roots: Node[]): number {
  let weighted = 0
  let shares = 0
  for (const root of roots) {
    // 没填或填 0 → 按 1 计（"还不知道"，不是"不重要"）
    const share = root.percent === undefined || root.percent === 0 ? 1 : root.percent
    weighted += share * referenceLeafProgress(items, root.id).percent
    shares += share
  }
  if (shares <= 0) return 0
  return Math.round(weighted / shares)
}

/** 确定性伪随机（避免 flaky：同一个种子永远生成同一批树） */
function makeRandom(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0
    return state / 0x100000000
  }
}

/** 随机造一片"多根、层数不限、同一层既有子节点又能打勾"的森林 */
function randomForest(random: () => number): { items: Node[]; roots: Node[] } {
  const items: Node[] = []
  const roots: Node[] = []
  const rootCount = 1 + Math.floor(random() * 4)
  for (let rootIndex = 0; rootIndex < rootCount; rootIndex += 1) {
    const rootId = `r${rootIndex}`
    const percent = Math.floor(random() * 5) * 10 // 0 / 10 / 20 / 30 / 40
    const root: Node = { id: rootId, parentId: null, done: random() < 0.5, percent }
    items.push(root)
    roots.push(root)
    const childCount = Math.floor(random() * 5)
    for (let childIndex = 0; childIndex < childCount; childIndex += 1) {
      const child: Node = {
        id: `${rootId}-c${childIndex}`,
        parentId: rootId,
        done: random() < 0.5
      }
      items.push(child)
      if (random() < 0.4) {
        const grandCount = 1 + Math.floor(random() * 2)
        for (let grandIndex = 0; grandIndex < grandCount; grandIndex += 1) {
          items.push({
            id: `${child.id}-g${grandIndex}`,
            parentId: child.id,
            done: random() < 0.5
          })
        }
      }
    }
  }
  return { items, roots }
}

// ===========================================================================
// 1. 与"原公式"逐例一致（回归保护）
// ===========================================================================

describe('公共进度实现与原公式一致（回归保护）', () => {
  it('§7.9 的实测例：占比 50/30/20、内部 43%/0%/100% → 主题 42%', () => {
    // 资料A：7 个最小单元里完成 3 个 → 42.857% → 43%
    const items: Node[] = [
      item('A', null, false, 50),
      item('A1', 'A'),
      item('A1a', 'A1', true),
      item('A1b', 'A1', true),
      item('A1c', 'A1', false),
      item('A2', 'A', true),
      item('A3', 'A', false),
      item('A4', 'A', false),
      item('A5', 'A', false),
      // 资料B：2 个最小单元，都没完成 → 0%
      item('B', null, false, 30),
      item('B1', 'B', false),
      item('B2', 'B', false),
      // 资料C：2 个最小单元，都完成 → 100%
      item('C', null, false, 20),
      item('C1', 'C', true),
      item('C2', 'C', true)
    ]
    const roots = items.filter((node) => node.parentId === null)

    expect(leafProgress(items, 'A').percent).toBe(43)
    expect(leafProgress(items, 'A')).toMatchObject({ done: 3, total: 7 })
    expect(leafProgress(items, 'B').percent).toBe(0)
    expect(leafProgress(items, 'C').percent).toBe(100)

    // (50×43 + 30×0 + 20×100) ÷ 100 = 41.5 → 42
    expect(topicProgress(items, roots)).toBe(42)
    expect(referenceTopicProgress(items, roots)).toBe(42)
  })

  it('随机 200 片森林：实现与参考逐个一致', () => {
    const random = makeRandom(20261011)
    for (let round = 0; round < 200; round += 1) {
      const { items, roots } = randomForest(random)
      expect(topicProgress(items, roots), `第 ${round} 片森林`).toBe(
        referenceTopicProgress(items, roots)
      )
      for (const root of roots) {
        expect(leafProgress(items, root.id), `第 ${round} 片森林的根 ${root.id}`).toEqual(
          referenceLeafProgress(items, root.id)
        )
      }
    }
  })

  it('读数与集合实现互相自洽：leafIds 之外没有节点被算进分母', () => {
    const random = makeRandom(7)
    for (let round = 0; round < 50; round += 1) {
      const { items, roots } = randomForest(random)
      const leaves = leafIds(items)
      for (const root of roots) {
        const progress = leafProgress(items, root.id)
        // 该子树里的最小单元数 == leafIds ∩ 子树
        const subtreeLeaves = items.filter(
          (node) => leaves.has(node.id) && (node.id === root.id || isUnder(items, node.id, root.id))
        ).length
        expect(progress.total).toBe(subtreeLeaves)
      }
    }
  })
})

/** nodeId 是不是 rootId 的后代（测试内部用，独立于被测代码） */
function isUnder(items: Node[], nodeId: string, rootId: string): boolean {
  const byId = new Map(items.map((node) => [node.id, node]))
  let cursor: string | null | undefined = byId.get(nodeId)?.parentId
  const guard = new Set<string>()
  while (cursor !== null && cursor !== undefined && !guard.has(cursor)) {
    if (cursor === rootId) return true
    guard.add(cursor)
    cursor = byId.get(cursor)?.parentId
  }
  return false
}

// ===========================================================================
// 2. 占比自动归一化
// ===========================================================================

describe('占比自动归一化（不必凑满 100）', () => {
  it('填 50/30/20 与填 5/3/2 得到同一个主题进度', () => {
    // 三份都 100% 完成时都该是 100%，真正要比的是"内部完成度不同"的情形
    const items: Node[] = [
      item('A', null, false, 50),
      item('A1', 'A', true),
      item('B', null, false, 30),
      item('B1', 'B', false),
      item('C', null, false, 20),
      item('C1', 'C', true)
    ]
    const big = topicProgress(items, items.filter((node) => node.parentId === null))
    const same = items.map((node) =>
      node.parentId === null && typeof node.percent === 'number'
        ? { ...node, percent: node.percent / 10 }
        : node
    )
    expect(topicProgress(same, same.filter((node) => node.parentId === null))).toBe(big)
    // 50×100 + 30×0 + 20×100 = 7000 ÷ 100 = 70
    expect(big).toBe(70)
  })

  it('一份占比填 0 或没填时按等权处理（不是"把这份资料删掉"）', () => {
    expect(shareOf({ percent: 0 })).toBe(1)
    expect(shareOf({})).toBe(1)
    expect(shareOf({ percent: 50 })).toBe(50)

    const items: Node[] = [
      item('A', null, false, 0),
      item('A1', 'A', true),
      item('B', null, false, 0),
      item('B1', 'B', false)
    ]
    const roots = items.filter((node) => node.parentId === null)
    // 等权：100% 与 0% 平均 → 50%
    expect(topicProgress(items, roots)).toBe(50)
    expect(referenceTopicProgress(items, roots)).toBe(50)
  })

  it('资料行的两个数字：占比是**归一化后**的百分比', () => {
    expect(sharePercent(50, [50, 30, 20])).toBe(50)
    expect(sharePercent(30, [50, 30, 20])).toBe(30)
    expect(sharePercent(5, [5, 5])).toBe(50)
    expect(sharePercent(0, [])).toBe(0)

    const items: Node[] = [
      item('A', null, false, 50),
      item('A1', 'A', true),
      item('A2', 'A', true),
      item('A3', 'A', false)
    ]
    const text = progressText(shareOf(items[0] as Node), [50], leafProgress(items, 'A'))
    expect(text).toBe('占比 100% · 已学 67%（2/3）')
  })

  it('空树 / 没有资料 → 0（不能是 NaN）', () => {
    expect(topicProgress([], [])).toBe(0)
    expect(treeProgress([])).toEqual({ done: 0, total: 0, percent: 0 })
    // 子树里一个节点都没有（或者问了一个不存在的 id）：分母为 0 也不能崩
    expect(leafProgress([], 'x')).toEqual({ done: 0, total: 0, percent: 0 })
    const items: Node[] = [item('root', null, true, 10), item('child', 'root', true)]
    expect(leafProgress(items, 'missing')).toEqual({ done: 0, total: 0, percent: 0 })
  })
})

// ===========================================================================
// 3. 最小单元才算数
// ===========================================================================

describe('最小单元才算数（汇总节点不参与计数）', () => {
  it('父节点自己打了勾、子节点没打：进度不能被抬上去', () => {
    const items: Node[] = [
      item('root', null, false, 100),
      item('chapter', 'root', true), // 汇总节点，勾了也不算
      item('leaf1', 'chapter', false),
      item('leaf2', 'chapter', false)
    ]
    const progress = leafProgress(items, 'root')
    expect(progress).toEqual({ done: 0, total: 2, percent: 0 })
  })

  it('没有子节点的根节点自己就是最小单元（单节点资料）', () => {
    const items: Node[] = [item('solo', null, true, 100)]
    expect(leafProgress(items, 'solo')).toEqual({ done: 1, total: 1, percent: 100 })
    expect(topicProgress(items, [items[0] as Node])).toBe(100)
  })

  it('不严格分层：同一层既有子节点、又能直接打勾，两者都按规则处理', () => {
    const items: Node[] = [
      item('root', null, false, 100),
      item('withChild', 'root', true), // 汇总
      item('under', 'withChild', true), // 最小单元
      item('plainLeaf', 'root', true) // 同一层直接打勾的最小单元
    ]
    expect(leafProgress(items, 'root')).toEqual({ done: 2, total: 2, percent: 100 })
  })
})

// ===========================================================================
// 4. 读书同理：书内完成度 = 读完的章 / 总章数（复用同一份实现）
// ===========================================================================

describe('读书的章节完成度复用同一份实现', () => {
  it('chapterProgress 与 treeProgress 结果完全一致', () => {
    const nodes = [
      { id: 'b1', parentId: null, done: false },
      { id: 'c1', parentId: 'b1', done: true },
      { id: 'c2', parentId: 'b1', done: false },
      { id: 'c3', parentId: 'b1', done: true },
      { id: 'c3-1', parentId: 'c3', done: true }
    ]
    expect(chapterProgress(nodes as unknown as ReadingNode[])).toEqual(treeProgress(nodes))
    // c1、c2、c3-1 是最小单元（c3 有子节点只做汇总）→ 2/3
    expect(chapterProgress(nodes as unknown as ReadingNode[])).toEqual({
      done: 2,
      total: 3,
      percent: 67
    })
  })
})
