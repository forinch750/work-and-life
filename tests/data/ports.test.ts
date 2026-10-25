/**
 * 阶段 0 测试：端口快照诊断
 *
 * 对应 PRD K2 —— 需要一个可检查的证据来证明运行期间不新增监听端口。
 */
import { mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { capturePortSnapshot, parseListeningPorts, savePortSnapshot } from '../../src/main/diagnostics/ports'

const tempDirs: string[] = []

function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'worklife-ports-'))
  tempDirs.push(dir)
  return dir
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()
    if (dir) rmSync(dir, { recursive: true, force: true })
  }
})

describe('parseListeningPorts', () => {
  it('解析多行端口并去重排序', () => {
    const stdout = ['5173', '135', '8888', '5173', '445', ''].join('\r\n')
    expect(parseListeningPorts(stdout)).toEqual([135, 445, 5173, 8888])
  })

  it('忽略空白行与非法内容', () => {
    const stdout = ['  135  ', '', 'not-a-port', '99999', '0', '-1', '443'].join('\n')
    expect(parseListeningPorts(stdout)).toEqual([135, 443])
  })

  it('空输出返回空数组', () => {
    expect(parseListeningPorts('')).toEqual([])
    expect(parseListeningPorts('\r\n\r\n')).toEqual([])
  })

  it('能认出 Jupyter 常用端口（便于对比，而不是避开）', () => {
    const stdout = ['8888', '8889', '8890'].join('\n')
    expect(parseListeningPorts(stdout)).toEqual([8888, 8889, 8890])
  })
})

describe('capturePortSnapshot', () => {
  it('返回带时间戳的快照，端口一定是数组', () => {
    const snapshot = capturePortSnapshot()
    expect(Array.isArray(snapshot.ports)).toBe(true)
    expect(Number.isNaN(Date.parse(snapshot.takenAt))).toBe(false)
  })
})

describe('savePortSnapshot', () => {
  it('把快照写成可读的 JSON 文件', () => {
    const dir = makeTempDir()
    const file = savePortSnapshot(join(dir, 'diagnostics'), 'test')

    expect(existsSync(file)).toBe(true)
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as { takenAt: string; ports: number[] }
    expect(Array.isArray(parsed.ports)).toBe(true)
    expect(file.endsWith('ports-test.json')).toBe(true)
  })

  it('目录不存在时自动创建', () => {
    const dir = makeTempDir()
    const nested = join(dir, 'a', 'b', 'c')
    expect(() => savePortSnapshot(nested, 'nested')).not.toThrow()
    expect(existsSync(join(nested, 'ports-nested.json'))).toBe(true)
  })
})
