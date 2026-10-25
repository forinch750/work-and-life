/**
 * 侧栏收起状态（第 08 块 · 决定 6 / `docs\TASKS\08` §6.2）
 *
 * 要验的是"**能存取、重开后保持**"这条：
 *
 *   1. 展开是缺省：老数据里根本没有 `sidebarCollapsed` 字段 → 展开
 *   2. 收起 → 落库 `true` → 重新读出来还是收起（重开程序不会弹回去）
 *   3. 再点一次展开 → 真的把 `false` 写回去（**不能只能收起、回不来**）
 *   4. 只认严格的 `true`：`"true"` / `1` / `"yes"` 一律当展开
 *      —— 宁可展开让人找得到导航，也不要因为一个坏字段把导航藏掉
 *
 * 持久化的落库语义按 `api.update` 的**合并**规则模拟（`{...旧记录, ...patch}`），
 * 因为 `renderer\lib\prefsClient.ts` 走的就是这条路。
 * 环境是 `environment: 'node'`：这里只测共享层的纯函数，界面行为交给端到端验收。
 */
import { describe, expect, it } from 'vitest'
import {
  DEFAULT_PREFERENCES,
  PREFERENCES_ID,
  isSidebarCollapsed,
  normalizePreferences,
  readPreferences,
  toggleSidebarCollapsed
} from '../../src/shared/preferences'

/** 一条偏好记录（形状与 `data\app.json` 里一致） */
function prefRecord(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { id: PREFERENCES_ID, ...extra }
}

/** 模拟 `api.update` 的合并语义：把 patch 盖到已有记录上 */
function mergePatch(
  record: Record<string, unknown>,
  patch: Record<string, unknown>
): Record<string, unknown> {
  return { ...record, ...patch }
}

/** 模拟"关掉程序再打开"：落盘 → 读盘（JSON 往返）→ 解析偏好 */
function reload(record: Record<string, unknown>): ReturnType<typeof readPreferences> {
  const onDisk = JSON.parse(JSON.stringify(record)) as Record<string, unknown>
  return readPreferences([onDisk])
}

describe('侧栏收起状态：存取', () => {
  it('缺省是展开（老数据没有这个字段也当展开）', () => {
    expect(isSidebarCollapsed(readPreferences([]))).toBe(false)
    expect(isSidebarCollapsed(readPreferences([prefRecord({ theme: 'dark' })]))).toBe(false)
    expect(isSidebarCollapsed(DEFAULT_PREFERENCES)).toBe(false)
    expect(DEFAULT_PREFERENCES.sidebarCollapsed).toBeUndefined()
  })

  it('收起后落库 true，重新读出来仍然是收起（重开后保持）', () => {
    const record = prefRecord({ theme: 'dark' })
    const patch = toggleSidebarCollapsed(readPreferences([record]))
    expect(patch).toEqual({ sidebarCollapsed: true })

    const saved = mergePatch(record, patch)
    // 关掉再打开：读到的是磁盘上的 JSON
    expect(isSidebarCollapsed(reload(saved))).toBe(true)
    // 其它偏好不受影响（只多写了一个字段）
    expect(reload(saved).theme).toBe('dark')
  })

  it('再点一次能展开：false 必须真的被写回去（合并语义下也不能丢）', () => {
    const collapsedRecord = prefRecord({ sidebarCollapsed: true })
    const patch = toggleSidebarCollapsed(readPreferences([collapsedRecord]))
    expect(patch).toEqual({ sidebarCollapsed: false })

    const saved = mergePatch(collapsedRecord, patch)
    expect(saved['sidebarCollapsed']).toBe(false)
    expect(isSidebarCollapsed(reload(saved))).toBe(false)
    // 再收起一次仍然正确（来回切换不粘住）
    const again = mergePatch(saved, toggleSidebarCollapsed(readPreferences([saved])))
    expect(isSidebarCollapsed(reload(again))).toBe(true)
  })

  it('只认严格的 true：字符串 / 数字 / 别的写法一律当展开', () => {
    for (const bad of ['true', 'yes', 1, 0, 'on', {} , []] as unknown[]) {
      const prefs = readPreferences([prefRecord({ sidebarCollapsed: bad })])
      expect(isSidebarCollapsed(prefs), `sidebarCollapsed=${JSON.stringify(bad)} 不该被当成收起`).toBe(
        false
      )
    }
    expect(isSidebarCollapsed(readPreferences([prefRecord({ sidebarCollapsed: true })]))).toBe(true)
  })

  it('归一化不会凭空多写这个字段（老数据不会被改写）', () => {
    const normalized = normalizePreferences({ theme: 'light', weekStart: 7 })
    expect('sidebarCollapsed' in normalized).toBe(false)
    // 收起时才会带上
    expect(normalizePreferences({ sidebarCollapsed: true }).sidebarCollapsed).toBe(true)
  })
})
