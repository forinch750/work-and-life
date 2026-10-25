/**
 * 模块标识（主进程与界面共用）
 *
 * 新增模块时在这里加一项，数据文件名随之确定。
 */
export const DATA_MODULES = [
  'app',
  'plan',
  'learning',
  'review',
  'reading',
  'memo'
] as const

export type DataModule = (typeof DATA_MODULES)[number]

export function isDataModule(value: string): value is DataModule {
  return (DATA_MODULES as readonly string[]).includes(value)
}

/** 模块 → 数据文件名 */
export function moduleFileName(module: DataModule): string {
  return `${module}.json`
}
