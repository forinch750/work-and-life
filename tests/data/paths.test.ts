/**
 * 阶段 0 测试：路径解析
 *
 * 验收目标：本程序产生的文件只落在应用根目录内（对应 PRD K3）。
 */
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve, sep } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { ensureDataDirs, isInsideRoot, resolveDataPaths } from '../../src/main/data/paths'

const tempDirs: string[] = []

function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'worklife-paths-'))
  tempDirs.push(dir)
  return dir
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()
    if (dir) rmSync(dir, { recursive: true, force: true })
  }
})

describe('resolveDataPaths', () => {
  it('所有目录都在应用根目录之下', () => {
    const root = 'D:\\工作生活'
    const paths = resolveDataPaths({ appRoot: root })

    expect(paths.root).toBe(resolve(root))
    expect(paths.data.startsWith(resolve(root) + sep)).toBe(true)
    expect(paths.backups.startsWith(resolve(root) + sep)).toBe(true)
    expect(paths.logs.startsWith(resolve(root) + sep)).toBe(true)
    expect(paths.diagnostics.startsWith(resolve(root) + sep)).toBe(true)
    expect(paths.exports.startsWith(resolve(root) + sep)).toBe(true)
  })

  it('目录名符合 PRD §7.1 的约定', () => {
    const paths = resolveDataPaths({ appRoot: 'D:\\工作生活' })
    expect(paths.data.endsWith(`${sep}data`)).toBe(true)
    expect(paths.backups.endsWith(`${sep}backups`)).toBe(true)
    expect(paths.logs.endsWith(`${sep}logs`)).toBe(true)
    expect(paths.logFile.endsWith(`${sep}logs${sep}app.log`)).toBe(true)
    // 导出的副本必须与备份分开，否则日后分不清某份文件是哪来的
    expect(paths.exports.endsWith(`${sep}exports`)).toBe(true)
    expect(paths.exports).not.toBe(paths.backups)
  })

  it('相对路径会被解析成绝对路径', () => {
    const paths = resolveDataPaths({ appRoot: '.' })
    expect(paths.data).toBe(resolve('.', 'data'))
  })
})

describe('ensureDataDirs', () => {
  it('一次性创建全部目录', () => {
    const root = makeTempDir()
    const paths = resolveDataPaths({ appRoot: root })
    ensureDataDirs(paths)

    expect(existsSync(paths.data)).toBe(true)
    expect(existsSync(paths.backups)).toBe(true)
    expect(existsSync(paths.logs)).toBe(true)
    expect(existsSync(paths.diagnostics)).toBe(true)
    expect(existsSync(paths.exports)).toBe(true)
  })

  it('重复调用是幂等的（启动多次不会报错）', () => {
    const root = makeTempDir()
    const paths = resolveDataPaths({ appRoot: root })
    expect(() => {
      ensureDataDirs(paths)
      ensureDataDirs(paths)
      ensureDataDirs(paths)
    }).not.toThrow()
  })

  it('只创建目录，不创建任何数据文件', () => {
    const root = makeTempDir()
    const paths = resolveDataPaths({ appRoot: root })
    ensureDataDirs(paths)
    expect(existsSync(join(paths.data, 'app.json'))).toBe(false)
  })
})

describe('isInsideRoot', () => {
  it('根目录自身与内部路径都算在内', () => {
    expect(isInsideRoot('D:\\工作生活', 'D:\\工作生活')).toBe(true)
    expect(isInsideRoot('D:\\工作生活', 'D:\\工作生活\\data\\plan.json')).toBe(true)
    expect(isInsideRoot('D:\\工作生活\\', 'D:\\工作生活\\data')).toBe(true)
  })

  it('大小写不同也算在内（Windows 路径不区分大小写）', () => {
    expect(isInsideRoot('D:\\工作生活', 'd:\\工作生活\\data\\memo.json')).toBe(true)
  })

  it('相似前缀的兄弟目录必须被拒绝', () => {
    expect(isInsideRoot('D:\\工作生活', 'D:\\工作生活备份\\plan.json')).toBe(false)
    expect(isInsideRoot('D:\\工作生活', 'D:\\工作生活2')).toBe(false)
  })

  it('外部路径必须被拒绝', () => {
    expect(isInsideRoot('D:\\工作生活', 'C:\\Users\\HP\\AppData\\Roaming\\x.json')).toBe(false)
    expect(isInsideRoot('D:\\工作生活', 'D:\\elsewhere\\data.json')).toBe(false)
    expect(isInsideRoot('D:\\工作生活', '\\\\wsl$\\Ubuntu\\home\\me\\x.json')).toBe(false)
  })
})
