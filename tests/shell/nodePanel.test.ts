/**
 * 就地面板的状态机（2026-10 修订 · 学习页 / 读书页共用）
 *
 * 用户原话：「补充问题：**这个无法收起**，在读书和学习中。」
 *
 * 根因不是"少个按钮"，而是**「子节点展开」和「就地面板展开」共用了一个状态数组**。
 * 于是三件事做不到：面板里没有收起入口、有子节点时想收面板但保留子节点做不到、
 * 收子节点会把面板也弄没。修法是把它拆成两个字段（`expandedIds` 数组 +
 * `openPanelId` 单值），纯逻辑收在 `src/shared/nodePanel.ts`。
 *
 * 这一份逐条钉住 §八 要求的那五条：
 *   1. 点行 → 开
 *   2. 再点同一行 → 收
 *   3. 点另一行 → 换（上一块自动收）
 *   4. 面板开着时展开 / 收起子节点，面板仍在
 *   5. 收起面板后子节点仍展开着
 */
import { describe, expect, it } from 'vitest'
import {
  EMPTY_NODE_PANEL_STATE,
  closeOpenPanel,
  isExpanded,
  isPanelOpen,
  openDetailIdsOf,
  setExpanded,
  toggleExpanded,
  toggleOpenPanel,
  type NodePanelState
} from '../../src/shared/nodePanel'

/** 点一行（页面里 `onOpenDetail` 的那一步） */
const clickRow = (state: NodePanelState, id: string): NodePanelState => toggleOpenPanel(state, id)

describe('点行 → 开 / 再点 → 收 / 点另一行 → 换', () => {
  it('空状态什么都不开', () => {
    expect(EMPTY_NODE_PANEL_STATE.openPanelId).toBeNull()
    expect(openDetailIdsOf(EMPTY_NODE_PANEL_STATE)).toEqual([])
  })

  it('点一行 → 这一行的面板开着', () => {
    const state = clickRow(EMPTY_NODE_PANEL_STATE, 'ch-1')
    expect(state.openPanelId).toBe('ch-1')
    expect(isPanelOpen(state, 'ch-1')).toBe(true)
    expect(isPanelOpen(state, 'ch-2')).toBe(false)
    expect(openDetailIdsOf(state)).toEqual(['ch-1'])
  })

  it('再点同一行 → 收起来', () => {
    const open = clickRow(EMPTY_NODE_PANEL_STATE, 'ch-1')
    const closed = clickRow(open, 'ch-1')
    expect(closed.openPanelId).toBeNull()
    expect(isPanelOpen(closed, 'ch-1')).toBe(false)
    expect(openDetailIdsOf(closed)).toEqual([])
  })

  it('点另一行 → 换过去，上一块自动收起（同屏只开一个）', () => {
    const first = clickRow(EMPTY_NODE_PANEL_STATE, 'ch-1')
    const second = clickRow(first, 'ch-2')
    expect(second.openPanelId).toBe('ch-2')
    expect(isPanelOpen(second, 'ch-1')).toBe(false)
    expect(openDetailIdsOf(second)).toEqual(['ch-2'])
  })

  it('「收起」按钮 / Esc：等价于把面板收掉，且是幂等的', () => {
    const open = clickRow(EMPTY_NODE_PANEL_STATE, 'ch-1')
    const closed = closeOpenPanel(open)
    expect(closed.openPanelId).toBeNull()
    // 再收一次什么都不变（Esc 连按不会把状态弄乱）
    expect(closeOpenPanel(closed)).toEqual(closed)
  })
})

describe('拆开以后：子节点展开与就地面板互不影响', () => {
  it('面板开着时展开子节点 → 面板仍在', () => {
    const opened = clickRow(EMPTY_NODE_PANEL_STATE, 'ch-1')
    const expanded = setExpanded(opened, 'ch-1', true)
    expect(isPanelOpen(expanded, 'ch-1')).toBe(true)
    expect(isExpanded(expanded, 'ch-1')).toBe(true)
  })

  it('面板开着时收起子节点 → 面板仍在（这正是用户截图 2 那种情形）', () => {
    const opened = clickRow(EMPTY_NODE_PANEL_STATE, 'ch-1')
    const expanded = setExpanded(opened, 'ch-1', true)
    const collapsed = setExpanded(expanded, 'ch-1', false)
    expect(isPanelOpen(collapsed, 'ch-1')).toBe(true)
    expect(isExpanded(collapsed, 'ch-1')).toBe(false)
  })

  it('收起面板 → 子节点仍展开着', () => {
    const expanded = setExpanded(EMPTY_NODE_PANEL_STATE, 'ch-1', true)
    const opened = clickRow(expanded, 'ch-1')
    const closed = closeOpenPanel(opened)
    expect(closed.openPanelId).toBeNull()
    expect(isExpanded(closed, 'ch-1')).toBe(true)
  })

  it('祖先链要能同时展开（数组语义**不许**退化成单值）', () => {
    let state = EMPTY_NODE_PANEL_STATE
    for (const id of ['lv1', 'lv2', 'lv3', 'lv4', 'lv5', 'lv6']) {
      state = setExpanded(state, id, true)
    }
    expect(state.expandedIds).toEqual(['lv1', 'lv2', 'lv3', 'lv4', 'lv5', 'lv6'])
    // 只开一个面板的情形下，六层祖先仍然全开着（以前共用数组时会被清掉）
    state = clickRow(state, 'lv6')
    expect(state.expandedIds).toHaveLength(6)
    expect(state.openPanelId).toBe('lv6')
  })

  it('切换子节点展开不会顺手把面板换掉或收掉', () => {
    const opened = clickRow(EMPTY_NODE_PANEL_STATE, 'ch-2')
    const toggled = toggleExpanded(opened, 'ch-1')
    expect(toggled.openPanelId).toBe('ch-2')
    expect(isExpanded(toggled, 'ch-1')).toBe(true)
  })
})

describe('setExpanded 的边界', () => {
  it('状态没变就返回原对象（少一次无意义的重渲染）', () => {
    const state = setExpanded(EMPTY_NODE_PANEL_STATE, 'ch-1', true)
    expect(setExpanded(state, 'ch-1', true)).toBe(state)
    expect(setExpanded(EMPTY_NODE_PANEL_STATE, 'ch-1', false)).toBe(EMPTY_NODE_PANEL_STATE)
  })

  it('重复点击不会把同一个 id 塞两遍', () => {
    let state = EMPTY_NODE_PANEL_STATE
    state = toggleExpanded(state, 'ch-1')
    state = toggleExpanded(state, 'ch-1')
    state = toggleExpanded(state, 'ch-1')
    expect(state.expandedIds).toEqual(['ch-1'])
  })

  it('不改原对象（纯函数，React 才认得出变化）', () => {
    const before = clickRow(EMPTY_NODE_PANEL_STATE, 'ch-1')
    const snapshot = { ...before, expandedIds: [...before.expandedIds] }
    setExpanded(before, 'ch-1', true)
    closeOpenPanel(before)
    toggleOpenPanel(before, 'ch-2')
    expect(before).toEqual(snapshot)
  })
})
