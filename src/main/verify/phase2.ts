/**
 * 阶段 2 验收检查（DEVPLAN 阶段 2 / PRD §10.3）
 *
 * 覆盖：十项导航都能点且没有空白页、三个待开发模块的说明卡、角标、
 *       快速记一笔（Ctrl+Alt+M）、搜索（Ctrl+K）、Esc 关闭抽屉、主题切换。
 *
 * 做法：在渲染进程里真实读取 DOM 并派发点击/键盘事件，
 * 而不是"看代码觉得没问题"。
 */
import { dateKey } from '../../shared/date'
import { normalizePlanTask } from '../../shared/plan'
import { countsAsOverdue } from '../../shared/planLogic'
import type { VerifyCheck, VerifyContext } from './runner'

type Recorder = (check: VerifyCheck) => void

/** 在渲染进程执行一段脚本并取回结果 */
async function evaluate<T>(context: VerifyContext, expression: string): Promise<T> {
  return (await context.window.webContents.executeJavaScript(expression)) as T
}

/** 注入到渲染进程的 DOM 小工具 */
const DOM_HELPERS = `
  window.__verify = {
    byTestId: (id) => document.querySelector('[data-testid="' + id + '"]'),
    navButton: (id) => document.querySelector('[data-nav-id="' + id + '"]'),
    clickNav: (id) => {
      const el = document.querySelector('[data-nav-id="' + id + '"]')
      if (!el) return false
      el.click()
      return true
    },
    click: (selector) => {
      const el = document.querySelector(selector)
      if (!el) return false
      el.click()
      return true
    },
    key: (key, options) => {
      const opts = Object.assign({ bubbles: true, cancelable: true }, options || {})
      window.dispatchEvent(new KeyboardEvent('keydown', Object.assign({ key }, opts)))
      return true
    },
    navLabels: () => Array.from(document.querySelectorAll('[data-nav-id]')).map((el) => el.textContent.trim()),
    navIds: () => Array.from(document.querySelectorAll('[data-nav-id]')).map((el) => el.getAttribute('data-nav-id')),
    activeView: () => document.querySelector('[data-testid="workspace"]').getAttribute('data-view'),
    pageTitle: () => {
      const el = document.querySelector('.page__title')
      return el ? el.textContent.trim() : null
    },
    rootLength: () => {
      const el = document.getElementById('root')
      return el ? el.innerHTML.length : -1
    },
    exists: (id) => !!document.querySelector('[data-testid="' + id + '"]'),
    count: (selector) => document.querySelectorAll(selector).length,
    html: (id) => {
      const el = document.querySelector('[data-testid="' + id + '"]')
      return el ? el.innerHTML : null
    },
    theme: () => document.documentElement.getAttribute('data-theme'),
    setSelect: (id, value) => {
      const el = document.querySelector('[data-testid="' + id + '"]')
      if (!el) return false
      // 与 setText 同理：React 受控组件只认原生 setter 触发的变更。
      // 直接写 el.value 再派发 change，能不能触发 onChange 取决于 React 内部的
      // value 追踪状态——实测偶尔不触发，表现为"切换主题/下拉框随机不生效"。
      const proto = HTMLSelectElement.prototype
      const descriptor = Object.getOwnPropertyDescriptor(proto, 'value')
      if (descriptor && descriptor.set) descriptor.set.call(el, value)
      else el.value = value
      el.dispatchEvent(new Event('change', { bubbles: true }))
      return true
    },
    setText: (id, value) => {
      const el = document.querySelector('[data-testid="' + id + '"]')
      if (!el) return false
      // React 受控组件只认原生 setter 触发的变更，
      // 直接赋 el.value 再派发 input 事件在 React 18+ 里不会更新 state。
      const proto = el instanceof HTMLTextAreaElement
        ? HTMLTextAreaElement.prototype
        : HTMLInputElement.prototype
      const descriptor = Object.getOwnPropertyDescriptor(proto, 'value')
      if (descriptor && descriptor.set) descriptor.set.call(el, value)
      else el.value = value
      el.dispatchEvent(new Event('input', { bubbles: true }))
      return true
    }
  }
  'helpers-ready'
`

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

export async function runPhase2Checks(context: VerifyContext, record: Recorder): Promise<void> {
  await evaluate(context, DOM_HELPERS)

  // ---- 1. 十项导航齐全，顺序与分组正确（C1）----
  try {
    const ids = await evaluate<string[]>(context, 'window.__verify.navIds()')
    const expected = [
      'home',
      'plan',
      'learning',
      'review',
      'reading',
      'memo',
      'project',
      'research',
      'ledger',
      'settings'
    ]
    record({
      id: 'P2-1',
      prd: 'C1',
      name: '导航栏显示全部 10 项且顺序正确',
      passed: JSON.stringify(ids) === JSON.stringify(expected),
      detail: `实际顺序：${ids.join(' → ')}`
    })
  } catch (error) {
    record({
      id: 'P2-1',
      prd: 'C1',
      name: '导航栏显示全部 10 项且顺序正确',
      passed: false,
      detail: String(error)
    })
  }

  // ---- 2. 逐项点击：都能切过去，且不出现空白页（C1）----
  const navIds = [
    'home',
    'plan',
    'learning',
    'review',
    'reading',
    'memo',
    'project',
    'research',
    'ledger',
    'settings'
  ]
  const failures: string[] = []
  const details: string[] = []
  try {
    for (const id of navIds) {
      await evaluate(context, `window.__verify.clickNav('${id}')`)
      await wait(60)
      const state = await evaluate<{ view: string; rootLength: number; title: string | null }>(
        context,
        `({ view: window.__verify.activeView(), rootLength: window.__verify.rootLength(), title: window.__verify.pageTitle() })`
      )
      const ok = state.view === id && state.rootLength > 200 && state.title !== null
      if (!ok) failures.push(`${id}(view=${state.view} len=${state.rootLength} title=${state.title})`)
      details.push(`${id}:${state.title ?? '无标题'}`)
    }
    record({
      id: 'P2-2',
      prd: 'C1',
      name: '十项导航逐项点击都能切换且内容非空',
      passed: failures.length === 0,
      detail: failures.length === 0 ? details.join('，') : `失败：${failures.join('；')}`
    })
  } catch (error) {
    record({
      id: 'P2-2',
      prd: 'C1',
      name: '十项导航逐项点击都能切换且内容非空',
      passed: false,
      detail: String(error)
    })
  }

  // ---- 3. 三个待开发模块显示说明卡，且卡上没有按钮（C2）----
  try {
    const results: string[] = []
    let allOk = true
    for (const id of ['project', 'research', 'ledger']) {
      await evaluate(context, `window.__verify.clickNav('${id}')`)
      await wait(60)
      const info = await evaluate<{
        hasCard: boolean
        featureCount: number
        buttonCount: number
        text: string
      }>(
        context,
        `(() => {
           const card = window.__verify.byTestId('placeholder-page')
           return {
             hasCard: !!card,
             featureCount: window.__verify.count('.feature-list__item'),
             buttonCount: card ? card.querySelectorAll('button').length : -1,
             text: card ? card.textContent : ''
           }
         })()`
      )
      const ok =
        info.hasCard &&
        info.featureCount >= 3 &&
        info.buttonCount === 0 &&
        info.text.includes('待开发')
      if (!ok) allOk = false
      results.push(
        `${id}: 卡片=${info.hasCard} 功能条数=${info.featureCount} 按钮数=${info.buttonCount}`
      )
    }
    record({
      id: 'P2-3',
      prd: 'C2',
      name: '待开发模块点开是说明卡，且卡上没有任何可用按钮',
      passed: allOk,
      detail: results.join('；')
    })
  } catch (error) {
    record({
      id: 'P2-3',
      prd: 'C2',
      name: '待开发模块点开是说明卡，且卡上没有任何可用按钮',
      passed: false,
      detail: String(error)
    })
  }

  // ---- 4. Ctrl+Alt+M 唤出快速记一笔（C4）----
  try {
    await evaluate(context, `window.__verify.key('m', { ctrlKey: true, altKey: true })`)
    await wait(80)
    const opened = await evaluate<boolean>(context, `window.__verify.exists('quick-capture')`)
    await evaluate(context, `window.__verify.key('Escape')`)
    await wait(80)
    const closed = await evaluate<boolean>(context, `!window.__verify.exists('quick-capture')`)
    record({
      id: 'P2-4',
      prd: 'C4',
      name: 'Ctrl+Alt+M 唤出快速记一笔，Esc 关闭',
      passed: opened && closed,
      detail: `唤出=${opened} Esc 后关闭=${closed}`
    })
  } catch (error) {
    record({
      id: 'P2-4',
      prd: 'C4',
      name: 'Ctrl+Alt+M 唤出快速记一笔，Esc 关闭',
      passed: false,
      detail: String(error)
    })
  }

  // ---- 5. Ctrl+K 打开搜索并聚焦输入框（C5）----
  try {
    await evaluate(context, `window.__verify.key('k', { ctrlKey: true })`)
    await wait(120)
    const state = await evaluate<{ open: boolean; focused: boolean }>(
      context,
      `({
         open: window.__verify.exists('search-drawer'),
         focused: document.activeElement === window.__verify.byTestId('search-input')
       })`
    )
    record({
      id: 'P2-5',
      prd: 'C5',
      name: 'Ctrl+K 打开搜索并且输入框已获得焦点',
      passed: state.open && state.focused,
      detail: `抽屉打开=${state.open} 输入框聚焦=${state.focused}`
    })
  } catch (error) {
    record({
      id: 'P2-5',
      prd: 'C5',
      name: 'Ctrl+K 打开搜索并且输入框已获得焦点',
      passed: false,
      detail: String(error)
    })
  }

  // ---- 6. Esc 能关闭抽屉（C6）----
  try {
    await evaluate(context, `window.__verify.key('Escape')`)
    await wait(100)
    const closed = await evaluate<boolean>(context, `!window.__verify.exists('search-drawer')`)
    record({
      id: 'P2-6',
      prd: 'C6',
      name: 'Esc 关闭已打开的抽屉',
      passed: closed,
      detail: `抽屉已关闭=${closed}`
    })
  } catch (error) {
    record({
      id: 'P2-6',
      prd: 'C6',
      name: 'Esc 关闭已打开的抽屉',
      passed: false,
      detail: String(error)
    })
  }

  // ---- 7. 输入框里按单键不触发全局热键 ----
  // N 是阶段 4 的"新建"热键，这里先验证框架层面的"输入中不误触"。
  try {
    await evaluate(context, `window.__verify.key('k', { ctrlKey: true })`)
    await wait(150)
    const result = await evaluate<{
      drawerOpen: boolean
      focused: boolean
      stillOpenAfterKey: boolean
    }>(
      context,
      `(() => {
         const input = window.__verify.byTestId('search-input')
         if (!input) return { drawerOpen: window.__verify.exists('search-drawer'), focused: false, stillOpenAfterKey: false }
         input.focus()
         const focused = document.activeElement === input
         input.dispatchEvent(new KeyboardEvent('keydown', { key: 'n', bubbles: true }))
         return {
           drawerOpen: window.__verify.exists('search-drawer'),
           focused,
           stillOpenAfterKey: window.__verify.exists('search-drawer')
         }
       })()`
    )
    await evaluate(context, `window.__verify.key('Escape')`)
    await wait(80)
    record({
      id: 'P2-7',
      prd: 'C4',
      name: '在输入框内按单键不会误触发全局热键',
      passed: result.drawerOpen && result.focused && result.stillOpenAfterKey,
      detail: `抽屉打开=${result.drawerOpen} 输入框聚焦=${result.focused} 按 n 后仍打开=${result.stillOpenAfterKey}`
    })
  } catch (error) {
    record({
      id: 'P2-7',
      prd: 'C4',
      name: '在输入框内按单键不会误触发全局热键',
      passed: false,
      detail: String(error)
    })
  }

  // ---- 8. 快速记一笔真的能存下数据（阶段 2 端到端）----
  try {
    const before = context.appData.module('memo').list().length
    await evaluate(context, `window.__verify.key('m', { ctrlKey: true, altKey: true })`)
    await wait(80)
    await evaluate(context, `window.__verify.setText('quick-input', '阶段2验收：快速记一笔')`)
    await wait(50)
    await evaluate(context, `window.__verify.click('[data-testid="quick-save"]')`)
    // 等界面完成保存；随后显式落盘，保证进入后续检查前磁盘已是最新
    await wait(500)
    context.appData.flushAll()
    const after = context.appData.module('memo').list().length
    const saved = context.appData
      .module('memo')
      .list()
      .some((item) => item['text'] === '阶段2验收：快速记一笔')
    record({
      id: 'P2-8',
      prd: 'C4',
      name: '快速记一笔保存后数据真的落到主进程',
      passed: after === before + 1 && saved,
      detail: `备忘 ${before} → ${after} 条，内容命中=${saved}`
    })
  } catch (error) {
    record({
      id: 'P2-8',
      prd: 'C4',
      name: '快速记一笔保存后数据真的落到主进程',
      passed: false,
      detail: String(error)
    })
  }

  // ---- 9. 角标与红点只出现在该出现的导航项上（PRD §2.2）----
  // 注意：这里不再断言"角标数为 0"——阶段 5 接入复习后，有到期卡就应当显示角标。
  // 正确的判据是：
  //   - 角标只可能出现在"复习"上，且数量等于今日到期数
  //   - 红点只可能出现在"计划"上，且仅当存在逾期任务
  try {
    const state = await evaluate<{
      badgeItems: string[]
      badgeText: string
      dotItems: string[]
      itemCount: number
    }>(
      context,
      `(() => {
         const items = Array.from(document.querySelectorAll('[data-nav-id]'))
         const badgeItems = items.filter(el => el.querySelector('.nav__badge')).map(el => el.getAttribute('data-nav-id'))
         const dotItems = items.filter(el => el.querySelector('.nav__dot')).map(el => el.getAttribute('data-nav-id'))
         const review = document.querySelector('[data-nav-id="review"]')
         const badge = review && review.querySelector('.nav__badge')
         return {
           badgeItems,
           badgeText: badge ? (badge.textContent || '').trim() : '',
           dotItems,
           itemCount: items.length
         }
       })()`
    )

    const todayKey = dateKey(new Date())
    /**
     * "今天到期几张"只数**卡片**。
     *
     * 第 06 块起 review 模块里还有 `kind:'history'` 的复习历史记录：
     * 它们没有 `dueDate`，而下面这条过滤条件是"不是字符串就算了"，
     * 于是历史会被算成"到期"——角标显示 3，这里算出 56，检查无故变红。
     * 判据（角标文本 === 到期张数）一个字没改，只是把"哪些记录算卡片"说清楚。
     */
    const dueCount = context.appData
      .module('review')
      .list()
      .filter((card) => card['kind'] !== 'history')
      .filter((card) => {
        const due = card['dueDate']
        return typeof due !== 'string' || due === '' || due <= todayKey
      }).length
    /**
     * 红点的"实际有逾期"必须与界面用**同一条规则**。
     *
     * ⚠️ 这里原来是手写的一份判据（`done !== true && date < today && date !== 'unscheduled'`），
     * 修改 4 轮加了第三态「放弃」之后两份判据就分家了：放弃的任务**不算逾期**
     * （`shared/planLogic.isOverdue` 早退），而手写那份还会把它数进去，
     * 于是表现成"红点没出现、验收却说有逾期"（本趟 P2-9 就是这么红的）。
     *
     * 改法不是放宽断言，而是**把口径换成唯一那份实现**：
     * 与 `shared/badges.ts` 的 `computeBadges()` 完全一致——先滤掉软删除，
     * 再用 `normalizePlanTask` + `countsAsOverdue`。红点仍然必须与数据一致，
     * 判据一个字都没软。
     *
     * 修改 7 轮：`isOverdue` → `countsAsOverdue`（用户「标记未完成不显示逾期」）。
     * 这不是放宽：红点的口径本来就必须等于 `computeBadges()`，而它改成了统计口径；
     * 两边继续用同一个函数才算"唯一那份实现"。
     */
    const hasOverdue = context.appData
      .module('plan')
      .list()
      .filter((task) => task['deletedAt'] === undefined || task['deletedAt'] === null)
      .map((task) => normalizePlanTask(task as Record<string, unknown>))
      .filter((task) => task.id !== '' && task.title !== '')
      .some((task) => countsAsOverdue(task, todayKey))

    const badgeOk =
      state.badgeItems.every((id) => id === 'review') &&
      (dueCount === 0 ? state.badgeItems.length === 0 : state.badgeText === String(dueCount))
    const dotOk =
      state.dotItems.every((id) => id === 'plan') && (hasOverdue ? state.dotItems.includes('plan') : state.dotItems.length === 0)

    record({
      id: 'P2-9',
      prd: 'C3',
      name: '角标只出现在复习、红点只出现在计划，且与数据一致',
      passed: badgeOk && dotOk && state.itemCount === 10,
      detail: `带角标的导航项=[${state.badgeItems.join(', ')}]（应为 review 或空），角标文本="${state.badgeText}"，实际今日到期=${dueCount}；带红点的导航项=[${state.dotItems.join(', ')}]（应为 plan 或空），实际有逾期=${hasOverdue}`
    })
  } catch (error) {
    record({
      id: 'P2-9',
      prd: 'C3',
      name: '角标只出现在复习、红点只出现在计划，且与数据一致',
      passed: false,
      detail: String(error)
    })
  }
}
