/**
 * 阶段 1 测试：数据层端到端验收
 *
 * 把 PRD §10.1 的条目做成可重复运行的自动化用例：
 *   A1  写入 → 关闭 → 重开，数据都在
 *   A5  数据目录与备份目录结构正确
 *   A6  连续多次增删改后数据仍然正确
 */
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createAppData } from '../../src/main/data'
import { createLogger } from '../../src/main/data/logger'
import { ensureDataDirs, resolveDataPaths } from '../../src/main/data/paths'

const tempRoots: string[] = []


function makeRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'worklife-e2e-'))
  tempRoots.push(root)
  return root
}

function openApp(root: string, options: { seedEmptyFiles?: boolean } = {}) {
  const paths = resolveDataPaths({ appRoot: root })
  ensureDataDirs(paths)
  const logger = createLogger({ console: false, filePath: paths.logFile })
  return createAppData({
    paths,
    appVersion: '0.1.0-test',
    logger,
    seedEmptyFiles: options.seedEmptyFiles
  })
}

afterEach(() => {
  while (tempRoots.length > 0) {
    const dir = tempRoots.pop()
    if (dir) rmSync(dir, { recursive: true, force: true })
  }
})

describe('端到端：A1 写入 → 关闭 → 重开', () => {
  it('备忘、任务、书三项都还在，内容未变', () => {
    const root = makeRoot()

    // ---- 第一次打开 ----
    const first = openApp(root)
    const plan = first.store.module('plan')
    const memo = first.store.module('memo')
    const reading = first.store.module('reading')

    plan.add({ title: '交周报', done: false })
    plan.add({ title: '改接口文档', done: true })
    memo.add({ text: '物业电话 400-xxx-xxxx' })
    memo.add({ text: '想买的那本书叫《设计中的设计》' })
    reading.add({ title: '深入理解计算机系统', totalPages: 320 })

    first.flushAll()

    // ---- 关闭 ----
    expect(first.store.hasPendingWrites()).toBe(false)

    // ---- 第二次打开 ----
    const second = openApp(root)
    const planAfter = second.store.module('plan')
    const memoAfter = second.store.module('memo')
    const readingAfter = second.store.module('reading')

    expect(second.startup.every((item) => item.status === 'ok' || item.status === 'fresh')).toBe(true)
    expect(planAfter.list().map((item) => item.title).sort()).toEqual(['交周报', '改接口文档'])
    expect(planAfter.list().find((item) => item.title === '改接口文档')?.done).toBe(true)
    expect(memoAfter.list().map((item) => item.text)).toContain('物业电话 400-xxx-xxxx')
    expect(readingAfter.list()).toHaveLength(1)
    expect(readingAfter.list()[0]!.totalPages).toBe(320)

    second.flushAll()
  })

  it('改过之后再重开，读到的是新值', () => {
    const root = makeRoot()

    const first = openApp(root)
    const memo = first.store.module('memo')
    const created = memo.add({ text: '原文', pinned: false })
    first.flushAll()

    memo.update(created.id, { text: '改过的内容', pinned: true })
    first.flushAll()

    const second = openApp(root)
    const restored = second.store.module('memo').list()[0]!
    expect(restored.text).toBe('改过的内容')
    expect(restored.pinned).toBe(true)
    second.flushAll()
  })

  it('软删除的记录重开后仍然不显示，但也没丢', () => {
    const root = makeRoot()

    const first = openApp(root)
    const memo = first.store.module('memo')
    const keep = memo.add({ text: '保留' })
    const drop = memo.add({ text: '删掉' })
    memo.remove(drop.id)
    first.flushAll()

    const second = openApp(root)
    const store = second.store.module('memo')
    expect(store.list().map((item) => item.text)).toEqual(['保留'])
    expect(store.all().map((item) => item.text).sort()).toEqual(['保留', '删掉'])
    expect(store.byId(keep.id)).toBeTruthy()
    second.flushAll()
  })
})

describe('端到端：A5 目录结构（PRD §7.1）', () => {
  it('首次打开不预建空文件，第一次保存后才出现对应文件', () => {
    const root = makeRoot()
    const app = openApp(root)

    // 还没写过任何东西 → 不该有数据文件（避免"备份六个空文件"）
    expect(existsSync(join(app.paths.data, 'memo.json'))).toBe(false)

    app.store.module('memo').add({ text: '第一条' })
    app.flushAll()

    expect(existsSync(join(app.paths.data, 'memo.json'))).toBe(true)
    const parsed = JSON.parse(readFileSync(join(app.paths.data, 'memo.json'), 'utf8'))
    expect(parsed.module).toBe('memo')
    expect(parsed.records).toHaveLength(1)
  })

  it('预建模式：每个模块都有文件，backups\\ 下有当天备份', () => {
    const root = makeRoot()
    const app = openApp(root, { seedEmptyFiles: true })

    for (const module of ['app', 'plan', 'learning', 'review', 'reading', 'memo']) {
      expect(existsSync(join(app.paths.data, `${module}.json`))).toBe(true)
    }

    expect(app.backup.created).toBe(true)
    expect(app.backup.files.length).toBeGreaterThan(0)
    expect(existsSync(app.backup.dir)).toBe(true)

    const stats = app.getStats()
    expect(stats.fileCount).toBe(6)
    expect(stats.recordCount).toBe(0)
    expect(stats.backups.length).toBe(1)
    app.flushAll()
  })

  it('所有产出文件都在应用根目录内（对应 K3）', () => {
    const root = makeRoot()
    const app = openApp(root, { seedEmptyFiles: true })
    app.store.module('memo').add({ text: 'x' })
    app.flushAll()

    const stats = app.getStats()
    const lowered = root.toLowerCase()
    for (const path of [stats.root, stats.dataDir, stats.backupDir, stats.logFile]) {
      expect(path.toLowerCase().startsWith(lowered)).toBe(true)
    }
  })

  it('同一天重复打开不会产生第二份备份', () => {
    const root = makeRoot()
    const first = openApp(root, { seedEmptyFiles: true })
    first.store.module('memo').add({ text: '第一条' })
    first.flushAll()
    expect(first.backup.created).toBe(true)

    const second = openApp(root, { seedEmptyFiles: true })
    expect(second.backup.created).toBe(false)
    expect(second.backup.message).toContain('已存在')
    expect(second.getStats().backups.length).toBe(1)
    second.flushAll()
  })
})

describe('端到端：A6 连续多次操作', () => {
  it('连续 120 次增删改之后，数据仍然自洽', () => {
    const root = makeRoot()
    const app = openApp(root)
    const memo = app.store.module('memo')

    const ids: string[] = []
    for (let i = 0; i < 120; i += 1) {
      const record = memo.add({ text: `第 ${i} 条`, seq: i })
      ids.push(record.id)
      if (i % 3 === 0) memo.update(record.id, { text: `第 ${i} 条（已改）` })
      if (i % 5 === 0) memo.remove(record.id)
    }
    app.flushAll()

    const expectedAlive = ids.length - Math.ceil(ids.length / 5)
    expect(memo.list()).toHaveLength(expectedAlive)
    expect(memo.all()).toHaveLength(ids.length)

    // 重开后数量一致
    const again = openApp(root)
    const restored = again.store.module('memo')
    expect(restored.list()).toHaveLength(expectedAlive)
    expect(restored.all()).toHaveLength(ids.length)
    again.flushAll()
  })

  it('数据文件内容始终是合法 JSON 且结构完整', () => {
    const root = makeRoot()
    const app = openApp(root)
    const plan = app.store.module('plan')
    for (let i = 0; i < 30; i += 1) plan.add({ title: `任务 ${i}`, done: i % 2 === 0 })
    app.flushAll()

    const parsed = JSON.parse(readFileSync(join(app.paths.data, 'plan.json'), 'utf8'))
    expect(parsed.module).toBe('plan')
    expect(typeof parsed.formatVersion).toBe('number')
    expect(Number.isNaN(Date.parse(parsed.updatedAt))).toBe(false)
    expect(Array.isArray(parsed.records)).toBe(true)
    expect(parsed.records).toHaveLength(30)
  })
})
