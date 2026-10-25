/**
 * 学习页的**视图计算**（第 09 块 · `MASTER.md` §7.5 + §7.9 + 决定 11–16）
 *
 * 这里只放**纯函数**：进来的是记录数组，出去的是界面上直接显示的那几个字符串与数字。
 *
 * ## 为什么另起一份，而不是写在页面里
 *
 * 1. **进度公式不许重写**。`MASTER.md` §7.9 的两个进度（占比 / 内部完成度）
 *    在第 02 块就抽进了 `src\shared\treeProgress.ts`，第 08 块又补了回归单测。
 *    本文件**一行公式都没有**：`topicPercent()` 直接转调 `topicProgress()`，
 *    资料行的两个数字直接转调 `progressText()` / `leafProgress()`。
 *    → 单测能把"学习页算出来的数"与"公共实现的数"钉成同一个（§7.2 第一条）。
 * 2. **vitest 是 `environment: 'node'`**（没有 jsdom、也不许引 jsdom）：
 *    组件行为交给端到端验收（`src\main\verify\phase8.ts` 的 P8-S*），
 *    能单测的只有"算出来的数对不对"，所以算的部分必须从组件里搬出来。
 *
 * ## 09 块定义的界面口径（与 §7.5 的定稿一一对应）
 *
 * | 界面位置 | 显示什么 | 谁算 |
 * |---|---|---|
 * | 左栏主题行 | `42% · 资料 3 · 180 分钟` | `topicListMeta()` |
 * | 预览左侧信息卡 | 开始 / 时限 / 资料 / 学习记录 | `topicPreviewFacts()` |
 * | 预览进度条 | 主题进度 = Σ(占比 × 内部完成度) ÷ Σ占比 | `topicPercent()` |
 * | 中区「资料」卡 | `教材 · 书 · 占比 50%` | `resourceCardMeta()` |
 * | 中区「学习日志」卡 | 日期 / 时长 / → 复习 | `topicLogs()`（含挂在章节上的） |
 * | 下区树的资料行 | `占比 50% · 已学 43%（3/7）` | `rowProgressText()` |
 * | 下区树的章节行 | `已学 33%（1/3）` | `chapterProgressText()` |
 */

import { dateKey } from './date'
import type { TopicStatus } from './learning'
import {
  leafProgress,
  progressText,
  shareOf,
  sharePercent,
  topicProgress,
  type TreeProgressItem
} from './treeProgress'

/** 视图计算只需要节点的这几项（`LearningNode` 原样满足） */
export interface LearningViewNode extends TreeProgressItem {
  title: string
  /** 资料的分组名（用户自己填，第 09 块新加；旧数据没有） */
  group?: string
  /** 资料的类型（书 / 视频 / 课程 / 文档…） */
  resourceType?: string
  /** 资料的占比（任意正数，自动归一化） */
  percent?: number
  /** 树的所有者（学习主题 id） */
  ownerId?: string
  topicId?: string
}

/** 视图计算只需要日志的这几项（`LearningLog` 原样满足） */
export interface LearningViewLog {
  id: string
  topicId: string
  date: string
  minutes: number
  /** 挂在哪个章节上（决定 16）；旧日志没有这一项 */
  nodeId?: string
}

/** 某个主题下的整棵树（资料是根，章 / 子章挂在下面） */
export function nodesOfTopic<T extends { ownerId?: string; topicId?: string }>(
  nodes: T[],
  topicId: string
): T[] {
  if (topicId === '') return []
  return nodes.filter((node) => node.ownerId === topicId || node.topicId === topicId)
}

/**
 * 根节点 = 界面上的「资料」。
 *
 * v2 起磁盘上只有一种从属记录（`kind: 'node'`）：`parentId === null` 的那个就是资料。
 */
export function resourcesOf<T extends { parentId: string | null }>(nodes: T[]): T[] {
  return nodes.filter((node) => node.parentId === null)
}

/** 主题下的学习日志：**含挂在章节上的那些**（决定 16），按日期倒序 */
export function topicLogs<T extends LearningViewLog>(logs: T[], topicId: string): T[] {
  if (topicId === '') return []
  return logs
    .filter((log) => log.topicId === topicId)
    .slice()
    .sort((a, b) => (a.date === b.date ? 0 : a.date < b.date ? 1 : -1))
}

/** 主题进度：**直接转调公共实现**，不在这里再写一遍加权平均 */
export function topicPercent(nodes: LearningViewNode[], topicId: string): number {
  const own = nodesOfTopic(nodes, topicId)
  return topicProgress(own, resourcesOf(own))
}

export interface TopicListMeta {
  /** 主题进度（占比加权，0–100） */
  percent: number
  resourceCount: number
  logCount: number
  totalMinutes: number
}

/** 左栏主题行要显示的四样东西（§6.1：名字 / 进度% / 资料数 / 时长） */
export function topicListMeta(
  topicId: string,
  nodes: LearningViewNode[],
  logs: LearningViewLog[]
): TopicListMeta {
  const own = nodesOfTopic(nodes, topicId)
  const ownLogs = logs.filter((log) => log.topicId === topicId)
  return {
    percent: topicProgress(own, resourcesOf(own)),
    resourceCount: resourcesOf(own).length,
    logCount: ownLogs.length,
    totalMinutes: ownLogs.reduce((sum, log) => sum + Math.max(0, Math.round(log.minutes || 0)), 0)
  }
}

/** 左栏主题行的副标题：`42% · 资料 3 · 180 分钟` */
export function topicListMetaText(meta: TopicListMeta): string {
  return `${meta.percent}% · 资料 ${meta.resourceCount} · ${meta.totalMinutes} 分钟`
}

/** 一份资料在全部资料里的占比（归一化后的整数百分比） */
export function resourceSharePercent(node: LearningViewNode, allNodes: LearningViewNode[]): number {
  return sharePercent(
    shareOf(node),
    resourcesOf(allNodes).map((item) => shareOf(item))
  )
}

/**
 * 资料卡那一行：`教材 · 书 · 占比 50%`（§6.3）。
 *
 * 分组名与类型缺哪个就少写哪个——旧数据只有 `resourceType`，
 * 那时它就同时充当分组名（`docs\TASKS\01` §5.2 的迁移口径），所以不能显示成「书 · 书」。
 */
export function resourceCardMeta(node: LearningViewNode, allNodes: LearningViewNode[]): string {
  const parts: string[] = []
  const label = resourceLabel(node)
  if (label !== '') parts.push(label)
  parts.push(`占比 ${resourceSharePercent(node, allNodes)}%`)
  return parts.join(' · ')
}

/** 资料行的行首标签（分组名 · 类型）；两项相同只写一个，都没有返回空串 */
export function resourceLabel(node: LearningViewNode): string {
  const group = (node.group ?? '').trim()
  const type = (node.resourceType ?? '').trim()
  if (group !== '' && type !== '' && group !== type) return `${group} · ${type}`
  return group !== '' ? group : type
}

/**
 * 树行上的进度文字（§7.9 / 决定 12）。
 *
 * - 资料行（根节点）：**两个数字** —— `占比 50% · 已学 43%（3/7）`
 * - 章 / 子章：只有已学 —— `已学 33%（1/3）`（占比只属于资料）
 * - 找不到这个节点：`null`（界面就不显示这一格）
 */
export function rowProgressText(id: string, nodes: LearningViewNode[]): string | null {
  const node = nodes.find((candidate) => candidate.id === id)
  if (node === undefined) return null
  if (node.parentId !== null) return chapterProgressText(node, nodes)
  return progressText(
    shareOf(node),
    resourcesOf(nodes).map((item) => shareOf(item)),
    leafProgress(nodes, node.id)
  )
}

/** 章 / 子章行的进度：只数它下面的最小单元 */
export function chapterProgressText(node: LearningViewNode, nodes: LearningViewNode[]): string {
  const inner = leafProgress(nodes, node.id)
  return `已学 ${inner.percent}%（${inner.done}/${inner.total}）`
}

export interface TopicPreviewFacts {
  /** 开始（YYYY-MM-DD）；记录没有时间戳时是空串 */
  startedAt: string
  /** 时限：`30 天` / `未设时限` */
  timeLimit: string
  resourceCount: number
  logCount: number
  totalMinutes: number
  /** `6 条 · 180 分钟` */
  recordText: string
}

/** 预览区左侧信息卡上的这几行（§6.2：说明 / 开始日期 / 时限 / 资料数 / 记录数） */
export function topicPreviewFacts(
  topic: { id: string; createdAt?: string; targetDays?: number },
  nodes: LearningViewNode[],
  logs: LearningViewLog[]
): TopicPreviewFacts {
  const meta = topicListMeta(topic.id, nodes, logs)
  return {
    startedAt: startedAtLabel(topic.createdAt),
    timeLimit: timeLimitText(topic.targetDays),
    resourceCount: meta.resourceCount,
    logCount: meta.logCount,
    totalMinutes: meta.totalMinutes,
    recordText: recordLineText(meta.logCount, meta.totalMinutes)
  }
}

/** `2026-09-20` → 原样；空 / 非法时间戳 → 空串（不往界面上写 Invalid Date） */
export function startedAtLabel(createdAt: unknown): string {
  const raw = typeof createdAt === 'string' ? createdAt.trim() : ''
  if (raw === '') return ''
  const date = new Date(raw)
  if (Number.isNaN(date.getTime())) return ''
  return dateKey(date)
}

/**
 * 时限文字：没填 / 填 0 / 非法一律「未设时限」。
 *
 * 产品上没有"第 0 天"这种时限，所以 0 与没填归同一档；
 * 显示成「未设时限」而不是留空，是为了让这一行永远有字，界面不会忽高忽低。
 */
export function timeLimitText(days: unknown): string {
  const parsed = typeof days === 'number' ? days : Number.parseFloat(String(days ?? ''))
  if (!Number.isFinite(parsed) || parsed <= 0) return '未设时限'
  return `${Math.round(parsed)} 天`
}

/** `6 条 · 180 分钟` */
export function recordLineText(logCount: number, totalMinutes: number): string {
  const count = Number.isFinite(logCount) ? Math.max(0, Math.trunc(logCount)) : 0
  const minutes = Number.isFinite(totalMinutes) ? Math.max(0, Math.trunc(totalMinutes)) : 0
  return `${count} 条 · ${minutes} 分钟`
}

/**
 * 时限天数收口：只有正整数才落库，其它返回 `undefined`（= 不写这个字段）。
 *
 * 与 `clampShare` 同一套思路：界面上的空 / 0 / 乱填都不该变成一条坏数据，
 * 也不该把用户原来填的数改成 0（那样"清空"与"填 0"就分不开了）。
 */
export function clampTargetDays(value: unknown): number | undefined {
  const parsed = typeof value === 'number' ? value : Number.parseInt(String(value ?? ''), 10)
  if (!Number.isFinite(parsed) || parsed <= 0) return undefined
  return Math.round(parsed)
}

/**
 * 三步走的判定（决定 1 / §6.6）。
 *
 * 「进入」不是路由，也不是整页替换：它只是**下方树那一段显不显示**。
 * 所以状态就是一个 id：`entered === selected.topic.id` 时树展开；
 * 换主题、删除主题、刷新页面都会让它自动回到"未进入"（比对不上就等于没进入）。
 *
 * 10（复习页）、11（读书页）照抄这三行即可，别各自发明一套状态。
 */
export function isTopicEntered(enteredId: string | null, selectedId: string | null): boolean {
  if (enteredId === null || selectedId === null) return false
  return enteredId !== '' && enteredId === selectedId
}

// ===========================================================================
// 学习主题的状态操作（修改 4 轮 · §6.1 的按钮矩阵）
// ===========================================================================

/**
 * 学习主题那四个状态动作的 testid。
 *
 * 前两个沿用了既有验收已经点过的 id（`learning-mark-done` / `learning-archive`）——
 * **沿用是有意的**：现有端到端还在点它们，条件显示之后仍然有效
 * （只有状态不对时才不出现）。
 */
export type TopicStatusActionId =
  | 'learning-mark-done'
  | 'learning-mark-undone'
  | 'learning-archive'
  | 'learning-unarchive'

export interface TopicStatusAction {
  id: TopicStatusActionId
  label: string
  /** 点下去要落库的目标状态（**算出来的**，不在 onClick 里写死） */
  target: TopicStatus
}

/** 按钮文案（唯一一份；页面与单测都从这里取） */
export const TOPIC_STATUS_ACTION_LABELS = {
  markDone: '标记完成',
  markUndone: '标记未完成',
  archive: '归档',
  unarchive: '取消归档'
} as const

/**
 * 学习主题的状态按钮矩阵（用户原话：*"标记完成不能取消"*、
 * *"归档和标记完成不能同时出现"*）。
 *
 * | 当前状态 | 状态动作 | 归档动作 |
 * |---|---|---|
 * | `active`   | 标记完成（→ done）    | 归档（→ archived）    |
 * | `done`     | 标记未完成（→ active）| 归档（→ archived）    |
 * | `archived` | **不出现**            | 取消归档（→ active）  |
 *
 * 两条已定的默认（`修改-4.md` §6.1）：
 *   1. **取消归档一律回到 `active`**，不记忆归档前的状态——简单、可预期
 *   2. `active` 时同时显示「标记完成」与「归档」：这是"两种收尾方式，选一个"，
 *      不是冲突
 *
 * 返回的顺序就是界面上的顺序。数据层本来就支持三态
 * （`shared/learning.ts` 的 `TopicStatus`），这里只是把单向按钮改成条件项。
 */
export function topicStatusActions(status: TopicStatus): TopicStatusAction[] {
  // 已归档：只剩"取消归档"——「标记完成 / 标记未完成」**不再出现**
  if (status === 'archived') {
    return [{ id: 'learning-unarchive', label: TOPIC_STATUS_ACTION_LABELS.unarchive, target: 'active' }]
  }
  const toggle: TopicStatusAction =
    status === 'done'
      ? {
          id: 'learning-mark-undone',
          label: TOPIC_STATUS_ACTION_LABELS.markUndone,
          target: 'active'
        }
      : { id: 'learning-mark-done', label: TOPIC_STATUS_ACTION_LABELS.markDone, target: 'done' }
  return [
    toggle,
    { id: 'learning-archive', label: TOPIC_STATUS_ACTION_LABELS.archive, target: 'archived' }
  ]
}
