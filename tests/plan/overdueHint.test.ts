/**
 * 修改 6 轮测试：计划页工具栏里的逾期提示「该不该显示」
 *
 * 用户原话：「这个提醒放在上面按个框框里，然后可以关闭。」
 * 与用户确认过的口径是"**当天不再出现**"：
 *   关掉 → 今天不再显示；第二天有逾期又会出来（不需要任何定时器）。
 *
 * 判据放在 `shared/planLogic.shouldShowOverdueHint`（纯逻辑），这里逐条钉住：
 *   显示 = 逾期 > 0 且 关掉的那一天 !== 今天
 *
 * 另外守一条很容易被顺手改坏的边界：**页头「逾期 N 项」统计不读这个状态**。
 * 那个数字是常驻统计，关掉的只是这条提示（见 `renderer/../PlanPage` 与 `P8-Q4`）。
 */
import { describe, expect, it } from 'vitest'
import { shouldShowOverdueHint } from '../../src/shared/planLogic'

const TODAY = '2026-02-14'
const YESTERDAY = '2026-02-13'

describe('shouldShowOverdueHint（修改 6 轮 · 逾期提示按天关闭）', () => {
  it('有逾期、没关过 → 显示', () => {
    expect(shouldShowOverdueHint(2, undefined, TODAY)).toBe(true)
  })

  it('逾期为 0 → 不显示（哪怕从没关过）', () => {
    expect(shouldShowOverdueHint(0, undefined, TODAY)).toBe(false)
  })

  it('今天关过 → 不显示', () => {
    expect(shouldShowOverdueHint(2, TODAY, TODAY)).toBe(false)
  })

  it('昨天关过 → 显示（第二天自动回来）', () => {
    expect(shouldShowOverdueHint(2, YESTERDAY, TODAY)).toBe(true)
  })

  it('关掉之后即使逾期变多也不显示（"当天不再出现"的字面语义）', () => {
    expect(shouldShowOverdueHint(9, TODAY, TODAY)).toBe(false)
  })

  it('非法条数一律不显示（磁盘/调试来的脏值不该冒出提示）', () => {
    expect(shouldShowOverdueHint(Number.NaN, undefined, TODAY)).toBe(false)
    expect(shouldShowOverdueHint(-1, undefined, TODAY)).toBe(false)
  })

  it('隔了很多天再回头看仍然显示（只比较"是不是今天"，不做"多久前"的判断）', () => {
    expect(shouldShowOverdueHint(1, '2025-01-01', TODAY)).toBe(true)
  })
})
