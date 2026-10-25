/**
 * 启动自检与恢复（DEVPLAN 阶段 1 / PRD §7.3）
 *
 * 顺序：
 *   1. 读主文件 → 解析 → 迁移 → 校验，通过就用它
 *   2. 失败 → 读 .bak → 通过则用，并明确告知"已从备份副本恢复"
 *   3. 都失败 → 返回空数据 + corrupted 状态，由上层报警并提示用户从 backups\ 恢复
 *
 * 绝不允许静默丢数据。
 */
import { createEmptyModuleFile, normalizeModuleFile, type BaseRecord, type ModuleFile, type MigrationResult } from './format'
import type { DataModule } from '../../shared/modules'

export type RecoveryStatus = 'ok' | 'recovered-from-backup' | 'fresh' | 'corrupted' | 'migrated'

export interface RecoveryResult {
  module: DataModule
  status: RecoveryStatus
  file: ModuleFile<BaseRecord>
  /** 执行过的迁移步骤 */
  applied: string[]
  /** 面向用户的中文说明 */
  message: string
  /** 出错时的原因 */
  error?: string
}

export interface RecoverOptions {
  filePath: string
  module: DataModule
  /**
   * 读取"指定路径"的原始内容；文件不存在时返回 null。
   * 注意：这里必须是纯粹的按路径读取，不能带回退逻辑，
   * 否则无法区分"主文件正常"和"主文件缺失、内容来自备份"。
   */
  read: (filePath: string) => string | null
  /** 规范化 + 迁移（可注入，默认用真实的 normalizeModuleFile） */
  normalize?: (input: unknown, module: DataModule) => MigrationResult
}

/** 记录集里是否出现了明显的结构错误（例如不是对象、缺 id） */
export function validateRecords(records: unknown): string | null {
  if (!Array.isArray(records)) return 'records 不是数组'
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index]
    if (typeof record !== 'object' || record === null || Array.isArray(record)) {
      return `第 ${index + 1} 条记录不是对象`
    }
    const id = (record as Record<string, unknown>)['id']
    if (typeof id !== 'string' || id === '') {
      return `第 ${index + 1} 条记录缺少 id`
    }
  }
  return null
}

export function recoverModuleFile(options: RecoverOptions): RecoveryResult {
  const { filePath, module } = options
  const normalize = options.normalize ?? normalizeModuleFile

  const primaryRaw = options.read(filePath)
  const primary = tryParse(primaryRaw, module, normalize)

  if (primary.ok) {
    // 主文件缺失但备份副本可用 —— 这是"恢复"，必须如实报告，不能悄悄当成正常
    if (primaryRaw === null) {
      return {
        module,
        status: 'recovered-from-backup',
        file: primary.file,
        applied: primary.applied,
        message: '主文件不存在，已从备份副本恢复',
        error: '主文件不存在'
      }
    }

    // 迁移过就单独标一个状态，便于日志里能看出"这次启动升级了老数据"
    if (primary.applied.length > 0) {
      return {
        module,
        status: 'migrated',
        file: primary.file,
        applied: primary.applied,
        message: `数据已从旧版本升级：${primary.applied.join('、')}`
      }
    }
    return {
      module,
      status: 'ok',
      file: primary.file,
      applied: [],
      message: '数据完整'
    }
  }

  // 主文件不可用 → 尝试备份副本
  const backupRaw = options.read(`${filePath}.bak`)
  const backup = tryParse(backupRaw, module, normalize)

  if (backup.ok) {
    return {
      module,
      status: 'recovered-from-backup',
      file: backup.file,
      applied: backup.applied,
      message: `主文件无法读取（${primary.error}），已从备份副本恢复`,
      error: primary.error
    }
  }

  // 两份都不可用
  if (primaryRaw === null && backupRaw === null) {
    return {
      module,
      status: 'fresh',
      file: createEmptyModuleFile(module) as ModuleFile<BaseRecord>,
      applied: [],
      message: '没有找到数据文件，已按空数据启动'
    }
  }

  return {
    module,
    status: 'corrupted',
    file: createEmptyModuleFile(module) as ModuleFile<BaseRecord>,
    applied: [],
    message: `数据文件与备份副本都损坏了（${primary.error}），已按空数据启动，请从 backups\\ 目录恢复`,
    error: primary.error
  }
}

interface ParseOutcome {
  ok: boolean
  file: ModuleFile<BaseRecord>
  applied: string[]
  error?: string
}

function tryParse(
  raw: string | null,
  module: DataModule,
  normalize: (input: unknown, module: DataModule) => MigrationResult
): ParseOutcome {
  const empty: ModuleFile<BaseRecord> = createEmptyModuleFile(module) as ModuleFile<BaseRecord>

  if (raw === null || raw.trim() === '') {
    return { ok: false, file: empty, applied: [], error: '内容为空' }
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (error) {
    return {
      ok: false,
      file: empty,
      applied: [],
      error: `JSON 解析失败：${error instanceof Error ? error.message : String(error)}`
    }
  }

  const recordsError = validateRecords((parsed as Record<string, unknown>)?.['records'])
  if (recordsError) {
    return { ok: false, file: empty, applied: [], error: recordsError }
  }

  try {
    const result = normalize(parsed, module)
    const postError = validateRecords(result.file.records)
    if (postError) {
      return { ok: false, file: empty, applied: [], error: `迁移后校验失败：${postError}` }
    }
    return { ok: true, file: result.file as ModuleFile<BaseRecord>, applied: result.applied }
  } catch (error) {
    return {
      ok: false,
      file: empty,
      applied: [],
      error: error instanceof Error ? error.message : String(error)
    }
  }
}
