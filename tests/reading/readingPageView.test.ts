/**
 * 第 11 块（读书页重构）的视图计算单测
 *
 * 覆盖 `docs\TASKS\11` §7.2 要求新增的四条，外加本块新写的那些口径：
 *
 *   1. **书内进度 = 读完的章 / 总章数；页码不影响进度**（关键回归）
 *   2. **三档状态**（想读 / 在读 / 读完）的判定与显示
 *   3. **摘录不在树里**（树节点集合不含摘录类记录）
 *   4. **缩进规则**（第 5 层起 12px）
 *
 * vitest 是 `environment: 'node'`（没有 jsdom、也不许引），所以这里只测纯函数；
 * 组件行为（中区两块内部滚、页面级无滚动条、点章节就地展开…）由端到端验收覆盖
 * —— `src\main\verify\phase8.ts` 的 `P8-V1…V8`。
 */
import { describe, expect, it } from 'vitest'
import {
  chapterProgress,
  normalizeReadingRecord,
  progressLabel,
  type Book,
  type ReadingNode
} from '../../src/shared/reading'
import {
  bookPercent,
  bookPreviewFacts,
  chapterProgressText,
  chapterRowProgress,
  chapterStats,
  excerptCounts,
  excerptTypeLabel,
  excerptsOfBook,
  formatLabel,
  isBookEntered,
  lastReadSpot,
  nodesOfBook,
  normalizeStatus,
  pageReferenceText,
  readingIndent,
  readingTreeNodes,
  recordOwnerText,
  recordPagesText,
  recordsOfBook,
  recordsOfChapter,
  recordsSummary,
  shelfMetaText,
  shelfRows,
  spotNote,
  statusLabel,
  type ReadingViewNode,
  type ReadingViewRecord
} from '../../src/shared/readingPageView'
import { indentForDepth, treeProgress } from '../../src/shared/treeProgress'

function node(
  id: string,
  parentId: string | null,
  done: boolean,
  extra: Partial<ReadingViewNode> = {}
): ReadingViewNode {
  return { id, ownerId: 'b1', parentId, title: id, done, ...extra }
}

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

function record(id: string, overrides: Partial<ReadingViewRecord> = {}): ReadingViewRecord {
  return { id, bookId: 'b1', date: '2026-10-01', minutes: 30, ...overrides }
}

/** 定稿图里那棵树：第 1 章是最小单元（勾了）；第 2 章有子章 → 汇总，不进分母 */
const TREE: ReadingViewNode[] = [
  node('ch1', null, true),
  node('ch2', null, false),
  node('2.1', 'ch2', false)
]

// ===========================================================================
// 1. 书内进度 = 读完的章 / 总章数；页码不影响进度（关键回归）
// ===========================================================================

describe('书内进度：读完的章 / 总章数（页码只作参考）', () => {
  it('只数最小单元：汇总章节不进分母', () => {
    // ch1（勾）、2.1（未勾）是叶子；ch2 有子节点 → 汇总，不计入
    expect(chapterStats(TREE)).toEqual({ done: 1, total: 2, percent: 50 })
  })

  it('与 02 块的公共实现逐例一致（不在这里写第二份公式）', () => {
    expect(chapterStats(TREE)).toEqual(chapterProgress(TREE as unknown as ReadingNode[]))
    expect(chapterStats([])).toEqual(chapterProgress([] as ReadingNode[]))
  })

  it('随机 100 棵树：读书页的数与 treeProgress 完全相同', () => {
    // 固定序列的伪随机（不依赖 Math.random，失败可复现）
    let seed = 20261011
    const next = (max: number): number => {
      seed = (seed * 1103515245 + 12345) % 2147483648
      return seed % max
    }
    for (let round = 0; round < 100; round += 1) {
      const count = 1 + next(12)
      const nodes: ReadingViewNode[] = []
      for (let index = 0; index < count; index += 1) {
        const parentId = index === 0 ? null : nodes[next(index)].id
        nodes.push(node(`n${index}`, parentId, next(2) === 1))
      }
      expect(chapterStats(nodes)).toEqual(treeProgress(nodes))
    }
  })

  it('【关键回归】把页码改大，进度一个数都不动', () => {
    const before = bookPercent(TREE)
    expect(before).toBe(50)

    // 页码那一行确实变了……
    const readings = [0, 128, 320].map((currentPage) =>
      progressLabel(book({ currentPage, totalPages: 320 }))
    )
    expect(readings).toEqual(['0/320 页', '128/320 页', '320/320 页'])

    // ……但进度条一格都没动（这是本块最要紧的一条回归）
    expect(bookPercent(TREE)).toBe(before)
    // 电子书的百分比同理：它只影响"读到哪了"那一行
    expect(pageReferenceText(book({ format: 'ebook', percent: 99 }))).toBe('99%')
    expect(bookPercent(TREE)).toBe(before)
    expect(chapterProgressText(chapterStats(TREE))).toBe('1/2 章 · 50%')
  })

  it('页码显示 ≠ 进度：读到 320/320 页，但章节一章没勾 → 0%', () => {
    const noDone = [node('ch1', null, false), node('ch2', null, false)]
    const full = book({ currentPage: 320, totalPages: 320 })
    expect(progressLabel(full)).toBe('320/320 页')
    expect(bookPercent(noDone)).toBe(0)
  })

  it('章节全勾就是 100%；一章都没有是 0%（不能是 NaN）', () => {
    expect(bookPercent([node('a', null, true), node('b', null, true)])).toBe(100)
    expect(chapterStats([])).toEqual({ done: 0, total: 0, percent: 0 })
  })

  it('进度显示就是"n/m 章 · p%"，同一个数三处共用', () => {
    const stats = chapterStats(TREE)
    expect(chapterProgressText(stats)).toBe('1/2 章 · 50%')
    expect(chapterProgressText(stats)).toContain(`${stats.percent}%`)
    expect(chapterProgressText(stats)).toContain(`${stats.done}/${stats.total}`)
  })
})

// ===========================================================================
// 2. 三档状态（想读 / 在读 / 读完）的判定与显示
// ===========================================================================

describe('三档状态：想读 / 在读 / 读完', () => {
  it('三档各有自己的显示文字', () => {
    expect(statusLabel('want')).toBe('想读')
    expect(statusLabel('reading')).toBe('在读')
    expect(statusLabel('finished')).toBe('读完')
  })

  it('非法 / 缺省状态一律归到「想读」（与 normalizeReadingRecord 同口径）', () => {
    expect(normalizeStatus('搁置')).toBe('want')
    expect(normalizeStatus(undefined)).toBe('want')
    expect(normalizeStatus('')).toBe('want')
    expect(statusLabel('搁置')).toBe('想读')
  })

  it('左栏排序：在读 → 想读 → 读完，组内按最近更新倒序', () => {
    const rows = shelfRows([
      { id: 'f1', status: 'finished' as const, updatedAt: '2026-03-01' },
      { id: 'r-old', status: 'reading' as const, updatedAt: '2026-01-01' },
      { id: 'w1', status: 'want' as const, updatedAt: '2026-02-01' },
      { id: 'r-new', status: 'reading' as const, updatedAt: '2026-04-01' }
    ])
    expect(rows.map((row) => row.id)).toEqual(['r-new', 'r-old', 'w1', 'f1'])
  })

  it('三档一本书都不会丢（数量守恒）', () => {
    const books = [
      { id: 'a', status: 'want' as const },
      { id: 'b', status: 'reading' as const },
      { id: 'c', status: 'finished' as const }
    ]
    expect(shelfRows(books)).toHaveLength(books.length)
  })

  it('书架行副标题 = `状态 · 按章节算的百分比`', () => {
    expect(shelfMetaText({ status: 'reading' }, TREE)).toBe('在读 · 50%')
    expect(shelfMetaText({ status: 'want' }, [])).toBe('想读 · 0%')
    expect(shelfMetaText({ status: 'finished' }, [node('a', null, true)])).toBe('读完 · 100%')
  })

  it('格式显示', () => {
    expect(formatLabel(book())).toBe('纸质书')
    expect(formatLabel(book({ format: 'ebook' }))).toBe('电子书')
  })
})

// ===========================================================================
// 3. 摘录与想法**不在**树里（决定 24）
// ===========================================================================

describe('摘录与想法不进树（决定 24）', () => {
  const records: Array<Record<string, unknown>> = [
    { id: 'b1', kind: 'book', title: '书' },
    { id: 'n1', kind: 'node', ownerId: 'b1', parentId: null, order: 0, title: '第1章', done: true },
    { id: 'n2', kind: 'node', ownerId: 'b1', parentId: 'n1', order: 0, title: '1.1', done: false },
    {
      id: 'e1',
      kind: 'excerpt',
      bookId: 'b1',
      type: 'quote',
      locator: 'p.11',
      content: '摘录正文'
    },
    {
      id: 'e2',
      kind: 'excerpt',
      bookId: 'b1',
      type: 'thought',
      locator: 'p.12',
      content: '想法正文'
    },
    { id: 'p1', kind: 'progress', bookId: 'b1', date: '2026-10-01', minutes: 30, toPage: 128 }
  ]

  it('树里只有章节：book / progress / excerpt 一个都不进来', () => {
    const nodes = readingTreeNodes(records)
    expect(nodes.map((item) => item.id)).toEqual(['n1', 'n2'])
    expect(nodes.every((item) => item.kind === 'node')).toBe(true)
  })

  it('摘录正文不会出现在树的任何节点上', () => {
    const nodes = readingTreeNodes(records)
    const dump = JSON.stringify(nodes)
    expect(dump.includes('摘录正文')).toBe(false)
    expect(dump.includes('想法正文')).toBe(false)
  })

  it('【关键回归】没有章节时，树是空的——不会退化成"把摘录当叶子"', () => {
    const onlyExcerpts = records.filter((item) => item.kind !== 'node')
    expect(readingTreeNodes(onlyExcerpts)).toEqual([])
    // 只算摘录的话进度会是 0/0 → 0%，而它本来就不该参与计数
    expect(chapterStats(readingTreeNodes(onlyExcerpts))).toEqual({ done: 0, total: 0, percent: 0 })
  })

  it('摘录留在中区列表里：按页码倒序，原文 / 想法同列', () => {
    const excerpts = [
      { id: 'e1', bookId: 'b1', type: 'quote' as const, locator: 'p.11', content: 'A' },
      { id: 'e2', bookId: 'b1', type: 'thought' as const, locator: 'p.98', content: 'B' },
      { id: 'e3', bookId: 'b2', type: 'quote' as const, locator: 'p.200', content: 'C' }
    ]
    expect(excerptsOfBook(excerpts, 'b1').map((item) => item.id)).toEqual(['e2', 'e1'])
    expect(excerptsOfBook(excerpts, '').length).toBe(0)
  })

  it('摘录计数写成 `原文 / 想法`', () => {
    expect(excerptCounts([]).text).toBe('0 / 0')
    expect(
      excerptCounts([
        { id: 'a', bookId: 'b1', type: 'quote', locator: '', content: '' },
        { id: 'b', bookId: 'b1', type: 'quote', locator: '', content: '' },
        { id: 'c', bookId: 'b1', type: 'thought', locator: '', content: '' }
      ])
    ).toEqual({ quotes: 2, thoughts: 1, text: '2 / 1' })
    expect(excerptTypeLabel('quote')).toBe('原文')
    expect(excerptTypeLabel('thought')).toBe('想法')
  })
})

// ===========================================================================
// 4. 缩进规则：第 5 层起 12px
// ===========================================================================

describe('树的缩进：第 5 层起 12px', () => {
  it('第 1–4 层每层 20px', () => {
    expect(readingIndent(0)).toBe(0)
    expect(readingIndent(1)).toBe(20)
    expect(readingIndent(2)).toBe(40)
    expect(readingIndent(3)).toBe(60)
    expect(readingIndent(4)).toBe(80)
  })

  it('第 5 层起每层 12px（层数不限）', () => {
    expect(readingIndent(5)).toBe(92)
    expect(readingIndent(6)).toBe(104)
    expect(readingIndent(9)).toBe(140)
  })

  it('与公共实现一致（页面里不许再写 depth * 20）', () => {
    for (let depth = 0; depth < 20; depth += 1) {
      expect(readingIndent(depth)).toBe(indentForDepth(depth))
    }
  })

  it('第 4→5 层的增量是 12、第 3→4 层是 20（钉住收窄发生的那一层）', () => {
    expect(readingIndent(4) - readingIndent(3)).toBe(20)
    expect(readingIndent(5) - readingIndent(4)).toBe(12)
    expect(readingIndent(6) - readingIndent(5)).toBe(12)
  })

  it('负数 / 小数深度不会算出负数缩进', () => {
    expect(readingIndent(-3)).toBe(0)
    expect(readingIndent(2.8)).toBe(40)
  })
})

// ===========================================================================
// 预览区那六行 / 中区两块 / 章节面板（本块新定义的口径）
// ===========================================================================

describe('预览区信息（作者 / 格式 / 读到 / 章节 / 记录 / 摘录）', () => {
  it('六行都算得出来，章节那一行与进度条同源', () => {
    const facts = bookPreviewFacts(
      book(),
      TREE,
      [record('r1', { minutes: 45, toPage: 128 }), record('r2', { minutes: 30 })],
      [
        { id: 'e1', bookId: 'b1', type: 'quote', locator: 'p.11', content: '' },
        { id: 'e2', bookId: 'b1', type: 'thought', locator: 'p.9', content: '' },
        { id: 'e3', bookId: 'b1', type: 'quote', locator: 'p.20', content: '' }
      ]
    )
    expect(facts.author).toBe('Randal Bryant')
    expect(facts.format).toBe('纸质书')
    expect(facts.pages).toBe('128/320 页')
    expect(facts.chapters).toBe('1/2 章')
    expect(facts.percent).toBe(bookPercent(TREE))
    expect(facts.records).toBe('2 次 · 75 分钟')
    expect(facts.notes).toBe('2 / 1')
  })

  it('没填作者时写「未填作者」，不留空', () => {
    expect(bookPreviewFacts(book({ author: '   ' }), [], [], []).author).toBe('未填作者')
  })

  it('页码那一行：纸质按页、电子按百分比', () => {
    expect(pageReferenceText(book())).toBe('128/320 页')
    expect(pageReferenceText(book({ format: 'ebook', percent: 32 }))).toBe('32%')
  })

  it('进度条下面那句提示把"页码只作参考"说出来', () => {
    const records = [record('r1', { toPage: 128 }), record('r2', { date: '2026-09-01', toPage: 90 })]
    expect(lastReadSpot(records)).toBe('上次读到 128 页')
    expect(spotNote(records)).toContain('页码只作参考，完成度按章节算')
    expect(spotNote(records)).toContain('上次读到 128 页')
    expect(spotNote([])).toBe('页码只作参考，完成度按章节算')
    expect(lastReadSpot([record('e', { percent: 32 })])).toBe('上次读到 32%')
    expect(lastReadSpot([])).toBe('')
  })
})

describe('中区两块：阅读记录 / 摘录与想法', () => {
  it('记录按日期倒序，且只取这本书的', () => {
    const records = [
      record('old', { date: '2026-09-01' }),
      record('new', { date: '2026-10-09' }),
      record('mid', { date: '2026-10-05' }),
      record('other', { bookId: 'b2', date: '2026-10-10' })
    ]
    expect(recordsOfBook(records, 'b1').map((item) => item.id)).toEqual(['new', 'mid', 'old'])
    expect(recordsOfBook(records, '').length).toBe(0)
  })

  it('「该章的阅读记录」只取挂在这一章上的那几条', () => {
    const records = [
      record('book-level', { date: '2026-10-09' }),
      record('on-ch1', { date: '2026-10-05', nodeId: 'ch1' }),
      record('on-ch2', { date: '2026-10-06', nodeId: 'ch2' }),
      record('on-ch1-new', { date: '2026-10-08', nodeId: 'ch1' })
    ]
    expect(recordsOfChapter(records, 'ch1').map((item) => item.id)).toEqual(['on-ch1-new', 'on-ch1'])
    expect(recordsOfChapter(records, 'nope')).toEqual([])
    expect(recordsOfChapter(records, '')).toEqual([])
  })

  it('页码范围三种写法：区间 / 只读到 / 百分比', () => {
    expect(recordPagesText({ fromPage: 100, toPage: 128 })).toBe('100–128 页')
    expect(recordPagesText({ fromPage: 0, toPage: 128 })).toBe('读到 128 页')
    expect(recordPagesText({ percent: 32 })).toBe('32%')
    expect(recordPagesText({})).toBe('')
  })

  it('记录行会标出"挂在哪一章"，书级记录不标', () => {
    const nodes = [node('ch1', null, true, { title: '第 1 章' })]
    expect(recordOwnerText(record('r', { nodeId: 'ch1' }), nodes)).toBe('挂在「第 1 章」')
    expect(recordOwnerText(record('r'), nodes)).toBe('')
    expect(recordOwnerText(record('r', { nodeId: 'missing' }), nodes)).toBe('')
  })

  it('阅读记录汇总：次数与总时长', () => {
    expect(recordsSummary([]).text).toBe('0 次 · 0 分钟')
    expect(
      recordsSummary([
        record('a', { minutes: 45 }),
        record('b', { minutes: 30 }),
        record('c', { minutes: 0 })
      ]).text
    ).toBe('3 次 · 75 分钟')
  })

  it('这本书的章节树按 ownerId 过滤', () => {
    const nodes = [
      node('a', null, true, { ownerId: 'b1' }),
      node('b', null, true, { ownerId: 'b2' })
    ]
    expect(nodesOfBook(nodes, 'b1').map((item) => item.id)).toEqual(['a'])
    expect(nodesOfBook(nodes, '')).toEqual([])
  })
})

describe('树行右侧的补充信息', () => {
  it('汇总章节显示"下面勾了几个"，最小单元显示自己的页码', () => {
    const nodes = [
      node('ch1', null, true, { note: 'p.128' }),
      node('ch2', null, false),
      node('2.1', 'ch2', true),
      node('2.2', 'ch2', false)
    ]
    expect(chapterRowProgress(nodes[0], nodes)).toBe('读到 p.128')
    expect(chapterRowProgress(nodes[1], nodes)).toBe('1/2')
    expect(chapterRowProgress(nodes[2], nodes)).toBeNull()
    expect(chapterRowProgress(node('x', null, false, { note: '  ' }), [])).toBeNull()
  })
})

describe('三步走：选中 → 预览 → 进入展开树', () => {
  it('进入的是当前这本书，下方才展开树', () => {
    expect(isBookEntered('b1', 'b1')).toBe(true)
    expect(isBookEntered('b1', 'b2')).toBe(false)
    expect(isBookEntered(null, 'b1')).toBe(false)
    expect(isBookEntered('b1', null)).toBe(false)
    expect(isBookEntered('', '', )).toBe(false)
  })
})

describe('阅读记录的可选 nodeId（本块新增，旧数据零改写）', () => {
  it('没有 nodeId 的记录规范化后仍然不带这个键', () => {
    const normalized = normalizeReadingRecord({
      id: 'p1',
      kind: 'progress',
      bookId: 'b1',
      date: '2026-10-01',
      minutes: 30,
      toPage: 128
    })
    if (normalized?.kind !== 'progress') throw new Error('应当识别为 progress')
    expect('nodeId' in normalized).toBe(false)
  })

  it('带 nodeId 的记录会原样留下（章节里记的那几条）', () => {
    const normalized = normalizeReadingRecord({
      id: 'p2',
      kind: 'progress',
      bookId: 'b1',
      nodeId: ' ch1 ',
      date: '2026-10-01',
      minutes: 30,
      toPage: 128
    })
    if (normalized?.kind !== 'progress') throw new Error('应当识别为 progress')
    expect(normalized.nodeId).toBe('ch1')
  })

  it('空字符串的 nodeId 不落键（等价于书级记录）', () => {
    const normalized = normalizeReadingRecord({
      id: 'p3',
      kind: 'progress',
      bookId: 'b1',
      nodeId: '',
      date: '2026-10-01',
      minutes: 30
    })
    if (normalized?.kind !== 'progress') throw new Error('应当识别为 progress')
    expect('nodeId' in normalized).toBe(false)
  })
})
