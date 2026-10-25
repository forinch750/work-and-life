/**
 * 阶段 6 测试：读书模块（PRD §5.5 / §10.8 H1–H7）
 */
import { describe, expect, it } from 'vitest'
import {
  applyProgressUpdate,
  coverHue,
  coverInitial,
  excerptToCard,
  finishPatch,
  formatMinutes,
  groupShelf,
  normalizeReadingRecord,
  progressLabel,
  progressPercent,
  shelfStats,
  sortExcerpts,
  type Book,
  type Excerpt,
  type ReadingProgress
} from '../../src/shared/reading'

function book(overrides: Partial<Book> = {}): Book {
  return {
    id: 'b1',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    kind: 'book',
    title: '深入理解计算机系统',
    author: 'Randal Bryant',
    format: 'paper',
    status: 'reading',
    totalPages: 320,
    currentPage: 128,
    percent: 0,
    finishedAt: null,
    rating: 0,
    review: '',
    ...overrides
  }
}

describe('progressLabel（H1 / H3：纸质按页、电子按百分比）', () => {
  it('纸质书显示 当前页/总页数', () => {
    expect(progressLabel(book({ currentPage: 128, totalPages: 320 }))).toBe('128/320 页')
  })

  it('电子书显示百分比', () => {
    expect(progressLabel(book({ format: 'ebook', percent: 32 }))).toBe('32%')
  })

  it('纸质书没填总页数时只显示当前页', () => {
    expect(progressLabel(book({ currentPage: 50, totalPages: 0 }))).toBe('第 50 页')
    expect(progressLabel(book({ currentPage: 0, totalPages: 0 }))).toBe('未开始')
  })
})

describe('progressPercent', () => {
  it('纸质书按页数换算', () => {
    expect(progressPercent(book({ currentPage: 128, totalPages: 320 }))).toBe(40)
    expect(progressPercent(book({ currentPage: 320, totalPages: 320 }))).toBe(100)
    expect(progressPercent(book({ currentPage: 0, totalPages: 320 }))).toBe(0)
  })

  it('电子书直接取百分比', () => {
    expect(progressPercent(book({ format: 'ebook', percent: 88 }))).toBe(88)
  })

  it('没有总页数但已读到某页时视为 100%', () => {
    expect(progressPercent(book({ totalPages: 0, currentPage: 10 }))).toBe(100)
  })

  it('结果始终落在 0–100', () => {
    expect(progressPercent(book({ currentPage: 999, totalPages: 320 }))).toBe(100)
    expect(progressPercent(book({ format: 'ebook', percent: 999 }))).toBe(100)
  })
})

describe('applyProgressUpdate（H2：更新进度并保存）', () => {
  it('纸质书只改当前页，不动百分比', () => {
    const patch = applyProgressUpdate(book({ format: 'paper', percent: 50 }), { page: 200 })
    expect(patch).toEqual({ currentPage: 200 })
    expect('percent' in patch).toBe(false)
  })

  it('电子书只改百分比，不动页数', () => {
    const patch = applyProgressUpdate(book({ format: 'ebook', currentPage: 100 }), { percent: 45 })
    expect(patch).toEqual({ percent: 45 })
    expect('currentPage' in patch).toBe(false)
  })

  it('纸质书页码不会超过总页数', () => {
    expect(applyProgressUpdate(book({ totalPages: 320 }), { page: 9999 })).toEqual({ currentPage: 320 })
  })

  it('电子书百分比夹在 0–100', () => {
    expect(applyProgressUpdate(book({ format: 'ebook' }), { percent: -10 })).toEqual({ percent: 0 })
    expect(applyProgressUpdate(book({ format: 'ebook' }), { percent: 999 })).toEqual({ percent: 100 })
  })

  it('不传新值时不改变任何东西', () => {
    expect(applyProgressUpdate(book({ currentPage: 128 }), {})).toEqual({ currentPage: 128 })
  })
})

describe('finishPatch（H6：标记读完）', () => {
  it('同时写入状态、日期、评分与总评', () => {
    const patch = finishPatch('2026-02-14', 5, '  值得反复读  ')
    expect(patch).toEqual({
      status: 'finished',
      finishedAt: '2026-02-14',
      rating: 5,
      review: '值得反复读'
    })
  })

  it('评分夹在 0–5', () => {
    expect(finishPatch('2026-02-14', 9, '').rating).toBe(5)
    expect(finishPatch('2026-02-14', -1, '').rating).toBe(0)
  })
})

describe('封面生成（纯色块 + 首字）', () => {
  it('取书名首字', () => {
    expect(coverInitial('深入理解计算机系统')).toBe('深')
    expect(coverInitial('  Design  ')).toBe('D')
    expect(coverInitial('')).toBe('书')
  })

  it('同一书名每次得到同一个色相', () => {
    expect(coverHue('人类简史')).toBe(coverHue('人类简史'))
    expect(coverHue('人类简史')).toBeGreaterThanOrEqual(0)
    expect(coverHue('人类简史')).toBeLessThan(360)
  })
})

describe('groupShelf（书架分组）', () => {
  it('按状态分成三组', () => {
    const groups = groupShelf([
      book({ id: 'a', status: 'reading' }),
      book({ id: 'b', status: 'want' }),
      book({ id: 'c', status: 'finished' }),
      book({ id: 'd', status: 'reading' })
    ])
    expect(groups.reading.map((item) => item.id).sort()).toEqual(['a', 'd'])
    expect(groups.want.map((item) => item.id)).toEqual(['b'])
    expect(groups.finished.map((item) => item.id)).toEqual(['c'])
  })

  it('组内按最近更新倒序', () => {
    const groups = groupShelf([
      book({ id: 'old', status: 'reading', updatedAt: '2026-01-01T00:00:00.000Z' }),
      book({ id: 'new', status: 'reading', updatedAt: '2026-03-01T00:00:00.000Z' })
    ])
    expect(groups.reading.map((item) => item.id)).toEqual(['new', 'old'])
  })

  it('只有三个状态，没有"搁置"', () => {
    const groups = groupShelf([])
    expect(Object.keys(groups).sort()).toEqual(['finished', 'reading', 'want'])
  })
})

describe('shelfStats', () => {
  it('统计在读、想读、读完、本月读完与本月时长', () => {
    const books = [
      book({ id: 'a', status: 'reading' }),
      book({ id: 'b', status: 'want' }),
      book({ id: 'c', status: 'finished', finishedAt: '2026-02-10' }),
      book({ id: 'd', status: 'finished', finishedAt: '2026-01-20' })
    ]
    const progress: ReadingProgress[] = [
      {
        id: 'p1',
        createdAt: 'x',
        updatedAt: 'x',
        kind: 'progress',
        bookId: 'a',
        date: '2026-02-14',
        minutes: 45
      },
      {
        id: 'p2',
        createdAt: 'x',
        updatedAt: 'x',
        kind: 'progress',
        bookId: 'a',
        date: '2026-02-11',
        minutes: 30
      },
      {
        id: 'p3',
        createdAt: 'x',
        updatedAt: 'x',
        kind: 'progress',
        bookId: 'a',
        date: '2026-01-05',
        minutes: 60
      }
    ]
    const stats = shelfStats(books, progress, '2026-02')
    expect(stats.reading).toBe(1)
    expect(stats.want).toBe(1)
    expect(stats.finished).toBe(2)
    expect(stats.finishedThisMonth).toBe(1)
    expect(stats.minutesThisMonth).toBe(75)
  })
})

describe('formatMinutes', () => {
  it('按小时与分钟可读显示', () => {
    expect(formatMinutes(0)).toBe('0 分钟')
    expect(formatMinutes(45)).toBe('45 分钟')
    expect(formatMinutes(60)).toBe('1 小时')
    expect(formatMinutes(500)).toBe('8 小时 20 分')
  })
})

describe('sortExcerpts（H4：摘录与想法同列，按页码倒序）', () => {
  it('按定位数字倒序', () => {
    const excerpts: Excerpt[] = [
      { id: 'a', createdAt: 'x', updatedAt: 'x', kind: 'excerpt', bookId: 'b1', type: 'quote', locator: 'p.98', content: 'A' },
      { id: 'b', createdAt: 'x', updatedAt: 'x', kind: 'excerpt', bookId: 'b1', type: 'thought', locator: 'p.112', content: 'B' },
      { id: 'c', createdAt: 'x', updatedAt: 'x', kind: 'excerpt', bookId: 'b1', type: 'quote', locator: '32%', content: 'C' }
    ]
    expect(sortExcerpts(excerpts).map((item) => item.id)).toEqual(['b', 'a', 'c'])
  })

  it('原文与想法一起排序，不分开', () => {
    const excerpts: Excerpt[] = [
      { id: 'quote', createdAt: 'x', updatedAt: 'x', kind: 'excerpt', bookId: 'b1', type: 'quote', locator: 'p.10', content: 'Q' },
      { id: 'thought', createdAt: 'x', updatedAt: 'x', kind: 'excerpt', bookId: 'b1', type: 'thought', locator: 'p.20', content: 'T' }
    ]
    expect(sortExcerpts(excerpts).map((item) => item.id)).toEqual(['thought', 'quote'])
  })

  it('没有数字的定位排最后', () => {
    const excerpts: Excerpt[] = [
      { id: 'none', createdAt: 'x', updatedAt: 'x', kind: 'excerpt', bookId: 'b1', type: 'quote', locator: '开篇', content: 'X' },
      { id: 'page', createdAt: 'x', updatedAt: 'x', kind: 'excerpt', bookId: 'b1', type: 'quote', locator: 'p.5', content: 'Y' }
    ]
    expect(sortExcerpts(excerpts).map((item) => item.id)).toEqual(['page', 'none'])
  })
})

describe('excerptToCard（H5：摘录 → 复习卡）', () => {
  it('原文摘录：正面是原文，背面标出处', () => {
    const card = excerptToCard(
      { id: 'e1', createdAt: 'x', updatedAt: 'x', kind: 'excerpt', bookId: 'b1', type: 'quote', locator: 'p.112', content: '系统是由硬件与软件组成的' },
      '深入理解计算机系统'
    )
    expect(card.front).toBe('系统是由硬件与软件组成的')
    expect(card.back).toContain('深入理解计算机系统')
    expect(card.back).toContain('p.112')
    expect(card.source).toBe('深入理解计算机系统')
  })

  it('想法：正面带上书名与定位，便于脱离上下文也能理解', () => {
    const card = excerptToCard(
      { id: 'e2', createdAt: 'x', updatedAt: 'x', kind: 'excerpt', bookId: 'b1', type: 'thought', locator: 'p.98', content: '这里和第 3 章是同一个东西' },
      '深入理解计算机系统'
    )
    expect(card.front).toContain('深入理解计算机系统')
    expect(card.front).toContain('p.98')
    expect(card.front).toContain('这里和第 3 章是同一个东西')
    expect(card.source).toBe('深入理解计算机系统')
  })
})

describe('normalizeReadingRecord', () => {
  it('识别 book 并补齐默认值', () => {
    const result = normalizeReadingRecord({ id: 'x', kind: 'book', title: ' 人类简史 ' })
    expect(result?.kind).toBe('book')
    if (result?.kind === 'book') {
      expect(result.title).toBe('人类简史')
      expect(result.format).toBe('paper')
      expect(result.status).toBe('want')
      expect(result.rating).toBe(0)
      expect(result.finishedAt).toBeNull()
    }
  })

  it('非法状态与格式回退', () => {
    const result = normalizeReadingRecord({ id: 'x', kind: 'book', status: '搁置', format: '音频' })
    if (result?.kind === 'book') {
      expect(result.status).toBe('want')
      expect(result.format).toBe('paper')
    } else {
      throw new Error('应当识别为 book')
    }
  })

  it('识别 progress：只写页数时不带 fromPage/toPage 之外的多余字段', () => {
    const result = normalizeReadingRecord({
      id: 'x',
      kind: 'progress',
      bookId: 'b1',
      date: '2026-02-14',
      minutes: 45,
      fromPage: 100,
      toPage: 128
    })
    if (result?.kind === 'progress') {
      expect(result.fromPage).toBe(100)
      expect(result.toPage).toBe(128)
      expect(result.percent).toBeUndefined()
    } else {
      throw new Error('应当识别为 progress')
    }
  })

  it('识别 excerpt，type 非 quote 一律按 thought', () => {
    const result = normalizeReadingRecord({
      id: 'x',
      kind: 'excerpt',
      bookId: 'b1',
      type: '随手写的',
      locator: 'p.10',
      content: '想法'
    })
    if (result?.kind === 'excerpt') {
      expect(result.type).toBe('thought')
      expect(result.content).toBe('想法')
    } else {
      throw new Error('应当识别为 excerpt')
    }
  })

  it('未知 kind 或缺少 id 返回 null', () => {
    expect(normalizeReadingRecord({ id: 'x', kind: '未知' })).toBeNull()
    expect(normalizeReadingRecord({ kind: 'book' })).toBeNull()
  })

  it('tags 会过滤掉空字符串', () => {
    const result = normalizeReadingRecord({ id: 'x', kind: 'book', tags: ['技术', '', '  '] })
    if (result?.kind === 'book') {
      expect(result.tags).toEqual(['技术'])
    }
  })
})
