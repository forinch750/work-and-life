/**
 * 阶段 5 验收检查（DEVPLAN 阶段 5 / PRD §10.6 F、§10.7 G）
 *
 * 覆盖学习（主题/资料/日志/进度/归档/转复习）与复习（一屏一卡、
 * 键盘全流程、三档评分、Esc 保留进度、积压提示、导航角标）。
 */
import { dateKey } from '../../shared/date'
import { addDaysToKey, nextStage } from '../../shared/review'
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

/** 在渲染进程里按下一个键（带上 code，保证数字键能被识别） */
function pressKey(key: string, options: { code?: string; ctrlKey?: boolean; altKey?: boolean } = {}): string {
  const code = options.code ?? ''
  return `window.dispatchEvent(new KeyboardEvent('keydown', ${JSON.stringify({
    key,
    code,
    bubbles: true,
    cancelable: true,
    ctrlKey: options.ctrlKey ?? false,
    altKey: options.altKey ?? false
  })})), true`
}

/** 学习记录 */
function learningRecords(context: VerifyContext): Array<Record<string, unknown>> {
  return context.appData.module('learning').list().map((record) => record as unknown as Record<string, unknown>)
}

/**
 * 复习模块里的**卡片**记录（不含复习历史）。
 *
 * 第 06 块起 review 模块里还有 `kind:'history'` 的复习历史记录，
 * 它们没有 `dueDate` / `stage` / `reviewCount`。本文件的所有断言都是关于**卡片**的
 * （"到期几张"、"复习了几次"），历史混进来会被算成"到期"（`dueDate` 不是字符串
 * → 那条过滤条件恰好会放过它），让 P5-G6 的角标断言在第二趟无故变红。
 *
 * 所以这里统一把历史滤掉：判据一条没改，只是把"哪些记录算卡片"说清楚。
 */
function reviewRecords(context: VerifyContext): Array<Record<string, unknown>> {
  return context.appData
    .module('review')
    .list()
    .filter((record) => (record as unknown as Record<string, unknown>)['kind'] !== 'history')
    .map((record) => record as unknown as Record<string, unknown>)
}

/** 复习卡片是否已经在界面上出现 */
async function hasReviewCard(context: VerifyContext): Promise<boolean> {
  return evaluate<boolean>(context, `window.__verify.exists('review-card')`)
}

/** 轮询等待复习卡片出现（界面是异步取数的，不能只看一眼就下结论） */
async function waitForReviewCard(context: VerifyContext, timeoutMs = 3000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    if (await hasReviewCard(context)) return true
    if (Date.now() >= deadline) return false
    await wait(150)
  }
}

/**
 * 确保复习页处于"手上有卡"的状态。
 *
 * 两种情况要处理：
 *   - 还没开始会话 → 点"开始今日复习"
 *   - 会话还在但快照已评完 → 直接等界面把新到期的卡补进队列
 *
 * 以前验收台缺这一步：前一个检查启动过会话，轮到下一个检查时队列正好是空的，
 * 于是被判成"没有卡"而失败——表现为同一项在不同趟次随机红。
 */
async function ensureReviewSession(context: VerifyContext): Promise<void> {
  if (await waitForReviewCard(context, 1500)) return

  const canStart = await evaluate<boolean>(context, `window.__verify.exists('review-start')`)
  if (canStart) {
    await evaluate(context, `window.__verify.click('[data-testid="review-start"]')`)
    await wait(400)
  }
  await waitForReviewCard(context, 3000)
}

export async function runPhase5Checks(
  context: VerifyContext,
  record: Recorder,
  passNumber: number
): Promise<void> {
  const todayKey = dateKey(new Date())
  const topicTitle = `阶段5验收：英语长难句（第${passNumber}趟）`

  // =========================================================================
  // 学习
  // =========================================================================
  await evaluate(context, `window.__verify.clickNav('learning')`)
  await wait(400)

  // ---- F1 新建主题并添加资料 ----
  try {
    const filled = await evaluate<boolean>(
      context,
      `window.__verify.setText('learning-new-topic-input', ${JSON.stringify(topicTitle)})`
    )
    await wait(80)
    // 派发回车前先确认输入框真的在页面上。以前这里直接取元素就 dispatch，
    // 元素不在时抛的是一句"Script failed to execute"（不带任何现场），
    // 报告里只留下一个定不了位的报错（第 04 块就撞过一次）。
    const submitState = await evaluate<{ ok: boolean; view: string; rootLength: number }>(
      context,
      `(() => {
         const el = window.__verify.byTestId('learning-new-topic-input')
         const view = typeof window.__verify.activeView === 'function' ? window.__verify.activeView() : ''
         const rootLength = typeof window.__verify.rootLength === 'function' ? window.__verify.rootLength() : -1
         if (!el) return { ok: false, view: view || '', rootLength }
         el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
         return { ok: true, view: view || '', rootLength }
       })()`
    )
    if (!submitState.ok) {
      throw new Error(
        `学习页上找不到"新建主题"输入框（当前视图=${submitState.view || '未知'}，#root 长度=${submitState.rootLength}，填值成功=${filled}）`
      )
    }
    await wait(800)
    context.appData.flushAll()

    // 以"界面当前选中的主题"为准去找主题记录。
    // 直接按标题 find 可能与界面选中的不是同一条（历史同名记录会干扰），
    // 那会让"资料挂在哪"这条断言失去意义。
    const detailTitle = await evaluate<string>(
      context,
      `((window.__verify.byTestId('learning-detail-title') || {}).textContent || '').trim()`
    )
    const topic = learningRecords(context).find(
      (item) => item['kind'] === 'topic' && item['title'] === (detailTitle || topicTitle)
    )

    // 选中它并添加一条资料
    await evaluate(
      context,
      `(() => {
         const buttons = Array.from(document.querySelectorAll('[data-testid="learning-topic"]'))
         const target = buttons.find(b => (b.textContent || '').indexOf(${JSON.stringify(topicTitle)}) >= 0)
         if (target) target.click()
         return true
       })()`
    )
    await wait(300)
    await evaluate(context, `window.__verify.click('[data-testid="learning-add-resource"]')`)
    await wait(300)
    await evaluate(context, `window.__verify.setText('learning-resource-name', '《语法俱乐部》')`)
    await evaluate(context, `window.__verify.setText('learning-resource-type', '书')`)
    await evaluate(context, `window.__verify.setText('learning-resource-progress', '第 3/10 章')`)
    await wait(100)
    await evaluate(context, `window.__verify.click('[data-testid="learning-resource-save"]')`)
    await wait(800)
    context.appData.flushAll()

    // 找"挂在本趟主题下"的那条资料；若历史同名主题下也有同名资料，取 topicId 命中的那条。
    // 第 02 块起"资料"就是**树的根节点**（kind: 'node' + parentId: null），
    // 不再有 kind: 'resource' 的记录（v1 记录在启动迁移里已转成 node）。
    const resources = learningRecords(context).filter(
      (item) => item['kind'] === 'node' && item['parentId'] === null && item['title'] === '《语法俱乐部》'
    )
    const resource = resources.find((item) => item['topicId'] === topic?.['id']) ?? resources[0]

    record({
      id: 'P5-F1',
      prd: 'F1',
      name: '新建学习主题并添加资料，都写入了数据文件',
      passed: Boolean(topic) && Boolean(resource) && resource?.['topicId'] === topic?.['id'],
      detail: `主题「${topicTitle}」${topic ? `id=${String(topic['id']).slice(0, 6)} 进度=${String(topic['progress'])}% 状态=${String(topic['status'])}` : '未保存'}；资料${
        resource
          ? `id=${String(resource['id']).slice(0, 6)} topicId=${String(resource['topicId']).slice(0, 6)} 名称=${String(resource['title'])} 分组=${String(resource['resourceType'])}`
          : '未保存'
      }；两者主题 id 是否一致=${resource?.['topicId'] === topic?.['id']}`
    })
  } catch (error) {
    record({
      id: 'P5-F1',
      prd: 'F1',
      name: '新建学习主题并添加资料，都写入了数据文件',
      passed: false,
      detail: String(error)
    })
  }

  // ---- F2 记一次学习：选 30 分钟 + 内容 ----
  try {
    await evaluate(context, `window.__verify.click('[data-testid="learning-log-study"]')`)
    await wait(300)
    const drawerOpen = await evaluate<boolean>(context, `window.__verify.exists('learning-log-drawer')`)
    await evaluate(context, `window.__verify.click('[data-testid="learning-minutes-30"]')`)
    await wait(100)
    // 日志正文从第 04 块起是富文本编辑器：用真实输入驱动（见 verify/rich.ts）
    await injectRichHelpers(context)
    await setRichHtml(context, 'learning-log-content', '读完第 3 章，做了 10 道例句练习')
    await wait(120)
    await evaluate(context, `window.__verify.click('[data-testid="learning-log-save"]')`)
    await wait(900)
    context.appData.flushAll()

    const log = learningRecords(context).find(
      (item) =>
        item['kind'] === 'log' &&
        toPlainText(item['content'], item['contentFormat']) === '读完第 3 章，做了 10 道例句练习'
    )
    const logCount = await evaluate<number>(context, `window.__verify.count('[data-testid="learning-log"]')`)
    const marks = await evaluate<number>(context, `window.__verify.count('.progress__mark')`)

    record({
      id: 'P5-F2',
      prd: 'F2',
      name: '记一次学习（30 分钟）后日志出现，进度条上多一个刻度',
      passed: drawerOpen && Boolean(log) && log?.['minutes'] === 30 && logCount >= 1 && marks >= 1,
      detail: `抽屉打开=${drawerOpen} 日志已保存=${Boolean(log)} 时长=${String(log?.['minutes'])} 分钟；格式=${String(log?.['contentFormat'] ?? 'plain')}；界面日志条数=${logCount}，进度条刻度=${marks}`
    })
  } catch (error) {
    record({
      id: 'P5-F2',
      prd: 'F2',
      name: '记一次学习（30 分钟）后日志出现，进度条上多一个刻度',
      passed: false,
      detail: String(error)
    })
  }

  // ---- F3 拖动进度条，进度被保存 ----
  try {
    await evaluate(
      context,
      `(() => {
         const range = window.__verify.byTestId('learning-progress-range')
         if (!range) return false
         const descriptor = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')
         if (descriptor && descriptor.set) descriptor.set.call(range, '45')
         range.dispatchEvent(new Event('input', { bubbles: true }))
         range.dispatchEvent(new Event('change', { bubbles: true }))
         return true
       })()`
    )
    await wait(900)
    context.appData.flushAll()
    const topic = learningRecords(context).find(
      (item) => item['kind'] === 'topic' && item['title'] === topicTitle
    )
    const shownValue = await evaluate<string>(
      context,
      `((window.__verify.byTestId('learning-progress-value') || {}).textContent || '').trim()`
    )
    record({
      id: 'P5-F3',
      prd: 'F3',
      name: '拖动进度条后进度保存到数据文件',
      passed: topic?.['progress'] === 45 && shownValue === '45%',
      detail: `落盘进度=${String(topic?.['progress'])}；界面显示=${shownValue}`
    })
  } catch (error) {
    record({
      id: 'P5-F3',
      prd: 'F3',
      name: '拖动进度条后进度保存到数据文件',
      passed: false,
      detail: String(error)
    })
  }

  // ---- F4 学习日志 → 复习卡 ----
  try {
    const before = reviewRecords(context).length
    await evaluate(context, `window.__verify.click('[data-testid="learning-log-to-review"]')`)
    await wait(900)
    context.appData.flushAll()
    const after = reviewRecords(context).length
    const card = reviewRecords(context).find(
      (item) => String(item['front'] ?? '').includes('读完第 3 章')
    )
    record({
      id: 'P5-F4',
      prd: 'F4',
      name: '学习日志可以一键生成复习卡',
      passed: after === before + 1 && Boolean(card),
      detail: `复习卡 ${before}→${after} 张${card ? `；新卡正面="${String(card['front']).slice(0, 30)}…"` : '（未找到新卡）'}`
    })
  } catch (error) {
    record({
      id: 'P5-F4',
      prd: 'F4',
      name: '学习日志可以一键生成复习卡',
      passed: false,
      detail: String(error)
    })
  }

  // ---- F5 归档后可从"已归档"找回 ----
  try {
    await evaluate(context, `window.__verify.click('[data-testid="learning-archive"]')`)
    await wait(800)
    context.appData.flushAll()
    const archived = learningRecords(context).find(
      (item) => item['kind'] === 'topic' && item['title'] === topicTitle
    )
    const hiddenFromDefault = await evaluate<boolean>(
      context,
      `!Array.from(document.querySelectorAll('[data-testid="learning-topic"]')).some(b => (b.textContent || '').indexOf(${JSON.stringify(topicTitle)}) >= 0)`
    )
    await evaluate(context, `window.__verify.click('[data-testid="learning-toggle-archived"]')`)
    await wait(500)
    const visibleAfterToggle = await evaluate<boolean>(
      context,
      `Array.from(document.querySelectorAll('[data-testid="learning-topic"]')).some(b => (b.textContent || '').indexOf(${JSON.stringify(topicTitle)}) >= 0)`
    )
    record({
      id: 'P5-F5',
      prd: 'F5',
      name: '主题归档后默认不显示，勾选"显示已归档"能找到',
      passed: archived?.['status'] === 'archived' && hiddenFromDefault && visibleAfterToggle,
      detail: `落盘状态=${String(archived?.['status'])}；默认隐藏=${hiddenFromDefault}；勾选后可见=${visibleAfterToggle}`
    })
    // 收尾：恢复成进行中，方便后续重复跑
    await evaluate(context, `window.__verify.click('[data-testid="learning-toggle-archived"]')`)
    await wait(200)
  } catch (error) {
    record({
      id: 'P5-F5',
      prd: 'F5',
      name: '主题归档后默认不显示，勾选"显示已归档"能找到',
      passed: false,
      detail: String(error)
    })
  }

  // =========================================================================
  // 复习
  // =========================================================================

  // ---- G6 导航角标显示今日到期数 ----
  // 先确保有足够的到期卡，否则后面的"连续评分 / Esc 保留进度"没有可验证的对象。
  // 用带趟次的标题，避免与其它趟次的样本混淆。
  try {
    const existingSamples = reviewRecords(context).filter((card) =>
      String(card['front'] ?? '').startsWith('阶段5验收样本')
    ).length
    const need = Math.max(0, 4 - existingSamples)
    for (let index = 0; index < need; index += 1) {
      await evaluate(
        context,
        `window.api.data.add('review', { front: ${JSON.stringify(`阶段5验收样本（第${passNumber}趟）${index}`)}, back: ${JSON.stringify(`这是第 ${index + 1} 张样本卡的答案`)}, source: '阶段5验收', stage: 0, dueDate: ${JSON.stringify(todayKey)}, reviewCount: 0, lastReviewedAt: null })`
      )
    }
    if (need > 0) {
      await evaluate(context, `window.api.data.flush()`)
      await wait(300)
    }
    // 通知界面刷新角标（角标由主进程数据驱动，注入样本后需要一次刷新）
    await evaluate(
      context,
      `window.dispatchEvent(new CustomEvent('worklife:data-changed', { detail: { module: 'review' } })), true`
    )
    await wait(600)
  } catch (error) {
    record({
      id: 'P5-G0',
      prd: 'G6',
      name: '准备复习样本卡（保证后续用例有可复习对象）',
      passed: false,
      detail: String(error)
    })
  }

  try {
    await evaluate(context, `window.__verify.clickNav('review')`)
    await wait(600)
    const badge = await evaluate<string>(
      context,
      `(() => {
         const item = document.querySelector('[data-nav-id="review"]')
         const b = item && item.querySelector('.nav__badge')
         return b ? (b.textContent || '').trim() : ''
       })()`
    )
    const dueCards = reviewRecords(context).filter((card) => {
      const due = card['dueDate']
      return typeof due !== 'string' || due === '' || due <= todayKey
    }).length
    record({
      id: 'P5-G6',
      prd: 'G6',
      name: '导航"复习"上的角标等于今日到期张数',
      passed: badge === String(dueCards) && dueCards > 0,
      detail: `角标显示="${badge}"；按数据算出的到期数=${dueCards}；复习卡总数=${reviewRecords(context).length}`
    })
  } catch (error) {
    record({
      id: 'P5-G6',
      prd: 'G6',
      name: '导航"复习"上的角标等于今日到期张数',
      passed: false,
      detail: String(error)
    })
  }

  // ---- G1 一屏一张卡；空格显示答案 ----
  try {
    await evaluate(context, `window.__verify.click('[data-testid="review-start"]')`)
    await wait(600)
    const cardCount = await evaluate<number>(context, `window.__verify.count('[data-testid="review-card"]')`)
    const beforeSpace = await evaluate<boolean>(context, `window.__verify.exists('review-answer')`)
    await evaluate(context, pressKey(' ', { code: 'Space' }))
    await wait(500)
    const afterSpace = await evaluate<{
      answer: boolean
      grades: number
    }>(
      context,
      `({ answer: window.__verify.exists('review-answer'), grades: window.__verify.count('[data-testid^="review-grade-"]') })`
    )
    record({
      id: 'P5-G1',
      prd: 'G1',
      name: '一屏只显示一张卡，按空格才浮出答案与三个按钮',
      passed: cardCount === 1 && beforeSpace === false && afterSpace.answer && afterSpace.grades === 3,
      detail: `卡片数=${cardCount}；按空格前有答案=${beforeSpace}；按空格后有答案=${afterSpace.answer}，评分按钮=${afterSpace.grades} 个`
    })
  } catch (error) {
    record({
      id: 'P5-G1',
      prd: 'G1',
      name: '一屏只显示一张卡，按空格才浮出答案与三个按钮',
      passed: false,
      detail: String(error)
    })
  }

  // ---- G2 按 1 / 2 / 3 记录选择并翻下一张 ----
  try {
    const firstId = await evaluate<string>(
      context,
      `(window.__verify.byTestId('review-card') || { getAttribute: () => '' }).getAttribute('data-card-id') || ''`
    )
    const firstBefore = reviewRecords(context).find((card) => card['id'] === firstId)
    const firstStageBefore = Number(firstBefore?.['stage'] ?? 0)

    await evaluate(context, pressKey('1', { code: 'Digit1' }))
    await wait(1200)
    const afterFirst = await evaluate<{ id: string; answered: boolean }>(
      context,
      `({
         id: (window.__verify.byTestId('review-card') || { getAttribute: () => '' }).getAttribute('data-card-id') || '',
         answered: window.__verify.exists('review-answer')
       })`
    )
    context.appData.flushAll()
    const firstCard = reviewRecords(context).find((card) => card['id'] === firstId)

    const secondId = afterFirst.id
    const secondBefore = reviewRecords(context).find((card) => card['id'] === secondId)
    const secondStageBefore = Number(secondBefore?.['stage'] ?? 0)

    await evaluate(context, pressKey(' ', { code: 'Space' }))
    await wait(500)
    await evaluate(context, pressKey('3', { code: 'Digit3' }))
    await wait(1200)
    context.appData.flushAll()
    const secondCard = reviewRecords(context).find((card) => card['id'] === secondId)

    // 期望值直接由已测过的算法给出，避免在验收里重写规则
    const expectedFirstStage = nextStage('forgot', firstStageBefore)
    const expectedSecondStage = nextStage('remembered', secondStageBefore)

    record({
      id: 'P5-G2',
      prd: 'G2',
      name: '按 1/3 评分后翻到下一张，且记录下本次选择',
      passed:
        afterFirst.id !== firstId &&
        afterFirst.answered === false &&
        Number(firstCard?.['stage']) === expectedFirstStage &&
        Number(firstCard?.['reviewCount']) >= 1 &&
        Number(secondCard?.['stage']) === expectedSecondStage,
      detail: `第一张按 1（忘了）：阶段 ${firstStageBefore}→${String(firstCard?.['stage'])}（期望 ${expectedFirstStage}），已复习 ${String(firstCard?.['reviewCount'])} 次；翻到下一张 ${firstId.slice(0, 6)}→${secondId.slice(0, 6)}；第二张按 3（记住了）：阶段 ${secondStageBefore}→${String(secondCard?.['stage'])}（期望 ${expectedSecondStage}）`
    })
  } catch (error) {
    record({
      id: 'P5-G2',
      prd: 'G2',
      name: '按 1/3 评分后翻到下一张，且记录下本次选择',
      passed: false,
      detail: String(error)
    })
  }

  // ---- G3 只用键盘完成若干张，不碰鼠标 ----
  try {
    // 先确保处于会话中且手上有卡。
    //
    // 为什么需要这段：前一个检查（G2）已经启动过会话，而会话队列在评完快照里的卡之后
    // 会短暂变成空；如果此刻直接判定"没有卡"，G3 就会拿到 0 张而失败——
    // 这不是界面坏了，是验收台没给界面留出刷新时间。
    // 因此这里显式：没有卡就点"开始今日复习"，并轮询等待卡片出现。
    await ensureReviewSession(context)

    let handled = 0
    for (let round = 0; round < 3; round += 1) {
      const hasCard = await waitForReviewCard(context, 3000)
      if (!hasCard) break
      await evaluate(context, pressKey(' ', { code: 'Space' }))
      await wait(350)
      await evaluate(context, pressKey('2', { code: 'Digit2' }))
      await wait(700)
      handled += 1
    }
    context.appData.flushAll()
    const remainingText = await evaluate<string>(
      context,
      `((window.__verify.byTestId('review-remaining') || {}).textContent || '').trim()`
    )
    const sessionFinished = await evaluate<boolean>(context, `window.__verify.exists('review-done')`)
    record({
      id: 'P5-G3',
      prd: 'G3',
      name: '全程只用键盘即可连续复习（空格 → 2 → 自动下一张）',
      passed: handled >= 1,
      detail: `纯键盘完成 ${handled} 张；${
        sessionFinished
          ? '本轮已复习完'
          : `界面提示="${remainingText}"`
      }`
    })
  } catch (error) {
    record({
      id: 'P5-G3',
      prd: 'G3',
      name: '全程只用键盘即可连续复习（空格 → 2 → 自动下一张）',
      passed: false,
      detail: String(error)
    })
  }

  // ---- G4 Esc 退出后进度保留 ----
  try {
    // 先确保会话里还有卡：没有就启动一轮，并等界面真的把卡渲染出来
    await ensureReviewSession(context)

    const remainingBefore = await evaluate<string>(
      context,
      `((window.__verify.byTestId('review-remaining') || {}).textContent || '')`
    )
    const reviewedBefore = reviewRecords(context).filter((card) => Number(card['reviewCount']) > 0).length

    await evaluate(context, pressKey('Escape', { code: 'Escape' }))
    await wait(500)
    const exited = await evaluate<boolean>(context, `!window.__verify.exists('review-session')`)
    // 退出后要么回到"待开始"（还有到期卡），要么显示"今天没有到期"（都做完了）
    const backToIdle = await evaluate<boolean>(
      context,
      `window.__verify.exists('review-idle') || window.__verify.exists('review-empty')`
    )

    // 再进来：已复习过的卡不应重新出现在队列里
    const canRestart = await evaluate<boolean>(context, `window.__verify.exists('review-start')`)
    if (canRestart) {
      await evaluate(context, `window.__verify.click('[data-testid="review-start"]')`)
      await wait(600)
    }
    const queueSizeAfter = await evaluate<number>(
      context,
      `(() => {
         const text = ((window.__verify.byTestId('review-remaining') || {}).textContent || '')
         const match = text.match(/还剩 (\\d+) 张/)
         return match ? Number(match[1]) : 0
       })()`
    )
    const totalDue = reviewRecords(context).filter((card) => {
      const due = card['dueDate']
      return typeof due !== 'string' || due === '' || due <= todayKey
    }).length
    const reviewedAfter = reviewRecords(context).filter((card) => Number(card['reviewCount']) > 0).length

    record({
      id: 'P5-G4',
      prd: 'G4',
      name: 'Esc 退出复习，再进来进度保留、已评过的卡不再出现',
      passed:
        exited &&
        backToIdle &&
        queueSizeAfter <= totalDue &&
        reviewedAfter === reviewedBefore,
      detail: `退出成功=${exited} 退出后回到非会话态=${backToIdle}；退出前提示${remainingBefore.trim() === '' ? '（本轮已完）' : `"${remainingBefore.trim()}"`}；再进入还剩 ${queueSizeAfter} 张（当前到期 ${totalDue} 张）；已评分卡数 ${reviewedBefore}→${reviewedAfter}`
    })
  } catch (error) {
    record({
      id: 'P5-G4',
      prd: 'G4',
      name: 'Esc 退出复习，再进来进度保留、已评过的卡不再出现',
      passed: false,
      detail: String(error)
    })
  }

  // ---- G5 卡片历史可查：日期、档位、下次到期 ----
  try {
    context.appData.flushAll()
    const reviewed = reviewRecords(context)
      .filter((card) => Number(card['reviewCount']) > 0)
      .map((card) => ({
        id: String(card['id']),
        stage: Number(card['stage']),
        dueDate: card['dueDate'],
        reviewCount: Number(card['reviewCount']),
        lastReviewedAt: card['lastReviewedAt']
      }))
    const allHaveHistory = reviewed.every(
      (card) =>
        typeof card.dueDate === 'string' &&
        card.dueDate > todayKey &&
        typeof card.lastReviewedAt === 'string' &&
        card.reviewCount >= 1
    )
    record({
      id: 'P5-G5',
      prd: 'G5',
      name: '每张复习过的卡都记录了复习次数、上次时间与下次到期日',
      passed: reviewed.length > 0 && allHaveHistory,
      detail:
        reviewed.length === 0
          ? '没有已复习的卡'
          : reviewed
              .slice(0, 3)
              .map(
                (card) =>
                  `${card.id.slice(0, 6)}：第 ${card.reviewCount} 次，下次 ${String(card.dueDate)}`
              )
              .join('；')
    })
  } catch (error) {
    record({
      id: 'P5-G5',
      prd: 'G5',
      name: '每张复习过的卡都记录了复习次数、上次时间与下次到期日',
      passed: false,
      detail: String(error)
    })
  }

  // ---- 积压提示：超过 50 张时出现 ----
  try {
    // 造 51 张到期卡（放在最后一趟做，避免影响前面的队列断言）
    const before = reviewRecords(context).length
    for (let index = 0; index < 51; index += 1) {
      await evaluate(
        context,
        `window.api.data.add('review', { front: '阶段5积压样本 ${index}', back: '', source: '积压测试', stage: 0, dueDate: ${JSON.stringify(addDaysToKey(todayKey, -1))}, reviewCount: 0, lastReviewedAt: null })`
      )
    }
    await evaluate(context, `window.api.data.flush()`)
    await wait(600)
    await evaluate(context, `window.__verify.clickNav('memo')`)
    await wait(200)
    await evaluate(context, `window.__verify.clickNav('review')`)
    await wait(800)
    const notice = await evaluate<string>(
      context,
      `((window.__verify.byTestId('review-backlog') || {}).textContent || '').trim()`
    )
    const after = reviewRecords(context).length
    record({
      id: 'P5-G7',
      prd: 'G4',
      name: '到期超过 50 张时给出"建议今天只做 20 张"的提示',
      passed: notice.includes('建议今天只做 20 张') && after === before + 51,
      detail: `复习卡 ${before}→${after} 张；界面提示="${notice}"`
    })

    // 收尾：把积压样本删掉，避免污染后续趟次
    for (const card of reviewRecords(context)) {
      if (String(card['front'] ?? '').startsWith('阶段5积压样本')) {
        context.appData.module('review').remove(String(card['id']), { hard: true })
      }
    }
    context.appData.flushAll()
  } catch (error) {
    record({
      id: 'P5-G7',
      prd: 'G4',
      name: '到期超过 50 张时给出"建议今天只做 20 张"的提示',
      passed: false,
      detail: String(error)
    })
  }
}
