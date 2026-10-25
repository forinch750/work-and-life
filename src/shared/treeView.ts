/**
 * 树界面的**纯逻辑**（第二轮 FEAT-006 / `docs\TASKS\02` §6.2）
 *
 * 为什么要与 React 组件分开：vitest 是 `environment: 'node'`，
 * **没有 jsdom、也不许为了测组件引入 jsdom**（`docs\TASKS\02` §6.2 的环境限制）。
 * 所以"层级怎么组装、拖拽落点算到哪个位置"这类最容易写错的判断
 * 必须留在 `src\shared\*` 里，才能被单测直接覆盖。
 *
 * 组件（`src\renderer\shell\TreeView.tsx`）只做渲染与事件绑定。
 */

/** 组件只依赖这几个字段：学习树的节点与读书的章节都满足 */
export interface TreeViewItem {
  id: string
  parentId: string | null
  order: number
  title: string
  done: boolean
}

/** 拖拽落点的三种位置 */
export type TreeDropPosition = 'before' | 'after' | 'onto'

/** 落点算好之后的落库参数：挂到哪个父级下的第几个位置 */
export interface TreeDropTarget {
  parentId: string | null
  index: number
}

/** 组装好的一行：渲染需要的层级信息一次算清 */
export interface TreeRow {
  item: TreeViewItem
  depth: number
  parentId: string | null
  /** 同级里的下标（0 起） */
  index: number
  childCount: number
  /** 有子节点 = 汇总节点（虚线框，不参与进度计数） */
  summary: boolean
}

const byOrderThenId = (a: TreeViewItem, b: TreeViewItem): number =>
  a.order !== b.order ? a.order - b.order : a.id.localeCompare(b.id)

/**
 * 把平铺节点组装成"要渲染的行"，顺序与层级一次算清。
 *
 * 容错与 `tree.ts` 的 `buildTree` **同一口径**：父级不存在、成环的节点一律提到顶层，
 * 绝不能因为一条坏数据就让整棵树渲染不出来（也绝不能无限递归）。
 */
export function assembleRows(items: TreeViewItem[]): TreeRow[] {
  const byId = new Map(items.map((item) => [item.id, item]))

  // ① 把"无效父级"与"成环节点"收敛成 null（与 buildTree 的 effectiveParent 同理）
  const effectiveParent = new Map<string, string | null>()
  for (const item of items) {
    let parentId = item.parentId
    if (parentId !== null && !byId.has(parentId)) parentId = null
    if (parentId !== null) {
      const seen = new Set<string>([item.id])
      let current: string | null = parentId
      while (current !== null) {
        if (seen.has(current)) {
          parentId = null
          break
        }
        seen.add(current)
        current = byId.get(current)?.parentId ?? null
      }
    }
    effectiveParent.set(item.id, parentId)
  }

  const childrenOf = new Map<string | null, TreeViewItem[]>()
  for (const item of items) {
    const parent = effectiveParent.get(item.id) ?? null
    const list = childrenOf.get(parent) ?? []
    list.push(item)
    childrenOf.set(parent, list)
  }

  const rows: TreeRow[] = []
  const walk = (parentId: string | null, depth: number): void => {
    const siblings = [...(childrenOf.get(parentId) ?? [])].sort(byOrderThenId)
    siblings.forEach((item, index) => {
      const children = childrenOf.get(item.id) ?? []
      rows.push({
        item,
        depth,
        parentId,
        index,
        childCount: children.length,
        summary: children.length > 0
      })
      walk(item.id, depth + 1)
    })
  }
  walk(null, 0)
  return rows
}

/**
 * 某一行是否可见（它的全部祖先都处于展开状态）。
 * 父级不存在 / 成环的节点已经被提到顶层，照样显示。
 */
export function isRowVisible(
  byId: Map<string, TreeViewItem>,
  item: TreeViewItem,
  expanded: Set<string>
): boolean {
  let current = item.parentId
  const guard = new Set<string>([item.id])
  while (current !== null) {
    if (guard.has(current)) return true
    guard.add(current)
    const parent = byId.get(current)
    if (!parent) return true
    if (!expanded.has(parent.id)) return false
    current = parent.parentId
  }
  return true
}

/**
 * 落点 → 落库参数：
 *   - `onto`   → 挂到目标节点下，排在现有子节点之后
 *   - `before` → 与目标同级，插到它前面
 *   - `after`  → 与目标同级，插到它后面
 *
 * 计算时**把自己排除**，避免"插到自己前面"这种空操作把顺序算歪。
 * 跨 owner 与"移到自己的后代下"这两条**不在这里判**：那是 `tree.ts` 的
 * `moveNode` 的职责（已有单测），这里只负责位置。
 */
export function resolveDropTarget(
  items: TreeViewItem[],
  draggedId: string,
  targetId: string,
  position: TreeDropPosition
): TreeDropTarget | null {
  const target = items.find((item) => item.id === targetId)
  if (!target || targetId === draggedId) return null

  if (position === 'onto') {
    const children = items
      .filter((item) => item.parentId === targetId && item.id !== draggedId)
      .sort(byOrderThenId)
    return { parentId: targetId, index: children.length }
  }

  const siblings = items
    .filter((item) => item.parentId === target.parentId && item.id !== draggedId)
    .sort(byOrderThenId)
  const base = siblings.findIndex((item) => item.id === targetId)
  if (base < 0) return null
  return { parentId: target.parentId, index: position === 'before' ? base : base + 1 }
}

/** 给 `tree.ts` 的 `moveNode` 用的形状（补上 ownerId） */
export function asTreeNodes(
  items: TreeViewItem[],
  ownerId: string
): Array<TreeViewItem & { ownerId: string }> {
  return items.map((item) => ({ ...item, ownerId }))
}
