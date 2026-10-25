/**
 * 路径解析（DEVPLAN 阶段 0/1）
 *
 * 红线：本程序产生的所有文件都住在应用根目录内（默认 D:\工作生活\）。
 * 绝不向系统盘、用户目录、WSL/Linux 路径写入任何东西。
 */
import { mkdirSync } from 'node:fs'
import { resolve } from 'node:path'

export interface DataPaths {
  /** 应用根目录 */
  root: string
  /** data\ —— 各模块 JSON 数据文件 */
  data: string
  /** backups\ —— 每日备份 */
  backups: string
  /** logs\ —— 启动与错误日志 */
  logs: string
  /** 主日志文件 */
  logFile: string
  /** 端口快照目录（隔离复验用） */
  diagnostics: string
  /**
   * exports\ —— 导出的数据副本。
   *
   * 与 backups\ 的区别：backups\ 是程序自己按时做的每日备份，
   * exports\ 是人主动作留下的（清空前的"后悔药"、手动导出的文件）。
   * 两者职责不同，故意不混放——否则日后分不清某份文件是哪来的。
   *
   * 为什么不再写桌面：以前"清空前备份"直接写系统桌面，
   * 每跑一次验收就往真实桌面丢一份（实测攒了 40 个）。
   */
  exports: string
}

export interface ResolveDataPathsOptions {
  /** 显式指定应用根目录（测试用） */
  appRoot: string
}

export function resolveDataPaths(options: ResolveDataPathsOptions): DataPaths {
  const root = resolve(options.appRoot)
  const data = resolve(root, 'data')
  const logs = resolve(root, 'logs')
  return {
    root,
    data,
    backups: resolve(root, 'backups'),
    logs,
    logFile: resolve(logs, 'app.log'),
    diagnostics: resolve(logs, 'diagnostics'),
    exports: resolve(root, 'exports')
  }
}

/** 确保所有运行期目录存在（幂等） */
export function ensureDataDirs(paths: DataPaths): void {
  for (const dir of [paths.data, paths.backups, paths.logs, paths.diagnostics, paths.exports]) {
    mkdirSync(dir, { recursive: true })
  }
}

/** 判断某个路径是否落在应用根目录内（越界写入的防线） */
export function isInsideRoot(root: string, target: string): boolean {
  const normalizedRoot = resolve(root).replace(/[\\/]+$/, '').toLowerCase()
  const normalizedTarget = resolve(target).toLowerCase()
  return normalizedTarget === normalizedRoot || normalizedTarget.startsWith(normalizedRoot + '\\')
}
