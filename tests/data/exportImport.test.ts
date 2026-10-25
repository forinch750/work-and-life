/**
 * 阶段 1 测试：导出与导入
 *
 * 直接对应验收标准：
 *   B1  导出后得到一个数据文件
 *   B2  清空后再导入 → 数据完全恢复
 *   B3  导入前先自动备份，绝不静默覆盖
 *   B4  导入的文件可再次导出，内容一致
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  CURRENT_BUNDLE_VERSION,
  exportAllData,
  importAllData,
  mergeRecords,
  pickNewer,
  validateBundle,
  type ExportBundle
} from '../../src/main/data/exportImport'
import type { BaseRecord } from '../../src/main/data/format'

const tempDirs: string[] = []

function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'worklife-export-'))
  tempDirs.push(dir)
  return dir
}

function makeLayout(): { root: string; dataDir: string; backupDir: string } {
  const root = makeTempDir()
  const dataDir = join(root, 'data')
  const backupDir = join(root, 'backups')
  mkdirSync(dataDir, { recursive: true })
  mkdirSync(backupDir, { recursive: true })
  return { root, dataDir, backupDir }
}

function writeModule(
  dataDir: string,
  module: string,
  records: Array<Record<string, unknown>>
): void {
  writeFileSync(
    join(dataDir, `${module}.json`),
    JSON.stringify({ formatVersion: 1, module, updatedAt: '2026-02-14T10:00:00.000Z', records }, null, 2),
    'utf8'
  )
}

function record(id: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...extra
  }
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()
    if (dir) rmSync(dir, { recursive: true, force: true })
  }
})

describe('exportAllData', () => {
  it('把各模块打包成一个可读的 JSON 文件（对应 B1）', () => {
    const { dataDir, root } = makeLayout()
    writeModule(dataDir, 'plan', [record('p1', { title: '交周报' })])
    writeModule(dataDir, 'memo', [record('m1', { text: '物业电话' })])

    const target = join(root, '导出.json')
    const result = exportAllData({ dataDir, targetFile: target, appVersion: '0.1.0' })

    expect(existsSync(target)).toBe(true)
    expect(result.moduleCount).toBe(2)
    expect(result.recordCount).toBe(2)
    expect(result.bytes).toBeGreaterThan(0)

    const bundle = JSON.parse(readFileSync(target, 'utf8')) as ExportBundle
    expect(bundle.kind).toBe('work-life-export')
    expect(bundle.bundleVersion).toBe(CURRENT_BUNDLE_VERSION)
    expect(bundle.appVersion).toBe('0.1.0')
    expect(bundle.modules.plan?.records).toHaveLength(1)
    expect(bundle.modules.memo?.records).toHaveLength(1)
  })

  it('没有数据的模块不会出现在包里', () => {
    const { dataDir, root } = makeLayout()
    writeModule(dataDir, 'plan', [record('p1')])

    const result = exportAllData({ dataDir, targetFile: join(root, 'out.json'), appVersion: '0.1.0' })
    const bundle = JSON.parse(readFileSync(result.file, 'utf8')) as ExportBundle
    expect(Object.keys(bundle.modules)).toEqual(['plan'])
  })

  it('单个模块文件损坏时不影响其它模块导出', () => {
    const { dataDir, root } = makeLayout()
    writeModule(dataDir, 'plan', [record('p1')])
    writeFileSync(join(dataDir, 'memo.json'), '{ 坏掉的', 'utf8')

    const result = exportAllData({ dataDir, targetFile: join(root, 'out.json'), appVersion: '0.1.0' })
    expect(result.moduleCount).toBe(1)
  })

  it('目录不存在时自动创建', () => {
    const { dataDir, root } = makeLayout()
    writeModule(dataDir, 'plan', [record('p1')])
    const target = join(root, 'a', 'b', 'out.json')
    expect(() => exportAllData({ dataDir, targetFile: target, appVersion: '0.1.0' })).not.toThrow()
    expect(existsSync(target)).toBe(true)
  })
})

describe('validateBundle', () => {
  it('接受本程序导出的文件', () => {
    const bundle = {
      kind: 'work-life-export',
      bundleVersion: 1,
      formatVersion: 1,
      exportedAt: '2026-02-14T10:00:00.000Z',
      appVersion: '0.1.0',
      modules: { plan: { formatVersion: 1, updatedAt: '2026-02-14T10:00:00.000Z', records: [] } }
    }
    expect(validateBundle(bundle).ok).toBe(true)
  })

  it('拒绝非本程序的文件', () => {
    expect(validateBundle({ foo: 'bar' })).toMatchObject({ ok: false })
    expect(validateBundle(null)).toMatchObject({ ok: false })
    expect(validateBundle([])).toMatchObject({ ok: false })
    expect(validateBundle('字符串')).toMatchObject({ ok: false })
  })

  it('拒绝更高版本的数据包，并说明原因', () => {
    const result = validateBundle({
      kind: 'work-life-export',
      bundleVersion: CURRENT_BUNDLE_VERSION + 1,
      modules: {}
    })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toContain('高于本程序支持')
  })

  it('拒绝 records 不是数组的模块', () => {
    const result = validateBundle({
      kind: 'work-life-export',
      bundleVersion: 1,
      modules: { plan: { records: '不是数组' } }
    })
    expect(result.ok).toBe(false)
  })
})

describe('importAllData', () => {
  it('覆盖模式：导入后数据与导出时完全一致（对应 B2）', () => {
    const { dataDir, backupDir, root } = makeLayout()
    writeModule(dataDir, 'plan', [record('p1', { title: '交周报' }), record('p2', { title: '改接口文档' })])
    const target = join(root, '导出.json')
    exportAllData({ dataDir, targetFile: target, appVersion: '0.1.0' })

    // 清空数据（模拟"清空后再导入"）
    writeModule(dataDir, 'plan', [])

    const result = importAllData({
      sourceFile: target,
      dataDir,
      backupDir,
      mode: 'replace',
      now: () => new Date(2026, 1, 15)
    })

    expect(result.recordCount).toBe(2)
    const restored = JSON.parse(readFileSync(join(dataDir, 'plan.json'), 'utf8'))
    expect(restored.records.map((r: Record<string, unknown>) => r.title)).toEqual(['交周报', '改接口文档'])
  })

  it('导入前一定先自动备份（对应 B3、B4）', () => {
    const { dataDir, backupDir, root } = makeLayout()
    writeModule(dataDir, 'plan', [record('p1', { title: '原始数据' })])
    const target = join(root, '导出.json')
    exportAllData({ dataDir, targetFile: target, appVersion: '0.1.0' })

    const onBackup = vi.fn()
    const result = importAllData({
      sourceFile: target,
      dataDir,
      backupDir,
      mode: 'replace',
      now: () => new Date(2026, 1, 15),
      onBackup
    })

    expect(onBackup).toHaveBeenCalledTimes(1)
    expect(result.backup.created).toBe(true)
    // 备份内容就是导入前的数据，可以再次导入
    const backupFile = join(backupDir, '2026-02-15', 'plan.json')
    expect(existsSync(backupFile)).toBe(true)
    expect(readFileSync(backupFile, 'utf8')).toContain('原始数据')
  })

  it('合并模式：id 相同的记录取 updatedAt 较新的一条', () => {
    const { dataDir, backupDir, root } = makeLayout()
    writeModule(dataDir, 'plan', [
      record('shared', { title: '旧标题', updatedAt: '2026-01-01T00:00:00.000Z' })
    ])
    const target = join(root, '导出.json')
    exportAllData({ dataDir, targetFile: target, appVersion: '0.1.0' })

    // 当前数据里把它改新了
    writeModule(dataDir, 'plan', [
      record('shared', { title: '新标题', updatedAt: '2026-03-01T00:00:00.000Z' })
    ])

    importAllData({
      sourceFile: target,
      dataDir,
      backupDir,
      mode: 'merge',
      now: () => new Date(2026, 1, 15)
    })

    const merged = JSON.parse(readFileSync(join(dataDir, 'plan.json'), 'utf8'))
    expect(merged.records).toHaveLength(1)
    expect(merged.records[0].title).toBe('新标题')
  })

  it('合并模式：两边各自独有的记录都会保留', () => {
    const { dataDir, backupDir, root } = makeLayout()
    writeModule(dataDir, 'plan', [record('only-in-export', { title: '导出里才有' })])
    const target = join(root, '导出.json')
    exportAllData({ dataDir, targetFile: target, appVersion: '0.1.0' })

    writeModule(dataDir, 'plan', [record('only-in-current', { title: '本机才有' })])

    const result = importAllData({
      sourceFile: target,
      dataDir,
      backupDir,
      mode: 'merge',
      now: () => new Date(2026, 1, 15)
    })

    expect(result.recordCount).toBe(2)
    const merged = JSON.parse(readFileSync(join(dataDir, 'plan.json'), 'utf8'))
    const titles = merged.records.map((r: Record<string, unknown>) => r.title).sort()
    expect(titles).toEqual(['导出里才有', '本机才有'])
  })

  it('导入非法文件时明确报错且不破坏现有数据', () => {
    const { dataDir, backupDir, root } = makeLayout()
    writeModule(dataDir, 'plan', [record('p1', { title: '必须保住' })])
    const bad = join(root, 'bad.json')
    writeFileSync(bad, '{"kind":"something-else"}', 'utf8')

    expect(() =>
      importAllData({ sourceFile: bad, dataDir, backupDir, mode: 'replace' })
    ).toThrow(/导入失败/)

    // 原数据没被动过
    expect(readFileSync(join(dataDir, 'plan.json'), 'utf8')).toContain('必须保住')
  })

  it('导入后再导出，内容一致（往返稳定，对应 B4）', () => {
    const { dataDir, backupDir, root } = makeLayout()
    writeModule(dataDir, 'plan', [record('p1', { title: '交周报' })])
    writeModule(dataDir, 'memo', [record('m1', { text: '物业电话' })])

    const first = join(root, '导出1.json')
    exportAllData({ dataDir, targetFile: first, appVersion: '0.1.0' })

    importAllData({ sourceFile: first, dataDir, backupDir, mode: 'replace', now: () => new Date(2026, 1, 15) })

    const second = join(root, '导出2.json')
    exportAllData({ dataDir, targetFile: second, appVersion: '0.1.0' })

    const a = JSON.parse(readFileSync(first, 'utf8')) as ExportBundle
    const b = JSON.parse(readFileSync(second, 'utf8')) as ExportBundle

    // 逐个模块比对记录内容本身。
    // 模块信封上的 updatedAt 会在导入时被刷新（表示"这份数据何时被写过"），
    // 因此它本来就会不同，不属于往返一致性要保证的部分。
    expect(Object.keys(b.modules).sort()).toEqual(Object.keys(a.modules).sort())
    for (const module of Object.keys(a.modules) as Array<keyof typeof a.modules>) {
      expect(b.modules[module]?.records).toEqual(a.modules[module]?.records)
      expect(b.modules[module]?.formatVersion).toBe(a.modules[module]?.formatVersion)
    }
  })

  it('onModuleWritten 会为每个被写入的模块回调一次', () => {
    const { dataDir, backupDir, root } = makeLayout()
    writeModule(dataDir, 'plan', [record('p1')])
    writeModule(dataDir, 'memo', [record('m1')])
    const target = join(root, '导出.json')
    exportAllData({ dataDir, targetFile: target, appVersion: '0.1.0' })

    const seen: string[] = []
    importAllData({
      sourceFile: target,
      dataDir,
      backupDir,
      mode: 'replace',
      now: () => new Date(2026, 1, 15),
      onModuleWritten: (module) => seen.push(module)
    })

    expect(seen.sort()).toEqual(['memo', 'plan'])
  })
})

describe('pickNewer / mergeRecords', () => {
  const older: BaseRecord = {
    id: 'a',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z'
  }
  const newer: BaseRecord = {
    id: 'a',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-02-01T00:00:00.000Z'
  }

  it('取 updatedAt 较新的一条', () => {
    expect(pickNewer(older, newer)).toBe(newer)
    expect(pickNewer(newer, older)).toBe(newer)
  })

  it('updatedAt 无法解析时不会误判为新', () => {
    const broken = { ...older, updatedAt: '不是时间' }
    expect(pickNewer(older, broken)).toBe(older)
  })

  it('mergeRecords 统计被保留（未被覆盖）的条数', () => {
    const current = [newer]
    const incoming = [older]
    const result = mergeRecords(current, incoming)
    expect(result.records).toHaveLength(1)
    expect(result.kept).toBe(1)
  })
})
