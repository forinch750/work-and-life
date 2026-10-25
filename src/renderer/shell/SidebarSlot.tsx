/**
 * 侧栏中段的"当前模块条目列表"挂载点（第 08 块）
 *
 * `TASKS\08` §5.1 的骨架里，左栏从上到下是：
 *   日期 / 导航（固定） → **中间列表（自己滚）** → 搜索 + 数据与设置（固定）
 *
 * 中间那一段的内容是**每个模块自己的**（学习是主题、读书是书、复习是主题+书…），
 * 但外壳不该认识任何一个模块的数据形状。所以这里用 portal 把它翻过来：
 * 外壳只提供一个空的容器节点，**模块页面自己把列表塞进去**。
 *
 * 这样做的三个好处（09/10/11 直接复用，别再各写一套）：
 *   1. 页面的选中状态、点击行为、数据读取**都留在页面里**，外壳不用跟着改；
 *   2. 列表的 DOM 跑到了侧栏里，但 React 树没变——`data-testid` 全都不变，
 *      既有验收（`[data-testid="learning-topic"]` 之类）不用改一行；
 *   3. 页面卸载时 portal 跟着卸载，不会在侧栏里留下上一个模块的条目。
 *
 * 用法（学习页就是这样用的）：
 * ```tsx
 * <SidebarListPortal>
 *   <div className="sidebar-list" data-testid="learning-topics">…</div>
 * </SidebarListPortal>
 * ```
 */
import { createContext, useContext, type ReactNode, type ReactPortal } from 'react'
import { createPortal } from 'react-dom'

/** 侧栏中段那个容器的 DOM 节点；还没挂上时是 null */
export const SidebarListTargetContext = createContext<HTMLElement | null>(null)

/** 把内容渲染到侧栏中段（没有容器时什么都不渲染，页面照常工作） */
export function SidebarListPortal({ children }: { children: ReactNode }): ReactPortal | null {
  const target = useContext(SidebarListTargetContext)
  if (target === null) return null
  return createPortal(children, target)
}
