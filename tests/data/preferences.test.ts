/**
 * 阶段 3 测试：偏好设置
 *
 * 对应 PRD §5.7 偏好项：每周起始日、复习间隔、主题、备份保留份数。
 * 重点验证"坏数据不会让整份偏好失效"。
 */
import { describe, expect, it } from 'vitest'
import {
  DEFAULT_PREFERENCES,
  PREFERENCES_ID,
  clampKeepDays,
  clampTrashKeepDays,
  intensityMultiplier,
  normalizePreferences,
  readPreferences
} from '../../src/shared/preferences'
import { DEFAULT_TRASH_KEEP_DAYS, TRASH_KEEP_FOREVER_DAYS } from '../../src/shared/trash'

describe('normalizePreferences', () => {
  it('合法输入原样通过', () => {
    const input = {
      theme: 'dark',
      weekStart: 7,
      reviewIntensity: 'intense',
      backupKeepDays: 14,
      trashKeepDays: 7
    }
    expect(normalizePreferences(input)).toEqual(input)
  })

  it('旧数据缺 trashKeepDays 时补默认值（回收站保留期限是第二轮新增的）', () => {
    const result = normalizePreferences({
      theme: 'dark',
      weekStart: 7,
      reviewIntensity: 'intense',
      backupKeepDays: 14
    })
    expect(result.trashKeepDays).toBe(DEFAULT_TRASH_KEEP_DAYS)
  })

  it('空值与非法值回退到默认', () => {
    expect(normalizePreferences(null)).toEqual(DEFAULT_PREFERENCES)
    expect(normalizePreferences(undefined)).toEqual(DEFAULT_PREFERENCES)
    expect(normalizePreferences('字符串')).toEqual(DEFAULT_PREFERENCES)
    expect(normalizePreferences({})).toEqual(DEFAULT_PREFERENCES)
  })

  it('单项非法只影响该项，不牵连其它项', () => {
    const result = normalizePreferences({
      theme: '不存在的主题',
      weekStart: 7,
      reviewIntensity: 'intense',
      backupKeepDays: 7
    })
    expect(result.theme).toBe('system')
    expect(result.weekStart).toBe(7)
    expect(result.reviewIntensity).toBe('intense')
    expect(result.backupKeepDays).toBe(7)
  })

  it('weekStart 只接受 1 或 7', () => {
    expect(normalizePreferences({ weekStart: 1 }).weekStart).toBe(1)
    expect(normalizePreferences({ weekStart: 7 }).weekStart).toBe(7)
    expect(normalizePreferences({ weekStart: 3 }).weekStart).toBe(1)
    expect(normalizePreferences({ weekStart: '7' }).weekStart).toBe(1)
  })

  it('复习间隔只接受三档', () => {
    for (const value of ['standard', 'relaxed', 'intense'] as const) {
      expect(normalizePreferences({ reviewIntensity: value }).reviewIntensity).toBe(value)
    }
    expect(normalizePreferences({ reviewIntensity: '疯狂' }).reviewIntensity).toBe('standard')
  })

  it('reviewHiddenTopicIds：脏数据一律清洗掉，绝不抛错（修改 2 轮 · 复习主题隐藏）', () => {
    // 合法值原样保留
    expect(normalizePreferences({ reviewHiddenTopicIds: ['topic:1', 'book:2'] }).reviewHiddenTopicIds).toEqual([
      'topic:1',
      'book:2'
    ])
    // 非数组 → 当作"什么都没隐藏"
    for (const bad of ['topic:1', 42, { a: 1 }, true]) {
      expect(normalizePreferences({ reviewHiddenTopicIds: bad }).reviewHiddenTopicIds).toBeUndefined()
    }
    // 数组成员里混了非字符串 / 空串 / 重复项 → 只留下合法的，且不抛错
    expect(
      normalizePreferences({
        reviewHiddenTopicIds: ['topic:1', 7, null, '', '  ', 'topic:1', { x: 1 }, 'book:2 ']
      }).reviewHiddenTopicIds
    ).toEqual(['topic:1', 'book:2'])
    // 全都不合法 → 等于没有隐藏
    expect(normalizePreferences({ reviewHiddenTopicIds: [1, '', null] }).reviewHiddenTopicIds).toBeUndefined()
    // 空数组也不写字段（老数据不必凭空多一项）
    expect(normalizePreferences({ reviewHiddenTopicIds: [] }).reviewHiddenTopicIds).toBeUndefined()
  })

  it('reviewHiddenTopicIds：缺省时就是"没有任何隐藏"（老数据不用改）', () => {
    expect(normalizePreferences({ theme: 'dark' }).reviewHiddenTopicIds).toBeUndefined()
    expect(readPreferences([]).reviewHiddenTopicIds).toBeUndefined()
  })

  it('overdueHintDismissedOn：只在"关过某一天"时才写（修改 6 轮 · 逾期提示按天关闭）', () => {
    // 合法日期原样通过
    expect(normalizePreferences({ overdueHintDismissedOn: '2026-02-14' }).overdueHintDismissedOn).toBe(
      '2026-02-14'
    )
    // 缺省 = 没关过 = 正常显示（老数据不用改，也不必凭空多一个字段）
    expect(normalizePreferences({ theme: 'dark' }).overdueHintDismissedOn).toBeUndefined()
    expect(readPreferences([]).overdueHintDismissedOn).toBeUndefined()
  })

  it('overdueHintDismissedOn：脏数据不抛错、被清掉（不能因为一个坏字段让整份偏好失效）', () => {
    const dirty: unknown[] = [
      '2026/02/14', // 分隔符不对
      '2026-2-14', // 没补零
      '2026-02-30', // 2 月没有 30 号
      '2026-13-01', // 没有 13 月
      '0000-00-00', // 全零
      '', // 空串
      '今天', // 中文
      42,
      true,
      null,
      {} as unknown,
      ['2026-02-14'] as unknown
    ]
    for (const value of dirty) {
      expect(
        () => normalizePreferences({ overdueHintDismissedOn: value }),
        `脏值 ${String(value)} 不该抛错`
      ).not.toThrow()
      expect(
        normalizePreferences({ overdueHintDismissedOn: value }).overdueHintDismissedOn,
        `脏值 ${String(value)} 应当被清掉`
      ).toBeUndefined()
    }
  })

  it('overdueHintDismissedOn：清洗它不影响其它项', () => {
    const result = normalizePreferences({
      theme: 'dark',
      weekStart: 7,
      overdueHintDismissedOn: '不是日期'
    })
    expect(result.theme).toBe('dark')
    expect(result.weekStart).toBe(7)
    expect(result.overdueHintDismissedOn).toBeUndefined()
  })
})

describe('clampTrashKeepDays', () => {
  it('把数值夹到 1 ~ 永久之间', () => {
    expect(clampTrashKeepDays(30)).toBe(30)
    expect(clampTrashKeepDays(0)).toBe(1)
    expect(clampTrashKeepDays(-5)).toBe(1)
    // 超过"永久"上限就统一按永久处理，避免出现"比永久还久"的无意义值
    expect(clampTrashKeepDays(999999)).toBe(TRASH_KEEP_FOREVER_DAYS)
  })

  it('接受可解析的字符串（下拉框给的是字符串）', () => {
    expect(clampTrashKeepDays('7')).toBe(7)
    expect(clampTrashKeepDays(' 30 ')).toBe(30)
  })

  it('无法解析时回退到默认 30 天', () => {
    expect(clampTrashKeepDays('abc')).toBe(DEFAULT_TRASH_KEEP_DAYS)
    expect(clampTrashKeepDays(null)).toBe(DEFAULT_TRASH_KEEP_DAYS)
    expect(clampTrashKeepDays(Number.NaN)).toBe(DEFAULT_TRASH_KEEP_DAYS)
  })
})

describe('clampKeepDays', () => {
  it('把数值夹到 1–365', () => {
    expect(clampKeepDays(30)).toBe(30)
    expect(clampKeepDays(0)).toBe(1)
    expect(clampKeepDays(-5)).toBe(1)
    expect(clampKeepDays(9999)).toBe(365)
  })

  it('接受可解析的字符串（表单里常见）', () => {
    expect(clampKeepDays('14')).toBe(14)
    expect(clampKeepDays(' 7 ')).toBe(7)
  })

  it('无法解析时回退到默认', () => {
    expect(clampKeepDays('abc')).toBe(DEFAULT_PREFERENCES.backupKeepDays)
    expect(clampKeepDays(null)).toBe(DEFAULT_PREFERENCES.backupKeepDays)
    expect(clampKeepDays(Number.NaN)).toBe(DEFAULT_PREFERENCES.backupKeepDays)
  })

  it('小数会被取整', () => {
    expect(clampKeepDays(14.6)).toBe(15)
  })
})

describe('readPreferences', () => {
  it('没有偏好记录时返回默认值', () => {
    expect(readPreferences([])).toEqual(DEFAULT_PREFERENCES)
    expect(readPreferences([{ id: 'other', foo: 1 }])).toEqual(DEFAULT_PREFERENCES)
  })

  it('按固定 id 取出偏好记录', () => {
    const records = [
      { id: 'other' },
      { id: PREFERENCES_ID, theme: 'dark', weekStart: 7, reviewIntensity: 'relaxed', backupKeepDays: 10 }
    ]
    const result = readPreferences(records)
    expect(result.theme).toBe('dark')
    expect(result.weekStart).toBe(7)
    expect(result.reviewIntensity).toBe('relaxed')
    expect(result.backupKeepDays).toBe(10)
  })

  it('记录里混入无关字段不影响读取', () => {
    const result = readPreferences([{ id: PREFERENCES_ID, theme: 'light', 未知字段: true }])
    expect(result.theme).toBe('light')
    expect(result.weekStart).toBe(1)
  })
})

describe('intensityMultiplier', () => {
  it('三档倍率关系正确：宽松 > 标准 > 密集', () => {
    expect(intensityMultiplier('relaxed')).toBeGreaterThan(intensityMultiplier('standard'))
    expect(intensityMultiplier('standard')).toBeGreaterThan(intensityMultiplier('intense'))
  })

  it('标准档为 1 倍', () => {
    expect(intensityMultiplier('standard')).toBe(1)
  })
})
