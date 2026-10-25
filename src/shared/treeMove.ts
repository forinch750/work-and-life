/**
 * 树节点「移动 / 增删改」的落库逻辑（第二轮 FEAT-006 / `docs\TASKS\02` §5.4）
 *
 * 为什么单独一份：**层级语义的判定必须与界面无关**，否则"跨 owner 能不能移"
 * 这种问题会散落在两个页面里，各写一遍、各错一遍。
 * 这里把所有判断收在一处，并保证：
 *
 *   1. **跨 owner 移动必须拒绝** —— 学习主题的章节不能跑到另一本书下面，
 *      反过来也不行。树的边界就是 `ownerId`。
 *   2. **移到自己的后代下必须拒绝（防成环）** —— 否则那棵子树会从界面上凭空消失
 *      （既不是任何节点的子，也不再是顶层）。
 *   3. **找不到的 id 一律变成"跳过"而不是抛错** —— 数据来自磁盘，
 *      坏数据只该让一条记录不动，不该让整个页面崩掉。
 *
 * 纯逻辑（含上面两条拒绝）在 `tree.ts` 里已有单测；本文件只做
 * "把它的结果翻译成要写回存储的补丁"，所以判定本身不在这里重复实现。
 */
import { byOrderThenId, moveNode, type TreeNode } from './tree'

/**
 * 判定与移动只依赖这几项——**故意不加索引签名**，
 * 这样 `LearningNode` / `ReadingNode` 这些真实记录类型能直接传进来，
 * 不必在调用处做一次多余的展开拷贝。
 */
export type TreeLike = Pick<TreeNode, 'id' | 'ownerId' | 'parentId' | 'order' | 'title' | 'done'>

export interface TreeMoveOutcome {
  ok: boolean
  /** 失败原因（面向用户的说法，可直接显示） */
  reason: string | null
  /** 需要写回存储的补丁（只含 parentId / order，不会覆盖节点的标题等） */
  patches: Array<{ id: string; patch: Record<string, unknown> }>
}

/**
 * 移动一个节点：先让 `tree.ts` 判合法性（跨 owner / 成环 / 找不到），
 * 通过后把它的补丁翻译成 `{ id, patch: { parentId, order } }`。
 */
export function buildMovePatches(
  nodes: TreeLike[],
  dragId: string,
  parentId: string | null,
  index: number
): TreeMoveOutcome {
  const result = moveNode(nodes, dragId, parentId, index)
  if (!result.ok) return { ok: false, reason: result.reason, patches: [] }
  return {
    ok: true,
    reason: null,
    patches: result.patches.map((patch) => ({
      id: patch.id,
      patch: { parentId: patch.parentId, order: patch.order }
    }))
  }
}

// ===========================================================================
// 四个显式的移动动作（2026-10 修订 · 修改 2 轮）
//
// ## 为什么只算"目标位置"
//
// 用户的原话是「树里建的节点不能移动，只能删掉重建，能不能往上/往下移动，
// 从 1.1 变成 1」。拖拽本来就有（`TreeView` 的原生 HTML5 拖拽），缺的只是
// **可发现的菜单入口**。所以这里**不新写一套落库逻辑**，只回答一个问题：
//
//     这个动作此刻要落到哪个 `{ parentId, index }`？
//
// 算出来以后交给界面调 `props.onMove`，与拖拽走**完全同一条**路
// （`buildMovePatches` → `tree.ts` 的 `moveNode`），于是防成环、防跨 owner、
// 子树连带移动、order 重排全部自动继承，一行都不用重写。
//
// ## `index` 的精确含义（最容易写错的一位）
//
// `buildMovePatches(nodes, id, parentId, index)` 的 `index` 是**插入位置**：
// `moveNode` 先把目标父级下的兄弟（**排除自己**）按 `byOrderThenId` 排好，
// 再把自己 `splice(index, 0, …)` 进去。所以：
//
//   - 上移一位 = 自己在**完整**兄弟表里的下标 − 1
//   - 下移一位 = 自己在**完整**兄弟表里的下标 + 1
//
// 这条不是凭直觉写的：`tests\learning\treeMoveActions.test.ts` 第一条用例
// 把它逐字形钉住（"点下移跳两格 / 不动"就是错在这里）。
// ===========================================================================

/** 算目标位置只认这几项（不看 ownerId：那个由 `moveNode` 判，见上） */
export interface TreeOrderLike {
  id: string
  parentId: string | null
  order: number
}

/** 一个移动动作要落到的位置（与 `buildMovePatches` 的入参同义） */
export interface MoveTarget {
  parentId: string | null
  /** **插入位置**（目标父级下、排除自己之后的下标），不是"目标下标" */
  index: number
}

/**
 * 一个移动动作此刻算出来的结果。
 *
 * `target === null` 表示这个动作此刻用不了，`reason` 是**面向用户**的说法，
 * 直接作为菜单项的 `hint` 显示——用户要知道"为什么点不了"，
 * 而不是看到一个灰掉了、说不清原因的项（这正是本轮要修的病：
 * 功能明明有、用户却以为不存在）。
 */
export interface MoveStep {
  target: MoveTarget | null
  reason: string | null
}

/** 四个动作一起算（界面每渲染一行就取一次，别分别调四遍） */
export interface MoveSteps {
  up: MoveStep
  down: MoveStep
  promote: MoveStep
  demote: MoveStep
}

export interface DemoteOptions {
  /**
   * 顶层节点能不能"降一级"。
   *
   * 三处树各建各的（`MASTER.md` 决定 3），顶层节点的语义**不一样**：
   *   - 学习树：顶层是**资料**。把资料降到章节层会让"资料 → 章 → 子章"
   *     这套层级语义乱掉（复习页按 `depth === 0` 认资料），所以**不给降**
   *   - 读书树：顶层是**章**。章降到上一章下面就是"子章"，是正常动作
   *
   * 所以这条由页面决定（`TreeView` 的 `allowRootDemote`），不在这里写死。
   */
  allowRootDemote?: boolean
}

const fail = (reason: string): MoveStep => ({ target: null, reason })

/**
 * 某一层下的全部兄弟（按 `byOrderThenId` 排）。
 *
 * **与 `tree.ts` 的 `moveNode` 同一口径**：只按 `parentId` 分组。
 * 跨 owner 那种坏数据由 `moveNode` 明确拒绝，这里不重复判——
 * 两处判据一旦不一致，会算出"补丁被拒但界面已经跳位"的鬼现象。
 */
function siblingsUnder(nodes: TreeOrderLike[], parentId: string | null): TreeOrderLike[] {
  return nodes.filter((node) => node.parentId === parentId).sort(byOrderThenId)
}

/** 这个节点在**它自己那一层**里排第几（0 起）；找不到返回 -1 */
export function siblingIndexOf(nodes: TreeOrderLike[], id: string): number {
  const self = nodes.find((node) => node.id === id)
  if (self === undefined) return -1
  return siblingsUnder(nodes, self.parentId).findIndex((node) => node.id === id)
}

/** 上移：与上一个兄弟交换位置（已是该层第一个 → 用不了） */
export function moveUpTarget(nodes: TreeOrderLike[], id: string): MoveStep {
  const self = nodes.find((node) => node.id === id)
  if (self === undefined) return fail('找不到要移动的节点')
  const index = siblingIndexOf(nodes, id)
  if (index <= 0) return fail('已经在最上面')
  return { target: { parentId: self.parentId, index: index - 1 }, reason: null }
}

/** 下移：与下一个兄弟交换位置（已是该层最后一个 → 用不了） */
export function moveDownTarget(nodes: TreeOrderLike[], id: string): MoveStep {
  const self = nodes.find((node) => node.id === id)
  if (self === undefined) return fail('找不到要移动的节点')
  const siblings = siblingsUnder(nodes, self.parentId)
  const index = siblings.findIndex((node) => node.id === id)
  if (index < 0) return fail('找不到要移动的节点')
  if (index >= siblings.length - 1) return fail('已经在最下面')
  // 排除自己之后列表短了一位，但"往下挪一格"的插入位置恰好还是 index + 1
  return { target: { parentId: self.parentId, index: index + 1 }, reason: null }
}

/**
 * 升一级（`1.1` → `1`）：挂到"爷爷"下面，位置**紧跟原来的父节点之后**。
 * 已经是顶层（`parentId === null`，学习树里的"资料"、读书树里的"章"）→ 用不了。
 */
export function promoteTarget(nodes: TreeOrderLike[], id: string): MoveStep {
  const self = nodes.find((node) => node.id === id)
  if (self === undefined) return fail('找不到要移动的节点')
  if (self.parentId === null) return fail('已经在最顶层，不能再升一级')
  const parent = nodes.find((node) => node.id === self.parentId)
  if (parent === undefined) return fail('找不到它的上一级')
  const parentIndex = siblingsUnder(nodes, parent.parentId).findIndex(
    (node) => node.id === parent.id
  )
  if (parentIndex < 0) return fail('找不到它的上一级')
  // 自己是"爷爷"这一层的新人（不在它现有的兄弟表里），所以 index 直接取父节点下标 + 1
  return { target: { parentId: parent.parentId, index: parentIndex + 1 }, reason: null }
}

/**
 * 降一级（`1` → `1.1`）：挂到**上一个兄弟**的最后。
 * 没有上一个兄弟（它是第一个）→ 用不了；顶层节点看 `allowRootDemote`。
 *
 * 防成环在这条路上是**构造保证**的：目标父级是"上一个兄弟"，
 * 它不可能是自己的后代（同一个父级下的两个节点互为兄弟）。
 * 真落库时 `moveNode` 还会再判一次，双保险。
 */
export function demoteTarget(
  nodes: TreeOrderLike[],
  id: string,
  options: DemoteOptions = {}
): MoveStep {
  const self = nodes.find((node) => node.id === id)
  if (self === undefined) return fail('找不到要移动的节点')
  if (self.parentId === null && options.allowRootDemote !== true) {
    return fail('顶层节点不能降级')
  }
  const siblings = siblingsUnder(nodes, self.parentId)
  const index = siblings.findIndex((node) => node.id === id)
  if (index < 0) return fail('找不到要移动的节点')
  const previous = index > 0 ? siblings[index - 1] : undefined
  if (previous === undefined) return fail('上面没有兄弟节点，无法降级')
  // 挂到上一个兄弟的**最后**：目标父级现有几个孩子就插到第几个
  const childCount = nodes.filter((node) => node.parentId === previous.id).length
  return { target: { parentId: previous.id, index: childCount }, reason: null }
}

/**
 * 一次算齐四个动作（`TreeView` 每渲染一行取一次）。
 *
 * 为什么合成一个函数：四个动作的边界条件互相牵连（例如"顶层"既决定
 * 升一级能不能用、也决定降一级能不能用），分散在四处调用会漏掉一个。
 */
export function moveStepsOf(
  nodes: TreeOrderLike[],
  id: string,
  options: DemoteOptions = {}
): MoveSteps {
  return {
    up: moveUpTarget(nodes, id),
    down: moveDownTarget(nodes, id),
    promote: promoteTarget(nodes, id),
    demote: demoteTarget(nodes, id, options)
  }
}

/** 判定用的最小形状：只认 ownerId / parentId / order / id */
export interface OwnedLite {
  id: string
  ownerId: string
  parentId: string | null
  order: number
}

/**
 * 这两条是 `docs\TASKS\02` §5.4 的**独立复核**（不给 `moveNode` 传 ownerId，
 * 只按 `ownerId` 字段自己判一次），供单测与验收直接调用：
 * 就算将来有人改了 `tree.ts` 的判据，这里也会立刻暴露不一致。
 */
export function canMove(
  nodes: OwnedLite[],
  dragId: string,
  parentId: string | null
): { ok: boolean; reason: string | null } {
  const self = nodes.find((node) => node.id === dragId)
  if (!self) return { ok: false, reason: '找不到要移动的节点' }
  if (parentId === null) return { ok: true, reason: null }

  const target = nodes.find((node) => node.id === parentId)
  if (!target) return { ok: false, reason: '找不到目标父节点' }
  if (target.ownerId !== self.ownerId) return { ok: false, reason: '不能跨主题/书籍移动节点' }
  if (parentId === dragId) return { ok: false, reason: '不能把节点移到它自己下面' }

  // 沿 parentId 往上从目标出发走一遍，能走回自己就是成环
  const byId = new Map(nodes.map((node) => [node.id, node]))
  const guard = new Set<string>([target.id])
  let current: string | null = target.parentId
  while (current !== null) {
    if (current === dragId) return { ok: false, reason: '不能把节点移到它自己的子节点下面' }
    if (guard.has(current)) break // 目标本身就在一个环里，别死循环
    guard.add(current)
    current = byId.get(current)?.parentId ?? null
  }
  return { ok: true, reason: null }
}

/**
 * 新增节点时要写的字段。
 *
 * **只写"新增"该有的东西**：`parentId` / `order` / `title` / `done`，
 * 再加上调用方给的附加字段（占比、分组名…）。
 * `id` / `createdAt` / `updatedAt` 由存储层生成，这里不碰。
 */
export function buildCreatePatch(input: {
  ownerId: string
  parentId: string | null
  order: number
  title: string
  extra?: Record<string, unknown>
}): Record<string, unknown> {
  return {
    kind: 'node',
    ownerId: input.ownerId,
    parentId: input.parentId,
    order: input.order,
    title: input.title.trim(),
    done: false,
    ...(input.extra ?? {})
  }
}

/** 在某个父级下"排在最后"要用的 order */
export function nextOrderUnder(nodes: OwnedLite[], ownerId: string, parentId: string | null): number {
  const siblings = nodes.filter((node) => node.ownerId === ownerId && node.parentId === parentId)
  return siblings.length === 0 ? 0 : Math.max(...siblings.map((node) => node.order)) + 1
}

/**
 * 删除前要一起处理的整棵子树（含自己）。
 * 与 `unlink.ts` 的 `unlinkTreeNode` 配对使用：那边生成补丁，这里给 id 清单。
 */
export function subtreeIds(nodes: TreeLike[], id: string): string[] {
  const childrenOf = new Map<string, string[]>()
  for (const node of nodes) {
    if (node.parentId === null) continue
    const list = childrenOf.get(node.parentId) ?? []
    list.push(node.id)
    childrenOf.set(node.parentId, list)
  }
  const out: string[] = []
  const seen = new Set<string>([id])
  const stack = [...(childrenOf.get(id) ?? [])]
  while (stack.length > 0) {
    const current = stack.pop()
    if (current === undefined || seen.has(current)) continue
    seen.add(current)
    out.push(current)
    for (const child of childrenOf.get(current) ?? []) stack.push(child)
  }
  return [id, ...out]
}
