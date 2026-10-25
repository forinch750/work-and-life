/**
 * 删除前的关联解除（第二轮 BUG-007 / 需求「六、删除与回收站规则」）
 *
 * 规则原文：
 *   1. 删除实体时，先解除与任务、复习项、章节的关联关系
 *   2. 实体本身进入回收站
 *   3. **关联数据不自动删除**，保留在原处或标记为"无关联"
 *   4. 删除前弹出确认，明确说明"仅删除当前项，关联内容将解除关联但保留"
 *
 * 这里只算"要改哪些记录"，不碰存储——由调用方决定何时写盘。
 * 抽成纯函数是为了能单测：解除关联一旦漏掉某一类引用，
 * 界面上就会出现"点进任务却找不到所属主题"这类悬空引用，很难靠手点发现。
 */

import type { DataModule } from './modules'

export interface UnlinkPatch {
  /** 目标模块（与 DATA_MODULES 一致，保证补丁只能写回真实存在的模块） */
  module: DataModule
  id: string
  /** 要写回的字段补丁 */
  patch: Record<string, unknown>
}

export interface UnlinkResult {
  /** 需要写回的记录补丁 */
  patches: UnlinkPatch[]
  /** 面向用户的说明，用于删除确认弹窗与操作后提示 */
  summary: string
}

/** 记录的最小形状（避免依赖具体模块的类型） */
export type AnyRecord = Record<string, unknown>

function isAlive(record: AnyRecord): boolean {
  return record['deletedAt'] === undefined || record['deletedAt'] === null
}

/**
 * 删除一个学习主题时要做的解除关联。
 *
 * 处理三类引用：
 *   - 计划任务上的 projectId 指向这个主题 → 清空（任务保留在原处，只是不再归属）
 *   - 该主题下的资料与树节点 → 一并软删除（它们是主题的从属内容，留着就是孤儿）
 *   - 学习日志 → **保留**（那是学习历史，按规则"关联数据不自动删除"）
 *
 * 复习卡的 source 字段只是生成时抄下的标题文本，不是外键，不需要处理。
 */
export function unlinkLearningTopic(
  topicId: string,
  learningRecords: AnyRecord[],
  planRecords: AnyRecord[]
): UnlinkResult {
  const patches: UnlinkPatch[] = []

  // 1) 计划任务解除归属
  for (const task of planRecords) {
    if (!isAlive(task)) continue
    if (task['projectId'] !== topicId) continue
    patches.push({ module: 'plan', id: String(task['id'] ?? ''), patch: { projectId: '' } })
  }

  // 2) 主题下的从属内容一并软删除（资料、树节点）
  let removedChildren = 0
  for (const record of learningRecords) {
    if (!isAlive(record)) continue
    if (record['topicId'] !== topicId && record['ownerId'] !== topicId) continue
    const kind = String(record['kind'] ?? '')
    if (kind !== 'resource' && kind !== 'node') continue
    patches.push({
      module: 'learning',
      id: String(record['id'] ?? ''),
      patch: { deletedAt: new Date().toISOString() }
    })
    removedChildren += 1
  }

  const taskCount = patches.filter((item) => item.module === 'plan').length
  const parts: string[] = []
  parts.push(`同时移除该主题下的 ${removedChildren} 项资料/章节`)
  if (taskCount > 0) parts.push(`并解除 ${taskCount} 个任务与它的归属关系（任务保留在原处）`)
  parts.push('学习日志会保留')

  return { patches, summary: parts.join('；') }
}

/**
 * 删除一本书时要做的解除关联。
 *
 * 处理三类引用：
 *   - 阅读记录与摘录 → **保留**（那是阅读痕迹，按规则不自动删除）
 *   - 树节点（本轮之后书下也会有章节）→ 一并软删除
 *   - 计划任务不会引用书，无需处理
 */
export function unlinkBook(
  bookId: string,
  readingRecords: AnyRecord[]
): UnlinkResult {
  const patches: UnlinkPatch[] = []
  let removedNodes = 0

  for (const record of readingRecords) {
    if (!isAlive(record)) continue
    if (record['ownerId'] !== bookId) continue
    if (String(record['kind'] ?? '') !== 'node') continue
    patches.push({
      module: 'reading',
      id: String(record['id'] ?? ''),
      patch: { deletedAt: new Date().toISOString() }
    })
    removedNodes += 1
  }

  const parts = ['该书的阅读记录与摘录会保留（可从回收站恢复整本书）']
  if (removedNodes > 0) parts.unshift(`同时移除该书下的 ${removedNodes} 个章节`)

  return { patches, summary: parts.join('；') }
}

/**
 * 删除一个树节点时要连带处理的整棵子树。
 * 与 unlinkLearningTopic 不同：这里删的就是节点本身，子节点跟着走。
 */
export function unlinkTreeNode(
  nodeId: string,
  descendantIds: string[],
  module: 'learning' | 'reading'
): UnlinkResult {  const stamp = new Date().toISOString()
  const patches: UnlinkPatch[] = [nodeId, ...descendantIds].map((id) => ({
    module,
    id,
    patch: { deletedAt: stamp }
  }))
  const childCount = descendantIds.length
  return {
    patches,
    summary: childCount > 0 ? `将同时删除 ${childCount} 个子章节` : '没有子章节'
  }
}
