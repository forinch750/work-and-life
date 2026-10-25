/**
 * 内存数据仓（DEVPLAN 阶段 1）
 *
 * 每个模块一份内存副本，改动先落到内存并标记脏，由防抖器合并后原子落盘。
 * 读接口返回深拷贝，避免调用方无意中改到内部状态。
 *
 * 说明：记录体是"带公共字段的任意 JSON"，所以这里统一用
 * BaseRecord & Record<string, unknown> 表示，不做每模块的泛型建模——
 * 各模块的字段含义由界面与测试各自负责，数据层只保证公共字段与持久化。
 */
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { DataModule } from '../../shared/modules'
import { moduleFileName } from '../../shared/modules'
import { writeFileAtomic } from './atomic'
import { createDebouncedWriter, type DebouncedWriter } from './debounce'
import {
  aliveRecords,
  createEmptyModuleFile,
  normalizeModuleFile,
  type BaseRecord,
  type ModuleFile
} from './format'
import { recoverModuleFile, type RecoveryResult } from './recovery'
import { isInsideRoot } from './paths'

export type { BaseRecord, ModuleFile }

/** 数据层对外使用的记录类型 */
export type RecordData = BaseRecord & Record<string, unknown>

export interface StoreOptions {
  dataDir: string
  /**
   * 允许写入的边界（应用根目录）。
   *
   * 这是 PRD K3（"数据只出现在应用根下"）在运行时的强制点：
   * 数据文件名来自模块白名单，本不该越界，但"不该"不等于"不会"——
   * 所以每次落盘前都实际校验一次。越界直接抛错（由防抖器转给 onWriteError 记入日志），
   * 宁可不写，也不要在应用根之外留下文件。
   *
   * 缺省时不校验（测试会写到临时目录）。
   */
  allowedRoot?: string
  /** 防抖合并窗口毫秒数 */
  writeDelayMs?: number
  /** 最长等待毫秒数 */
  maxDelayMs?: number
  /** 落盘失败回调 */
  onWriteError?: (module: DataModule, error: unknown) => void
  /** 从备份恢复时的通知回调 */
  onRecovered?: (module: DataModule, result: RecoveryResult) => void
  /** 注入写入实现（测试用） */
  writeImpl?: (filePath: string, content: string) => number
}

export interface ModuleStore {
  readonly module: DataModule
  readonly filePath: string
  /** 取全部记录（含软删除）的深拷贝 */
  all(): RecordData[]
  /** 取未删除记录的深拷贝 */
  list(): RecordData[]
  byId(id: string): RecordData | undefined
  /** 新增一条记录；id 与时间戳自动补齐 */
  add(record: Record<string, unknown>): RecordData
  /** 局部更新一条记录 */
  update(id: string, patch: Record<string, unknown>): RecordData | undefined
  /** 软删除（默认）或物理删除 */
  remove(id: string, options?: { hard?: boolean }): boolean
  /** 重新从磁盘加载（导入之后使用；会丢弃未落盘的改动） */
  reload(): RecoveryResult
  /**
   * 丢弃内存中的改动。
   * 仅供"导入"这类已经直接写盘、需要丢掉过期内存副本的流程使用。
   */
  discardPendingWrites(): void
  /** 立即落盘（若没有待写内容则不做事） */
  flush(): void
  /**
   * 无条件把当前内存内容写盘。
   * 用于"首次建文件"这类内存里没有待写改动、但磁盘上需要有一份文件的场景。
   */
  writeNow(): void
  /** 是否有未落盘的改动 */
  hasPendingWrites(): boolean
  /** 最后加载时做的迁移/恢复信息 */
  loadInfo(): RecoveryResult
}

let idCounter = 0

/** 生成记录 id。优先用 crypto.randomUUID，退化到时间戳+计数。 */
export function generateId(): string {
  const cryptoApi = globalThis.crypto as { randomUUID?: () => string } | undefined
  if (cryptoApi && typeof cryptoApi.randomUUID === 'function') return cryptoApi.randomUUID()
  idCounter += 1
  return `${Date.now().toString(36)}-${idCounter.toString(36)}`
}

export class DataStore {
  private readonly options: StoreOptions
  private readonly modules = new Map<DataModule, ModuleStore>()
  private readonly writers = new Map<DataModule, DebouncedWriter>()

  constructor(options: StoreOptions) {
    this.options = options
  }

  /** 取得（必要时创建）某个模块的读写接口 */
  module(module: DataModule): ModuleStore {
    const existing = this.modules.get(module)
    if (existing) return existing

    const filePath = join(this.options.dataDir, moduleFileName(module))
    let loadInfo = this.loadFromDisk(module, filePath)
    let file: ModuleFile<BaseRecord> = loadInfo.file

    /** 把当前内存内容写盘（写入前刷新 updatedAt） */
    const writeToDisk = (): void => {
      // 越界防线（PRD K3）：真正写之前校验一次，不允许写到应用根之外
      if (this.options.allowedRoot !== undefined && !isInsideRoot(this.options.allowedRoot, filePath)) {
        throw new Error(
          `拒绝写入应用根之外的路径：${filePath}（允许范围：${this.options.allowedRoot}）`
        )
      }
      file = { ...file, updatedAt: new Date().toISOString() }
      const content = JSON.stringify(file, null, 2)
      if (this.options.writeImpl) this.options.writeImpl(filePath, content)
      else writeFileAtomic(filePath, content)
    }

    const writer = createDebouncedWriter({
      delayMs: this.options.writeDelayMs ?? 300,
      maxDelayMs: this.options.maxDelayMs ?? 2000,
      write: () => writeToDisk(),
      onError: (error) => this.options.onWriteError?.(module, error)
    })
    this.writers.set(module, writer)

    // 对象字面量里的方法，其 this 指向字面量本身而不是 DataStore 实例，
    // 因此先把实例存下来，供 reload() 调用加载逻辑。
    const instance = this

    const store: ModuleStore = {
      module,
      filePath,

      all: () => clone(file.records) as RecordData[],
      list: () => clone(aliveRecords(file.records)) as RecordData[],
      byId: (id) => clone(file.records.find((record) => record.id === id)) as RecordData | undefined,

      add(record) {
        const timestamp = new Date().toISOString()
        const created = {
          ...record,
          id: typeof record['id'] === 'string' ? (record['id'] as string) : generateId(),
          createdAt: typeof record['createdAt'] === 'string' ? (record['createdAt'] as string) : timestamp,
          updatedAt: timestamp
        } as BaseRecord
        file = { ...file, records: [...file.records, created] }
        writer.schedule()
        return clone(created) as RecordData
      },

      update(id, patch) {
        const index = file.records.findIndex((record) => record.id === id)
        if (index < 0) return undefined
        const current = file.records[index] as BaseRecord
        const next = {
          ...current,
          ...patch,
          id: current.id,
          createdAt: current.createdAt,
          updatedAt: new Date().toISOString()
        } as BaseRecord
        const records = [...file.records]
        records[index] = next
        file = { ...file, records }
        writer.schedule()
        return clone(next) as RecordData
      },

      remove(id, removeOptions) {
        const index = file.records.findIndex((record) => record.id === id)
        if (index < 0) return false
        if (removeOptions?.hard) {
          file = { ...file, records: file.records.filter((record) => record.id !== id) }
        } else {
          const current = file.records[index] as BaseRecord
          const timestamp = new Date().toISOString()
          const records = [...file.records]
          records[index] = { ...current, deletedAt: timestamp, updatedAt: timestamp }
          file = { ...file, records }
        }
        writer.schedule()
        return true
      },

      reload() {
        writer.cancel()
        loadInfo = instance.loadFromDisk(module, filePath)
        file = loadInfo.file
        return loadInfo
      },

      discardPendingWrites() {
        writer.cancel()
      },

      flush: () => {
        writer.flush()
      },
      writeNow: () => {
        writeToDisk()
      },
      hasPendingWrites: () => writer.hasPending(),
      loadInfo: () => loadInfo
    }

    this.modules.set(module, store)
    return store
  }

  /** 把所有模块的待写内容立即落盘（程序退出前必须调用） */
  flushAll(): void {
    for (const writer of this.writers.values()) writer.flush()
  }

  /** 是否有任何未落盘的改动 */
  hasPendingWrites(): boolean {
    for (const writer of this.writers.values()) {
      if (writer.hasPending()) return true
    }
    return false
  }

  /** 主动加载某模块（启动自检用） */
  load(module: DataModule): RecoveryResult {
    return this.module(module).loadInfo()
  }

  /** 从磁盘加载一个模块（reload 流程也要用，因此不是私有方法） */
  loadFromDisk(module: DataModule, filePath: string): RecoveryResult {
    const backupFile = `${filePath}.bak`
    const hasMain = existsSync(filePath)
    const hasBackup = existsSync(backupFile)

    // 主文件与备份副本都不存在，才算真正的"首次使用"
    if (!hasMain && !hasBackup) {
      return {
        module,
        status: 'fresh',
        file: createEmptyModuleFile(module) as ModuleFile<BaseRecord>,
        applied: [],
        message: '首次使用，已创建空数据'
      }
    }

    const result = recoverModuleFile({
      filePath,
      module,
      // 主文件与备份副本都必须"按路径直读"：
      // 只有这样才能分辨"主文件本身是好的"与"主文件没了、内容其实来自备份"。
      read: (path) => {
        if (!existsSync(path)) return null
        try {
          return readFileSync(path, 'utf8')
        } catch {
          return null
        }
      },
      normalize: (input, target) => normalizeModuleFile(input, target)
    })

    if (result.status === 'recovered-from-backup') {
      this.options.onRecovered?.(module, result)
    }
    return result
  }
}

/** 深拷贝（数据都是纯 JSON，structuredClone 足够且安全） */
function clone<T>(value: T): T {
  if (value === undefined || value === null) return value
  return structuredClone(value)
}
