/**
 * 数据层统一入口（DEVPLAN 阶段 1）
 *
 * 把内存仓、每日备份、导出导入、启动自检收在一处，
 * 主进程只需要调用这里，不直接碰文件细节。
 */
import { existsSync, mkdirSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import type { DataModule } from '../../shared/modules'
import { DATA_MODULES, moduleFileName } from '../../shared/modules'
import { listBackups, runDailyBackup, type BackupResult } from './backup'
import { readPreferences } from '../../shared/preferences'
import { collectTrash, expiredEntries, type TrashEntry } from '../../shared/trash'
import type { DataPaths } from './paths'
import { DataStore, type ModuleStore } from './store'
import type { RecoveryResult } from './recovery'
import { exportAllData, importAllData, type ExportResult, type ImportMode, type ImportResult } from './exportImport'
import type { Logger } from './logger'

export interface AppDataOptions {
  paths: DataPaths
  appVersion: string
  logger: Logger
  /** 备份保留天数 */
  keepDays?: number
  /** 防抖合并窗口 */
  writeDelayMs?: number
  /**
   * 首次启动时是否为每个模块预建空数据文件，默认 false。
   * 不预建的原因：首份备份应当反映"用户真正写过什么"，
   * 空文件推迟到用户第一次保存时创建（由 flushAll 完成），
   * 否则会出现"备份了六个空文件"这种没有意义的备份。
   */
  seedEmptyFiles?: boolean
}

export interface AppDataStats {
  root: string
  dataDir: string
  backupDir: string
  logFile: string
  recordCount: number
  fileCount: number
  bytes: number
  backups: Array<{ date: string; files: number; path: string }>
}

export interface AppData {
  paths: DataPaths
  store: DataStore
  /** 启动时的检查结果（含是否有模块从备份恢复、是否有迁移） */
  startup: RecoveryResult[]
  /** 启动时的每日备份结果 */
  backup: BackupResult
  /** 启动时回收站自动清理的结果 */
  trashPurgeResult: { removed: number; message: string }
  /** 取得某模块的读写接口 */
  module(module: DataModule): ModuleStore
  getStats(): AppDataStats
  /** 立即再做一次备份（手动触发；当天已有备份时不会覆盖） */
  runBackupNow(): BackupResult
  flushAll(): void
  exportAll(targetFile: string): ExportResult
  importAll(sourceFile: string, mode: ImportMode): ImportResult
  /** 回收站：列出各模块已删除的记录 */
  trashList(): TrashEntry[]
  /** 回收站：恢复一条（清掉删除标记，回到原位置） */
  trashRestore(module: DataModule, id: string): boolean
  /** 回收站：彻底删除一条 */
  trashPurge(module: DataModule, id: string): boolean
  /** 回收站：清空（彻底删除全部） */
  trashPurgeAll(): number
  /** 回收站：按保留期限彻底删除过期条目，返回删除条数 */
  trashPurgeExpired(keepDays: number): number
}

export function createAppData(options: AppDataOptions): AppData {
  const { paths, logger } = options

  const store = new DataStore({
    dataDir: paths.data,
    // 落盘边界（PRD K3）：数据文件必须写在应用根内，越界直接拒绝
    allowedRoot: paths.root,
    writeDelayMs: options.writeDelayMs,
    onWriteError: (module, error) => logger.error('data-write-failed', { module, error: String(error) }),
    onRecovered: (module, result) => logger.warn('data-recovered-from-backup', { module, detail: result.message })
  })

  // 1) 预热所有模块：启动自检在最前面完成，发现问题能尽早暴露
  const startup: RecoveryResult[] = []
  for (const module of DATA_MODULES) {
    const result = store.load(module)
    startup.push(result)
    if (result.status === 'recovered-from-backup') {
      logger.warn('startup-recovered', { module, detail: result.message })
    } else if (result.status === 'corrupted') {
      logger.error('startup-corrupted', { module, detail: result.message })
    } else if (result.status === 'migrated') {
      logger.info('startup-migrated', { module, detail: result.message })
    }
  }

  // 2) 可选：为每个模块预建空数据文件（测试与"数据与设置"页需要）
  //    必须"逐个立即落盘"，否则文件要等到 flushAll 才出现，
  //    备份会跑在文件生成之前，导致首份备份缺失。
  if (options.seedEmptyFiles === true) {
    for (const module of DATA_MODULES) {
      const filePath = join(paths.data, moduleFileName(module))
      if (!existsSync(filePath)) store.module(module).writeNow()
    }
  }

  /** 备份保留份数：以"数据与设置"页的偏好为准，其次调用方指定，最后默认 30 */
  const currentKeepDays = (): number =>
    readPreferences(store.module('app').all() as unknown as Array<Record<string, unknown>>)
      .backupKeepDays ??
    options.keepDays ??
    30

  // 3) 每日备份（幂等）
  //
  // 保留份数以前恒用 options.keepDays ?? 30，导致设置页那个"备份保留份数"是个空挡：
  // 改了不生效，界面写着"保留最近 N 份"而实际永远按 30 天清理。
  // 偏好存在 app 模块里，而上面第 1 步已把 app 模块加载进内存，因此这里能读到最新值。
  const backup = runDailyBackup({
    dataDir: paths.data,
    backupDir: paths.backups,
    keepDays: currentKeepDays(),
    onEvent: (event, detail) => logger.info(event, detail)
  })
  logger.info('startup-backup', { created: backup.created, detail: backup.message })

  /** 回收站保留天数：以设置里的偏好为准，缺省 30 天 */
  const currentTrashKeepDays = (): number =>
    readPreferences(store.module('app').all() as unknown as Array<Record<string, unknown>>)
      .trashKeepDays

  /** 列出各模块已删除的记录（回收站的内容） */
  const trashList = (): TrashEntry[] => {
    const input: Partial<Record<DataModule, Array<Record<string, unknown>>>> = {}
    for (const module of DATA_MODULES) {
      input[module] = store.module(module).all() as unknown as Array<Record<string, unknown>>
    }
    return collectTrash(input)
  }

  /** 按保留期限彻底删除过期条目 */
  const purgeExpiredTrash = (keepDays: number): number => {
    const expired = expiredEntries(trashList(), keepDays, new Date())
    for (const entry of expired) {
      store.module(entry.module).remove(entry.id, { hard: true })
    }
    if (expired.length > 0) store.flushAll()
    return expired.length
  }

  // 4) 启动时按保留期限清理回收站
  //    为什么放在启动而不是定时：这个程序不常驻后台，启动时清一次最省事，
  //    也与每日备份同一时机，用户能预期"打开程序时顺手整理了一下"。
  let startupTrashPurge = { removed: 0, message: '回收站无需清理' }
  try {
    const removed = purgeExpiredTrash(currentTrashKeepDays())
    startupTrashPurge =
      removed > 0
        ? { removed, message: `已按保留期限彻底删除 ${removed} 项回收站内容` }
        : { removed: 0, message: '回收站无需清理' }
    if (removed > 0) logger.info('trash-purged', { removed })
  } catch (error) {
    logger.warn('trash-purge-failed', String(error))
  }

  return {
    paths,
    store,
    startup,
    backup,
    trashPurgeResult: startupTrashPurge,
    module: (module) => store.module(module),
    getStats() {
      let recordCount = 0
      let fileCount = 0
      let bytes = 0
      for (const module of DATA_MODULES) {
        const filePath = join(paths.data, moduleFileName(module))
        if (!existsSync(filePath)) continue
        fileCount += 1
        bytes += statSync(filePath).size
        recordCount += store.module(module).all().length
      }
      return {
        root: paths.root,
        dataDir: paths.data,
        backupDir: paths.backups,
        logFile: paths.logFile,
        recordCount,
        fileCount,
        bytes,
        backups: listBackups(paths.backups)
      }
    },
    flushAll: () => store.flushAll(),
    runBackupNow: () => {
      // 先把内存里的改动写盘，否则备份可能漏掉刚做的编辑
      store.flushAll()
      const result = runDailyBackup({
        dataDir: paths.data,
        backupDir: paths.backups,
        // 手动备份要实时读偏好：用户可能刚在设置里改过保留份数
        keepDays: currentKeepDays(),
        onEvent: (event, detail) => logger.info(event, detail)
      })
      logger.info('manual-backup', { created: result.created, files: result.files.length })
      return result
    },
    exportAll: (targetFile) =>
      exportAllData({ dataDir: paths.data, targetFile, appVersion: options.appVersion }),
    importAll: (sourceFile, mode) =>
      importAllData({
        sourceFile,
        dataDir: paths.data,
        backupDir: paths.backups,
        mode,
        // 逐模块写盘后立刻重载内存副本，保证界面看到的就是磁盘上的最新内容
        onModuleWritten: (module) => store.module(module).reload(),
        onBackup: (result) => logger.info('import-pre-backup', { dir: result.dir, created: result.created })
      }),
    trashList,
    /**
     * 恢复一条：清掉删除标记即可回到原位置。
     *
     * 这是"回收站不新增数据文件"这个设计带来的好处——
     * 记录一直在原来的模块文件里，恢复不需要搬运数据，也不会出现两份不一致。
     *
     * **必须用 null 而不是 undefined**：这个补丁要经 IPC 的结构化克隆传到主进程，
     * 而 `{deletedAt: undefined}` 序列化后键会直接消失（变成空对象 `{}`），
     * update 里 `{...current, ...patch}` 就无法覆盖掉原来的删除标记，
     * 结果是"点了恢复但记录还在回收站里"。
     * null 能穿过结构化克隆，而 isAlive() 把 undefined 与 null 都视为存活。
     */
    trashRestore: (module, id) => {
      const current = store.module(module).byId(id)
      if (!current) return false
      store.module(module).update(id, { deletedAt: null } as unknown as Record<string, unknown>)
      store.flushAll()
      logger.info('trash-restored', { module, id })
      return true
    },
    trashPurge: (module, id) => {
      const ok = store.module(module).remove(id, { hard: true })
      if (ok) {
        store.flushAll()
        logger.warn('trash-purged-item', { module, id })
      }
      return ok
    },
    trashPurgeAll: () => {
      let removed = 0
      for (const entry of trashList()) {
        if (store.module(entry.module).remove(entry.id, { hard: true })) removed += 1
      }
      store.flushAll()
      logger.warn('trash-emptied', { removed })
      return removed
    },
    trashPurgeExpired: purgeExpiredTrash
  }
}
/** 确保数据目录存在（轻量工具，供主进程早期调用） */
export function ensureDataDirReady(dataDir: string): void {
  if (!existsSync(dataDir)) mkdirSync(dataDir, { recursive: true })
}

/** 列出数据目录下的文件名（诊断用） */
export function listDataFiles(dataDir: string): string[] {
  if (!existsSync(dataDir)) return []
  return readdirSync(dataDir, { withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => entry.name)
    .sort()
}
