/**
 * 右键菜单纯逻辑的单测（第二轮 FEAT-001）
 *
 * 为什么测这些：菜单跑到窗口外、键盘跳不动、跳到了禁用项上——
 * 这些毛病在界面上都表现为"偶尔点不到/按了没反应"，很难靠手点发现，
 * 而它们完全由下面两个算法决定。
 */
import { describe, expect, it } from 'vitest'
import {
  MENU_MARGIN,
  firstEnabledIndex,
  nextEnabledIndex,
  placeMenu
} from '../../src/shared/contextMenu'
import { disabledFlags, type MenuItemSpec } from '../../src/shared/menuItems'

const VIEWPORT = { width: 1280, height: 840 }
const SIZE = { width: 200, height: 300 }

describe('placeMenu 定位', () => {
  it('空间足够时，菜单位于触发点右下方', () => {
    expect(placeMenu({ x: 100, y: 100 }, SIZE, VIEWPORT)).toEqual({ x: 100, y: 100 })
  })

  it('右侧放不下时翻到左边', () => {
    // 触发点离右边缘只剩 50px，菜单宽 200 → 必须翻到左侧
    const placed = placeMenu({ x: 1240, y: 100 }, SIZE, VIEWPORT)
    expect(placed.x).toBe(1240 - SIZE.width)
    expect(placed.y).toBe(100)
  })

  it('下方放不下时翻到上方', () => {
    const placed = placeMenu({ x: 100, y: 800 }, SIZE, VIEWPORT)
    expect(placed.y).toBe(800 - SIZE.height)
    expect(placed.x).toBe(100)
  })

  it('右下角同时翻两个方向', () => {
    const placed = placeMenu({ x: 1270, y: 830 }, SIZE, VIEWPORT)
    expect(placed.x).toBe(1270 - SIZE.width)
    expect(placed.y).toBe(830 - SIZE.height)
  })

  it('窗口比菜单还小时也夹在可视范围内（不能跑到窗口外）', () => {
    const tiny = { width: 150, height: 100 }
    const placed = placeMenu({ x: 140, y: 90 }, SIZE, tiny)
    expect(placed.x).toBeGreaterThanOrEqual(MENU_MARGIN)
    expect(placed.y).toBeGreaterThanOrEqual(MENU_MARGIN)
    // 夹紧后仍在窗口内（此处窗口小于菜单，只要求不出现负值/越界起点）
    expect(placed.x).toBeLessThanOrEqual(tiny.width)
    expect(placed.y).toBeLessThanOrEqual(tiny.height)
  })

  it('结果取整，避免半像素造成的模糊与错位', () => {
    const placed = placeMenu({ x: 10.4, y: 20.6 }, SIZE, VIEWPORT)
    expect(Number.isInteger(placed.x)).toBe(true)
    expect(Number.isInteger(placed.y)).toBe(true)
  })
})

describe('键盘导航：nextEnabledIndex', () => {
  it('向下跳过禁用项', () => {
    const disabled = [false, true, false]
    expect(nextEnabledIndex(disabled, 0, 1)).toBe(2)
  })

  it('向上跳过禁用项', () => {
    const disabled = [false, true, false]
    expect(nextEnabledIndex(disabled, 2, -1)).toBe(0)
  })

  it('到底后循环回开头', () => {
    const disabled = [false, false, false]
    expect(nextEnabledIndex(disabled, 2, 1)).toBe(0)
  })

  it('到顶后循环回末尾', () => {
    const disabled = [false, false, false]
    expect(nextEnabledIndex(disabled, 0, -1)).toBe(2)
  })

  it('全部禁用时返回 -1（不移动，也不报错）', () => {
    expect(nextEnabledIndex([true, true], 0, 1)).toBe(-1)
    expect(nextEnabledIndex([true, true], 1, -1)).toBe(-1)
  })

  it('空菜单返回 -1', () => {
    expect(nextEnabledIndex([], 0, 1)).toBe(-1)
  })

  it('当前位置本身无效时也能找到下一个可用项', () => {
    // 初始 activeIndex 可能是 -1（还没高亮），向下应落到第一个可用项
    expect(nextEnabledIndex([false, false], -1, 1)).toBe(0)
    // 或者落在被禁用项上时，也要能走出去
    expect(nextEnabledIndex([true, false], 0, 1)).toBe(1)
  })
})

describe('键盘导航：firstEnabledIndex', () => {
  it('返回第一个可用项', () => {
    expect(firstEnabledIndex([false, false])).toBe(0)
  })

  it('跳过开头的禁用项', () => {
    expect(firstEnabledIndex([true, true, false])).toBe(2)
  })

  it('全部禁用返回 -1', () => {
    expect(firstEnabledIndex([true])).toBe(-1)
  })

  it('空数组返回 -1', () => {
    expect(firstEnabledIndex([])).toBe(-1)
  })
})

describe('菜单项定义', () => {
  it('disabledFlags 把 undefined 当作可用', () => {
    const items: MenuItemSpec[] = [
      { id: 'a', label: '编辑', onSelect: () => undefined },
      { id: 'b', label: '删除', disabled: true, onSelect: () => undefined },
      { id: 'c', label: '复制', disabled: false, onSelect: () => undefined }
    ]
    expect(disabledFlags(items)).toEqual([false, true, false])
  })
})
