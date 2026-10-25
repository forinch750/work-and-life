/**
 * 每日备份与清理（DEVPLAN 阶段 1 / PRD §7.3、§7.4）
 *
 * 规则：
 *   - 每次启动时把 data\ 下的文件复制到 backups\YYYY-MM-DD\
 *   - 同一天只备份一次（幂等），重复启动不会覆盖当天第一份
 *   - 只保留最近 N 天（默认 30），更早的自动清理
 *   - 备份内容里写一份 manifest，便于日后核对与人工恢复
 */
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync
} from 'node:fs'
import { join } from 'node:path'

export interface BackupOptions {
  dataDir: string
  backupDir: string
  /** 保留天数，默认 30 */
  keepDays?: number
  /** 当前时间（测试注入） */
  now?: () => Date
  /** 日志回调 */
  onEvent?: (event: string, detail?: unknown) => void
}

export interface BackupResult {
  /** 备份目录（当天） */
  dir: string
  /** 本次是否真的做了备份 */
  created: boolean
  /** 备份的文件名 */
  files: string[]
  /** 被清理掉的旧备份目录 */
  removed: string[]
  /** 面向用户的说明 */
  message: string
}

const MANIFEST_NAME = 'manifest.json'

/** 本地日期键，例如 2026-02-14（按本地时区，避免跨时区错位） */
export function localDateKey(date: Date): string {
  const year = date.getFullYear()
  const month = `${date.getMonth() + 1}`.padStart(2, '0')
  const day = `${date.getDate()}`.padStart(2, '0')
  return `${year}-${month}-${day}`
}

/** 列出目录下的普通文件（不递归，跳过子目录） */
function listFiles(dir: string): string[] {
  if (!existsSync(dir)) return []
  return readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => entry.name)
    .sort()
}

/** 判断目录名是否是 YYYY-MM-DD 形式的备份目录 */
export function isBackupDirName(name: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(name)
}

/** 清理超过保留期的备份目录 */
export function pruneBackups(backupDir: string, keepDays: number, now: Date): string[] {
  if (!existsSync(backupDir) || keepDays <= 0) return []
  const cutoff = new Date(now.getTime() - keepDays * 24 * 60 * 60 * 1000)
  const cutoffKey = localDateKey(cutoff)
  const removed: string[] = []

  for (const entry of readdirSync(backupDir, { withFileTypes: true })) {
    if (!entry.isDirectory() || !isBackupDirName(entry.name)) continue
    // 目录名是按日期升序可比较的字符串，早于截止日期的就删掉
    if (entry.name < cutoffKey) {
      const target = join(backupDir, entry.name)
      try {
        rmSync(target, { recursive: true, force: true })
        removed.push(entry.name)
      } catch {
        /* 删不掉就留着，不能因此影响启动 */
      }
    }
  }
  return removed
}

/** 执行每日备份（幂等） */
export function runDailyBackup(options: BackupOptions): BackupResult {
  const now = (options.now ?? (() => new Date()))()
  const keepDays = options.keepDays ?? 30
  const dateKey = localDateKey(now)
  const targetDir = join(options.backupDir, dateKey)

  mkdirSync(options.backupDir, { recursive: true })

  const manifestPath = join(targetDir, MANIFEST_NAME)
  const dataFiles = listFiles(options.dataDir)

  // 幂等：当天已有备份就跳过，避免后来的启动覆盖第一份
  if (existsSync(manifestPath)) {
    let files: string[] = []
    try {
      const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as { files?: string[] }
      files = manifest.files ?? []
    } catch {
      files = listFiles(targetDir).filter((name) => name !== MANIFEST_NAME)
    }
    const removed = pruneBackups(options.backupDir, keepDays, now)
    return {
      dir: targetDir,
      created: false,
      files,
      removed,
      message: `今天的备份已存在（${files.length} 个文件），本次跳过`
    }
  }

  if (dataFiles.length === 0) {
    return {
      dir: targetDir,
      created: false,
      files: [],
      removed: pruneBackups(options.backupDir, keepDays, now),
      message: '还没有任何数据文件，今天不需要备份'
    }
  }

  mkdirSync(targetDir, { recursive: true })
  const copied: string[] = []
  for (const name of dataFiles) {
    const source = join(options.dataDir, name)
    try {
      if (!statSync(source).isFile()) continue
      copyFileSync(source, join(targetDir, name))
      copied.push(name)
    } catch (error) {
      options.onEvent?.('backup-file-failed', { file: name, error: String(error) })
    }
  }

  writeFileSync(
    manifestPath,
    JSON.stringify(
      {
        date: dateKey,
        createdAt: now.toISOString(),
        files: copied
      },
      null,
      2
    ),
    'utf8'
  )

  const removed = pruneBackups(options.backupDir, keepDays, now)
  options.onEvent?.('backup-created', { dir: targetDir, files: copied.length, removed: removed.length })

  return {
    dir: targetDir,
    created: true,
    files: copied,
    removed,
    message: `已备份 ${copied.length} 个数据文件到 backups\\${dateKey}\\`
  }
}

export interface DailyBackupSummary {
  dir: string
  created: boolean
  files: string[]
  message: string
}

/** 备份目录的清单（供"数据与设置"页展示） */
export function listBackups(backupDir: string): Array<{ date: string; files: number; path: string }> {
  if (!existsSync(backupDir)) return []
  return readdirSync(backupDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && isBackupDirName(entry.name))
    .map((entry) => {
      const dir = join(backupDir, entry.name)
      return {
        date: entry.name,
        files: listFiles(dir).filter((name) => name !== MANIFEST_NAME).length,
        path: dir
      }
    })
    .sort((a, b) => (a.date < b.date ? 1 : -1))
}
