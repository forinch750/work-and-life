/**
 * 通用菜单项定义（第二轮 FEAT-001 的地基）
 *
 * 为什么单独抽一份：现在各页都有自己的 `⋯` 小菜单（任务、备忘……），
 * 菜单项写在各页里。2.2 轮要加"右键菜单"，如果不共用定义，
 * 同一个对象的"⋯ 菜单"与"右键菜单"迟早会不一致——
 * 用户会看到"右键里有删除、⋯ 里没有"这种莫名其妙的差异。
 *
 * 因此：菜单项只定义一次，两种入口复用同一份数组。
 *
 * **五类实体的菜单项定义已经在 `src\shared\contextMenu.ts` 里落地**
 * （`taskMenuItems` / `treeNodeMenuItems` / `bookMenuItems` / `memoMenuItems` / `cardMenuItems`）；
 * 这个文件只保留"渲染要用到的最小结构"与 `disabledFlags`。
 * 新增一个菜单项：改 `contextMenu.ts` 里对应的那一个函数即可，两个入口自动同步。
 */
export interface MenuItemSpec {
  /** 稳定标识，供验收与测试定位 */
  id: string
  label: string
  /** 危险操作（删除、清空），界面上用红字 */
  danger?: boolean
  disabled?: boolean
  /** 可选的右侧提示，例如快捷键 */
  hint?: string
  /**
   * 分组标题（"时段"、"重复"、"设置复习时间"）。
   * 同一组的项共享一个标题，渲染时只在**组里第一项**之前画出标题。
   */
  group?: string
  /** 在这一项**之前**画一条分隔线 */
  separator?: boolean
  onSelect: () => void
}

/** 把菜单项数组转成"哪些被禁用"的布尔数组，供键盘导航使用 */
export function disabledFlags(items: MenuItemSpec[]): boolean[] {
  return items.map((item) => item.disabled === true)
}
