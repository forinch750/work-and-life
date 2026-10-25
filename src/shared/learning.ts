/**
 * 学习模块的数据模型（DEVPLAN 阶段 5 / PRD §5.3）
 *
 * 四类记录都放在 data\learning.json 里，用 kind 区分：
 *   topic    学习主题（标题、状态、进度）
 *   resource 资料来源（名称、类型、进度如"第 3/10 章"）—— v1 的旧形状
 *   node     树节点（资料 → 章 → 子章 → 条目）—— v2 起的主形状
 *   log      学习日志（日期、时长、内容）
 *
 * ## v2 的树（第 01 块）
 *
 * 资料**就是树的根节点**，不再和树是两套东西：
 *
 *   topicId = T                    ← 树的所有者（ownerId）
 *    ├─ node(父=null, percent=50, resourceType='书')   ← 原来的"资料"，现在叫根节点
 *    │   ├─ node(父=根)                               ← 章
 *    │   │   └─ node(父=章)                           ← 子章 / 条目
 *    │   └─ node(父=根)
 *    └─ node(父=null, percent=30)                     ← 第二份资料
 *
 * 三个 id 的关系（**下一块别搞混**）：
 *   - `ownerId`  = **学习主题 id**。树的边界就是它：跨 owner 移动必须拒绝
 *     （`src\shared\tree.ts` 的 `moveNode` 按 ownerId 判断）。
 *   - `parentId` = 父节点 id；资料这类根节点为 `null`。
 *     一个章节属于哪份资料，靠**沿 parentId 往上走**得到。
 *   - `topicId`  = 该节点最终归属的主题 id（与 ownerId 同值，冗余但让
 *     "按主题筛节点"是一次判断，不用先建树再回溯）。
 *
 * 这样定的原因（`docs\TASKS\01` §5.2 "resource 转成树的根级节点"）：
 * 资料若另开一套 `resource` 记录、树再挂到资料 id 上，就会出现
 * "半树半平"的双轨状态——两处都要读、删除要同步、进度要合并，
 * 正是本轮要清掉的东西。
 */
import type { BaseRecord } from './types'
import type { ContentFormat } from './richText'
import { normalizeRichText, toPlainText } from './richText'
import { clampShare, shareOf } from './treeProgress'
import { clampTargetDays } from './learningPageView'

export { clampShare, shareOf }

export type TopicStatus = 'active' | 'done' | 'archived'

export const TOPIC_STATUS_LABELS: Record<TopicStatus, string> = {
  active: '进行中',
  done: '已完成',
  archived: '已归档'
}

export interface LearningTopic extends BaseRecord {
  kind: 'topic'
  title: string
  status: TopicStatus
  /** 进度百分比 0–100；手动那一档，只是参考（自动那一档按树算，见 treeProgress.ts） */
  progress: number
  description?: string
  /**
   * 时限（天）。第 09 块加的可选字段：预览区信息卡上显示「时限 30 天」。
   *
   * 没有它就显示「未设时限」——**不落默认值**，老记录天然等于没设时限，
   * 不需要迁移，也不会把用户没填过的东西写成 0。
   */
  targetDays?: number
}

export interface LearningResource extends BaseRecord {
  kind: 'resource'
  topicId: string
  name: string
  /** 资料类型，自由文本：书 / 视频 / 课程 / 文档… */
  type: string
  /** 当前进度描述，例如 "第 3/10 章" */
  progress: string
  /** 可选的完成百分比，用于"按资料推进" */
  percent?: number
}

/**
 * 树节点（资料 / 章 / 子章 / 条目）。
 *
 * 字段与 `TreeNode`（tree.ts）对齐并扩展，所以可以直接交给
 * `buildTree` / `moveNode` / `subtreeProgress` 使用。
 */
export interface LearningNode extends BaseRecord, TreeShape {
  kind: 'node'
  ownerId: string
  parentId: string | null
  /** 同级内排序，从 0 开始 */
  order: number
  title: string
  done: boolean
  /** 所属主题 id（与 ownerId 同值，便于按主题筛选） */
  topicId: string
  /**
   * **占比**：这份资料在主题里的分量，用户自己填，程序按比例自动归一化
   * （填 50/30/20 与 5/3/2 等价，不必凑满 100）。
   * 只有**资料（根节点）**有这一项；章 / 子章没有。
   *
   * 与"内部完成度"是两件事：内部完成度按最小单元（无子节点的节点）算，
   * 由 `subtreeProgress` 之类在渲染时算出来，**不落库**。
   */
  percent?: number
  /** 资料分组名（原 `resource.type`，例如"书 / 视频 / 课程"）；只有根节点有 */
  resourceType?: string
  /**
   * **分组名**（用户自己填，第 09 块加的可选字段）。
   *
   * 与 `resourceType`（类型：书 / 文档…）是两件事：
   * 界面上一份资料显示成 `教材 · 书`（分组 · 类型），树里按分组归拢。
   * 老数据只有 `resourceType`（那时它同时充当分组名），
   * 所以渲染时缺 `group` 就只写类型（见 `learningPageView.resourceLabel`），
   * **不前推、不迁移、不写默认值**。
   */
  group?: string
  /** 正文格式标记：缺省即 plain（旧数据零改写），新记录写 rich */
  contentFormat?: ContentFormat
  /** 节点上的备注 / 说明 */
  note?: string
}

/** 与 tree.ts 的 TreeNode 形状对齐（避免两个模块互相 import 造成环） */
interface TreeShape {
  id: string
  ownerId: string
  parentId: string | null
  order: number
  title: string
  done: boolean
}

export interface LearningLog extends BaseRecord {
  kind: 'log'
  topicId: string
  /** 学习日期 YYYY-MM-DD */
  date: string
  /** 时长（分钟） */
  minutes: number
  content: string
  /** 正文格式标记：缺省即 plain（旧数据零改写） */
  contentFormat?: ContentFormat
  /** 日志挂在哪个章节上（决定 16）；旧日志没有这一项 */
  nodeId?: string
}

export type LearningRecord = LearningTopic | LearningResource | LearningNode | LearningLog

export function isTopic(value: LearningRecord): value is LearningTopic {
  return value.kind === 'topic'
}
export function isResource(value: LearningRecord): value is LearningResource {
  return value.kind === 'resource'
}
export function isNode(value: LearningRecord): value is LearningNode {
  return value.kind === 'node'
}
export function isLog(value: LearningRecord): value is LearningLog {
  return value.kind === 'log'
}

export function isTopicStatus(value: unknown): value is TopicStatus {
  return value === 'active' || value === 'done' || value === 'archived'
}

/** 进度夹到 0–100 的整数 */
export function clampProgress(value: unknown): number {
  const parsed = typeof value === 'number' ? value : Number.parseInt(String(value ?? ''), 10)
  if (!Number.isFinite(parsed)) return 0
  return Math.min(100, Math.max(0, Math.round(parsed)))
}

/** 时长夹到 0–1440 分钟 */
export function clampMinutes(value: unknown): number {
  const parsed = typeof value === 'number' ? value : Number.parseInt(String(value ?? ''), 10)
  if (!Number.isFinite(parsed)) return 0
  return Math.min(1440, Math.max(0, Math.round(parsed)))
}

/**
 * 占比的合法化与取值。
 *
 * **实现在 `src\shared\treeProgress.ts`**（第 02 块搬过去的）：占比属于
 * "树的进度模型"，学习与读书共用同一套，`docs\TASKS\02` §5.2 要求它可单测。
 * 这里保留再导出，旧调用方（含既有单测）不用改。
 */

/** 把任意记录规范成学习记录；无法识别 kind 时返回 null */
export function normalizeLearningRecord(
  input: Record<string, unknown>
): LearningRecord | null {
  const kind = input['kind']
  const id = String(input['id'] ?? '')
  const createdAt = String(input['createdAt'] ?? '')
  const updatedAt = String(input['updatedAt'] ?? '')
  if (id === '') return null
  const base = {
    id,
    createdAt,
    updatedAt,
    ...(typeof input['deletedAt'] === 'string' ? { deletedAt: input['deletedAt'] } : {})
  }

  if (kind === 'topic') {
    const targetDays = clampTargetDays(input['targetDays'])
    return {
      ...base,
      kind: 'topic',
      title: String(input['title'] ?? '').trim(),
      status: isTopicStatus(input['status']) ? input['status'] : 'active',
      progress: clampProgress(input['progress']),
      ...(typeof input['description'] === 'string' && input['description'] !== ''
        ? { description: input['description'] }
        : {}),
      ...(targetDays === undefined ? {} : { targetDays })
    }
  }

  if (kind === 'resource') {
    const percent = clampProgress(input['percent'])
    return {
      ...base,
      kind: 'resource',
      topicId: String(input['topicId'] ?? ''),
      name: String(input['name'] ?? '').trim(),
      type: String(input['type'] ?? '资料').trim() || '资料',
      progress: String(input['progress'] ?? '').trim(),
      ...(percent > 0 ? { percent } : {})
    }
  }

  if (kind === 'node') {
    const parent = input['parentId']
    const parentId = typeof parent === 'string' && parent !== '' ? parent : null
    const percent = clampShare(input['percent'])
    const topicId = String(input['topicId'] ?? '')
    return {
      ...base,
      kind: 'node',
      ownerId: String(input['ownerId'] ?? topicId),
      parentId: parentId === id ? null : parentId, // 自己是自己的父级是无意义的坏数据
      order: Number.isFinite(input['order']) ? Math.max(0, Math.trunc(Number(input['order']))) : 0,
      title: String(input['title'] ?? '').trim(),
      done: input['done'] === true,
      topicId,
      ...(percent !== undefined && percent > 0 ? { percent } : {}),
      ...(typeof input['resourceType'] === 'string' && input['resourceType'] !== ''
        ? { resourceType: input['resourceType'] }
        : {}),
      ...(typeof input['group'] === 'string' && input['group'].trim() !== ''
        ? { group: input['group'].trim() }
        : {}),
      ...(input['contentFormat'] === 'rich' ? { contentFormat: 'rich' as const } : {}),
      ...(typeof input['note'] === 'string' && input['note'] !== '' ? { note: input['note'] } : {})
    }
  }

  if (kind === 'log') {
    const rich = normalizeRichText(input['content'], input['contentFormat'])
    return {
      ...base,
      kind: 'log',
      topicId: String(input['topicId'] ?? ''),
      date: String(input['date'] ?? ''),
      minutes: clampMinutes(input['minutes']),
      content: rich.text.trim(),
      ...(rich.contentFormat ? { contentFormat: rich.contentFormat } : {}),
      ...(typeof input['nodeId'] === 'string' && input['nodeId'] !== ''
        ? { nodeId: input['nodeId'] }
        : {})
    }
  }

  return null
}

/**
 * 旧资料 → 树根节点（v1 → v2 迁移的核心，也供迁移单测直接调用）。
 *
 * 映射（`docs\TASKS\01` §5.2 / `MASTER.md` §9.5）：
 *   name      → title
 *   progress  → note
 *   percent   → percent（**占比，保留**）
 *   type      → resourceType（它就是"分组名"，字段名变了但值不动）
 *   id / createdAt / updatedAt / deletedAt → 原样保留
 *   parentId  → null（资料就是根）
 *   order     → 按原顺序（调用方传入）
 *
 * **不丢字段**：先把原记录整条铺开，再覆盖要改的键。这样 v1 里任何
 * 本轮还不知道的字段都会原样留下来。
 */
export function resourceToNode(
  resource: Record<string, unknown>,
  order: number
): Record<string, unknown> {
  const topicId = String(resource['topicId'] ?? '')
  const name = String(resource['name'] ?? '')
  const note = typeof resource['progress'] === 'string' ? resource['progress'] : ''
  const percent = clampShare(resource['percent'])
  const resourceType = String(resource['type'] ?? '').trim()

  // 解构出"要改名/要丢掉"的几个键，剩下的（含 v1 里本轮还不认识的字段）靠 rest 原样带上
  const {
    name: _droppedName,
    progress: _droppedProgress,
    type: _droppedType,
    percent: _droppedPercent,
    ...rest
  } = resource

  return {
    ...rest,
    kind: 'node',
    ownerId: topicId,
    topicId,
    parentId: null,
    order,
    title: name,
    done: false,
    ...(note !== '' ? { note } : {}),
    ...(percent !== undefined && percent > 0 ? { percent } : {}),
    ...(resourceType !== '' ? { resourceType } : {})
  }
}

/**
 * 按资料推进进度：取该主题下所有资料里"完成度最高"的那个。
 * 设计取舍：不做加权平均——那会把"一本书读到 80%"和"另一本没开始"平均成 40%，
 * 与直觉不符。取最高值是"我已经推进到哪"的更自然表达。
 */
export function progressFromResources(resources: LearningResource[]): number {
  if (resources.length === 0) return 0
  return resources.reduce((max, resource) => Math.max(max, resource.percent ?? 0), 0)
}

export interface TopicSummary {
  topic: LearningTopic
  resourceCount: number
  logCount: number
  totalMinutes: number
  lastLogDate: string | null
}

/** 只统计"是这个主题的资料"，不关心传进来的是旧 resource 还是新 node */
interface OwnedResource {
  topicId: string
}

/**
 * 汇总每个主题的资料数、日志数与总时长（学习页列表用）。
 *
 * v2 起"资料"就是树里的根节点：调用方传
 * `nodes.filter((node) => node.parentId === null)` 即可，与旧行为一致
 * （章 / 子章不会被算成资料）。
 */
export function summarizeTopics(
  topics: LearningTopic[],
  resources: OwnedResource[],
  logs: LearningLog[]
): TopicSummary[] {
  return topics.map((topic) => {
    const ownResources = resources.filter((item) => item.topicId === topic.id)
    const ownLogs = logs.filter((item) => item.topicId === topic.id)
    const sorted = [...ownLogs].sort((a, b) => (a.date < b.date ? 1 : -1))
    return {
      topic,
      resourceCount: ownResources.length,
      logCount: ownLogs.length,
      totalMinutes: ownLogs.reduce((sum, item) => sum + item.minutes, 0),
      lastLogDate: sorted[0]?.date ?? null
    }
  })
}

/** 学习日志按日期倒序、同日按创建时间倒序 */
export function sortLogs(logs: LearningLog[]): LearningLog[] {
  return [...logs].sort((a, b) => {
    if (a.date !== b.date) return a.date < b.date ? 1 : -1
    return String(b.createdAt).localeCompare(String(a.createdAt))
  })
}

/** 生成"某天的学习刻度"：进度条上显示每天学过没有 */
export interface StudyMark {
  date: string
  minutes: number
}

export function studyMarks(logs: LearningLog[]): StudyMark[] {
  const map = new Map<string, number>()
  for (const log of logs) {
    map.set(log.date, (map.get(log.date) ?? 0) + log.minutes)
  }
  return [...map.entries()]
    .map(([date, minutes]) => ({ date, minutes }))
    .sort((a, b) => (a.date < b.date ? -1 : 1))
}

/** 把学习日志转成复习卡的正反面 */
export function logToCard(log: LearningLog, topicTitle: string): {
  front: string
  back: string
  source: string
} {
  const content = toPlainText(log.content, log.contentFormat)
  return {
    front: `${topicTitle}：${content}`,
    back: `${log.date} 学了 ${log.minutes} 分钟`,
    source: topicTitle
  }
}
