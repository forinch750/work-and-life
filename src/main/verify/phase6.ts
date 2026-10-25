/**
 * 阶段 6 验收检查（DEVPLAN 阶段 6 / PRD §10.8 H、§10.10 J）
 *
 * 覆盖读书（书架、纸质/电子两套进度、阅读记录、摘录与想法、摘录转复习、标记读完、
 * 与学习模块互不牵连）与全局搜索（Ctrl+K、按模块分组、点击跳转、能搜书名作者摘录想法）。
 */
import { dateKey } from '../../shared/date'
import { toPlainText } from '../../shared/richText'
import { injectRichHelpers, setRichHtml } from './rich'
import type { VerifyCheck, VerifyContext } from './runner'

type Recorder = (check: VerifyCheck) => void

async function evaluate<T>(context: VerifyContext, expression: string): Promise<T> {
  return (await context.window.webContents.executeJavaScript(expression)) as T
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function readingRecords(context: VerifyContext): Array<Record<string, unknown>> {
  return context.appData.module('reading').list().map((record) => record as unknown as Record<string, unknown>)
}

/**
 * 确保搜索抽屉是关着的，且输入框里的关键词已经被清空。
 *
 * 为什么必须有这一步：搜索抽屉关闭时只是不渲染（组件不卸载），
 * 关键词要等 open 从 true 变 false 才被清空。如果不清空就重新打开并设置关键词，
 * 一旦设置的值恰好等于输入框里残留的值，React 的 onChange 不会触发，
 * 搜索就不会重跑，读到的是上一次的旧结果——
 * 表现就是"某个关键词随机搜不到""空状态偶尔不出现"。
 */
async function ensureSearchClosed(context: VerifyContext): Promise<void> {
  for (let attempt = 0; attempt < 12; attempt += 1) {
    const state = await evaluate<{ open: boolean; term: string }>(
      context,
      `(() => {
         const input = window.__verify.byTestId('search-input')
         return {
           open: window.__verify.exists('search-drawer'),
           term: input ? String(input.value || '') : ''
         }
       })()`
    )
    if (!state.open && state.term === '') return
    if (state.open) await evaluate(context, `window.__verify.key('Escape')`)
    await wait(120)
  }
}

/** 打开搜索抽屉（需先 ensureSearchClosed），并返回是否真的打开了 */
async function openSearch(context: VerifyContext): Promise<boolean> {
  await evaluate(context, `window.__verify.key('k', { ctrlKey: true })`)
  await wait(250)
  return evaluate<boolean>(context, `window.__verify.exists('search-drawer')`)
}

function findBook(context: VerifyContext, title: string): Record<string, unknown> | undefined {
  return readingRecords(context).find((item) => item['kind'] === 'book' && item['title'] === title)
}

export async function runPhase6Checks(
  context: VerifyContext,
  record: Recorder,
  passNumber: number
): Promise<void> {
  const todayKey = dateKey(new Date())
  const paperTitle = `阶段6验收：纸质书样本（第${passNumber}趟）`
  const ebookTitle = `阶段6验收：电子书样本（第${passNumber}趟）`

  // =========================================================================
  // 读书
  // =========================================================================
  await evaluate(context, `window.__verify.clickNav('reading')`)
  await wait(400)

  // ---- H1 添加纸质书（320 页）→ 书架"在读"分组出现 ----
  try {
    // 打开添加抽屉，填纸质书
    await evaluate(context, `window.__verify.click('[data-testid="reading-add-book"]')`)
    await wait(300)
    await evaluate(context, `window.__verify.setText('reading-new-title', ${JSON.stringify(paperTitle)})`)
    await evaluate(context, `window.__verify.setText('reading-new-author', 'Randal Bryant')`)
    await wait(80)
    await evaluate(context, `window.__verify.click('[data-testid="reading-new-save"]')`)
    await wait(900)
    context.appData.flushAll()

    const paper = findBook(context, paperTitle)
    const inWantTab = paper?.['status'] === 'want'

    // 切到"在读"分组，把它标为在读
    await evaluate(context, `window.__verify.click('[data-testid="reading-tab-want"]')`)
    await wait(300)
    const onShelf = await evaluate<boolean>(
      context,
      `Array.from(document.querySelectorAll('[data-testid="reading-book"]')).some(b => (b.textContent || '').indexOf(${JSON.stringify(paperTitle)}) >= 0)`
    )
    await evaluate(
      context,
      `(() => {
         const cards = Array.from(document.querySelectorAll('[data-testid="reading-book"]'))
         const card = cards.find(c => (c.textContent || '').indexOf(${JSON.stringify(paperTitle)}) >= 0)
         if (card) card.click()
         return true
       })()`
    )
    await wait(400)
    await evaluate(context, `window.__verify.click('[data-testid="reading-mark-reading"]')`)
    await wait(800)
    context.appData.flushAll()

    const paperAfter = findBook(context, paperTitle)
    // 填总页数：通过更新进度接口补上（添加时已填 320？——这里统一核对）
    record({
      id: 'P6-H1',
      prd: 'H1',
      name: '添加纸质书后出现在书架对应分组，可标记为在读',
      passed: Boolean(paper) && inWantTab === true && onShelf && paperAfter?.['status'] === 'reading',
      detail: `新书状态=${String(paper?.['status'])}（应为 want）；"想读"分组可见=${onShelf}；标记在读后=${String(paperAfter?.['status'])}；格式=${String(paperAfter?.['format'])} 总页数=${String(paperAfter?.['totalPages'])}`
    })
  } catch (error) {
    record({
      id: 'P6-H1',
      prd: 'H1',
      name: '添加纸质书后出现在书架对应分组，可标记为在读',
      passed: false,
      detail: String(error)
    })
  }

  // ---- H2 更新进度到 128 页 → 书卡显示 x/320，且落盘 ----
  try {
    // 先把总页数补成 320，再更新到 128 页
    const paper = findBook(context, paperTitle)
    if (paper) {
      context.appData.module('reading').update(String(paper['id']), { totalPages: 320 })
      context.appData.flushAll()
    }
    await evaluate(
      context,
      `window.dispatchEvent(new CustomEvent('worklife:data-changed', { detail: { module: 'reading' } })), true`
    )
    await wait(400)

    // 打开这本书的详情
    await evaluate(context, `window.__verify.click('[data-testid="reading-tab-reading"]')`)
    await wait(300)
    await evaluate(
      context,
      `(() => {
         const cards = Array.from(document.querySelectorAll('[data-testid="reading-book"]'))
         const card = cards.find(c => (c.textContent || '').indexOf(${JSON.stringify(paperTitle)}) >= 0)
         if (card) card.click()
         return true
       })()`
    )
    await wait(400)
    // 第 11 块：读书页改成"左栏书架 + 上预览 / 中两块 / 下树"，
    // 「更新进度」并进了「记一次阅读」抽屉 —— 先点开它（断言一条没动）
    await evaluate(context, `window.__verify.click('[data-testid="reading-log-reading"]')`)
    await wait(300)
    await evaluate(context, `window.__verify.setText('reading-progress-input', '128')`)
    await evaluate(context, `window.__verify.setText('reading-minutes-input', '45')`)
    await wait(100)
    await evaluate(context, `window.__verify.click('[data-testid="reading-progress-save"]')`)
    await wait(900)
    context.appData.flushAll()

    const updated = findBook(context, paperTitle)
    const detailProgress = await evaluate<string>(
      context,
      `((window.__verify.byTestId('reading-detail-progress') || {}).textContent || '').trim()`
    )
    const records = readingRecords(context).filter(
      (item) => item['kind'] === 'progress' && item['bookId'] === updated?.['id']
    )
    const recordItem = records[0]

    record({
      id: 'P6-H2',
      prd: 'H2',
      name: '更新进度到 128 页后落盘，并留下一条阅读记录',
      passed:
        updated?.['currentPage'] === 128 &&
        updated?.['totalPages'] === 320 &&
        detailProgress === '128/320 页' &&
        records.length === 1 &&
        recordItem?.['minutes'] === 45 &&
        recordItem?.['toPage'] === 128,
      detail: `落盘 currentPage=${String(updated?.['currentPage'])}/${String(updated?.['totalPages'])}；界面显示="${detailProgress}"；阅读记录 ${records.length} 条（时长 ${String(recordItem?.['minutes'])} 分钟，${String(recordItem?.['fromPage'])}→${String(recordItem?.['toPage'])} 页）`
    })
  } catch (error) {
    record({
      id: 'P6-H2',
      prd: 'H2',
      name: '更新进度到 128 页后落盘，并留下一条阅读记录',
      passed: false,
      detail: String(error)
    })
  }

  // ---- H3 电子书用百分比，与纸质书互不干扰 ----
  try {
    await evaluate(context, `window.__verify.click('[data-testid="reading-add-book"]')`)
    await wait(300)
    await evaluate(context, `window.__verify.setText('reading-new-title', ${JSON.stringify(ebookTitle)})`)
    await evaluate(context, `window.__verify.setSelect('reading-new-format', 'ebook')`)
    await wait(150)
    await evaluate(context, `window.__verify.click('[data-testid="reading-new-save"]')`)
    await wait(900)
    context.appData.flushAll()

    const ebook = findBook(context, ebookTitle)
    if (ebook) {
      context.appData.module('reading').update(String(ebook['id']), { status: 'reading' })
      context.appData.flushAll()
    }
    await evaluate(
      context,
      `window.dispatchEvent(new CustomEvent('worklife:data-changed', { detail: { module: 'reading' } })), true`
    )
    await wait(400)
    await evaluate(context, `window.__verify.click('[data-testid="reading-tab-reading"]')`)
    await wait(300)
    await evaluate(
      context,
      `(() => {
         const cards = Array.from(document.querySelectorAll('[data-testid="reading-book"]'))
         const card = cards.find(c => (c.textContent || '').indexOf(${JSON.stringify(ebookTitle)}) >= 0)
         if (card) card.click()
         return true
       })()`
    )
    await wait(400)
    // 同上：先进「记一次阅读」抽屉（电子书在这里填百分比）
    await evaluate(context, `window.__verify.click('[data-testid="reading-log-reading"]')`)
    await wait(300)
    await evaluate(context, `window.__verify.setText('reading-progress-input', '32')`)
    await wait(100)
    await evaluate(context, `window.__verify.click('[data-testid="reading-progress-save"]')`)
    await wait(900)
    context.appData.flushAll()

    const ebookAfter = findBook(context, ebookTitle)
    const paperAfter = findBook(context, paperTitle)
    const ebookLabel = await evaluate<string>(
      context,
      `((window.__verify.byTestId('reading-detail-progress') || {}).textContent || '').trim()`
    )

    record({
      id: 'P6-H3',
      prd: 'H3',
      name: '电子书按百分比记进度，纸质书的页数不受影响',
      passed:
        ebookAfter?.['percent'] === 32 &&
        ebookAfter?.['currentPage'] === 0 &&
        ebookAfter?.['totalPages'] === 0 &&
        ebookLabel === '32%' &&
        paperAfter?.['currentPage'] === 128,
      detail: `电子书 percent=${String(ebookAfter?.['percent'])}%（显示"${ebookLabel}"），页数字段=${String(ebookAfter?.['currentPage'])}；同时纸质书仍是 ${String(paperAfter?.['currentPage'])} 页`
    })
  } catch (error) {
    record({
      id: 'P6-H3',
      prd: 'H3',
      name: '电子书按百分比记进度，纸质书的页数不受影响',
      passed: false,
      detail: String(error)
    })
  }

  // ---- H4 原文与想法都记在同一本书下，带页码（选"原文"时要点清楚类型）----
  try {
    // 当前打开的是电子书，先切回纸质书
    await evaluate(context, `window.__verify.click('[data-testid="drawer-close"]')`)
    await wait(300)
    await evaluate(
      context,
      `(() => {
         const cards = Array.from(document.querySelectorAll('[data-testid="reading-book"]'))
         const card = cards.find(c => (c.textContent || '').indexOf(${JSON.stringify(paperTitle)}) >= 0)
         if (card) card.click()
         return true
       })()`
    )
    await wait(400)

    // 第 11 块：摘录的编辑器搬进「加摘录」抽屉（中区那块卡片只列已有的摘录）
    // 原文摘录：默认就是"原文"，但显式点一下更稳
    await evaluate(context, `window.__verify.click('[data-testid="reading-add-excerpt"]')`)
    await wait(300)
    await evaluate(context, `window.__verify.click('[data-testid="reading-excerpt-type-quote"]')`)
    await evaluate(context, `window.__verify.setText('reading-excerpt-locator', 'p.112')`)
    // 摘录正文从第 04 块起是富文本编辑器：用真实输入驱动（见 verify/rich.ts）
    await injectRichHelpers(context)
    await setRichHtml(context, 'reading-excerpt-input', '计算机系统是由硬件和系统软件组成的')
    await wait(150)
    await evaluate(
      context,
      `(() => {
         const el = window.__verify.byTestId('reading-excerpt-input')
         el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
         return true
       })()`
    )
    await wait(900)

    // 想法（抽屉保存后自动关闭，再打开一次）
    await evaluate(context, `window.__verify.click('[data-testid="reading-add-excerpt"]')`)
    await wait(300)
    await evaluate(context, `window.__verify.click('[data-testid="reading-excerpt-type-thought"]')`)
    await evaluate(context, `window.__verify.setText('reading-excerpt-locator', 'p.98')`)
    await setRichHtml(context, 'reading-excerpt-input', '这里和第 3 章的公式是同一个东西')
    await wait(150)
    await evaluate(
      context,
      `(() => {
         const el = window.__verify.byTestId('reading-excerpt-input')
         el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
         return true
       })()`
    )
    await wait(900)
    context.appData.flushAll()

    const book = findBook(context, paperTitle)
    const excerpts = readingRecords(context).filter(
      (item) => item['kind'] === 'excerpt' && item['bookId'] === book?.['id']
    )
    const quote = excerpts.find((item) => item['type'] === 'quote')
    const thought = excerpts.find((item) => item['type'] === 'thought')
    const uiCount = await evaluate<number>(context, `window.__verify.count('[data-testid="reading-excerpt"]')`)
    // 【诊断】第 11 块重做读书页后，这里出现过一次"落库 2 条、界面 0 条"（同一份代码复跑就好了）。
    // 判据一条没放宽，把现场（当前视图 / 选中哪本书 / 中区那块的计数 / 报错）一并写进报告，便于复发时定位。
    const diag = await evaluate<string>(
      context,
      `(() => {
         const ws = document.querySelector('[data-testid="workspace"]')
         const preview = document.querySelector('[data-testid="reading-detail"]')
         const band = document.querySelector('[data-testid="reading-excerpts"]')
         const err = document.querySelector('.notice--error')
         return JSON.stringify({
           view: ws ? ws.getAttribute('data-view') : null,
           preview: !!preview,
           previewBook: preview ? preview.getAttribute('data-book-id') : null,
           previewTitle: ((document.querySelector('[data-testid="reading-detail-title"]') || {}).textContent || '').trim(),
           band: !!band,
           bandCount: ((document.querySelector('[data-testid="reading-excerpts-count"]') || {}).textContent || '').trim(),
           rows: document.querySelectorAll('[data-testid="reading-excerpt"]').length,
           drawer: !!document.querySelector('[data-testid="reading-excerpt-drawer"]'),
           books: document.querySelectorAll('[data-testid="reading-book"]').length,
           error: err ? (err.textContent || '').trim() : ''
         })
       })()`
    )

    record({
      id: 'P6-H4',
      prd: 'H4',
      name: '原文与想法都挂在同一本书下，各自带页码',
      passed:
        excerpts.length === 2 &&
        quote?.['locator'] === 'p.112' &&
        thought?.['locator'] === 'p.98' &&
        uiCount === 2,
      detail: `摘录 ${excerpts.length} 条（界面显示 ${uiCount} 条）：原文 ${String(quote?.['locator'])}，想法 ${String(thought?.['locator'])}；现场=${diag}`
    })
  } catch (error) {
    record({
      id: 'P6-H4',
      prd: 'H4',
      name: '原文与想法都挂在同一本书下，各自带页码',
      passed: false,
      detail: String(error)
    })
  }

  // ---- H5 摘录 → 生成复习卡 ----
  try {
    const before = context.appData.module('review').list().length
    await evaluate(context, `window.__verify.click('[data-testid="reading-excerpt-to-review"]')`)
    await wait(900)
    context.appData.flushAll()
    const after = context.appData.module('review').list().length
    const card = context.appData
      .module('review')
      .list()
      .find((item) => String(item['front'] ?? '').includes('硬件和系统软件'))
    record({
      id: 'P6-H5',
      prd: 'H5',
      name: '摘录可以一键生成复习卡',
      passed: after === before + 1 && Boolean(card),
      detail: `复习卡 ${before}→${after} 张${card ? `；新卡正面="${String(card['front']).slice(0, 24)}…" 背面="${String(card['back']).slice(0, 24)}"` : '（未找到）'}`
    })
  } catch (error) {
    record({
      id: 'P6-H5',
      prd: 'H5',
      name: '摘录可以一键生成复习卡',
      passed: false,
      detail: String(error)
    })
  }

  // ---- H6 标记读完：弹日期/评分/总评表单；摘录仍可翻阅 ----
  try {
    await evaluate(context, `window.__verify.click('[data-testid="reading-mark-finished"]')`)
    await wait(400)
    const formOpen = await evaluate<boolean>(context, `window.__verify.exists('reading-finish-drawer')`)
    const hasRating = await evaluate<boolean>(context, `window.__verify.exists('reading-rating-4')`)
    await evaluate(context, `window.__verify.click('[data-testid="reading-rating-4"]')`)
    // 总评也是富文本编辑器（第 04 块）
    await injectRichHelpers(context)
    await setRichHtml(context, 'reading-finish-review', '值得反复读的一本')
    await wait(150)
    await evaluate(context, `window.__verify.click('[data-testid="reading-finish-save"]')`)
    await wait(1000)
    context.appData.flushAll()

    const finished = findBook(context, paperTitle)
    const excerptsStillThere = readingRecords(context).filter(
      (item) => item['kind'] === 'excerpt' && item['bookId'] === finished?.['id']
    ).length
    const inFinishedTab = await evaluate<boolean>(
      context,
      `Array.from(document.querySelectorAll('[data-testid="reading-book"]')).some(b => (b.textContent || '').indexOf(${JSON.stringify(paperTitle)}) >= 0)`
    )

    record({
      id: 'P6-H6',
      prd: 'H6',
      name: '标记读完会记录日期/评分/总评，摘录仍保留',
      passed:
        formOpen &&
        hasRating &&
        finished?.['status'] === 'finished' &&
        finished?.['finishedAt'] === todayKey &&
        finished?.['rating'] === 4 &&
        // 总评是富文本：判据按 contentFormat 抽纯文本（落库的可能是 HTML）
        toPlainText(finished?.['review'], finished?.['contentFormat']) === '值得反复读的一本' &&
        excerptsStillThere === 2 &&
        inFinishedTab,
      detail: `表单打开=${formOpen}；状态=${String(finished?.['status'])} 读完日=${String(finished?.['finishedAt'])} 评分=${String(finished?.['rating'])} 总评="${String(finished?.['review'])}"；摘录仍保留 ${excerptsStillThere} 条；已出现在"读完"分组=${inFinishedTab}`
    })
  } catch (error) {
    record({
      id: 'P6-H6',
      prd: 'H6',
      name: '标记读完会记录日期/评分/总评，摘录仍保留',
      passed: false,
      detail: String(error)
    })
  }

  // ---- H7 读书与学习互不牵连 ----
  try {
    const readingHtml = await evaluate<string>(
      context,
      `(document.querySelector('[data-testid="workspace"]') || {}).innerHTML || ''`
    )
    // 切到学习页，确认学习页里没有书名/摘录
    await evaluate(context, `window.__verify.clickNav('learning')`)
    await wait(500)
    const learningHtml = await evaluate<string>(
      context,
      `(document.querySelector('[data-testid="workspace"]') || {}).innerHTML || ''`
    )
    // 读书页里不应出现"学习"模块的入口文案
    const readingMentionsLearning = readingHtml.includes('学习主题') || readingHtml.includes('记一次学习')
    const learningMentionsBook =
      learningHtml.includes(paperTitle) || learningHtml.includes('硬件和系统软件')

    record({
      id: 'P6-H7',
      prd: 'H7',
      name: '读书页与学习页互不出现对方的入口或内容',
      passed: !readingMentionsLearning && !learningMentionsBook,
      detail: `读书页出现学习入口=${readingMentionsLearning}；学习页出现书名/摘录=${learningMentionsBook}`
    })
  } catch (error) {
    record({
      id: 'P6-H7',
      prd: 'H7',
      name: '读书页与学习页互不出现对方的入口或内容',
      passed: false,
      detail: String(error)
    })
  }

  // =========================================================================
  // 全局搜索
  // =========================================================================

  // ---- J1 Ctrl+K 打开搜索，跨模块结果按模块分组 ----
  try {
    // 先准备一个跨模块都能命中的词
    const keyword = `阶段6搜索词${passNumber}`
    await evaluate(
      context,
      `window.api.data.add('memo', { text: ${JSON.stringify(`${keyword} 出现在备忘里`)}, pinned: false })`
    )
    await evaluate(
      context,
      `window.api.data.add('plan', { title: ${JSON.stringify(`${keyword} 出现在计划里`)}, date: ${JSON.stringify(todayKey)}, timeSlot: 'none', recurrence: 'none', done: false, carriedOver: 0, doneAt: null })`
    )
    await evaluate(
      context,
      `window.api.data.add('reading', { kind: 'book', title: ${JSON.stringify(`${keyword} 之书`)}, author: '测试作者', format: 'paper', status: 'want', totalPages: 0, currentPage: 0, percent: 0, finishedAt: null, rating: 0, review: '' })`
    )
    await evaluate(
      context,
      `window.api.data.add('review', { front: ${JSON.stringify(`${keyword} 的复习卡`)}, back: '', source: '搜索验收', stage: 0, dueDate: null, reviewCount: 0, lastReviewedAt: null })`
    )
    await evaluate(context, `window.api.data.flush()`)
    await wait(400)

    // 先关抽屉清空关键词，再打开（理由见 ensureSearchClosed 的说明）
    await ensureSearchClosed(context)
    const opened = await openSearch(context)

    // 搜索是防抖的，且数据刚落盘，因此这里"重试直到出结果"，
    // 不依赖固定延时——否则在慢一点的机器上会出现偶发失败。
    const readGroups = `
      (() => {
         const groups = Array.from(document.querySelectorAll('[data-testid^="search-group-"]'))
         return {
           modules: groups.map(g => g.getAttribute('data-testid').replace('search-group-', '')),
           hits: document.querySelectorAll('[data-testid="search-hit"]').length,
           summary: ((window.__verify.byTestId('search-summary') || {}).textContent || '').trim()
         }
       })()
    `

    let groupInfo = { modules: [] as string[], hits: 0, summary: '' }
    for (let attempt = 0; attempt < 8; attempt += 1) {
      await evaluate(context, `window.__verify.setText('search-input', ${JSON.stringify(keyword)})`)
      await wait(500)
      groupInfo = await evaluate<{ modules: string[]; hits: number; summary: string }>(
        context,
        readGroups
      )
      if (groupInfo.hits >= 4) break
    }

    record({
      id: 'P6-J1',
      prd: 'J1',
      name: 'Ctrl+K 打开搜索，一个词跨模块命中并按模块分组',
      passed:
        opened &&
        groupInfo.hits >= 4 &&
        ['plan', 'memo', 'reading', 'review'].every((module) => groupInfo.modules.includes(module)),
      detail: `抽屉打开=${opened}；命中分组=[${groupInfo.modules.join(', ')}]；命中条数=${groupInfo.hits}；摘要="${groupInfo.summary}"`
    })
  } catch (error) {
    record({
      id: 'P6-J1',
      prd: 'J1',
      name: 'Ctrl+K 打开搜索，一个词跨模块命中并按模块分组',
      passed: false,
      detail: String(error)
    })
  }

  // ---- J2 点结果跳到对应模块 ----
  try {
    const navigated = await evaluate<{ clicked: boolean; viewAfter: string; group: string }>(
      context,
      `(() => {
         const hits = Array.from(document.querySelectorAll('[data-testid="search-hit"]'))
         const target = hits.find(h => h.getAttribute('data-module') === 'plan')
         if (!target) return { clicked: false, viewAfter: '', group: '' }
         target.click()
         return { clicked: true, viewAfter: '', group: 'plan' }
       })()`
    )
    await wait(700)
    const viewAfter = await evaluate<string>(context, `window.__verify.activeView()`)
    const drawerClosed = await evaluate<boolean>(context, `!window.__verify.exists('search-drawer')`)

    record({
      id: 'P6-J2',
      prd: 'J2',
      name: '点击搜索结果会跳到对应模块并关闭搜索',
      passed: navigated.clicked && viewAfter === 'plan' && drawerClosed,
      detail: `点击计划组结果=${navigated.clicked}；跳转后视图=${viewAfter}（期望 plan）；搜索已关闭=${drawerClosed}`
    })
  } catch (error) {
    record({
      id: 'P6-J2',
      prd: 'J2',
      name: '点击搜索结果会跳到对应模块并关闭搜索',
      passed: false,
      detail: String(error)
    })
  }

  // ---- J3 能搜到书名、作者、摘录原文与想法 ----
  try {
    const results: Array<{ label: string; found: boolean }> = []

    /**
     * 搜一个关键词并数出某个模块分组下的命中数。
     *
     * 关键：每次搜索前必须**先把抽屉关掉、把关键词清空**再重开。
     * 原因：搜索抽屉关闭时只是不渲染（组件不卸载），关键词要等 open 变 false 才被清空。
     * 如果连续两次搜同一个词（或者第二次设的值恰好等于输入框里残留的值），
     * React 的 onChange 不会触发，搜索就不会重跑，读到的是上一个词的旧结果——
     * 表现就是"某个关键词随机搜不到"。
     */
    const searchAndCount = async (keyword: string, module: string): Promise<number> => {
      // 先关抽屉并等关键词清空，否则第二次搜同一个词时 onChange 不触发、读到旧结果
      await ensureSearchClosed(context)
      await openSearch(context)

      // 输入关键词，并轮询等待结果出现（界面是异步取数的）
      let count = 0
      for (let attempt = 0; attempt < 10; attempt += 1) {
        await evaluate(context, `window.__verify.setText('search-input', ${JSON.stringify(keyword)})`)
        await wait(300)
        count = await evaluate<number>(
          context,
          `(() => {
             const group = window.__verify.byTestId('search-group-${module}')
             return group ? group.querySelectorAll('[data-testid="search-hit"]').length : 0
           })()`
        )
        if (count > 0) break
      }

      await evaluate(context, `window.__verify.key('Escape')`)
      await wait(200)
      return count
    }

    results.push({ label: '书名', found: (await searchAndCount(paperTitle, 'reading')) > 0 })
    results.push({ label: '作者', found: (await searchAndCount('Randal Bryant', 'reading')) > 0 })
    results.push({
      label: '摘录原文',
      found: (await searchAndCount('硬件和系统软件', 'reading')) > 0
    })
    results.push({
      label: '摘录想法',
      found: (await searchAndCount('第 3 章的公式', 'reading')) > 0
    })

    record({
      id: 'P6-J3',
      prd: 'J3',
      name: '搜索能命中书名、作者、摘录原文与想法',
      passed: results.every((item) => item.found),
      detail: results.map((item) => `${item.label}=${item.found ? '命中' : '未命中'}`).join('；')
    })
  } catch (error) {
    record({
      id: 'P6-J3',
      prd: 'J3',
      name: '搜索能命中书名、作者、摘录原文与想法',
      passed: false,
      detail: String(error)
    })
  }

  // ---- 搜不到时给出明确说法 ----
  try {
    // 关键词必须是真正不可能命中的字符串：
    // 之前用中文句子，结果"一定/不存在"这类子串撞上了验收自己造的数据。
    const impossible = `zzq-not-exist-${passNumber}-${Date.now().toString(36)}-qqz`
    // 必须先关抽屉清空关键词，否则上次残留的值会挡住这次 onChange
    await ensureSearchClosed(context)
    const drawerOpened = await openSearch(context)

    // 轮询等待"空状态"出现：摘要文案与空状态元素不是同一帧渲染出来的，
    // 固定延时下偶尔只赶上摘要、没赶上元素，就会误判成"没有给出提示"。
    let empty = false
    let summary = ''
    for (let attempt = 0; attempt < 12; attempt += 1) {
      await evaluate(context, `window.__verify.setText('search-input', ${JSON.stringify(impossible)})`)
      await wait(250)
      empty = await evaluate<boolean>(context, `window.__verify.exists('search-empty')`)
      summary = await evaluate<string>(
        context,
        `((window.__verify.byTestId('search-summary') || {}).textContent || '').trim()`
      )
      if (empty && summary.includes('没有找到')) break
    }
    await evaluate(context, `window.__verify.key('Escape')`)
    await wait(200)
    record({
      id: 'P6-J4',
      prd: 'J2',
      name: '搜不到内容时给出明确提示而不是空白',
      passed: drawerOpened && empty && summary.includes('没有找到'),
      detail: `关键词="${impossible}"；抽屉打开=${drawerOpened}；空状态显示=${empty}；摘要="${summary}"`
    })
  } catch (error) {
    record({
      id: 'P6-J4',
      prd: 'J2',
      name: '搜不到内容时给出明确提示而不是空白',
      passed: false,
      detail: String(error)
    })
  }
}
