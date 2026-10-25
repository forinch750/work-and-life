/**
 * 主题（PRD §2.9）
 *
 * 取值：跟随系统 / 浅色 / 深色。
 * 实现方式：在 <html> 上写 data-theme，具体颜色由 theme.css 的变量决定。
 */
export type ThemePreference = 'system' | 'light' | 'dark'

export const THEME_STORAGE_KEY = 'worklife.theme'

export function isThemePreference(value: unknown): value is ThemePreference {
  return value === 'system' || value === 'light' || value === 'dark'
}

/** 把主题偏好应用到文档根节点 */
export function applyTheme(theme: ThemePreference): void {
  const root = document.documentElement
  if (theme === 'system') root.removeAttribute('data-theme')
  else root.setAttribute('data-theme', theme)
}

/** 读取已保存的主题偏好 */
export function loadTheme(): ThemePreference {
  try {
    const saved = window.localStorage.getItem(THEME_STORAGE_KEY)
    return isThemePreference(saved) ? saved : 'system'
  } catch {
    return 'system'
  }
}

/** 保存主题偏好 */
export function saveTheme(theme: ThemePreference): void {
  try {
    window.localStorage.setItem(THEME_STORAGE_KEY, theme)
  } catch {
    /* 存不进去就用当前会话的即可，不影响使用 */
  }
}
