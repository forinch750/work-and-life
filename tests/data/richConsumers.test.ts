/**
 * 富文本"消费侧"的单测（第 04 块 / `docs\TASKS\04` §三 ② 与 §6.2）
 *
 * 本块的核心是这句话：**正文变成 HTML 之后，三处依赖方必须同时改，漏一处就出 bug。**
 * 所以这里把三处依赖方各钉一遍：
 *
 *   1. **搜索不吃标签**（`src\shared\search.ts`）
 *      —— 带 `<b>` 的正文搜"粗体字"能命中；搜 `b`、`<`、`p` 不该命中标签本身
 *   2. **复习卡不吃标签**（`learning.logToCard` / `reading.excerptToCard`）
 *      —— 生成的卡片正反面都是纯文本，没有 `<p>` `<b>`
 *   3. **转任务不吃标签**（`memo.memoToPlanInput` / `memo.memoToCardInput`）
 *      —— 富文本备忘转出来的任务标题是纯文本
 *
 * 外加两条显示层的守卫：
 *   4. **旧记录零改写**：没有 `contentFormat` 的记录按纯文本处理，且数据没被改动
 *   5. **回收站标题**也不漏标签（同一类"把正文当纯文本"的坑）
 */
import { describe, expect, it } from 'vitest'
import { searchAll } from '../../src/shared/search'
import { logToCard, normalizeLearningRecord } from '../../src/shared/learning'
import { excerptToCard, normalizeReadingRecord, type Excerpt } from '../../src/shared/reading'
import {
  memoToCardInput,
  memoToPlanInput,
  memoPlainText,
  normalizeMemoRecord
} from '../../src/shared/memo'
import { toTrashEntry } from '../../src/shared/trash'
import { richDisplay } from '../../src/shared/richTextDisplay'
import { normalizeModuleFile } from '../../src/main/data/format'

/** 一条"带标签"的富文本正文：粗体字 + 一个段落 */
const RICH_BODY = '<p>这里有一段<b>粗体字</b>要记住</p>'

const baseTimestamps = {
  createdAt: '2026-10-01T00:00:00.000Z',
  updatedAt: '2026-10-01T00:00:00.000Z'
}

describe('① 搜索：不吃标签', () => {
  const richMemo = {
    id: 'm1',
    ...baseTimestamps,
    text: RICH_BODY,
    pinned: false,
    contentFormat: 'rich'
  }

  it('搜正文里的字能命中富文本备忘', () => {
    const groups = searchAll({ memo: [richMemo] }, '粗体字')
    expect(groups.length).toBe(1)
    expect(groups[0]?.hits[0]?.title).toContain('粗体字')
  })

  it('命中结果里不带标签（标题是纯文本）', () => {
    const groups = searchAll({ memo: [richMemo] }, '粗体字')
    const title = groups[0]?.hits[0]?.title ?? ''
    expect(title).not.toContain('<b>')
    expect(title).not.toContain('</b>')
    expect(title).not.toContain('<p>')
  })

  it('搜标签名本身不该命中（b / p / strong）', () => {
    expect(searchAll({ memo: [richMemo] }, 'b')).toEqual([])
    expect(searchAll({ memo: [richMemo] }, 'p')).toEqual([])
    expect(searchAll({ memo: [richMemo] }, 'strong')).toEqual([])
  })

  it('搜 `<` 不该命中标签', () => {
    expect(searchAll({ memo: [richMemo] }, '<')).toEqual([])
  })

  it('纯文本备忘（旧记录）仍然照旧能搜到', () => {
    const plain = { id: 'm2', ...baseTimestamps, text: '今天买牛奶' }
    const groups = searchAll({ memo: [plain] }, '牛奶')
    expect(groups[0]?.hits[0]?.title).toBe('今天买牛奶')
  })

  it('富文本学习日志：搜正文能命中，搜标签名不命中', () => {
    const log = {
      id: 'l1',
      ...baseTimestamps,
      kind: 'log',
      topicId: 't1',
      date: '2026-10-02',
      minutes: 30,
      content: '<p>读完第 3 章，做了<b>十道</b>例句练习</p>',
      contentFormat: 'rich'
    }
    const hit = searchAll({ learning: [log] }, '例句练习')
    expect(hit[0]?.hits[0]?.title).toContain('例句练习')
    expect(hit[0]?.hits[0]?.title).not.toContain('<b>')
    expect(searchAll({ learning: [log] }, 'b')).toEqual([])
  })

  it('富文本摘录：搜正文能命中，搜标签名不命中', () => {
    const excerpt = {
      id: 'e1',
      ...baseTimestamps,
      kind: 'excerpt',
      bookId: 'b1',
      type: 'quote',
      locator: 'p.112',
      content: '<p>计算机系统由<b>硬件</b>与系统软件组成</p>',
      contentFormat: 'rich'
    }
    const hit = searchAll({ reading: [excerpt] }, '系统软件')
    expect(hit[0]?.hits[0]?.title).toContain('系统软件')
    expect(hit[0]?.hits[0]?.title).not.toContain('<b>')
    expect(searchAll({ reading: [excerpt] }, 'b')).toEqual([])
  })
})

describe('② 复习卡：正反面都不吃标签', () => {
  it('学习日志生成的卡片是纯文本', () => {
    const log = normalizeLearningRecord({
      id: 'l1',
      ...baseTimestamps,
      kind: 'log',
      topicId: 't1',
      date: '2026-10-02',
      minutes: 30,
      content: '<p>读完第 3 章</p><ul><li>做了十道题</li></ul>',
      contentFormat: 'rich'
    })
    expect(log).not.toBeNull()
    const card = logToCard(log as Parameters<typeof logToCard>[0], '语法俱乐部')
    expect(card.front).not.toContain('<p>')
    expect(card.front).not.toContain('<li>')
    expect(card.back).not.toContain('<')
    expect(card.front).toContain('读完第 3 章')
    expect(card.front).toContain('做了十道题')
  })

  it('摘录生成的卡片是纯文本', () => {
    const excerpt = normalizeReadingRecord({
      id: 'e1',
      ...baseTimestamps,
      kind: 'excerpt',
      bookId: 'b1',
      type: 'quote',
      locator: 'p.112',
      content: '<blockquote>计算机系统是由<b>硬件</b>和系统软件组成的</blockquote>',
      contentFormat: 'rich'
    }) as Excerpt
    const card = excerptToCard(excerpt, '深入理解计算机系统')
    expect(card.front).not.toContain('<blockquote>')
    expect(card.front).not.toContain('<b>')
    expect(card.front).toContain('硬件')
    expect(card.back).not.toContain('<')
  })

  it('旧日志（无 contentFormat）生成的卡片与以前完全一致', () => {
    const log = normalizeLearningRecord({
      id: 'l2',
      ...baseTimestamps,
      kind: 'log',
      topicId: 't1',
      date: '2026-10-02',
      minutes: 15,
      content: '纯文本日志：读了两页'
    })
    const card = logToCard(log as Parameters<typeof logToCard>[0], '英语')
    expect(card.front).toBe('英语：纯文本日志：读了两页')
    expect(card.back).toBe('2026-10-02 学了 15 分钟')
  })
})

describe('③ 转任务：标题是纯文本', () => {
  it('富文本备忘转任务的标题不含标签', () => {
    const input = memoToPlanInput({ text: RICH_BODY, contentFormat: 'rich' }, '2026-10-11')
    expect(String(input['title'])).toBe('这里有一段粗体字要记住')
    expect(String(input['title'])).not.toContain('<')
    expect(input['date']).toBe('2026-10-11')
  })

  it('富文本备忘转复习卡的正面不含标签', () => {
    const input = memoToCardInput({ text: RICH_BODY, contentFormat: 'rich' }, '2026-10-11')
    expect(String(input['front'])).toBe('这里有一段粗体字要记住')
    expect(String(input['front'])).not.toContain('<b>')
  })

  it('多行富文本备忘转任务：换行保留、标签丢掉', () => {
    const input = memoToPlanInput(
      { text: '<p>第一行</p><p>第二行</p>', contentFormat: 'rich' },
      '2026-10-11'
    )
    expect(String(input['title'])).toBe('第一行\n第二行')
  })

  it('旧备忘（无 contentFormat）转任务：与以前完全一致', () => {
    const input = memoToPlanInput({ text: ' 买牛奶\n顺路取快递 ' }, '2026-10-11')
    expect(String(input['title'])).toBe('买牛奶\n顺路取快递')
  })

  it('正文为空的富文本备忘不会造出空标题', () => {
    expect(memoPlainText({ text: '<p></p>', contentFormat: 'rich' })).toBe('')
    expect(String(memoToPlanInput({ text: '<p></p>', contentFormat: 'rich' }, '2026-10-11')['title'])).toBe('')
  })
})

describe('④ 旧记录零改写', () => {
  it('没有 contentFormat 的记录：显示成纯文本', () => {
    const display = richDisplay('旧正文\n第二行', undefined)
    expect(display.kind).toBe('text')
    expect(display.content).toBe('旧正文\n第二行')
  })

  it('规范化备忘记录时**不会**补上 contentFormat', () => {
    const record = normalizeMemoRecord({
      id: 'm-old',
      ...baseTimestamps,
      text: '旧备忘'
    })
    expect(record).not.toBeNull()
    expect(record as unknown as Record<string, unknown>).not.toHaveProperty('contentFormat')
  })

  it('规范化模块文件不会改写任何一条旧记录（迁移前后逐字段一致）', () => {
    const records = [
      { id: 'm1', text: '旧备忘一', pinned: false, createdAt: 'a', updatedAt: 'a' },
      { id: 'm2', text: '旧备忘二', createdAt: 'b', updatedAt: 'b' },
      { id: 'm3', text: '<b>看起来像标签</b>但它是纯文本', createdAt: 'c', updatedAt: 'c' }
    ]
    const before = JSON.parse(JSON.stringify(records)) as Array<Record<string, unknown>>
    const result = normalizeModuleFile({ formatVersion: 2, module: 'memo', records }, 'memo')
    // 记录原样保留：不多字段、不少字段、值一个都不变
    expect(result.file.records).toEqual(before)
    // 也不该出现"顺手补 contentFormat"这种批量改写
    expect(result.file.records.some((record) => 'contentFormat' in record)).toBe(false)
  })

  it('旧任务备注：没有 noteFormat 时按纯文本显示', () => {
    const display = richDisplay('备注原文<div>不是标签</div>', undefined)
    expect(display.kind).toBe('text')
    expect(display.content).toBe('备注原文<div>不是标签</div>')
  })
})

describe('⑤ 回收站标题也不漏标签', () => {
  it('富文本备忘在回收站里显示纯文本', () => {
    const entry = toTrashEntry('memo', {
      id: 'm1',
      ...baseTimestamps,
      text: RICH_BODY,
      contentFormat: 'rich',
      deletedAt: '2026-10-10T00:00:00.000Z'
    })
    expect(entry?.title ?? '').not.toContain('<b>')
    expect(entry?.title ?? '').toContain('粗体字')
  })

  it('旧备忘（无 contentFormat）的回收站标题与以前一致', () => {
    const entry = toTrashEntry('memo', {
      id: 'm2',
      ...baseTimestamps,
      text: '旧备忘正文',
      deletedAt: '2026-10-10T00:00:00.000Z'
    })
    expect(entry?.title).toBe('旧备忘正文')
  })

  it('富文本学习日志的回收站标题是纯文本', () => {
    const entry = toTrashEntry('learning', {
      id: 'l1',
      ...baseTimestamps,
      kind: 'log',
      content: '<p>读完<b>第一章</b></p>',
      contentFormat: 'rich',
      deletedAt: '2026-10-10T00:00:00.000Z'
    })
    expect(entry?.title ?? '').not.toContain('<p>')
    expect(entry?.title ?? '').toContain('第一章')
  })
})
