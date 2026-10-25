/**
 * `Esc` 收起就地面板（2026-10 修订 · 学习页 / 读书页共用）
 *
 * 为什么抽成 hook：两页的收起行为**必须完全一样**（§6.4 第 6 条：
 * 别一个用 `×`、一个用文字）。菜单文本、按钮位置、Esc 都从这两个入口走，
 * 页面里就只剩"传一个面板开着没开"这一件事。
 *
 * ## 三个坑，都踩过或差点踩到
 *
 * 1. **必须挂 window 原生监听，不能用 React 的 `onKeyDown`。**
 *    验收脚本派发的键盘事件是**从 window 出发**的，压根不经过 `#root` 上的
 *    React 事件代理（`ContextMenu.tsx` 里记了同一件事）。
 * 2. **抽屉 / 对话框开着时不能抢。** 它们各自在 window 上听 Esc 关闭自己；
 *    如果面板也一起收，用户"只想关抽屉"结果连面板也没了。
 *    所以先看一眼有没有 `.drawer-layer` / `.dialog-layer`，有就让它们处理。
 * 3. **右键菜单开着时不用管。** `ContextMenu` 在**捕获阶段**就
 *    `stopPropagation`，事件到不了这里的冒泡监听。
 *
 * 为什么要"面板开着才注册"：不注册就没有这条监听，
 * `Esc` 在没开面板时仍然只做它原来那些事（关快速记一笔 / 搜索 / 复习会话）。
 */
import { useEffect, useRef } from 'react'

export function usePanelEscape(open: boolean, collapse: () => void): void {
  // 回调走 ref：页面每次渲染都会给一个新的 `collapse`，但它不该让监听"重新注册"一次
  const collapseRef = useRef(collapse)
  collapseRef.current = collapse

  useEffect(() => {
    if (!open) return
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return
      // 抽屉 / 对话框优先：它们自己会用 Esc 关掉自己
      if (document.querySelector('.drawer-layer') !== null) return
      if (document.querySelector('.dialog-layer') !== null) return
      event.preventDefault()
      collapseRef.current()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [open])
}
