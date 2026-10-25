/**
 * 界面侧的数据层（DEVPLAN 阶段 2）
 *
 * 职责边界：
 *   - 这里不直接碰文件系统，只调用预加载暴露的 IPC 接口
 *   - 内存里保留各模块副本，供页面同步渲染；写操作后立即回读，保证与磁盘一致
 */
import type { DataModule } from '../../shared/modules'
import type { DataStats, RecordEnvelope } from '../../shared/types'

export interface DataApi {
  list(module: DataModule): Promise<RecordEnvelope[]>
  listAlive(module: DataModule): Promise<RecordEnvelope[]>
  add(module: DataModule, record: Record<string, unknown>): Promise<RecordEnvelope>
  update(
    module: DataModule,
    id: string,
    patch: Record<string, unknown>
  ): Promise<RecordEnvelope | null>
  remove(module: DataModule, id: string, hard?: boolean): Promise<boolean>
  flush(): Promise<boolean>
}

/** 回收站条目（与 preload 暴露的形状一致） */
export interface TrashEntryData {
  module: DataModule
  id: string
  deletedAt: string
  typeLabel: string
  title: string
  origin: string
}

export interface TrashApi {
  list(): Promise<TrashEntryData[]>
  restore(module: DataModule, id: string): Promise<boolean>
  purge(module: DataModule, id: string): Promise<boolean>
  purgeAll(): Promise<{ removed: number; message: string }>
  purgeExpired(keepDays: number): Promise<{ removed: number; message: string }>
  startupPurge(): Promise<{ removed: number; message: string }>
}

export function getDataApi(): DataApi {
  return window.api.data
}

/** 回收站接口（FEAT-009） */
export function getTrashApi(): TrashApi {
  return window.api.trash
}

export function getStats(): Promise<DataStats> {
  return window.api.getStats()
}

/** 生成记录 id（与主进程保持一致的策略：优先用 crypto.randomUUID） */
export function newId(): string {
  const cryptoApi = globalThis.crypto as { randomUUID?: () => string } | undefined
  if (cryptoApi && typeof cryptoApi.randomUUID === 'function') return cryptoApi.randomUUID()
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
}

/** 当前时间的 ISO 字符串 */
export function nowIso(): string {
  return new Date().toISOString()
}
