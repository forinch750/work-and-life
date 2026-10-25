/**
 * 树节点的四个显式移动动作（2026-10 修订 · 修改 2 轮）
 *
 * 用户原话：「树里面建立的分支**无法移动**，只能删除重写，能不能主动使分支
 * 往上移动或往下移动，**从 1.1 变成 1**」。
 *
 * 拖拽本来就有，缺的是**菜单入口**。所以本轮不新写落库逻辑：
 * `src\shared\treeMove.ts` 只负责回答"这个动作此刻要落到哪个 `{ parentId, index }`"，
 * 算出来以后交给界面走**与拖拽同一条**路（`buildMovePatches` → `moveNode`）。
 *
 * 因此这里测两层：
 *   1. **`buildMovePatches` 的 `index` 到底是"插入位置"还是"目标下标"**
 *      —— 这条必须先钉住（错一位就是"点下移不动"或"跳两格"，而且看起来像界面 bug）
 *   2. 四个动作各自的目标位置与边界
 *
 * 外加两条红线：**防成环**、**防跨 owner**（本轮不放开，跨资料 / 跨书搬家仍然被拒）。
 */
import { describe, expect, it } from 'vitest'
import { byOrderThenId, type TreeNode } from '../../src/shared/tree'
import {
  buildMovePatches,
  demoteTarget,
  moveDownTarget,
  moveStepsOf,
  moveUpTarget,
  promoteTarget,
  siblingIndexOf,
  type MoveTarget,
  type TreeOrderLike
} from '../../src/shared/treeMove'

function node(id: string, parentId: string | null, order: number, extra: Partial<TreeNode> = {}): TreeNode {
  return { id, ownerId: 'topic-1', parentId, order, title: id, done: false, ...extra }
}

/**
 * 样本树（学习树的三层 + 两份顶层资料）：
 *
 * ```
 * res          资料（根）
 * ├─ ch1       第一章
 * │  └─ s11    1.1
 * │     └─ i111  1.1.1
 * ├─ ch2       第二章
 * └─ ch3       第三章
 * lone         另一份资料（根，owner 相同）
 * ```
 *
 * ⚠️ 这里**刻意只有一个 owner**：四个"算目标位置"的函数只按 `parentId`
 * 分同级（与 `tree.ts` 的 `moveNode` 同一口径），传进去的本来就该是
 * **同一个主题 / 同一本书**那一棵树（界面传的就是 `props.items`）。
 * 跨 owner 的拒绝由 `moveNode` 负责，见下面 ⑦ 的用例。
 */
function sample(): TreeNode[] {
  return [
    node('res', null, 0),
    node('ch1', 'res', 0),
    node('s11', 'ch1', 0),
    node('i111', 's11', 0),
    node('ch2', 'res', 1),
    node('ch3', 'res', 2),
    node('lone', null, 1)
  ]
}

/** 混了两棵树（学习 + 读书）的节点表：只拿来验"落库时跨 owner 被拒" */
function mixedOwners(): TreeNode[] {
  return [...sample(), { ...node('other', null, 0), ownerId: 'book-9' }]
}

/** 读书树的样本（顶层是"章"，与学习树的"资料"语义不同） */
function readingSample(): TreeNode[] {
  return [
    node('c1', null, 0),
    node('c1s', 'c1', 0),
    node('c2', null, 1),
    node('c3', null, 2)
  ]
}

/** 把补丁应用到一个副本上（验收"落库后位置对不对"用） */
function applyPatches(
  nodes: TreeNode[],
  patches: Array<{ id: string; patch: Record<string, unknown> }>
): TreeNode[] {
  const byId = new Map(nodes.map((item) => [item.id, { ...item }]))
  for (const patch of patches) {
    const target = byId.get(patch.id)
    if (target === undefined) continue
    target.parentId = patch.patch['parentId'] as string | null
    target.order = Number(patch.patch['order'])
  }
  return [...byId.values()]
}

/** 某一层下的 id 顺序（按 order 排，与 `moveNode` 同一口径） */
function orderUnder(nodes: TreeOrderLike[], parentId: string | null): string[] {
  return nodes
    .filter((item) => item.parentId === parentId)
    .slice()
    .sort(byOrderThenId)
    .map((item) => item.id)
}

/** 真的把某个动作走一遍（算目标 → 落库 → 看结果），返回落库后的节点 */
function runAction(
  nodes: TreeNode[],
  target: MoveTarget,
  movedId: string
): { ok: boolean; reason: string | null; after: TreeNode[] } {
  const outcome = buildMovePatches(nodes, movedId, target.parentId, target.index)
  if (!outcome.ok) return { ok: false, reason: outcome.reason, after: nodes }
  return { ok: true, reason: null, after: applyPatches(nodes, outcome.patches) }
}

// ---------------------------------------------------------------------------
// ① 先把 index 语义钉住 —— 四个动作全靠这一条
// ---------------------------------------------------------------------------

describe('buildMovePatches 的 index 是「插入位置」（排除自己之后的下标）', () => {
  it('index = 0 表示插到该层最前面（不是"移到下标 0 的节点之后"）', () => {
    const nodes = sample()
    // res 这一层原本是 [ch1, ch2, ch3]；把 ch3 插到第 0 位
    const outcome = buildMovePatches(nodes, 'ch3', 'res', 0)
    expect(outcome.ok).toBe(true)
    expect(orderUnder(applyPatches(nodes, outcome.patches), 'res')).toEqual(['ch3', 'ch1', 'ch2'])
  })

  it('index 用的兄弟表**不含自己**：把第一位挪到 index 1 就是与第二位交换', () => {
    const nodes = sample()
    // 完整兄弟表 [ch1, ch2, ch3]，ch1 在 0；排除自己后是 [ch2, ch3]
    // 插到 index 1 → [ch2, ch1, ch3]：正好"往下挪一格"
    const outcome = buildMovePatches(nodes, 'ch1', 'res', 1)
    expect(outcome.ok).toBe(true)
    expect(orderUnder(applyPatches(nodes, outcome.patches), 'res')).toEqual(['ch2', 'ch1', 'ch3'])
  })

  it('index 超过兄弟数会被夹到末尾（不会丢节点）', () => {
    const nodes = sample()
    const outcome = buildMovePatches(nodes, 'ch1', 'res', 99)
    expect(outcome.ok).toBe(true)
    expect(orderUnder(applyPatches(nodes, outcome.patches), 'res')).toEqual(['ch2', 'ch3', 'ch1'])
  })
})

// ---------------------------------------------------------------------------
// ② 上移 / 下移
// ---------------------------------------------------------------------------

describe('上移 / 下移：正确的目标位置 + 边界返回「用不了」并带原因', () => {
  it('siblingIndexOf 与 assembleRows 的 row.index 同一口径（order 相同则按 id）', () => {
    const nodes = sample()
    expect(siblingIndexOf(nodes, 'ch1')).toBe(0)
    expect(siblingIndexOf(nodes, 'ch2')).toBe(1)
    expect(siblingIndexOf(nodes, 'ch3')).toBe(2)
    // order 撞在一起时用 id 兜底，位置必须稳定
    const tied = [node('b', null, 0), node('a', null, 0), node('c', null, 0)]
    expect(siblingIndexOf(tied, 'a')).toBe(0)
    expect(siblingIndexOf(tied, 'b')).toBe(1)
    // 找不到的 id 返回 -1（不抛错）
    expect(siblingIndexOf(tied, '不存在')).toBe(-1)
  })

  it('上移：与上一个兄弟交换（3 个兄弟的中间那个）', () => {
    const nodes = sample()
    const step = moveUpTarget(nodes, 'ch2')
    expect(step.reason).toBeNull()
    expect(step.target).toEqual({ parentId: 'res', index: 0 })
    const moved = runAction(nodes, step.target as MoveTarget, 'ch2')
    expect(moved.ok).toBe(true)
    expect(orderUnder(moved.after, 'res')).toEqual(['ch2', 'ch1', 'ch3'])
  })

  it('下移：与下一个兄弟交换', () => {
    const nodes = sample()
    const step = moveDownTarget(nodes, 'ch2')
    expect(step.target).toEqual({ parentId: 'res', index: 2 })
    const moved = runAction(nodes, step.target as MoveTarget, 'ch2')
    expect(moved.ok).toBe(true)
    expect(orderUnder(moved.after, 'res')).toEqual(['ch1', 'ch3', 'ch2'])
  })

  it('已是第一个 → 上移用不了，并说清原因（不是把菜单项藏起来）', () => {
    const step = moveUpTarget(sample(), 'ch1')
    expect(step.target).toBeNull()
    expect(step.reason).toBe('已经在最上面')
  })

  it('已是最后一个 → 下移用不了，并说清原因', () => {
    const step = moveDownTarget(sample(), 'ch3')
    expect(step.target).toBeNull()
    expect(step.reason).toBe('已经在最下面')
  })

  it('独生子：上移与下移都用不了', () => {
    expect(moveUpTarget(sample(), 'i111').target).toBeNull()
    expect(moveDownTarget(sample(), 'i111').target).toBeNull()
  })

  it('找不到的 id 一律"用不了"，不抛错（数据来自磁盘，坏数据不该让页面崩）', () => {
    expect(() => moveUpTarget(sample(), '不存在')).not.toThrow()
    expect(moveUpTarget(sample(), '不存在').target).toBeNull()
    expect(moveDownTarget(sample(), '不存在').target).toBeNull()
    expect(promoteTarget(sample(), '不存在').target).toBeNull()
    expect(demoteTarget(sample(), '不存在').target).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// ③ 升一级（1.1 → 1）
// ---------------------------------------------------------------------------

describe('升一级（1.1 → 1）：挂到"爷爷"下面，位置紧跟原父节点之后', () => {
  it('s11（ch1 的 1.1）升一级 → 变成 res 下面的一员，紧跟在 ch1 后面', () => {
    const nodes = sample()
    const step = promoteTarget(nodes, 's11')
    // 父节点 ch1 在 res 那一层的下标是 0 → 插到它后面就是 index 1
    expect(step.target).toEqual({ parentId: 'res', index: 1 })
    const moved = runAction(nodes, step.target as MoveTarget, 's11')
    expect(moved.ok).toBe(true)
    expect(orderUnder(moved.after, 'res')).toEqual(['ch1', 's11', 'ch2', 'ch3'])
    expect(moved.after.find((item) => item.id === 's11')?.parentId).toBe('res')
  })

  it('父节点排在最后时也紧跟其后（不能跑到父节点前面去）', () => {
    const nodes = sample()
    // 先把 ch1 挪到最后 → res 这一层变成 [ch2, ch3, ch1]
    const shuffled = applyPatches(
      nodes,
      buildMovePatches(nodes, 'ch1', 'res', 2).patches
    )
    const step = promoteTarget(shuffled, 's11')
    expect(step.target).toEqual({ parentId: 'res', index: 3 })
    const moved = runAction(shuffled, step.target as MoveTarget, 's11')
    expect(moved.ok).toBe(true)
    expect(orderUnder(moved.after, 'res')).toEqual(['ch2', 'ch3', 'ch1', 's11'])
  })

  it('子树跟着一起走（s11 的 i111 仍然挂在 s11 下面）', () => {
    const nodes = sample()
    const step = promoteTarget(nodes, 's11')
    const moved = runAction(nodes, step.target as MoveTarget, 's11')
    expect(moved.after.find((item) => item.id === 'i111')?.parentId).toBe('s11')
  })

  it('已经是顶层（资料 / 顶层的章）→ 用不了，并说清原因', () => {
    const step = promoteTarget(sample(), 'res')
    expect(step.target).toBeNull()
    expect(step.reason).toContain('顶层')
    expect(promoteTarget(readingSample(), 'c1').target).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// ④ 降一级（1 → 1.1）
// ---------------------------------------------------------------------------

describe('降一级（1 → 1.1）：挂到上一个兄弟的最后', () => {
  it('ch2 降一级 → 变成 ch1 的最后一个孩子', () => {
    const nodes = sample()
    const step = demoteTarget(nodes, 'ch2')
    // ch1 现有 1 个孩子（s11），所以插到第 1 位 = 末尾
    expect(step.target).toEqual({ parentId: 'ch1', index: 1 })
    const moved = runAction(nodes, step.target as MoveTarget, 'ch2')
    expect(moved.ok).toBe(true)
    expect(orderUnder(moved.after, 'ch1')).toEqual(['s11', 'ch2'])
    expect(orderUnder(moved.after, 'res')).toEqual(['ch1', 'ch3'])
  })

  it('上一个兄弟还没有孩子时插到第 0 位', () => {
    const nodes = [node('p', null, 0), node('a', 'p', 0), node('b', 'p', 1)]
    const step = demoteTarget(nodes, 'b')
    expect(step.target).toEqual({ parentId: 'a', index: 0 })
    const moved = runAction(nodes, step.target as MoveTarget, 'b')
    expect(orderUnder(moved.after, 'a')).toEqual(['b'])
  })

  it('没有上一个兄弟（它是第一个）→ 用不了，并说清原因', () => {
    const step = demoteTarget(sample(), 'ch1')
    expect(step.target).toBeNull()
    expect(step.reason).toContain('上面没有兄弟')
  })

  it('学习树里"资料"（顶层）不给降级；读书树里"章"（顶层）可以降成子章', () => {
    // 默认（`allowRootDemote` 不给）= 学习树的口径
    const learning = demoteTarget(sample(), 'lone')
    expect(learning.target).toBeNull()
    expect(learning.reason).toContain('顶层')

    // 读书树显式允许
    const reading = demoteTarget(readingSample(), 'c2', { allowRootDemote: true })
    expect(reading.target).toEqual({ parentId: 'c1', index: 1 })
    const moved = runAction(readingSample(), reading.target as MoveTarget, 'c2')
    expect(moved.ok).toBe(true)
    expect(orderUnder(moved.after, 'c1')).toEqual(['c1s', 'c2'])
  })
})

// ---------------------------------------------------------------------------
// ⑤ 四个动作只改 parentId / order
// ---------------------------------------------------------------------------

describe('四个动作只动 parentId 与被牵连节点的 order', () => {
  const actions: Array<{ name: string; build: (nodes: TreeNode[]) => ReturnType<typeof moveUpTarget>; id: string }> = [
    { name: '上移', build: (nodes) => moveUpTarget(nodes, 'ch2'), id: 'ch2' },
    { name: '下移', build: (nodes) => moveDownTarget(nodes, 'ch2'), id: 'ch2' },
    { name: '升一级', build: (nodes) => promoteTarget(nodes, 's11'), id: 's11' },
    { name: '降一级', build: (nodes) => demoteTarget(nodes, 'ch2'), id: 'ch2' }
  ]

  for (const action of actions) {
    it(`${action.name}：补丁里只有 parentId 与 order，标题 / 打勾状态一个字都不动`, () => {
      const nodes = sample()
      const step = action.build(nodes)
      const outcome = buildMovePatches(nodes, action.id, (step.target as MoveTarget).parentId, (step.target as MoveTarget).index)
      expect(outcome.ok).toBe(true)
      for (const patch of outcome.patches) {
        expect(Object.keys(patch.patch).sort()).toEqual(['order', 'parentId'])
      }
      const after = applyPatches(nodes, outcome.patches)
      for (const before of nodes) {
        const now = after.find((item) => item.id === before.id)
        expect(now?.title).toBe(before.title)
        expect(now?.done).toBe(before.done)
        expect(now?.ownerId).toBe(before.ownerId)
      }
      // 节点一个都没多、一个都没少（子树是"整体移动"，不是"拆开重建"）
      expect(after.map((item) => item.id).sort()).toEqual(nodes.map((item) => item.id).sort())
    })
  }
})

// ---------------------------------------------------------------------------
// ⑥ 防成环
// ---------------------------------------------------------------------------

describe('防成环：四个动作都不会把节点移到自己的后代下面', () => {
  it('把父节点放到自己的子节点下 → 直接落库被拒（tree.ts 的判据照旧生效）', () => {
    const outcome = buildMovePatches(sample(), 'res', 'i111', 0)
    expect(outcome.ok).toBe(false)
    expect(outcome.patches).toEqual([])
  })

  it('四个动作算出来的目标父级，永远不是自己的后代（逐节点扫一遍）', () => {
    const nodes = sample()
    /** 自己的全部后代 */
    const descendantsOf = (id: string): Set<string> => {
      const out = new Set<string>()
      const stack = nodes.filter((item) => item.parentId === id).map((item) => item.id)
      while (stack.length > 0) {
        const current = stack.pop()
        if (current === undefined || out.has(current)) continue
        out.add(current)
        for (const child of nodes.filter((item) => item.parentId === current)) stack.push(child.id)
      }
      return out
    }

    for (const item of nodes) {
      const steps = moveStepsOf(nodes, item.id, { allowRootDemote: true })
      for (const [name, step] of Object.entries(steps)) {
        if (step.target === null) continue
        const parentId = step.target.parentId
        expect(parentId, `${item.id} 的${name}目标父级是它自己`).not.toBe(item.id)
        if (parentId !== null) {
          expect(
            descendantsOf(item.id).has(parentId),
            `${item.id} 的${name}目标父级 ${parentId} 是它的后代`
          ).toBe(false)
        }
        // 再走一遍真实落库：算出来的位置在 `moveNode` 眼里也必须是合法的
        expect(
          buildMovePatches(nodes, item.id, parentId, step.target.index).ok,
          `${item.id} 的${name}落库被拒`
        ).toBe(true)
      }
    }
  })
})

// ---------------------------------------------------------------------------
// ⑦ 防跨 owner
// ---------------------------------------------------------------------------

describe('防跨 owner：只能在自己那棵树里挪', () => {
  it('把学习者节点移到别的书下面 → 被拒，且一条补丁都不产出', () => {
    const outcome = buildMovePatches(mixedOwners(), 'ch1', 'other', 0)
    expect(outcome.ok).toBe(false)
    expect(outcome.reason).not.toBeNull()
    expect(outcome.patches).toEqual([])
  })

  it('四个动作算出来的目标父级，ownerId 一定与节点自己相同', () => {
    // 入参是"同一棵树"的节点（界面给的就是当前主题 / 当前书的那一份），
    // 于是一个算出来的目标父级必然同 owner —— 这条是"不会算出跨 owner 位置"的正面证据。
    const nodes = sample()
    const ownerOf = (id: string): string | undefined => nodes.find((item) => item.id === id)?.ownerId
    for (const item of nodes) {
      const steps = moveStepsOf(nodes, item.id, { allowRootDemote: true })
      for (const [name, step] of Object.entries(steps)) {
        if (step.target === null || step.target.parentId === null) continue
        expect(ownerOf(step.target.parentId), `${item.id} 的${name}`).toBe(item.ownerId)
      }
    }
  })
})
