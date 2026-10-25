/**
 * 阶段 2 测试：热键框架
 *
 * 对应 PRD C4 / C5 / C6 与"输入框里按 N 不误触发"这条额外验收。
 */
import { describe, expect, it } from 'vitest'
import { comboFromEvent, hasModifier, isTypingTarget } from '../../src/renderer/lib/hotkeys'

/** 造一个最小的 KeyboardEvent 替身 */
function fakeKey(
  key: string,
  modifiers: { ctrl?: boolean; alt?: boolean; shift?: boolean; meta?: boolean } = {}
): KeyboardEvent {
  return {
    key,
    ctrlKey: modifiers.ctrl ?? false,
    altKey: modifiers.alt ?? false,
    shiftKey: modifiers.shift ?? false,
    metaKey: modifiers.meta ?? false
  } as unknown as KeyboardEvent
}

describe('comboFromEvent', () => {
  it('普通字母键取小写', () => {
    expect(comboFromEvent(fakeKey('N'))).toBe('n')
    expect(comboFromEvent(fakeKey('n'))).toBe('n')
    expect(comboFromEvent(fakeKey('T'))).toBe('t')
  })

  it('组合键按固定顺序拼接', () => {
    expect(comboFromEvent(fakeKey('k', { ctrl: true }))).toBe('ctrl+k')
    expect(comboFromEvent(fakeKey('M', { ctrl: true, alt: true }))).toBe('ctrl+alt+m')
    expect(comboFromEvent(fakeKey('K', { ctrl: true, shift: true }))).toBe('ctrl+shift+k')
  })

  it('特殊键用可读名字', () => {
    expect(comboFromEvent(fakeKey(' '))).toBe('space')
    expect(comboFromEvent(fakeKey('Escape'))).toBe('escape')
    expect(comboFromEvent(fakeKey('Esc'))).toBe('escape')
    expect(comboFromEvent(fakeKey('Enter'))).toBe('enter')
  })

  it('数字键可用于复习三档评分', () => {
    expect(comboFromEvent(fakeKey('1'))).toBe('1')
    expect(comboFromEvent(fakeKey('2'))).toBe('2')
    expect(comboFromEvent(fakeKey('3'))).toBe('3')
  })
})

describe('hasModifier', () => {
  it('识别带修饰键的组合', () => {
    expect(hasModifier('ctrl+k')).toBe(true)
    expect(hasModifier('ctrl+alt+m')).toBe(true)
    expect(hasModifier('meta+k')).toBe(true)
  })

  it('单键判定为无修饰键', () => {
    expect(hasModifier('n')).toBe(false)
    expect(hasModifier('space')).toBe(false)
    expect(hasModifier('escape')).toBe(false)
  })

  it('不会把字母里含 ctrl 子串的情况误判（例如 c 开头的组合）', () => {
    expect(hasModifier('c')).toBe(false)
    expect(hasModifier('control')).toBe(false)
  })
})

describe('isTypingTarget', () => {
  it('输入类元素算"正在输入"', () => {
    for (const tag of ['input', 'textarea', 'select']) {
      const element = { tagName: tag.toUpperCase(), isContentEditable: false } as unknown as HTMLElement
      expect(isTypingTarget(element)).toBe(true)
    }
  })

  it('可编辑区域算"正在输入"', () => {
    const element = {
      tagName: 'DIV',
      isContentEditable: true
    } as unknown as HTMLElement
    expect(isTypingTarget(element)).toBe(true)
  })

  it('普通按钮不算', () => {
    const element = {
      tagName: 'BUTTON',
      isContentEditable: false
    } as unknown as HTMLElement
    expect(isTypingTarget(element)).toBe(false)
  })

  it('null 与非法目标不抛错', () => {
    expect(isTypingTarget(null)).toBe(false)
    expect(isTypingTarget({} as EventTarget)).toBe(false)
  })
})
