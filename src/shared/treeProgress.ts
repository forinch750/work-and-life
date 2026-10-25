/**
 * 树的**进度模型**与**缩进规则**（第二轮 FEAT-006 / `MASTER.md` §7.9）
 *
 * 这里只放**纯函数**：不给 React、不碰存储、不认识任何具体模块。
 * 学习主题下的资料与读书的章节共用同一套，所以逻辑必须与界面无关、可单测。
 *
 * ## 两个进度是两件事（`docs\TASKS\02` §5.2）
 *
 * | | 是什么 | 谁定 |
 * |---|---|---|
 * | **占比** | 这份资料在主题里的分量 | 用户自己填（任意正数） |
 * | **内部完成度** | 资料内**最小单元**的完成比例 | 机器算 |
 *
 * **最小单元 = 没有子节点的节点**。有子节点的只做汇总，**不参与计数**
 * （界面上用虚线框表示）。所以"打勾"这件事只发生在最小单元上。
 *
 * ```
 * 资料内部完成度 = 已完成最小单元 / 最小单元总数
 * 主题进度       = Σ(资料占比 × 资料内部完成度) ÷ Σ占比   ← 自动归一化，不必凑满 100
 * ```
 *
 * 实测例：占比 50/30/20，内部完成度 43% / 0% / 100%
 *   → (50×43 + 30×0 + 20×100) ÷ 100 = **42%**
 *
 * 这两个数都**不落库**：占比怎么归一化取决于"当前有哪些资料"，
 * 落库会让"改一个占比"变成"要重写全部资料"，还会丢掉用户原本填的数字
 * （用户填 5/3/2 与填 50/30/20 是一回事，必须原样留着）。
 */

/** 进度计算只需要节点的这几项（学习/读书的节点都满足） */
export interface TreeProgressItem {
  id: string
  parentId: string | null
  done: boolean
}

/** 资料行（树根节点）上用户填的占比 */
export interface TreeShareItem {
  percent?: number
}

/** 内部完成度：已完成最小单元 / 最小单元总数 */
export interface LeafProgress {
  done: number
  total: number
  /** 0–100 的整数；没有最小单元时为 0 */
  percent: number
}

/**
 * 缩进规则（`docs\TASKS\02` §5.3）：**层数不限**，但第 5 层起缩进收窄。
 *
 * 第 1–4 层每层 20px；第 5 层起每层 12px（不砍层级，但避免深层把文字挤没）。
 * 同一深度必须永远得到同一个值——所以它是纯函数，不进组件内部。
 */
export const INDENT_BASE = 20
export const INDENT_NARROW = 12
/** 从第几层开始收窄（1 起数：第 5 层 → depth 4） */
export const INDENT_NARROW_FROM_LEVEL = 5

export function indentForDepth(depth: number): number {
  const level = Math.max(0, Math.floor(depth))
  if (level < INDENT_NARROW_FROM_LEVEL - 1) return level * INDENT_BASE
  const wide = (INDENT_NARROW_FROM_LEVEL - 1) * INDENT_BASE
  return wide + (level - (INDENT_NARROW_FROM_LEVEL - 1)) * INDENT_NARROW
}

/** 把用户填的占比合法化：任意有限非负数；非法值返回 undefined（= 没填） */
export function clampShare(value: unknown): number | undefined {
  const parsed = typeof value === 'number' ? value : Number.parseFloat(String(value ?? ''))
  if (!Number.isFinite(parsed) || parsed < 0) return undefined
  return parsed
}

/**
 * 取一个资料的有效占比：**没填或填 0 都按 1 计**。
 *
 * 这样"没设占比的几份资料之间就是等权"，比按 0 计（等于把这份资料从主题里删掉）
 * 更符合直觉：用户没填是"还不知道"，不是"不重要"。
 */
export function shareOf(node: TreeShareItem): number {
  const share = clampShare(node.percent)
  return share === undefined || share === 0 ? 1 : share
}

/** 没有子节点的节点 id 集合 —— 也就是参与计数的"最小单元" */
export function leafIds(items: TreeProgressItem[]): Set<string> {
  const ids = new Set(items.map((item) => item.id))
  const hasChild = new Set<string>()
  for (const item of items) {
    if (item.parentId !== null && ids.has(item.parentId)) hasChild.add(item.parentId)
  }
  const leaves = new Set<string>()
  for (const item of items) {
    if (!hasChild.has(item.id)) leaves.add(item.id)
  }
  return leaves
}

/** 某个节点是不是最小单元（没有子节点） */
export function isMinimalUnit(items: TreeProgressItem[], id: string): boolean {
  return leafIds(items).has(id)
}

/**
 * 内部完成度：**只看最小单元**。
 *
 * 有子节点的节点无论自己勾没勾都不计入——它只是汇总，
 * 把它一起算会让"父节点勾了、子节点没勾"这种状态把进度算高一截。
 */
export function leafProgress(items: TreeProgressItem[], id: string): LeafProgress {
  const subtree = new Set([id, ...descendantIdsOf(items, id)])
  const leaves = leafIds(items)
  let done = 0
  let total = 0
  for (const item of items) {
    if (!subtree.has(item.id) || !leaves.has(item.id)) continue
    total += 1
    if (item.done) done += 1
  }
  return { done, total, percent: total === 0 ? 0 : Math.round((done / total) * 100) }
}

/** 某个节点的全部后代 id（含环保护） */
export function descendantIdsOf(items: TreeProgressItem[], id: string): string[] {
  const childrenOf = new Map<string, string[]>()
  for (const item of items) {
    if (item.parentId === null) continue
    const list = childrenOf.get(item.parentId) ?? []
    list.push(item.id)
    childrenOf.set(item.parentId, list)
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
  return out
}

/** 树里所有最小单元的完成情况（整棵树，不区分资料） */
export function treeProgress(items: TreeProgressItem[]): LeafProgress {
  const leaves = leafIds(items)
  let done = 0
  let total = 0
  for (const item of items) {
    if (!leaves.has(item.id)) continue
    total += 1
    if (item.done) done += 1
  }
  return { done, total, percent: total === 0 ? 0 : Math.round((done / total) * 100) }
}

/**
 * 主题进度 = Σ(占比 × 资料内部完成度) ÷ Σ占比。
 *
 * roots 传**该主题下的资料（根节点）**，每项的 percent 是用户填的占比。
 * 占比自动归一化：填 50/30/20 与填 5/3/2 得到同一个结果。
 *
 * 边界：
 *   - 空树（没有资料）→ 0，不能返回 NaN
 *   - 全部资料占比都是 0（或都没填）→ 按等权平均（shareOf 兜底成 1）
 *   - 单节点 → 就是它自己的完成度
 */
export function topicProgress(
  items: TreeProgressItem[],
  roots: Array<TreeProgressItem & TreeShareItem>
): number {
  let weighted = 0
  let totalShare = 0
  for (const root of roots) {
    const share = shareOf(root)
    weighted += share * leafProgress(items, root.id).percent
    totalShare += share
  }
  if (totalShare <= 0) return 0
  return Math.round(weighted / totalShare)
}

/**
 * 资料行的两个数字（`docs\TASKS\02` §5.2 / 验收 DoD）：
 *   `占比 50% · 已学 43%（3/7）`
 *
 * 占比是**归一化之后**的百分比：三份分别填 50/30/20 时显示 50% / 30% / 20%。
 */
export function progressText(
  share: number,
  allShares: number[],
  progress: LeafProgress
): string {
  return `占比 ${sharePercent(share, allShares)}% · 已学 ${progress.percent}%（${progress.done}/${progress.total}）`
}

/** 一个占比在全部占比里占多少（归一化，四舍五入到整数百分比） */
export function sharePercent(share: number, allShares: number[]): number {
  const total = allShares.reduce((sum, value) => sum + value, 0)
  if (total <= 0) return 0
  return Math.round((share / total) * 100)
}
