/**
 * 把"自增的数字信号"变成一次回调（第二轮 FEAT-008 的 `N` / `T` 用）。
 *
 * 为什么不直接把键盘监听放进每个页面：
 *   - 单键热键必须**按当前页面**分发（`N` 在复习页不注册，决定 29），
 *     这件事只有"知道当前是哪个页面"的 `App.tsx` 能做。
 *   - 页面只该回答"给我一次新建信号，我打开什么"，不该关心用户按的是哪个键、
 *     也不该关心这个键有没有被用户改过。
 *
 * 三条细节都是为了"别误触发"：
 *   1. 信号没变不触发（重渲染时 `signal` 不变 → 什么都不做）
 *   2. 初始值不触发（页面首次挂载时 `signal` 是 0，不会凭空弹出一个表单）
 *   3. 回调走 ref：真实动作每次渲染都是新函数，但它不该让信号"重新触发"一次
 */
import { useEffect, useRef } from 'react'

export function useSignal(signal: number | undefined, handler: () => void): void {
  const handlerRef = useRef(handler)
  handlerRef.current = handler
  const lastRef = useRef(signal ?? 0)

  useEffect(() => {
    const next = signal ?? 0
    if (next === lastRef.current) return
    lastRef.current = next
    handlerRef.current()
  }, [signal])
}
