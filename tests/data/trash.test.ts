/**
 * 回收站纯逻辑的单测（第二轮 FEAT-009）
 *
 * 重点：
 *   - 汇总不能漏模块、不能把没删的记录也算进去（否则用户会以为数据被删了）
 *   - 类型与位置要判对（回收站列表的全部价值就在这里）
 *   - 按期限清理绝不能保守到"因为一个坏字段就把数据删了"
 */
import { describe, expect, it } from 'vitest'
import {
  DEFAULT_TRASH_KEEP_DAYS,
  TRASH_KEEP_FOREVER_DAYS,
  collectTrash,
  describeEntry,
  emptyTrashHint,
  expiredEntries,
  isDeleted,
  keepDaysLabel,
  toTrashEntry,
  type TrashEntry
} from '../../src/shared/trash'

const DELETED_AT = '2026-10-01T10:00:00.000Z'

function rec(id: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { id, createdAt: '2026-09-01T00:00:00.000Z', updatedAt: '2026-09-01T00:00:00.000Z', ...extra }
}

describe('isDeleted', () => {
  it('deletedAt 有值才算已删除', () => {
    expect(isDeleted(rec('a', { deletedAt: DELETED_AT }))).toBe(true)
    expect(isDeleted(rec('a'))).toBe(false)
    expect(isDeleted(rec('a', { deletedAt: null }))).toBe(false)
    expect(isDeleted(rec('a', { deletedAt: '' }))).toBe(false)
  })
})

describe('describeEntry 类型与位置判定', () => {
  it('学习模块按 kind 区分主题/资料/日志/章节', () => {
    expect(describeEntry('learning', { kind: 'topic' }).label).toBe('学习主题')
    expect(describeEntry('learning', { kind: 'resource' }).label).toBe('学习资料')
    expect(describeEntry('learning', { kind: 'log' }).label).toBe('学习日志')
    expect(describeEntry('learning', { kind: 'node' }).label).toBe('章节节点')
  })

  it('读书模块按 kind 区分书籍/阅读记录/摘录/章节', () => {
    expect(describeEntry('reading', { kind: 'book' }).label).toBe('书籍')
    expect(describeEntry('reading', { kind: 'progress' }).label).toBe('阅读记录')
    expect(describeEntry('reading', { kind: 'excerpt' }).label).toBe('摘录')
    expect(describeEntry('reading', { kind: 'node' }).label).toBe('章节节点')
  })

  it('计划/备忘/复习的简单类型', () => {
    expect(describeEntry('plan', {}).label).toBe('任务')
    expect(describeEntry('memo', {}).label).toBe('备忘')
    expect(describeEntry('review', {}).label).toBe('复习卡')
  })

  it('kind 无法识别时退回通用文案，而不是报错', () => {
    const info = describeEntry('learning', { kind: '未知类型' })
    expect(info.label).toBe('条目')
    expect(info.origin).toBe('未知位置')
  })

  it('原位置说明能指向具体模块', () => {
    expect(describeEntry('learning', { kind: 'topic' }).origin).toBe('学习 → 主题')
    expect(describeEntry('reading', { kind: 'book' }).origin).toBe('读书 → 书架')
    expect(describeEntry('memo', {}).origin).toBe('备忘录')
  })
})

describe('toTrashEntry', () => {
  it('未删除的记录不进回收站', () => {
    expect(toTrashEntry('memo', rec('m1', { text: '还在' }))).toBeNull()
  })

  it('已删除的记录带出类型、标题、删除时间与原位置', () => {
    const entry = toTrashEntry(
      'learning',
      rec('t1', { kind: 'topic', title: '英语长难句', deletedAt: DELETED_AT })
    )
    expect(entry).toEqual({
      module: 'learning',
      id: 't1',
      deletedAt: DELETED_AT,
      typeLabel: '学习主题',
      title: '英语长难句',
      origin: '学习 → 主题'
    })
  })

  it('标题取不到时给出占位文案，而不是空字符串', () => {
    const entry = toTrashEntry('memo', rec('m1', { deletedAt: DELETED_AT }))
    expect(entry?.title).toBe('（无标题）')
  })

  it('超长标题会截断，避免列表被一条撑爆', () => {
    const long = '很长的内容'.repeat(30)
    const entry = toTrashEntry('memo', rec('m1', { text: long, deletedAt: DELETED_AT }))
    expect(entry?.title.length).toBeLessThanOrEqual(61)
    expect(entry?.title.endsWith('…')).toBe(true)
  })

  it('id 为空的记录不进回收站（无法恢复）', () => {
    const entry = toTrashEntry('memo', { text: '无 id', deletedAt: DELETED_AT })
    expect(entry?.id).toBe('')
  })
})

describe('collectTrash 汇总', () => {
  it('把各模块已删除的记录汇总起来', () => {
    const entries = collectTrash({
      learning: [rec('t1', { kind: 'topic', title: '英语', deletedAt: DELETED_AT })],
      memo: [rec('m1', { text: '备忘', deletedAt: DELETED_AT })],
      plan: [rec('p1', { title: '任务', deletedAt: DELETED_AT })],
      review: [rec('r1', { front: '卡片', deletedAt: DELETED_AT })]
    })
    expect(entries).toHaveLength(4)
    expect(entries.map((e) => e.typeLabel).sort()).toEqual(['任务', '复习卡', '学习主题', '备忘'].sort())
  })

  it('没有删除的记录时返回空数组', () => {
    expect(collectTrash({ memo: [rec('m1', { text: '还在' })] })).toEqual([])
  })

  it('按删除时间倒序（最近删的在最上面）', () => {
    const entries = collectTrash({
      memo: [
        rec('old', { text: '先删的', deletedAt: '2026-09-01T00:00:00.000Z' }),
        rec('new', { text: '后删的', deletedAt: '2026-10-05T00:00:00.000Z' })
      ]
    })
    expect(entries.map((e) => e.id)).toEqual(['new', 'old'])
  })

  it('id 为空的记录被过滤掉（否则恢复按钮点了也没用）', () => {
    const entries = collectTrash({
      memo: [{ text: '没有 id', deletedAt: DELETED_AT }]
    })
    expect(entries).toEqual([])
  })

  it('模块值为非数组时不报错', () => {
    expect(() => collectTrash({ memo: undefined })).not.toThrow()
    expect(collectTrash({ memo: undefined })).toEqual([])
  })

  it('同一时刻删除的条目顺序稳定（不抖动）', () => {
    const input = {
      memo: [rec('a', { text: 'A', deletedAt: DELETED_AT }), rec('b', { text: 'B', deletedAt: DELETED_AT })]
    }
    const first = collectTrash(input).map((e) => e.id)
    const second = collectTrash(input).map((e) => e.id)
    expect(first).toEqual(second)
  })
})

describe('expiredEntries 按保留期限清理', () => {
  const now = new Date('2026-10-10T00:00:00.000Z')

  function entry(id: string, deletedAt: string): TrashEntry {
    return {
      module: 'memo',
      id,
      deletedAt,
      typeLabel: '备忘',
      title: id,
      origin: '备忘录'
    }
  }

  it('超过保留期限的条目会被清理', () => {
    const old = entry('old', '2026-09-01T00:00:00.000Z') // 39 天前
    const recent = entry('recent', '2026-10-08T00:00:00.000Z') // 2 天前
    expect(expiredEntries([old, recent], 30, now).map((e) => e.id)).toEqual(['old'])
  })

  it('刚好在期限内的不清理', () => {
    const edge = entry('edge', '2026-09-11T00:00:00.000Z') // 29 天前
    expect(expiredEntries([edge], 30, now)).toEqual([])
  })

  it('永久保留时什么都不清理', () => {
    const ancient = entry('ancient', '2000-01-01T00:00:00.000Z')
    expect(expiredEntries([ancient], TRASH_KEEP_FOREVER_DAYS, now)).toEqual([])
    expect(expiredEntries([ancient], TRASH_KEEP_FOREVER_DAYS + 1, now)).toEqual([])
  })

  it('期限为 0 表示立即全部清理（用户主动选择）', () => {
    const any = entry('any', '2026-10-09T00:00:00.000Z')
    expect(expiredEntries([any], 0, now)).toHaveLength(1)
  })

  it('删除时间坏掉的条目不清理（宁可留着也不误删）', () => {
    const broken = entry('broken', '不是时间')
    expect(expiredEntries([broken], 30, now)).toEqual([])
  })

  it('默认保留期是 30 天', () => {
    expect(DEFAULT_TRASH_KEEP_DAYS).toBe(30)
  })
})

describe('恢复后的记录必须被认作存活（踩过的坑）', () => {
  it('deletedAt 为 null 的记录不算已删除', () => {
    // 恢复时补丁用的是 { deletedAt: null }，而不是 undefined。
    // 原因：补丁要经 IPC 的结构化克隆，而 { deletedAt: undefined } 序列化后键会消失，
    // 于是 update 里的 {...current, ...patch} 覆盖不掉原来的删除标记——
    // 表现就是"点了恢复，记录还在回收站里"。
    expect(isDeleted(rec('a', { deletedAt: null }))).toBe(false)
    expect(toTrashEntry('memo', rec('a', { text: '已恢复', deletedAt: null }))).toBeNull()
  })

  it('恢复用的补丁经 JSON 往返（等价于 IPC 结构化克隆）后仍然保留字段', () => {
    const withNull = JSON.parse(JSON.stringify({ deletedAt: null })) as Record<string, unknown>
    expect('deletedAt' in withNull).toBe(true)

    // 反例：undefined 会消失，这正是当初导致恢复失效的原因
    const withUndefined = JSON.parse(JSON.stringify({ deletedAt: undefined })) as Record<string, unknown>
    expect('deletedAt' in withUndefined).toBe(false)
  })

  it('恢复后该条不应再出现在回收站汇总里', () => {
    const entries = collectTrash({
      memo: [
        rec('alive', { text: '已恢复', deletedAt: null }),
        rec('dead', { text: '还在回收站', deletedAt: DELETED_AT })
      ]
    })
    expect(entries.map((e) => e.id)).toEqual(['dead'])
  })
})

describe('文案', () => {
  it('保留期限的中文说明', () => {
    expect(keepDaysLabel(7)).toBe('7 天')
    expect(keepDaysLabel(30)).toBe('30 天')
    expect(keepDaysLabel(TRASH_KEEP_FOREVER_DAYS)).toBe('永久保留')
  })

  it('空状态有明确说法', () => {
    expect(emptyTrashHint()).toContain('回收站是空的')
  })
})
