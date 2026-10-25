/**
 * 第 01 块测试：数据模型 v1 → v2 的迁移
 *
 * 覆盖 `docs\TASKS\01` §6.2 要求的六项，一条都不省：
 *   ① 迁移幂等 —— 跑两次结果完全一致
 *   ② 不丢字段 —— v1 样本里的未知字段迁移后原样还在
 *   ③ 不丢内容 —— id / createdAt / title / note / 类型都在
 *   ④ 双轨清除 —— 迁移后不再有 kind:'resource' 记录
 *   ⑤ 数量对得上 —— 节点数量与原 resource 数量一致
 *   ⑥ 新字段默认值 —— 新增的可选字段在旧数据上取到安全默认值
 *
 * 另加：富文本"零改写"策略（旧记录一个字节都没动）与树边界
 * （跨 owner 移动拒绝 / 移到自己的后代下拒绝）。
 */
import { describe, expect, it } from 'vitest'
import {
  migrateLearningToV2,
  moduleFormatVersion,
  normalizeModuleFile,
  type BaseRecord,
  type ModuleFile
} from '../../src/main/data/format'
import {
  normalizeLearningRecord,
  resourceToNode,
  type LearningNode
} from '../../src/shared/learning'
import { buildTree, moveNode } from '../../src/shared/tree'

// ---------------------------------------------------------------------------
// v1 样本：形状严格照抄 v1 的 LearningResource
//   { kind:'resource', topicId, name, type, progress, percent }
// 并**故意混入一个 v2 还不知道的字段** `legacyFlag`，用来验"不丢字段"。
// ---------------------------------------------------------------------------

function v1Resource(id: string, overrides: Record<string, unknown> = {}): BaseRecord {
  return {
    id,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-02-01T00:00:00.000Z',
    kind: 'resource',
    topicId: 't1',
    name: `资料 ${id}`,
    type: '书',
    progress: '第 3/10 章',
    percent: 45,
    legacyFlag: '这一项 v2 不认识，必须原样保留',
    ...overrides
  } as BaseRecord
}

function v1LearningFile(): ModuleFile {
  return {
    formatVersion: 1,
    module: 'learning',
    updatedAt: '2026-02-01T00:00:00.000Z',
    records: [
      { ...v1Resource('t1'), kind: 'topic', title: '英语长难句', status: 'active', progress: 0 } as unknown as BaseRecord,
      v1Resource('r1', { name: '《语法俱乐部》', type: '书', progress: '第 3/10 章', percent: 50 }),
      v1Resource('r2', { name: '某公开课', type: '视频', progress: '看完 4 讲', percent: 30 }),
      v1Resource('r3', { name: '官方文档', type: '文档', progress: '', percent: undefined }),
      {
        id: 'l1',
        createdAt: '2026-01-05T00:00:00.000Z',
        updatedAt: '2026-01-05T00:00:00.000Z',
        kind: 'log',
        topicId: 't1',
        date: '2026-01-05',
        minutes: 45,
        content: '读完第 3 章'
      } as unknown as BaseRecord
    ]
  }
}

/** 取某条记录（断言里省掉一堆类型体操） */
function at(file: ModuleFile, index: number): Record<string, unknown> {
  return file.records[index] as unknown as Record<string, unknown>
}

function nodes(file: ModuleFile): Array<Record<string, unknown>> {
  return file.records
    .map((record) => record as unknown as Record<string, unknown>)
    .filter((record) => record['kind'] === 'node')
}

// ---------------------------------------------------------------------------

describe('learning v1 → v2：resource 转成树的根级节点', () => {
  it('① 幂等：迁移跑两次，结果完全一致', () => {
    const once = migrateLearningToV2(v1LearningFile())
    const twice = migrateLearningToV2(once)

    // updatedAt 每次都会刷新（它记录的是"这份文件什么时候被写过"），
    // 除它之外的**全部记录**必须逐字节一致。
    expect(twice.records).toEqual(once.records)
    expect(twice.formatVersion).toBe(once.formatVersion)
  })

  it('① 幂等：走完整的 normalizeModuleFile 链，两次也一致', () => {
    const first = normalizeModuleFile(v1LearningFile(), 'learning')
    const second = normalizeModuleFile(first.file, 'learning')

    expect(first.applied).toEqual(['v1 → v2'])
    // 第二次已经是 v2 了，不该再跑迁移
    expect(second.applied).toEqual([])
    expect(second.file.records).toEqual(first.file.records)
  })

  it('② 不丢字段：v1 里的未知字段迁移后原样还在', () => {
    const migrated = migrateLearningToV2(v1LearningFile())
    const r1 = nodes(migrated).find((node) => node['id'] === 'r1')
    expect(r1?.['legacyFlag']).toBe('这一项 v2 不认识，必须原样保留')
  })

  it('② 不丢字段：topic 与 log 一个字段都没被动过', () => {
    const before = v1LearningFile()
    const migrated = migrateLearningToV2(before)
    const topicBefore = at(before, 0)
    const topicAfter = at(migrated, 0)
    expect(topicAfter).toEqual(topicBefore)

    const logAfter = at(migrated, 4)
    expect(logAfter['kind']).toBe('log')
    expect(logAfter['content']).toBe('读完第 3 章')
    expect(logAfter['minutes']).toBe(45)
  })

  it('③ 不丢内容：id / createdAt / title / note / 类型都在', () => {
    const migrated = migrateLearningToV2(v1LearningFile())
    const r1 = nodes(migrated).find((node) => node['id'] === 'r1')

    expect(r1?.['id']).toBe('r1')
    expect(r1?.['createdAt']).toBe('2026-01-01T00:00:00.000Z')
    expect(r1?.['updatedAt']).toBe('2026-02-01T00:00:00.000Z')
    // name → title
    expect(r1?.['title']).toBe('《语法俱乐部》')
    // progress → note
    expect(r1?.['note']).toBe('第 3/10 章')
    // type → resourceType（它就是"分组名"）
    expect(r1?.['resourceType']).toBe('书')
    // percent → percent（占比保留）
    expect(r1?.['percent']).toBe(50)
    // parentId → null（资料就是根）
    expect(r1?.['parentId']).toBeNull()
    // ownerId / topicId = 主题 id（树的边界）
    expect(r1?.['ownerId']).toBe('t1')
    expect(r1?.['topicId']).toBe('t1')
    // 新节点默认未完成
    expect(r1?.['done']).toBe(false)
  })

  it('③ 不丢内容：空 progress 不写出空的 note（不给旧数据添字段）', () => {
    const migrated = migrateLearningToV2(v1LearningFile())
    const r3 = nodes(migrated).find((node) => node['id'] === 'r3')
    expect(r3?.['title']).toBe('官方文档')
    expect('note' in (r3 ?? {})).toBe(false)
    // percent 原本就没有 → 也不凭空造一个
    expect('percent' in (r3 ?? {})).toBe(false)
  })

  it('③ 不丢内容：旧的 name / progress / type 不再出现在记录上（不是双份）', () => {
    const migrated = migrateLearningToV2(v1LearningFile())
    const r1 = nodes(migrated).find((node) => node['id'] === 'r1')
    expect('name' in (r1 ?? {})).toBe(false)
    expect('progress' in (r1 ?? {})).toBe(false)
    expect('type' in (r1 ?? {})).toBe(false)
  })

  it('④ 双轨清除：迁移后不再有 kind:resource 记录', () => {
    const migrated = migrateLearningToV2(v1LearningFile())
    const kinds = migrated.records.map((record) => (record as unknown as Record<string, unknown>)['kind'])
    expect(kinds).not.toContain('resource')
    expect(kinds.filter((kind) => kind === 'node')).toHaveLength(3)
  })

  it('⑤ 数量对得上：节点数量与原 resource 数量一致', () => {
    const before = v1LearningFile()
    const resourceCount = before.records.filter(
      (record) => (record as unknown as Record<string, unknown>)['kind'] === 'resource'
    ).length

    const migrated = migrateLearningToV2(before)
    expect(nodes(migrated)).toHaveLength(resourceCount)
    // 总记录数不变（是改写，不是增删）
    expect(migrated.records).toHaveLength(before.records.length)
  })

  it('⑤ order 按原顺序、每个主题各自从 0 递增', () => {
    const migrated = migrateLearningToV2(v1LearningFile())
    const own = nodes(migrated).filter((node) => node['topicId'] === 't1')
    expect(own.map((node) => node['order'])).toEqual([0, 1, 2])
  })

  it('⑤ order 按主题分开计数（两个主题互不干扰）', () => {
    const file: ModuleFile = {
      formatVersion: 1,
      module: 'learning',
      updatedAt: '2026-02-01T00:00:00.000Z',
      records: [
        v1Resource('a1', { topicId: 't1' }),
        v1Resource('a2', { topicId: 't1' }),
        v1Resource('b1', { topicId: 't2' })
      ]
    }
    const migrated = migrateLearningToV2(file)
    const byId = new Map(nodes(migrated).map((node) => [node['id'], node['order']]))
    expect(byId.get('a1')).toBe(0)
    expect(byId.get('a2')).toBe(1)
    expect(byId.get('b1')).toBe(0)
  })

  it('⑥ 迁移后的节点能被 normalizeLearningRecord 正确读回', () => {
    const migrated = migrateLearningToV2(v1LearningFile())
    const r1 = nodes(migrated).find((node) => node['id'] === 'r1')
    const parsed = normalizeLearningRecord(r1 as Record<string, unknown>)
    expect(parsed?.kind).toBe('node')
    const node = parsed as LearningNode
    expect(node.title).toBe('《语法俱乐部》')
    expect(node.percent).toBe(50)
    expect(node.resourceType).toBe('书')
    expect(node.parentId).toBeNull()
    expect(node.ownerId).toBe('t1')
  })

  it('空文件迁移后什么都不发生', () => {
    const empty: ModuleFile = {
      formatVersion: 1,
      module: 'learning',
      updatedAt: '2026-02-01T00:00:00.000Z',
      records: []
    }
    expect(migrateLearningToV2(empty).records).toEqual([])
  })

  it('已经是 v2 的记录（kind:node）不再被转换', () => {
    const already: ModuleFile = {
      formatVersion: 2,
      module: 'learning',
      updatedAt: '2026-02-01T00:00:00.000Z',
      records: [
        {
          id: 'n1',
          createdAt: '2026-01-01T00:00:00.000Z',
          updatedAt: '2026-01-01T00:00:00.000Z',
          kind: 'node',
          ownerId: 't1',
          topicId: 't1',
          parentId: null,
          order: 0,
          title: '已经是节点',
          done: true
        } as unknown as BaseRecord
      ]
    }
    const migrated = migrateLearningToV2(already)
    expect(at(migrated, 0)['kind']).toBe('node')
    expect(at(migrated, 0)['done']).toBe(true)
    expect(at(migrated, 0)['title']).toBe('已经是节点')
  })
})

describe('resourceToNode 的纯函数行为', () => {
  it('缺 topicId 时 ownerId 落成空串而不是 undefined', () => {
    const node = resourceToNode({ id: 'x', name: '无主题' }, 0)
    expect(node['ownerId']).toBe('')
    expect(node['topicId']).toBe('')
  })

  it('percent 为 0 或负数时不写出该字段', () => {
    expect('percent' in resourceToNode({ id: 'x', percent: 0 }, 0)).toBe(false)
    expect('percent' in resourceToNode({ id: 'x', percent: -5 }, 0)).toBe(false)
  })

  it('type 为空时不写出 resourceType', () => {
    expect('resourceType' in resourceToNode({ id: 'x', type: '   ' }, 0)).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// 富文本零改写（`docs\TASKS\01` §5.4 / `MASTER.md` §9.4）
// ---------------------------------------------------------------------------

describe('富文本零改写：旧记录一个字节都没动', () => {
  it('迁移不给任何旧记录补 contentFormat', () => {
    const migrated = migrateLearningToV2(v1LearningFile())
    for (const record of migrated.records) {
      expect('contentFormat' in (record as unknown as Record<string, unknown>)).toBe(false)
    }
  })

  it('memo / plan / review / reading 的旧文件迁移后记录完全不变', () => {
    const samples: Partial<Record<'memo' | 'plan' | 'review' | 'reading', BaseRecord>> = {
      memo: {
        id: 'm1',
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
        text: '旧备忘，纯文本\n第二行',
        pinned: true
      } as unknown as BaseRecord,
      plan: {
        id: 'p1',
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
        title: '旧任务',
        date: '2026-02-01',
        timeSlot: 'morning',
        recurrence: 'none',
        done: false,
        carriedOver: 0,
        doneAt: null,
        note: '旧备注'
      } as unknown as BaseRecord,
      review: {
        id: 'c1',
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
        front: '正面',
        back: '背面',
        source: '英语长难句',
        stage: 2,
        dueDate: '2026-02-14',
        reviewCount: 3,
        lastReviewedAt: '2026-02-07T00:00:00.000Z'
      } as unknown as BaseRecord,
      reading: {
        id: 'b1',
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
        kind: 'book',
        title: '深入理解计算机系统',
        author: 'Randal',
        format: 'paper',
        status: 'reading',
        totalPages: 320,
        currentPage: 128,
        percent: 0,
        finishedAt: null,
        rating: 0,
        review: '旧总评，纯文本'
      } as unknown as BaseRecord
    }

    for (const [module, record] of Object.entries(samples)) {
      const input = {
        formatVersion: 1,
        module,
        updatedAt: '2026-02-01T00:00:00.000Z',
        records: [record]
      }
      const result = normalizeModuleFile(input, module as 'memo' | 'plan' | 'review' | 'reading')
      // 走的是"无结构变化"这条路：没有迁移函数被调用
      expect(result.applied).toEqual([`v1 → v2（无结构变化）`])
      expect(result.file.records[0]).toEqual(record)
      expect(result.file.formatVersion).toBe(moduleFormatVersion(module as 'memo'))
    }
  })
})

// ---------------------------------------------------------------------------
// 树的边界（`docs\TASKS\01` §6.3）：确认 tree.ts 的防成环逻辑能被新模型直接用
// ---------------------------------------------------------------------------

describe('树的边界：新模型能直接用 tree.ts 的防成环逻辑', () => {
  /** 造一条 LearningNode（形状与 tree.ts 的 TreeNode 对齐） */
  function node(
    id: string,
    ownerId: string,
    parentId: string | null,
    order: number
  ): LearningNode {
    return {
      id,
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
      kind: 'node',
      ownerId,
      topicId: ownerId,
      parentId,
      order,
      title: id,
      done: false
    }
  }

  it('跨 owner 移动必须拒绝', () => {
    const nodes = [node('a', 't1', null, 0), node('b', 't2', null, 0)]
    const result = moveNode(nodes, 'a', 'b', 0)
    expect(result.ok).toBe(false)
    expect(result.reason).toContain('另一个')
    expect(result.patches).toEqual([])
  })

  it('移到自己的后代下必须拒绝（防成环）', () => {
    const nodes = [node('a', 't1', null, 0), node('b', 't1', 'a', 0), node('c', 't1', 'b', 0)]
    expect(moveNode(nodes, 'a', 'b', 0).ok).toBe(false)
    expect(moveNode(nodes, 'a', 'c', 0).ok).toBe(false)
    expect(moveNode(nodes, 'a', 'c', 0).reason).toContain('子节点')
  })

  it('移到自己下面必须拒绝', () => {
    const nodes = [node('a', 't1', null, 0)]
    expect(moveNode(nodes, 'a', 'a', 0).ok).toBe(false)
  })

  it('同一 owner 内的正常移动给出补丁，顺序重排', () => {
    const nodes = [node('a', 't1', null, 0), node('b', 't1', null, 1), node('c', 't1', null, 2)]
    const result = moveNode(nodes, 'c', null, 0)
    expect(result.ok).toBe(true)
    expect(result.patches).toEqual([
      { id: 'c', parentId: null, order: 0 },
      { id: 'a', parentId: null, order: 1 },
      { id: 'b', parentId: null, order: 2 }
    ])
  })

  it('迁移出来的根节点能被 buildTree 挂成森林', () => {
    const migrated = migrateLearningToV2(v1LearningFile())
    const parsed = migrated.records
      .map((record) => normalizeLearningRecord(record as unknown as Record<string, unknown>))
      .filter((record): record is LearningNode => record !== null && record.kind === 'node')

    const forest = buildTree(parsed, 't1')
    expect(forest).toHaveLength(3)
    // 全是根节点，谁也不是谁的孩子
    for (const root of forest) expect(root.children).toEqual([])
    // 排序按 order
    expect(forest.map((root) => root.title)).toEqual(['《语法俱乐部》', '某公开课', '官方文档'])
  })
})
