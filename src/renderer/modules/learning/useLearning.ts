/**
 * 学习模块数据接口（DEVPLAN 阶段 5；第 02 块接入树）
 *
 * ## v2 起"资料"就是树的**根节点**
 *
 * 磁盘上只有一种从属记录：`kind: 'node'`。
 *   主题（ownerId）→ 资料（parentId = null）→ 章 → 子章 → 条目
 * 所以这里读出来的是**一棵树**，`resources` 只是"根节点"的别名视图
 * （界面上的"资料列表"就是它，避免同时维护两套东西）。
 *
 * 旧的 `kind: 'resource'` 记录在**启动迁移**里就转成了 node
 * （`migrations['learning'][2]`），这里不再写 `resource`。
 */
import { useCallback, useEffect, useState } from 'react'
import { getDataApi } from '../../lib/dataClient'
import { notifyDataChanged, subscribeDataChanged } from '../../lib/dataEvents'
import { unlinkLearningTopic, unlinkTreeNode } from '../../../shared/unlink'
import { buildCreatePatch, buildMovePatches, nextOrderUnder, subtreeIds } from '../../../shared/treeMove'
import {
  normalizeLearningRecord,
  type LearningLog,
  type LearningNode,
  type LearningRecord,
  type LearningTopic
} from '../../../shared/learning'

export interface LearningData {
  topics: LearningTopic[]
  logs: LearningLog[]
  /** 全部树节点（学习主题下的一整棵树，平铺） */
  nodes: LearningNode[]
  /** 根节点 = 界面上的"资料"（`parentId === null` 的节点） */
  resources: LearningNode[]
}

const EMPTY: LearningData = { topics: [], logs: [], nodes: [], resources: [] }

export function splitRecords(records: Array<Record<string, unknown>>): LearningData {
  const result: LearningData = { topics: [], logs: [], nodes: [], resources: [] }
  for (const record of records) {
    if (record['deletedAt'] !== undefined && record['deletedAt'] !== null) continue
    const normalized = normalizeLearningRecord(record)
    if (!normalized) continue
    if (normalized.kind === 'topic' && normalized.title !== '') result.topics.push(normalized)
    else if (normalized.kind === 'node') result.nodes.push(normalized)
    else if (normalized.kind === 'log') result.logs.push(normalized)
  }
  result.resources = result.nodes.filter((node) => node.parentId === null)
  return result
}

export interface NodeInput {
  ownerId: string
  parentId: string | null
  title: string
  percent?: number
  resourceType?: string
  /** 分组名（用户自己填，第 09 块）：与 resourceType（类型）是两件事 */
  group?: string
  note?: string
}

export interface UseLearningResult extends LearningData {
  loading: boolean
  error: string | null
  reload: () => Promise<void>
  addTopic: (title: string, description?: string) => Promise<void>
  updateTopic: (id: string, patch: Partial<LearningTopic>) => Promise<void>
  removeTopic: (id: string) => Promise<void>
  /** 删除主题并解除关联，返回面向用户的说明（BUG-007） */
  removeTopicWithUnlink: (id: string) => Promise<string>
  /** 新增一个树节点；`parentId` 为 null 即新增一份资料 */
  addNode: (input: NodeInput) => Promise<string>
  /** 改节点上的字段（标题 / 占比 / 分组名 / 备注…） */
  updateNode: (id: string, patch: Record<string, unknown>) => Promise<void>
  /** 打勾 / 取消打勾（只对最小单元有意义，界面已拦住汇总节点） */
  toggleNodeDone: (id: string, done: boolean) => Promise<void>
  /** 移动节点；跨 owner 与移到后代下会被 `tree.ts` 拒绝，返回原因 */
  moveTreeNode: (dragId: string, parentId: string | null, index: number) => Promise<string | null>
  /** 删除节点（连同整棵子树，走 unlink 规则），返回面向用户的说明 */
  removeNodeWithUnlink: (id: string) => Promise<string>
  addLog: (input: {
    topicId: string
    date: string
    minutes: number
    content: string
    /** 正文格式标记（第 04 块）：富文本写 'rich'，不传即 plain */
    contentFormat?: 'plain' | 'rich'
    /** 日志挂在哪个章节上（决定 16）；不传 = 挂在主题上 */
    nodeId?: string
  }) => Promise<void>
  removeLog: (id: string) => Promise<void>
}

export function useLearning(): UseLearningResult {
  const [data, setData] = useState<LearningData>(EMPTY)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const reload = useCallback(async () => {
    try {
      const records = (await getDataApi().list('learning')) as Array<Record<string, unknown>>
      setData(splitRecords(records))
      setError(null)
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void reload()
  }, [reload])

  /**
   * 别的页写入了学习数据时跟着刷新。
   *
   * 这条以前缺着：计划页的任务能引用学习主题、首页也可能改到它，
   * 只在挂载时读一次会出现"那边改了、这边还是旧的"。
   * 第 02 块补上后，学习页与读书 / 计划 / 复习三页的口径一致。
   */
  useEffect(() => {
    return subscribeDataChanged((module) => {
      if (module === null || module === 'learning') void reload()
    })
  }, [reload])

  const afterWrite = useCallback(async () => {
    await getDataApi().flush()
    await reload()
    notifyDataChanged('learning')
  }, [reload])

  /** 取主进程最新的记录（连续操作时本地 state 可能还没刷新） */
  const freshRecords = useCallback(
    async (): Promise<Array<Record<string, unknown>>> =>
      (await getDataApi().list('learning')) as Array<Record<string, unknown>>,
    []
  )

  const addTopic = useCallback(
    async (title: string, description?: string) => {
      await getDataApi().add('learning', {
        kind: 'topic',
        title,
        status: 'active',
        progress: 0,
        ...(description ? { description } : {})
      })
      await afterWrite()
    },
    [afterWrite]
  )

  const updateTopic = useCallback(
    async (id: string, patch: Partial<LearningTopic>) => {
      // 以主进程最新记录为准，避免连续操作时用过期的 progress
      const current = splitRecords(await freshRecords()).topics.find((topic) => topic.id === id)
      if (!current) {
        await reload()
        return
      }
      await getDataApi().update('learning', id, patch as Record<string, unknown>)
      await afterWrite()
    },
    [afterWrite, freshRecords, reload]
  )

  const removeTopic = useCallback(
    async (id: string) => {
      await getDataApi().remove('learning', id)
      await afterWrite()
    },
    [afterWrite]
  )

  /**
   * 删除主题并按规则解除关联（BUG-007 / 需求「六、删除与回收站规则」）。
   *
   * 顺序很重要：**先解除关联，再删本体**。
   * 反过来的话，中途失败会留下"主题已删、任务还指向它"的悬空引用。
   *
   * 返回面向用户的说明，由界面显示在确认弹窗与操作提示里。
   */
  const removeTopicWithUnlink = useCallback(
    async (id: string): Promise<string> => {
      const learningRecords = await freshRecords()
      const planRecords = (await getDataApi().list('plan')) as Array<Record<string, unknown>>
      const { patches, summary } = unlinkLearningTopic(id, learningRecords, planRecords)

      for (const patch of patches) {
        await getDataApi().update(patch.module, patch.id, patch.patch)
      }
      // 最后才删本体，让它进回收站（软删除）
      await getDataApi().remove('learning', id)
      await afterWrite()
      if (patches.some((patch) => patch.module === 'plan')) notifyDataChanged('plan')
      return summary
    },
    [afterWrite, freshRecords]
  )

  /**
   * 新增树节点。`parentId === null` 就是新增一份资料（树的根）。
   * order 取同级末尾——插在中间是"拖拽排序"的职责，不是新增的。
   */
  const addNode = useCallback(
    async (input: NodeInput): Promise<string> => {
      const fresh = splitRecords(await freshRecords())
      const lite = fresh.nodes.map((node) => ({
        id: node.id,
        ownerId: node.ownerId,
        parentId: node.parentId,
        order: node.order
      }))
      const order = nextOrderUnder(lite, input.ownerId, input.parentId)
      const created = (await getDataApi().add(
        'learning',
        buildCreatePatch({
          ownerId: input.ownerId,
          parentId: input.parentId,
          order,
          title: input.title,
          extra: {
            topicId: input.ownerId,
            ...(input.percent !== undefined && input.percent > 0 ? { percent: input.percent } : {}),
            ...(input.resourceType !== undefined && input.resourceType !== ''
              ? { resourceType: input.resourceType }
              : {}),
            ...(input.group !== undefined && input.group !== '' ? { group: input.group } : {}),
            ...(input.note !== undefined && input.note !== '' ? { note: input.note } : {})
          }
        })
      )) as { id: string }
      await afterWrite()
      return created.id
    },
    [afterWrite, freshRecords]
  )

  const updateNode = useCallback(
    async (id: string, patch: Record<string, unknown>) => {
      await getDataApi().update('learning', id, patch)
      await afterWrite()
    },
    [afterWrite]
  )

  const toggleNodeDone = useCallback(
    async (id: string, done: boolean) => {
      await getDataApi().update('learning', id, { done })
      await afterWrite()
    },
    [afterWrite]
  )

  /**
   * 移动节点：合法性（跨 owner / 成环）由 `tree.ts` 判，
   * 这里只把它的补丁写回存储。失败时**一个字段都不写**。
   */
  const moveTreeNode = useCallback(
    async (dragId: string, parentId: string | null, index: number): Promise<string | null> => {
      const fresh = splitRecords(await freshRecords())
      const outcome = buildMovePatches(fresh.nodes, dragId, parentId, index)
      if (!outcome.ok) {
        await reload()
        return outcome.reason
      }
      for (const patch of outcome.patches) {
        await getDataApi().update('learning', patch.id, patch.patch)
      }
      await afterWrite()
      return null
    },
    [afterWrite, freshRecords, reload]
  )

  /**
   * 删除一个节点：**连同整棵子树**（`tree.ts` 的 `removeSubtree` 口径），
   * 并且走 `unlink.ts` 的 `unlinkTreeNode` —— 先解除关联再软删除，
   * 这样节点进回收站、能整体恢复，也不留悬空引用。
   */
  const removeNodeWithUnlink = useCallback(
    async (id: string): Promise<string> => {
      const fresh = splitRecords(await freshRecords())
      const ids = subtreeIds(fresh.nodes, id)
      const { patches, summary } = unlinkTreeNode(id, ids.slice(1), 'learning')
      for (const patch of patches) {
        await getDataApi().update(patch.module, patch.id, patch.patch)
      }
      await afterWrite()
      return summary
    },
    [afterWrite, freshRecords]
  )

  const addLog = useCallback(
    async (input: {
      topicId: string
      date: string
      minutes: number
      content: string
      contentFormat?: 'plain' | 'rich'
      nodeId?: string
    }) => {
      await getDataApi().add('learning', {
        kind: 'log',
        topicId: input.topicId,
        date: input.date,
        minutes: input.minutes,
        content: input.content,
        // 只在富文本时写这个字段：不写即 plain，与旧记录口径一致（零改写）
        ...(input.contentFormat === 'rich' ? { contentFormat: 'rich' } : {}),
        ...(input.nodeId !== undefined && input.nodeId !== ''
          ? { nodeId: input.nodeId, ownerId: input.topicId }
          : {})
      })
      await afterWrite()
    },
    [afterWrite]
  )

  const removeLog = useCallback(
    async (id: string) => {
      await getDataApi().remove('learning', id)
      await afterWrite()
    },
    [afterWrite]
  )

  return {
    ...data,
    loading,
    error,
    reload,
    addTopic,
    updateTopic,
    removeTopic,
    removeTopicWithUnlink,
    addNode,
    updateNode,
    toggleNodeDone,
    moveTreeNode,
    removeNodeWithUnlink,
    addLog,
    removeLog
  }
}

/** 供测试：把记录数组拆成几类 */
export function classify(records: LearningRecord[]): {
  topics: LearningTopic[]
  logs: LearningLog[]
  nodes: LearningNode[]
} {
  return {
    topics: records.filter((record): record is LearningTopic => record.kind === 'topic'),
    logs: records.filter((record): record is LearningLog => record.kind === 'log'),
    nodes: records.filter((record): record is LearningNode => record.kind === 'node')
  }
}
