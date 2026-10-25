/**
 * 阶段 6 测试：全局搜索（PRD §2.6 / §10.10 J1–J3）
 *
 * 验收要点：
 *   J1 一个词能同时搜到多个模块，结果按模块分组
 *   J3 能搜到书名、作者、摘录原文与想法
 *   H7 读书与学习是两个独立分组，互不合并
 */
import { describe, expect, it } from 'vitest'
import {
  HITS_PER_MODULE,
  SEARCH_MODULE_LABELS,
  matches,
  searchAll,
  summarizeGroups,
  totalHits,
  type SearchInput
} from '../../src/shared/search'

function planTask(id: string, title: string, extra: Record<string, unknown> = {}) {
  return {
    id,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    title,
    date: '2026-02-14',
    timeSlot: 'none',
    recurrence: 'none',
    done: false,
    carriedOver: 0,
    doneAt: null,
    ...extra
  }
}

function memo(id: string, text: string, extra: Record<string, unknown> = {}) {
  return {
    id,
    createdAt: '2026-02-01T09:00:00.000Z',
    updatedAt: '2026-02-01T09:00:00.000Z',
    text,
    pinned: false,
    ...extra
  }
}

function learningRecord(id: string, extra: Record<string, unknown>) {
  return {
    id,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...extra
  }
}

function reviewCard(id: string, front: string, back: string) {
  return {
    id,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    front,
    back,
    source: '英语长难句',
    stage: 0,
    dueDate: null,
    reviewCount: 0,
    lastReviewedAt: null
  }
}

function bookRecord(id: string, extra: Record<string, unknown>) {
  return {
    id,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    kind: 'book',
    title: '未命名',
    author: '',
    format: 'paper',
    status: 'reading',
    totalPages: 0,
    currentPage: 0,
    percent: 0,
    finishedAt: null,
    rating: 0,
    review: '',
    ...extra
  }
}

function excerpt(id: string, content: string, locator = 'p.1', type = 'quote') {
  return {
    id,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    kind: 'excerpt',
    bookId: 'b1',
    type,
    locator,
    content
  }
}

const SAMPLE: SearchInput = {
  plan: [planTask('p1', '复习英语长难句'), planTask('p2', '交周报')],
  memo: [memo('m1', '英语课的时间改到周三'), memo('m2', '物业电话 400-xxx')],
  learning: [
    learningRecord('t1', { kind: 'topic', title: '英语长难句', status: 'active', progress: 45 }),
    learningRecord('t2', { kind: 'topic', title: '数据结构', status: 'active', progress: 20 }),
    learningRecord('l1', {
      kind: 'log',
      topicId: 't1',
      date: '2026-02-14',
      minutes: 45,
      content: '把英语长难句第 3 章读完'
    })
  ],
  review: [reviewCard('c1', '英语定语从句的省略', '关系代词作宾语时可省略')],
  reading: [
    bookRecord('b1', { title: '英语在用', author: 'Raymond Murphy' }),
    bookRecord('b2', { title: '人类简史', author: '尤瓦尔·赫拉利' }),
    excerpt('e1', '英语的时态其实是一种视角')
  ]
}

describe('matches', () => {
  it('忽略大小写', () => {
    expect(matches('English Grammar', 'english')).toBe(true)
    expect(matches('english', 'ENGLISH')).toBe(true)
  })

  it('支持中文子串', () => {
    expect(matches('复习英语长难句', '长难句')).toBe(true)
  })

  it('空关键词不匹配任何东西', () => {
    expect(matches('任意文本', '')).toBe(false)
  })
})

describe('searchAll（J1：跨模块搜索并按模块分组）', () => {
  it('一个词同时命中多个模块', () => {
    const groups = searchAll(SAMPLE, '英语')
    const modules = groups.map((group) => group.module)
    expect(modules).toContain('plan')
    expect(modules).toContain('memo')
    expect(modules).toContain('learning')
    expect(modules).toContain('review')
    expect(modules).toContain('reading')
  })

  it('分组顺序固定：计划 → 备忘 → 学习 → 复习 → 读书', () => {
    const groups = searchAll(SAMPLE, '英语')
    expect(groups.map((group) => group.module)).toEqual([
      'plan',
      'memo',
      'learning',
      'review',
      'reading'
    ])
  })

  it('每个分组带中文标签', () => {
    const groups = searchAll(SAMPLE, '英语')
    for (const group of groups) {
      expect(group.label).toBe(SEARCH_MODULE_LABELS[group.module])
    }
  })

  it('空关键词返回空结果', () => {
    expect(searchAll(SAMPLE, '')).toEqual([])
    expect(searchAll(SAMPLE, '   ')).toEqual([])
  })

  it('搜不到时返回空数组', () => {
    expect(searchAll(SAMPLE, '完全不存在的内容')).toEqual([])
  })

  it('忽略软删除的记录', () => {
    const input: SearchInput = {
      memo: [
        memo('m1', '保留的备忘'),
        memo('m2', '被删掉的备忘', { deletedAt: '2026-02-14T00:00:00.000Z' })
      ]
    }
    const groups = searchAll(input, '备忘')
    expect(groups[0]?.hits.map((hit) => hit.id)).toEqual(['m1'])
  })

  it('单个模块命中过多时会被截断', () => {
    const many = Array.from({ length: 30 }, (_, index) => memo(`m${index}`, `关键词内容 ${index}`))
    const groups = searchAll({ memo: many }, '关键词')
    expect(groups[0]?.hits).toHaveLength(HITS_PER_MODULE)
  })
})

describe('searchAll 各模块的搜索字段', () => {
  it('计划：搜任务标题，元信息带日期与完成状态', () => {
    const groups = searchAll({ plan: [planTask('p1', '交周报', { done: true })] }, '周报')
    expect(groups[0]?.hits[0]?.title).toBe('交周报')
    expect(groups[0]?.hits[0]?.meta).toContain('已完成')
  })

  it('备忘：搜正文', () => {
    const groups = searchAll({ memo: [memo('m1', '物业电话 400-xxx-xxxx')] }, '物业')
    expect(groups[0]?.hits[0]?.title).toContain('物业电话')
  })

  it('学习：主题标题与学习日志内容都能搜到', () => {
    const groups = searchAll(SAMPLE, '数据结构')
    expect(groups[0]?.hits[0]?.meta).toContain('主题')

    const logGroups = searchAll(SAMPLE, '第 3 章')
    expect(logGroups[0]?.hits[0]?.meta).toContain('学习日志')
    expect(logGroups[0]?.hits[0]?.meta).toContain('45 分钟')
  })

  it('复习：正面与背面都能搜到', () => {
    const byFront = searchAll(SAMPLE, '定语从句')
    expect(byFront[0]?.hits).toHaveLength(1)

    const byBack = searchAll(SAMPLE, '关系代词')
    expect(byBack[0]?.hits).toHaveLength(1)
  })

  it('读书：书名能搜到（J3）', () => {
    const groups = searchAll(SAMPLE, '人类简史')
    expect(groups[0]?.module).toBe('reading')
    expect(groups[0]?.hits[0]?.title).toBe('人类简史')
  })

  it('读书：作者能搜到（J3）', () => {
    const groups = searchAll(SAMPLE, '赫拉利')
    expect(groups[0]?.module).toBe('reading')
    expect(groups[0]?.hits[0]?.title).toBe('人类简史')
    expect(groups[0]?.hits[0]?.meta).toContain('赫拉利')
  })

  it('读书：摘录原文能搜到（J3）', () => {
    const groups = searchAll(SAMPLE, '时态其实是一种视角')
    expect(groups[0]?.module).toBe('reading')
    expect(groups[0]?.hits[0]?.meta).toContain('摘录')
  })

  it('读书：想法也能搜到（J3）', () => {
    const input: SearchInput = {
      reading: [bookRecord('b1', { title: '某本书' }), excerpt('e2', '这里和第 3 章是同一个东西', 'p.98', 'thought')]
    }
    const groups = searchAll(input, '同一个东西')
    expect(groups[0]?.module).toBe('reading')
  })

  it('读书搜索不会返回"学习"分组（H7：两边独立）', () => {
    // 只有读书数据时，分组里不应出现 learning
    const groups = searchAll({ reading: SAMPLE.reading }, '英语')
    expect(groups.every((group) => group.module === 'reading')).toBe(true)
  })
})

describe('totalHits / summarizeGroups', () => {
  it('汇总总命中数', () => {
    const groups = searchAll(SAMPLE, '英语')
    expect(totalHits(groups)).toBe(groups.reduce((sum, group) => sum + group.hits.length, 0))
    expect(totalHits(groups)).toBeGreaterThan(0)
  })

  it('摘要文字包含每个分组的名称与条数', () => {
    const groups = searchAll(SAMPLE, '英语')
    const summary = summarizeGroups(groups)
    expect(summary).toContain('计划')
    expect(summary).toContain('读书')
  })

  it('没有结果时给出明确说法', () => {
    expect(summarizeGroups([])).toBe('没有找到匹配的内容')
  })
})

describe('边界情况', () => {
  it('空输入不会抛错', () => {
    expect(() => searchAll({}, '任意')).not.toThrow()
    expect(searchAll({}, '任意')).toEqual([])
  })

  it('记录缺字段时被跳过而不是崩掉', () => {
    const groups = searchAll(
      {
        plan: [{ id: '', title: '没有 id' }, planTask('ok', '有点内容的标题')],
        memo: [{ id: 'm', text: '' }]
      },
      '内容'
    )
    expect(groups).toHaveLength(1)
    expect(groups[0]?.hits).toHaveLength(1)
  })

  it('关键词首尾空格会被忽略', () => {
    const groups = searchAll(SAMPLE, '  英语  ')
    expect(groups.length).toBeGreaterThan(0)
  })
})
