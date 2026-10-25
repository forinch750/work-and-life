/**
 * 导出与导入（DEVPLAN 阶段 1 / PRD §7.4）
 *
 * 规则：
 *   - 导出：把所有模块打包成一个带版本号的 JSON 文件，可拷到 U 盘或另一台电脑
 *   - 导入：先自动备份当前数据，再按用户选择"合并"或"覆盖"，绝不静默覆盖
 *   - 合并策略：逐条比对 updatedAt，新的胜出；两边都没有的记录各自保留
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { DataModule } from '../../shared/modules'
import { DATA_MODULES, moduleFileName } from '../../shared/modules'
import { writeFileAtomic } from './atomic'
import { runDailyBackup, type BackupResult } from './backup'
import { CURRENT_FORMAT_VERSION, normalizeModuleFile, type BaseRecord, type ModuleFile } from './format'

/** 导出文件里单个模块的内容，保留完整信封信息以便将来迁移 */
export interface ExportModulePayload {
  formatVersion: number
  updatedAt: string
  records: unknown[]
}

export interface ExportBundle {
  kind: 'work-life-export'
  bundleVersion: number
  formatVersion: number
  exportedAt: string
  appVersion: string
  modules: Partial<Record<DataModule, ExportModulePayload>>
}

export const CURRENT_BUNDLE_VERSION = 1

/** 校验一个对象是不是本程序导出的合法数据包 */
export function validateBundle(input: unknown): { ok: true; bundle: ExportBundle } | { ok: false; reason: string } {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    return { ok: false, reason: '文件内容不是一个对象' }
  }
  const bundle = input as Partial<ExportBundle>
  if (bundle.kind !== 'work-life-export') {
    return { ok: false, reason: '这不是本程序导出的数据文件（缺少标识）' }
  }
  if (typeof bundle.bundleVersion !== 'number') {
    return { ok: false, reason: '缺少 bundleVersion' }
  }
  if (bundle.bundleVersion > CURRENT_BUNDLE_VERSION) {
    return {
      ok: false,
      reason: `数据包版本 ${bundle.bundleVersion} 高于本程序支持的 ${CURRENT_BUNDLE_VERSION}，请升级程序`
    }
  }
  if (typeof bundle.modules !== 'object' || bundle.modules === null) {
    return { ok: false, reason: '缺少 modules 内容' }
  }
  for (const [name, payload] of Object.entries(bundle.modules)) {
    if (!(DATA_MODULES as readonly string[]).includes(name)) continue
    if (typeof payload !== 'object' || payload === null) {
      return { ok: false, reason: `模块 ${name} 的内容不是对象` }
    }
    if (!Array.isArray((payload as ExportModulePayload).records)) {
      return { ok: false, reason: `模块 ${name} 的 records 不是数组` }
    }
  }
  return { ok: true, bundle: bundle as ExportBundle }
}

export interface ExportOptions {
  dataDir: string
  targetFile: string
  appVersion: string
  now?: () => Date
}

export interface ExportResult {
  file: string
  bytes: number
  recordCount: number
  moduleCount: number
}

/** 导出全部数据到一个文件 */
export function exportAllData(options: ExportOptions): ExportResult {
  const now = (options.now ?? (() => new Date()))()
  const modules: Partial<Record<DataModule, ExportModulePayload>> = {}
  let recordCount = 0
  let moduleCount = 0

  for (const module of DATA_MODULES) {
    const filePath = join(options.dataDir, moduleFileName(module))
    if (!existsSync(filePath)) continue
    try {
      const normalized = normalizeModuleFile(JSON.parse(readFileSync(filePath, 'utf8')), module)
      modules[module] = {
        formatVersion: normalized.file.formatVersion,
        updatedAt: normalized.file.updatedAt,
        records: normalized.file.records
      }
      recordCount += normalized.file.records.length
      moduleCount += 1
    } catch {
      // 某个模块读不出来时不能整体失败，但要如实反映在 moduleCount 里
    }
  }

  const bundle: ExportBundle = {
    kind: 'work-life-export',
    bundleVersion: CURRENT_BUNDLE_VERSION,
    formatVersion: CURRENT_FORMAT_VERSION,
    exportedAt: now.toISOString(),
    appVersion: options.appVersion,
    modules
  }

  mkdirSync(dirname(options.targetFile), { recursive: true })
  const content = JSON.stringify(bundle, null, 2)
  writeFileSync(options.targetFile, content, 'utf8')

  return {
    file: options.targetFile,
    bytes: Buffer.byteLength(content, 'utf8'),
    recordCount,
    moduleCount
  }
}

export type ImportMode = 'merge' | 'replace'

export interface ImportOptions {
  /** 被导入的导出文件 */
  sourceFile: string
  dataDir: string
  backupDir: string
  mode: ImportMode
  now?: () => Date
  /** 导入前自动备份的结果回调（用于向用户展示"已先备份"） */
  onBackup?: (result: BackupResult) => void
  /**
   * 某个模块写盘后的回调。
   * 数据仓的内存副本在导入后已经过期，必须在这里重新加载，
   * 否则界面上的数据会与磁盘不一致。
   */
  onModuleWritten?: (module: DataModule) => void
}

export interface ImportResult {
  mode: ImportMode
  /** 导入前的自动备份 */
  backup: BackupResult
  perModule: Array<{ module: DataModule; incoming: number; kept: number; total: number }>
  recordCount: number
  message: string
}

/** 合并两条记录：updatedAt 较新的胜出 */
export function pickNewer(a: BaseRecord, b: BaseRecord): BaseRecord {
  const aTime = Date.parse(a.updatedAt ?? '') || 0
  const bTime = Date.parse(b.updatedAt ?? '') || 0
  return bTime > aTime ? b : a
}

/** 按 id 合并两组记录 */
export function mergeRecords(
  current: BaseRecord[],
  incoming: BaseRecord[]
): { records: BaseRecord[]; kept: number } {
  const byId = new Map<string, BaseRecord>()
  for (const record of current) byId.set(record.id, record)
  let kept = 0
  for (const record of incoming) {
    const existing = byId.get(record.id)
    if (!existing) {
      byId.set(record.id, record)
      continue
    }
    const winner = pickNewer(existing, record)
    byId.set(record.id, winner)
    if (winner === existing) kept += 1
  }
  return { records: [...byId.values()], kept }
}

/** 导入数据包 */
export function importAllData(options: ImportOptions): ImportResult {
  const now = (options.now ?? (() => new Date()))()

  const raw = readFileSync(options.sourceFile, 'utf8')
  const validation = validateBundle(JSON.parse(raw))
  if (!validation.ok) throw new Error(`导入失败：${validation.reason}`)
  const bundle = validation.bundle

  // 1) 先自动备份当前数据，绝不静默覆盖
  const backup = runDailyBackup({
    dataDir: options.dataDir,
    backupDir: options.backupDir,
    now: () => now
  })
  options.onBackup?.(backup)

  // 2) 逐模块写入
  const perModule: ImportResult['perModule'] = []
  let total = 0

  for (const module of DATA_MODULES) {
    const payload = bundle.modules[module]
    if (!payload) continue

    const normalized = normalizeModuleFile(
      { formatVersion: payload.formatVersion, records: payload.records, updatedAt: payload.updatedAt },
      module
    )
    const incoming = normalized.file.records
    const filePath = join(options.dataDir, moduleFileName(module))

    let records = incoming
    let kept = 0

    if (options.mode === 'merge' && existsSync(filePath)) {
      try {
        const currentFile = normalizeModuleFile(JSON.parse(readFileSync(filePath, 'utf8')), module)
        const merged = mergeRecords(currentFile.file.records, incoming)
        records = merged.records
        kept = merged.kept
      } catch {
        // 当前文件坏了就以导入内容为准
        records = incoming
      }
    }

    const file: ModuleFile = {
      formatVersion: CURRENT_FORMAT_VERSION,
      module,
      updatedAt: now.toISOString(),
      records
    }
    writeFileAtomic(filePath, JSON.stringify(file, null, 2))
    options.onModuleWritten?.(module)

    perModule.push({ module, incoming: incoming.length, kept, total: records.length })
    total += records.length
  }

  const modeLabel = options.mode === 'merge' ? '合并' : '覆盖'
  return {
    mode: options.mode,
    backup,
    perModule,
    recordCount: total,
    message: `已按"${modeLabel}"导入 ${perModule.length} 个模块，共 ${total} 条记录`
  }
}
