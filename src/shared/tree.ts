/**
 * 通用树模型的纯逻辑（第二轮 FEAT-006）
 *
 * 用途：学习主题与读书的书底下都要能加"章节 / 子章节 / 条目"，
 * 两处共用这一套（用户已确认），所以逻辑必须与界面无关、可单测。
 *
 * 数据形状：记录在磁盘上是**平铺**的，靠 parentId 与 order 表达层级。
 *   { id, ownerId, parentId: string | null, order: number, title, done }
 * 平铺存储的好处：改一个节点的父级或顺序只动一条记录，
 * 不需要整棵树重写；也不会出现"嵌套 JSON 里改一处要重写整棵子树"。
 *
 * 本轮只做纯逻辑与单测，界面在 2.2 轮。
 */

/** 平铺的树节点 */
export interface TreeNode {
  id: string
  /** 所属的顶层实体（学习主题 id 或书 id） */
  ownerId: string
  /** 父节点；顶层节点为 null */
  parentId: string | null
  /** 同级内的排序，从 0 开始 */
  order: number
  title: string
  done: boolean
}

/** 嵌套后的节点（挂上子节点） */
export interface TreeNodeWithChildren extends TreeNode {
  children: TreeNodeWithChildren[]
}

/**
 * 同级排序：**order 是位置的唯一权威**。
 *
 * order 相同时用 id 兜底，而不用标题——用标题会导致"改个标题，节点位置就跳了"，
 * 用户完全无法理解为什么。id 不可见也不会变，是稳定的兜底键。
 *
 * ## 为什么导出
 *
 * `treeMove.ts` 的四个"算目标位置"函数（上移 / 下移 / 升一级 / 降一级）
 * 必须按**同一口径**数同级的下标，否则 `moveNode` 的插入位置会错一位
 * （症状是"点下移不动"或"跳两格"）。两处各写一份比较器迟早漂移，
 * 所以这里只留一份，那边直接复用。
 */
export const byOrderThenId = (
  a: Pick<TreeNode, 'id' | 'order'>,
  b: Pick<TreeNode, 'id' | 'order'>
): number => {
  if (a.order !== b.order) return a.order - b.order
  return a.id.localeCompare(b.id)
}

/**
 * 把平铺节点组装成森林。
 *
 * 容错规则（数据来自磁盘或导入文件，必须宽容）：
 *   - parentId 指向不存在的节点 → 当作顶层节点，不能让它凭空消失
 *   - 出现环（A→B→A）→ 环上的节点全部提到顶层，避免无限递归把程序卡死
 *   - 只处理指定 owner 的节点（跨 owner 的引用一律当顶层，见下）
 */
export function buildTree(nodes: TreeNode[], ownerId?: string): TreeNodeWithChildren[] {
  const scoped = ownerId === undefined ? nodes : nodes.filter((node) => node.ownerId === ownerId)
  const byId = new Map<string, TreeNode>()
  for (const node of scoped) byId.set(node.id, node)

  /** 沿 parentId 往上走，判断是否会绕回起点（成环） */
  const isCyclic = (node: TreeNode): boolean => {
    const seen = new Set<string>([node.id])
    let current = node.parentId
    while (current !== null) {
      if (seen.has(current)) return true
      seen.add(current)
      const parent = byId.get(current)
      if (!parent) return false
      current = parent.parentId
    }
    return false
  }

  /** effectiveParent：把"无效父级"与"成环节点"都收敛成 null */
  const effectiveParent = new Map<string, string | null>()
  for (const node of scoped) {
    let parentId = node.parentId
    if (parentId !== null && !byId.has(parentId)) parentId = null
    if (parentId !== null && isCyclic(node)) parentId = null
    effectiveParent.set(node.id, parentId)
  }

  const built = new Map<string, TreeNodeWithChildren>()
  for (const node of scoped) {
    built.set(node.id, { ...node, parentId: effectiveParent.get(node.id) ?? null, children: [] })
  }

  const roots: TreeNodeWithChildren[] = []
  for (const node of scoped) {
    const parentId = effectiveParent.get(node.id) ?? null
    const self = built.get(node.id)
    if (!self) continue
    if (parentId === null) {
      roots.push(self)
      continue
    }
    const parent = built.get(parentId)
    if (!parent) {
      roots.push(self)
      continue
    }
    parent.children.push(self)
  }

  const sortRecursive = (list: TreeNodeWithChildren[]): void => {
    list.sort(byOrderThenId)
    for (const item of list) sortRecursive(item.children)
  }
  sortRecursive(roots)

  return roots
}

/** 把森林摊回平铺列表（深度优先，父在子前） */
export function flattenTree(roots: TreeNodeWithChildren[]): TreeNode[] {
  const out: TreeNode[] = []
  const walk = (list: TreeNodeWithChildren[]): void => {
    for (const node of list) {
      const { children, ...rest } = node
      out.push(rest)
      walk(children)
    }
  }
  walk(roots)
  return out
}

/** 某个节点的全部后代 id（不含自己） */
export function descendantIds(nodes: TreeNode[], id: string): string[] {
  const childrenOf = new Map<string, string[]>()
  for (const node of nodes) {
    if (node.parentId === null) continue
    const list = childrenOf.get(node.parentId) ?? []
    list.push(node.id)
    childrenOf.set(node.parentId, list)
  }

  const out: string[] = []
  const stack = [...(childrenOf.get(id) ?? [])]
  while (stack.length > 0) {
    const current = stack.pop()
    if (current === undefined) continue
    out.push(current)
    for (const child of childrenOf.get(current) ?? []) stack.push(child)
  }
  return out
}

/** 某个节点的深度（顶层为 0） */
export function depthOf(nodes: TreeNode[], id: string): number {
  const byId = new Map(nodes.map((node) => [node.id, node]))
  let depth = 0
  let current = byId.get(id)?.parentId ?? null
  const guard = new Set<string>([id])
  while (current !== null) {
    if (guard.has(current)) return depth // 成环，按已走深度返回即可
    guard.add(current)
    depth += 1
    current = byId.get(current)?.parentId ?? null
  }
  return depth
}

export interface MoveResult {
  ok: boolean
  /** 失败原因（成功时为 null） */
  reason: string | null
  /** 需要更新的节点补丁 */
  patches: Array<{ id: string; parentId: string | null; order: number }>
}

/**
 * 把一个节点移到新父级下的指定位置。
 *
 * **必须防成环**：不能把节点移到自己的后代下，否则那部分子树会从树上脱落
 * （既不是任何节点的子，也不再是顶层，界面上就"消失"了）。
 *
 * 返回需要落库的补丁，由调用方决定何时写盘——纯函数不碰存储。
 */
export function moveNode(
  nodes: TreeNode[],
  id: string,
  newParentId: string | null,
  newIndex: number
): MoveResult {
  const byId = new Map(nodes.map((node) => [node.id, node]))
  const self = byId.get(id)
  if (!self) return { ok: false, reason: '找不到要移动的节点', patches: [] }

  if (newParentId !== null) {
    const target = byId.get(newParentId)
    if (!target) return { ok: false, reason: '找不到目标父节点', patches: [] }
    if (target.ownerId !== self.ownerId) {
      return { ok: false, reason: '不能把节点移到另一个计划下', patches: [] }
    }
    if (newParentId === id) return { ok: false, reason: '不能把节点移到它自己下面', patches: [] }
    if (descendantIds(nodes, id).includes(newParentId)) {
      return { ok: false, reason: '不能把节点移到它自己的子节点下面', patches: [] }
    }
  }

  // 目标父级下现有的子节点（排除自己），插入到 index 位置
  const siblings = nodes
    .filter((node) => node.parentId === newParentId && node.id !== id)
    .sort(byOrderThenId)

  const clamped = Math.max(0, Math.min(newIndex, siblings.length))
  siblings.splice(clamped, 0, { ...self, parentId: newParentId })

  const patches: MoveResult['patches'] = siblings.map((node, index) => ({
    id: node.id,
    parentId: newParentId,
    order: index
  }))

  // 自己如果原本有子节点，父级变了但子节点不受影响（它们仍然跟着自己）
  return { ok: true, reason: null, patches }
}

/**
 * 同级重排：给定某个父级下**期望的顺序**，返回补丁。
 * 只重排这些节点的 order，不动层级。
 */
export function reorderSiblings(
  nodes: TreeNode[],
  parentId: string | null,
  orderedIds: string[]
): Array<{ id: string; order: number }> {
  const valid = new Set(
    nodes.filter((node) => node.parentId === parentId).map((node) => node.id)
  )
  const patches: Array<{ id: string; order: number }> = []
  let order = 0
  for (const id of orderedIds) {
    if (!valid.has(id)) continue
    patches.push({ id, order })
    order += 1
  }
  return patches
}

export interface RemoveSubtreeResult {
  /** 要标记删除的全部 id（含自己与所有后代） */
  ids: string[]
  /** 受影响的直接子节点数量，用于提示"将同时删除 N 个子章节" */
  descendantCount: number
}

/**
 * 删除一个节点时要连带处理的全部节点。
 *
 * 规则：连同整棵子树一起（用户已确认"树节点整棵处理"）。
 * 单独删父节点而把子节点提上来会让用户莫名其妙多出一堆层级错乱的内容。
 */
export function removeSubtree(nodes: TreeNode[], id: string): RemoveSubtreeResult {
  const descendants = descendantIds(nodes, id)
  return { ids: [id, ...descendants], descendantCount: descendants.length }
}

/** 节点是否是某个 owner 下的顶层节点 */
export function isRootNode(node: TreeNode): boolean {
  return node.parentId === null
}

/** 统计一棵子树里已完成 / 全部节点数，用于"进度 3/8"这类展示 */
export function subtreeProgress(
  nodes: TreeNode[],
  id: string
): { done: number; total: number } {
  const ids = new Set([id, ...descendantIds(nodes, id)])
  let done = 0
  let total = 0
  for (const node of nodes) {
    if (!ids.has(node.id)) continue
    total += 1
    if (node.done) done += 1
  }
  return { done, total }
}

/** 规范化一个树节点（数据来自磁盘或导入文件，必须宽容） */
export function normalizeTreeNode(input: Record<string, unknown>): TreeNode | null {
  const id = String(input['id'] ?? '')
  if (id === '') return null
  const ownerId = String(input['ownerId'] ?? '')
  if (ownerId === '') return null
  const rawParent = input['parentId']
  const parentId = typeof rawParent === 'string' && rawParent !== '' ? rawParent : null
  const order = Number.isFinite(input['order']) ? Math.max(0, Number(input['order'])) : 0
  return {
    id,
    ownerId,
    parentId: parentId === id ? null : parentId, // 自己当自己的父级是无意义的坏数据
    order: Math.trunc(order),
    title: String(input['title'] ?? '').trim(),
    done: input['done'] === true
  }
}
