/**
 * 第 06 块测试：快捷键的语义、冲突、重置与"输入框豁免"
 *
 * 对应 `docs\TASKS\06` §6.2 的四行：
 *   - **单键 `N`/`T` 的输入框豁免**：焦点在输入框时 `N`/`T` 不触发；`Ctrl+K` 等组合键仍触发
 *   - `N` 在复习页不注册（复习页按 `N` 无事发生）
 *   - 快捷键冲突检测（绑同一个键时能检出并提示）
 *   - 重置（重置后回到默认绑定）
 *
 * 这里测的都是**纯函数**：`matchHotkey` 决定"这次按键该不该触发"，
 * `newEntryKindOfView` / `todayHotkeyAppliesTo` 决定"哪个页面支持哪个动作"，
 * `assignHotkey` / `resetHotkeyAction` 决定"改绑能不能成"。
 * 页面里只剩"调这些函数"，所以这几条规则改不掉也漏不掉。
 */
import { describe, expect, it } from 'vitest'
import {
  assignHotkey,
  DEFAULT_HOTKEYS,
  HOTKEY_ACTIONS,
  HOTKEY_LABELS,
  comboConflicts,
  hotkeyConflictGroups,
  isDefaultHotkey,
  resolveHotkeys,
  resetAllHotkeys,
  resetHotkeyAction,
  type HotkeyAction
} from '../../src/shared/preferences'
import {
  FIXED_HOTKEYS,
  comboLabel,
  hotkeyHint,
  newEntryKindOfView,
  newHotkeyHint,
  todayHotkeyAppliesTo
} from '../../src/shared/hotkeys'
import { comboFromEvent, matchHotkey, type HotkeySpec } from '../../src/renderer/lib/hotkeys'

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

/** 输入框 / textarea / select / contentEditable 的替身 */
const INPUT = { tagName: 'INPUT', isContentEditable: false } as unknown as HTMLElement
const TEXTAREA = { tagName: 'TEXTAREA', isContentEditable: false } as unknown as HTMLElement
const EDITABLE = { tagName: 'DIV', isContentEditable: true } as unknown as HTMLElement
const BUTTON = { tagName: 'BUTTON', isContentEditable: false } as unknown as HTMLElement

/** 记录哪些 handler 被调用了 */
function makeSpecs(): { specs: HotkeySpec[]; hits: string[] } {
  const hits: string[] = []
  const specs: HotkeySpec[] = [
    { combo: 'n', handler: () => hits.push('new') },
    { combo: 't', handler: () => hits.push('today') },
    { combo: 'ctrl+k', handler: () => hits.push('search') },
    { combo: 'ctrl+s', handler: () => hits.push('save') }
  ]
  return { specs, hits }
}

/** 模拟一次按键：命中就调用 handler，返回是否触发 */
function press(specs: HotkeySpec[], key: string, target: unknown, modifiers = {}): boolean {
  const spec = matchHotkey(specs, comboFromEvent(fakeKey(key, modifiers)), target)
  if (spec === null) return false
  spec.handler(fakeKey(key, modifiers))
  return true
}

describe('单键 N / T 的输入框豁免（产品规定，也写进了用户指南第四章）', () => {
  it('焦点在普通元素上时 N / T 正常触发', () => {
    const { specs, hits } = makeSpecs()
    expect(press(specs, 'n', BUTTON)).toBe(true)
    expect(press(specs, 't', BUTTON)).toBe(true)
    expect(hits).toEqual(['new', 'today'])
  })

  it('焦点在输入框 / textarea / 可编辑区域里时 N / T 都不触发', () => {
    for (const target of [INPUT, TEXTAREA, EDITABLE]) {
      const { specs, hits } = makeSpecs()
      expect(press(specs, 'n', target)).toBe(false)
      expect(press(specs, 't', target)).toBe(false)
      expect(hits).toEqual([])
    }
  })

  it('组合键在任何情况下都触发（输入框里也一样）', () => {
    for (const target of [INPUT, TEXTAREA, EDITABLE, BUTTON]) {
      const { specs, hits } = makeSpecs()
      expect(press(specs, 'k', target, { ctrl: true })).toBe(true)
      expect(press(specs, 's', target, { ctrl: true })).toBe(true)
      expect(hits).toEqual(['search', 'save'])
    }
  })

  it('显式写了 allowInInput 的单键可以在输入框里用', () => {
    const hits: string[] = []
    const specs: HotkeySpec[] = [
      { combo: 'n', handler: () => hits.push('typed'), allowInInput: true }
    ]
    expect(press(specs, 'n', INPUT)).toBe(true)
    expect(hits).toEqual(['typed'])
  })

  it('没命中的组合键什么都不做', () => {
    const { specs, hits } = makeSpecs()
    expect(press(specs, 'x', BUTTON)).toBe(false)
    expect(hits).toEqual([])
  })
})

describe('N 在各页面的语义（决定 29）', () => {
  it('计划 / 学习 / 读书 / 备忘 各自"新建什么"', () => {
    expect(newEntryKindOfView('plan')).toBe('task')
    expect(newEntryKindOfView('learning')).toBe('topic')
    expect(newEntryKindOfView('reading')).toBe('book')
    expect(newEntryKindOfView('memo')).toBe('memo')
  })

  it('复习页不注册 N（卡片从别处生成，"新建"在那儿没有自然含义）', () => {
    expect(newEntryKindOfView('review')).toBeNull()
    // 顺带把"别的页面也不该莫名其妙支持 N"钉住
    for (const viewId of ['home', 'settings', 'project', 'research', 'ledger', '']) {
      expect(newEntryKindOfView(viewId)).toBeNull()
    }
  })

  it('T 只在计划页生效', () => {
    expect(todayHotkeyAppliesTo('plan')).toBe(true)
    for (const viewId of ['review', 'learning', 'reading', 'memo', 'home', 'settings']) {
      expect(todayHotkeyAppliesTo(viewId)).toBe(false)
    }
  })

  it('设置页上的提示把"复习页不注册"写出来了', () => {
    expect(newHotkeyHint()).toContain('复习页不注册')
    expect(newHotkeyHint()).toContain('新建任务')
    expect(hotkeyHint('new')).toBe(newHotkeyHint())
    expect(hotkeyHint('today')).toContain('计划页')
    expect(hotkeyHint('save')).toBeNull()
  })
})

describe('组合键的显示写法', () => {
  it('小写写法 → 键盘上印的字', () => {
    expect(comboLabel('ctrl+s')).toBe('Ctrl+S')
    expect(comboLabel('ctrl+alt+m')).toBe('Ctrl+Alt+M')
    expect(comboLabel('n')).toBe('N')
    expect(comboLabel('t')).toBe('T')
    expect(comboLabel('escape')).toBe('Esc')
    expect(comboLabel('space')).toBe('空格')
    expect(comboLabel('ctrl+enter')).toBe('Ctrl+回车')
  })

  it('固定键表的每一条都能显示成人话', () => {
    expect(FIXED_HOTKEYS.length).toBeGreaterThan(0)
    for (const item of FIXED_HOTKEYS) {
      expect(comboLabel(item.combo)).not.toBe('')
      expect(item.scope).not.toBe('')
    }
  })
})

describe('冲突检测（FEAT-008）', () => {
  it('把某个键绑到已被占用的动作上会被拒绝，并说出被谁占了', () => {
    const result = assignHotkey(resolveHotkeys(undefined), 'today', 'ctrl+s')
    expect(result.error).toContain('冲突')
    expect(result.error).toContain(HOTKEY_LABELS.save)
    expect(result.combo).toBeNull()
    // 拒绝时绑定表原样返回，不留半截改动
    expect(result.bindings).toEqual(resolveHotkeys(undefined))
  })

  it('绑到空闲的键上成功，且写法被规范化', () => {
    const result = assignHotkey(resolveHotkeys(undefined), 'today', 'CTRL+SHIFT+Y')
    expect(result.error).toBeNull()
    expect(result.combo).toBe('ctrl+shift+y')
    expect(result.bindings.today).toBe('ctrl+shift+y')
  })

  it('非法写法被拒绝（只有修饰键 / 乱序 / 重复修饰键）', () => {
    for (const bad of ['ctrl', 'shift+ctrl+s', 'ctrl+ctrl+s', '', 'ctrl+']) {
      const result = assignHotkey(resolveHotkeys(undefined), 'today', bad)
      expect(result.error).not.toBeNull()
      expect(result.combo).toBeNull()
    }
  })

  it('把动作绑回它自己原来的键不算冲突', () => {
    const bindings = resolveHotkeys(undefined)
    const result = assignHotkey(bindings, 'save', 'ctrl+s')
    expect(result.error).toBeNull()
    expect(result.bindings.save).toBe('ctrl+s')
  })

  it('comboConflicts / hotkeyConflictGroups 能找出重复占用', () => {
    const bindings = { ...resolveHotkeys(undefined), today: 'n' }
    expect(comboConflicts(bindings, 'n').sort()).toEqual(['new', 'today'])
    const groups = hotkeyConflictGroups(bindings)
    expect(groups).toHaveLength(1)
    expect(groups[0]?.combo).toBe('n')
    expect(groups[0]?.actions.sort()).toEqual(['new', 'today'])
    // 正常状态下（默认绑定）一个冲突都没有
    expect(hotkeyConflictGroups(resolveHotkeys(undefined))).toEqual([])
  })

  it('默认绑定表本身互不冲突，且每个动作都有一个非空绑定', () => {
    expect(hotkeyConflictGroups(resolveHotkeys(undefined))).toEqual([])
    for (const action of HOTKEY_ACTIONS) {
      expect(DEFAULT_HOTKEYS[action]).not.toBe('')
      expect(HOTKEY_LABELS[action]).not.toBe('')
    }
    expect(new Set(HOTKEY_ACTIONS).size).toBe(HOTKEY_ACTIONS.length)
  })
})

describe('重置（FEAT-008）', () => {
  it('单项重置后回到默认绑定', () => {
    const changed = assignHotkey(resolveHotkeys(undefined), 'save', 'ctrl+shift+s').bindings
    expect(changed.save).toBe('ctrl+shift+s')
    expect(isDefaultHotkey(changed, 'save')).toBe(false)
    const reset = resetHotkeyAction(changed, 'save')
    expect(reset.save).toBe(DEFAULT_HOTKEYS.save)
    expect(isDefaultHotkey(reset, 'save')).toBe(true)
    // 其它动作不受影响
    expect(reset.today).toBe(changed.today)
  })

  it('全部重置后整张表等于默认表', () => {
    let bindings = resolveHotkeys(undefined)
    bindings = assignHotkey(bindings, 'save', 'ctrl+shift+s').bindings
    bindings = assignHotkey(bindings, 'today', 'ctrl+shift+t').bindings
    expect(resetAllHotkeys()).toEqual(DEFAULT_HOTKEYS)
    expect(resetAllHotkeys()).not.toBe(DEFAULT_HOTKEYS) // 是副本，改它不会污染默认值
  })

  it('非法绑定值被忽略后回退默认（老数据 / 手改过的数据也不会把偏好弄坏）', () => {
    const resolved = resolveHotkeys({ save: 'ctrl+ctrl+s', today: 'zzz' } as Partial<
      Record<HotkeyAction, string>
    >)
    expect(resolved.save).toBe(DEFAULT_HOTKEYS.save)
    expect(resolved.today).toBe(DEFAULT_HOTKEYS.today)
  })
})
