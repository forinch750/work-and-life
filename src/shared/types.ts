/**
 * 界面可用的数据类型（主进程与渲染进程共用）
 *
 * 这里只描述"跨进程传输的形状"，全部是纯 JSON，可以安全穿过 IPC。
 */
import type { DataModule } from './modules'

/**
 * 记录的公共字段。
 * 与主进程 src/main/data/format.ts 里的同名类型保持一致——
 * 那个负责落盘校验，这个负责界面与纯逻辑的类型标注，刻意不互相引用，
 * 避免"共享层反向依赖主进程"。
 */
export interface BaseRecord {
  id: string
  createdAt: string
  updatedAt: string
  /** 软删除标记 */
  deletedAt?: string
}

export interface RecordEnvelope extends BaseRecord {
  [key: string]: unknown
}

export interface AppEnvironment {
  appRoot: string
  appVersion: string
  platform: string
  isPackaged: boolean
}

export interface DataFileInfo {
  module: DataModule
  fileName: string
  exists: boolean
  bytes: number
  recordCount: number
}

export interface DataStats {
  root: string
  dataDir: string
  backupDir: string
  logFile: string
  recordCount: number
  fileCount: number
  bytes: number
  backups: Array<{ date: string; files: number; path: string }>
  files: DataFileInfo[]
  /** 启动自检的结果摘要 */
  startup: Array<{ module: DataModule; status: string; message: string }>
  /** 启动时那次备份的说明 */
  backupMessage: string
}

export type ImportMode = 'merge' | 'replace'
