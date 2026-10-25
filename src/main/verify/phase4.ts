/**
 * 阶段 4 验收检查（DEVPLAN 阶段 4 / PRD §10.4 D、§10.5 E、§10.9 I）
 *
 * 覆盖计划、备忘录、首页三个模块的真实界面行为。
 *
 * ## 关于"自动顺延"（E5）——**修改 5 轮已反转口径**
 *
 * 以前：启动时自动顺延只跑一次 → 拆成两趟，第 1 趟造样本、第 2 趟验证它被**自动**挪走。
 * 现在（用户要求）：**不再自动顺延**，改由用户手动把「某一天」的未完成移到「指定的某一天」。
 * 所以仍然是两趟，但第 2 趟验的是**反过来的事**：
 *   - 第 1 趟：通过界面加一条"昨天到期"的任务（样本本身照旧有用）
 *   - 第 2 趟：本次启动后它**仍在昨天、顺延次数仍为 0**（证明没有自动搬）
 *             再**手动**用「移动某天未完成的…」面板把它移走，才变成目标日期、次数 +1
 *
 * ⚠️ 这是**反转改写**，不是删除：判据从"被自动挪走"变成"没被自动挪走 + 手动能挪走"。
 */
import { dateKey, addDaysToKey } from '../../shared/date'
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

/**
 * 轮询直到条件成立；**超时返回 null**（不返回"最后一次取值"，免得写成假通过）。
 *
 * 与 `phase8.ts` 的 `until` 同一套用法；验收台硬规矩第 1 条：轮询等待，不用固定延时。
 */
async function until<T>(
  context: VerifyContext,
  expression: string,
  accept: (value: T) => boolean,
  attempts = 16,
  interval = 250
): Promise<T | null> {
  for (let index = 0; index < attempts; index += 1) {
    const value = (await evaluate<T>(context, expression)) as T
    if (accept(value)) return value
    await wait(interval)
  }
  return null
}

/**
 * 用**原生 setter** 写受控输入框的值，并同时派发 input / change。
 *
 * 验收台硬规矩第 4 条：`date` / `time` 这类受控输入框只派发 input 有时推不动
 * React 的 onChange，补一个 change 更稳。返回实际写进去的值（找不到元素时返回 `__missing__`）。
 */
async function setInputValue(
  context: VerifyContext,
  testId: string,
  value: string
): Promise<string> {
  return evaluate<string>(
    context,
    `(() => {
       const el = window.__verify.byTestId(${JSON.stringify(testId)})
       if (!el) return '__missing__'
       const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype
       const descriptor = Object.getOwnPropertyDescriptor(proto, 'value')
       if (descriptor && descriptor.set) descriptor.set.call(el, ${JSON.stringify(value)})
       else el.value = ${JSON.stringify(value)}
       el.dispatchEvent(new Event('input', { bubbles: true }))
       el.dispatchEvent(new Event('change', { bubbles: true }))
       return el.value
     })()`
  )
}

/** 「不再自动顺延 / 手动搬走」用的哨兵标题，跨趟识别同一条任务 */
const CARRYOVER_SENTINEL = '阶段4验收：昨天该做没做的事'
/** 首页展开用的哨兵标题前缀 */
const EXPAND_PREFIX = '阶段4展开验收'

function tasks(context: VerifyContext): Record<string, unknown>[] {
  return context.appData
    .module('plan')
    .list()
    .map((record) => record as unknown as Record<string, unknown>)
}

function findTask(context: VerifyContext, title: string): Record<string, unknown> | undefined {
  return tasks(context).find((task) => task['title'] === title)
}

function memos(context: VerifyContext): Record<string, unknown>[] {
  return context.appData
    .module('memo')
    .list()
    .map((record) => record as unknown as Record<string, unknown>)
}

export async function runPhase4Checks(
  context: VerifyContext,
  record: Recorder,
  passNumber: number
): Promise<void> {
  const todayKey = dateKey(new Date())
  const yesterdayKey = addDaysToKey(todayKey, -1)

  // =========================================================================
  // 计划
  // =========================================================================

  // 验收会产生跨趟残留数据，因此标题带上趟次，保证本趟点到的就是本趟造的那一条
  const titleA = `阶段4验收：任务甲（第${passNumber}趟）`
  const titleB = `阶段4验收：任务乙（第${passNumber}趟）`
  const titleC = `阶段4验收：任务丙（第${passNumber}趟）`

  // ---- E1 行内快速新建，可连建 ----
  await evaluate(context, `window.__verify.clickNav('plan')`)
  await wait(300)
  try {
    const titles = [titleA, titleB, titleC]
    for (const title of titles) {
      await evaluate(context, `window.__verify.setText('plan-quick-add', ${JSON.stringify(title)})`)
      await wait(60)
      await evaluate(
        context,
        `(() => {
           const el = window.__verify.byTestId('plan-quick-add')
           el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
           return true
         })()`
      )
      await wait(320)
    }
    context.appData.flushAll()
    const created = titles.filter((title) => findTask(context, title))
    const todayCreated = created.filter((title) => findTask(context, title)?.['date'] === todayKey)
    record({
      id: 'P4-E1',
      prd: 'E1',
      name: '行内连续新建三条任务，都落在今天',
      passed: created.length === 3 && todayCreated.length === 3,
      detail: `创建成功 ${created.length}/3，其中今天到期 ${todayCreated.length}/3`
    })
  } catch (error) {
    record({
      id: 'P4-E1',
      prd: 'E1',
      name: '行内连续新建三条任务，都落在今天',
      passed: false,
      detail: String(error)
    })
  }

  // ---- E6 逾期任务置顶显示并带标记 ----
  try {
    // 关键：必须在"页面已经挂载之后"再注入这条昨天的任务，
    // 注入后靠 `worklife:data-changed` 让计划页重新读盘，
    // 才能真实观察到"逾期分组 + 标红 + 逾期字样"。
    // （修改 5 轮起计划页**不再自动顺延**，所以这条昨天的任务不会再被搬走——
    //   它留在原地正是这一条要看的画面。）
    await evaluate(
      context,
      `window.api.data.add('plan', { title: '阶段4验收：逾期项', date: ${JSON.stringify(yesterdayKey)}, timeSlot: 'none', recurrence: 'none', done: false, carriedOver: 0, doneAt: null })`
    )
    await evaluate(context, `window.api.data.flush()`)
    // 通知界面重新加载（React 的更新是异步的，必须分两次调用并在中间等待）
    await evaluate(
      context,
      `window.dispatchEvent(new CustomEvent('worklife:data-changed', { detail: { module: 'plan' } })), true`
    )
    await wait(800)

    const state = await evaluate<{
      hasOverdueGroup: boolean
      firstRowIsOverdue: boolean
      overdueMarked: boolean
      headerText: string
      planState: string
    }>(
      context,
      `(() => {
         const group = window.__verify.byTestId('group-overdue')
         const rows = Array.from(document.querySelectorAll('[data-testid="task-row"]'))
         const first = rows[0]
         const state = window.__verify.byTestId('plan-state')
         return {
           hasOverdueGroup: !!group,
           firstRowIsOverdue: !!first && first.className.indexOf('task--overdue') >= 0,
           overdueMarked: !!group && group.textContent.indexOf('逾期') >= 0,
           headerText: (document.querySelector('.page__description') || {}).textContent || '',
           planState: state
             ? 'view=' + state.getAttribute('data-view') +
               ' activeDay=' + state.getAttribute('data-active-day') +
               ' today=' + state.getAttribute('data-today') +
               ' calendar=' + !!document.querySelector('[data-testid="calendar"]') +
               ' rows=' + rows.length
             : '（没有 plan-state）'
         }
       })()`
    )
    record({
      id: 'P4-E6',
      prd: 'E6',
      name: '逾期任务在最前面的分组里，并带逾期标记',
      passed: state.hasOverdueGroup && state.firstRowIsOverdue && state.overdueMarked,
      detail: `逾期分组存在=${state.hasOverdueGroup} 首条标红=${state.firstRowIsOverdue} 含逾期字样=${state.overdueMarked}；页头="${state.headerText.trim()}"；页面状态=${state.planState}`
    })
  } catch (error) {
    record({
      id: 'P4-E6',
      prd: 'E6',
      name: '逾期任务在最前面的分组里，并带逾期标记',
      passed: false,
      detail: String(error)
    })
  }

  // ---- E5（第一半）第 1 趟：通过界面写下一条"昨天到期"的任务，供下一趟验证**不再**自动顺延 ----
  if (passNumber === 1) {
    try {
      await evaluate(context, `window.__verify.clickNav('plan')`)
      await wait(200)
      await evaluate(
        context,
        `window.api.data.add('plan', { title: ${JSON.stringify(CARRYOVER_SENTINEL)}, date: ${JSON.stringify(yesterdayKey)}, timeSlot: 'none', recurrence: 'none', done: false, carriedOver: 0, doneAt: null })`
      )
      await evaluate(context, `window.api.data.flush()`)
      await wait(200)
      context.appData.flushAll()
      const seeded = findTask(context, CARRYOVER_SENTINEL)
      record({
        id: 'P4-E5a',
        prd: 'E5',
        name: '第 1 趟：写入一条昨天到期的任务作为「不再自动顺延」的验证样本',
        passed: seeded?.['date'] === yesterdayKey && seeded?.['carriedOver'] === 0,
        detail: `已写入「${CARRYOVER_SENTINEL}」，日期=${String(seeded?.['date'])}，顺延次数=${String(seeded?.['carriedOver'])}`
      })
    } catch (error) {
      record({
        id: 'P4-E5a',
        prd: 'E5',
        name: '第 1 趟：写入一条昨天到期的任务作为「不再自动顺延」的验证样本',
        passed: false,
        detail: String(error)
      })
    }
  }

  /**
   * ---- E5（第二半）第 2 趟：**不再自动顺延**，但手动能把「某一天」的移到「指定的某一天」 ----
   *
   * 反转改写（`修改-5.md` §8.2）：
   *   旧口径：第 2 趟启动后它被**自动**挪到今天、`carriedOver === 1`
   *   新口径：第 2 趟启动后它**仍在昨天、`carriedOver === 0`**；
   *          再手动用「移动某天未完成的…」面板把它移走，才变成目标日期、`carriedOver === 1`
   *
   * 判据刻意保留"同一条样本"：能搬动的那个入口就在界面上，验的就是它。
   */
  if (passNumber === 2) {
    try {
      // 自带前提：不能依赖"第 1 趟留下的样本"。
      // 第 2 趟开头的 P1-7 会做"导出→清空→导入"，那一步会把第 1 趟写入的样本抹掉。
      // 所以这里现场把样本摆好（有就改回去，没有就新造），不赌上一趟的残留。
      const existing = findTask(context, CARRYOVER_SENTINEL)
      if (existing && (existing['date'] !== yesterdayKey || Number(existing['carriedOver'] ?? 0) !== 0)) {
        await evaluate(
          context,
          `window.api.data.update('plan', ${JSON.stringify(String(existing['id']))}, { date: ${JSON.stringify(yesterdayKey)}, carriedOver: 0, done: false, held: false, abandoned: false })`
        )
        await evaluate(context, `window.api.data.flush()`)
        context.appData.flushAll()
      } else if (!existing) {
        context.appData.module('plan').add({
          title: CARRYOVER_SENTINEL,
          date: yesterdayKey,
          timeSlot: 'none',
          recurrence: 'none',
          done: false,
          carriedOver: 0,
          doneAt: null
        })
        context.appData.flushAll()
      }

      // 切走再切回：让计划页重新挂载 —— 旧版本**正是靠这一次挂载**把它自动搬走的
      await evaluate(context, `window.__verify.clickNav('home')`)
      await wait(250)
      await evaluate(context, `window.__verify.clickNav('plan')`)
      await wait(600)

      // ① 反过来的第一条判据：进出计划页之后它**还在昨天**，顺延次数**仍是 0**
      const unmoved = await until<{ date: string; carriedOver: number }>(
        context,
        `(async () => {
           const alive = await window.api.data.listAlive('plan')
           const hit = alive.find((item) => String(item['title'] || '') === ${JSON.stringify(CARRYOVER_SENTINEL)})
           return hit ? { date: String(hit['date'] || ''), carriedOver: Number(hit['carriedOver'] || 0) } : { date: '', carriedOver: -1 }
         })()`,
        (value) => value.date === yesterdayKey && value.carriedOver === 0
      )
      const stillYesterday = unmoved !== null

      // ② 手动搬：打开「移动某天未完成的…」面板（入口在工具条上，任何时候都显示）
      const openedPanel = await evaluate<boolean>(
        context,
        `window.__verify.click('[data-testid="plan-move-open"]')`
      )
      const panelShown = openedPanel
        ? (await until<boolean>(
            context,
            `!!window.__verify.byTestId('plan-move-panel')`,
            (value) => value === true
          )) !== null
        : false

      // ③ 源 = 昨天、目标 = 今天（受控输入框用原生 setter，见验收台硬规矩第 4 条）
      const sourceSet = panelShown ? await setInputValue(context, 'plan-move-source', yesterdayKey) : ''
      const targetSet = panelShown ? await setInputValue(context, 'plan-move-target', todayKey) : ''

      // ④ 预览要先说出数量（点之前就该看得见），确认按钮要变成可用
      const preview = await until<{ text: string; count: number; disabled: boolean }>(
        context,
        `(() => {
           const box = window.__verify.byTestId('plan-move-preview')
           const button = window.__verify.byTestId('plan-move-confirm')
           return {
             text: box ? (box.textContent || '').trim() : '',
             count: box ? Number(box.getAttribute('data-count')) : -1,
             disabled: button ? button.disabled === true : true
           }
         })()`,
        (value) => value.count >= 1 && value.disabled === false
      )

      // ⑤ 真的搬
      const confirmed = preview !== null
        ? await evaluate<boolean>(context, `window.__verify.click('[data-testid="plan-move-confirm"]')`)
        : false
      const moved = confirmed
        ? await until<{ date: string; carriedOver: number }>(
            context,
            `(async () => {
               const alive = await window.api.data.listAlive('plan')
               const hit = alive.find((item) => String(item['title'] || '') === ${JSON.stringify(CARRYOVER_SENTINEL)})
               return hit ? { date: String(hit['date'] || ''), carriedOver: Number(hit['carriedOver'] || 0) } : { date: '', carriedOver: -1 }
             })()`,
            (value) => value.date === todayKey && value.carriedOver === 1
          )
        : null
      await evaluate(context, `window.api.data.flush()`)
      context.appData.flushAll()

      // ⑥ 提示里要带源日期与目标日期（旧文案"昨天没做完的"与实际不符，已改准）
      const notice = await evaluate<string>(
        context,
        `((window.__verify.byTestId('carryover-notice') || {}).textContent || '').trim()`
      )

      record({
        id: 'P4-E5b',
        prd: 'E5',
        name: '第 2 趟：昨天未完成的任务**不再自动挪到今天**；改用「移动某天未完成的…」手动搬走才变成目标日期、顺延次数 +1',
        passed:
          stillYesterday &&
          panelShown &&
          sourceSet === yesterdayKey &&
          targetSet === todayKey &&
          preview !== null &&
          moved !== null &&
          notice.includes(yesterdayKey) &&
          notice.includes(todayKey),
        detail: `样本日期起点=${yesterdayKey}；进出计划页之后仍在昨天且次数 0=${stillYesterday}（读到 ${JSON.stringify(unmoved)}）；面板打开=${panelShown}（源写入="${sourceSet}" 目标写入="${targetSet}"）；预览="${preview?.text ?? '（没读到）'}" 数量=${preview?.count ?? '?'} 确认按钮可用=${preview !== null}；点确认=${confirmed}；搬完后=${JSON.stringify(moved)}（期望日期 ${todayKey}、次数 1）；提示="${notice}"`
      })
    } catch (error) {
      record({
        id: 'P4-E5b',
        prd: 'E5',
        name: '第 2 趟：昨天未完成的任务**不再自动挪到今天**；改用「移动某天未完成的…」手动搬走才变成目标日期、顺延次数 +1',
        passed: false,
        detail: String(error)
      })
    }
  }

  // ---- E2 勾选完成后落到已完成区，再取消可恢复 ----
  try {
    await evaluate(context, `window.__verify.clickNav('plan')`)
    await wait(400)
    const target = titleA
    const clicked = await evaluate<boolean>(
      context,
      `(() => {
         const rows = Array.from(document.querySelectorAll('[data-testid="task-row"]'))
         const row = rows.find(r => r.textContent.indexOf(${JSON.stringify(target)}) >= 0)
         if (!row) return false
         const button = row.querySelector('[data-testid="task-toggle"]')
         if (!button) return false
         button.click()
         return true
       })()`
    )
    await wait(700)
    const doneState = await evaluate<{ inDoneGroup: boolean; doneAttr: string; planState: string }>(
      context,
      `(() => {
         const group = window.__verify.byTestId('group-done')
         const rows = Array.from(document.querySelectorAll('[data-testid="task-row"]'))
         const row = rows.find(r => r.textContent.indexOf(${JSON.stringify(target)}) >= 0)
         const state = window.__verify.byTestId('plan-state')
         return {
           inDoneGroup: !!group && group.textContent.indexOf(${JSON.stringify(target)}) >= 0,
           doneAttr: row ? (row.getAttribute('data-done') || '') : 'missing',
           planState: state
             ? 'view=' + state.getAttribute('data-view') +
               ' activeDay=' + state.getAttribute('data-active-day') +
               ' today=' + state.getAttribute('data-today') +
               ' calendar=' + !!document.querySelector('[data-testid="calendar"]') +
               ' rows=' + rows.length
             : '（没有 plan-state）'
         }
       })()`
    )
    context.appData.flushAll()
    const doneInStore = findTask(context, target)?.['done'] === true

    // 再取消勾选
    await evaluate(
      context,
      `(() => {
         const rows = Array.from(document.querySelectorAll('[data-testid="task-row"]'))
         const row = rows.find(r => r.textContent.indexOf(${JSON.stringify(target)}) >= 0)
         const button = row && row.querySelector('[data-testid="task-toggle"]')
         if (button) button.click()
         return true
       })()`
    )
    await wait(700)
    context.appData.flushAll()
    const restored = findTask(context, target)?.['done'] === false

    record({
      id: 'P4-E2',
      prd: 'E2',
      name: '勾选完成后沉到已完成区，取消勾选可恢复',
      passed: clicked && doneState.inDoneGroup && doneState.doneAttr === 'true' && doneInStore && restored,
      detail: `点击成功=${clicked} 出现在已完成区=${doneState.inDoneGroup} 行状态=${doneState.doneAttr} 数据层已完成=${doneInStore} 取消后恢复=${restored}；页面状态=${doneState.planState}`
    })
  } catch (error) {
    record({
      id: 'P4-E2',
      prd: 'E2',
      name: '勾选完成后沉到已完成区，取消勾选可恢复',
      passed: false,
      detail: String(error)
    })
  }

  // ---- E3 周视图 7 列 + 拖拽改期 ----
  try {
    await evaluate(context, `window.__verify.click('[data-testid="plan-view-week"]')`)
    await wait(400)
    const week = await evaluate<{ columns: number; dates: string[] }>(
      context,
      `({
         columns: window.__verify.count('[data-testid="week-column"]'),
         dates: Array.from(document.querySelectorAll('[data-testid="week-column"]')).map(el => el.getAttribute('data-date'))
       })`
    )

    // 尽量用真实卡片拖拽；如果这周一张卡片都没有，就先造一张再拖。
    // 注意：必须拖"样本任务"那张卡片——脚本默认抓第一张，可能拖到别的任务上，
    // 那样断言样本是否移动就会误判。
    const dragScript = (title: string | null): string => `
      (() => {
         const columns = Array.from(document.querySelectorAll('[data-testid="week-column"]'))
         if (columns.length === 0) return { moved: false, targetDate: '', reason: 'no-column' }
         const cards = Array.from(document.querySelectorAll('[data-testid="week-card"]'))
         const card = ${title === null ? 'cards[0]' : `cards.find(c => (c.textContent || '').indexOf(${JSON.stringify(title)}) >= 0)`}
         if (!card) {
           const last = columns[columns.length - 1]
           return { moved: false, targetDate: last.getAttribute('data-date') || '', reason: 'no-card' }
         }
         const currentColumn = card.closest('[data-testid="week-column"]')
         const target = columns.find(c => c !== currentColumn) || columns[0]
         const dt = new DataTransfer()
         card.dispatchEvent(new DragEvent('dragstart', { bubbles: true, dataTransfer: dt }))
         target.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: dt }))
         target.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt }))
         card.dispatchEvent(new DragEvent('dragend', { bubbles: true, dataTransfer: dt }))
         return { moved: true, targetDate: target.getAttribute('data-date') || '', reason: 'ok' }
       })()
    `

    const DRAG_SAMPLE = '阶段4验收：拖拽样本'
    // 先确保样本任务存在并在今天
    const hasSample = tasks(context).some((task) => task['title'] === DRAG_SAMPLE)
    if (!hasSample) {
      await evaluate(
        context,
        `window.api.data.add('plan', { title: ${JSON.stringify(DRAG_SAMPLE)}, date: ${JSON.stringify(todayKey)}, timeSlot: 'none', recurrence: 'none', done: false, carriedOver: 0, doneAt: null })`
      )
      await evaluate(context, `window.api.data.flush()`)
      await evaluate(
        context,
        `window.dispatchEvent(new CustomEvent('worklife:data-changed', { detail: { module: 'plan' } })), true`
      )
      await wait(700)
    }

    let dragResult = await evaluate<{ moved: boolean; targetDate: string; reason: string }>(
      context,
      dragScript(DRAG_SAMPLE)
    )

    // 样本这一周没有卡片时（例如它被判为逾期并被挪走），退回到"拖第一张卡片"并把样本换成那张卡
    let trackedTitle = DRAG_SAMPLE
    if (!dragResult.moved && dragResult.reason === 'no-card') {
      const firstCardTitle = await evaluate<string>(
        context,
        `(() => { const c = document.querySelector('[data-testid="week-card"]'); return c ? (c.textContent || '').trim() : '' })()`
      )
      if (firstCardTitle !== '') {
        dragResult = await evaluate<{ moved: boolean; targetDate: string; reason: string }>(
          context,
          dragScript(firstCardTitle)
        )
        trackedTitle = firstCardTitle
      }
    }

    await wait(800)
    context.appData.flushAll()

    const movedTask = tasks(context).find((task) => task['title'] === trackedTitle)
    const movedOk =
      dragResult.moved && dragResult.reason === 'ok' && movedTask?.['date'] === dragResult.targetDate

    record({
      id: 'P4-E3',
      prd: 'E3',
      name: '本周视图显示 7 列，拖拽卡片可改期',
      passed: week.columns === 7 && movedOk,
      detail: `列数=${week.columns}（${week.dates[0]} … ${week.dates[week.dates.length - 1]}）；被拖任务="${trackedTitle}"，拖拽结果=${dragResult.reason}，目标日=${dragResult.targetDate}，落盘日期=${String(movedTask?.['date'])}`
    })

    await evaluate(context, `window.__verify.click('[data-testid="plan-view-today"]')`)
    await wait(300)
  } catch (error) {
    record({
      id: 'P4-E3',
      prd: 'E3',
      name: '本周视图显示 7 列，拖拽卡片可改期',
      passed: false,
      detail: String(error)
    })
  }

  // ---- E4 重复任务：设为每天后重开页面仍然存在，且昨天记录保留 ----
  try {
    // 把"任务乙"设为每天重复
    await evaluate(
      context,
      `(() => {
         const rows = Array.from(document.querySelectorAll('[data-testid="task-row"]'))
         const row = rows.find(r => r.textContent.indexOf(${JSON.stringify(titleB)}) >= 0)
         const button = row && row.querySelector('[data-testid="task-menu"]')
         if (button) button.click()
         return true
       })()`
    )
    await wait(200)
    const setDaily = await evaluate<boolean>(
      context,
      `(() => {
         // 第 03 块起：任务行的「⋯」与右键共用同一个通用菜单（data-testid="context-menu"），
         // 旧的自绘下拉（task-menu-panel）已被它取代——菜单项内容与点击效果不变。
         const panel = window.__verify.byTestId('context-menu')
         if (!panel) return false
         const button = Array.from(panel.querySelectorAll('button')).find(b => b.textContent.trim() === '每天')
         if (!button) return false
         button.click()
         return true
       })()`
    )
    // 等 IPC 更新真正落盘后再读（点完立刻读会拿到旧值）
    await wait(800)
    context.appData.flushAll()
    const recurring = findTask(context, titleB)
    const isDaily = recurring?.['recurrence'] === 'daily'

    // 重新进页面（等价于重开后的展现）
    await evaluate(context, `window.__verify.clickNav('memo')`)
    await wait(150)
    await evaluate(context, `window.__verify.clickNav('plan')`)
    await wait(500)
    const stillShown = await evaluate<boolean>(
      context,
      `Array.from(document.querySelectorAll('[data-testid="task-row"]')).some(r => r.textContent.indexOf(${JSON.stringify(titleB)}) >= 0)`
    )
    const markShown = await evaluate<boolean>(
      context,
      `!!document.querySelector('.task__meta--repeat')`
    )
    record({
      id: 'P4-E4',
      prd: 'E4',
      name: '任务可设为每天重复，重进页面仍在且带重复标记',
      passed: setDaily && isDaily && stillShown && markShown,
      detail: `设置成功=${setDaily} 落盘规则=${String(recurring?.['recurrence'])} 重进仍在=${stillShown} 显示重复标记=${markShown}`
    })
  } catch (error) {
    record({
      id: 'P4-E4',
      prd: 'E4',
      name: '任务可设为每天重复，重进页面仍在且带重复标记',
      passed: false,
      detail: String(error)
    })
  }

  // =========================================================================
  // 备忘录
  // =========================================================================

  await evaluate(context, `window.__verify.clickNav('memo')`)
  await wait(300)

  // ---- I1 多行备忘 + Ctrl+Enter 保存 ----
  try {
    // 富文本编辑器里"按回车"产生的是行包装（<div>），这里照着造一条两行的备忘。
    // 保存后要能被抽回两行纯文本——这正是"换行被保留"的判据。
    await injectRichHelpers(context)
    const multilineHtml = '<div>阶段4验收：第一行</div><div>阶段4验收：第二行</div>'
    const filled = await setRichHtml(context, 'memo-input', multilineHtml)
    await wait(120)
    await evaluate(
      context,
      `(() => {
         const el = window.__verify.byTestId('memo-input')
         el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true, bubbles: true }))
         return true
       })()`
    )
    await wait(700)
    context.appData.flushAll()
    const saved = memos(context).find((memo) => String(memo['text'] ?? '').includes('阶段4验收：第一行'))
    // 正文现在是富文本：判"换行还在不在"要按 contentFormat 抽纯文本，
    // 直接看原文会因为 HTML 里没有 \n 而误判（这是本块必须改的判据）
    const plain = saved === undefined ? '' : toPlainText(saved['text'], saved['contentFormat'])
    record({
      id: 'P4-I1',
      prd: 'I1',
      name: '多行备忘用 Ctrl+回车保存，换行被保留',
      passed: filled && Boolean(saved) && plain === '阶段4验收：第一行\n阶段4验收：第二行',
      detail: saved
        ? `已保存，落库长度=${String(saved['text']).length}，格式=${String(saved['contentFormat'] ?? 'plain')}；抽回纯文本="${plain.replace(/\n/g, '\\n')}"`
        : '没有找到刚保存的备忘'
    })
  } catch (error) {
    record({
      id: 'P4-I1',
      prd: 'I1',
      name: '多行备忘用 Ctrl+回车保存，换行被保留',
      passed: false,
      detail: String(error)
    })
  }

  // ---- I2 置顶后排在最前 ----
  try {
    // 先确保它是未置顶状态，这样"点一下变置顶"是确定的。
    // 正文是富文本，比对要按**纯文本**（落库的是带 <p> 的 HTML）
    const memoText = '阶段4验收：第一行\n阶段4验收：第二行'
    const target = memos(context).find(
      (memo) => toPlainText(memo['text'], memo['contentFormat']) === memoText
    )
    if (target) {
      context.appData.module('memo').update(String(target['id']), { pinned: false })
      context.appData.flushAll()
    }
    await evaluate(
      context,
      `window.dispatchEvent(new CustomEvent('worklife:data-changed', { detail: { module: 'memo' } })), true`
    )
    await wait(500)

    const pinned = await evaluate<boolean>(
      context,
      `(() => {
         const items = Array.from(document.querySelectorAll('[data-testid="memo-item"]'))
         const item = items.find(el => el.textContent.indexOf('阶段4验收：第一行') >= 0)
         if (!item) return false
         const button = item.querySelector('[data-testid="memo-pin"]')
         if (!button) return false
         button.click()
         return true
       })()`
    )
    await wait(800)
    context.appData.flushAll()
    const firstText = await evaluate<string>(
      context,
      `(() => {
         const items = document.querySelectorAll('[data-testid="memo-item"]')
         return items.length > 0 ? (items[0].textContent || '') : ''
       })()`
    )
    const storedPinned = memos(context).some(
      (memo) => String(memo['text'] ?? '').includes('阶段4验收：第一行') && memo['pinned'] === true
    )
    record({
      id: 'P4-I2',
      prd: 'I2',
      name: '置顶的备忘排在最前面',
      passed: pinned && storedPinned && firstText.includes('阶段4验收：第一行'),
      detail: `点击成功=${pinned} 已存置顶标记=${storedPinned} 列表首条含目标=${firstText.includes('阶段4验收：第一行')}`
    })
  } catch (error) {
    record({
      id: 'P4-I2',
      prd: 'I2',
      name: '置顶的备忘排在最前面',
      passed: false,
      detail: String(error)
    })
  }

  // ---- I3 备忘 → 排进计划 / 生成复习卡 ----
  try {
    const planBefore = tasks(context).length
    const reviewBefore = context.appData.module('review').list().length

    await evaluate(
      context,
      `(() => {
         const items = Array.from(document.querySelectorAll('[data-testid="memo-item"]'))
         const item = items.find(el => el.textContent.indexOf('阶段4验收：第一行') >= 0)
         const button = item && item.querySelector('[data-testid="memo-menu"]')
         if (button) button.click()
         return true
       })()`
    )
    await wait(200)
    await evaluate(context, `window.__verify.click('[data-testid="context-menu-memo-to-plan"]')`)
    await wait(600)

    await evaluate(
      context,
      `(() => {
         const items = Array.from(document.querySelectorAll('[data-testid="memo-item"]'))
         const item = items.find(el => el.textContent.indexOf('阶段4验收：第一行') >= 0)
         const button = item && item.querySelector('[data-testid="memo-menu"]')
         if (button) button.click()
         return true
       })()`
    )
    await wait(200)
    await evaluate(context, `window.__verify.click('[data-testid="context-menu-memo-to-review"]')`)
    await wait(600)
    context.appData.flushAll()

    const planAfter = tasks(context).length
    const reviewAfter = context.appData.module('review').list().length
    record({
      id: 'P4-I3',
      prd: 'I3',
      name: '备忘可以排进计划、也可以生成复习卡',
      passed: planAfter === planBefore + 1 && reviewAfter === reviewBefore + 1,
      detail: `计划 ${planBefore}→${planAfter} 条；复习卡 ${reviewBefore}→${reviewAfter} 张`
    })
  } catch (error) {
    record({
      id: 'P4-I3',
      prd: 'I3',
      name: '备忘可以排进计划、也可以生成复习卡',
      passed: false,
      detail: String(error)
    })
  }

  // =========================================================================
  // 首页
  // =========================================================================

  await evaluate(context, `window.__verify.clickNav('home')`)
  await wait(500)

  // ---- D1 默认停在首页，显示今天日期 ----
  try {
    const info = await evaluate<{ date: string; greeting: string }>(
      context,
      `({
         date: (window.__verify.byTestId('home-date') || {}).textContent || '',
         greeting: (window.__verify.byTestId('home-greeting') || {}).textContent || ''
       })`
    )
    const now = new Date()
    const expected = `${now.getFullYear()}年${now.getMonth() + 1}月${now.getDate()}日`
    record({
      id: 'P4-D1',
      prd: 'D1',
      name: '首页显示今天的日期与问候语',
      passed: info.date.includes(expected) && info.greeting.trim().length > 0,
      detail: `日期="${info.date.trim()}"（预期含 ${expected}）；问候="${info.greeting.trim()}"`
    })
  } catch (error) {
    record({
      id: 'P4-D1',
      prd: 'D1',
      name: '首页显示今天的日期与问候语',
      passed: false,
      detail: String(error)
    })
  }

  // ---- D5 首页快速记一笔落到备忘录 ----
  try {
    const before = memos(context).length
    await evaluate(context, `window.__verify.setText('home-quick-input', '阶段4验收：首页快速记一笔')`)
    await wait(80)
    await evaluate(
      context,
      `(() => {
         const el = window.__verify.byTestId('home-quick-input')
         el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
         return true
       })()`
    )
    await wait(700)
    context.appData.flushAll()
    const after = memos(context).length
    const landed = memos(context).some((memo) => memo['text'] === '阶段4验收：首页快速记一笔')
    record({
      id: 'P4-D5',
      prd: 'D5',
      name: '首页快速记一笔直接落到备忘录',
      passed: after === before + 1 && landed,
      detail: `备忘 ${before}→${after} 条，内容命中=${landed}`
    })
  } catch (error) {
    record({
      id: 'P4-D5',
      prd: 'D5',
      name: '首页快速记一笔直接落到备忘录',
      passed: false,
      detail: String(error)
    })
  }

  // ---- D3 首页勾选任务，计划页状态一致 ----
  try {
    const clicked = await evaluate<string>(
      context,
      `(() => {
         const rows = Array.from(document.querySelectorAll('[data-testid="home-task-row"]'))
         if (rows.length === 0) return ''
         const row = rows[0]
         const title = (row.querySelector('.task__title') || {}).textContent || ''
         const button = row.querySelector('[data-testid="home-task-toggle"]')
         if (button) button.click()
         return title
       })()`
    )
    await wait(700)
    context.appData.flushAll()
    const task = clicked === '' ? undefined : findTask(context, clicked)
    record({
      id: 'P4-D3',
      prd: 'D3',
      name: '首页勾选任务后，数据层面状态同步为已完成',
      passed: clicked !== '' && task?.['done'] === true,
      detail:
        clicked === ''
          ? '首页今日计划没有可勾选的条目'
          : `勾选「${clicked}」→ 落盘 done=${String(task?.['done'])}`
    })
  } catch (error) {
    record({
      id: 'P4-D3',
      prd: 'D3',
      name: '首页勾选任务后，数据层面状态同步为已完成',
      passed: false,
      detail: String(error)
    })
  }

  // ---- D2 今日计划最多 3 项 + "还有 N 项" ----
  try {
    // 先看当前条数，不足 5 条就补到 5 条
    const existing = tasks(context).filter(
      (task) => task['date'] === todayKey && task['done'] !== true
    ).length
    const need = Math.max(0, 5 - existing)
    for (let index = 0; index < need; index += 1) {
      await evaluate(
        context,
        `window.api.data.add('plan', { title: ${JSON.stringify(`${EXPAND_PREFIX}${index}`)}, date: ${JSON.stringify(todayKey)}, timeSlot: 'none', recurrence: 'none', done: false, carriedOver: 0, doneAt: null })`
      )
      await wait(120)
    }
    await evaluate(context, `window.api.data.flush()`)
    await wait(200)
    await evaluate(context, `window.__verify.clickNav('memo')`)
    await wait(150)
    await evaluate(context, `window.__verify.clickNav('home')`)
    await wait(600)

    const planView = await evaluate<{ rows: number; hasMore: boolean; moreText: string }>(
      context,
      `({
         rows: window.__verify.count('[data-testid="home-task-row"]'),
         hasMore: !!window.__verify.byTestId('home-expand-plan'),
         moreText: (window.__verify.byTestId('home-expand-plan') || {}).textContent || ''
       })`
    )

    let afterExpand = planView.rows
    if (planView.hasMore) {
      await evaluate(context, `window.__verify.click('[data-testid="home-expand-plan"]')`)
      await wait(400)
      afterExpand = await evaluate<number>(context, `window.__verify.count('[data-testid="home-task-row"]')`)
    }

    record({
      id: 'P4-D2',
      prd: 'D2',
      name: '今日计划默认最多 3 项，可展开看到全部',
      passed: planView.rows === 3 && planView.hasMore && afterExpand > planView.rows,
      detail: `默认显示 ${planView.rows} 项；"还有 N 项"提示=${planView.hasMore}（"${planView.moreText.trim()}"）；展开后 ${afterExpand} 项`
    })
  } catch (error) {
    record({
      id: 'P4-D2',
      prd: 'D2',
      name: '今日计划默认最多 3 项，可展开看到全部',
      passed: false,
      detail: String(error)
    })
  }

  // ---- D4 首页显示最近备忘 ----
  try {
    const state = await evaluate<{ items: number; hasRecent: boolean }>(
      context,
      `({
         items: window.__verify.count('[data-testid="home-memo-item"]'),
         hasRecent: !!window.__verify.byTestId('home-recent-memos')
       })`
    )
    record({
      id: 'P4-D4',
      prd: 'D4',
      name: '首页显示最近备忘列表',
      passed: state.hasRecent && state.items > 0,
      detail: `最近备忘区块存在=${state.hasRecent}，条目数=${state.items}`
    })
  } catch (error) {
    record({
      id: 'P4-D4',
      prd: 'D4',
      name: '首页显示最近备忘列表',
      passed: false,
      detail: String(error)
    })
  }

  // ---- D6 关注卡：计划里没有逾期时不应出现"逾期未完成"卡 ----
  try {
    // 清掉所有逾期任务，制造"没有逾期"的状态
    for (const task of tasks(context)) {
      if (task['done'] === true) continue
      const date = String(task['date'] ?? '')
      if (date !== '' && date !== 'unscheduled' && date < todayKey) {
        context.appData.module('plan').remove(String(task['id']), { hard: true })
      }
    }
    context.appData.flushAll()
    await evaluate(context, `window.__verify.clickNav('memo')`)
    await wait(150)
    await evaluate(context, `window.__verify.clickNav('home')`)
    await wait(600)

    const state = await evaluate<{ hasCard: boolean; attentionBlock: boolean; cards: number }>(
      context,
      `({
         hasCard: !!window.__verify.byTestId('attention-overdue'),
         attentionBlock: !!window.__verify.byTestId('home-attention'),
         cards: window.__verify.count('[data-testid^="attention-"]')
       })`
    )
    record({
      id: 'P4-D6',
      prd: 'D6',
      name: '没有逾期任务时不显示"逾期未完成"关注卡',
      passed: state.hasCard === false,
      detail: `逾期卡存在=${state.hasCard}；关注区块存在=${state.attentionBlock}；关注卡总数=${state.cards}（复习/学习阶段接入后这里可能大于 0）`
    })
  } catch (error) {
    record({
      id: 'P4-D6',
      prd: 'D6',
      name: '没有逾期任务时不显示"逾期未完成"关注卡',
      passed: false,
      detail: String(error)
    })
  }
}
