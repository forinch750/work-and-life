/**
 * 数据文件格式与迁移（DEVPLAN 阶段 1 / PRD §7.2）
 *
 * 每个模块一个文件，统一信封格式，带格式版本号：
 *   { formatVersion, module, updatedAt, records: [...] }
 *
 * 版本号的作用：以后结构变了，老数据能被自动升级，不会出现"新版读不了旧数据"。
 */
import type { DataModule } from '../../shared/modules'
import { DATA_MODULES } from '../../shared/modules'
import { resourceToNode } from '../../shared/learning'

/**
 * 每个模块各自的当前格式版本（**按模块取用，不共用一个大版本号**）。
 *
 * 为什么按模块分：每个数据文件里存的是**它自己的** `formatVersion`，
 * 而"结构变没变"是各模块自己的事。共用一个数字会逼着没动过的模块
 * 跟着假升级，迁移表也不再能如实反映"哪个模块改过结构"。
 *
 * 任何影响结构（字段增删改、语义改写）的改动都要：
 *   1. 把它自己那一项 +1
 *   2. 在 migrations[模块][新版本号] 注册迁移
 *   3. 补迁移单测（幂等 / 不丢字段 / 不丢内容）
 *
 * v2（第 01 块）：
 *   - learning：新增 kind:'node' 树节点，并把旧 resource 转成树的根节点（**唯一需要改写数据的模块**）
 *   - plan / reading / memo / review / app：只加可选字段，旧记录**一个字节都不动**
 *     （新增字段一律由各模块的 normalizeXxx 补安全默认值）
 */
export const MODULE_FORMAT_VERSIONS: Record<DataModule, number> = {
  app: 2,
  plan: 2,
  learning: 2,
  review: 2,
  reading: 2,
  memo: 2
}

/**
 * 全部模块里最高的格式版本，供"整包导出"这类没有单一模块语境的场合使用。
 * 单个数据文件请用 moduleFormatVersion(module)。
 */
export const CURRENT_FORMAT_VERSION = Math.max(...DATA_MODULES.map((module) => MODULE_FORMAT_VERSIONS[module]))

/** 取某个模块当前的格式版本 */
export function moduleFormatVersion(module: DataModule): number {
  return MODULE_FORMAT_VERSIONS[module]
}

/** 每条记录的公共字段 */
export interface BaseRecord {
  id: string
  createdAt: string
  updatedAt: string
  /** 软删除标记：能标记就不真删，便于在备份里找回 */
  deletedAt?: string
}

/** 一个模块的数据文件内容 */
export interface ModuleFile<T extends BaseRecord = BaseRecord> {
  formatVersion: number
  module: DataModule
  updatedAt: string
  records: T[]
}

export interface MigrationResult {
  file: ModuleFile
  /** 实际执行过的迁移步骤描述（从 v1 到 v2 之类） */
  applied: string[]
  /**
   * 在某一步迁移里失败了（该步抛错）。
   * 这时**不继续**往上升级、也**不把版本号报成最新**——
   * 否则调用方会把"没迁完的数据"当成最新版本写回磁盘，旧结构就此被固化。
   * 记录仍原样返回，由调用方决定是报警还是从备份恢复。
   */
  failed?: { version: number; message: string }
}

export type Migration = (file: ModuleFile) => ModuleFile

/**
 * 迁移表：模块 → 版本号 → 把 n-1 版升级到 n 版的函数。
 * 例如 plan 模块将来从 v1 升到 v2，就注册 migrations.plan[2]。
 */
export const migrations: Record<string, Record<number, Migration>> = {}

/**
 * ---- learning v1 → v2：旧 `resource` 转成树的根级节点 ----
 *
 * 这是本轮**唯一真正改写数据**的迁移（其余模块只加可选字段，旧值一律不动，
 * 因此不需要注册迁移函数——`normalizeModuleFile` 会标成"无结构变化"并推进版本号）。
 *
 * 逐条对照 `MASTER.md` §9.5 / `docs\TASKS\01` §5.2：
 *   name → title ｜ progress → note ｜ percent → percent（占比，保留）
 *   type → resourceType ｜ id / createdAt → 保留 ｜ parentId → null ｜ order 按原顺序
 *
 * 三条纪律：
 *   - **幂等**：已经是 `kind:'node'` 的记录原样返回 → 再跑一次没有任何变化
 *   - **不丢字段**：`resourceToNode` 先把原记录整条铺开再覆盖要改的键
 *   - **不留双轨**：转完这个模块里不再有 `kind:'resource'` 记录，
 *     所以不会出现"既有 resource 又有对应 node"的半树半平状态
 */
export function migrateLearningToV2(file: ModuleFile): ModuleFile {
  /** order 按"每个主题各自的下标"递增——同级排序以它为唯一权威（见 tree.ts） */
  const nextOrder = new Map<string, number>()

  const records = file.records.map((record) => {
    const raw = record as unknown as Record<string, unknown>
    if (raw['kind'] !== 'resource') return record

    const ownerId = String(raw['topicId'] ?? '')
    const order = nextOrder.get(ownerId) ?? 0
    nextOrder.set(ownerId, order + 1)
    return resourceToNode(raw, order) as unknown as BaseRecord
  })

  return { ...file, records, updatedAt: new Date().toISOString() }
}

/** 判断一个值是不是普通对象（非数组、非 null） */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * 把任意输入规范成 ModuleFile 结构，并逐级执行迁移。
 * 传入的数据可能来自磁盘、也可能是用户手动导入的文件，所以必须宽容对待。
 */
export function normalizeModuleFile(input: unknown, module: DataModule): MigrationResult {
  const applied: string[] = []
  const target = moduleFormatVersion(module)

  if (!isPlainObject(input)) {
    return {
      file: { formatVersion: target, module, updatedAt: new Date().toISOString(), records: [] },
      applied
    }
  }

  const rawVersion = typeof input['formatVersion'] === 'number' ? input['formatVersion'] : 0
  const records = Array.isArray(input['records']) ? (input['records'] as BaseRecord[]) : []
  let file: ModuleFile = {
    formatVersion: rawVersion,
    module,
    updatedAt: typeof input['updatedAt'] === 'string' ? input['updatedAt'] : new Date().toISOString(),
    records
  }

  if (file.formatVersion > target) {
    throw new Error(
      `数据文件版本 ${file.formatVersion} 高于本程序支持的 ${target}（模块 ${module}），请升级程序后再打开`
    )
  }

  // 从当前版本逐级升到最新
  for (let version = file.formatVersion + 1; version <= target; version += 1) {
    const migration = migrations[module]?.[version]
    if (!migration) {
      // 没有对应的迁移函数时，仅推进版本号（结构兼容的情况）
      applied.push(`v${version - 1} → v${version}（无结构变化）`)
      file = { ...file, formatVersion: version }
      continue
    }

    try {
      file = migration(file)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      return {
        file: { ...file, module },
        applied,
        failed: { version, message: `v${version - 1} → v${version} 迁移失败：${message}` }
      }
    }

    file = { ...file, formatVersion: version }
    applied.push(`v${version - 1} → v${version}`)
  }

  return {
    file: { ...file, module, formatVersion: target },
    applied
  }
}

/** 构造一个空的模块文件 */
export function createEmptyModuleFile(module: DataModule): ModuleFile {
  return {
    formatVersion: moduleFormatVersion(module),
    module,
    updatedAt: new Date().toISOString(),
    records: []
  }
}

/** 记录是否"活着"（未被软删除） */
export function isAlive(record: BaseRecord): boolean {
  return record.deletedAt === undefined || record.deletedAt === null
}

/** 从记录数组里取出未删除的部分 */
export function aliveRecords<T extends BaseRecord>(records: T[]): T[] {
  return records.filter(isAlive)
}

// ---------------------------------------------------------------------------
// 迁移注册（按模块）
//
// 只有**真正改写数据**的模块在这里注册；只加可选字段的模块不需要函数，
// normalizeModuleFile 会标成"无结构变化"并推进版本号。
// 注册放在文件末尾：此时 resourceToNode 等依赖都已就绪，也不会形成循环引用。
// ---------------------------------------------------------------------------

migrations['learning'] = { 2: migrateLearningToV2 }
