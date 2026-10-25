/**
 * 阶段 1 测试：每日备份与清理
 *
 * 验收目标（PRD §7.3、§7.4）：
 *   A5  程序启动后 backups\ 下出现当天日期的备份文件夹
 *   §7.3 保留最近 30 天，更早的自动清理；同一天重复启动不覆盖第一份
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  isBackupDirName,
  listBackups,
  localDateKey,
  pruneBackups,
  runDailyBackup
} from '../../src/main/data/backup'

const tempDirs: string[] = []

function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'worklife-backup-'))
  tempDirs.push(dir)
  return dir
}

function makeLayout(): { dataDir: string; backupDir: string } {
  const root = makeTempDir()
  const dataDir = join(root, 'data')
  const backupDir = join(root, 'backups')
  mkdirSync(dataDir, { recursive: true })
  mkdirSync(backupDir, { recursive: true })
  return { dataDir, backupDir }
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()
    if (dir) rmSync(dir, { recursive: true, force: true })
  }
})

describe('localDateKey', () => {
  it('按本地时区生成 YYYY-MM-DD', () => {
    expect(localDateKey(new Date(2026, 1, 14))).toBe('2026-02-14')
    expect(localDateKey(new Date(2026, 11, 3))).toBe('2026-12-03')
  })

  it('补零到两位', () => {
    expect(localDateKey(new Date(2026, 0, 5))).toBe('2026-01-05')
  })
})

describe('isBackupDirName', () => {
  it('只认日期形式的目录名', () => {
    expect(isBackupDirName('2026-02-14')).toBe(true)
    expect(isBackupDirName('2026-2-14')).toBe(false)
    expect(isBackupDirName('backup-2026-02-14')).toBe(false)
    expect(isBackupDirName('随便什么')).toBe(false)
  })
})

describe('runDailyBackup', () => {
  it('把当天数据复制到 backups\\YYYY-MM-DD\\ 并写 manifest（对应 A5）', () => {
    const { dataDir, backupDir } = makeLayout()
    writeFileSync(join(dataDir, 'plan.json'), '{"module":"plan","records":[]}', 'utf8')
    writeFileSync(join(dataDir, 'memo.json'), '{"module":"memo","records":[]}', 'utf8')

    const result = runDailyBackup({
      dataDir,
      backupDir,
      now: () => new Date(2026, 1, 14, 9, 30)
    })

    expect(result.created).toBe(true)
    expect(result.files.sort()).toEqual(['memo.json', 'plan.json'])
    expect(existsSync(join(backupDir, '2026-02-14', 'plan.json'))).toBe(true)
    expect(existsSync(join(backupDir, '2026-02-14', 'memo.json'))).toBe(true)

    const manifest = JSON.parse(readFileSync(join(backupDir, '2026-02-14', 'manifest.json'), 'utf8'))
    expect(manifest.date).toBe('2026-02-14')
    expect(manifest.files.sort()).toEqual(['memo.json', 'plan.json'])
  })

  it('同一天再次启动不覆盖已有备份（幂等）', () => {
    const { dataDir, backupDir } = makeLayout()
    const now = () => new Date(2026, 1, 14, 9, 0)

    writeFileSync(join(dataDir, 'plan.json'), '{"v":1}', 'utf8')
    const first = runDailyBackup({ dataDir, backupDir, now })
    expect(first.created).toBe(true)

    // 当天稍后数据变了，再启动一次
    writeFileSync(join(dataDir, 'plan.json'), '{"v":2}', 'utf8')
    const second = runDailyBackup({ dataDir, backupDir, now })

    expect(second.created).toBe(false)
    expect(second.message).toContain('已存在')
    // 第一份仍然是原始内容 —— 这正是幂等要保护的东西
    expect(readFileSync(join(backupDir, '2026-02-14', 'plan.json'), 'utf8')).toBe('{"v":1}')
  })

  it('没有任何数据文件时不做备份，但不算失败', () => {
    const { dataDir, backupDir } = makeLayout()
    const result = runDailyBackup({ dataDir, backupDir, now: () => new Date(2026, 1, 14) })
    expect(result.created).toBe(false)
    expect(result.files).toEqual([])
    expect(result.message).toContain('不需要备份')
  })

  it('数据目录不存在时不抛错', () => {
    const root = makeTempDir()
    const result = runDailyBackup({
      dataDir: join(root, '不存在'),
      backupDir: join(root, 'backups'),
      now: () => new Date(2026, 1, 14)
    })
    expect(result.created).toBe(false)
  })

  it('备份目录不存在时自动创建', () => {
    const root = makeTempDir()
    const dataDir = join(root, 'data')
    mkdirSync(dataDir, { recursive: true })
    writeFileSync(join(dataDir, 'plan.json'), '{}', 'utf8')

    const result = runDailyBackup({
      dataDir,
      backupDir: join(root, 'new', 'backups'),
      now: () => new Date(2026, 1, 14)
    })
    expect(result.created).toBe(true)
  })

  it('第 31 天启动时清理掉最老的一份，只留 30 份', () => {
    const { dataDir, backupDir } = makeLayout()
    writeFileSync(join(dataDir, 'plan.json'), '{}', 'utf8')

    // 造 31 天的备份
    for (let day = 1; day <= 31; day += 1) {
      runDailyBackup({
        dataDir,
        backupDir,
        now: () => new Date(2026, 0, day, 12)
      })
    }
    const before = listBackups(backupDir)
    expect(before).toHaveLength(31)

    const result = runDailyBackup({
      dataDir,
      backupDir,
      now: () => new Date(2026, 1, 1, 12) // 2 月 1 日，距 1 月 1 日 31 天
    })

    expect(result.removed).toContain('2026-01-01')
    expect(existsSync(join(backupDir, '2026-01-01'))).toBe(false)
    expect(existsSync(join(backupDir, '2026-02-01'))).toBe(true)
    expect(listBackups(backupDir).length).toBeLessThanOrEqual(31)
  })

  it('保留天数可配置：keepDays=1 时只留今天和昨天', () => {
    const { dataDir, backupDir } = makeLayout()
    writeFileSync(join(dataDir, 'plan.json'), '{}', 'utf8')

    runDailyBackup({ dataDir, backupDir, keepDays: 1, now: () => new Date(2026, 0, 10, 12) })
    runDailyBackup({ dataDir, backupDir, keepDays: 1, now: () => new Date(2026, 0, 11, 12) })
    const result = runDailyBackup({ dataDir, backupDir, keepDays: 1, now: () => new Date(2026, 0, 12, 12) })

    expect(result.removed).toContain('2026-01-10')
    expect(existsSync(join(backupDir, '2026-01-11'))).toBe(true)
    expect(existsSync(join(backupDir, '2026-01-12'))).toBe(true)
  })

  it('备份失败的文件不影响其它文件，并通过 onEvent 上报', () => {
    const { dataDir, backupDir } = makeLayout()
    writeFileSync(join(dataDir, 'plan.json'), '{}', 'utf8')
    // 用一个目录占住同名目标文件，让 copyFileSync 失败
    mkdirSync(join(backupDir, '2026-02-14', 'plan.json'), { recursive: true })

    const onEvent = vi.fn()
    const result = runDailyBackup({
      dataDir,
      backupDir,
      now: () => new Date(2026, 1, 14),
      onEvent
    })

    expect(result.files).toEqual([])
    expect(onEvent).toHaveBeenCalledWith('backup-file-failed', expect.anything())
  })
})

describe('pruneBackups', () => {
  it('只删日期目录，不碰其它目录', () => {
    const { backupDir } = makeLayout()
    mkdirSync(join(backupDir, '2026-01-01'), { recursive: true })
    mkdirSync(join(backupDir, '重要文件夹'), { recursive: true })

    const removed = pruneBackups(backupDir, 1, new Date(2026, 1, 1))
    expect(removed).toContain('2026-01-01')
    expect(existsSync(join(backupDir, '重要文件夹'))).toBe(true)
  })

  it('目录不存在时安全返回', () => {
    expect(pruneBackups('Z:\\不存在的目录', 30, new Date())).toEqual([])
  })
})

describe('listBackups', () => {
  it('按日期倒序列出备份及文件数', () => {
    const { dataDir, backupDir } = makeLayout()
    writeFileSync(join(dataDir, 'plan.json'), '{}', 'utf8')
    runDailyBackup({ dataDir, backupDir, now: () => new Date(2026, 0, 10, 12) })
    runDailyBackup({ dataDir, backupDir, now: () => new Date(2026, 0, 12, 12) })

    const list = listBackups(backupDir)
    expect(list.map((item) => item.date)).toEqual(['2026-01-12', '2026-01-10'])
    expect(list[0]!.files).toBe(1)
  })

  it('没有备份时返回空数组', () => {
    expect(listBackups(join(makeTempDir(), 'nothing'))).toEqual([])
  })
})
