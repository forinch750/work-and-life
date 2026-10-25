/**
 * 阶段 2 测试：导航定义
 *
 * 对应 PRD C1 / C2 的结构性部分：
 *   - 十项导航齐全
 *   - 高频五项在上、待开发三项居中、工具项沉底
 *   - 三个待开发模块必须带说明内容（点进去不是空白页）
 *   - 角标只配给"复习"和"计划"
 */
import { describe, expect, it } from 'vitest'
import {
  DEFAULT_VIEW_ID,
  NAV_ITEMS,
  SEARCH_ITEM,
  findNavItem
} from '../../src/shared/navigation'
import { PLACEHOLDER_CONTENT } from '../../src/shared/placeholderContent'

describe('NAV_ITEMS 结构', () => {
  it('一共 10 项，id 不重复', () => {
    expect(NAV_ITEMS).toHaveLength(10)
    const ids = NAV_ITEMS.map((item) => item.id)
    expect(new Set(ids).size).toBe(10)
  })

  it('包含 PRD 要求的全部模块', () => {
    const labels = NAV_ITEMS.map((item) => item.label)
    expect(labels).toEqual([
      '总览',
      '计划',
      '学习',
      '复习',
      '读书',
      '备忘录',
      '项目',
      '预研',
      '记账',
      '数据与设置'
    ])
  })

  it('分组顺序：高频五项 → 待开发三项 → 工具项', () => {
    const sections = NAV_ITEMS.map((item) => item.section)
    expect(sections).toEqual([
      'main',
      'main',
      'main',
      'main',
      'main',
      'main',
      'planned',
      'planned',
      'planned',
      'tool'
    ])
  })

  it('只有项目/预研/记账三项是待开发', () => {
    const notReady = NAV_ITEMS.filter((item) => !item.ready).map((item) => item.id)
    expect(notReady).toEqual(['project', 'research', 'ledger'])
  })

  it('待开发项必须带说明内容与计划版本（点进去不能是空白页）', () => {
    for (const item of NAV_ITEMS.filter((nav) => !nav.ready)) {
      expect(item.placeholder, `${item.id} 缺少说明内容`).toBeTruthy()
      expect(item.placeholder?.summary.length ?? 0).toBeGreaterThan(10)
      expect(item.placeholder?.features.length ?? 0).toBeGreaterThanOrEqual(3)
      expect(item.plannedVersion).toBeTruthy()
      for (const feature of item.placeholder?.features ?? []) {
        expect(feature.title.length).toBeGreaterThan(0)
        expect(feature.detail.length).toBeGreaterThan(0)
      }
    }
  })

  it('待开发项的说明内容与共享常量一致', () => {
    expect(findNavItem('project')?.placeholder).toBe(PLACEHOLDER_CONTENT.project)
    expect(findNavItem('research')?.placeholder).toBe(PLACEHOLDER_CONTENT.research)
    expect(findNavItem('ledger')?.placeholder).toBe(PLACEHOLDER_CONTENT.ledger)
  })

  it('角标只配给复习，红点只配给计划', () => {
    const withBadge = NAV_ITEMS.filter((item) => item.badge).map((item) => item.id)
    const withDot = NAV_ITEMS.filter((item) => item.dot).map((item) => item.id)
    expect(withBadge).toEqual(['review'])
    expect(withDot).toEqual(['plan'])
  })

  it('已完成模块不携带说明内容', () => {
    for (const item of NAV_ITEMS.filter((nav) => nav.ready)) {
      expect(item.placeholder, `${item.id} 不该有说明内容`).toBeUndefined()
    }
  })

  it('默认视图是总览，且总览存在', () => {
    expect(DEFAULT_VIEW_ID).toBe('home')
    expect(findNavItem(DEFAULT_VIEW_ID)).toBeTruthy()
  })

  it('搜索入口带 Ctrl+K 提示', () => {
    expect(SEARCH_ITEM.id).toBe('search')
    expect(SEARCH_ITEM.shortcut).toBe('Ctrl+K')
  })
})
