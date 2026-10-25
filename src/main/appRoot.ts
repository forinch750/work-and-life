/**
 * 应用根目录解析（DEVPLAN 阶段 0 / 阶段 7 修订）
 *
 * 运行期数据（data / backups / logs）的落点规则：
 *   1. 设置了环境变量 WORKLIFE_ROOT → 用它（便携模式：数据跟着程序走）
 *   2. 开发态 → 当前工作目录（也就是项目根，方便边开发边看数据）
 *   3. 打包态 → %APPDATA%\工作生活
 *      Windows 对"已安装的程序"就是这样约定的：程序装在 Program Files 之类的位置，
 *      用户数据写在自己的 AppData 下，避免因为程序目录不可写而失败。
 *
 * 注意：主进程由 tsc 编译为 CommonJS，因此这里使用 __dirname 而不是 import.meta。
 */
import { resolve } from 'node:path'

export interface ResolveAppRootOptions {
  /** 是否已打包运行 */
  isPackaged: boolean
  /** 当前工作目录（开发态用） */
  cwd: string
  /** 打包态使用的用户数据目录（通常传 app.getPath('userData') 的父级） */
  packagedRoot?: string
  /** 环境变量覆盖值（最高优先级） */
  envOverride?: string
}

/**
 * 解析应用根目录。
 * 返回值一定是绝对路径。
 */
export function resolveAppRoot(options: ResolveAppRootOptions): string {
  const { isPackaged, cwd, packagedRoot, envOverride } = options
  if (envOverride && envOverride.trim() !== '') return resolve(envOverride.trim())
  if (!isPackaged) return resolve(cwd)
  if (packagedRoot && packagedRoot.trim() !== '') return resolve(packagedRoot)
  // 兜底：拿不到 userData 时退回工作目录，至少不会写到奇怪的地方
  return resolve(cwd)
}

/** 在 Electron 运行时下求当前应用根目录 */
export function currentAppRoot(isPackaged: boolean, userDataDir?: string): string {
  return resolveAppRoot({
    isPackaged,
    cwd: process.cwd(),
    packagedRoot: userDataDir,
    envOverride: process.env['WORKLIFE_ROOT']
  })
}
