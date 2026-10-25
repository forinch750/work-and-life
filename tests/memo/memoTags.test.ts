/**
 * 第 06 块测试：备忘标签（FEAT-004）
 *
 * 已定决定：**只做标签，不做文件夹**。"标签筛选"要满足三件事，
 * 都有这条单测盯着（`docs\TASKS\06` §6.2 的"标签筛选：命中 / 不命中 / 多标签"）：
 *   - 命中：选了某个标签，带这个标签的备忘必须出现
 *   - 不命中：没带的必须消失；选一个不存在的标签 → 空结果（而不是"全返回"）
 *   - 多标签：多选是"命中任意一个"（OR），不是"必须全中"
 */
import { describe, expect, it } from 'vitest'
import { filterMemosByTags, normalizeMemoRecord, normalizeTags, tagCounts } from '../../src/shared/memo'

function memo(id: string, tags?: string[]): ReturnType<typeof normalizeMemoRecord> {
  return normalizeMemoRecord({ id, text: `备忘 ${id}`, ...(tags ? { tags } : {}) })
}

const LIST = [
  memo('a', ['工作']),
  memo('b', ['生活']),
  memo('c', ['工作', '待办']),
  memo('d')
].filter((item) => item !== null)

describe('normalizeTags', () => {
  it('去空、去重、保持原顺序', () => {
    expect(normalizeTags([' 工作 ', '工作', '', '  ', '生活'])).toEqual(['工作', '生活'])
  })

  it('非数组与非字符串项一律丢掉', () => {
    expect(normalizeTags(undefined)).toEqual([])
    expect(normalizeTags('工作')).toEqual([])
    expect(normalizeTags([1, '工作', null, {}])).toEqual(['工作'])
  })
})

describe('filterMemosByTags（工具条筛选）', () => {
  it('没选标签 = 不筛，返回全部', () => {
    expect(filterMemosByTags(LIST, []).map((item) => item.id)).toEqual(['a', 'b', 'c', 'd'])
  })

  it('命中：选中「工作」时，带这个标签的都出现', () => {
    expect(filterMemosByTags(LIST, ['工作']).map((item) => item.id)).toEqual(['a', 'c'])
  })

  it('不命中：没这个标签的不出现；不存在的标签返回空', () => {
    const hit = filterMemosByTags(LIST, ['生活']).map((item) => item.id)
    expect(hit).toEqual(['b'])
    expect(hit).not.toContain('a')
    expect(filterMemosByTags(LIST, ['不存在的标签'])).toEqual([])
  })

  it('多标签是"命中任意一个"（OR）：多选反而看得更多', () => {
    expect(filterMemosByTags(LIST, ['工作', '生活']).map((item) => item.id)).toEqual([
      'a',
      'b',
      'c'
    ])
    // 只选一个时的结果是多选结果的子集
    const single = filterMemosByTags(LIST, ['工作']).map((item) => item.id)
    const both = filterMemosByTags(LIST, ['工作', '生活']).map((item) => item.id)
    expect(single.every((id) => both.includes(id))).toBe(true)
  })

  it('一条备忘带多个标签时，选其中任意一个都能命中', () => {
    expect(filterMemosByTags(LIST, ['待办']).map((item) => item.id)).toEqual(['c'])
  })

  it('空标签 / 重复标签被规范化掉，不影响结果', () => {
    expect(filterMemosByTags(LIST, ['', '  ', '工作', '工作']).map((item) => item.id)).toEqual([
      'a',
      'c'
    ])
  })

  it('筛选不改变传入顺序（置顶仍在最前）', () => {
    const ordered = [memo('p1', ['工作']), memo('p2', ['工作']), memo('x', ['生活'])]
      .filter((item) => item !== null)
    expect(filterMemosByTags(ordered, ['工作']).map((item) => item.id)).toEqual(['p1', 'p2'])
  })
})

describe('tagCounts（工具条的筛选项）', () => {
  it('统计每个标签的出现次数，多的在前，同数量按名字', () => {
    expect(tagCounts(LIST)).toEqual([
      { tag: '工作', count: 2 },
      { tag: '待办', count: 1 },
      { tag: '生活', count: 1 }
    ])
  })

  it('没有标签时返回空数组', () => {
    expect(tagCounts([memo('only')].filter((item) => item !== null))).toEqual([])
  })
})

describe('备忘的标签落库形状（零改写原则）', () => {
  it('没有 tags 字段的旧记录读出来就是"没有标签"（不写空数组）', () => {
    const parsed = normalizeMemoRecord({ id: 'old', text: '旧备忘' })
    expect(parsed?.tags).toBeUndefined()
    expect(filterMemosByTags([parsed!], [])).toHaveLength(1)
  })

  it('脏数据（字符串 / 空数组 / 带空白）也能读', () => {
    expect(normalizeMemoRecord({ id: 'm1', text: 'x', tags: [] })?.tags).toBeUndefined()
    expect(normalizeMemoRecord({ id: 'm2', text: 'x', tags: 'oops' })?.tags).toBeUndefined()
    expect(normalizeMemoRecord({ id: 'm3', text: 'x', tags: [' 工作 ', ''] })?.tags).toEqual(['工作'])
  })
})
