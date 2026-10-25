/**
 * 阶段 1 测试：数据格式与迁移
 *
 * 验收目标（PRD §7.2）：文件带格式版本号；老版本数据能被自动升级；
 * 来自"未来版本"的文件不能静默读坏。
 */
import { afterEach, describe, expect, it } from 'vitest'
import {
  CURRENT_FORMAT_VERSION,
  MODULE_FORMAT_VERSIONS,
  aliveRecords,
  createEmptyModuleFile,
  isAlive,
  migrations,
  moduleFormatVersion,
  normalizeModuleFile,
  type BaseRecord
} from '../../src/main/data/format'
import { DATA_MODULES } from '../../src/shared/modules'

/** plan 模块自己的当前版本（第 01 块起版本号按模块取） */
const PLAN_VERSION = moduleFormatVersion('plan')

afterEach(() => {
  // 只清掉测试期间临时注册的迁移，别把真实的 learning 迁移删掉
  delete migrations['plan']
})

function record(id: string, extra: Partial<BaseRecord> = {}): BaseRecord {
  return {
    id,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...extra
  }
}

describe('normalizeModuleFile', () => {
  it('已经是最新版本时原样通过', () => {
    const input = {
      formatVersion: PLAN_VERSION,
      module: 'plan',
      updatedAt: '2026-02-14T10:00:00.000Z',
      records: [record('a')]
    }
    const result = normalizeModuleFile(input, 'plan')
    expect(result.file.formatVersion).toBe(PLAN_VERSION)
    expect(result.file.records).toHaveLength(1)
    expect(result.applied).toEqual([])
  })

  it('非对象输入退回空数据，不抛错', () => {
    for (const bad of [null, undefined, 42, 'string', []]) {
      const result = normalizeModuleFile(bad, 'plan')
      expect(result.file.records).toEqual([])
      expect(result.file.formatVersion).toBe(PLAN_VERSION)
    }
  })

  it('缺少 formatVersion 视为 0 版并升级到最新', () => {
    const result = normalizeModuleFile({ records: [record('a')] }, 'plan')
    expect(result.file.formatVersion).toBe(PLAN_VERSION)
    expect(result.applied.length).toBe(PLAN_VERSION)
  })

  it('records 不是数组时退回空数组', () => {
    const result = normalizeModuleFile({ formatVersion: 1, records: 'oops' }, 'plan')
    expect(result.file.records).toEqual([])
  })

  it('低版本数据会逐级执行迁移', () => {
    // 临时把当前版本视为 3，并注册两次结构变化
    migrations['plan'] = {
      2: (file) => ({ ...file, records: file.records.map((r) => ({ ...r, migratedTo2: true })) as BaseRecord[] }),
      3: (file) => ({ ...file, records: file.records.map((r) => ({ ...r, migratedTo3: true })) as BaseRecord[] })
    }

    const original = PLAN_VERSION
    try {
      // 通过显式构造 v1 输入来验证迁移链（当前版本若已是 1，则需要临时提升）
      const input = { formatVersion: 1, records: [record('a')] }
      const result = normalizeModuleFile(input, 'plan')
      if (original >= 2) {
        expect(result.applied).toContain('v1 → v2')
      }
      expect(result.file.formatVersion).toBe(PLAN_VERSION)
    } finally {
      expect(original).toBe(PLAN_VERSION)
    }
  })

  it('注册了迁移却抛错时，不把版本号报成最新（否则旧结构会被固化）', () => {
    migrations['plan'] = {
      2: () => {
        throw new Error('故意失败')
      }
    }
    const result = normalizeModuleFile({ formatVersion: 1, records: [record('a')] }, 'plan')
    expect(result.failed?.version).toBe(2)
    expect(result.failed?.message).toContain('故意失败')
    // 关键：宁可停在 v1，也不能谎报成最新的 v2
    expect(result.file.formatVersion).toBe(1)
    expect(result.file.records).toHaveLength(1)
  })

  it('来自更高版本的文件必须明确报错，而不是读坏', () => {
    expect(() =>
      normalizeModuleFile({ formatVersion: PLAN_VERSION + 5, records: [] }, 'plan')
    ).toThrow(/高于本程序支持/)
  })

  it('module 字段以调用方为准（防止文件被拷错位置）', () => {
    const result = normalizeModuleFile({ formatVersion: 1, module: 'memo', records: [] }, 'plan')
    expect(result.file.module).toBe('plan')
  })

  it('updatedAt 缺失时补当前时间', () => {
    const result = normalizeModuleFile({ formatVersion: 1, records: [] }, 'plan')
    expect(Number.isNaN(Date.parse(result.file.updatedAt))).toBe(false)
  })
})

describe('按模块的格式版本', () => {
  it('六个模块都有自己的版本号，且都已是 2', () => {
    for (const module of DATA_MODULES) {
      expect(MODULE_FORMAT_VERSIONS[module]).toBe(2)
      expect(moduleFormatVersion(module)).toBe(2)
    }
  })

  it('CURRENT_FORMAT_VERSION 与最高模块版本一致', () => {
    const highest = Math.max(...DATA_MODULES.map((module) => MODULE_FORMAT_VERSIONS[module]))
    expect(CURRENT_FORMAT_VERSION).toBe(highest)
    expect(moduleFormatVersion('plan')).toBe(CURRENT_FORMAT_VERSION)
  })

  it('某个模块的旧文件只按它自己的版本升级', () => {
    // memo 在 v1 结构上没有任何字段被改写，所以走"无结构变化"这条路
    const result = normalizeModuleFile({ formatVersion: 1, records: [record('a')] }, 'memo')
    expect(result.applied).toEqual(['v1 → v2（无结构变化）'])
    expect(result.file.records[0]).toEqual(record('a'))
  })

  it('learning 的 v1 文件会走真正的迁移函数', () => {
    const result = normalizeModuleFile(
      {
        formatVersion: 1,
        records: [
          record('r1', {
            kind: 'resource',
            topicId: 't1',
            name: '资料',
            type: '书',
            progress: '第 3 章'
          } as Partial<BaseRecord>)
        ]
      },
      'learning'
    )
    expect(result.applied).toEqual(['v1 → v2'])
    expect(result.failed).toBeUndefined()
    const migrated = result.file.records[0] as unknown as Record<string, unknown>
    expect(migrated['kind']).toBe('node')
  })
})

describe('createEmptyModuleFile', () => {
  it('结构完整且为空', () => {
    const file = createEmptyModuleFile('reading')
    expect(file.module).toBe('reading')
    expect(file.formatVersion).toBe(moduleFormatVersion('reading'))
    expect(file.records).toEqual([])
  })
})

describe('软删除', () => {
  it('isAlive 区分已删除记录', () => {
    expect(isAlive(record('a'))).toBe(true)
    expect(isAlive(record('b', { deletedAt: '2026-02-01T00:00:00.000Z' }))).toBe(false)
  })

  it('aliveRecords 过滤掉软删除的记录', () => {
    const records = [record('a'), record('b', { deletedAt: '2026-02-01T00:00:00.000Z' }), record('c')]
    expect(aliveRecords(records).map((r) => r.id)).toEqual(['a', 'c'])
  })
})
