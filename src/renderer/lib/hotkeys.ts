/**
 * 热键框架（PRD §2.5 / DEVPLAN 阶段 2）
 *
 * 已确认的取舍：
 *   - 单键热键（如 N）在输入框里必须失效，否则打字时会误触发
 *   - 组合键（Ctrl+K / Ctrl+Alt+M / Esc）任何情况下都生效
 */
import { useEffect, useRef } from 'react'

export interface HotkeySpec {
  /** 组合键写法，例如 'ctrl+k'、'ctrl+alt+m'、'escape'、'n' */
  combo: string
  handler: (event: KeyboardEvent) => void
  /**
   * 单键热键在输入框内是否也生效，默认 false（不生效，避免打字误触）。
   * 组合键不受此限制。
   */
  allowInInput?: boolean
  /** 是否 preventDefault，默认 true */
  preventDefault?: boolean
}

/** 把键盘事件归一化成 'ctrl+alt+m' 这样的组合键字符串 */
export function comboFromEvent(event: KeyboardEvent): string {
  const parts: string[] = []
  if (event.ctrlKey) parts.push('ctrl')
  if (event.altKey) parts.push('alt')
  if (event.shiftKey) parts.push('shift')
  if (event.metaKey) parts.push('meta')

  const key = event.key
  if (key === ' ' || key === 'Spacebar') parts.push('space')
  else if (key === 'Esc' || key === 'Escape') parts.push('escape')
  else if (key === 'Enter') parts.push('enter')
  else if (key.length === 1) parts.push(key.toLowerCase())
  else parts.push(key.toLowerCase())

  return parts.join('+')
}

/** 组合键里是否包含修饰键 */
export function hasModifier(combo: string): boolean {
  return /(^|\+)(ctrl|alt|shift|meta)(\+|$)/.test(combo)
}

/** 事件目标是否落在"正在输入"的元素里。参数取 unknown，便于用普通对象做测试。 */
export function isTypingTarget(target: unknown): boolean {
  if (target === null || typeof target !== 'object') return false
  const candidate = target as { tagName?: unknown; isContentEditable?: unknown }
  const tag = typeof candidate.tagName === 'string' ? candidate.tagName.toLowerCase() : ''
  if (tag === 'input' || tag === 'textarea' || tag === 'select') return true
  return candidate.isContentEditable === true
}

/**
 * 从一组热键里挑出这次按键该触发哪一个（没有就是 null）。
 *
 * 抽成纯函数是为了让"**单键在输入框里失效、组合键不受限**"这条规定可以被单测钉住
 * ——写成 hook 内部的一行 `continue` 时，没有任何测试能直接覆盖它，
 * 而这恰恰是"打字时按 n 突然新建了一条"的根源。
 *
 * 规则：
 *   - 组合键（带修饰键）任何情况下都生效
 *   - 单键默认在输入框 / contentEditable 里**不生效**；除非该条显式写了 `allowInInput`
 *   - 有多个 spec 命中同一个组合键时，**按传入顺序取第一个**（注册顺序即优先级）
 */
export function matchHotkey(
  specs: HotkeySpec[],
  combo: string,
  target: unknown
): HotkeySpec | null {
  for (const spec of specs) {
    if (spec.combo !== combo) continue
    const singleKey = !hasModifier(spec.combo)
    if (singleKey && spec.allowInInput !== true && isTypingTarget(target)) continue
    return spec
  }
  return null
}

/**
 * 注册一组热键。
 * 传入的 specs 每次渲染都会变，因此用 ref 持有最新的处理函数，只注册一次监听。
 */
export function useHotkeys(specs: HotkeySpec[]): void {
  const specsRef = useRef(specs)
  specsRef.current = specs

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      const combo = comboFromEvent(event)
      const spec = matchHotkey(specsRef.current, combo, event.target)
      if (spec === null) return
      if (spec.preventDefault !== false) event.preventDefault()
      spec.handler(event)
    }

    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [])
}
