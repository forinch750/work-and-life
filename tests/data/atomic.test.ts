/**
 * 阶段 1 测试：原子写入与备份回退
 *
 * 验收目标（PRD §7.3）：
 *   - 写入过程中不会留下"写了一半"的坏文件
 *   - 主文件损坏时能回退到 .bak
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  backupPathFor,
  isSamePath,
  readFileWithFallback,
  removeFileWithBackup,
  writeFileAtomic
} from '../../src/main/data/atomic'

const tempDirs: string[] = []

function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'worklife-atomic-'))
  tempDirs.push(dir)
  return dir
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()
    if (dir) rmSync(dir, { recursive: true, force: true })
  }
})

describe('writeFileAtomic', () => {
  it('首次写入创建文件并返回字节数', () => {
    const dir = makeTempDir()
    const file = join(dir, 'plan.json')
    const bytes = writeFileAtomic(file, '{"a":1}')
    expect(bytes).toBe(Buffer.byteLength('{"a":1}', 'utf8'))
    expect(readFileSync(file, 'utf8')).toBe('{"a":1}')
  })

  it('目录不存在时自动创建', () => {
    const dir = makeTempDir()
    const file = join(dir, 'nested', 'deep', 'plan.json')
    expect(() => writeFileAtomic(file, 'x')).not.toThrow()
    expect(existsSync(file)).toBe(true)
  })

  it('覆盖写：内容整体替换，不残留旧内容', () => {
    const dir = makeTempDir()
    const file = join(dir, 'plan.json')
    writeFileAtomic(file, 'aaaaaaaaaaaaaaaaaaaa')
    writeFileAtomic(file, 'b')
    expect(readFileSync(file, 'utf8')).toBe('b')
  })

  it('第二次写入会把上一版留成 .bak', () => {
    const dir = makeTempDir()
    const file = join(dir, 'plan.json')
    writeFileAtomic(file, 'v1')
    expect(existsSync(backupPathFor(file))).toBe(false)

    writeFileAtomic(file, 'v2')
    expect(readFileSync(file, 'utf8')).toBe('v2')
    expect(readFileSync(backupPathFor(file), 'utf8')).toBe('v1')
  })

  it('写完不留临时文件', () => {
    const dir = makeTempDir()
    const file = join(dir, 'plan.json')
    writeFileAtomic(file, 'v1')
    writeFileAtomic(file, 'v2')
    writeFileAtomic(file, 'v3')

    const leftovers = readdirSync(dir).filter((name) => name.endsWith('.tmp'))
    expect(leftovers).toEqual([])
  })

  it('写入失败时抛出错误，并清掉临时文件', () => {
    const dir = makeTempDir()
    // 用一个目录占住目标文件名，rename 必然失败
    const file = join(dir, 'occupied.json')
    mkdirSync(file)

    expect(() =>
      writeFileAtomic(file, 'data', { retries: 1, retryDelayMs: 1, sleep: () => {} })
    ).toThrow()

    const leftovers = readdirSync(dir).filter((name) => name.endsWith('.tmp'))
    expect(leftovers).toEqual([])
  })

  it('中文与多行内容按 UTF-8 正确往返', () => {
    const dir = makeTempDir()
    const file = join(dir, 'plan.json')
    const content = '{\n  "标题": "交周报",\n  "备注": "第一行\\n第二行"\n}'
    writeFileAtomic(file, content)
    expect(readFileSync(file, 'utf8')).toBe(content)
  })

  it('可注入 sleep，重试不拖慢测试', () => {
    const dir = makeTempDir()
    const file = join(dir, 'plan.json')
    let sleeps = 0
    writeFileAtomic(file, 'ok', {
      sleep: () => {
        sleeps += 1
      }
    })
    expect(sleeps).toBe(0)
  })
})

describe('readFileWithFallback', () => {
  it('优先读主文件', () => {
    const dir = makeTempDir()
    const file = join(dir, 'plan.json')
    writeFileAtomic(file, 'v1')
    writeFileAtomic(file, 'v2')

    const result = readFileWithFallback(file)
    expect(result?.source).toBe('file')
    expect(result?.content).toBe('v2')
  })

  it('主文件缺失时回退到 .bak', () => {
    const dir = makeTempDir()
    const file = join(dir, 'plan.json')
    writeFileAtomic(file, 'v1')
    writeFileAtomic(file, 'v2')
    rmSync(file)

    const result = readFileWithFallback(file)
    expect(result?.source).toBe('backup')
    expect(result?.content).toBe('v1')
  })

  it('都不存在时返回 null', () => {
    const dir = makeTempDir()
    expect(readFileWithFallback(join(dir, 'nope.json'))).toBeNull()
  })

  it('读取失败不抛错（目录占位的情况）', () => {
    const dir = makeTempDir()
    const file = join(dir, 'is-a-dir.json')
    mkdirSync(file)
    const result = readFileWithFallback(file)
    expect(result === null || typeof result.content === 'string').toBe(true)
  })
})

describe('backupPathFor / isSamePath / removeFileWithBackup', () => {
  it('备份路径规则固定', () => {
    expect(backupPathFor('D:\\data\\plan.json')).toBe('D:\\data\\plan.json.bak')
  })

  it('路径比较忽略大小写与结尾分隔符', () => {
    expect(isSamePath('D:\\data\\plan.json', 'd:\\data\\plan.json')).toBe(true)
    expect(isSamePath('D:\\data', 'D:\\data\\')).toBe(true)
    expect(isSamePath('D:\\data\\a.json', 'D:\\data\\b.json')).toBe(false)
  })

  it('删除会同时清掉主文件与备份', () => {
    const dir = makeTempDir()
    const file = join(dir, 'plan.json')
    writeFileAtomic(file, 'v1')
    writeFileAtomic(file, 'v2')

    removeFileWithBackup(file)
    expect(existsSync(file)).toBe(false)
    expect(existsSync(backupPathFor(file))).toBe(false)
  })
})

describe('断电模拟：写到一半的畸形文件', () => {
  it('截断的主文件会被原样读出，交由恢复层判定（读函数只负责取内容）', () => {
    const dir = makeTempDir()
    const file = join(dir, 'plan.json')
    writeFileAtomic(file, '{"formatVersion":1,"records":[]}')
    writeFileAtomic(file, '{"formatVersion":1,"records":[{"id":"a"}]}')

    // 模拟断电：主文件被写坏
    writeFileSync(file, '{"formatVersion":1,"record')

    const result = readFileWithFallback(file)
    // readFileWithFallback 只做"取内容"，不做内容校验；
    // 校验与回退发生在 recovery 层（见 tests/data/store.test.ts 的损坏恢复用例）。
    expect(result?.source).toBe('file')
    expect(() => JSON.parse(result!.content)).toThrow()
  })

  it('主文件被删掉时能立刻拿到上一份完整内容', () => {
    const dir = makeTempDir()
    const file = join(dir, 'plan.json')
    writeFileAtomic(file, '{"formatVersion":1,"records":[]}')
    writeFileAtomic(file, '{"formatVersion":1,"records":[{"id":"a"}]}')
    rmSync(file)

    const result = readFileWithFallback(file)
    expect(result?.source).toBe('backup')
    expect(JSON.parse(result!.content)).toEqual({ formatVersion: 1, records: [] })
  })
})
