/**
 * 数据相关 IPC 注册（DEVPLAN 阶段 1）
 *
 * 界面只能通过这里读写数据：走 Electron IPC，不经过网络，也不直接接触文件系统。
 * 所有返回值都是纯 JSON。
 */
import { app, dialog, ipcMain, shell, type BrowserWindow } from 'electron'
import { existsSync, statSync } from 'node:fs'
import { join } from 'node:path'
import type { DataModule } from '../shared/modules'
import { DATA_MODULES, isDataModule, moduleFileName } from '../shared/modules'
import type { DataStats, ImportMode } from '../shared/types'
import type { AppData } from './data'
import type { Logger } from './data/logger'

export interface RegisterDataIpcOptions {
  appData: AppData
  logger: Logger
  getWindow: () => BrowserWindow | null
}

/** 校验模块名，防止渲染进程传入任意字符串 */
function requireModule(value: unknown): DataModule {
  if (typeof value !== 'string' || !isDataModule(value)) {
    throw new Error(`未知的数据模块：${String(value)}`)
  }
  return value
}

/** 校验记录体：必须是普通对象 */
function requireRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('记录必须是一个对象')
  }
  return value as Record<string, unknown>
}

export function registerDataIpc(options: RegisterDataIpcOptions): void {
  const { appData, logger, getWindow } = options

  ipcMain.handle('data:list', (_event, module: unknown) => appData.module(requireModule(module)).all())

  ipcMain.handle('data:list-alive', (_event, module: unknown) =>
    appData.module(requireModule(module)).list()
  )

  ipcMain.handle('data:add', (_event, module: unknown, record: unknown) => {
    const target = requireModule(module)
    const created = appData.module(target).add(requireRecord(record))
    logger.info('data-added', { module: target })
    return created
  })

  ipcMain.handle('data:update', (_event, module: unknown, id: unknown, patch: unknown) => {
    const target = requireModule(module)
    if (typeof id !== 'string') throw new Error('id 必须是字符串')
    return appData.module(target).update(id, requireRecord(patch)) ?? null
  })

  ipcMain.handle('data:remove', (_event, module: unknown, id: unknown, hard: unknown) => {
    const target = requireModule(module)
    if (typeof id !== 'string') throw new Error('id 必须是字符串')
    return appData.module(target).remove(id, { hard: hard === true })
  })

  ipcMain.handle('data:flush', () => {
    const hadPending = appData.store.hasPendingWrites()
    appData.flushAll()
    return hadPending
  })

  ipcMain.handle('data:stats', (): DataStats => {
    const stats = appData.getStats()
    const files = DATA_MODULES.map((module: DataModule) => {
      const fileName = moduleFileName(module)
      const filePath = join(stats.dataDir, fileName)
      const exists = existsSync(filePath)
      return {
        module,
        fileName,
        exists,
        bytes: exists ? statSync(filePath).size : 0,
        recordCount: appData.module(module).all().length
      }
    })

    return {
      root: stats.root,
      dataDir: stats.dataDir,
      backupDir: stats.backupDir,
      logFile: stats.logFile,
      recordCount: stats.recordCount,
      fileCount: stats.fileCount,
      bytes: stats.bytes,
      backups: stats.backups,
      files,
      startup: appData.startup.map((item) => ({
        module: item.module,
        status: item.status,
        message: item.message
      })),
      backupMessage: appData.backup.message
    }
  })

  ipcMain.handle('data:backup-now', () => {
    const result = appData.runBackupNow()
    logger.info('manual-backup', { created: result.created, files: result.files.length })
    return {
      created: result.created,
      dir: result.dir,
      files: result.files,
      message: result.message
    }
  })

  ipcMain.handle('data:export', async (_event, presetPath?: unknown) => {
    const window = getWindow()
    const defaultName = `工作生活-数据备份-${new Date().toISOString().slice(0, 10)}.json`

    // 无人值守验收时可以显式传入落点，避免文件对话框把自动流程卡住。
    // 正式使用时界面不传该参数，走正常的保存对话框。
    let targetPath: string | null = null

    if (typeof presetPath === 'string' && presetPath.trim() !== '') {
      targetPath = presetPath
    } else {
      const options = {
        title: '导出全部数据',
        // 默认落在应用根内的 exports\，用户仍可另选位置（例如 U 盘）
        defaultPath: join(appData.paths.exports, defaultName),
        filters: [{ name: 'JSON 数据文件', extensions: ['json'] }]
      }
      const result = window
        ? await dialog.showSaveDialog(window, options)
        : await dialog.showSaveDialog(options)
      if (result.canceled || !result.filePath) return null
      targetPath = result.filePath
    }

    const exported = appData.exportAll(targetPath)
    logger.info('data-exported', { modules: exported.moduleCount, records: exported.recordCount })
    return {
      file: exported.file,
      recordCount: exported.recordCount,
      moduleCount: exported.moduleCount
    }
  })

  ipcMain.handle('data:import', async (_event, mode: unknown, presetPath?: unknown) => {
    const importMode: ImportMode = mode === 'merge' ? 'merge' : 'replace'
    const window = getWindow()

    let sourceFile: string | null = null
    const fromEnv = process.env['WORKLIFE_IMPORT_PATH']
    if (typeof presetPath === 'string' && presetPath.trim() !== '') {
      sourceFile = presetPath
    } else if (fromEnv && fromEnv.trim() !== '') {
      sourceFile = fromEnv
    } else {
      const options = {
        title: '选择要导入的数据文件',
        properties: ['openFile' as const],
        filters: [{ name: 'JSON 数据文件', extensions: ['json'] }]
      }
      const picked = window
        ? await dialog.showOpenDialog(window, options)
        : await dialog.showOpenDialog(options)
      if (picked.canceled || picked.filePaths.length === 0) {
        return { cancelled: true, message: '已取消导入', recordCount: 0 }
      }
      sourceFile = picked.filePaths[0] ?? null
    }

    if (!sourceFile) return { cancelled: true, message: '已取消导入', recordCount: 0 }

    try {
      const result = appData.importAll(sourceFile, importMode)
      logger.info('data-imported', {
        mode: importMode,
        modules: result.perModule.length,
        records: result.recordCount
      })
      return { cancelled: false, message: result.message, recordCount: result.recordCount }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      logger.error('data-import-failed', message)
      return { cancelled: false, message, recordCount: 0 }
    }
  })

  // 在文件管理器里打开数据目录
  ipcMain.handle('data:open-folder', async () => {
    const result = await shell.openPath(appData.paths.data)
    if (result !== '') {
      logger.warn('open-folder-failed', result)
      return { opened: false, message: result }
    }
    logger.info('open-folder', { dir: appData.paths.data })
    return { opened: true, message: appData.paths.data }
  })

  // 清空全部数据。破坏性操作，必须显式确认后才执行。
  ipcMain.handle('data:clear-all', async (_event, options: unknown) => {
    const opts = (typeof options === 'object' && options !== null ? options : {}) as {
      confirmText?: unknown
      force?: unknown
      skipDialog?: unknown
      /** 显式指定落点（无人值守验收用，避免污染真实桌面） */
      exportDir?: unknown
    }

    const force = opts.force === true
    if (!force && opts.confirmText !== '清空') {
      return { cleared: false, message: '确认文字不正确，未执行清空', exportedTo: null, removed: 0 }
    }

    // 清空前先把最后一份数据导出，给一次后悔的机会。
    //
    // 落点优先级：调用方显式指定 → WORKLIFE_EXPORT_DIR → 应用根内的 exports\。
    // **默认不再是系统桌面**：以前写桌面，每跑一次验收就往真实桌面丢一份
    // （实测攒了 40 个）。现在一律待在应用根内，用户想挪走可以自己拷。
    let exportedTo: string | null = null
    try {
      const fromEnv = process.env['WORKLIFE_EXPORT_DIR']
      const dir =
        typeof opts.exportDir === 'string' && opts.exportDir.trim() !== ''
          ? opts.exportDir
          : typeof fromEnv === 'string' && fromEnv.trim() !== ''
            ? fromEnv
            : appData.paths.exports
      const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
      const target = join(dir, `工作生活-清空前备份-${stamp}.json`)
      const result = appData.exportAll(target)
      exportedTo = result.file
      logger.info('clear-all-pre-export', { file: result.file })
    } catch (error) {
      logger.warn('clear-all-pre-export-failed', String(error))
    }

    // 再确认一次（自动流程跳过）
    if (!force && opts.skipDialog !== true) {
      const window = getWindow()
      const detail = exportedTo
        ? `清空前已把当前数据导出到：\n${exportedTo}\n\n清空后无法在程序内撤销，只能从该文件或 backups 目录恢复。`
        : '清空前导出失败（可能是桌面不可写）。清空后无法在程序内撤销，请确认 backups 目录可用。'
      const options2 = {
        type: 'warning' as const,
        title: '清空全部数据',
        message: '确定要清空全部数据吗？',
        detail,
        buttons: ['取消', '确认清空'],
        defaultId: 0,
        cancelId: 0
      }
      const answer = window
        ? await dialog.showMessageBox(window, options2)
        : await dialog.showMessageBox(options2)
      if (answer.response !== 1) {
        return { cleared: false, message: '已取消清空', exportedTo, removed: 0 }
      }
    }

    let removed = 0
    for (const module of DATA_MODULES) {
      const store = appData.module(module)
      for (const record of store.all()) {
        if (store.remove(record.id, { hard: true })) removed += 1
      }
    }
    appData.flushAll()
    logger.warn('data-cleared', { removed })

    return {
      cleared: true,
      message: `已清空 ${removed} 条记录`,
      exportedTo,
      removed
    }
  })

  // ---- 回收站（第二轮 FEAT-009）----
  //
  // 设计：不新增数据文件，复用既有的软删除（deletedAt）。
  // "恢复"只是清掉标记，记录本来就在原模块文件里，因此天然回到原位置。
  // 注意「清空全部数据」**不是**回收站的一部分，它是物理删除（唯一例外）。

  ipcMain.handle('trash:list', () => appData.trashList())

  ipcMain.handle('trash:restore', (_event, module: unknown, id: unknown) => {
    const target = requireModule(module)
    if (typeof id !== 'string') throw new Error('id 必须是字符串')
    const ok = appData.trashRestore(target, id)
    logger.info('trash-restore-requested', { module: target, ok })
    return ok
  })

  ipcMain.handle('trash:purge', (_event, module: unknown, id: unknown) => {
    const target = requireModule(module)
    if (typeof id !== 'string') throw new Error('id 必须是字符串')
    return appData.trashPurge(target, id)
  })

  ipcMain.handle('trash:purge-all', () => {
    const removed = appData.trashPurgeAll()
    return { removed, message: removed > 0 ? `已彻底删除 ${removed} 项` : '回收站本来就是空的' }
  })

  ipcMain.handle('trash:purge-expired', (_event, keepDays: unknown) => {
    const days = typeof keepDays === 'number' ? keepDays : Number.parseInt(String(keepDays ?? ''), 10)
    if (!Number.isFinite(days)) throw new Error('保留天数必须是数字')
    const removed = appData.trashPurgeExpired(days)
    return { removed, message: removed > 0 ? `已清理 ${removed} 项过期内容` : '没有过期内容' }
  })

  // 启动时那次自动清理的结果，供设置页显示
  ipcMain.handle('trash:startup-purge', () => appData.trashPurgeResult)

  logger.info('data-ipc-registered', { handlers: 17, appVersion: app.getVersion() })
}
