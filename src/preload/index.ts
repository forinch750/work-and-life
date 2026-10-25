/**
 * 预加载脚本（DEVPLAN 阶段 1-3）
 *
 * 这是界面与主进程之间唯一的通道：Electron IPC，不是网络。
 * 暴露的接口全部是纯 JSON 的请求/响应，不含任何 Node 或文件系统细节。
 */
import { contextBridge, ipcRenderer } from 'electron'
import type { DataModule } from '../shared/modules'
import type { AppEnvironment, DataStats, ImportMode, RecordEnvelope } from '../shared/types'

export interface BackupNowResult {
  created: boolean
  dir: string
  files: string[]
  message: string
}

export interface ExportResult {
  file: string
  recordCount: number
  moduleCount: number
}

export interface ImportOutcome {
  cancelled: boolean
  message: string
  recordCount: number
}

export interface ClearAllOptions {
  /** 必须等于 "清空" 才会执行 */
  confirmText?: string
  /** 跳过二次确认弹窗（自动验收用） */
  skipDialog?: boolean
  /** 强制执行，跳过确认文字检查（自动验收用） */
  force?: boolean
}

export interface TrashEntryWire {
  module: DataModule
  id: string
  deletedAt: string
  typeLabel: string
  title: string
  origin: string
}

export interface ClearAllResult {
  cleared: boolean
  message: string
  exportedTo: string | null
  removed: number
}

const trash = {
  /** 列出回收站里的条目（各模块已删除的记录） */
  list: (): Promise<TrashEntryWire[]> => ipcRenderer.invoke('trash:list'),
  /** 恢复一条：清掉删除标记，回到原位置 */
  restore: (module: DataModule, id: string): Promise<boolean> =>
    ipcRenderer.invoke('trash:restore', module, id),
  /** 彻底删除一条 */
  purge: (module: DataModule, id: string): Promise<boolean> =>
    ipcRenderer.invoke('trash:purge', module, id),
  /** 清空回收站（彻底删除全部） */
  purgeAll: (): Promise<{ removed: number; message: string }> =>
    ipcRenderer.invoke('trash:purge-all'),
  /** 按保留期限清理过期条目 */
  purgeExpired: (keepDays: number): Promise<{ removed: number; message: string }> =>
    ipcRenderer.invoke('trash:purge-expired', keepDays),
  /** 启动时那次自动清理的结果 */
  startupPurge: (): Promise<{ removed: number; message: string }> =>
    ipcRenderer.invoke('trash:startup-purge')
}

const data = {
  /** 读取某个模块的全部记录（含软删除） */
  list: (module: DataModule): Promise<RecordEnvelope[]> => ipcRenderer.invoke('data:list', module),

  /** 只读未删除的记录 */
  listAlive: (module: DataModule): Promise<RecordEnvelope[]> =>
    ipcRenderer.invoke('data:list-alive', module),

  add: (module: DataModule, record: Record<string, unknown>): Promise<RecordEnvelope> =>
    ipcRenderer.invoke('data:add', module, record),

  update: (
    module: DataModule,
    id: string,
    patch: Record<string, unknown>
  ): Promise<RecordEnvelope | null> => ipcRenderer.invoke('data:update', module, id, patch),

  remove: (module: DataModule, id: string, hard = false): Promise<boolean> =>
    ipcRenderer.invoke('data:remove', module, id, hard),

  /** 立即落盘，返回是否有未落盘的改动被写出 */
  flush: (): Promise<boolean> => ipcRenderer.invoke('data:flush')
}

const api = {
  getEnvironment: (): Promise<AppEnvironment> => ipcRenderer.invoke('app:environment'),
  getStats: (): Promise<DataStats> => ipcRenderer.invoke('data:stats'),
  data,
  trash,
  backupNow: (): Promise<BackupNowResult> => ipcRenderer.invoke('data:backup-now'),
  /** presetPath 仅用于无人值守验收；界面上不传，走系统保存对话框 */
  exportAll: (presetPath?: string): Promise<ExportResult | null> =>
    ipcRenderer.invoke('data:export', presetPath),
  importAll: (mode: ImportMode, presetPath?: string): Promise<ImportOutcome> =>
    ipcRenderer.invoke('data:import', mode, presetPath),
  openDataFolder: (): Promise<{ opened: boolean; message: string }> =>
    ipcRenderer.invoke('data:open-folder'),
  clearAll: (options?: ClearAllOptions): Promise<ClearAllResult> =>
    ipcRenderer.invoke('data:clear-all', options ?? {})
}

export type RendererApi = typeof api

contextBridge.exposeInMainWorld('api', api)
