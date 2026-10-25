/**
 * 快捷键绑定的上下文（第二轮 FEAT-008）
 *
 * 绑定值跟着数据走，存在 `app` 模块的偏好记录里（`preferences.ts` 的 `hotkeys`，
 * 只存"改过的那些"，没改的取默认）。这里把**解析后的完整绑定表**发给整棵树：
 *   - `App.tsx` 负责读偏好、写 Provider、注册全局热键
 *   - 页面只通过 `useHotkeyBindings()` 取值，**不自己读第二份偏好**
 *     （05 块踩过"两处各读一份、改一处不生效"，别再来一次）
 *
 * 为什么不把绑定放 localStorage：偏好必须**跟着数据走**——
 * 整个数据文件夹拷到另一台电脑，快捷键习惯也跟着过去（见 `shared/preferences.ts` 文件头）。
 */
import { createContext, useContext } from 'react'
import { DEFAULT_HOTKEYS, type HotkeyAction } from '../../shared/preferences'

/** 完整绑定表：每个动作都有值（默认值打底，用户改过的覆盖上去） */
export type HotkeyBindings = Record<HotkeyAction, string>

export const HotkeyBindingsContext = createContext<HotkeyBindings>({ ...DEFAULT_HOTKEYS })

/** 取当前生效的绑定表 */
export function useHotkeyBindings(): HotkeyBindings {
  return useContext(HotkeyBindingsContext)
}
