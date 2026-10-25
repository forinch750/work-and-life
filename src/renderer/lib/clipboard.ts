/**
 * 剪贴板（第 03 块菜单里的"复制"用）
 *
 * 为什么单独一小步：`navigator.clipboard` 在"写入"这一侧可能被浏览器拒绝
 * （非安全上下文、窗口没有焦点、用户没授权）。复制失败**不该把菜单点崩**，
 * 所以这里统一兜底成"返回是否成功"，由调用方决定提示什么。
 *
 * 这里**只写本地剪贴板**，不发起任何网络请求，也不碰 `process.env`。
 */
export async function copyText(text: string): Promise<boolean> {
  const value = text.trim()
  if (value === '') return false
  try {
    const clipboard = (globalThis as { navigator?: { clipboard?: { writeText?: (t: string) => Promise<void> } } })
      .navigator?.clipboard
    if (clipboard?.writeText !== undefined) {
      await clipboard.writeText(value)
      return true
    }
  } catch {
    /* 落到下面的兜底 */
  }
  // 兜底：老式 execCommand（本地 Electron 里可用）。同样可能失败，失败就如实返回 false
  try {
    const area = document.createElement('textarea')
    area.value = value
    area.setAttribute('readonly', 'readonly')
    area.style.position = 'fixed'
    area.style.opacity = '0'
    document.body.appendChild(area)
    area.select()
    const ok = document.execCommand('copy')
    document.body.removeChild(area)
    return ok
  } catch {
    return false
  }
}
