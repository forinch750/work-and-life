/**
 * 阶段 1 测试：内存数据仓 + 启动自检 + 持久化
 *
 * 直接对应验收标准：
 *   A1  写进去 → 关掉 → 重开，数据还在
 *   A5  数据文件存在且结构正确
 *   §7.3 主文件损坏时从备份副本恢复
 */
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DataStore, generateId } from '../../src/main/data/store'
import { moduleFileName } from '../../src/shared/modules'

const tempDirs: string[] = []

function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'worklife-store-'))
  tempDirs.push(dir)
  return dir
}

function makeStore(dataDir: string, hooks: Partial<ConstructorParameters<typeof DataStore>[0]> = {}) {
  return new DataStore({ dataDir, writeDelayMs: 60_000, maxDelayMs: 120_000, ...hooks })
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()
    if (dir) rmSync(dir, { recursive: true, force: true })
  }
})

describe('generateId', () => {
  it('生成的 id 唯一且非空', () => {
    const ids = new Set(Array.from({ length: 500 }, () => generateId()))
    expect(ids.size).toBe(500)
    for (const id of ids) expect(id.length).toBeGreaterThan(0)
  })
})

describe('DataStore 基本读写', () => {
  it('首次使用是 fresh 状态', () => {
    const store = makeStore(makeTempDir())
    const info = store.load('plan')
    expect(info.status).toBe('fresh')
    expect(store.module('plan').list()).toEqual([])
  })

  it('add 自动补齐 id 与时间戳', () => {
    const store = makeStore(makeTempDir())
    const plan = store.module('plan')
    const created = plan.add({ title: '交周报' })

    expect(created.id).toBeTruthy()
    expect(Number.isNaN(Date.parse(created.createdAt))).toBe(false)
    expect(Number.isNaN(Date.parse(created.updatedAt))).toBe(false)
    expect(created.title).toBe('交周报')
    expect(plan.list()).toHaveLength(1)
  })

  it('读接口返回深拷贝，外部改动不影响内部状态', () => {
    const store = makeStore(makeTempDir())
    const memo = store.module('memo')
    memo.add({ text: '原始内容' })

    const list = memo.list()
    list[0]!.text = '被外部改掉了'
    expect(memo.list()[0]!.text).toBe('原始内容')
  })

  it('update 更新字段并刷新 updatedAt，保留 createdAt', async () => {
    const store = makeStore(makeTempDir())
    const memo = store.module('memo')
    const created = memo.add({ text: 'v1' })
    await new Promise((resolve) => setTimeout(resolve, 5))

    const updated = memo.update(created.id, { text: 'v2' })
    expect(updated?.text).toBe('v2')
    expect(updated?.createdAt).toBe(created.createdAt)
    expect(Date.parse(updated!.updatedAt)).toBeGreaterThanOrEqual(Date.parse(created.updatedAt))
  })

  it('update 不存在的 id 返回 undefined', () => {
    const store = makeStore(makeTempDir())
    expect(store.module('memo').update('不存在', {})).toBeUndefined()
  })

  it('remove 默认软删除：list 看不到、all 还在', () => {
    const store = makeStore(makeTempDir())
    const memo = store.module('memo')
    const created = memo.add({ text: '待删' })

    expect(memo.remove(created.id)).toBe(true)
    expect(memo.list()).toHaveLength(0)
    expect(memo.all()).toHaveLength(1)
    expect(memo.all()[0]!.deletedAt).toBeTruthy()
  })

  it('remove 支持物理删除', () => {
    const store = makeStore(makeTempDir())
    const memo = store.module('memo')
    const created = memo.add({ text: '待删' })
    memo.remove(created.id, { hard: true })
    expect(memo.all()).toHaveLength(0)
  })

  it('byId 能查到记录，也能查到已软删除的', () => {
    const store = makeStore(makeTempDir())
    const memo = store.module('memo')
    const created = memo.add({ text: 'x' })
    memo.remove(created.id)
    expect(memo.byId(created.id)?.id).toBe(created.id)
  })
})

describe('落盘与持久化（对应 A1）', () => {
  it('flush 之后数据文件存在且结构正确（对应 A5）', () => {
    const dir = makeTempDir()
    const store = makeStore(dir)
    store.module('plan').add({ title: '交周报' })
    store.flushAll()

    const file = join(dir, moduleFileName('plan'))
    expect(existsSync(file)).toBe(true)

    const parsed = JSON.parse(readFileSync(file, 'utf8'))
    expect(parsed.module).toBe('plan')
    expect(parsed.formatVersion).toBeGreaterThanOrEqual(1)
    expect(parsed.records).toHaveLength(1)
    expect(parsed.records[0].title).toBe('交周报')
  })

  it('模拟重启：新的 store 能读回上次写的内容（A1 核心）', () => {
    const dir = makeTempDir()

    const first = makeStore(dir)
    const plan1 = first.module('plan')
    const memo1 = first.module('memo')
    plan1.add({ title: '交周报' })
    plan1.add({ title: '改接口文档' })
    memo1.add({ text: '物业电话 400-xxx' })
    first.flushAll()

    // 丢掉第一个实例，重新加载（等价于关掉程序再打开）
    const second = makeStore(dir)
    expect(second.load('plan').status).toBe('ok')
    const plan2 = second.module('plan')
    const memo2 = second.module('memo')

    expect(plan2.list().map((r) => r.title)).toEqual(['交周报', '改接口文档'])
    expect(memo2.list().map((r) => r.text)).toEqual(['物业电话 400-xxx'])
  })

  it('未 flush 时有待写标记，flush 后清除', () => {
    const store = makeStore(makeTempDir())
    const memo = store.module('memo')
    memo.add({ text: 'x' })
    expect(store.hasPendingWrites()).toBe(true)
    expect(memo.hasPendingWrites()).toBe(true)

    store.flushAll()
    expect(store.hasPendingWrites()).toBe(false)
    expect(memo.hasPendingWrites()).toBe(false)
  })

  it('写入做防抖：连续 50 次改动只落盘一次', () => {
    const dir = makeTempDir()
    const writes: string[] = []
    const store = new DataStore({
      dataDir: dir,
      writeDelayMs: 60_000,
      maxDelayMs: 120_000,
      writeImpl: (filePath, content) => {
        writes.push(filePath)
        writeFileSync(filePath, content, 'utf8')
        return content.length
      }
    })

    const memo = store.module('memo')
    for (let i = 0; i < 50; i += 1) memo.add({ text: `第 ${i} 条` })
    expect(writes).toHaveLength(0)

    store.flushAll()
    expect(writes).toHaveLength(1)
    expect(memo.list()).toHaveLength(50)
  })

  it('落盘失败会通过 onWriteError 上报，不影响内存数据', () => {
    const onWriteError = vi.fn()
    const store = new DataStore({
      dataDir: makeTempDir(),
      writeDelayMs: 0,
      maxDelayMs: 0,
      writeImpl: () => {
        throw new Error('磁盘满了')
      },
      onWriteError
    })

    const memo = store.module('memo')
    memo.add({ text: '第一条' })
    store.flushAll()

    expect(onWriteError).toHaveBeenCalledTimes(1)
    expect(onWriteError.mock.calls[0]?.[0]).toBe('memo')
    expect(memo.list()).toHaveLength(1)
  })
})

describe('启动自检与恢复（PRD §7.3）', () => {
  it('主文件缺失但备份存在时，从备份副本恢复并回调通知', () => {
    const dir = makeTempDir()
    const file = join(dir, moduleFileName('plan'))

    const first = makeStore(dir)
    first.module('plan').add({ title: '第一版' })
    first.flushAll()
    first.module('plan').add({ title: '第二版' })
    first.flushAll()

    // 模拟主文件丢失，只剩 .bak（.bak 里是第一版）
    rmSync(file)

    const onRecovered = vi.fn()
    const second = makeStore(dir, { onRecovered })
    const info = second.load('plan')

    expect(info.status).toBe('recovered-from-backup')
    expect(onRecovered).toHaveBeenCalledTimes(1)
    expect(
      second.module('plan').list().map((r) => r.title)
    ).toEqual(['第一版'])
  })

  it('主文件与备份都损坏时报 corrupted，并给出可读提示', () => {
    const dir = makeTempDir()
    const file = join(dir, moduleFileName('memo'))
    writeFileSync(file, '{ 坏掉的 JSON', 'utf8')
    writeFileSync(`${file}.bak`, '也不是 JSON', 'utf8')

    const store = makeStore(dir)
    const info = store.load('memo')

    expect(info.status).toBe('corrupted')
    expect(info.message).toContain('backups')
    expect(store.module('memo').list()).toEqual([])
  })

  it('主文件格式不对但备份完好时能恢复', () => {
    const dir = makeTempDir()
    const file = join(dir, moduleFileName('memo'))

    const first = makeStore(dir)
    first.module('memo').add({ text: '完好内容' })
    first.flushAll()
    first.module('memo').add({ text: '第二版' })
    first.flushAll()

    writeFileSync(file, '{"records": "不是数组"}', 'utf8')

    const second = makeStore(dir)
    expect(second.load('memo').status).toBe('recovered-from-backup')
    expect(second.module('memo').list()).toHaveLength(1)
  })

  it('reload 会丢弃内存改动并以磁盘为准（导入流程依赖）', () => {
    const dir = makeTempDir()
    const store = makeStore(dir)
    const memo = store.module('memo')
    memo.add({ text: '只存在于内存' })

    // 磁盘上还没有内容
    expect(existsSync(join(dir, moduleFileName('memo')))).toBe(false)

    const info = memo.reload()
    expect(info.status).toBe('fresh')
    expect(memo.list()).toEqual([])
    expect(store.hasPendingWrites()).toBe(false)
  })
})

/**
 * 落盘边界（PRD K3：数据只出现在应用根下）。
 *
 * 这一条以前只有"口头保证"——paths.ts 里的 isInsideRoot 定义了却从未被调用，
 * 单测直接测它，所以测试全绿而保护并不存在。现在它在写盘路径上真正生效。
 */
describe('落盘边界（allowedRoot）', () => {
  it('数据目录在允许范围内时正常写入', () => {
    const root = makeTempDir()
    const dataDir = join(root, 'data')
    const store = new DataStore({ dataDir, allowedRoot: root, writeDelayMs: 60_000 })

    store.module('plan').add({ title: '正常任务' })
    store.flushAll()

    expect(existsSync(join(dataDir, moduleFileName('plan')))).toBe(true)
  })

  it('数据目录落在允许范围之外时拒绝写入，并走 onWriteError', () => {
    const root = makeTempDir()
    const outside = makeTempDir()
    const errors: Array<{ module: string; error: unknown }> = []

    const store = new DataStore({
      dataDir: join(outside, 'data'),
      allowedRoot: root,
      writeDelayMs: 60_000,
      onWriteError: (module, error) => errors.push({ module, error })
    })

    store.module('memo').add({ text: '这条不该被写出去' })
    store.flushAll()

    // 没有写出任何文件
    expect(existsSync(join(outside, 'data', moduleFileName('memo')))).toBe(false)
    // 而且是响亮失败，不是静默丢数据
    expect(errors).toHaveLength(1)
    expect(errors[0]?.module).toBe('memo')
    expect(String(errors[0]?.error)).toContain('拒绝写入应用根之外')
  })

  it('未指定 allowedRoot 时不校验（测试写临时目录的场景）', () => {
    const dir = makeTempDir()
    const store = new DataStore({ dataDir: dir, writeDelayMs: 60_000 })
    store.module('memo').add({ text: '随便写' })
    store.flushAll()
    expect(existsSync(join(dir, moduleFileName('memo')))).toBe(true)
  })
})
