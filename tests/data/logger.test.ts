/**
 * 阶段 0 测试：应用日志
 *
 * 验收目标：日志能落盘、能表达错误原因，且绝不影响主流程。
 */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createLogger, describeError, formatLogLine } from '../../src/main/data/logger'

const tempDirs: string[] = []

function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'worklife-log-'))
  tempDirs.push(dir)
  return dir
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()
    if (dir) rmSync(dir, { recursive: true, force: true })
  }
})

describe('formatLogLine', () => {
  const at = new Date('2026-02-14T10:00:00.000Z')

  it('包含 ISO 时间、级别与事件名', () => {
    expect(formatLogLine('info', 'app-ready', undefined, at)).toBe(
      '2026-02-14T10:00:00.000Z [info] app-ready'
    )
  })

  it('把 Error 展开成可读文本', () => {
    const line = formatLogLine('error', 'write-failed', new Error('磁盘已满'), at)
    expect(line).toBe('2026-02-14T10:00:00.000Z [error] write-failed | Error: 磁盘已满')
  })

  it('带上系统错误码，便于定位', () => {
    const err = new Error('拒绝访问') as NodeJS.ErrnoException
    err.code = 'EPERM'
    expect(formatLogLine('warn', 'write-retry', err, at)).toContain('EPERM')
  })

  it('非 Error 对象不会导致抛错', () => {
    const circular: Record<string, unknown> = {}
    circular['self'] = circular
    expect(() => formatLogLine('error', 'weird', circular, at)).not.toThrow()
    expect(formatLogLine('error', 'weird', { a: 1 }, at)).toContain('{"a":1}')
  })
})

describe('describeError', () => {
  it('处理字符串、对象与 null', () => {
    expect(describeError('直接给的字符串')).toBe('直接给的字符串')
    expect(describeError({ code: 42 })).toBe('{"code":42}')
    expect(describeError(null)).toBe('null')
  })
})

describe('createLogger', () => {
  it('按行追加写入文件', () => {
    const dir = makeTempDir()
    const file = join(dir, 'nested', 'app.log')
    const logger = createLogger({
      filePath: file,
      console: false,
      now: () => new Date('2026-02-14T10:00:00.000Z')
    })

    logger.info('boot')
    logger.warn('slow-write', { ms: 120 })
    logger.error('crash', new Error('boom'))

    const lines = readFileSync(file, 'utf8').trim().split('\n')
    expect(lines).toHaveLength(3)
    expect(lines[0]).toContain('[info] boot')
    expect(lines[1]).toContain('[warn] slow-write')
    expect(lines[2]).toContain('[error] crash')
    expect(lines[2]).toContain('boom')
  })

  it('没有 filePath 时只输出控制台，不报错', () => {
    const logger = createLogger({ console: false })
    expect(() => logger.info('no-file')).not.toThrow()
  })

  it('写日志失败绝不能影响主流程', () => {
    const logger = createLogger({
      filePath: 'X:\\不存在的盘\\app.log',
      console: false,
      writer: () => {
        throw new Error('disk on fire')
      }
    })
    expect(() => logger.error('write-failed')).not.toThrow()
  })

  it('允许注入时间与写入实现，便于测试', () => {
    const write = vi.fn()
    const logger = createLogger({
      filePath: 'C:\\fake\\app.log',
      console: false,
      writer: write,
      now: () => new Date('2026-01-01T00:00:00.000Z')
    })
    logger.info('tick')
    expect(write).toHaveBeenCalledTimes(1)
    expect(write.mock.calls[0]?.[1]).toContain('2026-01-01T00:00:00.000Z [info] tick')
  })

  it('日志内容不包含任何用户数据字段（只接受显式传入的事件与详情）', () => {
    const write = vi.fn()
    const logger = createLogger({ filePath: 'C:\\fake\\app.log', console: false, writer: write })
    logger.info('data-saved', { module: 'plan', count: 3 })
    const line = String(write.mock.calls[0]?.[1])
    expect(line).toContain('data-saved')
    expect(line).toContain('plan')
  })
})
