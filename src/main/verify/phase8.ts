/**
 * 阶段 8 验收检查（第二轮 FEAT-006：通用树界面 + 学习/读书接入）
 *
 * 覆盖 `docs\TASKS\02` §八 的 DoD：
 *   1. 学习与读书都有可用的树（增删改、排序、折叠、完成勾选）
 *   2. 进度按 §5.2 的公式算：占比自动归一化、**最小单元才算数**
 *   3. 汇总节点用**虚线框**、最小单元用**实心方框**
 *   4. 资料行显示 `占比 X% · 已学 Y%（n/m）` 两个数字
 *   5. 层数不限；**第 5 层起缩进收窄到 12px**
 *   6. 跨 owner 移动、移到后代下 —— **都被拒绝**
 *   7. 删节点走 `unlink.ts`（解除关联、关联内容保留）
 *   8. **摘录/想法没有进树**
 *   9. 拖拽排序落盘
 *
 * ## 验收台四条硬规矩（血泪教训，必须遵守）
 *
 * 1. **轮询等待**，不用固定延时
 * 2. **自带前提**，不依赖别处留下的状态（样本现场造）
 * 3. **先复位再操作**（进页面先关抽屉 / 清空输入）
 * 4. **用对触发方式**（受控组件用原生 setter：`window.__verify.setText` / `setSelect`）
 *
 * 另外：本阶段的所有样本都带 `阶段8树（第N趟）` 前缀，
 * 断言一律只在这个前缀里找，免得被前面阶段留下的同名记录干扰。
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  addDaysToKey,
  dateKey,
  dayOfKey,
  monthOfKey,
  monthStartKey,
  weekKeysFor,
  yearOfKey,
  type WeekStart
} from '../../shared/date'
import { SIDEBAR_COLLAPSED_WIDTH, SIDEBAR_WIDTH } from '../../shared/navigation'
import { REVIEW_TOPIC_DELETE_ID, REVIEW_TOPIC_DELETE_LABEL } from '../../shared/contextMenu'
import { normalizePlanTask, isHeld } from '../../shared/plan'
import { countsAsOverdue, isOverdue } from '../../shared/planLogic'
import { toPlainText } from '../../shared/richText'
import { GUIDE, chapterTitle, parseInline, type GuideBlock } from '../../shared/guide'
import {
  HISTORY_KEEP_LIMIT,
  applyGrade,
  dueQueue,
  normalizeReviewCard,
  type ReviewCard
} from '../../shared/review'
import { HOTKEY_ACTIONS, resolveHotkeys, type HotkeyAction } from '../../shared/preferences'
import {
  boldViaToolbar,
  injectRichHelpers,
  readRichHtml,
  setRichHtml,
  type RichDisplaySnapshot
} from './rich'
import type { VerifyCheck, VerifyContext } from './runner'

type Recorder = (check: VerifyCheck) => void

async function evaluate<T>(context: VerifyContext, expression: string): Promise<T> {
  return (await context.window.webContents.executeJavaScript(expression)) as T
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * 轮询直到条件成立；**超时返回 null**。
 *
 * 刻意不返回"最后一次取值"——那样调用方很容易写出
 * `const rows = await until(...); passed = rows.length === 2` 这种
 * "超时了也算拿了个值"的假通过。null 一律按失败处理。
 */
async function until<T>(
  context: VerifyContext,
  expression: string,
  accept: (value: T) => boolean,
  attempts = 12,
  interval = 250
): Promise<T | null> {
  for (let index = 0; index < attempts; index += 1) {
    const value = (await evaluate<T>(context, expression)) as T
    if (accept(value)) return value
    await wait(interval)
  }
  return null
}

/** 只等条件成立、不关心取值的场景（返回是否等到了） */
async function untilTrue(
  context: VerifyContext,
  expression: string,
  attempts = 12,
  interval = 250
): Promise<boolean> {
  return (await until<boolean>(context, expression, (value) => value === true, attempts, interval)) === true
}

/** 读一棵树的行（可限定节点 id 前缀，避免与其它阶段的数据混淆） */
const rowsExpr = (prefix: string, idPrefix = ''): string => `(() => {
  const rows = Array.from(document.querySelectorAll('[data-testid="${prefix}-row"]'))
  return rows
    .filter((row) => ${JSON.stringify(idPrefix)} === '' || (row.getAttribute('data-node-id') || '').startsWith(${JSON.stringify(idPrefix)}))
    .map((row) => {
      const line = row.querySelector('.tree__line')
      const check = row.querySelector('[data-testid="${prefix}-check"]')
      const title = row.querySelector('[data-testid="${prefix}-title"]')
      const progress = row.querySelector('[data-testid="${prefix}-progress"]')
      return {
        id: row.getAttribute('data-node-id') || '',
        depth: Number(row.getAttribute('data-depth') || '0'),
        summary: row.getAttribute('data-summary') === '1',
        done: row.getAttribute('data-done') === '1',
        indent: line ? Number(line.getAttribute('data-indent') || '0') : -1,
        checkDisabled: check ? check.disabled === true : true,
        checkBorder: check
          ? (() => {
              const style = getComputedStyle(check)
              // 「实心方框」在 CSS 里没有显式 border（用的是浏览器默认外观），
              // 所以 computed borderStyle 会是 none —— 那也算实心（可打勾的那种）。
              // 另外用 disabled 兜底：汇总节点的勾是只读的，最小单元的勾可点，
              // 这条判据比 appearance 稳（不同 Chromium 版本对 appearance 的报法不一致）。
              if (check.disabled === true) return 'dashed'
              return style.borderStyle === 'none' ? 'solid' : style.borderStyle
            })()
          : '',
        title: title ? (title.textContent || '').trim() : '',
        progress: progress ? (progress.textContent || '').trim() : ''
      }
    })
})()`

interface TreeRow {
  id: string
  depth: number
  summary: boolean
  done: boolean
  indent: number
  checkDisabled: boolean
  checkBorder: string
  title: string
  progress: string
}

/**
 * 从一堆行里挑出"汇总节点（虚线框）"与"最小单元（实心方框）"两行。
 *
 * 必须看**计算样式**而不是 `data-summary`：`data-summary` 表示"数据上有没有子节点"
 * （折叠着也是 1），而要求的是"界面上真的呈现成虚线框 / 实心方框"。
 *
 * 而且要挑**真正有祖先关系**的一对（汇总节点是某个最小单元的祖先）：
 * 随便两行拿去做"不能移到自己的后代下"的检查是没有意义的
 * ——它们本来就不该被拒（已踩过：拿两个不相干的节点去试，结果"移动成功"被当成 bug）。
 */
function pickBoxes(
  rows: TreeRow[],
  parentOf: Record<string, string | null>
): { summary: TreeRow; leaf: TreeRow } | null {
  const isAncestor = (candidate: string, of: string): boolean => {
    const guard = new Set<string>([of])
    let cursor: string | null | undefined = parentOf[of]
    while (cursor !== null && cursor !== undefined) {
      if (cursor === candidate) return true
      if (guard.has(cursor)) return false
      guard.add(cursor)
      cursor = parentOf[cursor] ?? null
    }
    return false
  }
  for (const leaf of rows.filter((row) => row.checkBorder === 'solid')) {
    const summary = rows.find(
      (row) => row.checkBorder === 'dashed' && isAncestor(row.id, leaf.id)
    )
    if (summary !== undefined) return { summary, leaf }
  }
  return null
}

/**
 * 打开学习页并选中指定主题；等到"这一棵树"真的渲染出来。
 *
 * ⚠️ **整段要能重试**（验收台硬规矩第 1 条：轮询等待，不用固定延时）。
 *
 * 为什么要重试而不是"点一次就等"：点主题 → 预览重渲染 → 出现「进入主题」按钮
 * → 点它 → 树挂载，这中间每一步都依赖一帧渲染。打包产物在忙的机器上单帧偶发
 * 会超过一秒（已踩过：`P8-A1` 在一次打包产物验收里报"没能切换到主题…的树"，
 * 现场是"树根压根不存在"，也就是「进入主题」那一下没落上去）。
 * 早先的写法只给这一步 6×150ms，超了以后就再也补不回来了——
 * 下面的 16×250ms 只能干等一棵永远不会出现的树。
 *
 * 这里改成"最多 3 轮完整流程"：每轮重新点一次主题与「进入主题」，然后重新等。
 * 判据**一个字没放宽**：最后仍然要 `data-tree-owner === 目标 id`，等不到照样失败。
 */
async function openLearningTopic(context: VerifyContext, topicId: string): Promise<void> {
  // 先离开再回来：验收有时会**绕过界面**（直接用 window.api 造样本）写数据，
  // 页面不会自动重读，主题列表里就看不到刚造的那个主题（已踩过）。
  // 切一次模块让学习页重新挂载、重新读盘，等价于用户换页再回来。
  await evaluate(context, `window.__verify.clickNav('home')`)
  await wait(200)
  await evaluate(context, `window.__verify.clickNav('learning')`)
  await wait(400)
  // 先复位：有的检查会把抽屉开着
  await evaluate(context, `window.__verify.key('Escape')`)
  await wait(200)

  for (let round = 0; round < 3; round += 1) {
    // ① 点这一行主题（选中）
    await untilTrue(
      context,
      `(() => {
         const button = document.querySelector('[data-testid="learning-topic"][data-topic-id="${topicId}"]')
         if (!button) return false
         button.click()
         return true
       })()`,
      10,
      200
    )
    /*
     * ② 三步走的第三步（第 09 块 §6.6）：**点主题只是选中，树要点「进入主题」才展开**
     * （决定 1：预览与卡片留在上面、下方展开树，不整页替换）。
     * 已经进入过（`data-entered=1`）就不重复点，免得把它点成「退出主题」。
     */
    await untilTrue(
      context,
      `(() => {
         const button = document.querySelector('[data-testid="learning-enter-topic"]')
         if (!button) return false
         if (button.getAttribute('data-entered') === '1') return true
         button.click()
         return true
       })()`,
      10,
      200
    )
    /*
     * ③ 轮询到树的归属换成这个主题为止。
     * 一定要等到**非空且等于目标 id**：切换过程中会出现"根本没有树"的一瞬，
     * 那时候取到空字符串就当成切好了，后面的检查会全落在上一个主题的树上（已踩过）。
     */
    const switched = await until<string>(
      context,
      `(() => {
         const root = document.querySelector('[data-testid="learning-tree-root"]')
         return root ? root.getAttribute('data-tree-owner') || '' : ''
       })()`,
      (owner) => owner !== '' && owner === topicId,
      16,
      250
    )
    if (switched !== null) return
  }

  // 三轮都没成：诊断信息要够定位问题（列表里到底有哪些主题按钮、当前树的归属是谁）
  const diagnostic = await evaluate<string>(
    context,
    `(async () => {
       const buttons = Array.from(document.querySelectorAll('[data-testid="learning-topic"]'))
       const root = document.querySelector('[data-testid="learning-tree-root"]')
       const enter = document.querySelector('[data-testid="learning-enter-topic"]')
       const locked = document.querySelector('[data-testid="learning-tree-locked"]')
       const alive = await window.api.data.listAlive('learning')
       const all = await window.api.data.list('learning')
       const topics = alive.filter((item) => item['kind'] === 'topic')
       return JSON.stringify({
         target: ${JSON.stringify(topicId)},
         owner: root ? root.getAttribute('data-tree-owner') : null,
         enterButton: enter ? { entered: enter.getAttribute('data-entered') } : null,
         lockedShown: !!locked,
         view: (document.querySelector('[data-testid="workspace"]') || { getAttribute: () => null }).getAttribute('data-view'),
         buttons: buttons.map((b) => b.getAttribute('data-topic-id')),
         aliveCount: alive.length,
         allCount: all.length,
         topics: topics.map((t) => ({ id: t['id'], title: t['title'], status: t['status'], deletedAt: t['deletedAt'] ?? null })),
         targetInAlive: alive.some((t) => t['id'] === ${JSON.stringify(topicId)})
       })
     })()`
  )
  throw new Error(`没能切换到主题 ${topicId.slice(0, 6)} 的树（重试 3 轮）；现场=${diagnostic}`)
}

/**
 * 打开读书页并选中某本书；等到"这一本书"的章节树渲染出来。
 *
 * 第 11 块起读书页也是**三步走**（选中 → 预览 → 点「进入书」→ 下方展开树），
 * 所以这里要补一次「进入书」——不补的话下面所有等树行的检查都会空等到超时。
 * 书架也从"分组标签 + 卡片"改成了**左栏书架**：不再需要点标签，直接点那一行。
 */
async function openBookDetail(context: VerifyContext, bookId: string): Promise<void> {
  // 先离开再回来：验收有时会**绕过界面**（直接用 window.api 造样本）写数据，
  // 页面不会自动重读，左栏书架里就看不到刚造的那本书（已踩过）。
  await evaluate(context, `window.__verify.clickNav('home')`)
  await wait(200)
  await evaluate(context, `window.__verify.clickNav('reading')`)
  await wait(400)
  // 先复位：有的检查会把抽屉 / 菜单开着
  await evaluate(context, `window.__verify.key('Escape')`)
  await wait(150)
  const found = await evaluate<boolean>(
    context,
    `(() => {
       const button = document.querySelector('[data-testid="reading-book"][data-book-id="${bookId}"]')
       if (!button) return false
       button.click()
       return true
     })()`
  )
  if (!found) {
    const dump = await evaluate<string>(
      context,
      `(async () => {
         const buttons = Array.from(document.querySelectorAll('[data-testid="reading-book"]'))
         const alive = await window.api.data.listAlive('reading')
         return JSON.stringify({
           target: ${JSON.stringify(bookId)},
           buttons: buttons.map((b) => b.getAttribute('data-book-id')),
           books: alive.filter((item) => item['kind'] === 'book').map((item) => ({ id: item['id'], title: item['title'], status: item['status'] }))
         })
       })()`
    )
    throw new Error(`读书页的书架里没有这本书 ${bookId.slice(0, 6)}；现场=${dump}`)
  }
  // 三步走的第三步：点「进入书」下方才展开章节树（已经是 1 就不要再点，否则会收起）
  await untilTrue(
    context,
    `(() => {
       const button = document.querySelector('[data-testid="reading-enter-book"]')
       if (!button) return false
       if (button.getAttribute('data-entered') === '1') return true
       button.click()
       return true
     })()`,
    6,
    150
  )
  const switched = await until<string>(
    context,
    `(() => {
       const root = document.querySelector('[data-testid="reading-tree-root"]')
       return root ? root.getAttribute('data-tree-owner') || '' : ''
     })()`,
    (owner) => owner !== '' && owner === bookId,
    16,
    250
  )
  if (switched === null) throw new Error(`没能打开书 ${bookId.slice(0, 6)} 的章节树`)
}

/**
 * 等到界面上同时出现"汇总节点（虚线框）"与"最小单元（实心方框）"两行，把它们返回。
 *
 * 界面是"一次只展开一个"的口琴式，前面的检查很可能会把展开位挪走，
 * 所以每次要用汇总节点时都得先点开一个有子节点的根节点；
 * 又因为展开是异步渲染的，必须**轮询到 data-summary === '1' 真的出现**，
 * 不能点一下就当成已经展开（已踩过：直接读会拿到 0 个汇总节点）。
 */
async function waitForSummaryRows(
  context: VerifyContext,
  prefix: string,
  notes: string[]
): Promise<{ summary: TreeRow; leaf: TreeRow }> {
  const trace: string[] = []
  for (let attempt = 0; attempt < 14; attempt += 1) {
    const rows = await evaluate<TreeRow[]>(context, rowsExpr(prefix))
    const parentOf = await evaluate<Record<string, string | null>>(
      context,
      `(window.__treeParentMap || {})`
    )
    const boxes = pickBoxes(rows, parentOf)
    if (boxes !== null) return boxes

    // 当前展开的是哪个（空 = 全部收起）。这是判断"点到底有没有生效"的直接读数
    const expandedIds = await evaluate<string>(
      context,
      `(() => {
         const root = document.querySelector('[data-testid="${prefix}-root"]')
         return root ? root.getAttribute('data-expanded-ids') || '' : ''
       })()`
    )
    const expandedList = expandedIds === '' ? [] : expandedIds.split(',')
    trace.push(
      `#${attempt} 行=${rows.length} 虚线=${rows.filter((row) => row.checkBorder === 'dashed').length} 实心=${rows.filter((row) => row.checkBorder === 'solid').length} 边框=[${rows.map((row) => `${row.id.slice(0, 4)}:${row.checkBorder}:${row.summary ? 'S' : 'L'}`).join(' ')}] 展开=[${expandedList.map((id) => id.slice(0, 4)).join(',')}]`
    )

    if (expandedList.length === 0) {
      // 全收起：点开最后一个"有子节点"的根节点
      const target = [...rows].reverse().find((row) => row.summary)
      if (target === undefined) {
        const id = await collapsedNodeId(context, prefix)
        if (id === null) {
          const dump = await evaluate<string[]>(
            context,
            `Array.from(document.querySelectorAll('[data-testid="${prefix}-row"]')).map((row) => JSON.stringify({ id: row.getAttribute('data-node-id'), depth: row.getAttribute('data-depth'), summary: row.getAttribute('data-summary') }))`
          )
          throw new Error(`界面上没有任何汇总节点，也没找到可展开的行；现场=${dump.join(' | ')}`)
        }
        await toggleRow(context, prefix, id, true)
      } else {
        await toggleRow(context, prefix, target.id, true)
      }
    } else {
      // 已经展开了一个：继续往**最深的那一行**里面点。
      // 每点一次进一层，点到"最里面那一行没有子节点"时，界面上就会出现实心方框。
      //
      // 两个坑（都已踩过）：
      //   1. 不要点根节点：那样只会在几个根之间来回切，永远见不到最小单元
      //   2. 不能把"当前展开项的那些祖先行"也算成候选：它们自己就是展开路径上的行，
      //      再点一次只会折叠回去，于是就在两条行之间来回弹
      const parentOf = await evaluate<Record<string, string | null>>(
        context,
        `(window.__treeParentMap || {})`
      )
      const ancestors = new Set<string>()
      let cursor: string | null | undefined = parentOf[expandedList[expandedList.length - 1] ?? '']
      while (cursor !== null && cursor !== undefined) {
        ancestors.add(cursor)
        cursor = parentOf[cursor] ?? null
      }
      const deepest = rows
        .filter((row) => row.checkBorder === 'dashed' && !ancestors.has(row.id))
        .sort((a, b) => b.depth - a.depth)[0]
      if (deepest !== undefined) await toggleRow(context, prefix, deepest.id, true)
      else await wait(250)
    }
  }
  const dump = await evaluate<string[]>(
    context,
    `Array.from(document.querySelectorAll('[data-testid="${prefix}-row"]')).map((row) => JSON.stringify({ id: row.getAttribute('data-node-id'), depth: row.getAttribute('data-depth'), summary: row.getAttribute('data-summary'), caret: (row.querySelector('.tree__caret') || {}).outerHTML }))`
  )
  throw new Error(
    `界面里没有同时出现汇总节点与最小单元；行=${dump.join(' | ')}；过程=${trace.join(' / ')}；渲染进程=${
      notes.length === 0 ? '无报错' : notes.slice(-2).join(' | ')
    }`
  )
}

/**
 * 点某一行的三角键展开/折叠它，并轮询到"这一行真的展开了"。
 *
 * ⚠️ 这一步要**一次点完就轮询**，不能"先查 aria、再点、再查 aria"：
 * 界面是**手风琴式**的（一次只展开一个），点开第 N 层会把第 N-1 层收起来，
 * 于是刚点的那一行会连同它的子树一起从界面上消失——
 * 再去找它就会得到 `exists:false`，很容易误判成"点了没反应"（已踩过）。
 *
 * 因此：点了之后如果这一行**已经不在界面上**，也算成功（说明它的祖先被收起了）。
 */
async function toggleRow(
  context: VerifyContext,
  prefix: string,
  nodeId: string,
  expectExpanded: boolean
): Promise<boolean> {
  const clicked = await evaluate<boolean>(
    context,
    `(() => {
       const row = document.querySelector('[data-testid="${prefix}-row"][data-node-id="${nodeId}"]')
       const caret = row && row.querySelector('.tree__caret')
       if (!caret) return false
       caret.click()
       return true
     })()`
  )
  if (!clicked) return false
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const state = await evaluate<string>(
      context,
      `(() => {
         const row = document.querySelector('[data-testid="${prefix}-row"][data-node-id="${nodeId}"]')
         const root = document.querySelector('[data-testid="${prefix}-root"]')
         const expandedNow = root ? root.getAttribute('data-expanded-ids') || '' : ''
         if (!row) return expandedNow.includes(${JSON.stringify(nodeId)}) ? 'gone-open' : 'gone'
         const caret = row.querySelector('.tree__caret')
         return caret && caret.getAttribute('aria-expanded') === 'true' ? 'open' : 'closed'
       })()`
    )
    if (state === 'gone-open') return true
    // 行没了但展开集合里也没有它：说明它的祖先被收起来了（手风琴），也算点到了
    if (state === 'gone') return true
    if (state === (expectExpanded ? 'open' : 'closed')) return true
    await wait(200)
  }
  const dump = await evaluate<string>(
    context,
    `(() => {
       const root = document.querySelector('[data-testid="${prefix}-root"]')
       const row = document.querySelector('[data-testid="${prefix}-row"][data-node-id="${nodeId}"]')
       return JSON.stringify({
         expandedIds: root ? root.getAttribute('data-expanded-ids') : null,
         rowExists: !!row,
         rowHtml: row ? row.outerHTML.slice(0, 220) : null
       })
     })()`
  )
  console.log(`[phase8] toggleRow 未生效：${dump}`)
  return false
}

/** 找到"最后一个折叠着、但点得动的行"（＝有子节点、还没展开的汇总节点） */
async function collapsedNodeId(context: VerifyContext, prefix: string): Promise<string | null> {
  return evaluate<string | null>(
    context,
    `(() => {
       const rows = Array.from(document.querySelectorAll('[data-testid="${prefix}-row"]'))
       const hit = rows.find((row) => {
         const caret = row.querySelector('.tree__caret')
         return caret !== null && caret.tagName === 'BUTTON' && (caret.textContent || '').trim() === '▸'
       })
       return hit ? hit.getAttribute('data-node-id') : null
     })()`
  )
}

/** 点某一行里的某个按钮（先确认按钮在，再派发点击） */
async function clickRowButton(
  context: VerifyContext,
  prefix: string,
  nodeId: string,
  suffix: string
): Promise<boolean> {
  return evaluate<boolean>(
    context,
    `(() => {
       const row = document.querySelector('[data-testid="${prefix}-row"][data-node-id="${nodeId}"]')
       const button = row && row.querySelector('[data-testid="${prefix}-${suffix}"]')
       if (!button) return false
       button.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }))
       return true
     })()`
  )
}

// ===========================================================================
// 第 03 块（右键菜单）用的工具
// ===========================================================================

/** 菜单项的读数：id、文案、禁用、分组、菜单整体位置与窗口边界 */
interface MenuSnapshot {
  open: boolean
  ids: string[]
  labels: string[]
  /** 每项右侧那句提示（禁用原因、"当前"、"不影响今天到期总数"…） */
  hints: string[]
  disabledIds: string[]
  groups: string[]
  source: string
  left: number
  top: number
  right: number
  bottom: number
  viewportWidth: number
  viewportHeight: number
}

/** 读当前那个菜单；没开就 open=false */
const menuExpr = `(() => {
  const box = document.querySelector('[data-testid="context-menu"]')
  if (!box) {
    return {
      open: false, ids: [], labels: [], hints: [], disabledIds: [], groups: [], source: '',
      left: 0, top: 0, right: 0, bottom: 0,
      viewportWidth: window.innerWidth, viewportHeight: window.innerHeight
    }
  }
  const rect = box.getBoundingClientRect()
  const buttons = Array.from(box.querySelectorAll('[role="menuitem"]'))
  return {
    open: true,
    ids: buttons.map((b) => (b.getAttribute('data-testid') || '').replace('context-menu-', '')),
    labels: buttons.map((b) => (b.querySelector('.context-menu__label') || {}).textContent || ''),
    hints: buttons.map((b) => ((b.querySelector('.context-menu__hint') || {}).textContent || '').trim()),
    disabledIds: buttons.filter((b) => b.disabled === true).map((b) => (b.getAttribute('data-testid') || '').replace('context-menu-', '')),
    groups: Array.from(box.querySelectorAll('.context-menu__group')).map((g) => (g.textContent || '').trim()),
    source: box.getAttribute('data-menu-source') || '',
    left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom,
    viewportWidth: window.innerWidth, viewportHeight: window.innerHeight
  }
})()`

/**
 * 只关右键菜单（不动抽屉 / 对话框）。
 *
 * ⚠️ Esc 要派发到**菜单自己**（它打开时是被聚焦的），不能派发到 window：
 * `window.dispatchEvent` 的 target 就是 window，捕获与冒泡两段都只经过 window 一个节点，
 * 于是抽屉（`Editors.tsx` 的 `Drawer`）在 window 上的 Esc 监听**照样会收到**，
 * 结果"只想关菜单"变成了"连书详情抽屉一起关掉"（已踩过：P8-J8）。
 * 从菜单元素派发则会正常冒泡：菜单的捕获监听先处理并 `stopPropagation`，抽屉收不到。
 */
async function closeMenu(context: VerifyContext): Promise<void> {
  if (!(await evaluate<boolean>(context, `!!document.querySelector('[data-testid="context-menu"]')`))) {
    return
  }
  await evaluate(
    context,
    `(() => {
       const box = document.querySelector('[data-testid="context-menu"]')
       if (!box) return false
       box.focus()
       box.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))
       return true
     })()`
  )
  await untilTrue(context, `!document.querySelector('[data-testid="context-menu"]')`, 6, 150)
}

/**
 * 关掉当前所有浮层（右键前先复位，见 §6.3 第 3 条硬规矩）。
 *
 * ⚠️ 用在"页面上没有需要保留的抽屉"的场合。页面上有要留着的抽屉时用 `closeMenu`。
 * Esc 一律派发到**当前浮层自己**身上（见 `closeMenu` 的说明），不要派发到 window——
 * 那样会连带把别的浮层一起关掉。
 */
async function closeFloaters(context: VerifyContext): Promise<void> {
  await closeMenu(context)
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const anyOpen = await evaluate<boolean>(
      context,
      `!!document.querySelector('.drawer-layer') || !!document.querySelector('.dialog-layer')`
    )
    if (!anyOpen) return
    // 抽屉 / 对话框：点它自己的关闭按钮或遮罩
    await evaluate(
      context,
      `(() => {
         const close = document.querySelector('[data-testid="drawer-close"]')
         if (close) { close.click(); return }
         const mask = document.querySelector('.dialog-layer__mask') || document.querySelector('.drawer-layer__mask')
         if (mask) mask.click()
       })()`
    )
    await wait(200)
  }
}

/**
 * 在某个元素上真的派发一次右键（不是直接调 React 的 onContextMenu）。
 *
 * ⚠️ 必须派发到**真正挂了 `onContextMenu` 的那个子元素**上。
 * 树行是 `<li class="tree__row"><div class="tree__line" onContextMenu=…>`，
 * 而 `elementFromPoint` 在行的内边距 / 子元素缝隙上会返回外面的 `<li>`
 * （对外层 `<li>` 派发是**不会**冒泡到内层 `<div>` 的）。
 * 已踩过：`hit=LI.tree__row` → 菜单压根不打开，而日志看起来"右键成功了"。
 */
async function rightClickSelector(
  context: VerifyContext,
  selector: string,
  at?: { x: number; y: number }
): Promise<boolean> {
  const result = await evaluate<{ ok: boolean; why: string }>(
    context,
    `(() => {
       const el = document.querySelector(${JSON.stringify(selector)})
       if (!el) return { ok: false, why: '找不到元素' }
       const line = el.querySelector('.tree__line')
       const target = line || el
       const rect = target.getBoundingClientRect()
       if (rect.width === 0 || rect.height === 0) {
         return { ok: false, why: '元素尺寸为 0（不可见）：' + JSON.stringify({ w: rect.width, h: rect.height }) }
       }
       ${at === undefined ? 'const x = Math.round(rect.left + Math.min(30, rect.width / 2)); const y = Math.round(rect.top + rect.height / 2);' : `const x = ${at.x}; const y = ${at.y};`}
       target.dispatchEvent(new MouseEvent('contextmenu', {
         bubbles: true, cancelable: true, view: window, clientX: x, clientY: y, button: 2
       }))
       return { ok: true, why: '派发到=' + target.tagName + '.' + (target.className || '') + ' point=' + x + ',' + y }
     })()`
  )
  if (!result.ok) console.log(`[phase8] rightClickSelector 失败：${selector} → ${result.why}`)
  else if (process.env['WORKLIFE_VERIFY_TRACE'] === '1') {
    console.log(`[phase8] rightClickSelector：${selector} → ${result.why}`)
  }
  return result.ok
}

/** 等菜单打开并取回读数（超时返回 null，调用方按失败处理） */
async function waitForMenu(context: VerifyContext, attempts = 10): Promise<MenuSnapshot | null> {
  const found = await until<MenuSnapshot>(
    context,
    menuExpr,
    (value) => value.open === true && value.ids.length > 0,
    attempts,
    200
  )
  if (found === null) {
    // 失败时把现场带出来：菜单到底有没有渲染、里面有没有菜单项、有没有别的浮层挡着
    const dump = await evaluate<string>(
      context,
      `(() => {
         const boxes = document.querySelectorAll('[data-testid="context-menu"]')
         const active = document.activeElement
         return JSON.stringify({
           menuCount: boxes.length,
           menuHtml: boxes.length > 0 ? boxes[0].outerHTML.slice(0, 300) : null,
           menuitemCount: document.querySelectorAll('[role="menuitem"]').length,
           activeTag: active ? active.tagName + '.' + (active.className || '') : null,
           drawers: document.querySelectorAll('.drawer-layer').length,
           dialogs: document.querySelectorAll('.dialog-layer').length,
           rowCount: document.querySelectorAll('[data-testid="task-row"],[data-testid="week-card"],[data-testid="memo-item"],[data-testid="review-card-row"],[data-testid^="learning-tree-row"],[data-testid="reading-tree-row"]').length
         })
       })()`
    )
    console.log(`[phase8] waitForMenu 没拿到菜单：${dump}`)
  }
  return found
}

/** 点菜单里的某一项（按 id），并轮询到菜单关掉 */
async function clickMenuItem(context: VerifyContext, id: string): Promise<boolean> {
  const clicked = await evaluate<boolean>(
    context,
    `(() => {
       const button = document.querySelector('[data-testid="context-menu-${id}"]')
       if (!button) return false
       button.click()
       return true
     })()`
  )
  if (!clicked) return false
  return untilTrue(context, `!document.querySelector('[data-testid="context-menu"]')`, 8, 200)
}

/** 在某一行的 `⋯` 上点一下（菜单按钮） */
async function clickMenuButton(context: VerifyContext, testId: string, rowSelector?: string): Promise<boolean> {
  return evaluate<boolean>(
    context,
    `(() => {
       const scope = ${rowSelector === undefined ? 'document' : `document.querySelector(${JSON.stringify(rowSelector)})`}
       if (!scope) return false
       const button = scope.querySelector('[data-testid="${testId}"]')
       if (!button) return false
       button.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }))
       return true
     })()`
  )
}

/** 菜单是否整个落在窗口内（"不能跑到窗口外点不到"） */
function menuInsideViewport(menu: MenuSnapshot): boolean {
  return (
    menu.left >= 0 &&
    menu.top >= 0 &&
    menu.right <= menu.viewportWidth &&
    menu.bottom <= menu.viewportHeight
  )
}

/** 两个读数是否"同一批菜单项"（id 顺序与文案都要一致） */
function sameItems(a: MenuSnapshot, b: MenuSnapshot): boolean {
  return a.ids.join('|') === b.ids.join('|') && a.labels.join('|') === b.labels.join('|')
}

/**
 * 树里那四个显式移动动作的菜单项 id（修改 2 轮 · 2026-10）。
 *
 * 放在模块作用域而不是某个检查内部：`P8-W4`（中区 ≠ 树里的差异）与
 * `P8-X1…X5`（四个动作本身）都要用同一份清单——两处各写一遍迟早漂移成
 * "验收以为少了一项，其实只是清单没同步"。
 */
const MOVE2_IDS = ['node-move-up', 'node-move-down', 'node-promote', 'node-demote']

// ===========================================================================
// 修改 4 轮的验收读数（学习主题状态矩阵 / 计划页页头统计 / 年视图完成率）
//
// 这三份读数是 `P8-Z1` ~ `P8-Z6` 共用的：`Z1`/`Z2` 看学习页"哪几个按钮在"，
// `Z4` 看页头那三个数，`Z6` 看年视图某个月的项数与完成率。
// 放模块作用域的理由与 `MOVE2_IDS` 一样：同一份读数只写一遍，
// 免得两条检查各写一份、其中一份悄悄写错却还是"通过"。
// ===========================================================================

/** 学习页预览区的四个状态按钮 + 状态徽标（修改 4 轮 §6.1 的按钮矩阵） */
interface LearningStatusButtons {
  markDone: boolean
  markUndone: boolean
  archive: boolean
  unarchive: boolean
  /** 预览区那个状态徽标（`learning-detail-status`）的文字：进行中 / 已完成 / 已归档 */
  status: string
  title: string
}

/** 读学习页预览区"当前状态下出现了哪几个按钮"（按 testid 判在不在） */
const learningStatusButtonsExpr = `(() => {
  const has = (id) => !!document.querySelector('[data-testid="' + id + '"]')
  const badge = window.__verify.byTestId('learning-detail-status')
  const title = window.__verify.byTestId('learning-detail-title')
  return {
    markDone: has('learning-mark-done'),
    markUndone: has('learning-mark-undone'),
    archive: has('learning-archive'),
    unarchive: has('learning-unarchive'),
    status: badge ? (badge.textContent || '').trim() : '',
    title: title ? (title.textContent || '').trim() : ''
  }
})()`

/** 把按钮读数翻成一行人话（失败时看 detail 就知道当时到底是哪一组） */
function describeLearningButtons(value: LearningStatusButtons | null): string {
  if (value === null) return '（等不到应有的按钮组合）'
  const labels = [
    value.markDone ? '标记完成' : '',
    value.markUndone ? '标记未完成' : '',
    value.archive ? '归档' : '',
    value.unarchive ? '取消归档' : ''
  ].filter((item) => item !== '')
  return `徽标="${value.status}" 按钮=[${labels.join(' / ')}]`
}

/** 计划页页头那三个数（`plan-state` 上的隐藏读数）+ 可见的页头说明文字 */
interface PlanHeaderCounts {
  view: string
  overdue: number
  today: number
  week: number
  abandoned: number
  text: string
}

const planHeaderCountsExpr = `(() => {
  const state = window.__verify.byTestId('plan-state')
  const head = window.__verify.byTestId('page-description')
  return {
    view: state ? (state.getAttribute('data-view') || '') : '',
    overdue: state ? Number(state.getAttribute('data-count-overdue')) : -1,
    today: state ? Number(state.getAttribute('data-count-today')) : -1,
    week: state ? Number(state.getAttribute('data-count-week')) : -1,
    abandoned: state ? Number(state.getAttribute('data-count-abandoned')) : -1,
    text: head ? (head.textContent || '').trim() : ''
  }
})()`

/** 计划页某条任务行的三态读数（`data-state`） */
const taskRowStateExpr = (taskId: string): string =>
  `(() => {
     const row = document.querySelector('[data-testid="task-row"][data-task-id="${taskId}"]')
     return row ? (row.getAttribute('data-state') || '') : ''
   })()`

/** 行上那个「已放弃」标签的文字（没有就空串） */
const taskAbandonedLabelExpr = (taskId: string): string =>
  `(() => {
     const row = document.querySelector('[data-testid="task-row"][data-task-id="${taskId}"]')
     const tag = row ? row.querySelector('[data-testid="task-abandoned-label"]') : null
     return tag ? (tag.textContent || '').trim() : ''
   })()`

/** 年视图某个月格子的读数（项数 / 完成率，属性与可见文字各取一份） */
interface YearMonthCellView {
  month: number
  count: number
  rate: number
  countText: string
  rateText: string
}

const yearMonthCellExpr = (month: number): string => `(() => {
  const cell = document.querySelector('[data-testid="year-month"][data-month="${month}"]')
  if (!cell) return null
  const count = cell.querySelector('[data-testid="year-month-count"]')
  const rate = cell.querySelector('[data-testid="year-month-rate"]')
  return {
    month: ${month},
    count: Number(cell.getAttribute('data-count')),
    rate: Number(cell.getAttribute('data-rate')),
    countText: count ? (count.textContent || '').trim() : '',
    rateText: rate ? (rate.textContent || '').trim() : ''
  }
})()`

/** 年视图 12 个格子的读数（挑一个"原本空着"的月份来造样本，判据才不含旧数据） */
const yearCellsExpr = `Array.from(document.querySelectorAll('[data-testid="year-month"]')).map((cell) => {
  const count = cell.querySelector('[data-testid="year-month-count"]')
  const rate = cell.querySelector('[data-testid="year-month-rate"]')
  return {
    month: Number(cell.getAttribute('data-month')),
    count: Number(cell.getAttribute('data-count')),
    rate: Number(cell.getAttribute('data-rate')),
    countText: count ? (count.textContent || '').trim() : '',
    rateText: rate ? (rate.textContent || '').trim() : ''
  }
})`

/**
 * 沿祖先链把一棵树逐级展开，直到目标行出现在界面上。
 *
 * 为什么非要这样：树的展开是**手风琴式**的（一次只展开一条链），
 * 直接查深层节点会得到"找不到元素"——不是数据没有，是那一行压根没渲染。
 * 祖先关系读页面写下的 `window.__treeParentMap`（学习页与读书页都写了一份）。
 */
async function expandAncestorsOf(
  context: VerifyContext,
  prefix: string,
  nodeId: string,
  attempts = 8
): Promise<boolean> {
  const rowExpr = `!!document.querySelector('[data-testid="${prefix}-row"][data-node-id="${nodeId}"]')`
  if (await evaluate<boolean>(context, rowExpr)) return true
  for (let round = 0; round < attempts; round += 1) {
    const chain = await evaluate<string[]>(
      context,
      `(() => {
         const map = window.__treeParentMap || {}
         const chain = []
         let cursor = map[${JSON.stringify(nodeId)}]
         const guard = new Set()
         while (cursor !== null && cursor !== undefined && !guard.has(cursor) && chain.length < 12) {
           guard.add(cursor)
           chain.push(cursor)
           cursor = map[cursor] ?? null
         }
         return chain.reverse()
       })()`
    )
    // 从最外层往里点；每次只点"当前还没展开的那一层"，点完轮询
    for (const ancestorId of chain) {
      const expanded = await evaluate<boolean>(
        context,
        `(() => {
           const row = document.querySelector('[data-testid="${prefix}-row"][data-node-id="${ancestorId}"]')
           const caret = row && row.querySelector('.tree__caret')
           return !!caret && caret.getAttribute('aria-expanded') === 'true'
         })()`
      )
      if (expanded) continue
      const clicked = await toggleRow(context, prefix, ancestorId, true)
      if (!clicked) break
      await wait(250)
    }
    if (await evaluate<boolean>(context, rowExpr)) return true
    await wait(300)
  }
  return await evaluate<boolean>(context, rowExpr)
}

/**
 * 反复重挂某个页面，直到**它真的把刚才写的记录读出来**。
 *
 * 为什么需要：验收经常绕过界面直接 `window.api.data.add(...)` 造样本。
 * 但页面是**挂载时读一次盘**的，如果那一次读发生在写入落盘之前，
 * 页面就一直是旧快照——表现是"数据里明明有两条、界面上只有一条"（已踩过）。
 * 固定 `wait(400)` 只是碰运气；这里改成"重挂 + 轮询"，直到看见为止。
 *
 * `tap` 是"切走再切回来"的那个中间页；`view` 是目标页。
 */
async function remountUntil(
  context: VerifyContext,
  view: string,
  tap: string,
  ready: string,
  attempts = 6
): Promise<boolean> {
  if (await untilTrue(context, ready, 4, 200)) return true
  for (let round = 0; round < attempts; round += 1) {
    await evaluate(context, `window.__verify.clickNav(${JSON.stringify(tap)})`)
    await wait(250)
    await evaluate(context, `window.__verify.clickNav(${JSON.stringify(view)})`)
    await wait(450)
    await closeFloaters(context)
    if (await untilTrue(context, ready, 5, 250)) return true
  }
  return await evaluate<boolean>(context, ready)
}

/** 计划页上某条任务的行走查 */
const planRowExpr = (taskId: string): string =>
  `!!document.querySelector('[data-testid="task-row"][data-task-id="${taskId}"]')`

// ===========================================================================
// 三模块页的滚轮规矩读数（2026-10 修订 · 学习 / 复习 / 读书三页共用）
// ===========================================================================

/**
 * 改口径的来由（`MASTER.md` §7.2 / §14 决定 7 / §14 决定 18，2026-10）。
 *
 * 用户原话：「我希望我滚动整个页面的时候，能**跟随整个页面往下翻**，
 * 而不是在一小块里，在一小块里看的不方便。」
 *
 * 落地方式：滚动容器从"下区 `.bands__main`"上移到**右侧内容区 `.workspace`**，
 * 下区与树都按内容高（`styles/layout.css` 的 `page--scroll` 一节）。
 *
 * 三页用的是**同一段脚本、同一个判据函数**，所以"学习页改对了、读书页没改"
 * 这种半拉子改动会在验收里当场露出来。
 */
const moduleScrollExpr = `(() => {
  const el = (selector) => document.querySelector(selector)
  const box = (node) => (node ? node.getBoundingClientRect() : null)
  const style = (node) => (node ? getComputedStyle(node) : null)
  const round = (value) => (typeof value === 'number' ? Math.round(value) : -1)
  const doc = document.scrollingElement
  const sidebar = el('[data-testid="sidebar"]')
  const bottom = el('[data-testid="sidebar-bottom"]')
  const workspace = el('[data-testid="workspace"]')
  const main = el('[data-testid="bands-main"]')
  const cards = Array.from(document.querySelectorAll('.band-card'))
  const bodies = cards.map((card) => card.querySelector('.band-card__body'))
  const bottomRect = box(bottom)
  const root = style(document.documentElement)
  return {
    view: workspace ? workspace.getAttribute('data-view') : '',
    pageScrollHeight: doc ? doc.scrollHeight : -1,
    pageClientHeight: doc ? doc.clientHeight : -1,
    pageMaxScrollTop: doc ? Math.max(0, doc.scrollHeight - doc.clientHeight) : -1,
    htmlOverflow: root ? root.overflow : '',
    bodyScrollHeight: document.body.scrollHeight,
    bodyClientHeight: document.body.clientHeight,
    workspaceScrollHeight: workspace ? workspace.scrollHeight : -1,
    workspaceClientHeight: workspace ? workspace.clientHeight : -1,
    workspaceOverflow: workspace ? style(workspace).overflowY : '',
    workspaceGutter: workspace ? style(workspace).scrollbarGutter : '',
    workspaceBarWidth: workspace ? workspace.offsetWidth - workspace.clientWidth : -1,
    workspaceScrollTop: workspace ? Math.round(workspace.scrollTop) : -1,
    sidebarScrollHeight: sidebar ? sidebar.scrollHeight : -1,
    sidebarClientHeight: sidebar ? sidebar.clientHeight : -1,
    sidebarOverflow: sidebar ? style(sidebar).overflowY : '',
    bottomTop: round(bottomRect ? bottomRect.top : -1),
    bottomBottom: round(bottomRect ? bottomRect.bottom : -1),
    viewportHeight: window.innerHeight,
    mainHeight: round(box(main) ? box(main).height : 0),
    mainScrollHeight: main ? main.scrollHeight : 0,
    mainClientHeight: main ? main.clientHeight : 0,
    mainOverflow: main ? style(main).overflowY : '',
    cardCount: cards.length,
    cardHeights: cards.map((card) => round(box(card) ? box(card).height : 0)),
    cardOverflow: bodies.map((body) => (body ? style(body).overflowY : ''))
  }
})()`

interface ModuleScrollSnapshot {
  view: string
  pageScrollHeight: number
  pageClientHeight: number
  pageMaxScrollTop: number
  htmlOverflow: string
  bodyScrollHeight: number
  bodyClientHeight: number
  workspaceScrollHeight: number
  workspaceClientHeight: number
  workspaceOverflow: string
  workspaceGutter: string
  workspaceBarWidth: number
  workspaceScrollTop: number
  sidebarScrollHeight: number
  sidebarClientHeight: number
  sidebarOverflow: string
  bottomTop: number
  bottomBottom: number
  viewportHeight: number
  mainHeight: number
  mainScrollHeight: number
  mainClientHeight: number
  mainOverflow: string
  cardCount: number
  cardHeights: number[]
  cardOverflow: string[]
}

/**
 * 三模块页滚轮规矩的判据（**新口径，别再往回改**）。
 *
 *   ✅ 页面级（`html` / `body`）仍然**零溢出** —— 滚动条不许跑到整页上去
 *   ✅ 滚动发生在**右侧内容区**：`.workspace` 的 `overflow-y: auto`
 *      + `scrollbar-gutter: stable`（决定 8：滚动条必须始终可见）
 *   ✅ 左栏**不被滚走**（`scrollHeight <= clientHeight`）+ 底部「数据与设置」在屏幕内
 *   ✅ 中区两块仍是 `[132,132]px` + 各自 `overflow: auto`（没被这次改动带跑）
 *   ✅ 下区**不再内部滚**（`.bands-main` 的 `overflow` 是 visible，且内容高 == 可视高）
 *
 * 右侧内容区的"内容高 > 可视高"在内容长时**允许且期望**出现（这正是本轮要的效果），
 * 所以它只写进 detail 当读数，不进判据——判据不能依赖"这一页正好有多长"。
 */
function judgeModuleScroll(snapshot: ModuleScrollSnapshot): {
  passed: boolean
  detail: string
} {
  const pageOk = snapshot.pageScrollHeight <= snapshot.pageClientHeight + 1
  const bodyOk = snapshot.bodyScrollHeight <= snapshot.bodyClientHeight + 1
  const contentIsScroller =
    snapshot.workspaceOverflow === 'auto' || snapshot.workspaceOverflow === 'scroll'
  const gutterStable = snapshot.workspaceGutter === 'stable'
  // 滑块真的占位（10px 滑块 + ±1 容差，容器宽度常是小数）
  const barVisible = snapshot.workspaceBarWidth >= 9 && snapshot.workspaceBarWidth <= 11
  const leftFixed =
    snapshot.sidebarScrollHeight <= snapshot.sidebarClientHeight + 1 &&
    (snapshot.sidebarOverflow === 'hidden' || snapshot.sidebarOverflow === 'clip')
  const bottomVisible =
    snapshot.bottomBottom <= snapshot.viewportHeight + 1 &&
    snapshot.bottomTop >= 0 &&
    snapshot.bottomBottom > snapshot.bottomTop
  const cardsOk =
    snapshot.cardCount === 2 &&
    snapshot.cardHeights.length === 2 &&
    snapshot.cardHeights.every((height) => height >= 120 && height <= 150) &&
    snapshot.cardHeights[0] === snapshot.cardHeights[1] &&
    snapshot.cardOverflow.every((value) => value === 'auto' || value === 'scroll')
  const mainNotInternal =
    snapshot.mainOverflow === 'visible' &&
    snapshot.mainScrollHeight <= snapshot.mainClientHeight + 1
  const contentOverflows = snapshot.workspaceScrollHeight > snapshot.workspaceClientHeight

  return {
    passed: pageOk && bodyOk && contentIsScroller && gutterStable && barVisible && leftFixed && bottomVisible && cardsOk && mainNotInternal,
    detail: `视图=${snapshot.view}；页面滚动元素（html）内容高=${snapshot.pageScrollHeight} 可视高=${snapshot.pageClientHeight} 零溢出=${pageOk}（还差 ${snapshot.pageMaxScrollTop}px 才能滚，期望 0；html overflow=${snapshot.htmlOverflow}）；body ${snapshot.bodyScrollHeight}/${snapshot.bodyClientHeight} 零溢出=${bodyOk}；右侧内容区（滚动容器）内容高=${snapshot.workspaceScrollHeight} 可视高=${snapshot.workspaceClientHeight} overflow=${snapshot.workspaceOverflow} 是滚动容器=${contentIsScroller} gutter=${snapshot.workspaceGutter} 槽位=${snapshot.workspaceBarWidth}px（可见=${barVisible}）内容比可视高=${contentOverflows}（长内容允许溢出，这是本轮要的效果）；左栏 内容高=${snapshot.sidebarScrollHeight} 可视高=${snapshot.sidebarClientHeight} overflow=${snapshot.sidebarOverflow} 不被滚走=${leftFixed}，底部「数据与设置」top=${snapshot.bottomTop} bottom=${snapshot.bottomBottom} 视口=${snapshot.viewportHeight} 在屏幕内=${bottomVisible}；中区两块 高度=[${snapshot.cardHeights.join(',')}] overflow=[${snapshot.cardOverflow.join(',')}]（≈132 且各自内部滚=${cardsOk}）；下区 高=${snapshot.mainHeight} 内容/可视=${snapshot.mainScrollHeight}/${snapshot.mainClientHeight} overflow=${snapshot.mainOverflow} 不再内部滚=${mainNotInternal}`
  }
}

/** 读一次三模块页的现场，超时返回 null（调用方按失败处理） */
async function readModuleScroll(
  context: VerifyContext,
  attempts = 12,
  interval = 250
): Promise<ModuleScrollSnapshot | null> {
  return until<ModuleScrollSnapshot>(
    context,
    moduleScrollExpr,
    (value) => value !== null && value.cardCount === 2 && value.workspaceClientHeight > 0,
    attempts,
    interval
  )
}

// ===========================================================================
// 第 05 块（日历三档）用的工具
// ===========================================================================

/** 打开计划页并切到日历的某一档，**轮询到日历真的以这个档位渲染出来**。
 *
 * 先关掉所有浮层再点视图按钮（验收台硬规矩第 3 条：先复位再操作）：
 * 上一项检查可能把抽屉开着，抽屉的遮罩会吃掉点击，症状是"点了没反应"而看不出原因。
 */
async function openPlanCalendar(
  context: VerifyContext,
  mode: 'week' | 'month' | 'year'
): Promise<boolean> {
  await closeFloaters(context)
  await evaluate(context, `window.__verify.clickNav('plan')`)
  await wait(300)
  const clicked = await evaluate<boolean>(
    context,
    `window.__verify.click('[data-testid="plan-view-${mode}"]')`
  )
  if (!clicked) return false
  return untilTrue(
    context,
    `(() => {
       const calendar = document.querySelector('[data-testid="calendar"]')
       return !!calendar && calendar.getAttribute('data-mode') === '${mode}'
     })()`,
    12,
    200
  )
}

/** 切回列表视图（今天 / 全部）并等到日历消失了 */
async function openPlanList(context: VerifyContext, view: 'today' | 'all'): Promise<boolean> {
  const clicked = await evaluate<boolean>(
    context,
    `window.__verify.click('[data-testid="plan-view-${view}"]')`
  )
  if (!clicked) return false
  return untilTrue(context, `!document.querySelector('[data-testid="calendar"]')`, 10, 200)
}

/**
 * 直接写一条计划样本（自带前提：不依赖别处留下的状态）。
 * 写完强制落盘并广播 `worklife:data-changed`，让已经挂载的计划页重新读盘。
 */
async function addPlanSample(
  context: VerifyContext,
  sample: Record<string, unknown>
): Promise<string> {
  const created = await evaluate<{ id: string }>(
    context,
    `window.api.data.add('plan', ${JSON.stringify(sample)})`
  )
  await evaluate(context, `window.api.data.flush()`)
  await evaluate(
    context,
    `window.dispatchEvent(new CustomEvent('worklife:data-changed', { detail: { module: 'plan' } })), true`
  )
  await wait(400)
  return created.id
}

/**
 * 直接写 `app` 偏好里"逾期提醒被关掉的那一天"（修改 6 轮 · `overdueHintDismissedOn`）。
 *
 * 用途有两个，都是**自带前提**的复位：
 *   1. 写成**昨天** = "今天没关过" → 提示应当出现
 *   2. 造出"昨天关过"的状态 → 用来验"第二天自动回来"
 *
 * 不经过界面：验收台硬规矩第 3 条要求"先复位再操作"，
 * 而"关掉"这一步本身要靠点 `×` 来验，复位就得走数据层。
 */
async function setOverdueHintDismissedOn(context: VerifyContext, dayKey: string): Promise<void> {
  await evaluate(
    context,
    `(async () => {
       const records = await window.api.data.list('app')
       const hit = records.find((item) => String(item['id'] || '') === 'preferences')
       if (hit) await window.api.data.update('app', 'preferences', { overdueHintDismissedOn: ${JSON.stringify(dayKey)} })
       else await window.api.data.add('app', { id: 'preferences', overdueHintDismissedOn: ${JSON.stringify(dayKey)} })
       await window.api.data.flush()
       return true
     })()`
  )
  await evaluate(
    context,
    `window.dispatchEvent(new CustomEvent('worklife:data-changed', { detail: { module: 'app' } })), true`
  )
  await wait(250)
}

/** 读偏好里"逾期提醒被关掉的那一天"（没记录 / 没这个字段都返回空串） */
async function readOverdueHintDismissedOn(context: VerifyContext): Promise<string> {
  return evaluate<string>(
    context,
    `(async () => {
       const records = await window.api.data.list('app')
       const hit = records.find((item) => String(item['id'] || '') === 'preferences')
       return hit ? String(hit['overdueHintDismissedOn'] || '') : ''
     })()`
  )
}

/**
 * 用**原生 setter** 写受控输入框的值，并同时派发 input / change。
 *
 * `date` / `time` 这类输入框上只派发 input 有时推不动 React 的 onChange
 * （验收台硬规矩第 4 条），补一个 change 更稳。
 */
async function setNativeValue(
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

/** 读现在落库的全部计划任务（已排除回收站） */
async function planRecords(context: VerifyContext): Promise<Array<Record<string, unknown>>> {
  return evaluate<Array<Record<string, unknown>>>(context, `window.api.data.listAlive('plan')`)
}

/**
 * 按数据算出"某个月应当显示的任务数与完成率"。
 *
 * 断言必须**对着数据算一遍**再比界面：验收会在同一个数据目录上跑 3 趟，
 * 前面几趟留下的任务会一直在，写死"这个月 3 项"注定第二趟就红。
 */
function expectedMonthStats(
  records: Array<Record<string, unknown>>,
  year: number,
  month: number
): { total: number; rate: number } {
  let total = 0
  let done = 0
  for (const record of records) {
    if (record['deletedAt'] !== undefined && record['deletedAt'] !== null) continue
    const date = String(record['date'] ?? '')
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) continue
    if (yearOfKey(date) !== year || monthOfKey(date) !== month) continue
    total += 1
    if (record['done'] === true) done += 1
  }
  return { total, rate: total === 0 ? 0 : Math.round((done / total) * 100) }
}

/** 按数据算出"某一天有多少条任务" */
function expectedDayCount(records: Array<Record<string, unknown>>, dayKey: string): number {
  return records.filter((record) => {
    if (record['deletedAt'] !== undefined && record['deletedAt'] !== null) return false
    return String(record['date'] ?? '') === dayKey
  }).length
}

/**
 * 读出当前生效的"每周从周几开始"。
 *
 * 必须读真实偏好：验收第 2 趟会把设置改成"周日开头"（`pref-week-start=7`），
 * 之后一直沿用到第 3 趟。写死"周一开头"会让第 3 趟无故变红。
 */
async function effectiveWeekStart(context: VerifyContext): Promise<WeekStart> {
  const value = await evaluate<number>(
    context,
    `(async () => {
       const records = await window.api.data.listAlive('app')
       const found = records.find((item) => item['id'] === 'preferences')
       return found && found['weekStart'] === 7 ? 7 : 1
     })()`
  )
  return value === 7 ? 7 : 1
}

// ===========================================================================
// 第 06 块（复习增强 / 备忘标签 / 快捷键）用的工具
// ===========================================================================

/** 组合键 → dispatch 用的 KeyboardEvent 形状（与 `comboFromEvent` 同一套写法） */
function keyShapeOfCombo(combo: string): {
  key: string
  ctrlKey: boolean
  altKey: boolean
  shiftKey: boolean
  metaKey: boolean
} {
  const parts = combo.split('+')
  const last = parts[parts.length - 1] ?? ''
  const key =
    last === 'space' ? ' ' : last === 'escape' ? 'Escape' : last === 'enter' ? 'Enter' : last === 'tab' ? 'Tab' : last
  return {
    key,
    ctrlKey: parts.includes('ctrl'),
    altKey: parts.includes('alt'),
    shiftKey: parts.includes('shift'),
    metaKey: parts.includes('meta')
  }
}

/**
 * 派发一次 keydown。
 *
 * `onBody: true` → 目标固定为 `document.body`（确定不是输入框，单键热键会生效）；
 * `onBody: false` → 目标是**当前焦点元素**（用来验"焦点在输入框里时不触发"，
 * 以及设置页抓键时的**捕获阶段拦截**）。
 *
 * 为什么不能直接派发到 `window`：事件直接以 window 为目标时处于"target 阶段"，
 * 监听器按**注册顺序**触发而与捕获/冒泡无关——设置页那个捕获阶段的拦截器
 * 比 App 的全局监听注册得晚，就拦不住。从 body 派发才有真正的捕获→冒泡路径。
 */
async function pressKeyOn(
  context: VerifyContext,
  key: string,
  options: Record<string, unknown> = {},
  onBody = true
): Promise<void> {
  const target = onBody ? 'document.body' : 'document.activeElement || document.body'
  await evaluate(
    context,
    `(() => {
       const target = ${target}
       target.dispatchEvent(new KeyboardEvent('keydown', Object.assign(
         { key: ${JSON.stringify(key)}, bubbles: true, cancelable: true },
         ${JSON.stringify(options)}
       )))
       return true
     })()`
  )
}

/** 按组合键写法派发（会按当前真实绑定值调用，绑定被改过也不怕） */
async function pressCombo(context: VerifyContext, combo: string, onBody = true): Promise<void> {
  const shape = keyShapeOfCombo(combo)
  await pressKeyOn(
    context,
    shape.key,
    { ctrlKey: shape.ctrlKey, altKey: shape.altKey, shiftKey: shape.shiftKey, metaKey: shape.metaKey },
    onBody
  )
}

/** 读出当前生效的完整快捷键绑定（设置页可能改过，验收一律按真实值按键） */
async function effectiveHotkeys(
  context: VerifyContext
): Promise<Record<HotkeyAction, string>> {
  const raw = await evaluate<Record<string, unknown> | null>(
    context,
    `(async () => {
       const records = await window.api.data.listAlive('app')
       const found = records.find((item) => item['id'] === 'preferences')
       return found ? { hotkeys: found['hotkeys'] } : null
     })()`
  )
  const overrides = (raw?.['hotkeys'] ?? undefined) as Partial<Record<HotkeyAction, string>> | undefined
  return resolveHotkeys(overrides)
}

/** 读计划页的状态读数（当前视图 / 选中的是哪一天 / 今天是哪天） */
async function planState(
  context: VerifyContext
): Promise<{ view: string; activeDay: string; today: string } | null> {
  return evaluate<{ view: string; activeDay: string; today: string } | null>(
    context,
    `(() => {
       const el = window.__verify.byTestId('plan-state')
       if (!el) return null
       return {
         view: el.getAttribute('data-view') || '',
         activeDay: el.getAttribute('data-active-day') || '',
         today: el.getAttribute('data-today') || ''
       }
     })()`
  )
}

/** 复习模块里的**卡片**（不含历史；口径与 phase5 的 reviewRecords 一致） */
async function reviewCards(context: VerifyContext): Promise<Array<Record<string, unknown>>> {
  const records = await evaluate<Array<Record<string, unknown>>>(
    context,
    `window.api.data.listAlive('review')`
  )
  return records.filter((record) => record['kind'] !== 'history')
}

/** 读出当前生效的复习间隔强度（设置页会改，验收一律按真实值算期望） */
async function effectiveIntensity(
  context: VerifyContext
): Promise<'standard' | 'relaxed' | 'intense'> {
  const value = await evaluate<string>(
    context,
    `(async () => {
       const records = await window.api.data.listAlive('app')
       const found = records.find((item) => item['id'] === 'preferences')
       const raw = found ? found['reviewIntensity'] : 'standard'
       return raw === 'relaxed' || raw === 'intense' ? raw : 'standard'
     })()`
  )
  return value === 'relaxed' || value === 'intense' ? value : 'standard'
}

/** 复习模块里的**历史**记录 */
async function reviewHistories(
  context: VerifyContext,
  cardId?: string
): Promise<Array<Record<string, unknown>>> {
  const records = await evaluate<Array<Record<string, unknown>>>(
    context,
    `window.api.data.listAlive('review')`
  )
  return records.filter(
    (record) =>
      record['kind'] === 'history' &&
      (cardId === undefined || String(record['cardId'] ?? '') === cardId)
  )
}

/** 直接写一张复习卡样本（自带前提：不依赖别处留下的状态） */
async function addReviewCard(
  context: VerifyContext,
  sample: Record<string, unknown>
): Promise<string> {
  const created = await evaluate<{ id: string }>(
    context,
    `window.api.data.add('review', ${JSON.stringify(sample)})`
  )
  await evaluate(context, `window.api.data.flush()`)
  await evaluate(
    context,
    `window.dispatchEvent(new CustomEvent('worklife:data-changed', { detail: { module: 'review' } })), true`
  )
  await wait(400)
  return created.id
}

/** 打开复习页并**确保没有会话在跑**（就地背卡只在没有会话时接管键盘） */
async function openReviewIdle(context: VerifyContext): Promise<void> {
  await closeFloaters(context)
  await evaluate(context, `window.__verify.clickNav('review')`)
  await wait(500)
  // 第 10 块：进页面后要读三个模块才画得出主题列表 —— 等它真的画出来再往下做，
  // 否则后面的"点主题 / 找卡片行"会踩在还没渲染的空页面上（本块第一次全量跑红过 U5/U7）
  await untilTrue(
    context,
    `!!document.querySelector('[data-testid="review-topic"]') || window.__verify.exists('review-topics-empty')`,
    16,
    250
  )
  // Esc 先退出可能存在的会话：就地背卡与"会话"是两套状态，
  // 会话在手时空格/1/2/3 作用于会话，验就地背卡的键盘会拿到错的目标
  await pressKeyOn(context, 'Escape')
  await wait(300)
}

/** 点开复习树里的某一行（就地展开） */
async function expandCardRow(context: VerifyContext, cardId: string): Promise<boolean> {
  // 第 10 块：卡片行只在"当前主题的树"里。没看到就先把它的主题点开（见 revealReviewCardRow）
  const shown = await revealReviewCardRow(context, cardId)
  if (!shown) return false
  const clicked = await evaluate<boolean>(
    context,
    `(() => {
       const row = document.querySelector('[data-testid="review-card-row"][data-card-id="${cardId}"]')
       if (!row) return false
       row.click()
       return true
     })()`
  )
  if (!clicked) return false
  return untilTrue(
    context,
    `!!document.querySelector('[data-testid="inline-card-review"][data-card-id="${cardId}"]')`,
    12,
    200
  )
}

/** 读一张卡的行（到期日 / 到期时间 / 是否展开） */
async function cardRowSnapshot(
  context: VerifyContext,
  cardId: string
): Promise<{ due: string; dueTime: string; expanded: boolean; text: string } | null> {
  return evaluate<{ due: string; dueTime: string; expanded: boolean; text: string } | null>(
    context,
    `(() => {
       const row = document.querySelector('[data-testid="review-card-row"][data-card-id="${cardId}"]')
       if (!row) return null
       return {
         due: row.getAttribute('data-due') || '',
         dueTime: row.getAttribute('data-due-time') || '',
         expanded: row.getAttribute('data-expanded') === '1',
         text: (row.textContent || '').trim()
       }
     })()`
  )
}

/**
 * 第 10 块：把复习页切到"某张卡所属的主题"，并展开它的树。
 *
 * ## 为什么要这一步
 *
 * 复习页重做之后，结构变成**左栏选主题 → 「开始复习这个主题」→ 下方展开树**（§6.7），
 * 卡片行只出现在**当前主题**的树里。以前"全部卡片"那种一屏列完全部卡片的列表没有了，
 * 所以验收必须先把它所属的主题点开，否则会空等一行永远不渲染的卡片。
 *
 * ## 为什么不在验收里重算归属
 *
 * "这张卡属于哪个主题"由页面按 `shared/reviewPageView.ts` 的 `cardTopicKey` 算出来
 * （topicId → bookId → 来源名 → 自成来源档）。验收再算一遍等于把规则抄第二份，
 * 规则一改就会出现"页面对了、验收还在按老规则找"的假失败。
 * 所以页面把映射挂在 `window.__reviewCardTopics` 上（与学习页的 `__treeParentMap`
 * 是同一类验收挂点），这里只照着点。
 */
async function focusReviewCardTopic(context: VerifyContext, cardId: string): Promise<boolean> {
  /**
   * ⚠️ 这两步都**必须轮询**（本块第一次全量跑就在这里栽了：P8-U5/U7 在第 1 趟红，
   * 第 2 趟却绿）。进页面后要读三个模块（review / learning / reading）才算得出
   * "卡片属于哪个主题"，单点读一次会拿到空映射 —— 判据没错，是验收台没给界面留时间。
   */
  const key = await until<string>(
    context,
    `(((window.__reviewCardTopics || {})[${JSON.stringify(cardId)}]) || '')`,
    (value) => typeof value === 'string' && value !== '',
    14,
    250
  )
  if (key === null || key === '') return false

  // 左栏那一行（按 data-topic-key 精确匹配，不做字符串转义）；已经是选中的就不再点
  const clicked = await until<boolean>(
    context,
    `(() => {
       const rows = Array.from(document.querySelectorAll('[data-testid="review-topic"]'))
       const row = rows.find((item) => item.getAttribute('data-topic-key') === ${JSON.stringify(key)})
       if (!row) return false
       if (row.getAttribute('data-active') !== '1') row.click()
       return true
     })()`,
    (value) => value === true,
    14,
    250
  )
  if (clicked !== true) return false

  // 已经"进入"过就不要再点（再点一次是"收起"）
  const already = await evaluate<boolean>(
    context,
    `(() => {
       const button = window.__verify.byTestId('review-enter-topic')
       return !!button && button.getAttribute('data-entered') === '1'
     })()`
  )
  if (!already) {
    const buttonShown = await untilTrue(context, `window.__verify.exists('review-enter-topic')`, 10, 200)
    if (!buttonShown) return false
    await evaluate(context, `window.__verify.click('[data-testid="review-enter-topic"]')`)
  }
  return untilTrue(context, `window.__verify.exists('review-card-tree')`, 12, 200)
}

/** 切到那张卡所属的主题并等它的行渲染出来（第 10 块起，"看到卡片行"必须先做这一步） */
async function revealReviewCardRow(context: VerifyContext, cardId: string): Promise<boolean> {
  const present = await evaluate<boolean>(
    context,
    `!!document.querySelector('[data-testid="review-card-row"][data-card-id="${cardId}"]')`
  )
  if (present) return true
  const focused = await focusReviewCardTopic(context, cardId)
  if (!focused) return false
  return untilTrue(
    context,
    `!!document.querySelector('[data-testid="review-card-row"][data-card-id="${cardId}"]')`,
    14,
    250
  )
}


/** 设置页里某个动作那一行的读数 */
async function hotkeyRowSnapshot(
  context: VerifyContext,
  action: string
): Promise<{ combo: string; isDefault: boolean; single: boolean } | null> {
  return evaluate<{ combo: string; isDefault: boolean; single: boolean } | null>(
    context,
    `(() => {
       const row = document.querySelector('[data-testid="hotkey-row"][data-action="${action}"]')
       if (!row) return null
       return {
         combo: row.getAttribute('data-combo') || '',
         isDefault: row.getAttribute('data-default') === '1',
         single: !!row.querySelector('[data-testid="hotkey-single"]')
       }
     })()`
  )
}

/** 点设置页里某个动作那一行的某个按钮 */
async function clickHotkeyRowButton(
  context: VerifyContext,
  action: string,
  testId: string
): Promise<boolean> {
  return evaluate<boolean>(
    context,
    `(() => {
       const row = document.querySelector('[data-testid="hotkey-row"][data-action="${action}"]')
       if (!row) return false
       const button = row.querySelector('[data-testid="${testId}"]')
       if (!button) return false
       button.click()
       return true
     })()`
  )
}

export async function runPhase8Checks(
  context: VerifyContext,
  record: Recorder,
  passNumber: number
): Promise<void> {
  const marker = `阶段8树（第${passNumber}趟）`

  /** 渲染进程里报的错：验收失败时把最近几条带出来，省得靠猜（临时诊断用） */
  const consoleErrors: string[] = []
  context.window.webContents.on('console-message', (event) => {
    const message = String(event.message)
    if (event.level === 'error') consoleErrors.push(message.slice(0, 300))
    if (message.includes('[phase8]')) consoleErrors.push(message.slice(0, 600))
  })
  const diagnostics = (): string =>
    consoleErrors.length === 0 ? '渲染进程无报错' : `渲染进程报错=${consoleErrors.slice(-3).join(' | ')}`
  void diagnostics

  // =========================================================================
  // A. 学习树：加资料 → 加子节点 → 折叠 → 打勾 → 数据里真的落了
  // =========================================================================
  try {
    // 自带前提：现场造一个主题，不依赖任何别处留下的状态
    const topic = await evaluate<{ id: string }>(
      context,
      `window.api.data.add('learning', { kind: 'topic', title: ${JSON.stringify(
        `${marker} 主题`
      )}, status: 'active', progress: 0 })`
    )
    await evaluate(context, `window.api.data.flush()`)
    await wait(300)
    await openLearningTopic(context, topic.id)

    // 先复位：新主题必然是空树，等它渲染出来（空树会显示提示行）
    const emptyShown = await untilTrue(context, `window.__verify.exists('learning-tree-empty')`, 8, 250)

    // ① 加一份资料（根节点）
    await evaluate(context, `window.__verify.click('[data-testid="learning-tree-add-root"]')`)
    await wait(300)
    const resourceDrawer = await evaluate<boolean>(
      context,
      `window.__verify.exists('learning-resource-drawer')`
    )
    await evaluate(
      context,
      `window.__verify.setText('learning-resource-name', ${JSON.stringify(`${marker} 资料A`)})`
    )
    await evaluate(context, `window.__verify.setText('learning-resource-type', '书')`)
    await evaluate(context, `window.__verify.setText('learning-resource-percent', '50')`)
    await evaluate(context, `window.__verify.click('[data-testid="learning-resource-save"]')`)

    const rows = await until<TreeRow[]>(
      context,
      rowsExpr('learning-tree'),
      (list) => list.length === 1
    )
    if (rows === null) throw new Error('资料没有渲染出来')
    const resourceRow = rows[0]
    if (resourceRow === undefined) throw new Error('资料行没有渲染出来')

    // ② 在资料下加一个章节（子节点）
    await evaluate(
      context,
      `(() => {
         const row = document.querySelector('[data-testid="learning-tree-row"][data-node-id="${resourceRow.id}"]')
         const button = row && row.querySelector('[data-testid="learning-tree-add-child"]')
         if (button) button.click()
         return !!button
       })()`
    )
    await wait(300)
    await evaluate(
      context,
      `window.__verify.setText('learning-node-title', ${JSON.stringify(`${marker} 第1章`)})`
    )
    await evaluate(context, `window.__verify.click('[data-testid="learning-node-save"]')`)

    const rows2 = await until<TreeRow[]>(
      context,
      rowsExpr('learning-tree'),
      (list) => list.length === 2 && list.some((row) => row.title.includes('第1章'))
    )
    const chapter = rows2?.find((row) => row.title.includes('第1章'))
    const chapterCreated = chapter !== undefined

    // ③ 打勾 + 折叠：资料行此时是汇总节点（有子节点），它那格勾必须点不动
    const toggled = await evaluate<boolean>(
      context,
      `(() => {
         const row = document.querySelector('[data-testid="learning-tree-row"][data-node-id="${chapter?.id ?? ''}"]')
         const check = row && row.querySelector('[data-testid="learning-tree-check"]')
         if (!check) return false
         check.click()
         return true
       })()`
    )
    const toggledDone = await untilTrue(
      context,
      `(() => {
         const row = document.querySelector('[data-testid="learning-tree-row"][data-node-id="${chapter?.id ?? ''}"]')
         return !!row && row.getAttribute('data-done') === '1'
       })()`
    )
    // 折叠：点资料行的三角，章节行应当从界面上消失
    await evaluate(
      context,
      `(() => {
         const row = document.querySelector('[data-testid="learning-tree-row"][data-node-id="${resourceRow.id}"]')
         const caret = row && row.querySelector('[data-testid="learning-tree-toggle"]')
         if (caret) caret.click()
         return !!caret
       })()`
    )
    const collapsed = await untilTrue(
      context,
      `${rowsExpr('learning-tree')}.length === 1`
    )
    // 再展开回来，后面的检查还要用
    await evaluate(
      context,
      `(() => {
         const row = document.querySelector('[data-testid="learning-tree-row"][data-node-id="${resourceRow.id}"]')
         const caret = row && row.querySelector('[data-testid="learning-tree-toggle"]')
         if (caret) caret.click()
         return !!caret
       })()`
    )
    await untilTrue(context, `${rowsExpr('learning-tree')}.length === 2`)
    await evaluate(context, `window.api.data.flush()`)
    await wait(300)

    const saved = await evaluate<Array<Record<string, unknown>>>(
      context,
      `window.api.data.listAlive('learning')`
    )
    const nodeRecords = saved.filter((item) => item['kind'] === 'node')
    const resourceRecord = nodeRecords.find((item) => item['id'] === resourceRow.id)
    const chapterRecord = nodeRecords.find((item) => item['id'] === chapter?.id)

    record({
      id: 'P8-A1',
      prd: 'FEAT-006',
      name: '学习树：加资料 → 加章节 → 折叠/展开 → 打勾，全部落到数据文件',
      passed:
        emptyShown &&
        resourceDrawer &&
        chapterCreated &&
        toggled &&
        toggledDone &&
        collapsed &&
        resourceRecord?.['kind'] === 'node' &&
        resourceRecord?.['parentId'] === null &&
        chapterRecord?.['parentId'] === resourceRow.id &&
        chapterRecord?.['done'] === true,
      detail: `开始时是空树=${emptyShown}；资料抽屉打开=${resourceDrawer}；资料 id=${resourceRow.id.slice(0, 6)} parentId=${String(resourceRecord?.['parentId'])}；章节 id=${String(chapter?.id).slice(0, 6)} parentId=${String(chapterRecord?.['parentId']).slice(0, 6)} done=${String(chapterRecord?.['done'])}；打勾后界面已更新=${toggledDone}；折叠生效=${collapsed}`
    })
  } catch (error) {
    record({
      id: 'P8-A1',
      prd: 'FEAT-006',
      name: '学习树：加资料 → 加章节 → 折叠/展开 → 打勾，全部落到数据文件',
      passed: false,
      detail: String(error)
    })
  }

  // =========================================================================
  // B. 进度模型：占比自动归一化 + 最小单元才算数 + 汇总节点不参与
  // =========================================================================
  /** B 造出来的三份资料之一，C 要用它验"就地改占比" */
  let shareTargetId = ''
  try {
    // 现场造三份资料，占比 50 / 30 / 20：
    //   资料A：章(汇总) → 条目a1(勾) + 条目a2(未勾) + 条目a3(未勾)  → 内部 1/3 = 33%
    //   资料B：两个条目，都没勾                                      → 内部 0/2 = 0%
    //   资料C：两个条目，都勾了                                      → 内部 2/2 = 100%
    // 主题进度 = (50×33 + 30×0 + 20×100) ÷ 100 = 36.5 → 37%
    const topic = await evaluate<{ id: string }>(
      context,
      `window.api.data.add('learning', { kind: 'topic', title: ${JSON.stringify(
        `${marker} 进度主题`
      )}, status: 'active', progress: 0 })`
    )
    const topicId = topic.id

    const addNode = async (
      title: string,
      parentId: string | null,
      order: number,
      done: boolean,
      percent?: number
    ): Promise<{ id: string }> =>
      evaluate<{ id: string }>(
        context,
        `window.api.data.add('learning', ${JSON.stringify({
          kind: 'node',
          ownerId: topicId,
          topicId,
          parentId,
          order,
          title,
          done,
          ...(percent === undefined ? {} : { percent })
        })})`
      )

    const resA = await addNode(`${marker} A`, null, 0, false, 50)
    const resB = await addNode(`${marker} B`, null, 1, false, 30)
    const resC = await addNode(`${marker} C`, null, 2, false, 20)
    const chA = await addNode(`${marker} A-第1章`, resA.id, 0, true) // 汇总：自己勾了也不该算
    await addNode(`${marker} A-1.1`, chA.id, 0, true)
    await addNode(`${marker} A-1.2`, chA.id, 1, false)
    await addNode(`${marker} A-1.3`, chA.id, 2, false)
    // 资料 B 下面两个最小单元，都没勾 → 内部 0/2
    await addNode(`${marker} B-1`, resB.id, 0, false)
    await addNode(`${marker} B-2`, resB.id, 1, false)
    // 资料 C 下面两个最小单元，都勾了 → 内部 2/2
    await addNode(`${marker} C-1`, resC.id, 0, true)
    await addNode(`${marker} C-2`, resC.id, 1, true)
    await evaluate(context, `window.api.data.flush()`)
    await wait(400)

    await openLearningTopic(context, topicId)
    const computed = await until<string>(
      context,
      `((window.__verify.byTestId('learning-progress-computed') || {}).textContent || '').trim()`,
      (text) => text.includes('%')
    )
    // 等到三份资料都渲染出来，且汇总章节也在（它默认是展开的）
    const rows = await until<TreeRow[]>(
      context,
      rowsExpr('learning-tree'),
      (list) =>
        list.filter((row) => row.depth === 0).length === 3 &&
        list.some((row) => row.id === resA.id && row.progress.includes('已学'))
    )
    if (rows === null) throw new Error('三份资料没有渲染出来')

    // 展开资料 A，让它的汇总章节也出现在界面上（要先点得动，才谈得上虚线框）
    await evaluate(
      context,
      `(() => {
         const row = document.querySelector('[data-testid="learning-tree-row"][data-node-id="${resA.id}"]')
         const caret = row && row.querySelector('[data-testid="learning-tree-toggle"]')
         if (caret) caret.click()
         return !!caret
       })()`
    )
    const expanded = await until<TreeRow[]>(
      context,
      rowsExpr('learning-tree'),
      (list) => list.some((row) => row.id === chA.id)
    )
    if (expanded === null) throw new Error('资料 A 展开后没看到汇总章节')

    // 用 id 认行，不要靠标题后缀——标题是用户可改的，改一次断言就失效
    const rowA = expanded.find((row) => row.id === resA.id)
    const chapterRow = expanded.find((row) => row.id === chA.id)
    shareTargetId = resA.id

    // 资料 A 行必须是"两个数字"，且已学按最小单元算（1/3）
    const aText = rowA?.progress ?? ''
    const twoNumbers = aText.includes('占比') && aText.includes('已学') && aText.includes('（1/3）')

    record({
      id: 'P8-B1',
      prd: 'FEAT-006',
      name: '进度公式：占比自动归一化、最小单元才算数、汇总节点不参与计数',
      passed:
        twoNumbers &&
        aText.includes('占比 50%') &&
        chapterRow?.checkDisabled === true &&
        chapterRow?.summary === true,
      detail: `资料A 行显示="${aText}"（期望"占比 50% · 已学 33%（1/3）"）；汇总章节 summary=${String(
        chapterRow?.summary
      )} 勾不可点=${String(chapterRow?.checkDisabled)}；主题进度显示="${String(computed)}"（期望 37%）`
    })
  } catch (error) {
    record({
      id: 'P8-B1',
      prd: 'FEAT-006',
      name: '进度公式：占比自动归一化、最小单元才算数、汇总节点不参与计数',
      passed: false,
      detail: String(error)
    })
  }

  // =========================================================================
  // C. 资料行的两个数字 + 就地改占比（自动归一化）
  // =========================================================================
  try {
    if (shareTargetId === '') throw new Error('B 没能造出资料行，C 无法继续')
    const rows = await until<TreeRow[]>(
      context,
      rowsExpr('learning-tree'),
      (list) => list.some((row) => row.id === shareTargetId)
    )
    const rootRow = rows?.find((row) => row.id === shareTargetId)
    if (rootRow === undefined) throw new Error('资料行没有渲染出来')

    // 点资料行 → 就地改占比
    await evaluate(
      context,
      `(() => {
         const row = document.querySelector('[data-testid="learning-tree-row"][data-node-id="${rootRow.id}"]')
         const line = row && row.querySelector('.tree__line')
         if (line) line.click()
         return !!line
       })()`
    )
    const editorOpen = await untilTrue(context, `window.__verify.exists('learning-share-editor')`, 8, 250)
    // 填一个**任意数字**（不凑 100，验证自动归一化）
    await evaluate(
      context,
      `(() => {
         const input = window.__verify.byTestId('learning-share-input')
         if (!input) return false
         const descriptor = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')
         if (descriptor && descriptor.set) descriptor.set.call(input, '7')
         input.dispatchEvent(new Event('input', { bubbles: true }))
         return true
       })()`
    )
    await wait(200)
    await evaluate(context, `window.__verify.click('[data-testid="learning-share-save"]')`)
    const shareSaved = await untilTrue(
      context,
      `(() => {
         const row = document.querySelector('[data-testid="learning-tree-row"][data-node-id="${rootRow.id}"]')
         const progress = row && row.querySelector('[data-testid="learning-tree-progress"]')
         return !!progress && (progress.textContent || '').includes('占比')
       })()`
    )
    await evaluate(context, `window.api.data.flush()`)
    await wait(300)

    const saved = await evaluate<Array<Record<string, unknown>>>(
      context,
      `window.api.data.listAlive('learning')`
    )
    const record_ = saved.find((item) => item['id'] === rootRow.id)
    const rows2 = await evaluate<TreeRow[]>(context, rowsExpr('learning-tree'))
    const firstProgress = rows2.find((row) => row.id === rootRow.id)?.progress ?? ''

    record({
      id: 'P8-C1',
      prd: 'FEAT-006',
      name: '资料行显示两个数字（占比 / 已学），点它可以就地改占比并写盘',
      passed:
        editorOpen && shareSaved && record_?.['percent'] === 7 && firstProgress.includes('已学'),
      detail: `就地编辑打开=${editorOpen}；落盘 percent=${String(record_?.['percent'])}（期望 7，填的就是任意数字不是百分数）；行显示="${firstProgress}"`
    })
  } catch (error) {
    record({
      id: 'P8-C1',
      prd: 'FEAT-006',
      name: '资料行显示两个数字（占比 / 已学），点它可以就地改占比并写盘',
      passed: false,
      detail: String(error)
    })
  }

  // =========================================================================
  // D. 虚线框 / 实心方框 + 第 5 层起缩进 12px + 层数不限
  // =========================================================================
  try {
    // 先复位再操作：绕开界面/直接写盘造出来的节点，界面可能还没渲染出来，
    // 重新进一次这个主题保证树是最新的
    const currentTopic = await evaluate<string>(
      context,
      `(() => {
         const root = document.querySelector('[data-testid="learning-tree-root"]')
         return root ? root.getAttribute('data-tree-owner') || '' : ''
       })()`
    )
    if (currentTopic === '') throw new Error('拿不到当前主题的 id')
    await openLearningTopic(context, currentTopic)

    // 建到第 7 层：1 → 2 → 3 → 4 → 5 → 6 → 7。
    // 最里面那层是**最小单元**（没有子节点），所以它会渲染成实心方框；
    // 7 层也让 depth 4/5/6 同时出现在界面上，正好覆盖"第 5 层起缩进 12px"的三个点。
    const topicId = currentTopic
    let parentId: string | null = null
    let lastId = ''
    for (let level = 1; level <= 7; level += 1) {
      const created = await evaluate<{ id: string }>(
        context,
        `window.api.data.add('learning', ${JSON.stringify({
          kind: 'node',
          ownerId: topicId,
          topicId,
          parentId: null,
          order: 90 + level,
          title: `${marker} 第${level}层`,
          done: false
        })})`
      )
      if (parentId !== null) {
        await evaluate(
          context,
          `window.api.data.update('learning', ${JSON.stringify(created.id)}, { parentId: ${JSON.stringify(parentId)} })`
        )
      }
      parentId = created.id
      lastId = created.id
    }
    await evaluate(context, `window.api.data.flush()`)
    // 重新进一次这个主题，让新节点渲染出来
    await evaluate(context, `window.__verify.clickNav('home')`)
    await wait(300)
    await openLearningTopic(context, topicId)

    // 这条链在现有的资料下面，先展开它所在的资料根，逐层点到最里面那一层
    let currentId = ''
    for (let round = 0; round < 10; round += 1) {
      const visible = await evaluate<
        Array<{ id: string; parentId: string | null; summary: boolean; border: string }>
      >(
        context,
        `(() => {
           const rows = Array.from(document.querySelectorAll('[data-testid="learning-tree-row"]'))
           return rows.map((row) => {
             const id = row.getAttribute('data-node-id') || ''
             const check = row.querySelector('[data-testid="learning-tree-check"]')
             return {
               id,
               // 父子关系从页面写下的映射里取（DOM 上只有一个 depth，还原不出 parent）
               parentId: (window.__treeParentMap || {})[id] ?? null,
               summary: row.getAttribute('data-summary') === '1',
               border: check && check.disabled === true ? 'dashed' : 'solid'
             }
           })
         })()`
      )
      if (visible.some((row) => row.id === lastId)) break
      const next = visible.find((row) => row.parentId === currentId && row.summary)
      if (next === undefined) break
      await toggleRow(context, 'learning-tree', next.id, true)
      currentId = next.id
    }

    // 现在界面上既有"虚线框汇总节点"（中间层）也有"实心方框最小单元"（最里面那层）
    const boxes = await waitForSummaryRows(context, 'learning-tree', consoleErrors)
    const summaryRow = boxes.summary
    const leafRow = boxes.leaf
    const deepIndent = await evaluate<{ depth: number; indent: number } | null>(
      context,
      `(() => {
         const row = document.querySelector('[data-testid="learning-tree-row"][data-node-id="${lastId}"]')
         if (!row) return null
         const line = row.querySelector('.tree__line')
         return { depth: Number(row.getAttribute('data-depth') || '0'), indent: line ? Number(line.getAttribute('data-indent') || '0') : -1 }
       })()`
    )

    // 缩进必须与"第 5 层起 12px"的规则一致：depth=5（第 6 层）→ 80 + 12 = 92
    const indents = await evaluate<number[]>(
      context,
      `(() => {
         const rows = Array.from(document.querySelectorAll('[data-testid="learning-tree-row"]'))
         return rows
           .map((row) => row.querySelector('.tree__line'))
           .filter(Boolean)
           .map((line) => Number(line.getAttribute('data-indent') || '0'))
       })()`
    )
    const level5Indent = indents.includes(80) // 第 5 层（depth 4）
    const level6Indent = indents.includes(92) // 第 6 层（depth 5）：80 + 12
    const level7Indent = indents.includes(104) // 第 7 层（depth 6）：80 + 24
    record({
      id: 'P8-D1',
      prd: 'FEAT-006',
      name: '汇总节点虚线框、最小单元实心方框；层数不限且第 5 层起缩进收窄到 12px',
      passed:
        summaryRow?.checkBorder === 'dashed' &&
        leafRow?.checkBorder === 'solid' &&
        deepIndent !== null &&
        level5Indent &&
        level6Indent &&
        level7Indent,
      detail: `汇总节点边框=${String(summaryRow?.checkBorder)}（期望 dashed）；最小单元边框=${String(
        leafRow?.checkBorder
      )}（期望 solid）；最深渲染到 depth=${String(deepIndent?.depth)} indent=${String(deepIndent?.indent)}；出现过的缩进=[${indents.join(', ')}]（期望含 80/92/104）`
    })
  } catch (error) {
    record({
      id: 'P8-D1',
      prd: 'FEAT-006',
      name: '汇总节点虚线框、最小单元实心方框；层数不限且第 5 层起缩进收窄到 12px',
      passed: false,
      detail: String(error)
    })
  }

  // =========================================================================
  // E. 拖拽排序：把后面的兄弟拖到前面，顺序真的落盘
  // =========================================================================
  try {
    const rows = await evaluate<TreeRow[]>(context, rowsExpr('learning-tree'))
    const topRows = rows.filter((row) => row.depth === 0)
    if (topRows.length < 2) throw new Error('顶层节点少于两个，无法验证排序')
    const first = topRows[0]
    const second = topRows[1]
    if (!first || !second) throw new Error('拿不到前两个顶层节点')

    const dragged = await evaluate<boolean>(
      context,
      `(() => {
         const row = document.querySelector('[data-testid="learning-tree-row"][data-node-id="${second.id}"]')
         const grip = row && row.querySelector('[data-testid="learning-tree-drag"]')
         const target = document.querySelector('[data-testid="learning-tree-row"][data-node-id="${first.id}"] .tree__line')
         if (!grip || !target) return false
         const data = new DataTransfer()
         // 把 dataTransfer 挂在 window 上，好让 dragover 与 drop 分两次派发
         window.__dragData = data
         grip.dispatchEvent(new DragEvent('dragstart', { bubbles: true, cancelable: true, dataTransfer: data }))
         const rect = target.getBoundingClientRect()
         // 落在目标行的**上半部分** → 同级插到它前面
         target.dispatchEvent(new DragEvent('dragover', {
           bubbles: true, cancelable: true, dataTransfer: data,
           clientY: rect.top + Math.max(1, rect.height * 0.1)
         }))
         return true
       })()`
    )
    // 真实的拖拽里 dragover 与 drop 之间一定有时间间隔；
    // 这里同样分开派发，否则组件还没来得及记下落点就收到 drop（已踩过）
    await wait(400)
    const dropped = await evaluate<boolean>(
      context,
      `(() => {
         const target = document.querySelector('[data-testid="learning-tree-row"][data-node-id="${first.id}"] .tree__line')
         const grip = document.querySelector('[data-testid="learning-tree-row"][data-node-id="${second.id}"] [data-testid="learning-tree-drag"]')
         if (!target || !window.__dragData) return false
         const rect = target.getBoundingClientRect()
         target.dispatchEvent(new DragEvent('drop', {
           bubbles: true, cancelable: true, dataTransfer: window.__dragData,
           clientY: rect.top + Math.max(1, rect.height * 0.1)
         }))
         if (grip) {
           grip.dispatchEvent(new DragEvent('dragend', {
             bubbles: true, cancelable: true, dataTransfer: window.__dragData
           }))
         }
         delete window.__dragData
         return true
       })()`
    )
    await evaluate(context, `window.api.data.flush()`)
    await wait(400)

    const after = await until<TreeRow[]>(
      context,
      rowsExpr('learning-tree'),
      (list) => list.filter((row) => row.depth === 0)[0]?.id === second.id
    )
    const afterTop = after?.filter((row) => row.depth === 0) ?? []
    const saved = await evaluate<Array<Record<string, unknown>>>(
      context,
      `window.api.data.listAlive('learning')`
    )
    const firstRecord = saved.find((item) => item['id'] === first.id)
    const secondRecord = saved.find((item) => item['id'] === second.id)
    // 只断言"两者的先后关系反过来了"：同级 order 是否从 0 起连续
    // 受这棵树里**别的**顶层节点（同主题的历史样本）影响，不该在这里要求具体数值
    const orderOk =
      Number(secondRecord?.['order']) < Number(firstRecord?.['order']) &&
      firstRecord?.['parentId'] === null &&
      secondRecord?.['parentId'] === null

    record({
      id: 'P8-E1',
      prd: 'FEAT-006',
      name: '拖动排序：拖到目标行上边即插到它前面，同级顺序真的落盘',
      passed: dragged && dropped && after !== null && afterTop[0]?.id === second.id && orderOk,
      detail: `拖拽事件发出=${dragged && dropped}；拖动后第一行=${afterTop[0]?.title ?? '（空）'}（期望第 2 个：${second.title}）；落盘 order：被拖的=${String(
        secondRecord?.['order']
      )}，原来的第一个=${String(firstRecord?.['order'])}（前者必须更小）`
    })
  } catch (error) {
    record({
      id: 'P8-E1',
      prd: 'FEAT-006',
      name: '拖动排序：拖到目标行上边即插到它前面，同级顺序真的落盘',
      passed: false,
      detail: String(error)
    })
  }

  // =========================================================================
  // F. 边界拒绝：跨 owner 移动 / 移到自己的后代下（防成环）
  // =========================================================================
  try {
    // 前置：另造一个主题与它的节点（属于**另一个 owner**）
    const otherTopic = await evaluate<{ id: string }>(
      context,
      `window.api.data.add('learning', { kind: 'topic', title: ${JSON.stringify(
        `${marker} 另一个主题`
      )}, status: 'active', progress: 0 })`
    )
    const foreign = await evaluate<{ id: string }>(
      context,
      `window.api.data.add('learning', ${JSON.stringify({
        kind: 'node',
        ownerId: otherTopic.id,
        topicId: otherTopic.id,
        parentId: null,
        order: 0,
        title: `${marker} 别人的资料`,
        done: false
      })})`
    )

    // 当前页这棵树（走的是与拖拽完全相同的那条路）
    const freshIds = await evaluate<string[]>(
      context,
      `window.__worklifeTree.freshNodeIds('learning')`
    )
    // 光看"被拒"不够：还要确认那个外来节点**真的在存储里**，
    // 否则拿一个不存在的 id 去移动也会被拒，那样这条检查等于没验（已踩过）
    const foreignExists = freshIds.includes(foreign.id)
    // 挂点必须与界面上那棵树是同一棵：不同步的话，判据会拿旧数据去判，结论不可信
    const hookDiag = await evaluate<string>(
      context,
      `(() => {
         const tree = window.__worklifeTree
         const root = document.querySelector('[data-testid="learning-tree-root"]')
         return JSON.stringify({
           hookOwner: tree ? tree.ownerId : null,
           domOwner: root ? root.getAttribute('data-tree-owner') : null,
           hookNodeCount: tree ? tree.nodeIds().length : -1,
           foreignInHook: tree ? tree.nodeIds().includes(${JSON.stringify(foreign.id)}) : false,
           foreignInStore: ${JSON.stringify(freshIds)}.includes(${JSON.stringify(foreign.id)})
         })
       })()`
    )
    // 跨 owner 的判据在 `tree.ts` 里同时校验"两个 id 都在同一批节点里"，
    // 所以拖动源那边也要给一个**真实存在**的本地节点
    const boxes = await waitForSummaryRows(context, 'learning-tree', consoleErrors)
    const parentRow = boxes.summary
    const leafRow = boxes.leaf

    // ① 跨 owner：拿**别的主题**的节点 id 当拖动源。
    //    页面这棵树里当然没有它，所以**任何**拒绝理由都算拒绝——
    //    断言只要求"被拒 + 数据没被改"，不挑具体文案
    const crossOwner = await evaluate<{ ok: boolean; reason: string | null }>(
      context,
      `window.__worklifeTree.canMove(${JSON.stringify(foreign.id)}, ${JSON.stringify(parentRow.id)})`
    )
    const crossResult = await evaluate<string | null>(
      context,
      `window.__worklifeTree.tryMove(${JSON.stringify(foreign.id)}, ${JSON.stringify(parentRow.id)}, 0)`
    )
    // ② 防成环：拖动源与目标都在同一棵树里，且**目标确实是它的后代**
    //    （拿两个不相干的节点来试是没有意义的：那本来就该成功，已踩过）
    const together = await evaluate<{ ok: boolean; reason: string | null; move: string | null }>(
      context,
      `(async () => {
         const result = window.__worklifeTree.canMove(${JSON.stringify(parentRow.id)}, ${JSON.stringify(leafRow.id)})
         const move = await window.__worklifeTree.tryMove(${JSON.stringify(parentRow.id)}, ${JSON.stringify(leafRow.id)}, 0)
         return { ok: result.ok, reason: result.reason, move }
       })()`
    )
    await evaluate(context, `window.api.data.flush()`)
    await wait(300)

    // 被拒之后**数据一个字段都不能动**：树里不该多出"别人的资料"，层级也不该变
    const saved = await evaluate<Array<Record<string, unknown>>>(
      context,
      `window.api.data.listAlive('learning')`
    )
    const foreignRecord = saved.find((item) => item['id'] === foreign.id)
    const parentRecord = saved.find((item) => item['id'] === parentRow.id)
    const untouched =
      foreignRecord?.['ownerId'] === otherTopic.id &&
      foreignRecord?.['parentId'] === null &&
      parentRecord?.['parentId'] !== leafRow.id
    const stillLocal =
      foreignRecord !== undefined && parentRecord !== undefined && parentRecord['ownerId'] !== otherTopic.id

    record({
      id: 'P8-F1',
      prd: 'FEAT-006',
      name: '边界拒绝：跨 owner 移动被拒；移到自己的后代下被拒（防成环），且不动数据',
      passed:
        foreignExists &&
        crossOwner.ok === false &&
        crossResult !== null &&
        together.ok === false &&
        together.move !== null &&
        together.move.includes('不能') &&
        untouched &&
        stillLocal,
      detail: `外来节点确实存在于存储=${foreignExists}；挂点现场=${hookDiag}；跨 owner：canMove=${JSON.stringify(
        crossOwner
      )}，tryMove 返回="${String(crossResult)}"；成环：canMove=${JSON.stringify(
        together
      )}"（move 是拒绝理由而不是 null，说明确实没写盘）；数据未被改动=${untouched}（别人的资料 ownerId=${String(
        foreignRecord?.['ownerId']
      ).slice(0, 6)} parentId=${String(foreignRecord?.['parentId'])}；拖动源仍在本主题=${stillLocal}）`
    })
  } catch (error) {
    record({
      id: 'P8-F1',
      prd: 'FEAT-006',
      name: '边界拒绝：跨 owner 移动被拒；移到自己的后代下被拒（防成环），且不动数据',
      passed: false,
      detail: String(error)
    })
  }

  // =========================================================================
  // G. 删除节点走 unlink：整棵子树一起进回收站，日志等关联内容保留
  // =========================================================================
  try {
    const topic = await evaluate<{ id: string }>(
      context,
      `window.api.data.add('learning', { kind: 'topic', title: ${JSON.stringify(
        `${marker} 删除主题`
      )}, status: 'active', progress: 0 })`
    )
    const topicId = topic.id
    const parent = await evaluate<{ id: string }>(
      context,
      `window.api.data.add('learning', ${JSON.stringify({
        kind: 'node',
        ownerId: topicId,
        topicId,
        parentId: null,
        order: 0,
        title: `${marker} 待删除章节`,
        done: false
      })})`
    )
    const child = await evaluate<{ id: string }>(
      context,
      `window.api.data.add('learning', ${JSON.stringify({
        kind: 'node',
        ownerId: topicId,
        topicId,
        parentId: parent.id,
        order: 0,
        title: `${marker} 待删除子章`,
        done: false
      })})`
    )
    // 关联内容：一条挂在这个章节上的学习日志（删除节点时**必须保留**）
    const log = await evaluate<{ id: string }>(
      context,
      `window.api.data.add('learning', ${JSON.stringify({
        kind: 'log',
        topicId,
        nodeId: parent.id,
        date: '2026-10-11',
        minutes: 30,
        content: `${marker} 这一节的日志`
      })})`
    )
    await evaluate(context, `window.api.data.flush()`)
    await wait(300)
    await openLearningTopic(context, topicId)

    const rows = await until<TreeRow[]>(
      context,
      rowsExpr('learning-tree'),
      (list) => list.some((row) => row.id === parent.id)
    )
    if (rows === null) throw new Error('待删除章节没有渲染出来')

    await evaluate(
      context,
      `(() => {
         const row = document.querySelector('[data-testid="learning-tree-row"][data-node-id="${parent.id}"]')
         const button = row && row.querySelector('[data-testid="learning-tree-delete"]')
         if (button) button.click()
         return !!button
       })()`
    )
    const dialogOpen = await untilTrue(
      context,
      `window.__verify.exists('learning-node-delete-dialog')`,
      8,
      200
    )
    const summaryText = await evaluate<string>(
      context,
      `((window.__verify.byTestId('learning-node-delete-summary') || {}).textContent || '').trim()`
    )
    await evaluate(context, `window.__verify.click('[data-testid="dialog-confirm"]')`)
    const goneFromUi = await untilTrue(
      context,
      `(() => {
         const row = document.querySelector('[data-testid="learning-tree-row"][data-node-id="${parent.id}"]')
         return row === null
       })()`
    )
    await evaluate(context, `window.api.data.flush()`)
    await wait(400)

    const alive = await evaluate<Array<Record<string, unknown>>>(
      context,
      `window.api.data.listAlive('learning')`
    )
    const all = await evaluate<Array<Record<string, unknown>>>(
      context,
      `window.api.data.list('learning')`
    )
    const parentAlive = alive.some((item) => item['id'] === parent.id)
    const childAlive = alive.some((item) => item['id'] === child.id)
    const parentDeleted = all.find((item) => item['id'] === parent.id)?.['deletedAt'] !== undefined
    const childDeleted = all.find((item) => item['id'] === child.id)?.['deletedAt'] !== undefined
    // 关联内容保留：那条日志必须还在（不是跟着节点一起被删）
    const logKept = alive.some((item) => item['id'] === log.id)

    record({
      id: 'P8-G1',
      prd: 'FEAT-006',
      name: '删除节点：整棵子树一起进回收站，关联内容（学习日志）保留',
      passed:
        dialogOpen &&
        goneFromUi &&
        summaryText.includes('子节点') &&
        !parentAlive &&
        !childAlive &&
        parentDeleted &&
        childDeleted &&
        logKept,
      detail: `确认弹窗=${dialogOpen}；界面上的行已消失=${goneFromUi}；提示="${summaryText}"；父节点已软删=${parentDeleted}；子节点已软删=${childDeleted}；子节点仍在存活列表=${childAlive}；日志保留=${logKept}`
    })
  } catch (error) {
    record({
      id: 'P8-G1',
      prd: 'FEAT-006',
      name: '删除节点：整棵子树一起进回收站，关联内容（学习日志）保留',
      passed: false,
      detail: String(error)
    })
  }

  // =========================================================================
  // H. 读书树：书 → 章 → 子章，完成度按章算；摘录**不进树**
  // =========================================================================
  try {
    const book = await evaluate<{ id: string }>(
      context,
      `window.api.data.add('reading', ${JSON.stringify({
        kind: 'book',
        title: `${marker} 之书`,
        author: '验收',
        format: 'paper',
        status: 'reading',
        totalPages: 320,
        currentPage: 128,
        percent: 0,
        finishedAt: null,
        rating: 0,
        review: ''
      })})`
    )
    const bookId = book.id
    const addChapter = async (
      title: string,
      parentId: string | null,
      order: number,
      done: boolean
    ): Promise<{ id: string }> =>
      evaluate<{ id: string }>(
        context,
        `window.api.data.add('reading', ${JSON.stringify({
          kind: 'node',
          ownerId: bookId,
          parentId,
          order,
          title,
          done
        })})`
      )
    // 第 1 章是顶层最小单元（勾了）；第 2 章有子章 → 汇总，不进分母
    await addChapter(`${marker} 第1章`, null, 0, true)
    const ch2 = await addChapter(`${marker} 第2章`, null, 1, false)
    const sub21 = await addChapter(`${marker} 2.1`, ch2.id, 0, false)
    // 摘录：**不能进树**（它永远不打勾，当叶子算会让进度永远偏低）
    await evaluate(
      context,
      `window.api.data.add('reading', ${JSON.stringify({
        kind: 'excerpt',
        bookId,
        type: 'quote',
        locator: 'p.11',
        content: `${marker} 一条摘录`
      })})`
    )
    await evaluate(context, `window.api.data.flush()`)
    await wait(300)

    await openBookDetail(context, bookId)
    const drawerOpen = await evaluate<boolean>(context, `window.__verify.exists('reading-detail')`)
    const rows = await until<TreeRow[]>(
      context,
      rowsExpr('reading-tree'),
      (list) => list.length >= 2
    )
    if (rows === null) throw new Error('章节树没有渲染出来')
    // 展开第 2 章，让子章渲染出来
    await evaluate(
      context,
      `(() => {
         const row = document.querySelector('[data-testid="reading-tree-row"][data-node-id="${ch2.id}"]')
         const caret = row && row.querySelector('[data-testid="reading-tree-toggle"]')
         if (caret) caret.click()
         return !!caret
       })()`
    )
    const rowsExpanded = await until<TreeRow[]>(
      context,
      rowsExpr('reading-tree'),
      (list) => list.some((row) => row.id === sub21.id)
    )
    if (rowsExpanded === null) throw new Error('子章没有渲染出来')

    // 完成度按章算：最小单元 = ch1（勾）、sub21（未勾）；ch2 是汇总不进分母 → 1/2 = 50%
    const progressText = await until<string>(
      context,
      `((window.__verify.byTestId('reading-chapter-progress') || {}).textContent || '').trim()`,
      (text) => text.includes('%')
    )
    if (progressText === null) throw new Error('章节完成度没有显示')
    const subChapterShown = rowsExpanded.some((row) => row.id === sub21.id)
    // 摘录不进树：树里不许出现摘录文本
    const treeHtml = await evaluate<string>(
      context,
      `(document.querySelector('[data-testid="reading-tree-root"]') || {}).innerHTML || ''`
    )
    const excerptInTree = treeHtml.includes('一条摘录')
    const excerptStillListed = await evaluate<boolean>(
      context,
      `(() => {
         const items = Array.from(document.querySelectorAll('[data-testid="reading-excerpt"]'))
         return items.some((el) => (el.textContent || '').includes('一条摘录'))
       })()`
    )
    // 书卡上的页码仍作参考显示
    const spotShown = await evaluate<string>(
      context,
      `((window.__verify.byTestId('reading-spot') || {}).textContent || '').trim()`
    )

    record({
      id: 'P8-H1',
      prd: 'FEAT-006',
      name: '读书树：书 → 章 → 子章可用；完成度按章算；摘录与想法不进树',
      passed:
        drawerOpen &&
        subChapterShown &&
        progressText.includes('50%') &&
        progressText.includes('1/2') &&
        !excerptInTree &&
        excerptStillListed,
      detail: `抽屉打开=${drawerOpen}；章行数=${rows.length}；展开后含子章=${subChapterShown}；完成度="${progressText}"（期望 1/2 = 50%）；摘录出现在树里=${excerptInTree}（期望 false）；摘录仍在列表里=${excerptStillListed}；页码参考="${spotShown}"`
    })
  } catch (error) {
    record({
      id: 'P8-H1',
      prd: 'FEAT-006',
      name: '读书树：书 → 章 → 子章可用；完成度按章算；摘录与想法不进树',
      passed: false,
      detail: String(error)
    })
  }

  // =========================================================================
  // I. 读书树的增删改 + 跨书移动被拒
  // =========================================================================
  try {
    const bookId = await evaluate<string>(
      context,
      `(() => {
         const tree = document.querySelector('[data-testid="reading-tree-root"]')
         const drawer = document.querySelector('[data-testid="reading-detail"]')
         if (!tree || !drawer) return ''
         return tree.getAttribute('data-tree-owner') || ''
       })()`
    )
    if (bookId === '') throw new Error('拿不到当前书的 id')

    // ① 通过界面「加章节」新增一个顶层章
    await evaluate(context, `window.__verify.click('[data-testid="reading-tree-add-root"]')`)
    await wait(300)
    const chapterDrawer = await evaluate<boolean>(
      context,
      `window.__verify.exists('reading-chapter-drawer')`
    )
    await evaluate(
      context,
      `window.__verify.setText('reading-chapter-title', ${JSON.stringify(`${marker} 新加的章`)})`
    )
    await evaluate(context, `window.__verify.click('[data-testid="reading-chapter-save"]')`)
    const rows = await until<TreeRow[]>(
      context,
      rowsExpr('reading-tree'),
      (list) => list.some((row) => row.title.includes('新加的章'))
    )
    if (rows === null) throw new Error('新加的章没有渲染出来')
    const added = rows.find((row) => row.title.includes('新加的章'))
    if (added === undefined) throw new Error('拿不到新加的章的 id')

    // ② 打勾 → 完成度变化
    await evaluate(
      context,
      `(() => {
         const row = document.querySelector('[data-testid="reading-tree-row"][data-node-id="${added.id}"]')
         const check = row && row.querySelector('[data-testid="reading-tree-check"]')
         if (check) check.click()
         return !!check
       })()`
    )
    const checked = await untilTrue(
      context,
      `(() => {
         const row = document.querySelector('[data-testid="reading-tree-row"][data-node-id="${added.id}"]')
         return !!row && row.getAttribute('data-done') === '1'
       })()`
    )

    // ③ 改名（就地输入框：点「改名」→ 输入 → 回车）
    // 注意：点之前先确认这一行**没有**处于"正在改名"的状态，避免上一次的残留影响本次判断
    const clickedRename = await clickRowButton(context, 'reading-tree', added.id, 'rename-open')
    const renameOpened = await untilTrue(context, `window.__verify.exists('reading-tree-rename')`, 8, 200)
    // 失败时把现场带出来（就地改名最容易"看着打开了、其实没提交"）
    const renameDiagOpen = renameOpened
      ? ''
      : await evaluate<string>(
          context,
          `(() => {
             const row = document.querySelector('[data-testid="reading-tree-row"][data-node-id="${added.id}"]')
             const button = row && row.querySelector('[data-testid="reading-tree-rename-open"]')
             return JSON.stringify({
               clicked: ${JSON.stringify(clickedRename)},
               rowExists: !!row,
               buttonExists: !!button,
               drawerOpen: !!document.querySelector('[data-testid="reading-detail"]'),
               nameInputs: document.querySelectorAll('input.tree__rename').length
             })
           })()`
        )
    // 用**原生 setter** 输入（React 受控/非受控都认这个），并确认输入框当时确实在
    const typed = await evaluate<string>(
      context,
      `(() => {
         const input = window.__verify.byTestId('reading-tree-rename')
         if (!input) return 'missing'
         const descriptor = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')
         if (descriptor && descriptor.set) descriptor.set.call(input, ${JSON.stringify(
           `${marker} 改名后的章`
         )})
         input.dispatchEvent(new Event('input', { bubbles: true }))
         return 'typed:' + input.value
       })()`
    )
    /*
     * 再触发提交：回车提交，失焦也提交（两条路都试）。
     *
     * ⚠️ **输入框可能已经不在了 —— 那说明它已经提交过了**（就地输入框挂 `onBlur`，
     * 焦点一旦被别的事情挪走就自动提交）。早先这里把"提交那一刻输入框还在"也当成
     * 判据，于是遇到"刚输入完就被 blur 提交"时会出现假失败：
     * 落盘与行标题**都已经是新名字**，只有 `committed` 是 false（已踩过，P8-I1 偶发）。
     * 现在改成轮询：输入框还在就派发回车 + 失焦；不在了就认为已提交，
     * 最终判据仍然是"**界面与落盘都变成了新名字**"——一个字都没放宽。
     */
    let commitAttempts = 0
    for (; commitAttempts < 6; commitAttempts += 1) {
      const stillEditing = await evaluate<boolean>(
        context,
        `!!window.__verify.byTestId('reading-tree-rename')`
      )
      if (!stillEditing) break
      await evaluate(
        context,
        `(() => {
           const input = window.__verify.byTestId('reading-tree-rename')
           if (!input) return false
           input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
           input.dispatchEvent(new FocusEvent('blur', { bubbles: true }))
           return true
         })()`
      )
      await wait(250)
    }
    // 等界面上的行真的换成新名字（轮询）
    for (let attempt = 0; attempt < 12; attempt += 1) {
      const hit = await evaluate<boolean>(
        context,
        `(() => {
           const rows = Array.from(document.querySelectorAll('[data-testid="reading-tree-row"]'))
           return rows.some((row) => (row.textContent || '').includes('改名后的章'))
         })()`
      )
      if (hit) break
      await wait(250)
    }
    const renamedRow = await evaluate<string>(
      context,
      `(() => {
         const rows = Array.from(document.querySelectorAll('[data-testid="reading-tree-row"][data-node-id="${added.id}"]'))
         const title = rows[0] && rows[0].querySelector('[data-testid="reading-tree-title"]')
         return title ? (title.textContent || '').trim() : ''
       })()`
    )
    /*
     * 判据：**界面与落盘都变成新名字**（这才叫"改名生效"）。
     * 不再要求"提交那一刻输入框还在"——那是机制细节，输入框可能已经被 blur 提前提交了。
     */
    const storedTitle = await evaluate<string>(
      context,
      `(async () => {
         const records = await window.api.data.listAlive('reading')
         const mine = records.find((item) => item['id'] === ${JSON.stringify(added.id)})
         return mine ? String(mine['title'] || '') : ''
       })()`
    )
    const renamed = renamedRow.includes('改名后的章') && storedTitle.includes('改名后的章')
    // 改名失败时把现场带出来：输入框在不在、值是什么、存储里的标题是什么
    const renameDiag = await evaluate<string>(
      context,
      `(() => {
         return JSON.stringify({
           inputPresent: !!window.__verify.byTestId('reading-tree-rename'),
           openedImmediately: ${JSON.stringify(renameOpened)},
           typedInto: ${JSON.stringify(typed)},
           openDiag: ${JSON.stringify(renameDiagOpen)},
           storedTitle: ${JSON.stringify(storedTitle)},
           rowTitle: ${JSON.stringify(renamedRow)},
           commitRounds: ${commitAttempts}
         })
       })()`
    )
    await evaluate(context, `window.api.data.flush()`)
    await wait(300)

    // ④ 跨书移动被拒：另造一本书的一个章节，试着拖到当前这本书下
    const otherBook = await evaluate<{ id: string }>(
      context,
      `window.api.data.add('reading', ${JSON.stringify({
        kind: 'book',
        title: `${marker} 另一本书`,
        author: '验收',
        format: 'paper',
        status: 'want',
        totalPages: 0,
        currentPage: 0,
        percent: 0,
        finishedAt: null,
        rating: 0,
        review: ''
      })})`
    )
    const foreign = await evaluate<{ id: string }>(
      context,
      `window.api.data.add('reading', ${JSON.stringify({
        kind: 'node',
        ownerId: otherBook.id,
        parentId: null,
        order: 0,
        title: `${marker} 别人书里的章`,
        done: false
      })})`
    )
    const localRoot = rows.find((row) => row.depth === 0)
    const cross = await evaluate<{ ok: boolean; reason: string | null }>(
      context,
      `window.__worklifeTree.canMove(${JSON.stringify(foreign.id)}, ${JSON.stringify(localRoot?.id ?? '')})`
    )
    const crossTry = await evaluate<string | null>(
      context,
      `window.__worklifeTree.tryMove(${JSON.stringify(foreign.id)}, ${JSON.stringify(localRoot?.id ?? '')}, 0)`
    )
    await evaluate(context, `window.api.data.flush()`)
    await wait(300)
    const alive = await evaluate<Array<Record<string, unknown>>>(
      context,
      `window.api.data.listAlive('reading')`
    )
    const foreignRecord = alive.find((item) => item['id'] === foreign.id)
    const notMoved = foreignRecord?.['ownerId'] === otherBook.id && foreignRecord?.['parentId'] === null

    record({
      id: 'P8-I1',
      prd: 'FEAT-006',
      name: '读书树：加章节 / 打勾 / 改名都落盘；跨书移动被拒且不动数据',
      passed:
        chapterDrawer && checked && renamed && cross.ok === false && crossTry !== null && notMoved,
      detail: `加章抽屉=${chapterDrawer}；新章 id=${added.id.slice(0, 6)}；打勾落盘=${checked}；改名生效=${renamed}（现场=${renameDiag}）；跨书 canMove=${JSON.stringify(
        cross
      )}；tryMove 返回="${String(crossTry)}"；数据未动=${notMoved}`
    })
  } catch (error) {
    record({
      id: 'P8-I1',
      prd: 'FEAT-006',
      name: '读书树：加章节 / 打勾 / 改名都落盘；跨书移动被拒且不动数据',
      passed: false,
      detail: `${String(error)}；${diagnostics()}`
    })
  }

  // =========================================================================
  // J. 右键菜单（第 03 块 / FEAT-001）
  //
  // 覆盖 `docs\TASKS\03` §八 的 DoD：五类实体都有右键菜单、
  // `⋯` 与右键取到相同的项、条件项按状态切换、Esc 能关、边缘会翻转、
  // 删除仍进回收站。
  //
  // 四条硬规矩在这里的落法：
  //   ① 轮询等待（`until` / `untilTrue`）
  //   ② 自带前提（每条自己造任务 / 备忘 / 章 / 卡）
  //   ③ **先复位再操作**（`closeFloaters`，右键菜单是浮层，最容易踩"前一个没关"）
  //   ④ 用对触发方式（真的派发 `contextmenu` 事件，不直接调 React 回调）
  // =========================================================================

  // ---- J1 任务 / 日历项：右键与 `⋯` 取到同一批项；Esc 能关 ----
  try {
    const taskTitle = `${marker} 右键任务`
    const created = await evaluate<{ id: string }>(
      context,
      `window.api.data.add('plan', ${JSON.stringify({
        title: taskTitle,
        date: dateKey(new Date()),
        timeSlot: 'none',
        recurrence: 'none',
        done: false,
        carriedOver: 0,
        doneAt: null
      })})`
    )
    await evaluate(context, `window.api.data.flush()`)
    await closeFloaters(context)
    await evaluate(context, `window.__verify.clickNav('plan')`)
    await wait(400)

    /** 这一条任务的菜单读数（按 textContent 找到行，避开同页的别的任务） */
    const myRowSelector = `[data-testid="task-row"][data-task-id="${created.id}"]`
    const rowShown = await untilTrue(context, `!!document.querySelector(${JSON.stringify(myRowSelector)})`, 12, 250)
    if (!rowShown) throw new Error('新造的任务没有渲染在计划页上')

    // —— 右键 ——
    await closeFloaters(context)
    const rightClicked = await rightClickSelector(context, myRowSelector)
    const byRight = await waitForMenu(context)
    const rightInside = byRight !== null && menuInsideViewport(byRight)
    // Esc 关闭
    await evaluate(context, `window.__verify.key('Escape')`)
    const closedByEsc = await untilTrue(context, `!document.querySelector('[data-testid="context-menu"]')`, 6, 200)

    // —— 点 `⋯`（同一个入口的另一半）——
    await closeFloaters(context)
    const menuButtonClicked = await clickMenuButton(context, 'task-menu', myRowSelector)
    const byButton = await waitForMenu(context)
    await closeFloaters(context)

    const identical = byRight !== null && byButton !== null && sameItems(byRight, byButton)
    const rightIds = byRight?.ids ?? []
    record({
      id: 'P8-J1',
      prd: 'FEAT-001',
      name: '任务行：右键与 ⋯ 取到同一批菜单项；Esc 能关；菜单不跑到窗口外',
      passed:
        rightClicked &&
        byRight !== null &&
        rightInside &&
        closedByEsc &&
        menuButtonClicked &&
        byButton !== null &&
        identical &&
        rightIds.length >= 8 &&
        rightIds.includes('task-delete') &&
        rightIds.includes('task-mark-done'),
      detail: `右键成功=${rightClicked}；右键项=[${rightIds.join(',')}]；⋯ 点击=${menuButtonClicked}；⋯ 项=[${(byButton?.ids ?? []).join(',')}]；两者一致=${identical}；菜单在窗口内=${rightInside}（位置 ${byRight?.left ?? -1},${byRight?.top ?? -1} / 视口 ${byRight?.viewportWidth ?? -1}×${byRight?.viewportHeight ?? -1}）；Esc 关闭=${closedByEsc}`
    })
  } catch (error) {
    record({
      id: 'P8-J1',
      prd: 'FEAT-001',
      name: '任务行：右键与 ⋯ 取到同一批菜单项；Esc 能关；菜单不跑到窗口外',
      passed: false,
      detail: `${String(error)}；${diagnostics()}`
    })
  }

  // ---- J2 任务：条件项（完成/未完成）+ 从菜单真的能改数据 ----
  try {
    const taskTitle = `${marker} 条件项任务`
    const created = await evaluate<{ id: string }>(
      context,
      `window.api.data.add('plan', ${JSON.stringify({
        title: taskTitle,
        date: dateKey(new Date()),
        timeSlot: 'none',
        recurrence: 'none',
        done: false,
        carriedOver: 0,
        doneAt: null
      })})`
    )
    await evaluate(context, `window.api.data.flush()`)
    await closeFloaters(context)
    // 造完样本要**等页面真的读出来**（重挂 + 轮询），不能靠固定延时碰运气
    const rowSelector = `[data-testid="task-row"][data-task-id="${created.id}"]`
    const rowShown = await remountUntil(context, 'plan', 'memo', planRowExpr(created.id))
    if (!rowShown) throw new Error(`新造的任务没有渲染在计划页上（id=${created.id}）`)

    // 未完成 → 只有"标记完成"
    await rightClickSelector(context, rowSelector)
    const pending = await waitForMenu(context)
    const pendingHasDone = pending?.ids.includes('task-mark-done') === true
    const pendingHasUndone = pending?.ids.includes('task-mark-undone') === true

    // 点"标记完成" → 数据里 done 变 true
    const clickedMarkDone = await clickMenuItem(context, 'task-mark-done')
    // **轮询等界面真的变了**再读数据。
    // 不能"点完固定等 500ms 就读"：写盘是异步的（要 flush），
    // 固定延时在快机器上偶尔够、在慢机器上就假失败（已踩过：done=false 但界面其实已勾）。
    const doneInUi = await untilTrue(
      context,
      `(() => {
         const row = document.querySelector('[data-testid="task-row"][data-task-id="${created.id}"]')
         return !!row && row.getAttribute('data-done') === 'true'
       })()`,
      16,
      250
    )
    await evaluate(context, `window.api.data.flush()`)
    await wait(300)
    const afterDone = await evaluate<Array<Record<string, unknown>>>(context, `window.api.data.list('plan')`)
    const doneValue = afterDone.find((item) => item['id'] === created.id)?.['done'] === true

    // 已完成 → 只有"标记未完成"
    await closeFloaters(context)
    // 勾完以后任务会挪到"已完成"分组，行会重新挂载；重挂 + 轮询等它回来
    const rowBack = await remountUntil(context, 'plan', 'memo', planRowExpr(created.id))
    if (!rowBack) throw new Error('勾完以后任务行没有回到界面上')
    await closeFloaters(context)
    await rightClickSelector(context, rowSelector)
    const finished = await waitForMenu(context)
    const finishedHasUndone = finished?.ids.includes('task-mark-undone') === true
    const finishedHasDone = finished?.ids.includes('task-mark-done') === true

    // 点"标记未完成" → 回到 false
    const clickedMarkUndone = await clickMenuItem(context, 'task-mark-undone')
    const undoneInUi = await untilTrue(
      context,
      `(() => {
         const row = document.querySelector('[data-testid="task-row"][data-task-id="${created.id}"]')
         return !!row && row.getAttribute('data-done') === 'false'
       })()`,
      16,
      250
    )
    await evaluate(context, `window.api.data.flush()`)
    await wait(300)
    const afterUndone = await evaluate<Array<Record<string, unknown>>>(context, `window.api.data.list('plan')`)
    const undoneValue = afterUndone.find((item) => item['id'] === created.id)?.['done'] === false
    await closeFloaters(context)

    record({
      id: 'P8-J2',
      prd: 'FEAT-001',
      name: '任务的"标记完成 / 标记未完成"按状态只出现一条，且点了真的改数据',
      passed:
        pending !== null &&
        pendingHasDone &&
        !pendingHasUndone &&
        clickedMarkDone &&
        doneInUi &&
        doneValue &&
        finished !== null &&
        finishedHasUndone &&
        !finishedHasDone &&
        clickedMarkUndone &&
        undoneInUi &&
        undoneValue,
      detail: `未完成时：有标记完成=${pendingHasDone} 有标记未完成=${pendingHasUndone}（应为 true / false）；点后界面已勾=${doneInUi} 落盘 done=${String(doneValue)}；已完成时：有标记未完成=${finishedHasUndone} 有标记完成=${finishedHasDone}（应为 true / false）；再点后界面已取消=${undoneInUi} 落盘 done=${String(undoneValue)}`
    })
  } catch (error) {
    record({
      id: 'P8-J2',
      prd: 'FEAT-001',
      name: '任务的"标记完成 / 标记未完成"按状态只出现一条，且点了真的改数据',
      passed: false,
      detail: `${String(error)}；${diagnostics()}`
    })
  }

  // ---- J3 任务：删除仍进回收站（不是物理删除）----
  try {
    const created = await evaluate<{ id: string }>(
      context,
      `window.api.data.add('plan', ${JSON.stringify({
        title: `${marker} 待删除任务`,
        date: dateKey(new Date()),
        timeSlot: 'none',
        recurrence: 'none',
        done: false,
        carriedOver: 0,
        doneAt: null
      })})`
    )
    await evaluate(context, `window.api.data.flush()`)
    await closeFloaters(context)
    const rowSelector = `[data-testid="task-row"][data-task-id="${created.id}"]`
    const rowShown = await remountUntil(context, 'plan', 'memo', planRowExpr(created.id))
    if (!rowShown) throw new Error(`待删除的任务没有渲染在计划页上（id=${created.id}）`)
    await closeFloaters(context)
    await rightClickSelector(context, rowSelector)
    await waitForMenu(context)
    const clickedDelete = await clickMenuItem(context, 'task-delete')
    // 轮询等这一行从界面上消失（写盘是异步的，固定延时会假失败）
    const goneFromUi = await untilTrue(
      context,
      `(() => {
         const row = document.querySelector('[data-testid="task-row"][data-task-id="${created.id}"]')
         return row === null
       })()`,
      16,
      250
    )
    await evaluate(context, `window.api.data.flush()`)
    await wait(300)

    const alive = await evaluate<Array<Record<string, unknown>>>(context, `window.api.data.listAlive('plan')`)
    const all = await evaluate<Array<Record<string, unknown>>>(context, `window.api.data.list('plan')`)
    const gone = !alive.some((item) => item['id'] === created.id)
    const inTrash = all.find((item) => item['id'] === created.id)?.['deletedAt'] !== undefined
    const trashListed = await evaluate<Array<{ id: string }>>(
      context,
      `(async () => (await window.api.trash.list()).map((entry) => ({ id: entry.id })))()`
    )
    const inTrashList = trashListed.some((entry) => entry.id === created.id)
    await closeFloaters(context)

    record({
      id: 'P8-J3',
      prd: 'FEAT-001',
      name: '右键删除任务：进回收站（软删除）而不是物理删除',
      passed: clickedDelete && goneFromUi && gone && inTrash && inTrashList,
      detail: `菜单里点了删除=${clickedDelete}；界面上那行已消失=${goneFromUi}；存活列表里已消失=${gone}；记录带 deletedAt=${inTrash}；回收站列表里能找到=${inTrashList}`
    })
  } catch (error) {
    record({
      id: 'P8-J3',
      prd: 'FEAT-001',
      name: '右键删除任务：进回收站（软删除）而不是物理删除',
      passed: false,
      detail: `${String(error)}；${diagnostics()}`
    })
  }

  // ---- J4 日历项（本周视图的卡片）也能右键出同一批项 ----
  try {
    // 自带前提：样本走 `addPlanSample`（写盘 + 广播刷新），不依赖别处留下的状态
    const taskId = await addPlanSample(context, {
      title: `${marker} 日历项`,
      date: dateKey(new Date()),
      timeSlot: 'morning',
      recurrence: 'none',
      done: false,
      carriedOver: 0,
      doneAt: null
    })
    await closeFloaters(context)
    const rowSelector = `[data-testid="task-row"][data-task-id="${taskId}"]`
    const cardSelector = `[data-testid="week-card"][data-task-id="${taskId}"]`
    const rowShownToday = await remountUntil(context, 'plan', 'memo', planRowExpr(taskId))
    if (!rowShownToday) throw new Error('日历项的样本任务没有渲染在计划页上')

    // 切周视图：**轮询到日历真的渲染出来**（不用固定延时）
    let weekShown = await openPlanCalendar(context, 'week')
    let cardShown = weekShown
      ? await untilTrue(context, `!!document.querySelector(${JSON.stringify(cardSelector)})`, 8, 250)
      : false
    // 卡片刻不出来就整页重挂一次再试（页面是挂载时读一次盘，见 `remountUntil`）
    if (!cardShown) {
      await remountUntil(context, 'plan', 'memo', planRowExpr(taskId))
      weekShown = await openPlanCalendar(context, 'week')
      cardShown = weekShown
        ? await untilTrue(context, `!!document.querySelector(${JSON.stringify(cardSelector)})`, 8, 250)
        : false
    }

    // 对照：同一页任务行的菜单（两者应完全一致——同一份定义）
    const listShown = await openPlanList(context, 'today')
    await closeFloaters(context)
    const rowShown = listShown
      ? await untilTrue(context, `!!document.querySelector(${JSON.stringify(rowSelector)})`, 8, 250)
      : false
    let byRow: MenuSnapshot | null = null
    if (rowShown) {
      await rightClickSelector(context, rowSelector)
      byRow = await waitForMenu(context)
      await closeFloaters(context)
    }
    // 切回周视图右键那张卡
    const weekAgain = await openPlanCalendar(context, 'week')
    await closeFloaters(context)
    const cardClicked = weekAgain ? await rightClickSelector(context, cardSelector) : false
    const byCard = await waitForMenu(context)
    await closeFloaters(context)
    await openPlanList(context, 'today')

    record({
      id: 'P8-J4',
      prd: 'FEAT-001',
      name: '日历（本周视图）的项也能右键，且与任务行是同一批菜单项',
      passed:
        cardShown && cardClicked && byCard !== null && byRow !== null && sameItems(byCard, byRow),
      detail: `周视图日历渲染=${weekShown} 卡片渲染=${cardShown}；回到今天视图=${listShown} 任务行渲染=${rowShown}；右键=${cardClicked}；卡片项=[${(byCard?.ids ?? []).join(',')}]；任务行项=[${(byRow?.ids ?? []).join(',')}]；一致=${byCard !== null && byRow !== null && sameItems(byCard, byRow)}`
    })
  } catch (error) {
    record({
      id: 'P8-J4',
      prd: 'FEAT-001',
      name: '日历（本周视图）的项也能右键，且与任务行是同一批菜单项',
      passed: false,
      detail: `${String(error)}；${diagnostics()}`
    })
  }

  // ---- J5 树节点（章 / 子章）：右键项齐全，且"添加子节点"真的建出子节点 ----
  try {
    const topic = await evaluate<{ id: string }>(
      context,
      `window.api.data.add('learning', { kind: 'topic', title: ${JSON.stringify(
        `${marker} 右键主题`
      )}, status: 'active', progress: 0 })`
    )
    const parent = await evaluate<{ id: string }>(
      context,
      `window.api.data.add('learning', ${JSON.stringify({
        kind: 'node',
        ownerId: topic.id,
        topicId: topic.id,
        parentId: null,
        order: 0,
        title: `${marker} 右键资料`,
        done: false
      })})`
    )
    const chapter = await evaluate<{ id: string }>(
      context,
      `window.api.data.add('learning', ${JSON.stringify({
        kind: 'node',
        ownerId: topic.id,
        topicId: topic.id,
        parentId: parent.id,
        order: 0,
        title: `${marker} 右键章节`,
        done: false
      })})`
    )
    await evaluate(context, `window.api.data.flush()`)
    await wait(300)
    await openLearningTopic(context, topic.id)
    // 树的展开是手风琴式的：父节点（资料）没展开时，章节行根本没渲染。
    // 这里沿祖先链逐级点开，直到章节行真的出现在界面上。
    const chapterShown = await expandAncestorsOf(context, 'learning-tree', chapter.id)

    const chapterSelector = `[data-testid="learning-tree-row"][data-node-id="${chapter.id}"]`
    await closeFloaters(context)
    const rightClicked = await rightClickSelector(context, chapterSelector)
    const menu = await waitForMenu(context)
    const ids = menu?.ids ?? []
    const hasAll =
      ids.includes('node-add-child') &&
      ids.includes('node-rename') &&
      ids.includes('node-delete') &&
      ids.includes('node-mark-done') &&
      ids.includes('node-toggle-expand')

    // 从菜单点"添加子节点" → 应该弹出新增抽屉
    const clickedAddChild = await clickMenuItem(context, 'node-add-child')
    const drawerOpen = await untilTrue(context, `window.__verify.exists('learning-node-drawer')`, 10, 200)
    await closeFloaters(context)

    // `⋯` 与右键取同一批项（注意：刚才点了"添加子节点"打开过抽屉，先复位）
    const buttonClicked = await clickMenuButton(context, 'learning-tree-menu', chapterSelector)
    const byButton = await waitForMenu(context)
    await closeFloaters(context)

    record({
      id: 'P8-J5',
      prd: 'FEAT-001',
      name: '树节点（章节）右键项齐全（加子节点/编辑/删除/标记完成/展开折叠），且 ⋯ 与右键一致',
      passed:
        chapterShown &&
        rightClicked &&
        menu !== null &&
        hasAll &&
        clickedAddChild &&
        drawerOpen &&
        buttonClicked &&
        byButton !== null &&
        sameItems(menu, byButton),
      detail: `章节行渲染=${chapterShown}；右键=${rightClicked}；项=[${ids.join(',')}]；必需项齐全=${hasAll}；"添加子节点"打开抽屉=${drawerOpen}；⋯ 点击=${buttonClicked}；⋯ 项=[${(byButton?.ids ?? []).join(',')}]；一致=${menu !== null && byButton !== null && sameItems(menu, byButton)}`
    })
  } catch (error) {
    record({
      id: 'P8-J5',
      prd: 'FEAT-001',
      name: '树节点（章节）右键项齐全（加子节点/编辑/删除/标记完成/展开折叠），且 ⋯ 与右键一致',
      passed: false,
      detail: `${String(error)}；${diagnostics()}`
    })
  }

  // ---- J6 树节点：汇总节点的"标记完成"是禁用的，且点不出事 ----
  try {
    const topic = await evaluate<{ id: string }>(
      context,
      `window.api.data.add('learning', { kind: 'topic', title: ${JSON.stringify(
        `${marker} 汇总主题`
      )}, status: 'active', progress: 0 })`
    )
    const parent = await evaluate<{ id: string }>(
      context,
      `window.api.data.add('learning', ${JSON.stringify({
        kind: 'node',
        ownerId: topic.id,
        topicId: topic.id,
        parentId: null,
        order: 0,
        title: `${marker} 汇总资料`,
        done: false
      })})`
    )
    await evaluate(
      context,
      `window.api.data.add('learning', ${JSON.stringify({
        kind: 'node',
        ownerId: topic.id,
        topicId: topic.id,
        parentId: parent.id,
        order: 0,
        title: `${marker} 汇总资料下的章`,
        done: false
      })})`
    )
    await evaluate(context, `window.api.data.flush()`)
    await wait(300)
    await openLearningTopic(context, topic.id)

    const parentSelector = `[data-testid="learning-tree-row"][data-node-id="${parent.id}"]`
    await untilTrue(context, `!!document.querySelector(${JSON.stringify(parentSelector)})`, 14, 250)
    // 先展开一下，让这一行确实是"有子节点"的汇总状态（展开不影响它的 summary 判定）
    await toggleRow(context, 'learning-tree', parent.id, true)
    await closeFloaters(context)
    await rightClickSelector(context, parentSelector)
    const menu = await waitForMenu(context)
    // 汇总节点是"有子节点"的那一行：它自己的勾是只读的，菜单里那一项也必须禁用
    const markId = menu?.ids.includes('node-mark-undone') === true ? 'node-mark-undone' : 'node-mark-done'
    const disabled = menu?.disabledIds.includes(markId) === true

    // 点它：禁用项必须点不动（数据里 done 仍是 false）
    const clicked = await evaluate<boolean>(
      context,
      `(() => {
         const button = document.querySelector('[data-testid="context-menu-${markId}"]')
         if (!button) return false
         button.click()
         return true
       })()`
    )
    await wait(400)
    await evaluate(context, `window.api.data.flush()`)
    const records = await evaluate<Array<Record<string, unknown>>>(context, `window.api.data.listAlive('learning')`)
    const stillNotDone = records.find((item) => item['id'] === parent.id)?.['done'] !== true
    await closeFloaters(context)

    record({
      id: 'P8-J6',
      prd: 'FEAT-001',
      name: '汇总节点的"标记完成"是禁用项，点了也不会改动数据（与树上只读的勾一致）',
      passed: menu !== null && disabled && clicked && stillNotDone,
      detail: `菜单项=[${(menu?.ids ?? []).join(',')}]；禁用项=[${(menu?.disabledIds ?? []).join(',')}]；标记项=${markId} 被禁用=${disabled}；点了以后数据仍未完成=${stillNotDone}`
    })
  } catch (error) {
    record({
      id: 'P8-J6',
      prd: 'FEAT-001',
      name: '汇总节点的"标记完成"是禁用项，点了也不会改动数据（与树上只读的勾一致）',
      passed: false,
      detail: `${String(error)}；${diagnostics()}`
    })
  }

  // ---- J7 备忘：右键与 ⋯ 一致；置顶 / 取消置顶是条件项 ----
  try {
    const memoText = `${marker} 右键备忘`
    const created = await evaluate<{ id: string }>(
      context,
      `window.api.data.add('memo', { text: ${JSON.stringify(memoText)}, pinned: false })`
    )
    await evaluate(context, `window.api.data.flush()`)
    await closeFloaters(context)
    await evaluate(context, `window.__verify.clickNav('memo')`)
    await wait(400)

    const rowSelector = `[data-testid="memo-item"][data-memo-id="${created.id}"]`
    const shown = await untilTrue(context, `!!document.querySelector(${JSON.stringify(rowSelector)})`, 12, 250)
    await closeFloaters(context)
    const rightClicked = await rightClickSelector(context, rowSelector)
    const byRight = await waitForMenu(context)
    const ids = byRight?.ids ?? []
    const hasAll =
      ids.includes('memo-edit') &&
      ids.includes('memo-delete') &&
      ids.includes('memo-pin') &&
      ids.includes('memo-add-tag')
    const notPinned = ids.includes('memo-pin') && !ids.includes('memo-unpin')
    await closeFloaters(context)

    const buttonClicked = await clickMenuButton(context, 'memo-menu', rowSelector)
    const byButton = await waitForMenu(context)
    await closeFloaters(context)

    // 从菜单置顶 → 再开菜单应该变成"取消置顶"
    await clickMenuButton(context, 'memo-menu', rowSelector)
    await waitForMenu(context)
    const clickedPin = await clickMenuItem(context, 'memo-pin')
    await evaluate(context, `window.api.data.flush()`)
    await wait(600)
    const records = await evaluate<Array<Record<string, unknown>>>(context, `window.api.data.listAlive('memo')`)
    const pinnedStored = records.find((item) => item['id'] === created.id)?.['pinned'] === true

    await closeFloaters(context)
    await clickMenuButton(context, 'memo-menu', rowSelector)
    const afterPin = await waitForMenu(context)
    const nowUnpin = afterPin?.ids.includes('memo-unpin') === true && afterPin?.ids.includes('memo-pin') === false
    await closeFloaters(context)

    record({
      id: 'P8-J7',
      prd: 'FEAT-001',
      name: '备忘：右键与 ⋯ 一致；置顶 / 取消置顶按状态切换，置顶真的落盘',
      passed:
        shown &&
        rightClicked &&
        byRight !== null &&
        hasAll &&
        notPinned &&
        buttonClicked &&
        byButton !== null &&
        sameItems(byRight, byButton) &&
        clickedPin &&
        pinnedStored &&
        nowUnpin,
      detail: `备忘行渲染=${shown}；右键=${rightClicked}；项=[${ids.join(',')}]；四项齐全=${hasAll}；未置顶时只有"置顶"=${notPinned}；⋯ 与右键一致=${byRight !== null && byButton !== null && sameItems(byRight, byButton)}；点置顶成功=${clickedPin} 已落盘=${pinnedStored}；再开菜单变成"取消置顶"=${nowUnpin}`
    })
  } catch (error) {
    record({
      id: 'P8-J7',
      prd: 'FEAT-001',
      name: '备忘：右键与 ⋯ 一致；置顶 / 取消置顶按状态切换，置顶真的落盘',
      passed: false,
      detail: `${String(error)}；${diagnostics()}`
    })
  }

  // ---- J8 资料 / 书：书详情的 ⋯ 与章节行的右键都能出菜单 ----
  try {
    const book = await evaluate<{ id: string }>(
      context,
      `window.api.data.add('reading', ${JSON.stringify({
        kind: 'book',
        title: `${marker} 右键之书`,
        author: '验收',
        format: 'paper',
        status: 'reading',
        totalPages: 200,
        currentPage: 10,
        percent: 0,
        finishedAt: null,
        rating: 0,
        review: ''
      })})`
    )
    const chapter = await evaluate<{ id: string }>(
      context,
      `window.api.data.add('reading', ${JSON.stringify({
        kind: 'node',
        ownerId: book.id,
        parentId: null,
        order: 0,
        title: `${marker} 右键之章`,
        done: false
      })})`
    )
    await evaluate(context, `window.api.data.flush()`)
    await wait(300)
    await openBookDetail(context, book.id)

    // ⚠️ 这里全程用 `closeMenu`（只关菜单）：书的详情本身是抽屉，
    // 章节行就在抽屉里，按 Esc 会把抽屉连同行一起关掉（已踩过）。
    const drawerShown = await untilTrue(context, `window.__verify.exists('reading-detail')`, 10, 200)
    if (!drawerShown) throw new Error('书详情抽屉没有打开，章节行不在页面上')

    // 书的 `⋯`
    await closeMenu(context)
    const bookButton = await clickMenuButton(context, 'reading-book-menu')
    const bookMenu = await waitForMenu(context)
    const bookIds = bookMenu?.ids ?? []
    const bookHasAll =
      bookIds.includes('book-edit') &&
      bookIds.includes('book-delete') &&
      bookIds.includes('book-measure') &&
      bookIds.includes('book-add-chapter')
    await closeMenu(context)

    // 章节行右键（顶层章：无祖先，直接就在界面上）
    const chapterSelector = `[data-testid="reading-tree-row"][data-node-id="${chapter.id}"]`
    const chapterShown = await untilTrue(context, `!!document.querySelector(${JSON.stringify(chapterSelector)})`, 12, 250)
    await closeMenu(context)
    const rightClicked = await rightClickSelector(context, chapterSelector)
    const chapterMenu = await waitForMenu(context)
    const chapterIds = chapterMenu?.ids ?? []
    const chapterHasAll =
      chapterIds.includes('node-add-child') &&
      chapterIds.includes('node-rename') &&
      chapterIds.includes('node-delete') &&
      chapterIds.includes('node-mark-done')
    await closeMenu(context)

    record({
      id: 'P8-J8',
      prd: 'FEAT-001',
      name: '资料 / 书：书卡详情的 ⋯ 与章节行右键都出菜单，项与定义一致',
      passed:
        bookButton &&
        bookMenu !== null &&
        bookHasAll &&
        chapterShown &&
        rightClicked &&
        chapterMenu !== null &&
        chapterHasAll,
      detail: `抽屉打开=${drawerShown}；书 ⋯=${bookButton}；书项=[${bookIds.join(',')}]；四项齐全=${bookHasAll}；章节行渲染=${chapterShown} 右键=${rightClicked}；章节项=[${chapterIds.join(',')}]；四项齐全=${chapterHasAll}`
    })
  } catch (error) {
    record({
      id: 'P8-J8',
      prd: 'FEAT-001',
      name: '资料 / 书：书卡详情的 ⋯ 与章节行右键都出菜单，项与定义一致',
      passed: false,
      detail: `${String(error)}；${diagnostics()}`
    })
  }

  // ---- J9 卡片：右键与 ⋯ 一致；"设置复习时间"真的改到期日 ----
  try {
    const cardFront = `${marker} 右键卡片`
    const created = await evaluate<{ id: string }>(
      context,
      `window.api.data.add('review', ${JSON.stringify({
        front: cardFront,
        back: '答案',
        source: '验收',
        stage: 0,
        dueDate: dateKey(new Date()),
        reviewCount: 0,
        lastReviewedAt: null
      })})`
    )
    await evaluate(context, `window.api.data.flush()`)
    await closeFloaters(context)
    await evaluate(context, `window.__verify.clickNav('review')`)
    await wait(500)

    const rowSelector = `[data-testid="review-card-row"][data-card-id="${created.id}"]`
    // 第 10 块：卡片行在主题的树里 —— 先把它所属的主题点开
    const shown = await revealReviewCardRow(context, created.id)
    await closeFloaters(context)
    const rightClicked = await rightClickSelector(context, rowSelector)
    const byRight = await waitForMenu(context)
    const ids = byRight?.ids ?? []
    const hasAll =
      ids.includes('card-edit') &&
      ids.includes('card-delete') &&
      ids.includes('card-view-history') &&
      ids.includes('card-review-3')
    await closeFloaters(context)

    const buttonClicked = await clickMenuButton(context, 'card-menu', rowSelector)
    const byButton = await waitForMenu(context)
    await closeFloaters(context)

    // 从菜单设"3 天后"复习
    await clickMenuButton(context, 'card-menu', rowSelector)
    await waitForMenu(context)
    const clickedReview3 = await clickMenuItem(context, 'card-review-3')
    await evaluate(context, `window.api.data.flush()`)
    await wait(600)
    const expected = addDaysToKey(dateKey(new Date()), 3)
    const records = await evaluate<Array<Record<string, unknown>>>(context, `window.api.data.listAlive('review')`)
    const dueAfter = String(records.find((item) => item['id'] === created.id)?.['dueDate'] ?? '')

    // 看历史：应留下一条说明（历史界面在 06 块）
    await closeFloaters(context)
    await clickMenuButton(context, 'card-menu', rowSelector)
    await waitForMenu(context)
    const clickedHistory = await clickMenuItem(context, 'card-view-history')
    const historyNotice = await untilTrue(context, `window.__verify.exists('review-history-notice')`, 8, 200)
    await closeFloaters(context)

    record({
      id: 'P8-J9',
      prd: 'FEAT-001',
      name: '卡片：右键与 ⋯ 一致；"设置复习时间"改到期日；"看历史"有回应',
      passed:
        shown &&
        rightClicked &&
        byRight !== null &&
        hasAll &&
        buttonClicked &&
        byButton !== null &&
        sameItems(byRight, byButton) &&
        clickedReview3 &&
        dueAfter === expected &&
        clickedHistory &&
        historyNotice,
      detail: `卡片行渲染=${shown}；右键=${rightClicked}；项=[${ids.join(',')}]；四项齐全=${hasAll}；⋯ 与右键一致=${byRight !== null && byButton !== null && sameItems(byRight, byButton)}；点"3 天后"=${clickedReview3} 落盘 dueDate=${dueAfter}（期望 ${expected}）；看历史有回应=${historyNotice}`
    })
  } catch (error) {
    record({
      id: 'P8-J9',
      prd: 'FEAT-001',
      name: '卡片：右键与 ⋯ 一致；"设置复习时间"改到期日；"看历史"有回应',
      passed: false,
      detail: `${String(error)}；${diagnostics()}`
    })
  }

  // ---- J10 边缘翻转：在窗口右下角右键，菜单必须整体落在窗口内 ----
  try {
    const taskTitle = `${marker} 角落任务`
    const created = await evaluate<{ id: string }>(
      context,
      `window.api.data.add('plan', ${JSON.stringify({
        title: taskTitle,
        date: dateKey(new Date()),
        timeSlot: 'none',
        recurrence: 'none',
        done: false,
        carriedOver: 0,
        doneAt: null
      })})`
    )
    await evaluate(context, `window.api.data.flush()`)
    await closeFloaters(context)
    await evaluate(context, `window.__verify.clickNav('plan')`)
    await wait(400)
    const rowSelector = `[data-testid="task-row"][data-task-id="${created.id}"]`
    await untilTrue(context, `!!document.querySelector(${JSON.stringify(rowSelector)})`, 12, 250)
    await closeFloaters(context)

    // 故意把触发点放在窗口右下角（真实场景：任务行就在底部）
    const corner = await evaluate<{ x: number; y: number }>(
      context,
      `({ x: window.innerWidth - 2, y: window.innerHeight - 2 })`
    )
    await rightClickSelector(context, rowSelector, corner)
    const menu = await waitForMenu(context)
    const inside = menu !== null && menuInsideViewport(menu)
    // 翻转的判据：菜单左边界明显小于触发点（说明翻到了左边）
    const flippedLeft = menu !== null && menu.left < corner.x - 20
    await closeFloaters(context)

    record({
      id: 'P8-J10',
      prd: 'FEAT-001',
      name: '靠近窗口右下角右键时菜单会翻转，整体仍在窗口内（点得到）',
      passed: menu !== null && inside && flippedLeft,
      detail: `触发点=(${corner.x},${corner.y})；菜单位置=(${menu?.left ?? -1},${menu?.top ?? -1})-(${menu?.right ?? -1},${menu?.bottom ?? -1})；视口=${menu?.viewportWidth ?? -1}×${menu?.viewportHeight ?? -1}；整体在窗口内=${inside}；向上/左翻转=${flippedLeft}`
    })
  } catch (error) {
    record({
      id: 'P8-J10',
      prd: 'FEAT-001',
      name: '靠近窗口右下角右键时菜单会翻转，整体仍在窗口内（点得到）',
      passed: false,
      detail: `${String(error)}；${diagnostics()}`
    })
  }

  // =========================================================================
  // 第 04 块：富文本接入（FEAT-002）
  //
  // 这一组盯的是 `docs\TASKS\04` §6.3 的六条 + §八 DoD：
  //   R1 五个正文类字段都换成富文本编辑器，工具条齐全
  //   R2 工具条加粗真的生效：落库是 rich，显示按 contentFormat 走
  //   R3 搜索不吃标签（搜正文命中；搜 `b` / `<` 不命中标签本身）
  //   R4 备忘"转任务"的标题是纯文本
  //   R5 富文本学习日志生成的复习卡正反面都是纯文本
  //   R6 链接只能存、不能点开（DOM 里没有 href，且有提示）
  //   R7 旧记录零改写（无 contentFormat 的按纯文本渲染，数据一个字节不动）
  //   R8 净化仍生效（script / onerror / javascript: 都拦得住）
  //
  // 每个检查都自己造样本、先复位，并只认带自己 marker 的记录。
  // =========================================================================
  const richMarker = `阶段8富文本（第${passNumber}趟）`

  /** 读某条富文本备忘的落库记录（验收只认自己造的那条） */
  const findMemo = async (keyword: string): Promise<Record<string, unknown> | null> => {
    const records = await evaluate<Array<Record<string, unknown>>>(
      context,
      `window.api.data.listAlive('memo')`
    )
    return records.find((item) => String(item['text'] ?? '').includes(keyword)) ?? null
  }

  /** 备忘页上某条备忘的显示块快照 */
  const memoDisplay = async (
    memoId: string
  ): Promise<{ display: RichDisplaySnapshot | null; found: boolean }> => {
    const display = await evaluate<RichDisplaySnapshot | null>(
      context,
      `(() => {
         const item = document.querySelector('[data-testid="memo-item"][data-memo-id=${JSON.stringify(memoId)}]')
         if (!item) return null
         const el = item.querySelector('[data-testid="memo-text"]')
         if (!el) return null
         const html = el.innerHTML
         return {
           text: (el.textContent || '').trim(),
           format: el.getAttribute('data-content-format') || '',
           hasLinks: el.getAttribute('data-has-links') === 'true',
           anchors: el.querySelectorAll('a[href]').length,
           hasHref: /\\shref\\s*=/.test(html),
           hasLinkHint: !!el.querySelector('.rich-text__link-hint')
         }
       })()`
    )
    return { display, found: display !== null }
  }

  // ---- R1 五个正文类字段都接上了富文本编辑器（工具条齐全） ----
  try {
    await injectRichHelpers(context)
    const TOOLS = ['bold', 'italic', 'underline', 'h2', 'ul', 'ol', 'quote', 'code', 'link']

    /** 读某个编辑器本体 + 工具条按钮（选择器在 TS 侧拼好再注入，避免字符串嵌套写错） */
    const readEditor = async (
      id: string
    ): Promise<{ editable: boolean; tools: string[] }> => {
      const editorSelector = JSON.stringify(`[data-testid="${id}"]`)
      const toolSelectors = JSON.stringify(
        Object.fromEntries(TOOLS.map((tool) => [tool, `[data-testid="${id}-${tool}"]`]))
      )
      return evaluate<{ editable: boolean; tools: string[] }>(
        context,
        `(() => {
           const el = document.querySelector(${editorSelector})
           const selectors = ${toolSelectors}
           const tools = Object.keys(selectors).filter((tool) => !!document.querySelector(selectors[tool]))
           return { editable: !!el && el.isContentEditable === true, tools }
         })()`
      )
    }

    // ① 备忘（新建输入区就在页面上）
    await closeFloaters(context)
    await evaluate(context, `window.__verify.clickNav('memo')`)
    await wait(400)
    const memoEditor = await readEditor('memo-input')

    // ② 学习日志（在"记一次学习"抽屉里；按钮只在选中主题后才渲染，所以先造一个主题并选中）
    await closeFloaters(context)
    const editorTopic = await evaluate<{ id: string }>(
      context,
      `window.api.data.add('learning', ${JSON.stringify({
        kind: 'topic',
        title: `${richMarker} 编辑器主题`,
        status: 'active',
        progress: 0
      })})`
    )
    await evaluate(context, `window.api.data.flush()`)
    await openLearningTopic(context, editorTopic.id)
    const studyButton = await evaluate<boolean>(
      context,
      `window.__verify.click('[data-testid="learning-log-study"]')`
    )
    const logDrawer = studyButton ? await untilTrue(context, `window.__verify.exists('learning-log-drawer')`, 10, 200) : false
    const logEditor = await readEditor('learning-log-content')
    await closeFloaters(context)

    // ③ 摘录（读书页书详情里）
    const excerptBook = await evaluate<{ id: string }>(
      context,
      `window.api.data.add('reading', ${JSON.stringify({
        kind: 'book',
        title: `${richMarker} 富文本书`,
        author: '验收',
        format: 'paper',
        status: 'reading',
        totalPages: 100,
        currentPage: 0,
        percent: 0,
        finishedAt: null,
        rating: 0,
        review: ''
      })})`
    )
    await evaluate(context, `window.api.data.flush()`)
    await openBookDetail(context, excerptBook.id)
    await untilTrue(context, `window.__verify.exists('reading-detail')`, 10, 200)
    // 第 11 块：摘录编辑器搬进了「加摘录」抽屉（中区那块卡片只列已有的摘录），
    // 所以要多点一下；断言（可编辑 + 工具条齐全）一条没动。
    const excerptClicked = await evaluate<boolean>(
      context,
      `window.__verify.click('[data-testid="reading-add-excerpt"]')`
    )
    const excerptDrawer = excerptClicked
      ? await untilTrue(context, `window.__verify.exists('reading-excerpt-drawer')`, 10, 200)
      : false
    const excerptEditor = await readEditor('reading-excerpt-input')

    // ④ 书籍总评（"标记读完"抽屉里）
    // ⚠️ 这里**不能**关浮层：书详情本身是抽屉，"标记读完"按钮就在它里面
    //（关一次就会把抽屉连按钮一起关掉，已踩过）。
    const finishClicked = await evaluate<boolean>(
      context,
      `window.__verify.click('[data-testid="reading-mark-finished"]')`
    )
    const finishDrawer = finishClicked
      ? await untilTrue(context, `window.__verify.exists('reading-finish-drawer')`, 10, 200)
      : false
    const reviewEditor = await readEditor('reading-finish-review')
    await closeFloaters(context)

    // ⑤ 任务备注（新建任务表单里）
    await evaluate(context, `window.__verify.clickNav('plan')`)
    await wait(400)
    const newTaskClicked = await evaluate<boolean>(
      context,
      `window.__verify.click('[data-testid="plan-new-task"]')`
    )
    const taskForm = newTaskClicked
      ? await untilTrue(context, `window.__verify.exists('task-form')`, 10, 200)
      : false
    const noteEditor = await readEditor('task-form-note')
    await closeFloaters(context)

    const allEditable =
      memoEditor.editable &&
      logEditor.editable &&
      excerptEditor.editable &&
      reviewEditor.editable &&
      noteEditor.editable
    const allTools =
      [memoEditor, logEditor, excerptEditor, reviewEditor, noteEditor].every(
        (editor) => editor.tools.length === TOOLS.length
      )

    record({
      id: 'P8-R1',
      prd: 'FEAT-002',
      name: '五个正文类字段（备忘 / 学习日志 / 摘录 / 书籍总评 / 任务备注）都是富文本编辑器，工具条齐全',
      passed: allEditable && allTools,
      detail: `备忘=${memoEditor.editable}/${memoEditor.tools.length}项；日志抽屉打开=${logDrawer} 编辑器=${logEditor.editable}/${logEditor.tools.length}项；摘录抽屉打开=${excerptDrawer} 编辑器=${excerptEditor.editable}/${excerptEditor.tools.length}项；总评抽屉打开=${finishDrawer} 编辑器=${reviewEditor.editable}/${reviewEditor.tools.length}项；任务表单打开=${taskForm} 备注=${noteEditor.editable}/${noteEditor.tools.length}项（工具条应有 ${TOOLS.length} 项）`
    })
  } catch (error) {
    record({
      id: 'P8-R1',
      prd: 'FEAT-002',
      name: '五个正文类字段（备忘 / 学习日志 / 摘录 / 书籍总评 / 任务备注）都是富文本编辑器，工具条齐全',
      passed: false,
      detail: `${String(error)}；${diagnostics()}`
    })
  }

  // ---- R2 工具条加粗真的生效：落库 rich、显示按 contentFormat 走 ----
  try {
    await injectRichHelpers(context)
    await closeFloaters(context)
    await evaluate(context, `window.__verify.clickNav('memo')`)
    await wait(400)

    const richText = `${richMarker} 加粗验收`
    // 先输入、再"全选 + 点工具条加粗"——这就是用户的真实操作顺序
    const typed = await setRichHtml(context, 'memo-input', richText)
    await wait(120)
    const boldClicked = await boldViaToolbar(context, 'memo-input')
    await wait(150)
    const editorHtml = await readRichHtml(context, 'memo-input')

    // Ctrl+回车保存
    await evaluate(
      context,
      `(() => {
         const el = window.__verify.byTestId('memo-input')
         el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true, bubbles: true }))
         return true
       })()`
    )
    await wait(700)
    await evaluate(context, `window.api.data.flush()`)

    const saved = await findMemo(richText)
    const savedText = String(saved?.['text'] ?? '')
    const savedPlain = saved === null ? '' : toPlainText(saved['text'], saved['contentFormat'])
    const boldInStore = /<(b|strong)>/i.test(savedText)

    // 页面上：这条备忘应该按富文本渲染，且**看不到标签**
    const rendered = saved === null ? { display: null, found: false } : await memoDisplay(String(saved['id']))
    const display = rendered.display

    record({
      id: 'P8-R2',
      prd: 'FEAT-002',
      name: '读：工具条加粗真的生效——落库是 rich（带 <b>），页面按 contentFormat 渲染且不露标签',
      passed:
        typed &&
        boldClicked &&
        saved !== null &&
        saved['contentFormat'] === 'rich' &&
        boldInStore &&
        savedPlain === richText &&
        display !== null &&
        display.format === 'rich' &&
        display.text === richText,
      detail: `输入=${typed} 点加粗=${boldClicked}；编辑器内容="${String(editorHtml)}"；落库="${savedText}"（格式=${String(saved?.['contentFormat'])}）；抽纯文本="${savedPlain}"；页面显示格式=${display?.format ?? '（没找到）'} 文字="${display?.text ?? ''}"`
    })
  } catch (error) {
    record({
      id: 'P8-R2',
      prd: 'FEAT-002',
      name: '读：工具条加粗真的生效——落库是 rich（带 <b>），页面按 contentFormat 渲染且不露标签',
      passed: false,
      detail: `${String(error)}；${diagnostics()}`
    })
  }

  // ---- R3 搜索不吃标签 ----
  try {
    await closeFloaters(context)
    /**
     * 搜一个关键词，返回备忘分组的命中标题 + 摘要。
     *
     * 两个坑（都踩过）：
     *   1. 搜索是**防抖**的（120ms + 一轮 IPC）。输入框一改，`term` 就非空了，
     *      而 `groups` 还是空的，于是摘要会**先**显示"没有找到匹配的内容"——
     *      这时候去读结果只会拿到空列表。所以必须"重试到出结果"，不能等一个固定延时。
     *   2. 关键词重复设置时 React 不会重跑，所以每轮都重新 set 一次（与 phase6 同一手法）。
     *
     * `expectNeedle` 给了就是"等到这条命中出现"；给 null 表示"确认它是真的搜不到"，
     * 这时要连续读到两次空结果才算数（第一次可能只是还没搜完）。
     */
    const runSearch = async (
      keyword: string,
      expectNeedle: string | null
    ): Promise<{ titles: string[]; summary: string; opened: boolean }> => {
      await evaluate(context, `window.__verify.key('Escape')`)
      await wait(250)
      await evaluate(context, `window.__verify.key('k', { ctrlKey: true })`)
      const opened = await untilTrue(context, `window.__verify.exists('search-drawer')`, 14, 200)
      let titles: string[] = []
      let summary = ''
      let emptyStreak = 0
      for (let attempt = 0; attempt < 10; attempt += 1) {
        await evaluate(context, `window.__verify.setText('search-input', ${JSON.stringify(keyword)})`)
        await wait(450)
        const read = await evaluate<{ titles: string[]; summary: string; hits: number }>(
          context,
          `(() => {
             const group = window.__verify.byTestId('search-group-memo')
             const titles = group
               ? Array.from(group.querySelectorAll('[data-testid="search-hit"]')).map(
                   (hit) => (hit.querySelector('.search__hit-title') || {}).textContent || '')
               : []
             return {
               titles,
               hits: document.querySelectorAll('[data-testid="search-hit"]').length,
               summary: ((window.__verify.byTestId('search-summary') || {}).textContent || '').trim()
             }
           })()`
        )
        titles = read.titles
        summary = read.summary
        if (expectNeedle !== null) {
          if (titles.some((title) => title.includes(expectNeedle))) break
        } else {
          emptyStreak = read.hits === 0 ? emptyStreak + 1 : 0
          if (emptyStreak >= 2) break
        }
      }
      return { titles, summary, opened }
    }

    const needle = `${richMarker} 加粗验收`
    const positive = await runSearch('加粗验收', needle)
    await evaluate(context, `window.__verify.key('Escape')`)
    await wait(200)

    const byTagName = await runSearch('b', null)
    await evaluate(context, `window.__verify.key('Escape')`)
    await wait(200)

    const byAngle = await runSearch('<', null)
    await evaluate(context, `window.__verify.key('Escape')`)
    await wait(200)

    const hitByText =
      positive.opened && positive.titles.some((title) => title.includes(needle) && !title.includes('<'))
    const noTagHit = !byTagName.titles.some((title) => title.includes('加粗验收'))
    const noAngleHit = !byAngle.titles.some((title) => title.includes('加粗验收'))

    record({
      id: 'P8-R3',
      prd: 'FEAT-002',
      name: '搜索不吃标签：搜正文命中且结果不带标签；搜标签名 / 尖括号不命中标签本身',
      passed: hitByText && noTagHit && noAngleHit,
      detail: `抽屉打开=${positive.opened}；搜"加粗验收"→[${positive.titles.join(' | ')}]（摘要="${positive.summary}"）；搜"b"→[${byTagName.titles.join(' | ')}]；搜"<"→[${byAngle.titles.join(' | ')}]；正文命中=${hitByText} 搜标签名不命中=${noTagHit} 搜尖括号不命中=${noAngleHit}`
    })
  } catch (error) {
    record({
      id: 'P8-R3',
      prd: 'FEAT-002',
      name: '搜索不吃标签：搜正文命中且结果不带标签；搜标签名 / 尖括号不命中标签本身',
      passed: false,
      detail: `${String(error)}；${diagnostics()}`
    })
  }

  // ---- R4 备忘"转任务"：标题是纯文本 ----
  try {
    await closeFloaters(context)
    await evaluate(context, `window.__verify.clickNav('memo')`)
    await wait(400)
    const target = await findMemo(richMarker)
    if (target === null) throw new Error('没有找到 R2 造的那条富文本备忘')
    const memoId = String(target['id'])
    const rowSelector = `[data-testid="memo-item"][data-memo-id="${memoId}"]`
    await untilTrue(context, `!!document.querySelector(${JSON.stringify(rowSelector)})`, 12, 250)
    await closeFloaters(context)

    const opened = await clickMenuButton(context, 'memo-menu', rowSelector)
    const menu = await waitForMenu(context)
    // 注意：`clickMenuItem` 自己会加上 `context-menu-` 前缀，这里传的是菜单项 id
    const clicked = await clickMenuItem(context, 'memo-to-plan')
    await wait(700)
    await evaluate(context, `window.api.data.flush()`)

    const planRecords = await evaluate<Array<Record<string, unknown>>>(
      context,
      `window.api.data.listAlive('plan')`
    )
    const expectedTitle = toPlainText(target['text'], target['contentFormat'])
    const created = planRecords.find((item) => item['title'] === expectedTitle)
    const leaked = planRecords.filter((item) => String(item['title'] ?? '').includes('<'))

    record({
      id: 'P8-R4',
      prd: 'FEAT-002',
      name: '备忘转任务：富文本备忘转出来的任务标题是纯文本，没有标签漏进计划',
      passed:
        opened &&
        menu !== null &&
        clicked &&
        created !== undefined &&
        expectedTitle !== '' &&
        leaked.length === 0,
      detail: `菜单项=[${(menu?.ids ?? []).join(',')}]；点了"转任务"=${clicked}；期望标题="${expectedTitle}"；找到新任务=${created !== undefined}；计划里带标签的标题 ${leaked.length} 条`
    })
  } catch (error) {
    record({
      id: 'P8-R4',
      prd: 'FEAT-002',
      name: '备忘转任务：富文本备忘转出来的任务标题是纯文本，没有标签漏进计划',
      passed: false,
      detail: `${String(error)}；${diagnostics()}`
    })
  }

  // ---- R5 富文本学习日志 → 复习卡：正反面都是纯文本 ----
  try {
    await closeFloaters(context)
    const logContent = `<p>${richMarker} 日志正文<b>粗体重点</b></p>`
    const topic = await evaluate<{ id: string }>(
      context,
      `window.api.data.add('learning', ${JSON.stringify({
        kind: 'topic',
        title: `${richMarker} 日志主题`,
        status: 'active',
        progress: 0
      })})`
    )
    await evaluate(
      context,
      `window.api.data.add('learning', ${JSON.stringify({
        kind: 'log',
        topicId: topic.id,
        date: dateKey(new Date()),
        minutes: 30,
        content: logContent,
        contentFormat: 'rich'
      })})`
    )
    await evaluate(context, `window.api.data.flush()`)

    await openLearningTopic(context, topic.id)
    const logRowShown = await untilTrue(
      context,
      `Array.from(document.querySelectorAll('[data-testid="learning-log"]')).some(
         (row) => (row.textContent || '').indexOf(${JSON.stringify(richMarker)}) >= 0)`,
      14,
      250
    )
    const before = await evaluate<number>(context, `window.api.data.listAlive('review').then((r) => r.length)`)

    // 点这条日志的"→ 复习"（只点带自己 marker 的那一行）
    const toReviewClicked = await evaluate<boolean>(
      context,
      `(() => {
         const rows = Array.from(document.querySelectorAll('[data-testid="learning-log"]'))
         const row = rows.find((item) => (item.textContent || '').indexOf(${JSON.stringify(richMarker)}) >= 0)
         if (!row) return false
         const button = row.querySelector('[data-testid="learning-log-to-review"]')
         if (!button) return false
         button.click()
         return true
       })()`
    )
    await wait(800)
    await evaluate(context, `window.api.data.flush()`)

    const cards = await evaluate<Array<Record<string, unknown>>>(
      context,
      `window.api.data.listAlive('review')`
    )
    const card = cards.find((item) => String(item['front'] ?? '').includes(`${richMarker} 日志正文`))
    const front = String(card?.['front'] ?? '')
    const back = String(card?.['back'] ?? '')

    record({
      id: 'P8-R5',
      prd: 'FEAT-002',
      name: '富文本学习日志生成的复习卡：正面背面都是纯文本，没有 <p> <b>',
      passed:
        logRowShown &&
        toReviewClicked &&
        cards.length === before + 1 &&
        card !== undefined &&
        !front.includes('<') &&
        !back.includes('<') &&
        front.includes('粗体重点'),
      detail: `日志行渲染=${logRowShown} 点了"→复习"=${toReviewClicked}；复习卡 ${before}→${cards.length} 张；新卡正面="${front.slice(0, 40)}" 背面="${back.slice(0, 40)}"`
    })
  } catch (error) {
    record({
      id: 'P8-R5',
      prd: 'FEAT-002',
      name: '富文本学习日志生成的复习卡：正面背面都是纯文本，没有 <p> <b>',
      passed: false,
      detail: `${String(error)}；${diagnostics()}`
    })
  }

  // ---- R6 链接只能存、不能点开 ----
  try {
    await closeFloaters(context)
    const linkText = `${richMarker} 链接验收`
    const linkUrl = 'https://example.com/only-stored'
    const created = await evaluate<{ id: string }>(
      context,
      `window.api.data.add('memo', ${JSON.stringify({
        text: `<p>${linkText} 看 <a href="${linkUrl}">这个链接</a></p>`,
        pinned: false,
        contentFormat: 'rich'
      })})`
    )
    await evaluate(context, `window.api.data.flush()`)
    await remountUntil(
      context,
      'memo',
      'home',
      `!!document.querySelector('[data-testid="memo-item"][data-memo-id="${created.id}"]')`
    )
    await closeFloaters(context)

    const { display } = await memoDisplay(created.id)
    // 落库那一份必须**保留** href（只存），显示那一份必须**没有** href（不点）
    const stored = await findMemo(linkText)
    const storedText = String(stored?.['text'] ?? '')

    record({
      id: 'P8-R6',
      prd: 'FEAT-002',
      name: '链接只存不点开：落库保留原 href，渲染出来的 DOM 里没有任何可跳转的 <a href>，并附提示',
      passed:
        display !== null &&
        display.format === 'rich' &&
        display.hasLinks &&
        display.anchors === 0 &&
        !display.hasHref &&
        display.hasLinkHint &&
        display.text.includes('这个链接') &&
        storedText.includes(`href="${linkUrl}"`),
      detail: `显示格式=${display?.format ?? ''} 有链接=${String(display?.hasLinks)} 可跳转 anchor=${String(display?.anchors)} 带 href=${String(display?.hasHref)} 有提示=${String(display?.hasLinkHint)}；显示文字="${display?.text ?? ''}"；落库仍保留原地址=${storedText.includes(`href="${linkUrl}"`)}`
    })
  } catch (error) {
    record({
      id: 'P8-R6',
      prd: 'FEAT-002',
      name: '链接只存不点开：落库保留原 href，渲染出来的 DOM 里没有任何可跳转的 <a href>，并附提示',
      passed: false,
      detail: `${String(error)}；${diagnostics()}`
    })
  }

  // ---- R7 旧记录零改写 ----
  try {
    await closeFloaters(context)
    const legacyText = '<b>看起来像标签</b>其实是纯文本'
    // 刻意**不写** contentFormat：这就是升级前的旧记录形状
    const created = await evaluate<{ id: string }>(
      context,
      `window.api.data.add('memo', ${JSON.stringify({ text: legacyText, pinned: false })})`
    )
    const legacyTask = await evaluate<{ id: string }>(
      context,
      `window.api.data.add('plan', ${JSON.stringify({
        title: `${richMarker} 旧备注任务`,
        date: dateKey(new Date()),
        timeSlot: 'none',
        recurrence: 'none',
        done: false,
        carriedOver: 0,
        doneAt: null,
        note: '旧备注：<i>这不是标签</i>'
      })})`
    )
    await evaluate(context, `window.api.data.flush()`)
    await wait(300)

    await remountUntil(
      context,
      'memo',
      'home',
      `!!document.querySelector('[data-testid="memo-item"][data-memo-id="${created.id}"]')`
    )
    const { display } = await memoDisplay(created.id)

    await remountUntil(
      context,
      'plan',
      'home',
      `!!document.querySelector('[data-testid="task-row"][data-task-id="${legacyTask.id}"]')`
    )
    const noteDisplay = await evaluate<RichDisplaySnapshot | null>(
      context,
      `(() => {
         const row = document.querySelector('[data-testid="task-row"][data-task-id=${JSON.stringify(legacyTask.id)}]')
         if (!row) return null
         const el = row.querySelector('[data-testid="task-note"]')
         if (!el) return null
         return {
           text: (el.textContent || '').trim(),
           format: el.getAttribute('data-content-format') || '',
           hasLinks: el.getAttribute('data-has-links') === 'true',
           anchors: el.querySelectorAll('a[href]').length,
           hasHref: /\\shref\\s*=/.test(el.innerHTML),
           hasLinkHint: !!el.querySelector('.rich-text__link-hint')
         }
       })()`
    )

    // 数据必须一个字节都没动：原样、且没有补上 contentFormat / noteFormat
    const records = await evaluate<Array<Record<string, unknown>>>(
      context,
      `window.api.data.listAlive('memo')`
    )
    const storedMemo = records.find((item) => item['id'] === created.id)
    const planRecords = await evaluate<Array<Record<string, unknown>>>(
      context,
      `window.api.data.listAlive('plan')`
    )
    const storedTask = planRecords.find((item) => item['id'] === legacyTask.id)

    record({
      id: 'P8-R7',
      prd: 'FEAT-002',
      name: '旧记录零改写：没有 contentFormat / noteFormat 的记录按纯文本渲染，数据一个字段都没被补上',
      passed:
        display !== null &&
        display.format === 'plain' &&
        display.text === legacyText &&
        storedMemo !== undefined &&
        storedMemo['text'] === legacyText &&
        !('contentFormat' in (storedMemo ?? {})) &&
        noteDisplay !== null &&
        noteDisplay.format === 'plain' &&
        noteDisplay.text === '旧备注：<i>这不是标签</i>' &&
        storedTask !== undefined &&
        !('noteFormat' in (storedTask ?? {})),
      detail: `备忘显示格式=${display?.format ?? '（没找到）'} 文字="${display?.text ?? ''}"；落库原文未变=${storedMemo?.['text'] === legacyText} 未被补 contentFormat=${!(storedMemo !== undefined && 'contentFormat' in storedMemo)}；任务备注格式=${noteDisplay?.format ?? '（没找到）'} 文字="${noteDisplay?.text ?? ''}" 未被补 noteFormat=${!(storedTask !== undefined && 'noteFormat' in storedTask)}`
    })
  } catch (error) {
    record({
      id: 'P8-R7',
      prd: 'FEAT-002',
      name: '旧记录零改写：没有 contentFormat / noteFormat 的记录按纯文本渲染，数据一个字段都没被补上',
      passed: false,
      detail: `${String(error)}；${diagnostics()}`
    })
  }

  // ---- R8 净化仍生效（走真实输入与真实保存） ----
  try {
    await injectRichHelpers(context)
    await closeFloaters(context)
    await evaluate(context, `window.__verify.clickNav('memo')`)
    await wait(400)

    const cleanText = `${richMarker} 净化验收`
    // 三段典型攻击面：脚本、事件属性、javascript: 链接
    const dirty = `<p>${cleanText}</p><script>alert('xss')</script><b onerror="alert('xss')">粗</b><a href="javascript:alert('xss')">点我</a>`
    const typed = await setRichHtml(context, 'memo-input', dirty)
    await wait(150)
    await evaluate(
      context,
      `(() => {
         const el = window.__verify.byTestId('memo-input')
         el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true, bubbles: true }))
         return true
       })()`
    )
    await wait(700)
    await evaluate(context, `window.api.data.flush()`)

    const saved = await findMemo(cleanText)
    const savedText = String(saved?.['text'] ?? '')
    const rendered = saved === null ? { display: null, found: false } : await memoDisplay(String(saved['id']))
    const displayHtml = await evaluate<string>(
      context,
      `(() => {
         const item = document.querySelector('[data-testid="memo-item"][data-memo-id=${JSON.stringify(String(saved?.['id'] ?? ''))}]')
         const el = item && item.querySelector('[data-testid="memo-text"]')
         return el ? el.innerHTML : ''
       })()`
    )

    const storeClean =
      !savedText.includes('script') && !savedText.includes('onerror') && !savedText.includes('javascript:')
    const domClean =
      !displayHtml.includes('script') && !/onerror\s*=/i.test(displayHtml) && !displayHtml.includes('javascript:')

    record({
      id: 'P8-R8',
      prd: 'FEAT-002',
      name: '净化仍生效：script / onerror / javascript: 在落库与渲染两处都拦得住',
      passed: typed && saved !== null && storeClean && domClean && rendered.display?.format === 'rich',
      detail: `输入=${typed}；落库="${savedText}"；渲染 DOM="${displayHtml}"；落库干净=${storeClean} 渲染干净=${domClean} 显示格式=${rendered.display?.format ?? '（没找到）'}`
    })
  } catch (error) {
    record({
      id: 'P8-R8',
      prd: 'FEAT-002',
      name: '净化仍生效：script / onerror / javascript: 在落库与渲染两处都拦得住',
      passed: false,
      detail: `${String(error)}；${diagnostics()}`
    })
  }

  // =========================================================================
  // K. 日历三档（第 05 块 · FEAT-003 / FEAT-005 / BUG-009）
  //
  // 编号说明：`docs\TASKS\05` 里写的是 P8-C1~C10，但 **P8-C1 在 02 块就已经用掉了**
  // （资料行就地改占比）。本块按"下一个可用字母"顺延成 **P8-K1~K10**，
  // 与块文件的对应关系写在交接记录里。
  // =========================================================================
  const calendarMarker = `阶段8日历（第${passNumber}趟）`
  const todayKey = dateKey(new Date())
  /** 每周从周几开始（读真实偏好，第 2 趟起会被改成周日开头） */
  const weekStartPreference: WeekStart = await effectiveWeekStart(context)
  /**
   * 本块造样本用的"一个月"：按趟错开，避免三趟之间互相污染。
   * （年视图按整月统计，正是最容易撞车的地方。）
   */
  const monthProbe = {
    year: yearOfKey(todayKey) + (passNumber - 1),
    month: 1
  }

  /** K1 / K2 共用：周视图的关键读数 */
  interface WeekSnapshot {
    columns: number
    dates: string[]
    todayColumn: string
    todayHighlighted: boolean
    todayBackground: string
    otherBackground: string
    hourLabels: number
    firstHour: string
    lastHour: string
    slotsPerColumn: number
    slotsOfToday: number[]
  }

  const weekSnapshotExpr = `(() => {
    const columns = Array.from(document.querySelectorAll('[data-testid="week-column"]'))
    const todayColumn = columns.find((el) => el.getAttribute('data-today') === 'true')
    const other = columns.find((el) => el.getAttribute('data-today') !== 'true')
    const labels = Array.from(document.querySelectorAll('[data-testid="week-hour-label"]'))
    const slots = todayColumn ? Array.from(todayColumn.querySelectorAll('[data-testid="week-slot"]')) : []
    return {
      columns: columns.length,
      dates: columns.map((el) => el.getAttribute('data-date') || ''),
      todayColumn: todayColumn ? todayColumn.getAttribute('data-date') || '' : '',
      todayHighlighted: !!todayColumn && todayColumn.className.indexOf('week__column--today') >= 0,
      todayBackground: todayColumn ? getComputedStyle(todayColumn).backgroundColor : '',
      otherBackground: other ? getComputedStyle(other).backgroundColor : '',
      hourLabels: labels.length,
      firstHour: labels.length > 0 ? (labels[0].textContent || '').trim() : '',
      lastHour: labels.length > 0 ? (labels[labels.length - 1].textContent || '').trim() : '',
      slotsPerColumn: slots.length,
      slotsOfToday: slots.map((el) => Number(el.getAttribute('data-hour')))
    }
  })()`

  // ---- K1 视图按钮五个：今天 / 本周 / 月 / 年 / 全部，且今天与全部仍是列表 ----
  try {
    await closeFloaters(context)
    await evaluate(context, `window.__verify.clickNav('plan')`)
    await wait(400)

    const chips = await evaluate<Array<{ id: string; label: string }>>(
      context,
      `Array.from(document.querySelectorAll('[data-testid^="plan-view-"]')).map((el) => ({
         id: (el.getAttribute('data-testid') || '').replace('plan-view-', ''),
         label: (el.textContent || '').trim()
       }))`
    )
    const chipLabels = chips.map((chip) => chip.label)
    const chipIds = chips.map((chip) => chip.id)
    const fiveChips =
      chipIds.join('|') === 'today|week|month|year|all' &&
      chipLabels.slice(0, 3).join('|') === '今天|本周|月' &&
      chipLabels.slice(3, 5).join('|') === '年|全部'

    // 月：切得过去，网格是真的（5~6 行 × 7 列；能 5 行就不留空行）
    const monthOk = await openPlanCalendar(context, 'month')
    const monthShape = await evaluate<{ weeks: number; cells: number }>(
      context,
      `({
         weeks: document.querySelectorAll('[data-testid="month-week"]').length,
         cells: document.querySelectorAll('[data-testid="month-cell"]').length
       })`
    )

    // 年：切得过去，12 个月
    const yearOk = await openPlanCalendar(context, 'year')
    const yearMonths = await evaluate<number>(
      context,
      `document.querySelectorAll('[data-testid="year-month"]').length`
    )

    // 今天 / 全部 仍然是原来的列表（日历不出现，分组列表在）
    const todayStillList = await openPlanList(context, 'today')
    const todayGroups = await evaluate<boolean>(
      context,
      `window.__verify.exists('group-today')`
    )
    const allStillList = await openPlanList(context, 'all')
    const allGroup = await evaluate<boolean>(context, `window.__verify.exists('group-all')`)

    record({
      id: 'P8-K1',
      prd: 'FEAT-003',
      name: '视图按钮是五个（今天/本周/月/年/全部）：月与年能切过去；今天/全部仍是原来的列表',
      passed:
        fiveChips &&
        monthOk &&
        monthShape.weeks >= 5 &&
        monthShape.weeks <= 6 &&
        monthShape.cells === monthShape.weeks * 7 &&
        yearOk &&
        yearMonths === 12 &&
        todayStillList &&
        todayGroups &&
        allStillList &&
        allGroup,
      detail: `按钮=${chipLabels.join('/')}（id=${chipIds.join('/')}）；月视图切换到=${monthOk} 行=${monthShape.weeks} 格=${monthShape.cells}（应为 5~6 行、每行 7 格）；年视图切换到=${yearOk} 月份数=${yearMonths}；今天仍是列表=${todayStillList && todayGroups}；全部仍是列表=${allStillList && allGroup}`
    })
  } catch (error) {
    record({
      id: 'P8-K1',
      prd: 'FEAT-003',
      name: '视图按钮是五个（今天/本周/月/年/全部）：月与年能切过去；今天/全部仍是原来的列表',
      passed: false,
      detail: `${String(error)}；${diagnostics()}`
    })
  }

  // ---- K2 周视图：7 列 + 今天列高亮 + 完整 24 小时行 ----
  let weekReady = false
  try {
    weekReady = await openPlanCalendar(context, 'week')
    if (!weekReady) throw new Error('周视图没有渲染出来')
    const snapshot = await evaluate<WeekSnapshot>(context, weekSnapshotExpr)
    const expectedDates = weekKeysFor(todayKey, weekStartPreference)
    const expectedDatesText = expectedDates.join('|')
    const hourNumbersOk =
      snapshot.slotsPerColumn === 24 &&
      snapshot.slotsOfToday.length === 24 &&
      snapshot.slotsOfToday.every((hour, index) => hour === index)

    record({
      id: 'P8-K2',
      prd: 'FEAT-003',
      name: '周视图显示 7 列、今天那列高亮、小时行是完整 24 行（00:00 ~ 23:00）',
      passed:
        snapshot.columns === 7 &&
        snapshot.dates.join('|') === expectedDatesText &&
        snapshot.todayColumn === todayKey &&
        snapshot.todayHighlighted &&
        snapshot.todayBackground !== snapshot.otherBackground &&
        snapshot.hourLabels === 24 &&
        snapshot.firstHour === '00:00' &&
        snapshot.lastHour === '23:00' &&
        hourNumbersOk,
      detail: `列数=${snapshot.columns}（${snapshot.dates[0]} … ${snapshot.dates[6]}，按 weekStart=${weekStartPreference} 期望 ${expectedDatesText}）；今天是哪列=${snapshot.todayColumn} 高亮=${snapshot.todayHighlighted} 底色今日=${snapshot.todayBackground} 其它=${snapshot.otherBackground}；小时标签=${snapshot.hourLabels} 行（${snapshot.firstHour} … ${snapshot.lastHour}）；今天那列的小时格=${snapshot.slotsPerColumn} 数据=${
        snapshot.slotsOfToday.length > 0
          ? `${snapshot.slotsOfToday[0]}…${snapshot.slotsOfToday[snapshot.slotsOfToday.length - 1]}`
          : '无'
      }`
    })
  } catch (error) {
    record({
      id: 'P8-K2',
      prd: 'FEAT-003',
      name: '周视图显示 7 列、今天那列高亮、小时行是完整 24 行（00:00 ~ 23:00）',
      passed: false,
      detail: `${String(error)}；${diagnostics()}`
    })
  }

  // ---- K3 有 startTime=10:00 的任务落在 10:00 那一行 ----
  let timedTaskId = ''
  try {
    timedTaskId = await addPlanSample(context, {
      title: `${calendarMarker} 十点开会`,
      date: todayKey,
      timeSlot: 'none',
      startTime: '10:00',
      endTime: '11:30',
      recurrence: 'none',
      done: false,
      carriedOver: 0,
      doneAt: null
    })
    if (!weekReady) {
      weekReady = await openPlanCalendar(context, 'week')
      if (!weekReady) throw new Error('周视图没有渲染出来')
    }
    const card = await until<{ hour: string; date: string; time: string } | null>(
      context,
      `(() => {
         const card = document.querySelector('[data-testid="week-card"][data-task-id="${timedTaskId}"]')
         if (!card) return null
         const slot = card.closest('[data-testid="week-slot"]')
         const column = card.closest('[data-testid="week-column"]')
         const time = card.querySelector('[data-testid="calendar-bar-time"]')
         return {
           hour: slot ? slot.getAttribute('data-hour') || '' : '',
           date: column ? column.getAttribute('data-date') || '' : '',
           time: time ? (time.textContent || '').trim() : ''
         }
       })()`,
      (value) => value !== null && value.hour !== '',
      14,
      250
    )
    // 顺带验 §5.3 的"点空白格子 → 在那个时间点新建任务（日期+时间预填好）"
    await evaluate(
      context,
      `(() => {
         const column = document.querySelector('[data-testid="week-column"][data-date="${todayKey}"]')
         const slot = column && column.querySelector('[data-testid="week-slot"][data-hour="14"]')
         if (!slot) return false
         slot.click()
         return true
       })()`
    )
    const slotForm = await until<{ opened: boolean; date: string; start: string } | null>(
      context,
      `(() => {
         if (!window.__verify.exists('task-form')) return null
         const date = window.__verify.byTestId('task-form-date')
         const start = window.__verify.byTestId('task-form-start')
         return {
           opened: true,
           date: date ? date.value : '',
           start: start ? start.value : ''
         }
       })()`,
      (value) => value !== null,
      10,
      200
    )
    await closeFloaters(context)

    record({
      id: 'P8-K3',
      prd: 'FEAT-003',
      name: '给任务设 startTime=10:00 之后，它出现在周视图 10:00 那一行；点空白小时格能在那个时间点新建（日期+时间预填）',
      passed:
        card !== null &&
        card.hour === '10' &&
        card.date === todayKey &&
        card.time === '10:00–11:30' &&
        slotForm !== null &&
        slotForm.date === todayKey &&
        slotForm.start === '14:00',
      detail: `任务 id=${timedTaskId.slice(0, 6)} 落在第 ${card?.hour ?? '（没找到）'} 行、日期 ${card?.date ?? ''}、条上时间="${card?.time ?? ''}"（期望 10 / ${todayKey} / 10:00–11:30）；点 14:00 的空白格 → 表单打开=${slotForm?.opened ?? false} 预填日期="${slotForm?.date ?? ''}" 预填开始="${slotForm?.start ?? ''}"（期望 ${todayKey} / 14:00）`
    })
  } catch (error) {
    record({
      id: 'P8-K3',
      prd: 'FEAT-003',
      name: '给任务设 startTime=10:00 之后，它出现在周视图 10:00 那一行（且不在"全天"行）',
      passed: false,
      detail: `${String(error)}；${diagnostics()}`
    })
  }

  // ---- K4 只有 timeSlot=morning 的任务落在"全天"行，并显示"上午" ----
  let slotTaskId = ''
  try {
    slotTaskId = await addPlanSample(context, {
      title: `${calendarMarker} 上午买菜`,
      date: todayKey,
      timeSlot: 'morning',
      recurrence: 'none',
      done: false,
      carriedOver: 0,
      doneAt: null
    })
    if (!weekReady) {
      weekReady = await openPlanCalendar(context, 'week')
      if (!weekReady) throw new Error('周视图没有渲染出来')
    }
    const card = await until<{ inAllday: boolean; date: string; time: string; inSlot: boolean } | null>(
      context,
      `(() => {
         const card = document.querySelector('[data-testid="week-card"][data-task-id="${slotTaskId}"]')
         if (!card) return null
         const allday = card.closest('[data-testid="week-allday"]')
         const slot = card.closest('[data-testid="week-slot"]')
         const time = card.querySelector('[data-testid="calendar-bar-time"]')
         return {
           inAllday: !!allday,
           date: allday ? allday.getAttribute('data-date') || '' : '',
           time: time ? (time.textContent || '').trim() : '',
           inSlot: !!slot
         }
       })()`,
      (value) => value !== null,
      14,
      250
    )
    record({
      id: 'P8-K4',
      prd: 'FEAT-003',
      name: '只有 timeSlot=morning 的任务落在周视图顶部的"全天"行，条上显示"上午"',
      passed:
        card !== null && card.inAllday && !card.inSlot && card.date === todayKey && card.time === '上午',
      detail: `任务 id=${slotTaskId.slice(0, 6)} 在全天行=${card?.inAllday ?? false} 在小时格=${card?.inSlot ?? false} 日期=${card?.date ?? ''} 条上时间="${card?.time ?? ''}"（期望 上午）`
    })
  } catch (error) {
    record({
      id: 'P8-K4',
      prd: 'FEAT-003',
      name: '只有 timeSlot=morning 的任务落在周视图顶部的"全天"行，条上显示"上午"',
      passed: false,
      detail: `${String(error)}；${diagnostics()}`
    })
  }

  // ---- K5 月视图：当天任务数 + 最多 3 条 +"还有 N 项…"可点进那一天 ----
  try {
    // 自带前提：今天造 5 条，另造 1 条在同月的另一天（用来验"点某天"）
    for (let index = 1; index <= 5; index += 1) {
      await addPlanSample(context, {
        title: `${calendarMarker} 月度样本${index}`,
        date: todayKey,
        timeSlot: 'none',
        recurrence: 'none',
        done: false,
        carriedOver: 0,
        doneAt: null
      })
    }
    // 同月里挑另一天：优先 1 号，1 号就是今天时用 2 号
    const otherDay =
      dayOfKey(todayKey) === 1
        ? addDaysToKey(todayKey, 1)
        : monthStartKey(yearOfKey(todayKey), monthOfKey(todayKey))
    const otherTaskId = await addPlanSample(context, {
      title: `${calendarMarker} 另一天`,
      date: otherDay,
      timeSlot: 'none',
      recurrence: 'none',
      done: false,
      carriedOver: 0,
      doneAt: null
    })

    const records = await planRecords(context)
    const expectedToday = expectedDayCount(records, todayKey)
    const expectedOther = expectedDayCount(records, otherDay)

    const monthOk = await openPlanCalendar(context, 'month')
    if (!monthOk) throw new Error('月视图没有渲染出来')

    const cell = await until<{
      count: string
      tasks: number
      more: string
      moreHidden: string
      hasTodayDot: boolean
    } | null>(
      context,
      `(() => {
         const cell = document.querySelector('[data-testid="month-cell"][data-date="${todayKey}"]')
         if (!cell) return null
         const count = cell.querySelector('[data-testid="month-cell-count"]')
         const more = cell.querySelector('[data-testid="month-more"]')
         return {
           count: count ? (count.textContent || '').trim() : '',
           tasks: cell.querySelectorAll('[data-testid="month-task"]').length,
           more: more ? (more.textContent || '').trim() : '',
           moreHidden: more ? more.getAttribute('data-hidden') || '' : '',
           hasTodayDot: !!cell.querySelector('[data-testid="month-today-dot"]')
         }
       })()`,
      (value) => value !== null && value.count !== '',
      12,
      250
    )
    if (cell === null) throw new Error('没找到今天那一格')

    const expectedHidden = Math.max(0, expectedToday - 3)
    const moreNumber = Number.parseInt((cell.more.match(/\d+/) ?? ['0'])[0] ?? '0', 10)
    const cellOk =
      cell.count === `${expectedToday} 项` &&
      cell.tasks === Math.min(expectedToday, 3) &&
      cell.hasTodayDot &&
      expectedHidden > 0 &&
      moreNumber === expectedHidden &&
      cell.moreHidden === String(expectedHidden)

    // 点"还有 N 项…"→ 切到那一天的"今天"列表
    await evaluate(context, `window.__verify.click('[data-testid="month-more"]')`)
    const jumped = await untilTrue(
      context,
      `!document.querySelector('[data-testid="calendar"]') && window.__verify.exists('group-today')`,
      10,
      200
    )
    const todayListHasSamples = await evaluate<number>(
      context,
      `(() => {
         const group = document.querySelector('[data-testid="group-today"]')
         if (!group) return 0
         return group.querySelectorAll('[data-testid="task-row"]').length
       })()`
    )
    const clickThrough = todayListHasSamples >= 5

    // 再点"某天"的日期号 → 切到那一天
    await openPlanCalendar(context, 'month')
    // 顺带验 §5.4 的"点空白处 → 在那天新建任务"
    await evaluate(
      context,
      `(() => {
         const cell = document.querySelector('[data-testid="month-cell"][data-date="${otherDay}"]')
         if (!cell) return false
         cell.click()
         return true
       })()`
    )
    const cellForm = await until<{ date: string } | null>(
      context,
      `(() => {
         if (!window.__verify.exists('task-form')) return null
         const date = window.__verify.byTestId('task-form-date')
         return { date: date ? date.value : '' }
       })()`,
      (value) => value !== null,
      10,
      200
    )
    await closeFloaters(context)
    await openPlanCalendar(context, 'month')
    await evaluate(
      context,
      `window.__verify.click('[data-testid="month-cell-day"][data-date="${otherDay}"]')`
    )
    const switched = await untilTrue(
      context,
      `!document.querySelector('[data-testid="calendar"]') && window.__verify.exists('group-today')`,
      10,
      200
    )
    const otherShown = await untilTrue(
      context,
      `!!document.querySelector('[data-testid="group-today"] [data-testid="task-row"][data-task-id="${otherTaskId}"]')`,
      8,
      200
    )
    const todaySamplesGone = await evaluate<boolean>(
      context,
      `!Array.from(document.querySelectorAll('[data-testid="group-today"] [data-testid="task-row"]')).some((row) => (row.textContent || '').indexOf(${JSON.stringify(`${calendarMarker} 月度样本`)}) >= 0)`
    )

    record({
      id: 'P8-K5',
      prd: 'FEAT-005',
      name: '月视图：格子里显示当天任务数、最多列 3 条，超额显示"还有 N 项…"且点了进那一天；点某天也能切过去；点空白处在那天新建',
      passed:
        cellOk &&
        jumped &&
        clickThrough &&
        switched &&
        otherShown &&
        todaySamplesGone &&
        cellForm?.date === otherDay &&
        expectedOther === 1,
      detail: `今天那格：数="${cell.count}"（数据里 ${expectedToday} 条）列了 ${cell.tasks} 条 圆点=${cell.hasTodayDot} "还有"="${cell.more}"（data-hidden=${cell.moreHidden}）点它切到列表=${jumped} 列表里样本行=${todayListHasSamples}；点 ${otherDay} 的日期号切过去=${switched} 该日任务出现=${otherShown} 今天的样本已不在这一组=${todaySamplesGone}；点 ${otherDay} 那格空白处新建的表单预填日期="${cellForm?.date ?? '（没打开）'}"`
    })
  } catch (error) {
    record({
      id: 'P8-K5',
      prd: 'FEAT-005',
      name: '月视图：格子里显示当天任务数、最多列 3 条，超额显示"还有 N 项…"且点了进那一天；点某天也能切过去；点空白处在那天新建',
      passed: false,
      detail: `${String(error)}；${diagnostics()}`
    })
  }

  // ---- K6 年视图：12 个月，每月同时有任务数与完成率，数字与数据一致 ----
  try {
    // 自带前提：在本趟专属的月份造 3 条（2 条完成），免得与其它趟/其它块的数据撞车
    const probeDates = [
      monthStartKey(monthProbe.year, monthProbe.month),
      addDaysToKey(monthStartKey(monthProbe.year, monthProbe.month), 1),
      addDaysToKey(monthStartKey(monthProbe.year, monthProbe.month), 2)
    ]
    for (const [index, probeDate] of probeDates.entries()) {
      await addPlanSample(context, {
        title: `${calendarMarker} 年度样本${index + 1}`,
        date: probeDate,
        timeSlot: 'none',
        recurrence: 'none',
        done: index < 2,
        carriedOver: 0,
        doneAt: index < 2 ? new Date().toISOString() : null
      })
    }

    // 跳到这个月再切年视图（日期选择器跳转也是 §5.1 的要求）
    const monthOk = await openPlanCalendar(context, 'month')
    if (!monthOk) throw new Error('月视图没有渲染出来')
    const jumpedValue = await setNativeValue(context, 'calendar-jump', probeDates[0] ?? todayKey)
    const anchored = await untilTrue(
      context,
      `(() => {
         const cell = document.querySelector('[data-testid="month-cell"][data-date="${probeDates[0] ?? todayKey}"][data-in-month="true"]')
         const cell2 = document.querySelector('[data-testid="month-cell"][data-date="${probeDates[0] ?? todayKey}"]')
         return !!cell || !!cell2
       })()`,
      8,
      200
    )

    const yearOk = await openPlanCalendar(context, 'year')
    if (!yearOk) throw new Error('年视图没有渲染出来')

    const months = await evaluate<
      Array<{ month: string; count: string; rate: string; bar: string; current: boolean }>
    >(
      context,
      `Array.from(document.querySelectorAll('[data-testid="year-month"]')).map((el) => {
         const count = el.querySelector('[data-testid="year-month-count"]')
         const rate = el.querySelector('[data-testid="year-month-rate"]')
         const bar = el.querySelector('[data-testid="year-month-bar"]')
         return {
           month: el.getAttribute('data-month') || '',
           count: count ? (count.textContent || '').trim() : '',
           rate: rate ? (rate.textContent || '').trim() : '',
           bar: bar ? (bar.getAttribute('style') || '') : '',
           current: el.getAttribute('data-current') === 'true'
         }
       })`
    )

    const records = await planRecords(context)
    const mismatches: string[] = []
    for (const entry of months) {
      const monthNumber = Number.parseInt(entry.month, 10)
      const expected = expectedMonthStats(records, monthProbe.year, monthNumber)
      const countOk = entry.count === `${expected.total} 项`
      const rateOk = entry.rate === `完成率 ${expected.rate}%`
      const barOk = entry.bar.includes(`width: ${expected.rate}%`)
      if (!countOk || !rateOk || !barOk || monthNumber !== Number(entry.month)) {
        mismatches.push(
          `${entry.month}月: 界面"${entry.count}"/"${entry.rate}"/条宽"${entry.bar}" 期望 ${expected.total} 项 / ${expected.rate}%`
        )
      }
    }
    const currentCount = months.filter((entry) => entry.current).length
    /**
     * "当前月高亮"只在**看的这一年就是今年**时成立：
     * 本检查会跳到别的年份，那时一个高亮都不该有（0 个），今年则必须正好 1 个。
     * 这样既验了高亮，又不让断言依赖"今天到底是哪个月"。
     */
    const shownTitle = await evaluate<string>(
      context,
      `((window.__verify.byTestId('calendar-title') || {}).textContent || '').trim()`
    )
    const showingCurrentYear = shownTitle.includes('今年')
    const highlightOk = showingCurrentYear ? currentCount === 1 : currentCount === 0
    const probeMonth = months.find((entry) => entry.month === String(monthProbe.month))
    const probeExpected = expectedMonthStats(records, monthProbe.year, monthProbe.month)

    record({
      id: 'P8-K6',
      prd: 'FEAT-005',
      name: '年视图显示 12 个月，每月**同时**有任务数与完成率两个数，且两个数都与数据一致（进度条＝完成率）',
      passed:
        months.length === 12 &&
        mismatches.length === 0 &&
        highlightOk &&
        probeExpected.total === 3 &&
        probeExpected.rate === 67 &&
        probeMonth?.count === '3 项' &&
        probeMonth?.rate === '完成率 67%' &&
        jumpedValue === (probeDates[0] ?? todayKey) &&
        anchored,
      detail: `月份数=${months.length}；标题="${shownTitle}" 当前月高亮=${currentCount} 个（${showingCurrentYear ? '今年应为 1' : '非今年应为 0'}）；本趟样本月 ${monthProbe.year}-${monthProbe.month}：界面"${probeMonth?.count ?? ''}"/"${probeMonth?.rate ?? ''}"（期望 3 项 / 67%，2 完成 3 总数）；与数据不符的月份=${mismatches.length === 0 ? '无' : mismatches.join(' ; ')}；日期跳转=${anchored}（写入 ${jumpedValue}）`
    })
  } catch (error) {
    record({
      id: 'P8-K6',
      prd: 'FEAT-005',
      name: '年视图显示 12 个月，每月**同时**有任务数与完成率两个数，且两个数都与数据一致（进度条＝完成率）',
      passed: false,
      detail: `${String(error)}；${diagnostics()}`
    })
  }

  // ---- K7 翻页：周 / 月 / 年 各三颗按钮 ----
  try {
    /** 读导航条标题与（周视图时的）列日期 */
    const navSnapshot = async (): Promise<{ title: string; first: string; last: string; mode: string }> =>
      evaluate<{ title: string; first: string; last: string; mode: string }>(
        context,
        `(() => {
           const title = document.querySelector('[data-testid="calendar-title"]')
           const calendar = document.querySelector('[data-testid="calendar"]')
           const columns = Array.from(document.querySelectorAll('[data-testid="week-column"]'))
           return {
             title: title ? (title.textContent || '').trim() : '',
             first: columns.length > 0 ? columns[0].getAttribute('data-date') || '' : '',
             last: columns.length > 0 ? columns[columns.length - 1].getAttribute('data-date') || '' : '',
             mode: calendar ? calendar.getAttribute('data-mode') || '' : ''
           }
         })()`
      )

    const clickCalendar = async (testId: string): Promise<void> => {
      await evaluate(context, `window.__verify.click('[data-testid="${testId}"]')`)
      await wait(250)
    }

    // --- 周：上一周 / 下一周 / 回到本周 ---
    const weekOk = await openPlanCalendar(context, 'week')
    if (!weekOk) throw new Error('周视图没有渲染出来')
    // 先复位（硬规矩第 3 条）：锚点可能还停在上一条检查跳到的日子上，
    // 直接量"本周"会量到别的周，症状是看起来像翻页坏了
    await clickCalendar('calendar-today')
    const weekBefore = await navSnapshot()
    await clickCalendar('calendar-prev')
    const weekPrev = await navSnapshot()
    await clickCalendar('calendar-next')
    const weekNext = await navSnapshot()
    await clickCalendar('calendar-prev')
    await clickCalendar('calendar-prev')
    const weekPrev2 = await navSnapshot()
    await clickCalendar('calendar-today')
    const weekBack = await navSnapshot()
    const weekPassed =
      weekBefore.title.includes('本周') &&
      !weekPrev.title.includes('本周') &&
      weekPrev.first === addDaysToKey(weekBefore.first, -7) &&
      weekNext.first === weekBefore.first &&
      weekPrev2.first === addDaysToKey(weekBefore.first, -14) &&
      weekBack.first === weekBefore.first &&
      weekBack.title === weekBefore.title

    // --- 月：上一月 / 下一月 / 回到本月 ---
    const monthOk = await openPlanCalendar(context, 'month')
    if (!monthOk) throw new Error('月视图没有渲染出来')
    await clickCalendar('calendar-today')
    const monthBefore = await navSnapshot()
    await clickCalendar('calendar-prev')
    const monthPrev = await navSnapshot()
    await clickCalendar('calendar-next')
    const monthNext = await navSnapshot()
    await clickCalendar('calendar-prev')
    await clickCalendar('calendar-today')
    const monthBack = await navSnapshot()
    const monthPassed =
      monthBefore.title.includes('本月') &&
      monthPrev.title !== monthBefore.title &&
      monthNext.title === monthBefore.title &&
      monthBack.title === monthBefore.title

    // --- 年：上一年 / 下一年 / 回到今年 ---
    const yearOk = await openPlanCalendar(context, 'year')
    if (!yearOk) throw new Error('年视图没有渲染出来')
    await clickCalendar('calendar-today')
    const yearBefore = await navSnapshot()
    await clickCalendar('calendar-prev')
    const yearPrev = await navSnapshot()
    await clickCalendar('calendar-next')
    const yearNext = await navSnapshot()
    await clickCalendar('calendar-next')
    await clickCalendar('calendar-today')
    const yearBack = await navSnapshot()
    const yearPassed =
      yearBefore.title.includes('今年') &&
      yearPrev.title !== yearBefore.title &&
      yearNext.title === yearBefore.title &&
      yearBack.title === yearBefore.title

    // 三颗按钮的文案也要跟着档位变
    const labels = await evaluate<{ prev: string; next: string; back: string }>(
      context,
      `(() => {
         const read = (id) => {
           const el = document.querySelector('[data-testid="' + id + '"]')
           return el ? (el.textContent || '').trim() : ''
         }
         return { prev: read('calendar-prev'), next: read('calendar-next'), back: read('calendar-today') }
       })()`
    )

    record({
      id: 'P8-K7',
      prd: 'BUG-009',
      name: '翻页齐全：周（上一周/下一周/回到本周）、月（上一月/下一月/回到本月）、年（上一年/下一年/回到今年）',
      passed:
        weekPassed &&
        monthPassed &&
        yearPassed &&
        labels.prev === '上一年' &&
        labels.next === '下一年' &&
        labels.back === '回到今年',
      detail: `周：${weekBefore.title} → ${weekPrev.title} → ${weekNext.title} → ${weekBack.title}（列首日 ${weekBefore.first} → ${weekPrev.first} → ${weekNext.first} → ${weekBack.first}，每次正好 ±7 天=${weekPassed}）；月：${monthBefore.title} → ${monthPrev.title} → ${monthNext.title} → ${monthBack.title}（${monthPassed}）；年：${yearBefore.title} → ${yearPrev.title} → ${yearNext.title} → ${yearBack.title}（${yearPassed}）；年档按钮文案=${labels.prev}/${labels.next}/${labels.back}`
    })
  } catch (error) {
    record({
      id: 'P8-K7',
      prd: 'BUG-009',
      name: '翻页齐全：周（上一周/下一周/回到本周）、月（上一月/下一月/回到本月）、年（上一年/下一年/回到今年）',
      passed: false,
      detail: `${String(error)}；${diagnostics()}`
    })
  }

  // ---- K8 endTime 早于 startTime 时被拒绝（表单里给提示） ----
  try {
    await closeFloaters(context)
    await evaluate(context, `window.__verify.clickNav('plan')`)
    await wait(300)
    await openPlanList(context, 'today')

    const invalidTitle = `${calendarMarker} 时间颠倒`
    await evaluate(context, `window.__verify.click('[data-testid="plan-new-task"]')`)
    const formOpen = await untilTrue(context, `window.__verify.exists('task-form')`, 10, 200)
    if (!formOpen) throw new Error('新建任务表单没有打开')

    await setNativeValue(context, 'task-form-title', invalidTitle)
    await setNativeValue(context, 'task-form-date', todayKey)
    await setNativeValue(context, 'task-form-start', '11:00')
    await setNativeValue(context, 'task-form-end', '10:00')
    await evaluate(context, `window.__verify.click('[data-testid="task-form-submit"]')`)

    const errorText = await until<string>(
      context,
      `((window.__verify.byTestId('task-form-error') || {}).textContent || '').trim()`,
      (text) => text !== '',
      12,
      250
    )
    const stillOpen = await evaluate<boolean>(context, `window.__verify.exists('task-form')`)
    const storedAfterReject = await planRecords(context)
    const notSaved = !storedAfterReject.some((record) => record['title'] === invalidTitle)

    // 改成合法区间：必须能存下去（证明不是"一概拒绝"）
    await setNativeValue(context, 'task-form-end', '12:30')
    await evaluate(context, `window.__verify.click('[data-testid="task-form-submit"]')`)
    const closed = await untilTrue(context, `!window.__verify.exists('task-form')`, 12, 250)
    await evaluate(context, `window.api.data.flush()`)
    await wait(300)
    const storedAfterFix = await planRecords(context)
    const saved = storedAfterFix.find((record) => record['title'] === invalidTitle)

    record({
      id: 'P8-K8',
      prd: 'FEAT-003',
      name: 'endTime 早于 startTime 时被拒绝：表单给出提示且不落库；改成合法区间后能存下',
      passed:
        formOpen &&
        errorText !== null &&
        errorText.includes('结束时间必须晚于开始时间') &&
        stillOpen &&
        notSaved &&
        closed &&
        saved?.['startTime'] === '11:00' &&
        saved?.['endTime'] === '12:30',
      detail: `表单打开=${formOpen}；错误提示="${errorText ?? '（没有）'}"；表单仍开着=${stillOpen} 没落库=${notSaved}；改成 11:00–12:30 后保存=${closed} 落库=${String(saved?.['startTime'])}–${String(saved?.['endTime'])}`
    })
  } catch (error) {
    record({
      id: 'P8-K8',
      prd: 'FEAT-003',
      name: 'endTime 早于 startTime 时被拒绝：表单给出提示且不落库；改成合法区间后能存下',
      passed: false,
      detail: `${String(error)}；${diagnostics()}`
    })
  }

  // ---- K9 日历主体内部滚动；页面无滚动条；打开时滚到 08:00 附近 ----
  try {
    const weekOk = await openPlanCalendar(context, 'week')
    if (!weekOk) throw new Error('周视图没有渲染出来')
    const scroll = await until<{
      scrollHeight: number
      clientHeight: number
      scrollTop: number
      overflowY: string
      pageScrollHeight: number
      pageClientHeight: number
      devicePage: string
    } | null>(
      context,
      `(() => {
         const body = document.querySelector('[data-testid="calendar-week-scroll"]')
         if (!body) return null
         const doc = document.scrollingElement
         const style = getComputedStyle(body)
         return {
           scrollHeight: body.scrollHeight,
           clientHeight: body.clientHeight,
           scrollTop: body.scrollTop,
           overflowY: style.overflowY,
           pageScrollHeight: doc ? doc.scrollHeight : -1,
           pageClientHeight: doc ? doc.clientHeight : -1,
           devicePage: doc ? doc.tagName : ''
         }
       })()`,
      (value) => value !== null,
      10,
      200
    )
    if (scroll === null) throw new Error('找不到周视图的滚动容器')

    /** 打开时滚到 08:00 附近允许的误差：一格以内（44px）还多一点余量 */
    const nearEight = Math.abs(scroll.scrollTop - 8 * 44) <= 60
    const pageNoOverflow = scroll.pageScrollHeight <= scroll.pageClientHeight + 1

    record({
      id: 'P8-K9',
      prd: 'FEAT-003',
      name: '日历主体内部滚动（页面级无滚动条），周视图打开时自动滚到 08:00 附近',
      passed:
        scroll.scrollHeight > scroll.clientHeight &&
        (scroll.overflowY === 'auto' || scroll.overflowY === 'scroll') &&
        nearEight &&
        pageNoOverflow,
      detail: `滚动容器 内容高=${scroll.scrollHeight} 可视高=${scroll.clientHeight} overflow=${scroll.overflowY}；打开时 scrollTop=${scroll.scrollTop}（期望≈352，即 08:00）；页面滚动元素（${scroll.devicePage}）内容高=${scroll.pageScrollHeight} 可视高=${scroll.pageClientHeight} 无溢出=${pageNoOverflow}`
    })
  } catch (error) {
    record({
      id: 'P8-K9',
      prd: 'FEAT-003',
      name: '日历主体内部滚动（页面级无滚动条），周视图打开时自动滚到 08:00 附近',
      passed: false,
      detail: `${String(error)}；${diagnostics()}`
    })
  }

  // ---- K10 复习的到期卡片不出现在日历上（决定 21 的反向验证） ----
  try {
    const reviewFront = `${calendarMarker} 复习卡不该上日历`
    const createdCard = await evaluate<{ id: string }>(
      context,
      `window.api.data.add('review', ${JSON.stringify({
        front: reviewFront,
        back: '答案',
        source: `${calendarMarker} 主题`,
        stage: 0,
        dueDate: todayKey,
        reviewCount: 0,
        lastReviewedAt: null
      })})`
    )
    await evaluate(context, `window.api.data.flush()`)
    await wait(300)

    const weekOk = await openPlanCalendar(context, 'week')
    if (!weekOk) throw new Error('周视图没有渲染出来')
    const inWeek = await evaluate<boolean>(
      context,
      `(() => {
         const calendar = document.querySelector('[data-testid="calendar"]')
         if (!calendar) return true
         return (calendar.textContent || '').indexOf(${JSON.stringify(reviewFront)}) >= 0
       })()`
    )
    const monthOk = await openPlanCalendar(context, 'month')
    if (!monthOk) throw new Error('月视图没有渲染出来')
    const inMonth = await evaluate<boolean>(
      context,
      `(() => {
         const calendar = document.querySelector('[data-testid="calendar"]')
         if (!calendar) return true
         return (calendar.textContent || '').indexOf(${JSON.stringify(reviewFront)}) >= 0
       })()`
    )

    // 反向确认：这张卡确实存在、且真的到期（否则"日历上没有"可能是假阳性）
    await evaluate(context, `window.__verify.clickNav('review')`)
    await wait(500)
    // 第 10 块：卡片行在主题的树里 —— 先把它所属的主题点开
    const cardExists = await revealReviewCardRow(context, createdCard.id)
    const dueTotal = await evaluate<string>(
      context,
      `((window.__verify.byTestId('review-summary-total') || {}).textContent || '').trim()`
    )

    record({
      id: 'P8-K10',
      prd: '决定21',
      name: '复习的到期卡片不出现在日历上（日历只管计划任务）；同时确认这张卡确实存在且到期',
      passed: inWeek === false && inMonth === false && cardExists && dueTotal.includes('张'),
      detail: `卡片「${reviewFront}」在周视图出现=${inWeek} 在月视图出现=${inMonth}（都该是 false）；这张卡在复习页存在=${cardExists}；复习页汇总横条="${dueTotal}"`
    })
  } catch (error) {
    record({
      id: 'P8-K10',
      prd: '决定21',
      name: '复习的到期卡片不出现在日历上（日历只管计划任务）；同时确认这张卡确实存在且到期',
      passed: false,
      detail: `${String(error)}；${diagnostics()}`
    })
  }

  // =========================================================================
  // 第 06 块：复习增强（FEAT-007 / BUG-008 / 决定 18）+ 备忘标签（FEAT-004）
  //          + 快捷键（FEAT-008：N / T / 可改可重置可查冲突）
  //
  // 硬规矩照旧：轮询等待、自带前提、先复位再操作、受控组件用原生 setter。
  // 样本一律带 `${hotkeyMarker}` 前缀，断言只认自己造的那几条；
  // 快捷键一律按**当前真实绑定值**去按（设置页会被改过）。
  // =========================================================================
  const hotkeyMarker = `${marker} 06`

  // ---- L1 复习时间可手动设置：dueTime 落库、行上看得见、能改回空 ----
  let manualCardId = ''
  try {
    await closeFloaters(context)
    await evaluate(context, `window.__verify.clickNav('review')`)
    await wait(400)
    // 先复位：退出可能存在的会话，免得"今天到期 N 张"的读数含会话状态
    await pressKeyOn(context, 'Escape')
    await wait(200)

    const front = `${hotkeyMarker} 手动定时`
    await evaluate(context, `window.__verify.click('[data-testid="review-new-card"]')`)
    const formOpen = await untilTrue(context, `window.__verify.exists('review-form')`, 12, 200)
    if (!formOpen) throw new Error('新建复习卡表单没有打开')

    await setNativeValue(context, 'review-form-front', front)
    await setNativeValue(context, 'review-form-back', '手动定时的答案')
    await setNativeValue(context, 'review-form-due', todayKey)
    const dueTimeInput = await setNativeValue(context, 'review-form-due-time', '23:30')
    await evaluate(context, `window.__verify.click('[data-testid="review-form-submit"]')`)
    const formClosed = await untilTrue(context, `!window.__verify.exists('review-form')`, 12, 250)
    await evaluate(context, `window.api.data.flush()`)

    const cardsAfterCreate = await reviewCards(context)
    const created = cardsAfterCreate.find((card) => String(card['front'] ?? '') === front)
    manualCardId = String(created?.['id'] ?? '')
    const rowSelector = `[data-testid="review-card-row"][data-card-id="${manualCardId}"]`
    // 第 10 块：手写的卡按来源自成"来源档"主题 —— 先把那一档点开再找行
    const rowShown = manualCardId !== '' ? await revealReviewCardRow(context, manualCardId) : false
    const row = rowShown ? await cardRowSnapshot(context, manualCardId) : null

    /**
     * "保存后按设定时间进到期队列"：
     * 汇总横条的 `data-due` 必须等于**按数据算出来的**今天到期张数
     * （直接写死一个数字在第二趟必红——前面几趟的卡片一直在）。
     */
    const asCards = cardsAfterCreate
      .map((item) => normalizeReviewCard(item))
      .filter((item): item is ReviewCard => item !== null)
    const expectedDue = dueQueue(asCards, todayKey).length
    const summaryDue = await until<number>(
      context,
      `Number((window.__verify.byTestId('review-summary') || { getAttribute: () => '0' }).getAttribute('data-due'))`,
      (value) => value === expectedDue,
      10,
      200
    )

    // 改一次：把时间清空 → 落库必须真的清掉（写 null，而不是"没提这件事"）
    await closeFloaters(context)
    await clickMenuButton(context, 'card-menu', rowSelector)
    await waitForMenu(context)
    const editClicked = await clickMenuItem(context, 'card-edit')
    const editOpen = await untilTrue(context, `window.__verify.exists('review-form')`, 10, 200)
    await setNativeValue(context, 'review-form-due-time', '')
    await evaluate(context, `window.__verify.click('[data-testid="review-form-submit"]')`)
    const editClosed = await untilTrue(context, `!window.__verify.exists('review-form')`, 12, 250)
    await evaluate(context, `window.api.data.flush()`)
    await wait(400)
    const afterEdit = await reviewCards(context)
    const cleared = afterEdit.find((card) => card['id'] === manualCardId)
    const rowAfter = await cardRowSnapshot(context, manualCardId)

    record({
      id: 'P8-L1',
      prd: 'FEAT-007',
      name: '复习时间可手动设置：卡片表单能填 dueTime，落库并显示在行上；改成空之后真的被清掉；到期的卡进今天队列',
      passed:
        formOpen &&
        formClosed &&
        dueTimeInput === '23:30' &&
        rowShown &&
        created?.['dueDate'] === todayKey &&
        created?.['dueTime'] === '23:30' &&
        row?.dueTime === '23:30' &&
        (row?.text ?? '').includes('23:30') &&
        summaryDue === expectedDue &&
        editClicked &&
        editOpen &&
        editClosed &&
        (cleared?.['dueTime'] === undefined || cleared?.['dueTime'] === null) &&
        rowAfter?.dueTime === '',
      detail: `表单打开=${formOpen} 提交后关闭=${formClosed} dueTime 输入=${dueTimeInput}；落库 dueDate=${String(created?.['dueDate'])} dueTime=${String(created?.['dueTime'])}；行上 due-time="${row?.dueTime ?? '（没找到行）'}" 行文本含 23:30=${(row?.text ?? '').includes('23:30')}；汇总横条 data-due=${summaryDue ?? '（没等到）'}（按数据算 ${expectedDue}）；菜单里点"编辑"=${editClicked} 表单打开=${editOpen} 清空后关闭=${editClosed}；清空后落库 dueTime=${String(cleared?.['dueTime'])} 行上="${rowAfter?.dueTime ?? ''}"`
    })
  } catch (error) {
    record({
      id: 'P8-L1',
      prd: 'FEAT-007',
      name: '复习时间可手动设置：卡片表单能填 dueTime，落库并显示在行上；改成空之后真的被清掉；到期的卡进今天队列',
      passed: false,
      detail: `${String(error)}；${diagnostics()}`
    })
  }

  // ---- L2 复习历史：评分后落一条 kind:'history'，历史分区能查到内容/答案/时间/评分 ----
  let historyCardId = ''
  try {
    await openReviewIdle(context)
    const front = `${hotkeyMarker} 历史样本`
    const back = '历史样本答案'
    historyCardId = await addReviewCard(context, {
      front,
      back,
      source: hotkeyMarker,
      stage: 1,
      dueDate: todayKey,
      reviewCount: 2,
      lastReviewedAt: null
    })
    // 第 10 块：卡片行在"当前主题"的树里 —— 先点开它所属的主题
    const shown = await revealReviewCardRow(context, historyCardId)
    const expanded = await expandCardRow(context, historyCardId)
    const revealClicked = await evaluate<boolean>(
      context,
      `(() => {
         const button = document.querySelector('[data-testid="inline-card-reveal"]')
         if (!button) return false
         button.click()
         return true
       })()`
    )
    const gradeButtons = await until<number>(
      context,
      `document.querySelectorAll('[data-testid^="inline-grade-"]').length`,
      (count) => count === 3,
      10,
      200
    )
    const gradeClicked = await evaluate<boolean>(
      context,
      `(() => {
         const button = document.querySelector('[data-testid="inline-grade-remembered"]')
         if (!button) return false
         button.click()
         return true
       })()`
    )

    // 历史落库（自带前提：等自己这张卡的历史出现，不等"总共有几条"）
    const stored = await until<Array<Record<string, unknown>>>(
      context,
      `window.api.data.listAlive('review')`,
      (records) =>
        records.some(
          (item) => item['kind'] === 'history' && String(item['cardId'] ?? '') === historyCardId
        ),
      16,
      250
    )
    await evaluate(context, `window.api.data.flush()`)
    const historyList = await reviewHistories(context, historyCardId)
    const entry = historyList[0]
    const fieldsOk =
      entry !== undefined &&
      typeof entry['at'] === 'string' &&
      String(entry['at']) !== '' &&
      entry['grade'] === 'remembered' &&
      entry['stageBefore'] === 1 &&
      entry['stageAfter'] === 2 &&
      typeof entry['dueDateAfter'] === 'string' &&
      String(entry['dueDateAfter']) !== ''

    // 界面：历史分区里有一行是这张卡的，内容 / 答案 / 时间 / 当时评分都在
    const uiRow = await until<{
      count: number
      grade: string
      front: string
      back: string
      at: string
      gradeText: string
    } | null>(
      context,
      `(() => {
         const rows = Array.from(document.querySelectorAll('[data-testid="review-history-row"]'))
           .filter((row) => row.getAttribute('data-card-id') === ${JSON.stringify(historyCardId)})
         if (rows.length === 0) return null
         const read = (id) => {
           const el = rows[0].querySelector('[data-testid="' + id + '"]')
           return el ? (el.textContent || '').trim() : ''
         }
         return {
           count: rows.length,
           grade: rows[0].getAttribute('data-grade') || '',
           front: read('review-history-front'),
           back: read('review-history-back'),
           at: read('review-history-at'),
           gradeText: read('review-history-grade')
         }
       })()`,
      (value) => value !== null,
      14,
      250
    )

    // 卡片本身按算法推进（期望值由 applyGrade 给出，验收里不重写规则）
    const cardsNow = await reviewCards(context)
    const cardNow = cardsNow.find((item) => item['id'] === historyCardId)
    const intensityNow = await effectiveIntensity(context)
    const expected = applyGrade({ stage: 1, reviewCount: 2 }, 'remembered', todayKey, intensityNow)

    record({
      id: 'P8-L2',
      prd: 'BUG-008',
      name: '复习历史可查：评一次分就落一条历史（at/grade/stageBefore/stageAfter/dueDateAfter 齐全），复习页历史分区显示内容、答案、时间与当时评分',
      passed:
        shown &&
        expanded &&
        revealClicked &&
        gradeButtons === 3 &&
        gradeClicked &&
        stored !== null &&
        fieldsOk &&
        uiRow !== null &&
        uiRow.count >= 1 &&
        uiRow.grade === 'remembered' &&
        uiRow.front === front &&
        uiRow.back === back &&
        uiRow.at !== '' &&
        uiRow.gradeText.includes('记住了') &&
        cardNow?.['stage'] === expected.stageAfter &&
        cardNow?.['dueDate'] === expected.dueDate &&
        cardNow?.['reviewCount'] === expected.reviewCount,
      detail: `卡片行渲染=${shown} 就地展开=${expanded} 点"显示答案"=${revealClicked} 评分按钮=${gradeButtons ?? 0} 个 点"记住了"=${gradeClicked}；历史落库=${stored !== null} 共 ${historyList.length} 条，字段齐全=${fieldsOk}（${JSON.stringify(entry ?? {})}）；界面上这一行：前端="${uiRow?.front ?? '（没找到）'}" 答案="${uiRow?.back ?? ''}" 时间="${uiRow?.at ?? ''}" 评分="${uiRow?.gradeText ?? ''}"；卡片按算法推进：阶段→${String(cardNow?.['stage'])}（期望 ${expected.stageAfter}）到期→${String(cardNow?.['dueDate'])}（期望 ${expected.dueDate}）次数→${String(cardNow?.['reviewCount'])}（期望 ${expected.reviewCount}，强度=${intensityNow}）`
    })
  } catch (error) {
    record({
      id: 'P8-L2',
      prd: 'BUG-008',
      name: '复习历史可查：评一次分就落一条历史（at/grade/stageBefore/stageAfter/dueDateAfter 齐全），复习页历史分区显示内容、答案、时间与当时评分',
      passed: false,
      detail: `${String(error)}；${diagnostics()}`
    })
  }

  // ---- L3 历史裁剪：每卡恒为最近 50 次（写第 51 次时最早的那条被硬删） ----
  let trimCardId = ''
  try {
    await openReviewIdle(context)
    trimCardId = await addReviewCard(context, {
      front: `${hotkeyMarker} 五十条历史`,
      back: '答案',
      source: hotkeyMarker,
      stage: 0,
      dueDate: todayKey,
      reviewCount: 0,
      lastReviewedAt: null
    })
    /** 造 50 条历史（时间从 2026-01-01 起每分钟一条，递增 → 最后一条最新） */
    const oldestAt = await evaluate<string>(
      context,
      `(async () => {
         const base = Date.UTC(2026, 0, 1, 0, 0, 0)
         for (let index = 0; index < ${HISTORY_KEEP_LIMIT}; index += 1) {
           await window.api.data.add('review', {
             kind: 'history',
             cardId: ${JSON.stringify(trimCardId)},
             at: new Date(base + index * 60000).toISOString(),
             grade: 'fuzzy',
             stageBefore: 0,
             stageAfter: 0,
             dueDateAfter: ${JSON.stringify(todayKey)}
           })
         }
         return new Date(base).toISOString()
       })()`
    )
    await evaluate(context, `window.api.data.flush()`)
    await evaluate(
      context,
      `window.dispatchEvent(new CustomEvent('worklife:data-changed', { detail: { module: 'review' } })), true`
    )
    const seeded = await until<number>(
      context,
      `window.api.data.listAlive('review').then((records) => records.filter((item) => item['kind'] === 'history' && item['cardId'] === ${JSON.stringify(trimCardId)}).length)`,
      (count) => count === HISTORY_KEEP_LIMIT,
      16,
      250
    )

    // 再评一次 → 第 51 条 → 最早的被丢弃，总数回到 50
    // 第 10 块：卡片行在"当前主题"的树里 —— 先点开它所属的主题
    const shown = await revealReviewCardRow(context, trimCardId)
    const expanded = await expandCardRow(context, trimCardId)
    await evaluate(
      context,
      `(() => {
         const button = document.querySelector('[data-testid="inline-card-reveal"]')
         if (button) button.click()
         return true
       })()`
    )
    const gradeShown = await untilTrue(
      context,
      `!!document.querySelector('[data-testid="inline-grade-fuzzy"]')`,
      10,
      200
    )
    await evaluate(
      context,
      `(() => {
         const button = document.querySelector('[data-testid="inline-grade-fuzzy"]')
         if (button) button.click()
         return true
       })()`
    )
    const trimmed = await until<Array<Record<string, unknown>>>(
      context,
      `window.api.data.listAlive('review')`,
      (records) => {
        const mine = records.filter(
          (item) => item['kind'] === 'history' && String(item['cardId'] ?? '') === trimCardId
        )
        return mine.length === HISTORY_KEEP_LIMIT && !mine.some((item) => item['at'] === oldestAt)
      },
      16,
      250
    )
    await evaluate(context, `window.api.data.flush()`)
    const after = await reviewHistories(context, trimCardId)
    const oldestGone = !after.some((item) => item['at'] === oldestAt)
    const newestPresent = after.some((item) => item['grade'] === 'fuzzy' && item['at'] !== undefined)
    const cardNow = (await reviewCards(context)).find((item) => item['id'] === trimCardId)

    record({
      id: 'P8-L3',
      prd: '决定20',
      name: `复习历史每卡只保留最近 ${HISTORY_KEEP_LIMIT} 次：已经有 ${HISTORY_KEEP_LIMIT} 条时再评一次，最早的被丢弃且总数恒为 ${HISTORY_KEEP_LIMIT}`,
      passed:
        seeded === HISTORY_KEEP_LIMIT &&
        shown &&
        expanded &&
        gradeShown &&
        trimmed !== null &&
        after.length === HISTORY_KEEP_LIMIT &&
        oldestGone &&
        newestPresent &&
        Number(cardNow?.['reviewCount']) >= 1,
      detail: `造了 ${seeded ?? 0} 条历史（最早 ${oldestAt}）；卡片行=${shown} 就地展开=${expanded} 评分按钮=${gradeShown}；再评一次后历史 ${after.length} 条（期望 ${HISTORY_KEEP_LIMIT}）最早那条已丢弃=${oldestGone} 本次评分的那条在=${newestPresent}；卡片复习次数=${String(cardNow?.['reviewCount'])}`
    })
  } catch (error) {
    record({
      id: 'P8-L3',
      prd: '决定20',
      name: `复习历史每卡只保留最近 ${HISTORY_KEEP_LIMIT} 次：已经有 ${HISTORY_KEEP_LIMIT} 条时再评一次，最早的被丢弃且总数恒为 ${HISTORY_KEEP_LIMIT}`,
      passed: false,
      detail: `${String(error)}；${diagnostics()}`
    })
  }

  // ---- L4 就地背卡：点卡片就地展开 → 正面 → 显示答案 → 三档评分，不跳页、不进队列 ----
  let inlineCardId = ''
  try {
    await openReviewIdle(context)
    const front = `${hotkeyMarker} 就地背卡`
    inlineCardId = await addReviewCard(context, {
      front,
      back: '就地背卡的答案',
      source: hotkeyMarker,
      stage: 0,
      dueDate: todayKey,
      reviewCount: 0,
      lastReviewedAt: null
    })
    // 第 10 块：卡片行在"当前主题"的树里 —— 先点开它所属的主题
    const shown = await revealReviewCardRow(context, inlineCardId)
    const viewBefore = await evaluate<string>(context, `window.__verify.activeView()`)
    const expanded = await expandCardRow(context, inlineCardId)
    const snapshot = await until<{
      front: string
      hasBack: boolean
      grades: number
      session: boolean
      view: string
    } | null>(
      context,
      `(() => {
         const box = document.querySelector('[data-testid="inline-card-review"][data-card-id="${inlineCardId}"]')
         if (!box) return null
         const frontEl = box.querySelector('[data-testid="inline-card-front"]')
         return {
           front: frontEl ? (frontEl.textContent || '').trim() : '',
           hasBack: !!box.querySelector('[data-testid="inline-card-back"]'),
           grades: box.querySelectorAll('[data-testid^="inline-grade-"]').length,
           session: window.__verify.exists('review-session'),
           view: window.__verify.activeView()
         }
       })()`,
      (value) => value !== null,
      12,
      200
    )

    // 显示答案 → 背面 + 三个评分按钮
    await evaluate(
      context,
      `(() => {
         const button = document.querySelector('[data-testid="inline-card-reveal"]')
         if (button) button.click()
         return true
       })()`
    )
    const revealed = await until<{ back: string; grades: number; session: boolean; view: string } | null>(
      context,
      `(() => {
         const box = document.querySelector('[data-testid="inline-card-review"][data-card-id="${inlineCardId}"]')
         if (!box) return null
         const backEl = box.querySelector('[data-testid="inline-card-back"]')
         return {
           back: backEl ? (backEl.textContent || '').trim() : '',
           grades: box.querySelectorAll('[data-testid^="inline-grade-"]').length,
           session: window.__verify.exists('review-session'),
           view: window.__verify.activeView()
         }
       })()`,
      (value) => value !== null && value.grades === 3,
      12,
      200
    )

    // 评分：就地评完仍留在原地（不跳页、不进队列），卡片数据当场推进
    const intensityNow = await effectiveIntensity(context)
    const expected = applyGrade({ stage: 0, reviewCount: 0 }, 'fuzzy', todayKey, intensityNow)
    await evaluate(
      context,
      `(() => {
         const button = document.querySelector('[data-testid="inline-grade-fuzzy"]')
         if (button) button.click()
         return true
       })()`
    )
    const graded = await untilTrue(
      context,
      `(async () => {
         const records = await window.api.data.listAlive('review')
         const card = records.find((item) => item['id'] === ${JSON.stringify(inlineCardId)})
         return !!card && Number(card['reviewCount']) === ${expected.reviewCount}
       })()`,
      14,
      250
    )
    /**
     * 评完之后界面要回到"没显示答案"的样子（背面收起、三个评分按钮消失），
     * 并且仍停在同一页、同一张展开的卡上 —— 这就是"不跳页、不进队列"。
     *
     * 这里**必须轮询**：数据落库（上面那个 untilTrue）与 React 重渲染之间没有顺序保证，
     * 单点读一次会读到"上一帧的 DOM"（已踩过：L4 报"评分后按钮数=3"）。
     */
    const afterGrade = await until<{
      view: string
      session: boolean
      stillExpanded: boolean
      grades: number
    } | null>(
      context,
      `(() => {
         const box = document.querySelector('[data-testid="inline-card-review"][data-card-id="${inlineCardId}"]')
         return {
           view: window.__verify.activeView(),
           session: window.__verify.exists('review-session'),
           stillExpanded: !!box,
           grades: box ? box.querySelectorAll('[data-testid^="inline-grade-"]').length : 0
         }
       })()`,
      (value) => value !== null && value.stillExpanded && value.grades === 0,
      14,
      250
    )

    record({
      id: 'P8-L4',
      prd: '决定18',
      name: '就地背卡：点"全部卡片"里的一行就地展开（正面 → 显示答案 → 三档评分），不跳页、不进独立队列；评分后卡片当场推进',
      passed:
        shown &&
        viewBefore === 'review' &&
        expanded &&
        snapshot?.front === front &&
        snapshot?.hasBack === false &&
        (snapshot?.grades ?? -1) === 0 &&
        revealed?.back === '就地背卡的答案' &&
        revealed?.grades === 3 &&
        revealed?.session === false &&
        revealed?.view === 'review' &&
        graded &&
        afterGrade !== null &&
        afterGrade.view === 'review' &&
        afterGrade.session === false &&
        afterGrade.stillExpanded &&
        afterGrade.grades === 0,
      detail: `卡片行=${shown} 点之前的视图=${viewBefore}；点行就地展开=${expanded} 展开时显示正面="${snapshot?.front ?? ''}"（期望 "${front}"）此时有背面=${snapshot?.hasBack ?? '?'}（期望 false）评分按钮=${snapshot?.grades ?? -1}（期望 0）；"显示答案"后背面="${revealed?.back ?? ''}" 三个按钮=${revealed?.grades ?? -1} 会话存在=${revealed?.session ?? '?'}（期望 false）视图=${revealed?.view ?? ''}；评分落库=${graded}（期望次数 ${expected.reviewCount}）；评分后视图=${afterGrade?.view ?? '（没等到）'} 会话=${afterGrade?.session ?? '?'} 仍展开=${afterGrade?.stillExpanded ?? '?'} 按钮数=${afterGrade?.grades ?? '?'}（期望 0 = 还原成未显示答案）`
    })
  } catch (error) {
    record({
      id: 'P8-L4',
      prd: '决定18',
      name: '就地背卡：点"全部卡片"里的一行就地展开（正面 → 显示答案 → 三档评分），不跳页、不进独立队列；评分后卡片当场推进',
      passed: false,
      detail: `${String(error)}；${diagnostics()}`
    })
  }

  // ---- L5 就地背卡的键盘：空格显示答案 → 1/2/3 评分 ----
  let keyboardCardId = ''
  try {
    await openReviewIdle(context)
    keyboardCardId = await addReviewCard(context, {
      front: `${hotkeyMarker} 就地键盘`,
      back: '就地键盘的答案',
      source: hotkeyMarker,
      stage: 0,
      dueDate: todayKey,
      reviewCount: 0,
      lastReviewedAt: null
    })
    // 第 10 块：卡片行在"当前主题"的树里 —— 先点开它所属的主题
    const shown = await revealReviewCardRow(context, keyboardCardId)
    const expanded = await expandCardRow(context, keyboardCardId)

    // 空格：显示答案
    await pressKeyOn(context, ' ')
    const revealed = await untilTrue(
      context,
      `!!document.querySelector('[data-testid="inline-card-review"][data-card-id="${keyboardCardId}"] [data-testid="inline-card-back"]')`,
      12,
      200
    )
    // 3 = 记住了
    const intensityNow = await effectiveIntensity(context)
    const expected = applyGrade({ stage: 0, reviewCount: 0 }, 'remembered', todayKey, intensityNow)
    await pressKeyOn(context, '3')
    const graded = await untilTrue(
      context,
      `(async () => {
         const records = await window.api.data.listAlive('review')
         const card = records.find((item) => item['id'] === ${JSON.stringify(keyboardCardId)})
         return !!card && Number(card['stage']) === ${expected.stageAfter} && Number(card['reviewCount']) === ${expected.reviewCount}
       })()`,
      14,
      250
    )
    const backGone = await untilTrue(
      context,
      `!document.querySelector('[data-testid="inline-card-review"][data-card-id="${keyboardCardId}"] [data-testid="inline-card-back"]')`,
      10,
      200
    )

    record({
      id: 'P8-L5',
      prd: '决定18',
      name: '就地背卡的键盘可用：空格显示答案，1/2/3 三档评分（不需要鼠标，也不进会话队列）',
      passed: shown && expanded && revealed && graded && backGone,
      detail: `卡片行=${shown} 就地展开=${expanded}；空格显示答案=${revealed}；按 3（记住了）→ 阶段 ${expected.stageAfter} / 次数 ${expected.reviewCount} 落库=${graded}；评完背面收起=${backGone}`
    })
  } catch (error) {
    record({
      id: 'P8-L5',
      prd: '决定18',
      name: '就地背卡的键盘可用：空格显示答案，1/2/3 三档评分（不需要鼠标，也不进会话队列）',
      passed: false,
      detail: `${String(error)}；${diagnostics()}`
    })
  }

  // ---- L6 N = 当前模块新建一条（计划 / 学习 / 读书 / 备忘 各做各的） ----
  try {
    const bindings = await effectiveHotkeys(context)
    const newCombo = bindings.new

    // 计划：新建任务表单
    await closeFloaters(context)
    await evaluate(context, `window.__verify.clickNav('plan')`)
    await wait(400)
    await pressCombo(context, newCombo)
    const planForm = await untilTrue(context, `window.__verify.exists('task-form')`, 12, 200)
    await closeFloaters(context)
    await wait(200)

    // 学习：焦点进"新建主题"输入框
    await evaluate(context, `window.__verify.clickNav('learning')`)
    await wait(500)
    const learningInput = await untilTrue(
      context,
      `!!window.__verify.byTestId('learning-new-topic-input')`,
      12,
      200
    )
    await pressCombo(context, newCombo)
    const learningFocused = await untilTrue(
      context,
      `(() => {
         const el = window.__verify.byTestId('learning-new-topic-input')
         return !!el && document.activeElement === el
       })()`,
      12,
      200
    )

    // 读书：添加书表单
    await closeFloaters(context)
    await evaluate(context, `window.__verify.clickNav('reading')`)
    await wait(500)
    await pressCombo(context, newCombo)
    const readingForm = await untilTrue(context, `window.__verify.exists('reading-new-title')`, 12, 200)
    await closeFloaters(context)
    await wait(200)

    // 备忘：焦点进"记点什么"编辑区
    await evaluate(context, `window.__verify.clickNav('memo')`)
    await wait(500)
    const memoInput = await untilTrue(context, `!!window.__verify.byTestId('memo-input')`, 12, 200)
    await pressCombo(context, newCombo)
    const memoFocused = await untilTrue(
      context,
      `(() => {
         const el = window.__verify.byTestId('memo-input')
         return !!el && document.activeElement === el
       })()`,
      12,
      200
    )

    record({
      id: 'P8-L6',
      prd: 'FEAT-008',
      name: 'N（当前模块新建一条）已接线：计划页打开新建任务、学习页聚焦新建主题、读书页打开添加书、备忘页聚焦新建备忘',
      passed: planForm && learningInput && learningFocused && readingForm && memoInput && memoFocused,
      detail: `按 ${newCombo}（真实绑定）：计划页出新建任务表单=${planForm}；学习页有输入框=${learningInput} 焦点进入=${learningFocused}；读书页出添加书表单=${readingForm}；备忘页有编辑区=${memoInput} 焦点进入=${memoFocused}`
    })
  } catch (error) {
    record({
      id: 'P8-L6',
      prd: 'FEAT-008',
      name: 'N（当前模块新建一条）已接线：计划页打开新建任务、学习页聚焦新建主题、读书页打开添加书、备忘页聚焦新建备忘',
      passed: false,
      detail: `${String(error)}；${diagnostics()}`
    })
  }

  // ---- L7 N 在复习页不注册（决定 29） ----
  try {
    const bindings = await effectiveHotkeys(context)
    await openReviewIdle(context)
    // 第 10 块：先让树里真的有卡片行，免得"0 → 0"这种空比较被当成通过
    if (keyboardCardId !== '') await revealReviewCardRow(context, keyboardCardId)
    const before = await evaluate<{ cards: number; form: boolean; session: boolean; drawers: number }>(
      context,
      `({
         cards: document.querySelectorAll('[data-testid="review-card-row"]').length,
         form: window.__verify.exists('review-form'),
         session: window.__verify.exists('review-session'),
         drawers: document.querySelectorAll('.drawer-layer').length
       })`
    )
    await pressCombo(context, bindings.new)
    await wait(600)
    const after = await evaluate<{ cards: number; form: boolean; session: boolean; drawers: number }>(
      context,
      `({
         cards: document.querySelectorAll('[data-testid="review-card-row"]').length,
         form: window.__verify.exists('review-form'),
         session: window.__verify.exists('review-session'),
         drawers: document.querySelectorAll('.drawer-layer').length
       })`
    )

    record({
      id: 'P8-L7',
      prd: '决定29',
      name: 'N 在复习页不注册：在复习页按 N 什么都不发生（不弹表单、不进会话、卡片数不变）',
      passed:
        before.cards > 0 &&
        before.cards === after.cards &&
        before.form === false &&
        after.form === false &&
        before.session === after.session &&
        before.drawers === after.drawers,
      detail: `按 ${bindings.new}（真实绑定）前后：卡片行 ${before.cards}→${after.cards}；表单 ${before.form}→${after.form}；会话 ${before.session}→${after.session}；抽屉 ${before.drawers}→${after.drawers}`
    })
  } catch (error) {
    record({
      id: 'P8-L7',
      prd: '决定29',
      name: 'N 在复习页不注册：在复习页按 N 什么都不发生（不弹表单、不进会话、卡片数不变）',
      passed: false,
      detail: `${String(error)}；${diagnostics()}`
    })
  }

  // ---- L8 T = 计划页回到今天（同时把视图切回"今天"），其它页面不生效 ----
  try {
    const bindings = await effectiveHotkeys(context)
    const weekStart = await effectiveWeekStart(context)
    const thisWeekFirst = weekKeysFor(todayKey, weekStart)[0] ?? todayKey

    await closeFloaters(context)
    await evaluate(context, `window.__verify.clickNav('plan')`)
    await wait(400)
    // 先复位再操作：切到周视图，然后往回翻两周（这样"回到今天"才有可见效果）
    const weekOpened = await openPlanCalendar(context, 'week')
    if (!weekOpened) throw new Error('周视图没有渲染出来')
    await evaluate(context, `window.__verify.click('[data-testid="calendar-prev"]')`)
    await wait(250)
    await evaluate(context, `window.__verify.click('[data-testid="calendar-prev"]')`)
    await wait(300)
    const firstBefore = await evaluate<string>(
      context,
      `(() => {
         const column = document.querySelector('[data-testid="week-column"]')
         return column ? column.getAttribute('data-date') || '' : ''
       })()`
    )
    const stateBefore = await planState(context)

    await pressCombo(context, bindings.today)
    const wentToday = await until<{ view: string; activeDay: string } | null>(
      context,
      `(() => {
         const el = window.__verify.byTestId('plan-state')
         if (!el) return null
         return { view: el.getAttribute('data-view') || '', activeDay: el.getAttribute('data-active-day') || '' }
       })()`,
      (value) => value !== null && value.view === 'today' && value.activeDay === todayKey,
      12,
      200
    )
    // 锚点也复位了：再切回周视图，第一列应当是本周第一天（而不是翻回去的那两周）
    const weekAgain = await openPlanCalendar(context, 'week')
    const firstAfter = await evaluate<string>(
      context,
      `(() => {
         const column = document.querySelector('[data-testid="week-column"]')
         return column ? column.getAttribute('data-date') || '' : ''
       })()`
    )

    // 其它页面按 T 不生效
    //
    // 先**轮询到备忘页真的渲染出来**再按键（硬规矩第 1 条：不用固定延时）。
    // 12 块抓到过一例：这里只用 `wait(400)`，切页还没落地就按键/读读数，
    // 读到的还是上一页的 `data-view`（报告里写成一次 learning，看着像"T 会跳页"，
    // 其实只是场景自己没等页面切过去）。
    await closeFloaters(context)
    const memoReached = await (async (): Promise<boolean> => {
      for (let attempt = 0; attempt < 3; attempt += 1) {
        await evaluate(context, `window.__verify.clickNav('memo')`)
        const arrived = await untilTrue(context, `window.__verify.activeView() === 'memo'`, 8, 200)
        if (arrived) return true
      }
      return false
    })()
    const viewBeforeT = await evaluate<string>(context, `window.__verify.activeView()`)
    await pressCombo(context, bindings.today)
    // 按完再确认"仍然是备忘页"（等到它稳定，而不是读一次就走）
    const memoViewAfterT = await evaluate<string>(context, `window.__verify.activeView()`)
    const stayedOnMemo = await untilTrue(context, `window.__verify.activeView() === 'memo'`, 6, 200)
    const viewAfterWait = await evaluate<string>(context, `window.__verify.activeView()`)

    record({
      id: 'P8-L8',
      prd: 'FEAT-008',
      name: 'T（计划页回到今天）已接线：把视图从"本周"切回"今天"、选中今天，并把日历锚点复位；其它页面按 T 不生效',
      passed:
        stateBefore?.view === 'week' &&
        firstBefore !== thisWeekFirst &&
        wentToday !== null &&
        weekAgain &&
        firstAfter === thisWeekFirst &&
        memoReached &&
        viewBeforeT === 'memo' &&
        memoViewAfterT === 'memo' &&
        stayedOnMemo,
      detail: `按 ${bindings.today}（真实绑定）；事前：视图=${stateBefore?.view ?? ''}（期望 week）周首列=${firstBefore}（本周应是 ${thisWeekFirst}，翻过两周所以不同）；事后视图="today" 选中今天=${todayKey} → ${wentToday !== null}；再切回周视图首列=${firstAfter}（期望 ${thisWeekFirst}，说明锚点也复位了）；切到备忘页=${memoReached}（按 T 前视图=${viewBeforeT}）→ 按 T 后视图=${memoViewAfterT}，等 1 秒后仍是备忘页=${stayedOnMemo}（期望 true，末次读数=${viewAfterWait}）`
    })
  } catch (error) {
    record({
      id: 'P8-L8',
      prd: 'FEAT-008',
      name: 'T（计划页回到今天）已接线：把视图从"本周"切回"今天"、选中今天，并把日历锚点复位；其它页面按 T 不生效',
      passed: false,
      detail: `${String(error)}；${diagnostics()}`
    })
  }

  // ---- L9 单键在输入框里不生效；组合键任何情况下都生效 ----
  try {
    const bindings = await effectiveHotkeys(context)
    await closeFloaters(context)
    await evaluate(context, `window.__verify.clickNav('plan')`)
    await wait(400)
    const weekOpened = await openPlanCalendar(context, 'week')
    if (!weekOpened) throw new Error('周视图没有渲染出来')

    // 焦点进搜索框，再按 T / N（目标就是输入框本身）
    await evaluate(
      context,
      `(() => {
         const input = window.__verify.byTestId('plan-search')
         if (!input) return false
         input.focus()
         return document.activeElement === input
       })()`
    )
    const focused = await untilTrue(
      context,
      `(() => {
         const input = window.__verify.byTestId('plan-search')
         return !!input && document.activeElement === input
       })()`,
      10,
      200
    )
    const stateBefore = await planState(context)
    await pressCombo(context, bindings.today, false)
    await wait(400)
    await pressCombo(context, bindings.new, false)
    await wait(500)
    const stateAfter = await planState(context)
    const formAfterSingleKeys = await evaluate<boolean>(context, `window.__verify.exists('task-form')`)
    const stillFocused = await evaluate<boolean>(
      context,
      `(() => {
         const input = window.__verify.byTestId('plan-search')
         return !!input && document.activeElement === input
       })()`
    )

    // 组合键不受限：焦点还在输入框里，Ctrl+K 照样打开搜索
    await pressCombo(context, bindings.search, false)
    const searchOpened = await untilTrue(context, `window.__verify.exists('search-drawer')`, 14, 200)
    await pressKeyOn(context, 'Escape')
    const searchClosed = await untilTrue(context, `!window.__verify.exists('search-drawer')`, 10, 200)

    record({
      id: 'P8-L9',
      prd: 'FEAT-008',
      name: '单键（N / T）在输入框里不生效，带 Ctrl 的组合键（Ctrl+K）在任何情况下都能用',
      passed:
        focused &&
        stateBefore?.view === 'week' &&
        stateAfter?.view === stateBefore?.view &&
        stateAfter?.activeDay === stateBefore?.activeDay &&
        formAfterSingleKeys === false &&
        stillFocused &&
        searchOpened &&
        searchClosed,
      detail: `按 ${bindings.today}/${bindings.new}（单键）时焦点在计划页搜索框：聚焦=${focused} 视图 ${stateBefore?.view ?? ''}→${stateAfter?.view ?? ''}（期望不变）选中日 ${stateBefore?.activeDay ?? ''}→${stateAfter?.activeDay ?? ''}（期望不变）弹出新建任务表单=${formAfterSingleKeys}（期望 false）焦点仍在输入框=${stillFocused}；焦点仍在输入框时按 ${bindings.search}（组合键）→ 搜索抽屉打开=${searchOpened} 关掉=${searchClosed}`
    })
  } catch (error) {
    record({
      id: 'P8-L9',
      prd: 'FEAT-008',
      name: '单键（N / T）在输入框里不生效，带 Ctrl 的组合键（Ctrl+K）在任何情况下都能用',
      passed: false,
      detail: `${String(error)}；${diagnostics()}`
    })
  }

  // ---- L10 设置页：列出全部快捷键 / 可改 / 冲突检测 / 可重置 ----
  try {
    await closeFloaters(context)
    await evaluate(context, `window.__verify.clickNav('settings')`)
    await wait(500)
    const sectionShown = await untilTrue(context, `window.__verify.exists('settings-hotkeys')`, 12, 250)

    // 先复位：让这一项从已知状态开始（上一趟可能改过）
    await evaluate(context, `window.__verify.click('[data-testid="hotkey-reset-all"]')`)
    await wait(500)
    const rows = await evaluate<Array<{ action: string; combo: string; isDefault: boolean }>>(
      context,
      `Array.from(document.querySelectorAll('[data-testid="hotkey-row"]')).map((row) => ({
         action: row.getAttribute('data-action') || '',
         combo: row.getAttribute('data-combo') || '',
         isDefault: row.getAttribute('data-default') === '1'
       }))`
    )
    const allDefault = rows.every((row) => row.isDefault)
    const actionsOk = HOTKEY_ACTIONS.every((action) => rows.some((row) => row.action === action))
    const saveRow = rows.find((row) => row.action === 'save')
    const newRow = rows.find((row) => row.action === 'new')
    const todayRow = rows.find((row) => row.action === 'today')
    const fixedShown = await evaluate<number>(
      context,
      `document.querySelectorAll('[data-testid="hotkey-fixed-row"]').length`
    )

    // 冲突：抓键时按一个已被占用的键（save 的 ctrl+s）→ 拒绝并说明被谁占了
    const editClicked = await clickHotkeyRowButton(context, 'today', 'hotkey-edit')
    const capturing = await untilTrue(context, `window.__verify.exists('hotkey-capture')`, 10, 200)
    const tCombo = todayRow?.combo ?? 't'
    await pressKeyOn(context, 's', { ctrlKey: true })
    const conflictText = await until<string>(
      context,
      `((window.__verify.byTestId('hotkey-error') || {}).textContent || '').trim()`,
      (text) => text !== '',
      10,
      200
    )
    const stillCapturing = await evaluate<boolean>(context, `window.__verify.exists('hotkey-capture')`)
    const rowAfterConflict = await hotkeyRowSnapshot(context, 'today')
    // 抓键期间那次按键**不能被旧绑定顺带执行**（否则按 Ctrl+S 会真的去保存）
    const flashText = await evaluate<string>(
      context,
      `((window.__verify.byTestId('flash') || {}).textContent || '').trim()`
    )
    const saveNotTriggered = !flashText.includes('保存')

    // 改成一个空闲组合键 → 立即生效并落库
    await pressKeyOn(context, 'y', { ctrlKey: true, shiftKey: true })
    const changed = await until<{ combo: string; isDefault: boolean } | null>(
      context,
      `(() => {
         const row = document.querySelector('[data-testid="hotkey-row"][data-action="today"]')
         if (!row) return null
         return { combo: row.getAttribute('data-combo') || '', isDefault: row.getAttribute('data-default') === '1' }
       })()`,
      (value) => value !== null && value.combo === 'ctrl+shift+y',
      14,
      250
    )
    const storedHotkeys = await evaluate<Record<string, unknown> | null>(
      context,
      `(async () => {
         const records = await window.api.data.listAlive('app')
         const found = records.find((item) => item['id'] === 'preferences')
         return found ? found['hotkeys'] || null : null
       })()`
    )

    // 重置这一项 → 回到默认（落库里那条覆盖也要消失）
    const resetClicked = await clickHotkeyRowButton(context, 'today', 'hotkey-reset')
    const resetBack = await untilTrue(
      context,
      `(() => {
         const row = document.querySelector('[data-testid="hotkey-row"][data-action="today"]')
         if (!row) return false
         return row.getAttribute('data-combo') === ${JSON.stringify(tCombo)} && row.getAttribute('data-default') === '1'
       })()`,
      14,
      250
    )
    await evaluate(context, `window.api.data.flush()`)
    const storedAfterReset = await evaluate<Record<string, unknown> | null>(
      context,
      `(async () => {
         const records = await window.api.data.listAlive('app')
         const found = records.find((item) => item['id'] === 'preferences')
         return found ? found['hotkeys'] || null : null
       })()`
    )

    // 收尾：全部恢复默认，别把后面几趟的验收环境改坏
    await evaluate(context, `window.__verify.click('[data-testid="hotkey-reset-all"]')`)
    await wait(500)
    const restored = await evaluate<boolean>(
      context,
      `Array.from(document.querySelectorAll('[data-testid="hotkey-row"]')).every((row) => row.getAttribute('data-default') === '1')`
    )

    record({
      id: 'P8-L10',
      prd: 'FEAT-008',
      name: '设置页列出全部快捷键（Ctrl+S 在列），可改、可重置（单项与全部）、能检出冲突并说明被谁占用',
      passed:
        sectionShown &&
        rows.length === HOTKEY_ACTIONS.length &&
        actionsOk &&
        allDefault &&
        saveRow?.combo === 'ctrl+s' &&
        newRow?.combo === 'n' &&
        todayRow?.combo === 't' &&
        fixedShown >= 1 &&
        editClicked &&
        capturing &&
        (conflictText ?? '').includes('冲突') &&
        stillCapturing &&
        rowAfterConflict?.combo === tCombo &&
        saveNotTriggered &&
        changed !== null &&
        changed.isDefault === false &&
        (storedHotkeys?.['today'] ?? null) === 'ctrl+shift+y' &&
        resetClicked &&
        resetBack &&
        (storedAfterReset?.['today'] ?? null) === null &&
        restored,
      detail: `快捷键分区=${sectionShown}；行数=${rows.length}（期望 ${HOTKEY_ACTIONS.length}）动作齐全=${actionsOk} 复位后全部默认=${allDefault} Ctrl+S 行="${saveRow?.combo ?? ''}" N 行="${newRow?.combo ?? ''}" T 行="${todayRow?.combo ?? ''}"；固定键列出 ${fixedShown} 条；点"修改"=${editClicked} 进入抓键=${capturing} 按 Ctrl+S → 提示="${conflictText ?? '（没有）'}" 仍在抓键=${stillCapturing} 这一项没被改=${rowAfterConflict?.combo ?? ''}（期望 ${tCombo}） 旧"保存"没被顺带触发=${saveNotTriggered}（flash="${flashText}"）；按 Ctrl+Shift+Y → 行上="${changed?.combo ?? '（没变）'}"（data-default=${String(changed?.isDefault)}，期望 false）落库 hotkeys.today=${String(storedHotkeys?.['today'])}；点"重置"=${resetClicked} 回默认=${resetBack} 落库那条覆盖已消失=${(storedAfterReset?.['today'] ?? null) === null}；最后"全部恢复默认"=${restored}`
    })
  } catch (error) {
    record({
      id: 'P8-L10',
      prd: 'FEAT-008',
      name: '设置页列出全部快捷键（Ctrl+S 在列），可改、可重置（单项与全部）、能检出冲突并说明被谁占用',
      passed: false,
      detail: `${String(error)}；${diagnostics()}`
    })
  }

  // ---- L11 备忘标签：菜单里"添加标签"能加、行上看得见、工具条能按标签筛；置顶仍然有效 ----
  try {
    await injectRichHelpers(context)
    await closeFloaters(context)
    await evaluate(context, `window.__verify.clickNav('memo')`)
    await wait(500)

    const tag = `${hotkeyMarker}标签`
    const firstText = `${hotkeyMarker} 标签甲`
    const secondText = `${hotkeyMarker} 标签乙`

    /** 用正文编辑区写一条备忘（富文本编辑器要走 execCommand，不能直接赋 value） */
    const addMemo = async (text: string): Promise<void> => {
      const typed = await setRichHtml(context, 'memo-input', `<p>${text}</p>`)
      if (!typed) throw new Error('备忘输入区不可用')
      await evaluate(context, `window.__verify.click('[data-testid="memo-input-save"]')`)
      const shown = await untilTrue(
        context,
        `Array.from(document.querySelectorAll('[data-testid="memo-item"]')).some(
           (item) => (item.textContent || '').indexOf(${JSON.stringify(text)}) >= 0)`,
        14,
        250
      )
      if (!shown) throw new Error(`备忘没有出现：${text}`)
    }

    await addMemo(firstText)
    await addMemo(secondText)

    const firstId = await evaluate<string>(
      context,
      `(() => {
         const item = Array.from(document.querySelectorAll('[data-testid="memo-item"]'))
           .find((el) => (el.textContent || '').indexOf(${JSON.stringify(firstText)}) >= 0)
         return item ? item.getAttribute('data-memo-id') || '' : ''
       })()`
    )
    const rowSelector = `[data-testid="memo-item"][data-memo-id="${firstId}"]`

    // 走菜单：⋯ →「添加标签」→ 抽屉
    await clickMenuButton(context, 'memo-menu', rowSelector)
    await waitForMenu(context)
    const menuClicked = await clickMenuItem(context, 'memo-add-tag')
    const drawerOpen = await untilTrue(context, `window.__verify.exists('memo-tag-drawer')`, 10, 200)
    await setNativeValue(context, 'memo-tag-input', tag)
    const saveClicked = await evaluate<boolean>(
      context,
      `window.__verify.click('[data-testid="memo-tag-save"]')`
    )
    const drawerClosed = await untilTrue(context, `!window.__verify.exists('memo-tag-drawer')`, 12, 250)
    await evaluate(context, `window.api.data.flush()`)

    const memoRecords = await evaluate<Array<Record<string, unknown>>>(
      context,
      `window.api.data.listAlive('memo')`
    )
    const storedMemo = memoRecords.find((item) => item['id'] === firstId)
    const tagsStored = Array.isArray(storedMemo?.['tags']) && (storedMemo?.['tags'] as string[]).includes(tag)

    const rowTagsShown = await untilTrue(
      context,
      `(() => {
         const row = document.querySelector(${JSON.stringify(rowSelector)})
         if (!row) return false
         const box = row.querySelector('[data-testid="memo-tags"]')
         return !!box && (box.textContent || '').indexOf(${JSON.stringify(tag)}) >= 0
       })()`,
      12,
      250
    )
    const optionShown = await untilTrue(
      context,
      `!!document.querySelector('[data-testid="memo-tag-option"][data-tag="${tag}"]')`,
      12,
      250
    )

    // 点工具条上的标签 → 只剩带这个标签的那一条
    await evaluate(
      context,
      `(() => {
         const chip = document.querySelector('[data-testid="memo-tag-option"][data-tag="${tag}"]')
         if (chip) chip.click()
         return true
       })()`
    )
    const filtered = await until<{ count: number; texts: string[] } | null>(
      context,
      `(() => {
         const items = Array.from(document.querySelectorAll('[data-testid="memo-item"]'))
         return { count: items.length, texts: items.map((el) => el.textContent || '') }
       })()`,
      (value) => value !== null && value.count === 1 && value.texts[0]?.includes(firstText) === true,
      12,
      200
    )
    const otherHidden = filtered !== null && filtered.texts.every((text) => !text.includes(secondText))

    // 清除筛选 → 两条都回来
    await evaluate(context, `window.__verify.click('[data-testid="memo-tag-clear"]')`)
    const cleared = await untilTrue(
      context,
      `Array.from(document.querySelectorAll('[data-testid="memo-item"]')).filter(
         (item) => (item.textContent || '').indexOf(${JSON.stringify(hotkeyMarker)}) >= 0).length >= 2`,
      12,
      250
    )

    // 置顶仍然有效（决定：只做标签，不做文件夹；置顶保留）
    const pinClicked = await evaluate<boolean>(
      context,
      `(() => {
         const row = document.querySelector(${JSON.stringify(rowSelector)})
         const pin = row && row.querySelector('[data-testid="memo-pin"]')
         if (!pin) return false
         pin.click()
         return true
       })()`
    )
    const pinnedFirst = await untilTrue(
      context,
      `(() => {
         const first = document.querySelector('[data-testid="memo-item"]')
         return !!first &&
           first.getAttribute('data-memo-id') === ${JSON.stringify(firstId)} &&
           first.getAttribute('data-pinned') === '1'
       })()`,
      14,
      250
    )

    record({
      id: 'P8-L11',
      prd: 'FEAT-004',
      name: '备忘标签：菜单「添加标签」能加、行上看得见、工具条能按标签筛选（不命中的消失、清除后回来）；置顶仍然有效，没有做文件夹',
      passed:
        menuClicked &&
        drawerOpen &&
        saveClicked &&
        drawerClosed &&
        tagsStored &&
        rowTagsShown &&
        optionShown &&
        filtered !== null &&
        otherHidden &&
        cleared &&
        pinClicked &&
        pinnedFirst,
      detail: `菜单点「添加标签」=${menuClicked} 抽屉打开=${drawerOpen} 写入标签="${tag}" 保存=${saveClicked} 抽屉关闭=${drawerClosed}；落库 tags=${JSON.stringify(storedMemo?.['tags'] ?? null)}；行上显示标签=${rowTagsShown} 工具条出现筛选项=${optionShown}；点筛选后剩 ${filtered?.count ?? '（没等到）'} 条且只有甲=${otherHidden}；清除筛选后两条都回来=${cleared}；置顶=${pinClicked}（甲排到最前=${pinnedFirst}）`
    })
  } catch (error) {
    record({
      id: 'P8-L11',
      prd: 'FEAT-004',
      name: '备忘标签：菜单「添加标签」能加、行上看得见、工具条能按标签筛选（不命中的消失、清除后回来）；置顶仍然有效，没有做文件夹',
      passed: false,
      detail: `${String(error)}；${diagnostics()}`
    })
  }

  // =========================================================================
  // 第 10 块：复习页重构（`docs\TASKS\10` · `MASTER.md` §7.6 + §14 决定 17–21）
  //
  //   左栏主题（学习主题 + 读书的书）→ 预览 → 「开始复习这个主题」→ 下方树
  //   资料 → 章节 → 卡片；卡片行带三色到期圆点，点一下就地背卡。
  //
  // 两个防漏出口（R1 已定）：导航角标 + 顶部汇总横条 —— **两者必须是同一个数**，
  // 少了任何一个，漏复习就又变成**静默**的。
  //
  // 硬规矩照旧：轮询等待、自带前提、先复位再操作、受控组件用原生 setter。
  // 样本一律带 `${reviewMarker}` 前缀，断言只认自己造的这几条。
  // =========================================================================
  const reviewMarker = `${marker} 复习`

  /** 复习模块里的卡片（规范成 ReviewCard，期望值一律由它自己算） */
  const reviewCardsNormalized = async (): Promise<ReviewCard[]> =>
    (await reviewCards(context))
      .map((record) => normalizeReviewCard(record))
      .filter((card): card is ReviewCard => card !== null && card.front !== '')

  /**
   * 本块的样本（现场造，不依赖别处留下的状态）：
   *   - 一个学习主题：资料 → 章 → 节（三层树）
   *   - 四张卡：今天到期 ×2（其中一张不挂章节）/ 快到期（+2 天）/ 今天不用（+30 天）
   *   - 一个**一张卡都没有**的主题：用来验"已清显示「—」"
   */
  const fixtureTopicTitle = `${reviewMarker} 主题（第${passNumber}趟）`
  const fixtureEmptyTitle = `${reviewMarker} 空主题（第${passNumber}趟）`
  const fixture = { topicId: '', emptyTopicId: '', materialId: '', chapterId: '', sectionId: '' }
  const fixtureCards = { due: '', soon: '', later: '', unfiled: '' }
  let fixtureError = ''
  try {
    const built = await evaluate<{
      topicId: string
      emptyTopicId: string
      materialId: string
      chapterId: string
      sectionId: string
    }>(
      context,
      `(async () => {
         const topic = await window.api.data.add('learning', {
           kind: 'topic', title: ${JSON.stringify(fixtureTopicTitle)}, status: 'active', progress: 0
         })
         const empty = await window.api.data.add('learning', {
           kind: 'topic', title: ${JSON.stringify(fixtureEmptyTitle)}, status: 'active', progress: 0
         })
         const material = await window.api.data.add('learning', {
           kind: 'node', ownerId: topic.id, topicId: topic.id, parentId: null, order: 0,
           title: '资料甲', resourceType: '书', group: '教材', done: false
         })
         const chapter = await window.api.data.add('learning', {
           kind: 'node', ownerId: topic.id, topicId: topic.id, parentId: material.id, order: 0,
           title: '第一章', done: false
         })
         const section = await window.api.data.add('learning', {
           kind: 'node', ownerId: topic.id, topicId: topic.id, parentId: chapter.id, order: 0,
           title: '1.1 位与字节', done: false
         })
         await window.api.data.flush()
         return {
           topicId: topic.id, emptyTopicId: empty.id,
           materialId: material.id, chapterId: chapter.id, sectionId: section.id
         }
       })()`
    )
    Object.assign(fixture, built)

    const builtCards = await evaluate<{
      due: string
      soon: string
      later: string
      unfiled: string
    }>(
      context,
      `(async () => {
         const base = {
           source: ${JSON.stringify(fixtureTopicTitle)},
           topicId: ${JSON.stringify(built.topicId)},
           stage: 0,
           reviewCount: 0,
           lastReviewedAt: null
         }
         const due = await window.api.data.add('review', {
           ...base, nodeId: ${JSON.stringify(built.sectionId)},
           front: ${JSON.stringify(`${reviewMarker} 今天到期`)}, back: ${JSON.stringify(`${reviewMarker} 今天到期的答案`)},
           dueDate: ${JSON.stringify(todayKey)}
         })
         const soon = await window.api.data.add('review', {
           ...base, nodeId: ${JSON.stringify(built.sectionId)},
           front: ${JSON.stringify(`${reviewMarker} 快到期`)}, back: ${JSON.stringify(`${reviewMarker} 快到期的答案`)},
           dueDate: ${JSON.stringify(addDaysToKey(todayKey, 2))}
         })
         const later = await window.api.data.add('review', {
           ...base, nodeId: ${JSON.stringify(built.sectionId)},
           front: ${JSON.stringify(`${reviewMarker} 今天不用`)}, back: ${JSON.stringify(`${reviewMarker} 今天不用的答案`)},
           dueDate: ${JSON.stringify(addDaysToKey(todayKey, 30))}
         })
         const unfiled = await window.api.data.add('review', {
           ...base,
           front: ${JSON.stringify(`${reviewMarker} 没挂章节`)}, back: ${JSON.stringify(`${reviewMarker} 没挂章节的答案`)},
           dueDate: ${JSON.stringify(todayKey)}
         })
         await window.api.data.flush()
         return { due: due.id, soon: soon.id, later: later.id, unfiled: unfiled.id }
       })()`
    )
    Object.assign(fixtureCards, builtCards)
    await evaluate(
      context,
      `window.dispatchEvent(new CustomEvent('worklife:data-changed', { detail: { module: 'review' } })), true`
    )
    await wait(400)
  } catch (error) {
    fixtureError = String(error)
  }

  /** 把某张卡复位成"指定到期日、阶段 0、没复习过"（先复位再操作，硬规矩第 3 条） */
  const resetReviewCard = async (cardId: string, dueDate: string, stage = 0): Promise<void> => {
    if (cardId === '') return
    await evaluate(
      context,
      `window.api.data.update('review', ${JSON.stringify(cardId)}, {
         dueDate: ${JSON.stringify(dueDate)}, stage: ${stage}, reviewCount: 0, lastReviewedAt: null
       })`
    )
    await evaluate(context, `window.api.data.flush()`)
    await evaluate(
      context,
      `window.dispatchEvent(new CustomEvent('worklife:data-changed', { detail: { module: 'review' } })), true`
    )
    await wait(300)
  }

  // ---- R1 顶部汇总横条：总数 = 各主题到期数之和（防漏的核心不变量） ----
  try {
    if (fixtureError !== '') throw new Error(`样本没造出来：${fixtureError}`)
    await openReviewIdle(context)
    const cardsNow = await reviewCardsNormalized()
    const expectedDue = dueQueue(cardsNow, todayKey).length

    interface SummarySnapshot {
      totalText: string
      due: number
      topicDueTotal: number
      sidebarSum: number
      topicCount: number
      distribution: string
    }
    const snapshot = await until<SummarySnapshot | null>(
      context,
      `(() => {
         const summary = window.__verify.byTestId('review-summary')
         if (!summary) return null
         const rows = Array.from(document.querySelectorAll('[data-testid="review-topic"]'))
         const sidebarSum = rows.reduce((sum, row) => sum + Number(row.getAttribute('data-due') || '0'), 0)
         return {
           totalText: ((window.__verify.byTestId('review-summary-total') || {}).textContent || '').trim(),
           due: Number(summary.getAttribute('data-due') || '-1'),
           topicDueTotal: Number(summary.getAttribute('data-topic-due-total') || '-1'),
           sidebarSum,
           topicCount: rows.length,
           distribution: ((window.__verify.byTestId('review-summary-topics') || {}).textContent || '').trim()
         }
       })()`,
      (value) => value !== null && value.sidebarSum === expectedDue,
      14,
      250
    )
    const totalOk = (snapshot?.totalText ?? '').includes(`今天到期 ${expectedDue} 张`)

    record({
      id: 'P8-U1',
      prd: 'R1/决定19',
      name: '顶部汇总横条在：总数 = 各主题到期数之和 = 到期队列（防漏的核心不变量），并写清各主题分布',
      passed:
        snapshot !== null &&
        snapshot.due === expectedDue &&
        snapshot.topicDueTotal === expectedDue &&
        snapshot.sidebarSum === expectedDue &&
        snapshot.topicCount > 0 &&
        totalOk,
      detail: `横条文案="${snapshot?.totalText ?? '（没找到）'}"（按数据算 ${expectedDue} 张，文案对=${totalOk}）；横条 data-due=${snapshot?.due ?? '?'} data-topic-due-total=${snapshot?.topicDueTotal ?? '?'}；左栏 ${snapshot?.topicCount ?? 0} 个主题的到期数相加=${snapshot?.sidebarSum ?? '?'}；分布="${snapshot?.distribution ?? ''}"`
    })
  } catch (error) {
    record({
      id: 'P8-U1',
      prd: 'R1/决定19',
      name: '顶部汇总横条在：总数 = 各主题到期数之和 = 到期队列（防漏的核心不变量），并写清各主题分布',
      passed: false,
      detail: `${String(error)}；${diagnostics()}`
    })
  }

  // ---- R2 「汇总复习（N）」可点，按到期顺序逐张过 ----
  try {
    if (fixtureError !== '') throw new Error(`样本没造出来：${fixtureError}`)
    await openReviewIdle(context)
    const order = dueQueue(await reviewCardsNormalized(), todayKey).map((card) => card.id)
    if (order.length < 2) throw new Error(`到期卡片不足两张（只有 ${order.length} 张），验不了"逐张过"`)

    const clicked = await evaluate<boolean>(
      context,
      `(() => {
         const button = document.querySelector('[data-testid="review-summary-start"]')
         if (!button) return false
         button.click()
         return true
       })()`
    )
    const readCardId = `(() => {
      const card = window.__verify.byTestId('review-card')
      return card ? card.getAttribute('data-card-id') || '' : ''
    })()`
    const first = await until<string>(context, readCardId, (value) => value !== '' && value === order[0], 12, 250)
    // 空格显示答案 → 1（忘了）→ 翻下一张
    await pressKeyOn(context, ' ')
    await wait(250)
    await pressKeyOn(context, '1')
    const second = await until<string>(
      context,
      readCardId,
      (value) => value !== '' && value !== order[0],
      14,
      250
    )
    await pressKeyOn(context, 'Escape')
    const sessionClosed = await untilTrue(context, `!window.__verify.exists('review-session')`, 10, 200)

    record({
      id: 'P8-U2',
      prd: 'R1/决定19',
      name: '「汇总复习（N）」按钮可点：进入一屏一张卡的队列，并按到期顺序逐张过（空格→1 即翻下一张）',
      passed: clicked && first === order[0] && second === order[1] && sessionClosed,
      detail: `点按钮=${clicked}；第一张=${first || '（没出现）'}（期望到期顺序第一张 ${order[0]}）；按空格+1 后翻到=${second || '（没出现）'}（期望 ${order[1]}）；Esc 退出会话=${sessionClosed}`
    })
  } catch (error) {
    record({
      id: 'P8-U2',
      prd: 'R1/决定19',
      name: '「汇总复习（N）」按钮可点：进入一屏一张卡的队列，并按到期顺序逐张过（空格→1 即翻下一张）',
      passed: false,
      detail: `${String(error)}；${diagnostics()}`
    })
  }

  // ---- R3 导航「复习」带角标；侧栏收起时缩成小角标 ----
  try {
    await openReviewIdle(context)
    const expectedDue = dueQueue(await reviewCardsNormalized(), todayKey).length
    const expectedBadge = expectedDue > 99 ? '99+' : String(expectedDue)

    interface BadgeSnapshot {
      badge: string
      badgeWidth: number
      summaryDue: number
      navVisible: boolean
      collapsed: string
    }
    const badgeExpr = `(() => {
       const nav = document.querySelector('[data-nav-id="review"]')
       if (!nav) return null
       const dot = nav.querySelector('.nav__badge')
       const rect = nav.getBoundingClientRect()
       return {
         badge: dot ? (dot.textContent || '').trim() : '',
         badgeWidth: dot ? Math.round(dot.getBoundingClientRect().width) : -1,
         summaryDue: Number((window.__verify.byTestId('review-summary') || { getAttribute: () => '-1' }).getAttribute('data-due')),
         navVisible: rect.width > 0 && rect.height > 0,
         collapsed: (window.__verify.byTestId('sidebar') || { getAttribute: () => '' }).getAttribute('data-collapsed') || ''
       }
     })()`

    const expanded = await until<BadgeSnapshot | null>(
      context,
      badgeExpr,
      (value) => value !== null && value.badge === expectedBadge,
      14,
      250
    )

    // 收起侧栏 → 数字变成一个 8px 的小圆点（还看得见"有到期"，但放不下数字）
    await evaluate(context, `window.__verify.click('[data-testid="sidebar-collapse"]')`)
    const collapsed = await until<BadgeSnapshot | null>(
      context,
      badgeExpr,
      (value) => value !== null && value.collapsed === '1' && value.badgeWidth > 0 && value.badgeWidth <= 12,
      12,
      250
    )
    // 展开回来：别把"侧栏是收起的"留给后面的检查去猜
    await evaluate(context, `window.__verify.click('[data-testid="sidebar-collapse"]')`)
    const restored = await untilTrue(
      context,
      `(window.__verify.byTestId('sidebar') || { getAttribute: () => '' }).getAttribute('data-collapsed') === '0'`,
      10,
      200
    )

    record({
      id: 'P8-U3',
      prd: 'R1/决定19',
      name: '导航「复习」带数字角标，数值与汇总横条的总数一致；侧栏收起时缩成小圆点（仍然看得见有到期）',
      passed:
        expectedDue > 0 &&
        expanded !== null &&
        expanded.badge === expectedBadge &&
        expanded.summaryDue === expectedDue &&
        collapsed !== null &&
        collapsed.badgeWidth <= 12 &&
        collapsed.navVisible &&
        restored,
      detail: `按数据算到期 ${expectedDue} 张；展开时角标="${expanded?.badge ?? '（没等到）'}"（期望 ${expectedBadge}）宽 ${expanded?.badgeWidth ?? '?'}px，横条 data-due=${expanded?.summaryDue ?? '?'}；收起后角标宽 ${collapsed?.badgeWidth ?? '?'}px（≤12 即缩成小圆点），导航项仍可见=${collapsed?.navVisible ?? '?'}；已展开回来=${restored}`
    })
  } catch (error) {
    record({
      id: 'P8-U3',
      prd: 'R1/决定19',
      name: '导航「复习」带数字角标，数值与汇总横条的总数一致；侧栏收起时缩成小圆点（仍然看得见有到期）',
      passed: false,
      detail: `${String(error)}；${diagnostics()}`
    })
  }

  // ---- R4 左栏每项右侧显示自己的到期数；已清显示「—」 ----
  try {
    if (fixtureError !== '') throw new Error(`样本没造出来：${fixtureError}`)
    await openReviewIdle(context)
    interface TopicRowSnapshot {
      key: string
      due: number
      cards: number
      badge: string
      meta: string
      active: string
    }
    const rows = await until<TopicRowSnapshot[] | null>(
      context,
      `(() => {
         const list = Array.from(document.querySelectorAll('[data-testid="review-topic"]'))
         if (list.length === 0) return null
         return list.map((row) => ({
           key: row.getAttribute('data-topic-key') || '',
           due: Number(row.getAttribute('data-due') || '0'),
           cards: Number(row.getAttribute('data-cards') || '0'),
           badge: ((row.querySelector('[data-testid="review-topic-due"]') || {}).textContent || '').trim(),
           meta: ((row.querySelector('[data-testid="review-topic-meta"]') || {}).textContent || '').trim(),
           active: row.getAttribute('data-active') || ''
         }))
       })()`,
      (value) => value !== null && value.length > 0,
      14,
      250
    )
    const expectedByKey = await evaluate<Record<string, number>>(context, `(window.__reviewTopicDue || {})`)
    const badBadges = (rows ?? []).filter(
      (row) => row.badge !== (row.due > 0 ? String(row.due) : '—')
    )
    const badTotals = (rows ?? []).filter(
      (row) => row.due !== Number(expectedByKey[row.key] ?? -1)
    )
    const fixtureRow = (rows ?? []).find((row) => row.key === `topic:${fixture.topicId}`)
    const emptyRow = (rows ?? []).find((row) => row.key === `topic:${fixture.emptyTopicId}`)
    const withDue = (rows ?? []).filter((row) => row.due > 0).length
    const cleared = (rows ?? []).filter((row) => row.due === 0).length

    record({
      id: 'P8-U4',
      prd: '§6.2/决定19',
      name: '左栏每一个主题右侧都是**它自己的**到期数；已经清掉的主题显示「—」（不是 0、不是空白）',
      passed:
        rows !== null &&
        badBadges.length === 0 &&
        badTotals.length === 0 &&
        withDue > 0 &&
        cleared > 0 &&
        fixtureRow !== undefined &&
        emptyRow !== undefined &&
        emptyRow.badge === '—' &&
        emptyRow.cards === 0,
      detail: `共 ${rows?.length ?? 0} 个主题行；有到期的 ${withDue} 个、已清（显示「—」）的 ${cleared} 个；数字与 data-due 不符的有 ${badBadges.length} 行、与页面算的到期数不符的有 ${badTotals.length} 行；本块样本主题：到期 ${fixtureRow?.due ?? '?'} 张 / 副标题="${fixtureRow?.meta ?? ''}"；空主题：卡片 ${emptyRow?.cards ?? '?'} 张 → 显示"${emptyRow?.badge ?? ''}"（期望「—」）`
    })
  } catch (error) {
    record({
      id: 'P8-U4',
      prd: '§6.2/决定19',
      name: '左栏每一个主题右侧都是**它自己的**到期数；已经清掉的主题显示「—」（不是 0、不是空白）',
      passed: false,
      detail: `${String(error)}；${diagnostics()}`
    })
  }

  // ---- R5 树里卡片行有圆点状态，三色可区分 ----
  try {
    if (fixtureError !== '') throw new Error(`样本没造出来：${fixtureError}`)
    // 先复位三张样本卡的到期日（前面的检查可能评过分）
    await resetReviewCard(fixtureCards.due, todayKey)
    await resetReviewCard(fixtureCards.soon, addDaysToKey(todayKey, 2))
    await resetReviewCard(fixtureCards.later, addDaysToKey(todayKey, 30))
    await openReviewIdle(context)
    const shown = await revealReviewCardRow(context, fixtureCards.due)

    interface DotSnapshot {
      state: string
      dotState: string
      color: string
      label: string
    }
    const readDots = `(() => {
       const ids = ${JSON.stringify([fixtureCards.due, fixtureCards.soon, fixtureCards.later])}
       const out = []
       for (const id of ids) {
         const row = document.querySelector('[data-testid="review-card-row"][data-card-id="' + id + '"]')
         if (!row) return null
         const dot = row.querySelector('[data-testid="review-card-state"]')
         out.push({
           state: row.getAttribute('data-state') || '',
           dotState: dot ? dot.getAttribute('data-state') || '' : '',
           color: dot ? getComputedStyle(dot).backgroundColor : '',
           label: ((row.querySelector('[data-testid="review-card-state-label"]') || {}).textContent || '').trim()
         })
       }
       return out
     })()`
    const dots = await until<DotSnapshot[] | null>(
      context,
      readDots,
      (value) => value !== null && value.every((item) => item.state !== ''),
      14,
      250
    )
    const states = (dots ?? []).map((item) => item.state)
    const colors = (dots ?? []).map((item) => item.color)
    const distinct = new Set(colors).size === 3 && colors.every((color) => color !== '' && color !== 'rgba(0, 0, 0, 0)')
    const labelsOk = (dots ?? []).every(
      (item) => item.label === (item.state === 'due' ? '今天到期' : item.state === 'soon' ? '快到期' : '今天不用')
    )

    record({
      id: 'P8-U5',
      prd: '§6.5/决定18',
      name: '树里的卡片行带到期状态圆点：今天到期 / 快到期 / 今天不用 三态判定正确，且三种颜色互不相同',
      passed:
        shown &&
        dots !== null &&
        states[0] === 'due' &&
        states[1] === 'soon' &&
        states[2] === 'later' &&
        distinct &&
        labelsOk,
      detail: `样本卡渲染=${shown}；三张卡的状态=${JSON.stringify(states)}（期望 ["due","soon","later"]）、圆点颜色=${JSON.stringify(colors)}（三种互不相同=${distinct}）、行上的状态字=${JSON.stringify((dots ?? []).map((item) => item.label))}（与状态一致=${labelsOk}）`
    })
  } catch (error) {
    record({
      id: 'P8-U5',
      prd: '§6.5/决定18',
      name: '树里的卡片行带到期状态圆点：今天到期 / 快到期 / 今天不用 三态判定正确，且三种颜色互不相同',
      passed: false,
      detail: `${String(error)}；${diagnostics()}`
    })
  }

  // ---- R6 点卡片就地展开：正面 → 显示答案 → 三档按钮（不跳页、不进队列） ----
  try {
    if (fixtureError !== '') throw new Error(`样本没造出来：${fixtureError}`)
    await resetReviewCard(fixtureCards.due, todayKey)
    await openReviewIdle(context)
    const shown = await revealReviewCardRow(context, fixtureCards.due)
    const viewBefore = await evaluate<string>(context, `window.__verify.activeView()`)
    const expanded = await expandCardRow(context, fixtureCards.due)
    const beforeReveal = await until<{
      front: string
      hasBack: boolean
      grades: number
      session: boolean
      view: string
      hasMenu: boolean
    } | null>(
      context,
      `(() => {
         const box = document.querySelector('[data-testid="inline-card-review"][data-card-id="${fixtureCards.due}"]')
         if (!box) return null
         const row = document.querySelector('[data-testid="review-card-row"][data-card-id="${fixtureCards.due}"]')
         return {
           front: ((box.querySelector('[data-testid="inline-card-front"]') || {}).textContent || '').trim(),
           hasBack: !!box.querySelector('[data-testid="inline-card-back"]'),
           grades: box.querySelectorAll('[data-testid^="inline-grade-"]').length,
           session: window.__verify.exists('review-session'),
           view: window.__verify.activeView(),
           hasMenu: !!row && !!row.querySelector('[data-testid="card-menu"]')
         }
       })()`,
      (value) => value !== null,
      12,
      200
    )
    const revealClicked = await evaluate<boolean>(
      context,
      `(() => {
         const button = document.querySelector('[data-testid="inline-card-reveal"]')
         if (!button) return false
         button.click()
         return true
       })()`
    )
    const afterReveal = await until<{ back: string; grades: number; session: boolean } | null>(
      context,
      `(() => {
         const box = document.querySelector('[data-testid="inline-card-review"][data-card-id="${fixtureCards.due}"]')
         if (!box) return null
         return {
           back: ((box.querySelector('[data-testid="inline-card-back"]') || {}).textContent || '').trim(),
           grades: box.querySelectorAll('[data-testid^="inline-grade-"]').length,
           session: window.__verify.exists('review-session')
         }
       })()`,
      (value) => value !== null && value.grades === 3,
      12,
      200
    )
    // 点"忘了"：卡片当场推进，但仍留在原地（不跳页、不进队列）
    const intensityNow = await effectiveIntensity(context)
    const expected = applyGrade({ stage: 0, reviewCount: 0 }, 'forgot', todayKey, intensityNow)
    await evaluate(
      context,
      `(() => {
         const button = document.querySelector('[data-testid="inline-grade-forgot"]')
         if (button) button.click()
         return true
       })()`
    )
    const stored = await untilTrue(
      context,
      `(async () => {
         const records = await window.api.data.listAlive('review')
         const card = records.find((item) => item['id'] === ${JSON.stringify(fixtureCards.due)})
         return !!card && Number(card['reviewCount']) === ${expected.reviewCount} &&
           String(card['dueDate']) === ${JSON.stringify(expected.dueDate)}
       })()`,
      14,
      250
    )
    const afterGrade = await until<{ stillExpanded: boolean; grades: number; session: boolean } | null>(
      context,
      `(() => {
         const box = document.querySelector('[data-testid="inline-card-review"][data-card-id="${fixtureCards.due}"]')
         return {
           stillExpanded: !!box,
           grades: box ? box.querySelectorAll('[data-testid^="inline-grade-"]').length : 0,
           session: window.__verify.exists('review-session')
         }
       })()`,
      (value) => value !== null && value.stillExpanded && value.grades === 0,
      14,
      250
    )

    record({
      id: 'P8-U6',
      prd: '决定18',
      name: '点树里的卡片就地展开背卡：正面 → 「显示答案」→ 三档评分；不跳页、不进独立队列，评分当场落库',
      passed:
        shown &&
        viewBefore === 'review' &&
        expanded &&
        beforeReveal?.front === `${reviewMarker} 今天到期` &&
        beforeReveal?.hasBack === false &&
        beforeReveal?.grades === 0 &&
        beforeReveal?.hasMenu === true &&
        revealClicked &&
        afterReveal?.back === `${reviewMarker} 今天到期的答案` &&
        afterReveal?.grades === 3 &&
        afterReveal?.session === false &&
        stored &&
        afterGrade !== null &&
        afterGrade.stillExpanded &&
        afterGrade.grades === 0 &&
        afterGrade.session === false,
      detail: `卡片行=${shown} 点之前视图=${viewBefore}；就地展开=${expanded} 展开时正面="${beforeReveal?.front ?? ''}" 此时有背面=${beforeReveal?.hasBack ?? '?'} 按钮=${beforeReveal?.grades ?? '?'} 行上有 ⋯ 菜单=${beforeReveal?.hasMenu ?? '?'}；显示答案后背面="${afterReveal?.back ?? ''}" 三档按钮=${afterReveal?.grades ?? '?'} 会话=${afterReveal?.session ?? '?'}；点"忘了"→ 次数 ${expected.reviewCount} / 到期 ${expected.dueDate} 落库=${stored}；评完仍展开=${afterGrade?.stillExpanded ?? '?'} 按钮收起=${afterGrade?.grades === 0}（期望 0）`
    })
  } catch (error) {
    record({
      id: 'P8-U6',
      prd: '决定18',
      name: '点树里的卡片就地展开背卡：正面 → 「显示答案」→ 三档评分；不跳页、不进独立队列，评分当场落库',
      passed: false,
      detail: `${String(error)}；${diagnostics()}`
    })
  }

  // ---- R7 键盘 空格 / 1 / 2 / 3 在就地背卡上可用 ----
  try {
    if (fixtureError !== '') throw new Error(`样本没造出来：${fixtureError}`)
    await resetReviewCard(fixtureCards.soon, todayKey)
    await openReviewIdle(context)
    const shown = await revealReviewCardRow(context, fixtureCards.soon)
    const expanded = await expandCardRow(context, fixtureCards.soon)
    const noSession = await evaluate<boolean>(context, `!window.__verify.exists('review-session')`)

    // 空格 → 显示答案
    await pressKeyOn(context, ' ')
    const revealed = await untilTrue(
      context,
      `!!document.querySelector('[data-testid="inline-card-review"][data-card-id="${fixtureCards.soon}"] [data-testid="inline-card-back"]')`,
      12,
      200
    )
    // 2 → 有点模糊（再按一次 2 同样生效，这里只验一次落库口径）
    const intensityNow = await effectiveIntensity(context)
    const expected = applyGrade({ stage: 0, reviewCount: 0 }, 'fuzzy', todayKey, intensityNow)
    await pressKeyOn(context, '2')
    const fuzzyStored = await untilTrue(
      context,
      `(async () => {
         const records = await window.api.data.listAlive('review')
         const card = records.find((item) => item['id'] === ${JSON.stringify(fixtureCards.soon)})
         return !!card && Number(card['reviewCount']) === ${expected.reviewCount} &&
           String(card['dueDate']) === ${JSON.stringify(expected.dueDate)}
       })()`,
      14,
      250
    )
    const backGone = await untilTrue(
      context,
      `!document.querySelector('[data-testid="inline-card-review"][data-card-id="${fixtureCards.soon}"] [data-testid="inline-card-back"]')`,
      10,
      200
    )
    // 3 → 记住了（键盘三档都要能走）
    await pressKeyOn(context, ' ')
    const revealedAgain = await untilTrue(
      context,
      `!!document.querySelector('[data-testid="inline-card-review"][data-card-id="${fixtureCards.soon}"] [data-testid="inline-card-back"]')`,
      12,
      200
    )
    const expectedRemembered = applyGrade({ stage: 0, reviewCount: 1 }, 'remembered', todayKey, intensityNow)
    await pressKeyOn(context, '3')
    const rememberedStored = await untilTrue(
      context,
      `(async () => {
         const records = await window.api.data.listAlive('review')
         const card = records.find((item) => item['id'] === ${JSON.stringify(fixtureCards.soon)})
         return !!card && Number(card['stage']) === ${expectedRemembered.stageAfter} &&
           Number(card['reviewCount']) === ${expectedRemembered.reviewCount}
       })()`,
      14,
      250
    )
    // 1 → 忘了（三档齐了；1 与 2/3 同一套判断，这里顺带确认它没有把卡切走）
    await pressKeyOn(context, ' ')
    const revealedThird = await untilTrue(
      context,
      `!!document.querySelector('[data-testid="inline-card-review"][data-card-id="${fixtureCards.soon}"] [data-testid="inline-card-back"]')`,
      12,
      200
    )
    const expectedForgot = applyGrade(
      { stage: expectedRemembered.stageAfter, reviewCount: expectedRemembered.reviewCount },
      'forgot',
      todayKey,
      intensityNow
    )
    await pressKeyOn(context, '1')
    const forgotStored = await untilTrue(
      context,
      `(async () => {
         const records = await window.api.data.listAlive('review')
         const card = records.find((item) => item['id'] === ${JSON.stringify(fixtureCards.soon)})
         return !!card && Number(card['stage']) === 0 &&
           Number(card['reviewCount']) === ${expectedForgot.reviewCount}
       })()`,
      14,
      250
    )
    const stillOnTree = await evaluate<boolean>(
      context,
      `window.__verify.activeView() === 'review' && !window.__verify.exists('review-session')`
    )
    // 失败时能看出"到底差在哪"：把卡片最终的三个读数一起带回报告（诊断用，不参与判据）
    const finalCard = await evaluate<{ stage: number; count: number; due: string } | null>(
      context,
      `(async () => {
         const records = await window.api.data.listAlive('review')
         const card = records.find((item) => item['id'] === ${JSON.stringify(fixtureCards.soon)})
         return card
           ? { stage: Number(card['stage']), count: Number(card['reviewCount']), due: String(card['dueDate']) }
           : null
       })()`
    )

    record({
      id: 'P8-U7',
      prd: '决定18/§6.5',
      name: '就地背卡的键盘可用：空格显示答案，1 / 2 / 3 三档评分（全程不进会话队列、不跳页）',
      passed:
        shown &&
        expanded &&
        noSession &&
        revealed &&
        fuzzyStored &&
        backGone &&
        revealedAgain &&
        rememberedStored &&
        revealedThird &&
        forgotStored &&
        stillOnTree,
      detail: `卡片行=${shown} 就地展开=${expanded} 没有会话=${noSession}；空格显示答案=${revealed} → 按 2（有点模糊）落库=${fuzzyStored}（期望次数 ${expected.reviewCount} / 到期 ${expected.dueDate}）评完背面收起=${backGone}；再空格=${revealedAgain} → 按 3（记住了）落库=${rememberedStored}（阶段→${expectedRemembered.stageAfter}）；再空格=${revealedThird} → 按 1（忘了）落库=${forgotStored}（期望阶段 0 / 次数 ${expectedForgot.reviewCount}，实际 ${
        finalCard === null ? '卡片不存在' : `阶段 ${finalCard.stage} / 次数 ${finalCard.count} / 到期 ${finalCard.due}`
      }）；仍在复习页且不在会话=${stillOnTree}`
    })
  } catch (error) {
    record({
      id: 'P8-U7',
      prd: '决定18/§6.5',
      name: '就地背卡的键盘可用：空格显示答案，1 / 2 / 3 三档评分（全程不进会话队列、不跳页）',
      passed: false,
      detail: `${String(error)}；${diagnostics()}`
    })
  }

  // ---- R8 中区两块固定高度、各自内部滚；树吃满剩余高度 ----
  try {
    if (fixtureError !== '') throw new Error(`样本没造出来：${fixtureError}`)
    await resetReviewCard(fixtureCards.due, todayKey)
    await openReviewIdle(context)
    await revealReviewCardRow(context, fixtureCards.due)

    interface LayoutSnapshot {
      cardCount: number
      cardHeights: number[]
      bodyOverflows: string[]
      bodyHasScrollbar: number
      mainHeight: number
      mainBottom: number
      contentBottom: number
      treeOverflow: string
      treeClientHeight: number
      treeScrollHeight: number
    }
    const layout = await until<LayoutSnapshot | null>(
      context,
      `(() => {
         const cards = Array.from(document.querySelectorAll('.band-card'))
         const bodies = Array.from(document.querySelectorAll('.band-card__body'))
         const main = document.querySelector('[data-testid="bands-main"]')
         const content = document.querySelector('.page__content')
         const tree = document.querySelector('[data-testid="review-tree"]')
         if (!main || !content || !tree || cards.length === 0) return null
         const mainRect = main.getBoundingClientRect()
         const contentRect = content.getBoundingClientRect()
         return {
           cardCount: cards.length,
           cardHeights: cards.map((el) => Math.round(el.getBoundingClientRect().height)),
           bodyOverflows: bodies.map((el) => getComputedStyle(el).overflowY),
           bodyHasScrollbar: bodies.filter((el) => el.scrollHeight > el.clientHeight + 1).length,
           mainHeight: Math.round(mainRect.height),
           mainBottom: Math.round(mainRect.bottom),
           contentBottom: Math.round(contentRect.bottom),
           treeOverflow: getComputedStyle(tree).overflowY,
           treeClientHeight: tree.clientHeight,
           treeScrollHeight: tree.scrollHeight
         }
       })()`,
      (value) => value !== null,
      14,
      250
    )
    const heightsOk = (layout?.cardHeights ?? []).every((height) => Math.abs(height - 132) <= 1)
    /*
     * 2026-10 修订：下区不再"吃满剩余高度、内部滚"，改成**按内容高、跟随整页往下翻**。
     * 所以这里判的是"树不再内部滚"（旧口径的 `mainBottom ≈ contentBottom` 与
     * `treeOverflow === 'auto'` 已经作废——不变的是中区两块那 132px）。
     */
    const treeNotInternalScroll =
      layout !== null &&
      (layout.treeOverflow === 'visible' || layout.treeOverflow === '') &&
      layout.treeScrollHeight <= layout.treeClientHeight + 1
    const mainGrowsWithContent = layout !== null && layout.mainHeight > 0

    record({
      id: 'P8-U8',
      prd: '§7.2',
      name: '中区两块固定 132px、各自内部滚；下区的树按内容高、不再内部滚（滚轮规矩 2026-10 修订：下区跟随整页翻）',
      passed:
        layout !== null &&
        layout.cardCount === 2 &&
        heightsOk &&
        layout.bodyOverflows.every((value) => value === 'auto' || value === 'scroll') &&
        mainGrowsWithContent &&
        treeNotInternalScroll,
      detail: `中区 ${layout?.cardCount ?? 0} 块（期望 2），高度=${JSON.stringify(layout?.cardHeights ?? [])}px（期望都≈132±1=${heightsOk}），各自 overflow=${JSON.stringify(layout?.bodyOverflows ?? [])}，其中真的需要滚的 ${layout?.bodyHasScrollbar ?? 0} 块；下区主体高=${layout?.mainHeight ?? '?'}（按内容高=${mainGrowsWithContent}，底边=${layout?.mainBottom ?? '?'} 内容区底边=${layout?.contentBottom ?? '?'}——**不再要求对齐**）；树 overflow=${layout?.treeOverflow ?? ''} 可视 ${layout?.treeClientHeight ?? '?'} / 内容 ${layout?.treeScrollHeight ?? '?'} 不再内部滚=${treeNotInternalScroll}`
    })
  } catch (error) {
    record({
      id: 'P8-U8',
      prd: '§7.2',
      name: '中区两块固定 132px、各自内部滚；下区的树按内容高、不再内部滚（滚轮规矩 2026-10 修订：下区跟随整页翻）',
      passed: false,
      detail: `${String(error)}；${diagnostics()}`
    })
  }

  // ---- R9 复习页的滚轮规矩（2026-10 修订：页面级仍零溢出，滚动发生在右侧内容区） ----
  try {
    if (fixtureError !== '') throw new Error(`样本没造出来：${fixtureError}`)
    await openReviewIdle(context)
    await revealReviewCardRow(context, fixtureCards.due)
    const view = await readModuleScroll(context)
    if (view === null) throw new Error('没等到复习页的三段骨架渲染出来')
    const verdict = judgeModuleScroll(view)
    record({
      id: 'P8-U9',
      prd: '§7.2',
      name: '复习页滚轮规矩（2026-10 修订）：页面级零滚动条、滚动发生在右侧内容区，左栏不跟着滚、中区两块仍 132px 内部滚',
      passed: verdict.passed,
      detail: verdict.detail
    })
  } catch (error) {
    record({
      id: 'P8-U9',
      prd: '§7.2',
      name: '复习页滚轮规矩（2026-10 修订）：页面级零滚动条、滚动发生在右侧内容区，左栏不跟着滚、中区两块仍 132px 内部滚',
      passed: false,
      detail: `${String(error)}；${diagnostics()}`
    })
  }

  // ---- R10 三步走：选中主题 → 预览（四要素 + 四按钮）→ 「开始复习这个主题」→ 下方展开树 ----
  try {
    if (fixtureError !== '') throw new Error(`样本没造出来：${fixtureError}`)
    await openReviewIdle(context)
    const clickedEmpty = await evaluate<boolean>(
      context,
      `(() => {
         const rows = Array.from(document.querySelectorAll('[data-testid="review-topic"]'))
         const row = rows.find((item) => item.getAttribute('data-topic-key') === ${JSON.stringify(`topic:${fixture.emptyTopicId}`)})
         if (!row) return false
         row.click()
         return true
       })()`
    )
    const beforeEnter = await until<{
      previewTop: number
      previewHeight: number
      entered: string
      cards: string
      mastered: string
      last: string
      next: string
      buttons: string[]
      treeShown: boolean
      lockedShown: boolean
    } | null>(
      context,
      `(() => {
         const preview = window.__verify.byTestId('review-detail')
         if (!preview) return null
         const rect = preview.getBoundingClientRect()
         const read = (id) => ((window.__verify.byTestId(id) || {}).textContent || '').trim()
         const buttons = ['review-enter-topic', 'review-preview-new-card', 'review-edit-topic', 'review-only-due']
           .filter((id) => !!window.__verify.byTestId(id))
         return {
           previewTop: Math.round(rect.top),
           previewHeight: Math.round(rect.height),
           entered: (window.__verify.byTestId('review-enter-topic') || { getAttribute: () => '' }).getAttribute('data-entered') || '',
           cards: read('review-fact-cards'),
           mastered: read('review-fact-mastered'),
           last: read('review-fact-last'),
           next: read('review-fact-next'),
           buttons,
           treeShown: window.__verify.exists('review-card-tree'),
           lockedShown: window.__verify.exists('review-tree-locked')
         }
       })()`,
      (value) => value !== null && value.entered === '0',
      12,
      200
    )

    // 开始复习这个主题 → 下方展开树，**预览与中区两块留在上面不动**
    await evaluate(context, `window.__verify.click('[data-testid="review-enter-topic"]')`)
    const afterEnter = await until<{
      previewTop: number
      previewHeight: number
      entered: string
      treeShown: boolean
      treeTop: number
      previewBottom: number
      bandCards: number
    } | null>(
      context,
      `(() => {
         const preview = window.__verify.byTestId('review-detail')
         const tree = window.__verify.byTestId('review-card-tree')
         if (!preview) return null
         const rect = preview.getBoundingClientRect()
         return {
           previewTop: Math.round(rect.top),
           previewHeight: Math.round(rect.height),
           entered: (window.__verify.byTestId('review-enter-topic') || { getAttribute: () => '' }).getAttribute('data-entered') || '',
           treeShown: !!tree,
           treeTop: tree ? Math.round(tree.getBoundingClientRect().top) : -1,
           previewBottom: Math.round(rect.bottom),
           bandCards: document.querySelectorAll('.band-card').length
         }
       })()`,
      (value) => value !== null && value.entered === '1' && value.treeShown,
      14,
      250
    )

    record({
      id: 'P8-U10',
      prd: '§6.7/决定1',
      name: '三步走：选中主题 → 预览（卡片总数/已掌握/上次复习/下次到期 + 四个按钮）→ 点「开始复习这个主题」→ 下方展开树，预览不整页替换',
      passed:
        clickedEmpty &&
        beforeEnter !== null &&
        beforeEnter.entered === '0' &&
        beforeEnter.treeShown === false &&
        beforeEnter.lockedShown === true &&
        beforeEnter.buttons.length === 4 &&
        /\d+ 张/.test(beforeEnter.cards) &&
        /%$/.test(beforeEnter.mastered) &&
        beforeEnter.last !== '' &&
        beforeEnter.next !== '' &&
        afterEnter !== null &&
        afterEnter.entered === '1' &&
        afterEnter.treeShown &&
        afterEnter.previewTop === beforeEnter.previewTop &&
        afterEnter.previewHeight === beforeEnter.previewHeight &&
        afterEnter.treeTop >= afterEnter.previewBottom - 1 &&
        afterEnter.bandCards === 2,
      detail: `选中主题=${clickedEmpty}；进入前：进入标记=${beforeEnter?.entered ?? '?'} 树在=${beforeEnter?.treeShown ?? '?'} 未进入提示=${beforeEnter?.lockedShown ?? '?'} 四个按钮=${JSON.stringify(beforeEnter?.buttons ?? [])} 卡片总数="${beforeEnter?.cards ?? ''}" 已掌握="${beforeEnter?.mastered ?? ''}" 上次复习="${beforeEnter?.last ?? ''}" 下次到期="${beforeEnter?.next ?? ''}"；点「开始复习这个主题」后：进入标记=${afterEnter?.entered ?? '?'} 树在=${afterEnter?.treeShown ?? '?'}；预览位置 ${beforeEnter?.previewTop ?? '?'}/${beforeEnter?.previewHeight ?? '?'} → ${afterEnter?.previewTop ?? '?'}/${afterEnter?.previewHeight ?? '?'}（都不许变）树顶 ${afterEnter?.treeTop ?? '?'} ≥ 预览底 ${afterEnter?.previewBottom ?? '?'}；中区仍是 ${afterEnter?.bandCards ?? '?'} 块`
    })
  } catch (error) {
    record({
      id: 'P8-U10',
      prd: '§6.7/决定1',
      name: '三步走：选中主题 → 预览（卡片总数/已掌握/上次复习/下次到期 + 四个按钮）→ 点「开始复习这个主题」→ 下方展开树，预览不整页替换',
      passed: false,
      detail: `${String(error)}；${diagnostics()}`
    })
  }

  // =========================================================================
  // 第 07 块：操作指南（`docs\TASKS\07` §6.3）
  //
  // 「数据与设置」页里的一个**独立分区**：左侧章节目录 + 右侧正文，点目录跳转，
  // 滚动时目录跟着换当前章；正文区自己滚（页面级无滚动条）；键盘键是 <kbd>。
  //
  // 硬规矩照旧：轮询等待、自带前提、先复位再操作、用对触发方式。
  // 这一块**只读界面**、不造数据；断言拿 `src\shared\guide.ts` 的数据当基准
  // （界面漏渲染一章 / 少渲染一颗 <kbd> 都会红）。
  // =========================================================================

  /** 把指南里的块拍平成文字（数"本该渲染多少颗 <kbd>"用；块类型与界面共用一份） */
  const guideBlockTexts = (block: GuideBlock): string[] => {
    if (block.kind === 'paragraph') return [block.text]
    if (block.kind === 'list') return block.items.map((item) => item.text)
    if (block.kind === 'table') return [...block.head, ...block.rows.flat()]
    if (block.kind === 'code') return [...block.lines]
    if (block.kind === 'quote') return [block.text]
    return [block.title]
  }

  /** 正文里应当渲染成 `<kbd>` 的片段总数（`isKeyboardKey` 说它是键的那些） */
  const guideExpectedKeys = (): number =>
    GUIDE.chapters.reduce(
      (chapterSum, chapter) =>
        chapterSum +
        chapter.blocks
          .flatMap(guideBlockTexts)
          .reduce(
            (sum, text) =>
              sum + parseInline(text).filter((token) => token.kind === 'key').length,
            0
          ),
      0
    )

  /** 正文里标了【待实现】的段落数（与界面上的小标签数必须一致） */
  const guidePendingCount = (): number =>
    GUIDE.chapters.reduce((chapterSum, chapter) => {
      let count = 0
      for (const block of chapter.blocks) {
        if (block.kind === 'paragraph' && block.pending === true) count += 1
        if (block.kind === 'list') {
          count += block.items.filter((item) => item.pending === true).length
        }
      }
      return chapterSum + count
    }, 0)

  /** 每条检查的第一步：切到「数据与设置」，等指南分区渲染出来 */
  const openGuide = async (): Promise<boolean> => {
    await closeFloaters(context)
    await evaluate(context, `window.__verify.clickNav('settings')`)
    return untilTrue(context, `window.__verify.exists('settings-guide')`, 14, 250)
  }

  /** 指南分区的一次快照（目录 / 正文 / 待实现标签 / 当前章） */
  const guideSnapshot = `(() => {
    const section = document.querySelector('[data-view="settings"] [data-testid="settings-guide"]')
    const toc = Array.from(document.querySelectorAll('[data-testid="guide-toc-item"]'))
    const chapters = Array.from(document.querySelectorAll('[data-testid="guide-chapter"]'))
    const pending = Array.from(document.querySelectorAll('[data-testid="guide-pending"]'))
    const activeIndex = toc.findIndex((el) => el.getAttribute('aria-current') === 'true')
    return {
      insideSettings: !!section,
      sectionCount: document.querySelectorAll('[data-testid="settings-guide"]').length,
      tocCount: toc.length,
      tocTexts: toc.map((el) => (el.textContent || '').trim()),
      activeIndex,
      chapterCount: chapters.length,
      chapterTitles: chapters.map((el) => {
        const title = el.querySelector('.guide__chapter-title')
        return title ? (title.textContent || '').trim() : ''
      }),
      chapterIndexes: chapters.map((el) => el.getAttribute('data-chapter-index') || ''),
      pendingCount: pending.length,
      pendingTexts: pending.map((el) => (el.textContent || '').trim())
    }
  })()`

  interface GuideSnapshot {
    insideSettings: boolean
    sectionCount: number
    tocCount: number
    tocTexts: string[]
    activeIndex: number
    chapterCount: number
    chapterTitles: string[]
    chapterIndexes: string[]
    pendingCount: number
    pendingTexts: string[]
  }

  // ---- M1 「数据与设置」页里有独立分区「操作指南」：七章齐全、目录与正文一一对应 ----
  try {
    const opened = await openGuide()
    if (!opened) throw new Error('「数据与设置」页里没有「操作指南」分区')

    const snapshot = await until<GuideSnapshot>(
      context,
      guideSnapshot,
      (value) => value !== null && value.chapterCount > 0,
      12,
      250
    )
    if (snapshot === null) throw new Error('指南分区没有渲染出章节')

    const expectedTitles = GUIDE.chapters.map((chapter) => chapterTitle(chapter))
    const expectedIndexes = GUIDE.chapters.map((_, index) => String(index))
    const pendingExpected = guidePendingCount()

    record({
      id: 'P8-M1',
      prd: 'TASKS07-§5.1',
      name: '「数据与设置」页里有独立分区「操作指南」：七章正文齐全、左侧目录与正文一一对应、当前章有 aria-current、【待实现】标签按数据渲染',
      passed:
        snapshot.insideSettings &&
        snapshot.sectionCount === 1 &&
        snapshot.chapterCount === GUIDE.chapters.length &&
        snapshot.tocCount === GUIDE.chapters.length &&
        JSON.stringify(snapshot.tocTexts) === JSON.stringify(expectedTitles) &&
        JSON.stringify(snapshot.chapterTitles) === JSON.stringify(expectedTitles) &&
        JSON.stringify(snapshot.chapterIndexes) === JSON.stringify(expectedIndexes) &&
        snapshot.activeIndex === 0 &&
        snapshot.pendingCount === pendingExpected &&
        snapshot.pendingTexts.every((text) => text === '【待实现】'),
      detail: `分区在设置页内=${snapshot.insideSettings}（同一页里 ${snapshot.sectionCount} 个，期望 1 个）；章节 ${snapshot.chapterCount}/${GUIDE.chapters.length}，目录 ${snapshot.tocCount} 项；目录标题=${JSON.stringify(snapshot.tocTexts)}；正文标题=${JSON.stringify(snapshot.chapterTitles)}；初始当前章=${snapshot.activeIndex}（期望 0）；【待实现】标签 ${snapshot.pendingCount} 个（按数据算 ${pendingExpected} 个）文本=${JSON.stringify(snapshot.pendingTexts)}`
    })
  } catch (error) {
    record({
      id: 'P8-M1',
      prd: 'TASKS07-§5.1',
      name: '「数据与设置」页里有独立分区「操作指南」：七章正文齐全、左侧目录与正文一一对应、当前章有 aria-current、【待实现】标签按数据渲染',
      passed: false,
      detail: `${String(error)}；${diagnostics()}`
    })
  }

  // ---- M2 点目录能跳转；滚动时目录跟着换当前章（aria-current 滚动联动） ----
  try {
    const opened = await openGuide()
    if (!opened) throw new Error('「数据与设置」页里没有「操作指南」分区')

    interface GuideScrollState {
      /** 当前视图 id（万一被别的动作切走了，一眼看得出） */
      view: string
      sectionFound: boolean
      bodyFound: boolean
      tocCount: number
      chapterCount: number
      activeIndex: number
      scrollTop: number
      maxScroll: number
      clientHeight: number
      /** 目标章顶端相对滚动容器顶部的距离（跳转成功后应当≈ 12px 的容差） */
      targetOffset: number
    }

    /**
     * 一次读完联动需要的全部读数。
     *
     * **永远返回对象**（不返回 null）：这样超时的时候还能把"当时的现场"写进报告，
     * 而不是只留一句"没等到"——第 02 块就是因为只留一句空话才多花了两小时定位。
     */
    const guideStateExpr = (targetIndex: number): string => `(() => {
      const workspace = document.querySelector('[data-testid="workspace"]')
      const section = document.querySelector('[data-testid="settings-guide"]')
      const body = document.querySelector('[data-testid="guide-body"]')
      const toc = Array.from(document.querySelectorAll('[data-testid="guide-toc-item"]'))
      const chapters = Array.from(document.querySelectorAll('[data-guide-chapter]'))
      const target = document.querySelector('[data-guide-chapter="${targetIndex}"]')
      return {
        view: workspace ? workspace.getAttribute('data-view') || '' : '',
        sectionFound: !!section,
        bodyFound: !!body,
        tocCount: toc.length,
        chapterCount: chapters.length,
        activeIndex: toc.findIndex((el) => el.getAttribute('aria-current') === 'true'),
        scrollTop: body ? Math.round(body.scrollTop) : -1,
        maxScroll: body ? Math.round(body.scrollHeight - body.clientHeight) : -1,
        clientHeight: body ? Math.round(body.clientHeight) : -1,
        targetOffset:
          body && target
            ? Math.round(target.getBoundingClientRect().top - body.getBoundingClientRect().top)
            : -1
      }
    })()`

    /** 轮询到条件成立；**超时把最后一次读数带回来**（不返回假值，见 §5.5 第 1 条硬规矩） */
    const pollGuide = async (
      targetIndex: number,
      accept: (value: GuideScrollState) => boolean,
      attempts = 16,
      interval = 250
    ): Promise<{ ok: boolean; last: GuideScrollState | null }> => {
      let last: GuideScrollState | null = null
      for (let attempt = 0; attempt < attempts; attempt += 1) {
        last = await evaluate<GuideScrollState>(context, guideStateExpr(targetIndex))
        if (accept(last)) return { ok: true, last }
        await wait(interval)
      }
      return { ok: false, last }
    }

    const clickToc = async (index: number): Promise<boolean> =>
      evaluate<boolean>(
        context,
        `(() => {
           const item = document.querySelector('[data-testid="guide-toc-item"][data-chapter-index="${index}"]')
           if (!item) return false
           item.click()
           return true
         })()`
      )

    /**
     * 直接把正文滚到某个位置（模拟用户拖动滚动条），并**补派发一次 scroll 事件**。
     *
     * 为什么必须补这一下（12 块定位出来的，07/09 块记的那条"P8-M2 偶发"就是它）：
     * 验收态的主窗口是 `show: false` 创建的（`index.ts` 里 `createMainWindow({ show: !verifyMode })`），
     * 没有可见窗口就没有合成帧；Chromium 要等到下一帧才把"程序改了 scrollTop"这件事
     * 派发成 scroll 事件，于是界面的滚动联动**永远收不到通知**——现象就是
     * "scrollTop 已经是最大值、目录还停在第二章（activeIndex=1）"。
     * 探针实测：滚到底后手动派发一次 scroll，`aria-current` 立刻从第 1 章跳到第 6 章，
     * 说明**程序侧的监听是好的**，缺的是环境里的那一次派发。
     * 用户真的用滚轮 / 拖滚动条时，浏览器自己会派发，这里补的就是"真人滚一下"这件事。
     */
    const setBodyScrollTop = async (toBottom: boolean): Promise<void> => {
      await evaluate(
        context,
        `(() => {
           const body = document.querySelector('[data-testid="guide-body"]')
           if (!body) return false
           body.scrollTop = ${toBottom ? 'body.scrollHeight' : '0'}
           body.dispatchEvent(new Event('scroll'))
           return true
         })()`
      )
    }

    // 先复位：滚回顶部、等目录回到第一章
    await setBodyScrollTop(false)
    const atTop = await pollGuide(
      0,
      (value) => value.bodyFound && value.scrollTop === 0 && value.activeIndex === 0,
      10,
      200
    )

    // ① 点第 2 章 → 正文滚过去，标题贴到容器顶部（容差 12px），目录跟着变
    const clickedSecond = await clickToc(1)
    const jumped = await pollGuide(
      1,
      (value) =>
        value.activeIndex === 1 && value.scrollTop > 0 && Math.abs(value.targetOffset - 12) <= 2
    )

    // ② 滚到底 → 当前章变成最后一章（最后一章比容器矮也要认得出来）
    await setBodyScrollTop(true)
    const lastIndex = GUIDE.chapters.length - 1
    const atBottom = await pollGuide(
      lastIndex,
      (value) =>
        value.activeIndex === lastIndex &&
        value.maxScroll > 0 &&
        Math.abs(value.scrollTop - value.maxScroll) <= 2
    )

    // ③ 再点第 1 章 → 回到顶部
    const clickedFirst = await clickToc(0)
    const backTop = await pollGuide(
      0,
      (value) =>
        value.activeIndex === 0 && value.scrollTop === 0 && Math.abs(value.targetOffset) <= 2
    )

    record({
      id: 'P8-M2',
      prd: 'TASKS07-§5.4',
      name: '点目录能跳转（标题落到正文区顶部）；滚到底目录指向最后一章；点回第 1 章回到顶部——目录始终看得出停在哪一章',
      passed: atTop.ok && clickedSecond && jumped.ok && atBottom.ok && clickedFirst && backTop.ok,
      detail: `复位到顶部=${atTop.ok}（读数 ${JSON.stringify(atTop.last)}）；点第 2 章=${clickedSecond} 跳转后=${JSON.stringify(jumped.last)}；滚到底好后=${JSON.stringify(atBottom.last)}（期望当前章 ${lastIndex}）；点第 1 章=${clickedFirst} 回顶部后=${JSON.stringify(backTop.last)}`
    })
  } catch (error) {
    record({
      id: 'P8-M2',
      prd: 'TASKS07-§5.4',
      name: '点目录能跳转（标题落到正文区顶部）；滚到底目录指向最后一章；点回第 1 章回到顶部——目录始终看得出停在哪一章',
      passed: false,
      detail: `${String(error)}；${diagnostics()}`
    })
  }

  // ---- M3 正文区自己滚（固定高度、页面级无滚动条）；键盘键是 <kbd> 不是纯文本 ----
  try {
    const opened = await openGuide()
    if (!opened) throw new Error('「数据与设置」页里没有「操作指南」分区')

    interface GuideScrollBox {
      scrollHeight: number
      clientHeight: number
      overflowY: string
      rectHeight: number
      pageScrollHeight: number
      pageClientHeight: number
      devicePage: string
      kbdCount: number
      kbdTexts: string[]
      codeCount: number
    }

    const box = await until<GuideScrollBox>(
      context,
      `(() => {
         const body = document.querySelector('[data-testid="guide-body"]')
         if (!body) return null
         const style = getComputedStyle(body)
         const doc = document.scrollingElement
         const kbd = Array.from(body.querySelectorAll('kbd'))
         return {
           scrollHeight: body.scrollHeight,
           clientHeight: body.clientHeight,
           overflowY: style.overflowY,
           rectHeight: Math.round(body.getBoundingClientRect().height),
           pageScrollHeight: doc ? doc.scrollHeight : -1,
           pageClientHeight: doc ? doc.clientHeight : -1,
           devicePage: doc ? doc.tagName : '',
           kbdCount: kbd.length,
           kbdTexts: kbd.map((el) => (el.textContent || '').trim()),
           codeCount: body.querySelectorAll('code').length
         }
       })()`,
      (value) => value !== null && value.clientHeight > 0,
      12,
      250
    )
    if (box === null) throw new Error('找不到正文滚动容器')

    const expectedKeys = guideExpectedKeys()
    const pageNoOverflow = box.pageScrollHeight <= box.pageClientHeight + 1
    const keyTextsOk = box.kbdTexts.includes('Ctrl+K') && box.kbdTexts.includes('空格')

    record({
      id: 'P8-M3',
      prd: 'TASKS07-§5.4',
      name: '正文区自己滚（固定高度、页面级无滚动条，不把设置页撑长）；键盘键渲染成 <kbd> 小标签而不是纯文本',
      passed:
        box.scrollHeight > box.clientHeight &&
        (box.overflowY === 'auto' || box.overflowY === 'scroll') &&
        box.rectHeight <= 480 &&
        pageNoOverflow &&
        box.kbdCount === expectedKeys &&
        expectedKeys >= 10 &&
        keyTextsOk,
      detail: `正文 内容高=${box.scrollHeight} 可视高=${box.clientHeight} overflow=${box.overflowY} 实际高度=${box.rectHeight}px（上限 480）；页面滚动元素（${box.devicePage}）内容高=${box.pageScrollHeight} 可视高=${box.pageClientHeight} 无溢出=${pageNoOverflow}；<kbd> ${box.kbdCount} 个（按数据算 ${expectedKeys} 个）含 Ctrl+K=${box.kbdTexts.includes('Ctrl+K')} 含空格=${box.kbdTexts.includes('空格')}；行内 <code> ${box.codeCount} 个`
    })
  } catch (error) {
    record({
      id: 'P8-M3',
      prd: 'TASKS07-§5.4',
      name: '正文区自己滚（固定高度、页面级无滚动条，不把设置页撑长）；键盘键渲染成 <kbd> 小标签而不是纯文本',
      passed: false,
      detail: `${String(error)}；${diagnostics()}`
    })
  }

  // =========================================================================
  // 第 08 块：界面骨架与滚轮规矩（`docs\TASKS\08` §6.3）
  //
  // 七项，全部在**学习页**上验（本块的样板页；09 块才会重做整页）：
  //   N1 页面级无滚动条（`document.scrollingElement` 无溢出）★必须真断言
  //   N2 左栏三段：导航固定 / 中间可滚 / 底部"数据与设置"始终可见
  //   N3 中区两块：固定约 132px，各自内部滚（不无限延伸）
  //   N4 树吃满剩余高度且内部滚
  //   N5 滚动条可见：`scrollbar-gutter: stable` + 占满 10px + 有轨道底色
  //   N6 侧栏收起成 54px、图标保留；再点展开；偏好落盘（重开后保持）
  //   N7 选中态用颜色（浅色变深 / 深色变淡）；没有箭头
  //
  // 硬规矩照旧：轮询等待、自带前提（现场造 12 个主题 + 每个 8 条日志）、
  // 先复位再操作、用对触发方式。样本都带 `阶段8骨架（第N趟）` 前缀，
  // 每趟重新造，不依赖上一趟留下的东西。
  // =========================================================================

  const skeletonMarker = `阶段8骨架（第${passNumber}趟）`

  interface LayoutSnapshot {
    pageScrollHeight: number
    pageClientHeight: number
    pageTag: string
    htmlOverflow: string
    workspaceScrollHeight: number
    workspaceClientHeight: number
    workspaceOverflow: string
    workspaceGutter: string
    workspaceBarWidth: number
    bandsFound: boolean
    previewHeight: number
    cardsCount: number
    cardHeights: number[]
    cardOverflow: string[]
    cardGutter: string[]
    cardBodyClient: number[]
    cardBodyScroll: number[]
    mainHeight: number
    mainBottom: number
    contentBottom: number
    treeHeight: number
    treeListHeight: number
    treeListOverflow: string
    treeListClient: number
    treeListScroll: number
    treeListGutter: string
    treeListBarWidth: number
    sidebarWidth: number
    listClient: number
    listScroll: number
    listOverflow: string
    listGutter: string
    listBarWidth: number
    probeBarWidth: number
    listTopics: number
    navOverflow: string
    orders: string[]
    bottomTop: number
    bottomBottom: number
    viewportHeight: number
    scrollTrack: string
    scrollThumb: string
  }

  /** 一次读全"骨架 + 滚轮"的现场（各项检查只断言其中一部分，互相不干扰） */
  const layoutExpr = `(() => {
    const el = (selector) => document.querySelector(selector)
    const box = (node) => (node ? node.getBoundingClientRect() : null)
    const style = (node) => (node ? getComputedStyle(node) : null)
    const cards = Array.from(document.querySelectorAll('.band-card'))
    const cardBodies = cards.map((card) => card.querySelector('.band-card__body'))
    const sidebar = el('[data-testid="sidebar"]')
    const list = el('[data-testid="sidebar-list"]')
    const nav = el('[data-testid="sidebar-nav"]')
    const bottom = el('[data-testid="sidebar-bottom"]')
    const main = el('[data-testid="bands-main"]')
    const tree = el('[data-testid="bands-main"] .tree')
    const treeList = el('[data-testid="bands-main"] .tree__list')
    const content = el('.page__content')
    const workspace = el('[data-testid="workspace"]')
    const doc = document.scrollingElement
    const rootStyle = getComputedStyle(document.documentElement)
    const round = (value) => (typeof value === 'number' ? Math.round(value) : 0)
    /*
     * 滚动条宽度探针：一个**整数宽度**的临时元素，量 offsetWidth − clientWidth。
     *
     * 为什么不用真实容器量：容器的宽度常常是小数（侧栏 200 − padding − 边框），
     * offsetWidth/clientWidth 各自四舍五入后差值会差 1px（实测侧栏是 9、树是 10），
     * 拿它当"滑块是不是 10px"的判据会误报。探针宽度取整，量出来的就是滑块的 CSS 宽度。
     */
    const probe = document.createElement('div')
    probe.style.cssText = 'position:absolute;left:-9999px;top:0;width:100px;height:40px;overflow-y:scroll;'
    const probeChild = document.createElement('div')
    probeChild.style.height = '200px'
    probe.appendChild(probeChild)
    document.body.appendChild(probe)
    const probeBarWidth = probe.offsetWidth - probe.clientWidth
    probe.remove()
    return {
      pageScrollHeight: doc ? doc.scrollHeight : -1,
      pageClientHeight: doc ? doc.clientHeight : -1,
      pageTag: doc ? doc.tagName : '',
      htmlOverflow: getComputedStyle(document.documentElement).overflow,
      workspaceScrollHeight: workspace ? workspace.scrollHeight : -1,
      workspaceClientHeight: workspace ? workspace.clientHeight : -1,
      workspaceOverflow: workspace ? style(workspace).overflowY : '',
      // 2026-10 修订：三模块页的滚动容器就是这一层，所以"槽位 10px / gutter stable"也量它
      workspaceGutter: workspace ? style(workspace).scrollbarGutter : '',
      workspaceBarWidth: workspace ? workspace.offsetWidth - workspace.clientWidth : -1,
      bandsFound: !!el('[data-testid="learning-bands"]'),
      previewHeight: round(box(el('[data-testid="bands-preview"]')) ? box(el('[data-testid="bands-preview"]')).height : 0),
      cardsCount: cards.length,
      cardHeights: cards.map((card) => round(box(card).height)),
      cardOverflow: cardBodies.map((body) => (body ? style(body).overflowY : '')),
      cardGutter: cardBodies.map((body) => (body ? style(body).scrollbarGutter : '')),
      cardBodyClient: cardBodies.map((body) => (body ? body.clientHeight : 0)),
      cardBodyScroll: cardBodies.map((body) => (body ? body.scrollHeight : 0)),
      mainHeight: round(box(main) ? box(main).height : 0),
      mainBottom: round(box(main) ? box(main).bottom : 0),
      contentBottom: round(box(content) ? box(content).bottom : 0),
      treeHeight: round(box(tree) ? box(tree).height : 0),
      treeListHeight: round(box(treeList) ? box(treeList).height : 0),
      treeListOverflow: treeList ? style(treeList).overflowY : '',
      treeListClient: treeList ? treeList.clientHeight : 0,
      treeListScroll: treeList ? treeList.scrollHeight : 0,
      treeListGutter: treeList ? style(treeList).scrollbarGutter : '',
      treeListBarWidth: treeList ? treeList.offsetWidth - treeList.clientWidth : -1,
      probeBarWidth,
      sidebarWidth: sidebar ? sidebar.offsetWidth : -1,
      listClient: list ? list.clientHeight : 0,
      listScroll: list ? list.scrollHeight : 0,
      listOverflow: list ? style(list).overflowY : '',
      listGutter: list ? style(list).scrollbarGutter : '',
      listBarWidth: list ? list.offsetWidth - list.clientWidth : -1,
      listTopics: list ? list.querySelectorAll('[data-testid="learning-topic"]').length : 0,
      navOverflow: nav ? style(nav).overflowY : '',
      orders: ['top', 'nav', 'list', 'bottom'].map((key) => {
        const node = el('[data-testid="sidebar-' + key + '"]')
        return node ? style(node).order : ''
      }),
      bottomTop: round(box(bottom) ? box(bottom).top : -1),
      bottomBottom: round(box(bottom) ? box(bottom).bottom : -1),
      viewportHeight: window.innerHeight,
      scrollTrack: rootStyle.getPropertyValue('--scroll-track').trim(),
      scrollThumb: rootStyle.getPropertyValue('--scroll-thumb').trim()
    }
  })()`

  /** 切到学习页并等到"三段骨架 + 侧栏中段"都渲染出来（先离开再回来，强制重读盘） */
  const reopenLearningLayout = async (): Promise<boolean> => {
    await closeFloaters(context)
    await evaluate(context, `window.__verify.clickNav('home')`)
    await wait(200)
    await evaluate(context, `window.__verify.clickNav('learning')`)
    return untilTrue(
      context,
      `(() => {
         const bands = document.querySelector('[data-testid="learning-bands"]')
         const list = document.querySelector('[data-testid="sidebar-list"]')
         return !!bands && !!list && !!document.querySelector('[data-testid="learning-topic"]')
       })()`,
      16,
      250
    )
  }

  // ---- 现场造样本：12 个主题，每个挂「资料 + 两章」+ 8 条日志 ----
  let seededTopicId = ''
  try {
    const seeded = await evaluate<{ topicIds: string[] }>(
      context,
      `(async () => {
         const marker = ${JSON.stringify(skeletonMarker)}
         const alive = await window.api.data.listAlive('learning')
         const topics = alive.filter(
           (item) => item['kind'] === 'topic' && String(item['title'] || '').startsWith(marker)
         )
         const topicIds = topics.map((item) => String(item['id']))
         for (let index = topics.length; index < 12; index += 1) {
           const created = await window.api.data.add('learning', {
             kind: 'topic',
             title: marker + ' 主题' + String(index + 1).padStart(2, '0'),
             status: 'active',
             progress: 0
           })
           topicIds.push(String(created.id))
         }
         for (const topicId of topicIds) {
           // 每个主题都种一份"资料 → 两章"：树才有行可渲染、中区"资料"卡才有内容
           const hasNode = alive.some(
             (item) => item['kind'] === 'node' && String(item['ownerId'] || '') === topicId
           )
           if (!hasNode) {
             const resource = await window.api.data.add('learning', {
               kind: 'node',
               ownerId: topicId,
               parentId: null,
               order: 0,
               title: marker + ' 资料',
               done: false,
               percent: 50
             })
             await window.api.data.add('learning', {
               kind: 'node',
               ownerId: topicId,
               parentId: String(resource.id),
               order: 0,
               title: marker + ' 第1章',
               done: false
             })
             await window.api.data.add('learning', {
               kind: 'node',
               ownerId: topicId,
               parentId: String(resource.id),
               order: 1,
               title: marker + ' 第2章',
               done: true
             })
           }
           const hasLog = alive.some(
             (item) => item['kind'] === 'log' && String(item['topicId'] || '') === topicId
           )
           if (hasLog) continue
           for (let index = 0; index < 8; index += 1) {
             await window.api.data.add('learning', {
               kind: 'log',
               topicId,
               date: '2026-10-1' + String((index % 9) + 1),
               minutes: 15,
               content: marker + ' 日志 ' + index
             })
           }
         }
         await window.api.data.flush()
         return { topicIds }
       })()`
    )
    seededTopicId = seeded?.topicIds?.[0] ?? ''
    await evaluate(
      context,
      `window.dispatchEvent(new CustomEvent('worklife:data-changed', { detail: { module: 'learning' } })), true`
    )
    await wait(300)
  } catch (error) {
    console.log(`[phase8] 造骨架样本失败：${String(error)}`)
  }

  const openedLayout = await reopenLearningLayout()
  // 选中**本块自己造的那个主题**：页面默认选的是排序第一的主题，
  // 可能是前面检查留下的空主题（空树没有行，N3/N4 就白等了）。
  if (seededTopicId !== '') {
    await evaluate(
      context,
      `(() => {
         const button = document.querySelector('[data-testid="learning-topic"][data-topic-id="${seededTopicId}"]')
         if (button) button.click()
         return !!button
       })()`
    )
    await wait(300)
    // 三步走（09 块起）：点主题只是选中，还要点「进入主题」下方才展开树，
    // N3/N4 量的是"树吃满剩余高度"，没有树就无从量起。
    await evaluate(
      context,
      `(() => {
         const button = document.querySelector('[data-testid="learning-enter-topic"]')
         if (!button) return false
         if (button.getAttribute('data-entered') !== '1') button.click()
         return true
       })()`
    )
    await untilTrue(context, `!!document.querySelector('[data-testid="learning-tree-root"]')`, 16, 250)
  }
  const layout = await until<LayoutSnapshot | null>(
    context,
    layoutExpr,
    (value) => value !== null && value.cardsCount === 2 && value.listClient > 0 && value.treeListClient > 0,
    16,
    250
  )

  // ---- N1 页面级无滚动条（2026-10 修订：口径收窄） ----
  try {
    if (layout === null) {
      // 等不到现场时把"到底缺哪一块"带出来，省得只看一句超时
      const dump = await evaluate<string>(
        context,
        `(() => {
           const count = (selector) => document.querySelectorAll(selector).length
           const root = document.querySelector('[data-testid="learning-bands"]')
           const list = document.querySelector('[data-testid="sidebar-list"]')
           return JSON.stringify({
             view: (document.querySelector('[data-testid="workspace"]') || {}).getAttribute
               ? document.querySelector('[data-testid="workspace"]').getAttribute('data-view')
               : null,
             bands: !!root,
             cards: count('.band-card'),
             sidebarList: !!list,
             listHeight: list ? list.clientHeight : 0,
             topics: count('[data-testid="learning-topic"]'),
             treeRoot: !!document.querySelector('[data-testid="learning-tree-root"]'),
             treeList: !!document.querySelector('[data-testid="learning-tree-list"]'),
             treeEmpty: !!document.querySelector('[data-testid="learning-tree-empty"]'),
             treeRows: count('[data-testid="learning-tree-row"]'),
             detailTitle: ((document.querySelector('[data-testid="learning-detail-title"]') || {}).textContent || '').trim()
           })
         })()`
      )
      throw new Error(`没等到三段骨架渲染出来；现场=${dump}`)
    }
    /*
     * 2026-10 修订（`MASTER.md` §7.2 / 决定 7）：口径收窄。
     *
     * 旧断言是"**工作区也不能溢出**"，那是"下区自己内部滚"那一版模型的产物。
     * 现在三模块页的滚动**就在**右侧内容区里发生，所以：
     *
     *   - 仍然成立（全局）：`document.scrollingElement` 零溢出 ——
     *     滚动条不许跑到整页上去（`html` / `body` / `#root` 三层都是 overflow: hidden）
     *   - **作废**（三模块页）：工作区不许溢出。三模块页改成允许它溢出，
     *     新口径由 `P8-U9` / `P8-S5` / `P8-V7` 三页各判一次（同一段脚本、同一个判据）
     *   - 计划页 / 设置页 / 首页 / 备忘页仍然**零页面级溢出**，由新增的 `P8-W8` 守住
     */
    const pageNoOverflow = layout.pageScrollHeight <= layout.pageClientHeight + 1
    const workspaceIsScroller =
      layout.workspaceOverflow === 'auto' || layout.workspaceOverflow === 'scroll'
    record({
      id: 'P8-N1',
      prd: 'TASKS08-§6.3',
      name: '页面级（html/body）永不出现滚动条；三模块页的溢出改由右侧内容区承担（滚轮规矩 2026-10 修订）',
      passed: pageNoOverflow && layout.bandsFound && workspaceIsScroller,
      detail: `页面滚动元素（${layout.pageTag}）内容高=${layout.pageScrollHeight} 可视高=${layout.pageClientHeight} 零溢出=${pageNoOverflow}（html overflow=${layout.htmlOverflow}）；右侧内容区 内容高=${layout.workspaceScrollHeight} 可视高=${layout.workspaceClientHeight} overflow=${layout.workspaceOverflow}（三模块页**允许**溢出，这正是本轮要的效果；是滚动容器=${workspaceIsScroller}）；三段骨架在=${layout.bandsFound}`
    })
  } catch (error) {
    record({
      id: 'P8-N1',
      prd: 'TASKS08-§6.3',
      name: '页面级（html/body）永不出现滚动条；三模块页的溢出改由右侧内容区承担（滚轮规矩 2026-10 修订）',
      passed: false,
      detail: `${String(error)}；${diagnostics()}`
    })
  }

  // ---- N2 左栏三段：order 显式控制；中间可滚；底部"数据与设置"始终可见 ----
  try {
    if (layout === null) throw new Error('没等到三段骨架渲染出来')
    const orderOk =
      layout.orders[0] === '1' && layout.orders[1] === '2' && layout.orders[2] === '3' && layout.orders[3] === '4'
    const listScrollable =
      (layout.listOverflow === 'auto' || layout.listOverflow === 'scroll') &&
      layout.listScroll > layout.listClient
    const navFixed = layout.navOverflow === 'visible' || layout.navOverflow === 'hidden' || layout.navOverflow === 'clip'
    const bottomVisible =
      layout.bottomBottom <= layout.viewportHeight + 1 &&
      layout.bottomTop >= 0 &&
      layout.bottomBottom > layout.bottomTop

    // 再把中间列表滚到底，确认底部那一段**没有被推走**（"已踩过"的那条）
    await evaluate(
      context,
      `(() => {
         const list = document.querySelector('[data-testid="sidebar-list"]')
         if (list) list.scrollTop = list.scrollHeight
         return true
       })()`
    )
    await wait(200)
    const afterScroll = await evaluate<{ bottomTop: number; bottomBottom: number; viewportHeight: number; scrolled: number }>(
      context,
      `(() => {
         const list = document.querySelector('[data-testid="sidebar-list"]')
         const bottom = document.querySelector('[data-testid="sidebar-bottom"]')
         const rect = bottom ? bottom.getBoundingClientRect() : null
         return {
           bottomTop: rect ? Math.round(rect.top) : -1,
           bottomBottom: rect ? Math.round(rect.bottom) : -1,
           viewportHeight: window.innerHeight,
           scrolled: list ? list.scrollTop : -1
         }
       })()`
    )
    const stillVisible =
      afterScroll.scrolled > 0 &&
      afterScroll.bottomBottom <= afterScroll.viewportHeight + 1 &&
      Math.abs(afterScroll.bottomTop - layout.bottomTop) <= 1

    record({
      id: 'P8-N2',
      prd: 'TASKS08-§6.3',
      name: '左栏三段：导航固定 / 中间列表滚动 / 底部「数据与设置」始终可见（CSS order 显式控制）',
      passed: orderOk && listScrollable && navFixed && bottomVisible && stillVisible,
      detail: `order=${layout.orders.join('/')}（期望 1/2/3/4）三段齐=${orderOk}；中段列表 内容高=${layout.listScroll} 可视高=${layout.listClient} overflow=${layout.listOverflow} 能滚=${listScrollable}（主题 ${layout.listTopics} 条）；导航 overflow=${layout.navOverflow} 固定=${navFixed}；底部「数据与设置」top=${layout.bottomTop} bottom=${layout.bottomBottom} 视口=${layout.viewportHeight} 在屏幕内=${bottomVisible}；把列表滚到底（scrollTop=${afterScroll.scrolled}）后底部 top=${afterScroll.bottomTop} 仍在屏幕内=${stillVisible}`
    })
  } catch (error) {
    record({
      id: 'P8-N2',
      prd: 'TASKS08-§6.3',
      name: '左栏三段：导航固定 / 中间列表滚动 / 底部「数据与设置」始终可见（CSS order 显式控制）',
      passed: false,
      detail: `${String(error)}；${diagnostics()}`
    })
  }

  // ---- N3 中区两块：固定约 132px，各自内部滚 ----
  try {
    if (layout === null) throw new Error('没等到三段骨架渲染出来')
    const heightsFixed = layout.cardHeights.every((height) => height >= 120 && height <= 150)
    const bothScroll = layout.cardHeights.length === 2 && layout.cardHeights[0] === layout.cardHeights[1]
    const overflowOk = layout.cardOverflow.every((value) => value === 'auto' || value === 'scroll')
    // 内容超过固定高度时**真的能滚**（滚的是卡片内部，不是整页）
    const canScrollInside = layout.cardBodyScroll.some(
      (total, index) => total > (layout.cardBodyClient[index] ?? 0) + 1
    )
    record({
      id: 'P8-N3',
      prd: 'TASKS08-§6.3',
      name: '中区两块卡片固定约 132px、各自内部滚（内容再长也不把页面撑长）',
      passed: heightsFixed && bothScroll && overflowOk && canScrollInside,
      detail: `卡片数=${layout.cardsCount} 高度=${layout.cardHeights.join('/')}px（期望各 ~132）两块等高=${bothScroll}；内部 overflow=${layout.cardOverflow.join('/')}；内容高/可视高=${layout.cardBodyScroll.join('/')} ÷ ${layout.cardBodyClient.join('/')} 至少一块能内部滚=${canScrollInside}`
    })
  } catch (error) {
    record({
      id: 'P8-N3',
      prd: 'TASKS08-§6.3',
      name: '中区两块卡片固定约 132px、各自内部滚（内容再长也不把页面撑长）',
      passed: false,
      detail: `${String(error)}；${diagnostics()}`
    })
  }

  // ---- N4 下区按内容高、树不再内部滚（滚轮规矩 2026-10 修订） ----
  try {
    if (layout === null) throw new Error('没等到三段骨架渲染出来')
    /*
     * 旧口径（"树吃满剩余高度并内部滚动、主体底边与内容区底边对齐"）已随
     * `MASTER.md` §7.2 / 决定 7 的 2026-10 修订作废：三模块页改成**下区跟随整页滚**，
     * 所以现在要判的是相反的一面——树**不再**被压在固定高度里内部滚。
     * 行为面（"整页往下翻能看到树底"）由新增的 `P8-W2` 覆盖。
     */
    const mainGrowsWithContent = layout.mainHeight > 0 && layout.treeHeight > 0
    const treeNotInternalScroll =
      (layout.treeListOverflow === 'visible' || layout.treeListOverflow === '') &&
      layout.treeListScroll <= layout.treeListClient + 1
    record({
      id: 'P8-N4',
      prd: 'TASKS08-§6.3',
      name: '下区按内容高、树不再内部滚（滚轮规矩 2026-10 修订：下区跟随整页往下翻）',
      passed: mainGrowsWithContent && treeNotInternalScroll,
      detail: `主体高=${layout.mainHeight} 树高=${layout.treeHeight} 树列表高=${layout.treeListHeight} 可视=${layout.treeListClient} 内容=${layout.treeListScroll} overflow=${layout.treeListOverflow} 不再内部滚=${treeNotInternalScroll}（旧口径要的"底边对齐 / 树自己滚"已作废，见 W2）`
    })
  } catch (error) {
    record({
      id: 'P8-N4',
      prd: 'TASKS08-§6.3',
      name: '下区按内容高、树不再内部滚（滚轮规矩 2026-10 修订：下区跟随整页往下翻）',
      passed: false,
      detail: `${String(error)}；${diagnostics()}`
    })
  }

  // ---- N5 滚动条可见：scrollbar-gutter: stable + 占满 10px + 轨道有底色 ----
  try {
    if (layout === null) throw new Error('没等到三段骨架渲染出来')
    /*
     * 2026-10 修订：三模块页的滚动容器从"树列表"换成了**右侧内容区**（`.workspace`），
     * 所以"槽位 10px"要量在那个新的滚动容器上。树列表已经不再滚，
     * 它的 `offsetWidth − clientWidth` 恒为 0，量它没有意义（旧口径已作废）。
     */
    const gutters = [layout.listGutter, layout.workspaceGutter, ...layout.cardGutter]
    const gutterStable = gutters.every((value) => value === 'stable')
    /*
     * "滑块 10px"分两半量：
     *   - 探针（整数宽度）量出来的就是 CSS 里 `::-webkit-scrollbar { width }` 的值
     *   - 真实容器的槽位允许 ±1（它们的宽度是小数，四舍五入会差一个像素）
     */
    const barWidthOk =
      layout.probeBarWidth === 10 &&
      layout.listBarWidth >= 9 &&
      layout.listBarWidth <= 11 &&
      layout.workspaceBarWidth >= 9 &&
      layout.workspaceBarWidth <= 11
    const trackColored =
      layout.scrollTrack !== '' &&
      layout.scrollTrack !== 'transparent' &&
      layout.scrollThumb !== '' &&
      layout.scrollThumb !== 'transparent' &&
      layout.scrollTrack !== layout.scrollThumb
    record({
      id: 'P8-N5',
      prd: 'TASKS08-§6.3',
      name: '滚动条始终可见：scrollbar-gutter: stable 生效、滑块占满 10px、轨道有底色且与滑块不同色（三模块页量在右侧内容区上）',
      passed: gutterStable && barWidthOk && trackColored,
      detail: `scrollbar-gutter=[${gutters.join(' ')}] 全部 stable=${gutterStable}；滑块宽度 探针=${layout.probeBarWidth}px（期望 10px）列表槽=${layout.listBarWidth}px 右侧内容区槽=${layout.workspaceBarWidth}px（真实容器宽度是小数，允许 ±1）=${barWidthOk}；轨道色=${layout.scrollTrack} 滑块色=${layout.scrollThumb} 可见=${trackColored}`
    })
  } catch (error) {
    record({
      id: 'P8-N5',
      prd: 'TASKS08-§6.3',
      name: '滚动条始终可见：scrollbar-gutter: stable 生效、滑块占满 10px、轨道有底色且与滑块不同色（三模块页量在右侧内容区上）',
      passed: false,
      detail: `${String(error)}；${diagnostics()}`
    })
  }

  // ---- N6 侧栏收起成 54px + 图标保留；再点展开；偏好落盘 ----
  try {
    if (!openedLayout) throw new Error('没能打开学习页')
    // 收起前先量一次：按钮必须在**右上角**（展开状态下量；收起后 54px 里居中更合理）
    const before = await evaluate<{
      width: number
      buttonRight: number
      sidebarRight: number
      buttonTop: number
      sidebarTop: number
      buttonVisible: boolean
    }>(
      context,
      `(() => {
         const sidebar = document.querySelector('[data-testid="sidebar"]')
         const button = document.querySelector('[data-testid="sidebar-collapse"]')
         if (!sidebar || !button) return { width: -1, buttonRight: -1, sidebarRight: -1, buttonTop: -1, sidebarTop: -1, buttonVisible: false }
         const sidebarRect = sidebar.getBoundingClientRect()
         const buttonRect = button.getBoundingClientRect()
         return {
           width: sidebar.offsetWidth,
           buttonRight: Math.round(buttonRect.right),
           sidebarRight: Math.round(sidebarRect.right),
           buttonTop: Math.round(buttonRect.top),
           sidebarTop: Math.round(sidebarRect.top),
           buttonVisible: buttonRect.width > 0 && buttonRect.height > 0
         }
       })()`
    )
    const clickedCollapse = await evaluate<boolean>(
      context,
      `(() => {
         const button = document.querySelector('[data-testid="sidebar-collapse"]')
         if (!button) return false
         button.click()
         return true
       })()`
    )
    if (!clickedCollapse) throw new Error('侧栏右上角没有收起按钮')

    interface CollapsedSnapshot {
      collapsed: string
      width: number
      dateDisplay: string
      labelDisplay: string
      kbdDisplay: string
      listDisplay: string
      iconWidth: number
      iconText: string
      buttonRight: number
      sidebarRight: number
      buttonTop: number
      sidebarTop: number
    }

    const collapsedView = await until<CollapsedSnapshot | null>(
      context,
      `(() => {
         const sidebar = document.querySelector('[data-testid="sidebar"]')
         const date = document.querySelector('[data-testid="sidebar-date"]')
         const label = document.querySelector('.nav__label')
         const kbd = document.querySelector('.nav__kbd')
         const list = document.querySelector('[data-testid="sidebar-list"]')
         const icon = document.querySelector('.nav__icon')
         const button = document.querySelector('[data-testid="sidebar-collapse"]')
         if (!sidebar || !button) return null
         const rect = (node) => (node ? node.getBoundingClientRect() : null)
         return {
           collapsed: sidebar.getAttribute('data-collapsed') || '',
           width: sidebar.offsetWidth,
           dateDisplay: date ? getComputedStyle(date).display : '(没有)',
           labelDisplay: label ? getComputedStyle(label).display : '(没有)',
           kbdDisplay: kbd ? getComputedStyle(kbd).display : '(没有)',
           listDisplay: list ? getComputedStyle(list).display : '(没有)',
           iconWidth: icon ? Math.round(rect(icon).width) : 0,
           iconText: icon ? (icon.textContent || '').trim() : '',
           buttonRight: Math.round(rect(button).right),
           sidebarRight: Math.round(rect(sidebar).right),
           buttonTop: Math.round(rect(button).top),
           sidebarTop: Math.round(rect(sidebar).top)
         }
       })()`,
      (value) => value !== null && value.collapsed === '1' && value.width === SIDEBAR_COLLAPSED_WIDTH,
      12,
      250
    )
    if (collapsedView === null) throw new Error(`侧栏没有收起到 ${SIDEBAR_COLLAPSED_WIDTH}px`)

    const hiddenOk =
      collapsedView.dateDisplay === 'none' &&
      collapsedView.labelDisplay === 'none' &&
      collapsedView.kbdDisplay === 'none' &&
      collapsedView.listDisplay === 'none'
    const iconsKept = collapsedView.iconWidth >= 8 && collapsedView.iconText !== ''
    // 「按钮在右上角」按**展开状态**量（收起后只看它还在、还在顶部）
    // 允许 20px：侧栏自己有 padding，按钮贴着右上角但离边还有十几个像素
    const buttonTopRight =
      before.buttonVisible &&
      Math.abs(before.buttonRight - before.sidebarRight) <= 20 &&
      before.buttonTop - before.sidebarTop <= 40
    const buttonStillTop = collapsedView.buttonTop - collapsedView.sidebarTop <= 40

    // 偏好落盘：文件里要能看到 sidebarCollapsed=true（重开程序才会保持收起）
    let diskCollapsed: boolean | null = null
    for (let attempt = 0; attempt < 10; attempt += 1) {
      try {
        const raw = readFileSync(join(context.paths.data, 'app.json'), 'utf8')
        const parsed = JSON.parse(raw) as { records?: Array<Record<string, unknown>> }
        const found = (parsed.records ?? []).find((item) => item['id'] === 'preferences')
        diskCollapsed = found !== undefined && found['sidebarCollapsed'] === true
        if (diskCollapsed) break
      } catch {
        /* 文件还没写出来就再等一轮 */
      }
      await wait(200)
    }

    // 再点一次展开（本块检查做完要把界面还原，后面的检查还要看侧栏）
    const clickedExpand = await evaluate<boolean>(
      context,
      `(() => {
         const button = document.querySelector('[data-testid="sidebar-collapse"]')
         if (!button) return false
         button.click()
         return true
       })()`
    )
    const expandedView = await until<{ collapsed: string; width: number; labelDisplay: string; listDisplay: string } | null>(
      context,
      `(() => {
         const sidebar = document.querySelector('[data-testid="sidebar"]')
         const label = document.querySelector('.nav__label')
         const list = document.querySelector('[data-testid="sidebar-list"]')
         if (!sidebar) return null
         return {
           collapsed: sidebar.getAttribute('data-collapsed') || '',
           width: sidebar.offsetWidth,
           labelDisplay: label ? getComputedStyle(label).display : '(没有)',
           listDisplay: list ? getComputedStyle(list).display : '(没有)'
         }
       })()`,
      (value) => value !== null && value.collapsed === '0' && value.width === SIDEBAR_WIDTH,
      12,
      250
    )
    const expandOk =
      expandedView !== null &&
      expandedView.labelDisplay !== 'none' &&
      expandedView.listDisplay !== 'none'

    let diskExpanded: boolean | null = null
    for (let attempt = 0; attempt < 10; attempt += 1) {
      try {
        const raw = readFileSync(join(context.paths.data, 'app.json'), 'utf8')
        const parsed = JSON.parse(raw) as { records?: Array<Record<string, unknown>> }
        const found = (parsed.records ?? []).find((item) => item['id'] === 'preferences')
        diskExpanded = found !== undefined && found['sidebarCollapsed'] === false
        if (diskExpanded) break
      } catch {
        /* 同上 */
      }
      await wait(200)
    }

    record({
      id: 'P8-N6',
      prd: 'TASKS08-§6.3',
      name: '侧栏可收起/展开：收起成 54px 窄条只留图标（按钮在右上角），再点回原宽；偏好落盘、重开后保持',
      passed:
        clickedCollapse &&
        hiddenOk &&
        iconsKept &&
        buttonTopRight &&
        buttonStillTop &&
        diskCollapsed === true &&
        clickedExpand &&
        expandOk &&
        diskExpanded === true,
      detail: `收起前宽=${before.width}px 收起后=${collapsedView.width}px 再展开后=${expandedView ? expandedView.width : '（没等到）'}px（期望 ${SIDEBAR_WIDTH} / ${SIDEBAR_COLLAPSED_WIDTH} / ${SIDEBAR_WIDTH}）；收起时隐藏 日期=${collapsedView.dateDisplay === 'none'} 文字标签=${collapsedView.labelDisplay === 'none'} 快捷键提示=${collapsedView.kbdDisplay === 'none'} 列表=${collapsedView.listDisplay === 'none'}；图标保留=${iconsKept}（宽 ${collapsedView.iconWidth}px 文本「${collapsedView.iconText}」）；按钮在右上角=${buttonTopRight}（展开时按钮右 ${before.buttonRight} vs 侧栏右 ${before.sidebarRight}，顶距 ${before.buttonTop - before.sidebarTop}px；收起后仍在顶部=${buttonStillTop}）；落盘 收起=${String(diskCollapsed)} 展开=${String(diskExpanded)}`
    })
  } catch (error) {
    // 失败也要把侧栏还原，否则后面的检查会看到 54px 的窄条
    try {
      await evaluate(
        context,
        `(() => {
           const sidebar = document.querySelector('[data-testid="sidebar"]')
           const button = document.querySelector('[data-testid="sidebar-collapse"]')
           if (sidebar && button && sidebar.getAttribute('data-collapsed') === '1') button.click()
           return true
         })()`
      )
      await wait(400)
    } catch {
      /* 还原失败不该盖掉真正的错误 */
    }
    record({
      id: 'P8-N6',
      prd: 'TASKS08-§6.3',
      name: '侧栏可收起/展开：收起成 54px 窄条只留图标（按钮在右上角），再点回原宽；偏好落盘、重开后保持',
      passed: false,
      detail: `${String(error)}；${diagnostics()}`
    })
  }

  // ---- N7 选中态用颜色；没有箭头 ----
  try {
    interface SelectionSnapshot {
      activeCount: number
      active: { text: string; background: string; borderLeftWidth: string; borderLeftStyle: string; boxShadow: string }
      plain: { text: string; background: string; borderLeftWidth: string; borderLeftStyle: string; boxShadow: string }
      topicActive: { text: string; background: string; borderLeftWidth: string; boxShadow: string } | null
      topicPlain: { text: string; background: string; borderLeftWidth: string; boxShadow: string } | null
      arrowsOutsideCollapse: string[]
      activeLum: number
      plainLum: number
      appLum: number
      surfaceLum: number
      surfaceColor: string
    }

    const selection = await evaluate<SelectionSnapshot>(
      context,
      `(() => {
         const luminance = (color) => {
           const match = String(color).match(/rgba?\\(([^)]+)\\)/)
           if (!match) return -1
           const parts = match[1].split(',').map((part) => Number.parseFloat(part.trim()))
           const channel = (value) => {
             const normalized = Math.max(0, Math.min(255, value || 0)) / 255
             return normalized <= 0.03928 ? normalized / 12.92 : Math.pow((normalized + 0.055) / 1.055, 2.4)
           }
           return 0.2126 * channel(parts[0]) + 0.7152 * channel(parts[1]) + 0.0722 * channel(parts[2])
         }
         const read = (node) => {
           if (!node) return null
           const style = getComputedStyle(node)
           return {
             text: (node.textContent || '').trim(),
             background: style.backgroundColor,
             borderLeftWidth: style.borderLeftWidth,
             borderLeftStyle: style.borderLeftStyle,
             boxShadow: style.boxShadow
           }
         }
         const navItems = Array.from(document.querySelectorAll('.nav__item'))
         const activeNode = navItems.find((node) => node.classList.contains('nav__item--active')) || null
         const plainNode = navItems.find((node) => !node.classList.contains('nav__item--active')) || null
         const topics = Array.from(document.querySelectorAll('.topic'))
         const topicActiveNode = topics.find((node) => node.classList.contains('topic--active')) || null
         const topicPlainNode = topics.find((node) => !node.classList.contains('topic--active')) || null
         const arrows = ['▶', '▸', '►', '➤', '→', '⇒', '‹', '›', '«', '»', '⬤']
         const sidebar = document.querySelector('[data-testid="sidebar"]')
         const collapse = document.querySelector('[data-testid="sidebar-collapse"]')
         const collapseText = collapse ? (collapse.textContent || '').trim() : ''
         const sidebarText = sidebar ? (sidebar.textContent || '') : ''
         const arrowsOutsideCollapse = arrows.filter(
           (char) => !collapseText.includes(char) && sidebarText.includes(char)
         )
         const active = read(activeNode)
         const plain = read(plainNode)
         const rootStyle = getComputedStyle(document.documentElement)
         const surfaceColor = sidebar ? getComputedStyle(sidebar).backgroundColor : ''
         return {
           activeCount: navItems.filter((node) => node.classList.contains('nav__item--active')).length,
           active,
           plain,
           topicActive: read(topicActiveNode),
           topicPlain: read(topicPlainNode),
           arrowsOutsideCollapse,
           activeLum: active ? luminance(active.background) : -1,
           plainLum: plain ? luminance(plain.background) : -1,
           appLum: luminance(rootStyle.getPropertyValue('--bg-app')),
           surfaceLum: luminance(surfaceColor),
           surfaceColor
         }
       })()`
    )

    // 深色模式判定按**实际生效的底色**（--bg-app 的亮度），不按偏好值：
    // 验收前面可能把主题改成"跟随系统"，写死 theme='dark' 会误判
    const darkMode = selection.appLum >= 0 && selection.appLum < 0.2
    // 浅色：选中底比侧栏底色**深**（亮度更低）；深色：比侧栏底色**淡**（亮度更高）
    const directionOk = darkMode
      ? selection.activeLum > selection.surfaceLum + 0.005
      : selection.activeLum < selection.surfaceLum - 0.005
    const noBorder = selection.active.borderLeftWidth === '0px' || selection.active.borderLeftStyle === 'none'
    const noShadow = selection.active.boxShadow === 'none'
    // 侧栏里的主题行：普通行没有底色（透明），选中行必须有底色——"用颜色"这件事在这里再核一遍
    const topicDirectionOk =
      selection.topicActive !== null &&
      selection.topicPlain !== null &&
      selection.topicActive.background !== selection.topicPlain.background
    const topicNoBorder =
      selection.topicActive !== null &&
      (selection.topicActive.borderLeftWidth === '0px' || selection.topicActive.boxShadow === 'none')

    record({
      id: 'P8-N7',
      prd: 'TASKS08-§6.3',
      name: '选中态只用颜色（浅色变深 / 深色变淡）：没有箭头、没有加粗边框；唯一的箭头是折叠按钮',
      passed:
        selection.activeCount === 1 &&
        directionOk &&
        noBorder &&
        noShadow &&
        topicDirectionOk &&
        topicNoBorder &&
        selection.arrowsOutsideCollapse.length === 0,
      detail: `导航选中项 ${selection.activeCount} 个；底色 选中=${selection.active.background} 侧栏底=${selection.surfaceColor} 普通=${selection.plain.background}（${darkMode ? '深色模式：应更淡' : '浅色模式：应更深'}，符合=${directionOk}）；无加粗边框=${noBorder} border-left=${selection.active.borderLeftWidth}/${selection.active.borderLeftStyle}；无阴影竖条=${noShadow}（box-shadow=${selection.active.boxShadow}）；侧栏主题行 选中底色=${selection.topicActive ? selection.topicActive.background : '（没有）'} 普通=${selection.topicPlain ? selection.topicPlain.background : '（没有）'} 用颜色=${topicDirectionOk} 无边框=${topicNoBorder}；折叠按钮以外出现的箭头=${selection.arrowsOutsideCollapse.length === 0 ? '无' : selection.arrowsOutsideCollapse.join('')}（选中项文字「${selection.active.text}」）`
    })
  } catch (error) {
    record({
      id: 'P8-N7',
      prd: 'TASKS08-§6.3',
      name: '选中态只用颜色（浅色变深 / 深色变淡）：没有箭头、没有加粗边框；唯一的箭头是折叠按钮',
      passed: false,
      detail: `${String(error)}；${diagnostics()}`
    })
  }

  // =========================================================================
  // S. 第 09 块：学习页按定稿重做（`docs\TASKS\09` §7.3 的十项）
  //
  // 全部自带前提：现场造一个"三份资料 50/30/20 + 汇总章节 + 7 层深链 + 7 条日志"
  // 的主题，再管它叫「阶段9学习页（第N趟）」。断言只认这个主题里的行与数字。
  // =========================================================================
  const learningMarker = `阶段9学习页（第${passNumber}趟）`

  interface LearningSeed {
    topicId: string
    /** 三份资料的 id：[教材A(50), 参考B(30), 习题C(20)] */
    resourceIds: string[]
    /** 汇总章节（有子节点 → 虚线框） */
    summaryId: string
    /** 汇总章节下面的最小单元之一（实心方框） */
    leafId: string
    /** 资料 A 的第二章：没有子节点 → 自己就是最小单元，也挂了 1 条学习日志 */
    chapterId: string
    /** 资料 C 里那条 7 层深链的最里面一层（第 7 层） */
    deepLeafId: string
    /** 那句挂在章节上的日志正文，S9 要核实它出现在就地展开里 */
    chapterLogText: string
  }

  let seed: LearningSeed | null = null
  try {
    seed = await evaluate<LearningSeed>(
      context,
      `(async () => {
         const marker = ${JSON.stringify(learningMarker)}
         const add = async (record) => window.api.data.add('learning', record)
         const topic = await add({ kind: 'topic', title: marker + ' 主主题', status: 'active', progress: 0, targetDays: 30 })
         const topicId = String(topic.id)
         const node = async (title, parentId, order, done, extra) => {
           const created = await add(Object.assign(
             { kind: 'node', ownerId: topicId, topicId, parentId, order, title, done },
             extra || {}
           ))
           return String(created.id)
         }
         // 资料 A：分组「教材」· 类型「书」· 占比 50
         //   第一章（汇总）→ 三个最小单元（两个勾了）
         //   第二章（无子节点 → 自己就是最小单元，未勾）
         //   最小单元合计 4 个、完成 2 个 → 已学 50%
         const resA = await node(marker + ' 教材A', null, 0, false, { percent: 50, group: '教材', resourceType: '书' })
         const summary = await node(marker + ' 第一章', resA, 0, false)
         const leaf1 = await node(marker + ' 1.1 位与字节', summary, 0, true)
         await node(marker + ' 1.2 程序被翻译', summary, 1, true)
         const leaf3 = await node(marker + ' 1.3 主存', summary, 2, false)
         const chapter2 = await node(marker + ' 第二章', resA, 1, false)
         // 资料 B：分组「参考」· 类型「文档」· 占比 30；两个最小单元完成 1 个 → 50%
         const resB = await node(marker + ' 参考B', null, 1, false, { percent: 30, group: '参考', resourceType: '文档' })
         await node(marker + ' B-1', resB, 0, true)
         await node(marker + ' B-2', resB, 1, false)
         // 资料 C：分组「习题」· 类型「书」· 占比 20；7 层深链（最小单元只有最里面那层，未勾 → 0%）
         const resC = await node(marker + ' 习题C', null, 2, false, { percent: 20, group: '习题', resourceType: '书' })
         let parent = resC
         let deepest = resC
         for (let level = 1; level <= 7; level += 1) {
           deepest = await node(marker + ' 深第' + level + '层', parent, 0, false)
           parent = deepest
         }
         // 日志 6 条挂在主题上：中区「学习日志」卡（132px）一定会超过可视高度
         const dates = ['2026-10-05', '2026-10-06', '2026-10-07', '2026-10-08', '2026-10-09', '2026-10-10']
         for (let index = 0; index < dates.length; index += 1) {
           await add({
             kind: 'log',
             topicId,
             date: dates[index],
             minutes: 20 + index * 5,
             content: marker + ' 日志' + (index + 1) + '：读完了这一节，做了几道练习题，位与字节那一段回头再看一遍。'
           })
         }
         // 第 7 条挂在「第二章」上（决定 16：日志挂在章节上）
         const chapterLogText = marker + ' 章节日志：这一章的练习题做完了'
         await add({ kind: 'log', topicId, nodeId: chapter2, ownerId: topicId, date: '2026-10-11', minutes: 35, content: chapterLogText })
         // 再补 12 个只有名字的主题：左栏列表一定要滚得起来（不靠前面检查留下的数据）
         for (let index = 0; index < 12; index += 1) {
           await add({
             kind: 'topic',
             title: marker + ' 列表' + String(index + 1).padStart(2, '0'),
             status: 'active',
             progress: 0
           })
         }
         await window.api.data.flush()
         return {
           topicId,
           resourceIds: [resA, resB, resC],
           summaryId: summary,
           leafId: leaf1,
           chapterId: chapter2,
           deepLeafId: deepest,
           chapterLogText
         }
       })()`
    )
    await evaluate(
      context,
      `window.dispatchEvent(new CustomEvent('worklife:data-changed', { detail: { module: 'learning' } })), true`
    )
    await wait(300)
  } catch (error) {
    console.log(`[phase8] 造学习页样本失败：${String(error)}`)
  }

  /**
   * 把树一层层全展开（层数不限，所以要多轮：每轮只多露出一层）。
   *
   * 为什么要全展开：S4（树内部滚）要行够多才谈得上滚，
   * S10（第 5 层起缩进 12px）要看得到第 7 层。
   */
  const expandWholeTree = async (): Promise<number> => {
    let clicks = 0
    for (let round = 0; round < 10; round += 1) {
      const closed = await evaluate<number>(
        context,
        `(() => {
           const buttons = Array.from(document.querySelectorAll('[data-testid="learning-tree-toggle"]'))
           const targets = buttons.filter((button) => button.getAttribute('aria-expanded') === 'false')
           for (const button of targets) button.click()
           return targets.length
         })()`
      )
      clicks += closed
      await wait(220)
      if (closed === 0) break
    }
    return clicks
  }

  /** 读这个主题自己的那些树行（自带前提：只认样本的节点 id） */
  const seedRows = async (): Promise<TreeRow[]> => {
    const all = await evaluate<TreeRow[]>(context, rowsExpr('learning-tree'))
    if (seed === null) return []
    const ids = new Set<string>([
      ...seed.resourceIds,
      seed.summaryId,
      seed.leafId,
      seed.chapterId,
      seed.deepLeafId
    ])
    return all.filter((row) => ids.has(row.id))
  }

  /** 读全景：预览 / 中区两块 / 树 / 侧栏（各项检查只断言其中一部分） */
  const readingViewExpr = `(() => {
    const el = (selector) => document.querySelector(selector)
    const box = (node) => (node ? node.getBoundingClientRect() : null)
    const style = (node) => (node ? getComputedStyle(node) : null)
    const round = (value) => (typeof value === 'number' ? Math.round(value) : 0)
    const preview = el('[data-testid="learning-detail"]')
    const main = el('[data-testid="bands-main"]')
    const content = el('.page__content')
    const tree = el('[data-testid="bands-main"] .tree')
    const treeList = el('[data-testid="bands-main"] .tree__list')
    const cards = Array.from(document.querySelectorAll('.band-card'))
    const bodies = cards.map((card) => card.querySelector('.band-card__body'))
    const list = el('[data-testid="sidebar-list"]')
    const bottom = el('[data-testid="sidebar-bottom"]')
    const doc = document.scrollingElement
    const workspace = el('[data-testid="workspace"]')
    return {
      previewTop: round(box(preview) ? box(preview).top : -1),
      previewBottom: round(box(preview) ? box(preview).bottom : -1),
      previewHeight: round(box(preview) ? box(preview).height : 0),
      previewShown: !!preview,
      cardsCount: cards.length,
      cardHeights: cards.map((card) => round(box(card).height)),
      cardOverflow: bodies.map((body) => (body ? style(body).overflowY : '')),
      cardBodyClient: bodies.map((body) => (body ? body.clientHeight : 0)),
      cardBodyScroll: bodies.map((body) => (body ? body.scrollHeight : 0)),
      mainHeight: round(box(main) ? box(main).height : 0),
      mainBottom: round(box(main) ? box(main).bottom : 0),
      mainTop: round(box(main) ? box(main).top : 0),
      contentBottom: round(box(content) ? box(content).bottom : 0),
      treeHeight: round(box(tree) ? box(tree).height : 0),
      treeTop: round(box(tree) ? box(tree).top : -1),
      treeShown: !!tree,
      treeListOverflow: treeList ? style(treeList).overflowY : '',
      treeListClient: treeList ? treeList.clientHeight : 0,
      treeListScroll: treeList ? treeList.scrollHeight : 0,
      pageScrollHeight: doc ? doc.scrollHeight : -1,
      pageClientHeight: doc ? doc.clientHeight : -1,
      workspaceScrollHeight: workspace ? workspace.scrollHeight : -1,
      workspaceClientHeight: workspace ? workspace.clientHeight : -1,
      listClient: list ? list.clientHeight : 0,
      listScroll: list ? list.scrollHeight : 0,
      listOverflow: list ? style(list).overflowY : '',
      bottomTop: round(box(bottom) ? box(bottom).top : -1),
      bottomBottom: round(box(bottom) ? box(bottom).bottom : -1),
      viewportHeight: window.innerHeight,
      topics: Array.from(document.querySelectorAll('[data-testid="learning-topic"]')).map((button) => {
        const meta = button.querySelector('[data-testid="learning-topic-meta"]')
        const title = button.querySelector('.topic__title')
        return {
          title: title ? (title.textContent || '').trim() : '',
          meta: meta ? (meta.textContent || '').trim() : '',
          percent: button.getAttribute('data-percent') || ''
        }
      })
    }
  })()`

  type ReadingView = {
    previewTop: number
    previewBottom: number
    previewHeight: number
    previewShown: boolean
    cardsCount: number
    cardHeights: number[]
    cardOverflow: string[]
    cardBodyClient: number[]
    cardBodyScroll: number[]
    mainHeight: number
    mainBottom: number
    mainTop: number
    contentBottom: number
    treeHeight: number
    treeTop: number
    treeShown: boolean
    treeListOverflow: string
    treeListClient: number
    treeListScroll: number
    pageScrollHeight: number
    pageClientHeight: number
    workspaceScrollHeight: number
    workspaceClientHeight: number
    listClient: number
    listScroll: number
    listOverflow: string
    bottomTop: number
    bottomBottom: number
    viewportHeight: number
    topics: Array<{ title: string; meta: string; percent: string }>
  }

  // ---- S1 三步走：选中 → 预览（树还没出来）→ 进入主题 → 下方展开树，预览仍在上面 ----
  try {
    if (seed === null) throw new Error('样本没造出来')
    // 先复位：离开再回来，等价于用户换页再回来（页面重新读盘）
    await evaluate(context, `window.__verify.clickNav('home')`)
    await wait(200)
    await evaluate(context, `window.__verify.clickNav('learning')`)
    const topicReady = await untilTrue(
      context,
      `!!document.querySelector('[data-testid="learning-topic"][data-topic-id="${seed.topicId}"]')`,
      16,
      250
    )
    if (!topicReady) throw new Error('侧栏里没有刚造的那个主题')

    // 第一步 + 第二步：点主题 → 右侧出现的是**这个主题**的预览
    await evaluate(
      context,
      `(() => {
         const button = document.querySelector('[data-testid="learning-topic"][data-topic-id="${seed.topicId}"]')
         if (button) button.click()
         return !!button
       })()`
    )
    const previewTitle = await until<string>(
      context,
      `((document.querySelector('[data-testid="learning-detail-title"]') || {}).textContent || '').trim()`,
      (text) => text === `${learningMarker} 主主题`,
      16,
      250
    )
    const beforeEnter = await evaluate<ReadingView>(context, readingViewExpr)
    const lockedShown = await evaluate<boolean>(
      context,
      `!!document.querySelector('[data-testid="learning-tree-locked"]')`
    )
    const enterState = await evaluate<string>(
      context,
      `(() => {
         const button = document.querySelector('[data-testid="learning-enter-topic"]')
         return button ? button.getAttribute('data-entered') || '' : '（没有按钮）'
       })()`
    )
    const treeBeforeEnter = beforeEnter.treeShown

    // 第三步：点「进入主题」→ 下方展开树
    const entered = await evaluate<boolean>(
      context,
      `(() => {
         const button = document.querySelector('[data-testid="learning-enter-topic"]')
         if (!button) return false
         button.click()
         return true
       })()`
    )
    const treeAfterEnter = await untilTrue(
      context,
      `(() => {
         const root = document.querySelector('[data-testid="learning-tree-root"]')
         return !!root && root.getAttribute('data-tree-owner') === ${JSON.stringify(seed.topicId)}
       })()`,
      16,
      250
    )
    await wait(200)
    const afterEnter = await evaluate<ReadingView>(context, readingViewExpr)
    const previewKept =
      afterEnter.previewShown &&
      Math.abs(afterEnter.previewTop - beforeEnter.previewTop) <= 1 &&
      Math.abs(afterEnter.previewHeight - beforeEnter.previewHeight) <= 1
    const cardsKept = afterEnter.cardsCount === 2
    const treeBelowPreview = afterEnter.treeTop >= afterEnter.previewBottom - 1
    record({
      id: 'P8-S1',
      prd: 'TASKS09-§6.6',
      name: '三步走：点主题出预览（还没有树）→ 点「进入主题」下方展开树，预览与中区两块仍留在上面',
      passed:
        previewTitle !== null &&
        treeBeforeEnter === false &&
        lockedShown &&
        enterState === '0' &&
        entered &&
        treeAfterEnter &&
        previewKept &&
        cardsKept &&
        treeBelowPreview,
      detail: `点主题后预览标题=「${previewTitle ?? '（没等到）'}」；未进入时 树在=${treeBeforeEnter} 提示卡在=${lockedShown} 按钮 data-entered=${enterState}（期望 0）；点「进入主题」=${entered} 树出现=${treeAfterEnter}；预览仍在=${afterEnter.previewShown} 位置 top ${beforeEnter.previewTop}→${afterEnter.previewTop} 高 ${beforeEnter.previewHeight}→${afterEnter.previewHeight}（都没动=${previewKept}）；中区两块=${afterEnter.cardsCount}（保留=${cardsKept}）；树顶 ${afterEnter.treeTop} ≥ 预览底 ${afterEnter.previewBottom}（在下方的=${treeBelowPreview}）`
    })
  } catch (error) {
    record({
      id: 'P8-S1',
      prd: 'TASKS09-§6.6',
      name: '三步走：点主题出预览（还没有树）→ 点「进入主题」下方展开树，预览与中区两块仍留在上面',
      passed: false,
      detail: `${String(error)}；${diagnostics()}`
    })
  }

  // ---- S2 左栏：主题行四要素（名字 / 进度% / 资料数 / 时长）+ 中间滚 + 底部固定 ----
  try {
    if (seed === null) throw new Error('样本没造出来')
    const view = await evaluate<ReadingView>(context, readingViewExpr)
    const scrollable =
      (view.listOverflow === 'auto' || view.listOverflow === 'scroll') &&
      view.listScroll > view.listClient
    const metaPattern = /^\d+% · 资料 \d+ · \d+ 分钟$/
    const rowsOk =
      view.topics.length >= 8 &&
      view.topics.every((row) => row.title !== '' && metaPattern.test(row.meta))
    // 本块自己造的那一行：四样都要能对上（资料 3 份）
    const ownRow = view.topics.find((row) => row.percent !== '' && row.meta.includes('资料 3'))
    const ownMeta = ownRow === undefined ? '' : ownRow.meta
    // 把列表滚到底，确认底部「数据与设置」没有被推走
    await evaluate(
      context,
      `(() => {
         const list = document.querySelector('[data-testid="sidebar-list"]')
         if (list) list.scrollTop = list.scrollHeight
         return true
       })()`
    )
    await wait(200)
    const afterScroll = await evaluate<ReadingView>(context, readingViewExpr)
    const bottomStillThere =
      afterScroll.bottomBottom <= afterScroll.viewportHeight + 1 &&
      Math.abs(afterScroll.bottomTop - view.bottomTop) <= 1
    record({
      id: 'P8-S2',
      prd: 'TASKS09-§6.1',
      name: '左栏主题列表：每行「名字 / 进度% / 资料数 / 时长」，中间列表自己滚、底部「数据与设置」始终可见',
      passed: scrollable && rowsOk && ownMeta !== '' && bottomStillThere,
      detail: `列表 内容高=${view.listScroll} 可视高=${view.listClient} overflow=${view.listOverflow} 能滚=${scrollable}；主题 ${view.topics.length} 行，四要素格式全部符合=${rowsOk}（样本里的主题行="${ownMeta}"）；把列表滚到底后底部 top=${afterScroll.bottomTop} bottom=${afterScroll.bottomBottom} 视口=${afterScroll.viewportHeight} 仍在屏幕内=${bottomStillThere}`
    })
  } catch (error) {
    record({
      id: 'P8-S2',
      prd: 'TASKS09-§6.1',
      name: '左栏主题列表：每行「名字 / 进度% / 资料数 / 时长」，中间列表自己滚、底部「数据与设置」始终可见',
      passed: false,
      detail: `${String(error)}；${diagnostics()}`
    })
  }

  // ---- S3 中区两块：固定约 132px，各自内部滚 ----
  try {
    if (seed === null) throw new Error('样本没造出来')
    const view = await evaluate<ReadingView>(context, readingViewExpr)
    const heightsFixed =
      view.cardHeights.length === 2 &&
      view.cardHeights.every((height) => height >= 120 && height <= 150) &&
      view.cardHeights[0] === view.cardHeights[1]
    const overflowOk = view.cardOverflow.every((value) => value === 'auto' || value === 'scroll')
    const logsScrolls =
      (view.cardBodyScroll[1] ?? 0) > (view.cardBodyClient[1] ?? 0) + 1
    const resourcesShown = await evaluate<number>(
      context,
      `document.querySelectorAll('[data-testid="learning-resource-row"]').length`
    )
    const logsShown = await evaluate<number>(
      context,
      `document.querySelectorAll('[data-testid="learning-log"]').length`
    )
    record({
      id: 'P8-S3',
      prd: 'TASKS09-§6.3',
      name: '中区两块（资料 / 学习日志）固定约 132px、各自内部滚；资料卡显示「分组 · 类型 · 占比」',
      passed: heightsFixed && overflowOk && logsScrolls && resourcesShown >= 3 && logsShown >= 6,
      detail: `卡片数=${view.cardHeights.length} 高度=${view.cardHeights.join('/')}px 两块等高且 ~132=${heightsFixed}；内部 overflow=${view.cardOverflow.join('/')}；日志卡 内容高=${view.cardBodyScroll[1]} 可视高=${view.cardBodyClient[1]} 能内部滚=${logsScrolls}；资料 ${resourcesShown} 行、日志 ${logsShown} 条`
    })
  } catch (error) {
    record({
      id: 'P8-S3',
      prd: 'TASKS09-§6.3',
      name: '中区两块（资料 / 学习日志）固定约 132px、各自内部滚；资料卡显示「分组 · 类型 · 占比」',
      passed: false,
      detail: `${String(error)}；${diagnostics()}`
    })
  }

  // ---- S4 树按内容高、不再内部滚（滚轮规矩 2026-10 修订） ----
  try {
    if (seed === null) throw new Error('样本没造出来')
    await expandWholeTree()
    const view = await evaluate<ReadingView>(context, readingViewExpr)
    /*
     * 旧口径（"树吃满剩余高度且内部滚")已作废：下区跟随整页滚以后，
     * 树是**按内容自然变高**的，行数再多也不该在自己那一小块里滚。
     * "整页往下翻能看到树底"这条行为面由 `P8-W2` 覆盖。
     */
    const mainGrowsWithContent = view.mainHeight > 0 && view.treeHeight > 0
    const treeNotInternalScroll =
      (view.treeListOverflow === 'visible' || view.treeListOverflow === '') &&
      view.treeListScroll <= view.treeListClient + 1
    record({
      id: 'P8-S4',
      prd: 'TASKS09-§6.4',
      name: '学习页的树按内容自然变高、不再内部滚（滚轮规矩 2026-10 修订：下区跟随整页往下翻）',
      passed: mainGrowsWithContent && treeNotInternalScroll,
      detail: `主体高=${view.mainHeight} 顶=${view.mainTop} 底=${view.mainBottom} 内容区底=${view.contentBottom}；树高=${view.treeHeight}；树列表 overflow=${view.treeListOverflow} 可视=${view.treeListClient} 内容=${view.treeListScroll} 不再内部滚=${treeNotInternalScroll}（旧口径要的"吃满高度 + 树里滚"已作废，见 W2）`
    })
  } catch (error) {
    record({
      id: 'P8-S4',
      prd: 'TASKS09-§6.4',
      name: '学习页的树按内容自然变高、不再内部滚（滚轮规矩 2026-10 修订：下区跟随整页往下翻）',
      passed: false,
      detail: `${String(error)}；${diagnostics()}`
    })
  }

  // ---- S5 学习页的滚轮规矩（2026-10 修订：页面级仍零溢出，滚动发生在右侧内容区） ----
  try {
    const view = await readModuleScroll(context)
    if (view === null) throw new Error('没等到学习页的三段骨架渲染出来')
    const verdict = judgeModuleScroll(view)
    record({
      id: 'P8-S5',
      prd: 'TASKS09-§6.4',
      name: '学习页滚轮规矩（2026-10 修订）：页面级零滚动条、滚动发生在右侧内容区，左栏不跟着滚、底部「数据与设置」始终可点、中区两块仍 132px 内部滚',
      passed: verdict.passed,
      detail: verdict.detail
    })
  } catch (error) {
    record({
      id: 'P8-S5',
      prd: 'TASKS09-§6.4',
      name: '学习页滚轮规矩（2026-10 修订）：页面级零滚动条、滚动发生在右侧内容区，左栏不跟着滚、底部「数据与设置」始终可点、中区两块仍 132px 内部滚',
      passed: false,
      detail: `${String(error)}；${diagnostics()}`
    })
  }

  // ---- S6 资料行两个数字：`占比 X% · 已学 Y%（n/m）`，主题进度按占比加权 ----
  try {
    if (seed === null) throw new Error('样本没造出来')
    await expandWholeTree()
    const rows = await seedRows()
    const [resA, resB, resC] = seed.resourceIds
    const textOf = (id: string | undefined): string =>
      rows.find((row) => row.id === id)?.progress ?? ''
    const aText = textOf(resA)
    const bText = textOf(resB)
    const cText = textOf(resC)
    // 资料 A：最小单元 4 个（1.1 勾、1.2 勾、1.3 未勾、第二章未勾）→ 已学 50%
    const sharesOk =
      aText.includes('占比 50%') &&
      aText.includes('已学 50%（2/4）') &&
      bText.includes('占比 30%') &&
      bText.includes('已学 50%（1/2）') &&
      cText.includes('占比 20%') &&
      cText.includes('已学 0%（0/1）')
    const computed = await evaluate<string>(
      context,
      `((document.querySelector('[data-testid="learning-progress-computed"]') || {}).textContent || '').trim()`
    )
    // 主题进度 = (50×50 + 30×50 + 20×0) ÷ 100 = 40%
    record({
      id: 'P8-S6',
      prd: 'TASKS09-§6.4',
      name: '树里的资料行显示两个数字 `占比 X% · 已学 Y%（n/m）`；主题进度 = Σ(占比 × 内部完成度) ÷ Σ占比',
      passed: sharesOk && computed === '40%',
      detail: `资料A 行="${aText}"（期望 占比 50% · 已学 50%（2/4））；资料B 行="${bText}"；资料C 行="${cText}"；两个数字全对=${sharesOk}；主题进度显示="${computed}"（期望 40%）`
    })
  } catch (error) {
    record({
      id: 'P8-S6',
      prd: 'TASKS09-§6.4',
      name: '树里的资料行显示两个数字 `占比 X% · 已学 Y%（n/m）`；主题进度 = Σ(占比 × 内部完成度) ÷ Σ占比',
      passed: false,
      detail: `${String(error)}；${diagnostics()}`
    })
  }

  // ---- S7 虚线框＝汇总、实心框＝最小单元，两者能区分 ----
  try {
    if (seed === null) throw new Error('样本没造出来')
    await expandWholeTree()
    const rows = await seedRows()
    const summaryRow = rows.find((row) => row.id === seed?.summaryId)
    const leafRow = rows.find((row) => row.id === seed?.leafId)
    const chapterRow = rows.find((row) => row.id === seed?.chapterId)
    const parentOf = await evaluate<Record<string, string | null>>(
      context,
      `(window.__treeParentMap || {})`
    )
    /** 汇总节点必须是那个最小单元的祖先（随便两行不算数） */
    const isAncestor = (candidate: string | undefined, of: string | undefined): boolean => {
      if (candidate === undefined || of === undefined) return false
      let cursor: string | null | undefined = parentOf[of]
      const guard = new Set<string>([of])
      while (cursor !== null && cursor !== undefined) {
        if (cursor === candidate) return true
        if (guard.has(cursor)) return false
        guard.add(cursor)
        cursor = parentOf[cursor] ?? null
      }
      return false
    }
    const summaryIsDashed =
      summaryRow?.checkBorder === 'dashed' &&
      summaryRow.summary === true &&
      summaryRow.checkDisabled === true
    const leafIsSolid =
      leafRow?.checkBorder === 'solid' &&
      leafRow.summary === false &&
      leafRow.checkDisabled === false
    // 「第二章」没有子节点 → 自己就是最小单元（不严格分层：同一层既有汇总又有最小单元）
    const chapterIsSolid = chapterRow?.checkBorder === 'solid' && chapterRow.summary === false
    const ancestorOk = isAncestor(seed.summaryId, seed.leafId)
    record({
      id: 'P8-S7',
      prd: 'TASKS09-§6.4',
      name: '虚线框＝汇总节点（勾不可点）、实心框＝最小单元（可打勾），且同一层可以既有汇总又直接打勾',
      passed: summaryIsDashed && leafIsSolid && chapterIsSolid && ancestorOk,
      detail: `汇总章节「第一章」边框=${summaryRow?.checkBorder ?? '（没这行）'} summary=${String(summaryRow?.summary)} 勾不可点=${String(summaryRow?.checkDisabled)}；最小单元「1.1」边框=${leafRow?.checkBorder ?? '（没这行）'} summary=${String(leafRow?.summary)} 勾不可点=${String(leafRow?.checkDisabled)}（false = 可点）；「第二章」（无子节点）边框=${chapterRow?.checkBorder ?? '（没这行）'}；汇总是最小单元的祖先=${ancestorOk}`
    })
  } catch (error) {
    record({
      id: 'P8-S7',
      prd: 'TASKS09-§6.4',
      name: '虚线框＝汇总节点（勾不可点）、实心框＝最小单元（可打勾），且同一层可以既有汇总又直接打勾',
      passed: false,
      detail: `${String(error)}；${diagnostics()}`
    })
  }

  // ---- S8 点资料行就地改占比：填任意数字，自动归一化 ----
  try {
    if (seed === null) throw new Error('样本没造出来')
    await expandWholeTree()
    const targets: Array<[string, string]> = [
      [seed.resourceIds[0] ?? '', '5'],
      [seed.resourceIds[1] ?? '', '3'],
      [seed.resourceIds[2] ?? '', '2']
    ]
    const editLog: string[] = []
    for (const [id, value] of targets) {
      const clicked = await evaluate<boolean>(
        context,
        `(() => {
           const row = document.querySelector('[data-testid="learning-tree-row"][data-node-id="${id}"]')
           const line = row && row.querySelector('.tree__line')
           if (line) line.click()
           return !!line
         })()`
      )
      const editorOpen = await untilTrue(context, `window.__verify.exists('learning-share-editor')`, 8, 200)
      const typed = await evaluate<boolean>(
        context,
        `(() => {
           const input = window.__verify.byTestId('learning-share-input')
           if (!input) return false
           const descriptor = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')
           if (descriptor && descriptor.set) descriptor.set.call(input, ${JSON.stringify(value)})
           input.dispatchEvent(new Event('input', { bubbles: true }))
           return true
         })()`
      )
      await wait(150)
      await evaluate(context, `window.__verify.click('[data-testid="learning-share-save"]')`)
      const closed = await untilTrue(context, `!window.__verify.exists('learning-share-editor')`, 10, 200)
      editLog.push(`${id.slice(0, 6)}=${value} 打开=${editorOpen} 填值=${typed} 保存后收起=${closed}`)
      if (!clicked || !editorOpen || !typed || !closed) throw new Error(`改占比没走通：${editLog[editLog.length - 1]}`)
    }
    await evaluate(context, `window.api.data.flush()`)
    await wait(300)

    // ① 界面上一整排都必须显示**归一化之后**的 50% / 30% / 20%
    await expandWholeTree()
    const rows = await seedRows()
    const texts = seed.resourceIds.map(
      (id) => rows.find((row) => row.id === id)?.progress ?? ''
    )
    const shownOk =
      texts[0]?.includes('占比 50%') === true &&
      texts[1]?.includes('占比 30%') === true &&
      texts[2]?.includes('占比 20%') === true
    // ② 落库的是用户填的**原始数字** 5 / 3 / 2（不折算、不改写）
    const alive = await evaluate<Array<Record<string, unknown>>>(
      context,
      `window.api.data.listAlive('learning')`
    )
    const stored = seed.resourceIds.map(
      (id) => alive.find((item) => item['id'] === id)?.['percent'] ?? null
    )
    const storedOk =
      stored[0] === 5 && stored[1] === 3 && stored[2] === 2
    // ③ 归一化不该改变主题进度：(5×50 + 3×50 + 2×0) ÷ 10 = 40%
    const computed = await evaluate<string>(
      context,
      `((document.querySelector('[data-testid="learning-progress-computed"]') || {}).textContent || '').trim()`
    )
    record({
      id: 'P8-S8',
      prd: 'TASKS09-§6.5',
      name: '点资料行就地改占比：填任意数字（5/3/2）后界面自动归一化成 50%/30%/20%，落库保留原始数字',
      passed: shownOk && storedOk && computed === '40%',
      detail: `改占比过程=${editLog.join('；')}；界面显示=${texts.map((text) => (text.includes('占比') ? text.split(' · ')[0] : text)).join(' / ')}（归一化后应为 占比 50% / 30% / 20%，符合=${shownOk}）；落库原始数字=${stored.join('/')}（应为 5/3/2，符合=${storedOk}）；主题进度="${computed}"（归一化不改主题进度，期望 40%）`
    })
  } catch (error) {
    record({
      id: 'P8-S8',
      prd: 'TASKS09-§6.5',
      name: '点资料行就地改占比：填任意数字（5/3/2）后界面自动归一化成 50%/30%/20%，落库保留原始数字',
      passed: false,
      detail: `${String(error)}；${diagnostics()}`
    })
  }

  // ---- S9 点章节 → 就地展开「记一次学习」与这一节的学习记录 ----
  try {
    if (seed === null) throw new Error('样本没造出来')
    await expandWholeTree()
    let detailShown = false
    let attempts = 0
    for (; attempts < 3 && !detailShown; attempts += 1) {
      await evaluate(
        context,
        `(() => {
           const row = document.querySelector('[data-testid="learning-tree-row"][data-node-id="${seed.chapterId}"]')
           const line = row && row.querySelector('.tree__line')
           if (line) line.click()
           return !!line
         })()`
      )
      detailShown = await untilTrue(
        context,
        `(() => {
           const row = document.querySelector('[data-testid="learning-tree-row"][data-node-id="${seed.chapterId}"]')
           const detail = row && row.querySelector('[data-testid="learning-tree-detail"]')
           return !!detail && !!detail.querySelector('[data-testid="learning-node-log-input"]')
         })()`,
        5,
        200
      )
    }
    const detailSnapshot = await evaluate<{
      composer: boolean
      logCount: number
      text: string
      minutesButtons: number
    }>(
      context,
      `(() => {
         const row = document.querySelector('[data-testid="learning-tree-row"][data-node-id="${seed.chapterId}"]')
         const detail = row && row.querySelector('[data-testid="learning-tree-detail"]')
         const logs = detail ? Array.from(detail.querySelectorAll('[data-testid="learning-node-log"]')) : []
         const text = logs.map((item) => (item.textContent || '').trim()).join(' | ')
         return {
           composer: !!detail && !!detail.querySelector('[data-testid="learning-node-log-input"]'),
           logCount: logs.length,
           text,
           minutesButtons: detail ? detail.querySelectorAll('[data-testid^="learning-node-minutes-"]').length : 0
         }
       })()`
    )
    record({
      id: 'P8-S9',
      prd: 'TASKS09-§6.5',
      name: '点章节就地展开「记一次学习」与这一节的学习记录（日志挂在章节上，决定 16）',
      passed:
        detailShown &&
        detailSnapshot.composer &&
        detailSnapshot.minutesButtons === 3 &&
        detailSnapshot.logCount >= 1 &&
        detailSnapshot.text.includes('章节日志'),
      detail: `展开=${detailShown}（点了 ${attempts} 次）；记一次学习输入区在=${detailSnapshot.composer} 时长快捷键=${detailSnapshot.minutesButtons} 个；这一节的记录 ${detailSnapshot.logCount} 条，含本块造的那条=${detailSnapshot.text.includes('章节日志')}（正文="${detailSnapshot.text.slice(0, 60)}…"）`
    })
  } catch (error) {
    record({
      id: 'P8-S9',
      prd: 'TASKS09-§6.5',
      name: '点章节就地展开「记一次学习」与这一节的学习记录（日志挂在章节上，决定 16）',
      passed: false,
      detail: `${String(error)}；${diagnostics()}`
    })
  }

  // ---- S10 层数不限，第 5 层起缩进收窄到 12px ----
  try {
    if (seed === null) throw new Error('样本没造出来')
    await expandWholeTree()
    interface IndentRow {
      id: string
      depth: number
      indent: number
      title: string
    }
    const all = await evaluate<IndentRow[]>(
      context,
      `(() => {
         return Array.from(document.querySelectorAll('[data-testid="learning-tree-row"]')).map((row) => {
           const line = row.querySelector('.tree__line')
           return {
             id: row.getAttribute('data-node-id') || '',
             depth: Number(row.getAttribute('data-depth') || '0'),
             indent: line ? Number(line.getAttribute('data-indent') || '0') : -1,
             title: ((row.querySelector('[data-testid="learning-tree-title"]') || {}).textContent || '').trim()
           }
         })
       })()`
    )
    const own = all.filter((row) => seed !== null && row.id === seed.deepLeafId)
    const deep = own[0]
    const indentOfDepth = new Map<number, number>()
    for (const row of all) if (!indentOfDepth.has(row.depth)) indentOfDepth.set(row.depth, row.indent)
    const level5 = indentOfDepth.get(4)
    const level6 = indentOfDepth.get(5)
    const level7 = indentOfDepth.get(6)
    const level4 = indentOfDepth.get(3)
    const stepWide = level4 !== undefined && level5 !== undefined ? level5 - level4 : -1
    const stepNarrow = level5 !== undefined && level6 !== undefined ? level6 - level5 : -1
    const deepEnough = deep !== undefined && deep.depth >= 6 && deep.indent >= 104
    record({
      id: 'P8-S10',
      prd: 'TASKS09-§6.4',
      name: '层数不限（第 7 层也渲染出来）；第 5 层起缩进收窄到 12px（第 4 层仍是 20px）',
      passed:
        deepEnough &&
        level5 === 80 &&
        level6 === 92 &&
        level7 === 104 &&
        stepWide === 20 &&
        stepNarrow === 12,
      detail: `最深那条 depth=${deep?.depth ?? -1}（第 ${(deep?.depth ?? -2) + 1} 层）缩进=${deep?.indent ?? -1}；各深度缩进 depth3=${level4 ?? '（没这层）'} depth4=${level5 ?? '（没这层）'} depth5=${level6 ?? '（没这层）'} depth6=${level7 ?? '（没这层）'}（期望 60/80/92/104）；depth3→4 增量=${stepWide}（期望 20）depth4→5 增量=${stepNarrow}（期望 12）`
    })
  } catch (error) {
    record({
      id: 'P8-S10',
      prd: 'TASKS09-§6.4',
      name: '层数不限（第 7 层也渲染出来）；第 5 层起缩进收窄到 12px（第 4 层仍是 20px）',
      passed: false,
      detail: `${String(error)}；${diagnostics()}`
    })
  }

  // =========================================================================
  // W. 体验修正轮（2026-10）：滚轮规矩 / 中区删除入口 / 就地面板可收起
  //
  // 编号说明：A–N、R、S、U、V 都已被前面的块占用，本块用 **W**
  // （`修改.md` §8.3 指定的就是 P8-W1…W10）。
  //
  // 分三处落地：
  //   - 学习页：W1（未进入主题时下区随页面滚）、W2（树长时整页往下能翻到树底）、
  //             W3（中区两块仍是 132px）、W4（资料行 ⋯ 与树里同一批项）、
  //             W5（从资料行删 → 二次确认 → 回收站 → 可恢复）、W9（面板可收起）
  //   - 复习页：W6（到期卡片行 ⋯ 与树里同一批项）、W7（从卡片行删 → 回收站 → 可恢复）
  //   - 读书页：W10（面板可收起 + Esc）
  //   - 收尾：W8（计划页 / 设置页仍零页面级滚动条——防止这次改动扩散）
  // =========================================================================

  // ---- W3 中区两块仍是 [132,132] + overflow=auto（滚动模型改造没把它们带跑） ----
  try {
    if (seed === null) throw new Error('样本没造出来')
    const view = await evaluate<ReadingView>(context, readingViewExpr)
    const heightsOk =
      view.cardHeights.length === 2 &&
      view.cardHeights.every((height) => height >= 120 && height <= 150) &&
      view.cardHeights[0] === view.cardHeights[1]
    const overflowOk = view.cardOverflow.every((value) => value === 'auto' || value === 'scroll')
    record({
      id: 'P8-W3',
      prd: '修改-§8.3',
      name: '中区两块仍是 [132,132]px 且各自内部滚（下区改成跟随整页滚**没有**把它们带跑）',
      passed: heightsOk && overflowOk,
      detail: `中区卡片数=${view.cardHeights.length}（期望 2）高度=[${view.cardHeights.join(',')}]px（期望 132/132）=${heightsOk}；内部 overflow=[${view.cardOverflow.join(',')}]（要求 auto/scroll）=${overflowOk}`
    })
  } catch (error) {
    record({
      id: 'P8-W3',
      prd: '修改-§8.3',
      name: '中区两块仍是 [132,132]px 且各自内部滚（下区改成跟随整页滚**没有**把它们带跑）',
      passed: false,
      detail: `${String(error)}；${diagnostics()}`
    })
  }

  // ---- W2 树很长时：整页往下翻能看到树底（树不再自己滚） ----
  try {
    if (seed === null) throw new Error('样本没造出来')
    // 自带前提：把整棵树全展开（层数不限，多轮逐层点击），树才有足够多的行
    await expandWholeTree()
    const shot = await until<{
      treeOverflow: string
      treeScroll: number
      treeClient: number
      workspaceOverflow: string
      workspaceScrollTop: number
      workspaceScrollHeight: number
      workspaceClientHeight: number
      rows: number
      lastRowBottom: number
      viewportHeight: number
      pageScrollHeight: number
      pageClientHeight: number
    } | null>(
      context,
      `(() => {
         const list = document.querySelector('[data-testid="learning-tree-list"]')
         const rows = Array.from(document.querySelectorAll('[data-testid="learning-tree-row"]'))
         const workspace = document.querySelector('[data-testid="workspace"]')
         if (!list || rows.length === 0 || !workspace) return null
         const lastRect = rows[rows.length - 1].getBoundingClientRect()
         const doc = document.scrollingElement
         return {
           treeOverflow: getComputedStyle(list).overflowY,
           treeScroll: list.scrollHeight,
           treeClient: list.clientHeight,
           workspaceOverflow: getComputedStyle(workspace).overflowY,
           workspaceScrollTop: Math.round(workspace.scrollTop),
           workspaceScrollHeight: workspace.scrollHeight,
           workspaceClientHeight: workspace.clientHeight,
           rows: rows.length,
           lastRowBottom: Math.round(lastRect.bottom),
           viewportHeight: window.innerHeight,
           pageScrollHeight: doc ? doc.scrollHeight : -1,
           pageClientHeight: doc ? doc.clientHeight : -1
         }
       })()`,
      (value) => value !== null && value.rows > 4,
      14,
      250
    )
    if (shot === null) throw new Error('没等到展开后的学习树')
    // 树自己不许再滚（内容高 == 可视高）
    const treeNotInternal =
      (shot.treeOverflow === 'visible' || shot.treeOverflow === '') &&
      shot.treeScroll <= shot.treeClient + 1
    // 整页（右侧内容区）必须能滚，而且滚到底以后**最后一行树**在屏幕内 = "能跟随往下翻"
    await evaluate(
      context,
      `(() => {
         const workspace = document.querySelector('[data-testid="workspace"]')
         if (workspace) workspace.scrollTop = workspace.scrollHeight
         return true
       })()`
    )
    const after = await until<{
      scrollTop: number
      maxScrollTop: number
      lastRowBottom: number
      viewportHeight: number
      pageScrollHeight: number
      pageClientHeight: number
    } | null>(
      context,
      `(() => {
         const workspace = document.querySelector('[data-testid="workspace"]')
         const rows = Array.from(document.querySelectorAll('[data-testid="learning-tree-row"]'))
         if (!workspace || rows.length === 0) return null
         const doc = document.scrollingElement
         return {
           scrollTop: Math.round(workspace.scrollTop),
           maxScrollTop: Math.round(workspace.scrollHeight - workspace.clientHeight),
           lastRowBottom: Math.round(rows[rows.length - 1].getBoundingClientRect().bottom),
           viewportHeight: window.innerHeight,
           pageScrollHeight: doc ? doc.scrollHeight : -1,
           pageClientHeight: doc ? doc.clientHeight : -1
         }
       })()`,
      (value) => value !== null && value.scrollTop > 0,
      12,
      200
    )
    if (after === null) throw new Error('右侧内容区滚不动（下区仍被困在固定高度里）')
    const scrolledToBottom = Math.abs(after.scrollTop - after.maxScrollTop) <= 2
    const lastRowReachable =
      after.lastRowBottom <= after.viewportHeight + 1 && after.lastRowBottom > 0
    // 页面级仍然零溢出：滚的是右侧内容区，不是整页
    const pageStillZero = after.pageScrollHeight <= after.pageClientHeight + 1
    record({
      id: 'P8-W2',
      prd: '修改-§8.3',
      name: '学习页树很长时：整页往下翻能看到树底（树不再自己内部滚，滚动发生在右侧内容区）',
      passed:
        shot.rows > 4 &&
        treeNotInternal &&
        (shot.workspaceOverflow === 'auto' || shot.workspaceOverflow === 'scroll') &&
        shot.workspaceScrollHeight > shot.workspaceClientHeight &&
        scrolledToBottom &&
        lastRowReachable &&
        pageStillZero,
      detail: `展开后树 ${shot.rows} 行；树列表 overflow=${shot.treeOverflow} 可视=${shot.treeClient} 内容=${shot.treeScroll} 不再内部滚=${treeNotInternal}；右侧内容区 overflow=${shot.workspaceOverflow} 内容高=${shot.workspaceScrollHeight} 可视高=${shot.workspaceClientHeight}（能滚=${shot.workspaceScrollHeight > shot.workspaceClientHeight}）；把内容区滚到底 scrollTop=${after.scrollTop}（可滚上限=${after.maxScrollTop}，到底=${scrolledToBottom}）后最后一行树底边=${after.lastRowBottom} 视口=${after.viewportHeight}（在屏幕内=${lastRowReachable}）；同时页面级仍零溢出=${pageStillZero}（${after.pageScrollHeight}/${after.pageClientHeight}）`
    })
  } catch (error) {
    record({
      id: 'P8-W2',
      prd: '修改-§8.3',
      name: '学习页树很长时：整页往下翻能看到树底（树不再自己内部滚，滚动发生在右侧内容区）',
      passed: false,
      detail: `${String(error)}；${diagnostics()}`
    })
  }

  // ---- W4 学习页「资料」行有 ⋯，且与树里资料行取到的是**同一份定义**的菜单项 ----
  //
  // 口径修订（修改 2 轮 · 2026-10）：树里新增了四个移动动作，
  // 而中区那张卡是**扁平的资料列表**——"上一个兄弟 / 上一层"在那儿没有意义，
  // 所以适配层**刻意**不给这四项。断言因此从「两处完全相同」改成
  // 「中区 = 树里去掉这四项」，并**新增**「树里多出的正好是这四项」。
  // 这不是放宽：差异必须是**恰好**这四项，多一项少一项都算红。
  try {
    if (seed === null) throw new Error('样本没造出来')
    await closeFloaters(context)
    // 滚回顶部：资料卡在页面上方，浮层定位依赖真实坐标（"元素在视口外"会点不到）
    await evaluate(
      context,
      `(() => {
         const workspace = document.querySelector('[data-testid="workspace"]')
         if (workspace) workspace.scrollTop = 0
         return true
       })()`
    )
    await wait(200)
    const resourceId = seed.resourceIds[0]
    const rowReady = await untilTrue(
      context,
      `!!document.querySelector('[data-testid="learning-resource-row"][data-resource-id="${resourceId}"]')`,
      10,
      200
    )
    if (!rowReady) throw new Error('「资料」卡里没有本块造的那份资料')

    // ① 中区这一行的 `⋯`
    const bandOpened = await clickMenuButton(context, 'learning-resource-menu', `[data-testid="learning-resource-row"][data-resource-id="${resourceId}"]`)
    const bandMenu = bandOpened ? await waitForMenu(context) : null
    if (bandMenu === null) throw new Error('点「资料」行的 ⋯ 没有出菜单')
    const bandIds = bandMenu.ids
    await evaluate(context, `window.__verify.key('Escape')`)
    await wait(150)

    // ② 树里同一个资料行（右键）
    await closeFloaters(context)
    const treeRowShown = await untilTrue(
      context,
      `!!document.querySelector('[data-testid="learning-tree-row"][data-node-id="${resourceId}"]')`,
      10,
      200
    )
    if (!treeRowShown) throw new Error('树里找不到这份资料（树的展开状态被前面的检查改了？）')
    const rightClicked = await rightClickSelector(
      context,
      `[data-testid="learning-tree-row"][data-node-id="${resourceId}"]`
    )
    const treeMenu = rightClicked ? await waitForMenu(context) : null
    if (treeMenu === null) throw new Error('树里那份资料右键没有出菜单')
    const treeIds = treeMenu.ids
    await evaluate(context, `window.__verify.key('Escape')`)
    await wait(150)

    // 中区 = 树里去掉那四项；反过来中区不许有树里没有的项
    const listView = treeIds.filter((id) => !MOVE2_IDS.includes(id))
    const sameAfterFilter = bandIds.join('|') === listView.join('|')
    const extraInTree = treeIds.filter((id) => !bandIds.includes(id))
    const extraInBand = bandIds.filter((id) => !treeIds.includes(id))
    const extraIsExactlyMoves =
      extraInTree.length === MOVE2_IDS.length && MOVE2_IDS.every((id) => extraInTree.includes(id))
    record({
      id: 'P8-W4',
      prd: '修改-§8.3',
      name: '学习页「资料」行有 ⋯；取到的是树里同一行那**一份定义**里适用于列表视图的项（树里多出的正好是四个移动项）',
      passed:
        bandIds.length > 0 &&
        bandIds.includes('node-delete') &&
        sameAfterFilter &&
        extraIsExactlyMoves &&
        extraInBand.length === 0,
      detail: `中区「资料」行 ⋯ 打开=${bandOpened} 菜单来源=${bandMenu.source} 项=[${bandIds.join(',')}]；树里同一行右键=${rightClicked} 菜单来源=${treeMenu.source} 项=[${treeIds.join(',')}]；去掉四项移动后完全相同=${sameAfterFilter}；树里比中区多出=[${extraInTree.join(',')}] 正好是那四项=${extraIsExactlyMoves}；中区比树里多出=[${extraInBand.join(',')}]（要为空）；两处都有「删除」=${bandIds.includes('node-delete') && treeIds.includes('node-delete')}`
    })
  } catch (error) {
    record({
      id: 'P8-W4',
      prd: '修改-§8.3',
      name: '学习页「资料」行有 ⋯；取到的是树里同一行那**一份定义**里适用于列表视图的项（树里多出的正好是四个移动项）',
      passed: false,
      detail: `${String(error)}；${diagnostics()}`
    })
  }

  // ---- W5 从「资料」行菜单删除 → 二次确认 → 回收站 → 可恢复 ----
  try {
    if (seed === null) throw new Error('样本没造出来')
    await closeFloaters(context)
    await evaluate(
      context,
      `(() => {
         const workspace = document.querySelector('[data-testid="workspace"]')
         if (workspace) workspace.scrollTop = 0
         return true
       })()`
    )
    /*
     * 自带前提：现场造一份**只给这条检查用**的资料（不动前面几条检查依赖的那三份），
     * 列进中区「资料」卡之后从那一行删掉，删完再从回收站恢复回来。
     */
    const doomedTitle = `${learningMarker} 待删资料W5`
    const doomedId = await evaluate<string>(
      context,
      `(async () => {
         const alive = await window.api.data.listAlive('learning')
         const existing = alive.find(
           (item) => item['kind'] === 'node' && String(item['title'] || '') === ${JSON.stringify(doomedTitle)}
         )
         if (existing) return String(existing['id'])
         const created = await window.api.data.add('learning', {
           kind: 'node',
           ownerId: ${JSON.stringify(seed.topicId)},
           topicId: ${JSON.stringify(seed.topicId)},
           parentId: null,
           order: 9,
           title: ${JSON.stringify(doomedTitle)},
           done: false,
           percent: 10
         })
         await window.api.data.flush()
         return String(created.id)
       })()`
    )
    await evaluate(
      context,
      `window.dispatchEvent(new CustomEvent('worklife:data-changed', { detail: { module: 'learning' } })), true`
    )
    const rowAppeared = await untilTrue(
      context,
      `!!document.querySelector('[data-testid="learning-resource-row"][data-resource-id="${doomedId}"]')`,
      14,
      250
    )
    if (!rowAppeared) throw new Error('新造的资料没有出现在「资料」卡里')

    // ① 从中区这一行的 ⋯ 选「删除」
    await closeMenu(context)
    const opened = await clickMenuButton(
      context,
      'learning-resource-menu',
      `[data-testid="learning-resource-row"][data-resource-id="${doomedId}"]`
    )
    const menu = opened ? await waitForMenu(context) : null
    if (menu === null) throw new Error('点「资料」行的 ⋯ 没有出菜单')
    const clickedDelete = await clickMenuItem(context, 'node-delete')
    // ② 二次确认（删节点一定有确认框，testid 与树里那条完全一样）
    const dialogShown = await untilTrue(
      context,
      `window.__verify.exists('learning-node-delete-dialog')`,
      10,
      200
    )
    if (!dialogShown) throw new Error('点了「删除」没有弹二次确认')
    const confirmed = await evaluate<boolean>(
      context,
      `window.__verify.click('[data-testid="dialog-confirm"]')`
    )
    // ③ 进回收站（软删除），存活列表里消失
    let inTrash = false
    let aliveAfterDelete = true
    for (let attempt = 0; attempt < 14; attempt += 1) {
      const trash = await evaluate<Array<Record<string, unknown>>>(context, `window.api.trash.list()`)
      inTrash = trash.some((item) => String(item['id'] ?? '') === doomedId)
      const alive = await evaluate<Array<Record<string, unknown>>>(
        context,
        `window.api.data.listAlive('learning')`
      )
      aliveAfterDelete = alive.some((item) => String(item['id'] ?? '') === doomedId)
      if (inTrash && !aliveAfterDelete) break
      await wait(200)
    }
    // ④ 从回收站恢复回来（软删除必须可逆）
    const restored = await evaluate<boolean>(
      context,
      `window.api.trash.restore('learning', ${JSON.stringify(doomedId)})`
    )
    const backAlive = await untilTrue(
      context,
      `(async () => {
         const alive = await window.api.data.listAlive('learning')
         return alive.some((item) => String(item['id'] || '') === ${JSON.stringify(doomedId)})
       })()`,
      12,
      200
    )
    record({
      id: 'P8-W5',
      prd: '修改-§8.3',
      name: '从「资料」行菜单点删除 → 弹二次确认 → 确认后进回收站（软删）→ 可从回收站恢复',
      passed:
        opened &&
        menu.ids.includes('node-delete') &&
        clickedDelete &&
        dialogShown &&
        confirmed &&
        inTrash &&
        !aliveAfterDelete &&
        restored &&
        backAlive,
      detail: `⋯ 打开=${opened}（项=[${menu.ids.join(',')}]）点「删除」=${clickedDelete}；二次确认弹出=${dialogShown} 确认=${confirmed}；进回收站=${inTrash} 存活列表里已消失=${!aliveAfterDelete}；恢复=${restored} 回到存活列表=${backAlive}`
    })
  } catch (error) {
    record({
      id: 'P8-W5',
      prd: '修改-§8.3',
      name: '从「资料」行菜单点删除 → 弹二次确认 → 确认后进回收站（软删）→ 可从回收站恢复',
      passed: false,
      detail: `${String(error)}；${diagnostics()}`
    })
  }

  // ---- W9 学习页就地面板可收起（「收起」按钮 / 再点这一行；且与子节点展开解耦） ----
  try {
    if (seed === null) throw new Error('样本没造出来')
    await closeFloaters(context)
    await expandWholeTree()

    /** 面板是不是开在某个节点上（读 DOM，不看内部状态） */
    const panelOpenOf = (nodeId: string): string => `(() => {
      const row = document.querySelector('[data-testid="learning-tree-row"][data-node-id="${nodeId}"]')
      if (!row) return false
      const detail = row.querySelector('[data-testid="learning-tree-detail"]')
      return !!detail && !!detail.querySelector('[data-testid="learning-node-panel-collapse"]')
    })()`
    /** 某个节点自己的子节点展开着吗 */
    const caretExpandedOf = (nodeId: string): string => `(() => {
      const row = document.querySelector('[data-testid="learning-tree-row"][data-node-id="${nodeId}"]')
      const caret = row && row.querySelector('.tree__caret')
      return !!caret && caret.getAttribute('aria-expanded') === 'true'
    })()`
    const clickLineOf = (nodeId: string): string => `(() => {
      const row = document.querySelector('[data-testid="learning-tree-row"][data-node-id="${nodeId}"]')
      const line = row && row.querySelector('.tree__line')
      if (line) line.click()
      return !!line
    })()`

    const leafId = seed.chapterId
    const summaryId = seed.summaryId

    // 复位：两个节点的面板先都收着
    for (const id of [leafId, summaryId]) {
      if (await evaluate<boolean>(context, panelOpenOf(id))) {
        await evaluate(
          context,
          `(() => {
             const row = document.querySelector('[data-testid="learning-tree-row"][data-node-id="${id}"]')
             const detail = row && row.querySelector('[data-testid="learning-tree-detail"]')
             const button = detail && detail.querySelector('[data-testid="learning-node-panel-collapse"]')
             if (button) button.click()
             return true
           })()`
        )
        await wait(200)
      }
    }

    // ① 点章节行 → 面板开（面板里带「收起」）
    const clickedOnce = await evaluate<boolean>(context, clickLineOf(leafId))
    const openedOnce = await untilTrue(context, panelOpenOf(leafId), 10, 200)
    // ② 点面板里的「收起」→ 面板消失
    const collapsed = await evaluate<boolean>(
      context,
      `(() => {
         const row = document.querySelector('[data-testid="learning-tree-row"][data-node-id="${leafId}"]')
         const detail = row && row.querySelector('[data-testid="learning-tree-detail"]')
         const button = detail && detail.querySelector('[data-testid="learning-node-panel-collapse"]')
         if (!button) return false
         button.click()
         return true
       })()`
    )
    const closedByButton = await untilTrue(context, `!${panelOpenOf(leafId)}`, 10, 200)
    // ③ 再点这一行 → 又开；再点一次 → 又收
    await evaluate(context, clickLineOf(leafId))
    const reopened = await untilTrue(context, panelOpenOf(leafId), 10, 200)
    await evaluate(context, clickLineOf(leafId))
    const closedByClick = await untilTrue(context, `!${panelOpenOf(leafId)}`, 10, 200)

    // ④ 拆开后互不影响：汇总节点（有子节点）面板开着时，展开子节点不会把面板弄没；
    //    收起面板以后子节点仍然展开着
    const summaryExpandedFirst = await evaluate<boolean>(context, caretExpandedOf(summaryId))
    if (!summaryExpandedFirst) {
      await evaluate(
        context,
        `(() => {
           const row = document.querySelector('[data-testid="learning-tree-row"][data-node-id="${summaryId}"]')
           const caret = row && row.querySelector('[data-testid="learning-tree-toggle"]')
           if (caret) caret.click()
           return true
         })()`
      )
      await wait(250)
    }
    // 点这一行：面板开（汇总行会顺带收起自己的子节点——那是树本来的行为）
    await evaluate(context, clickLineOf(summaryId))
    const summaryPanelOpen = await untilTrue(context, panelOpenOf(summaryId), 10, 200)
    // 再把它的子节点展开：面板必须还在
    const caretAfter = await evaluate<boolean>(context, caretExpandedOf(summaryId))
    if (!caretAfter) {
      await evaluate(
        context,
        `(() => {
           const row = document.querySelector('[data-testid="learning-tree-row"][data-node-id="${summaryId}"]')
           const caret = row && row.querySelector('[data-testid="learning-tree-toggle"]')
           if (caret) caret.click()
           return true
         })()`
      )
      await wait(250)
    }
    const childExpanded = await evaluate<boolean>(context, caretExpandedOf(summaryId))
    const childRowShown = await evaluate<boolean>(
      context,
      `!!document.querySelector('[data-testid="learning-tree-row"][data-node-id="${seed.leafId}"]')`
    )
    const panelSurvivedExpand = await evaluate<boolean>(context, panelOpenOf(summaryId))
    // 收面板：子节点必须还展开着
    await evaluate(
      context,
      `(() => {
         const row = document.querySelector('[data-testid="learning-tree-row"][data-node-id="${summaryId}"]')
         const detail = row && row.querySelector('[data-testid="learning-tree-detail"]')
         const button = detail && detail.querySelector('[data-testid="learning-node-panel-collapse"]')
         if (button) button.click()
         return true
       })()`
    )
    const summaryClosed = await untilTrue(context, `!${panelOpenOf(summaryId)}`, 10, 200)
    const childStillExpanded = await evaluate<boolean>(context, caretExpandedOf(summaryId))
    const childRowStillShown = await evaluate<boolean>(
      context,
      `!!document.querySelector('[data-testid="learning-tree-row"][data-node-id="${seed.leafId}"]')`
    )

    record({
      id: 'P8-W9',
      prd: '修改-§8.3',
      name: '学习页就地面板可收起：点章节开面板 → 面板里有「收起」→ 点它面板消失，子节点仍展开着；再点这一行也能收',
      passed:
        clickedOnce &&
        openedOnce &&
        collapsed &&
        closedByButton &&
        reopened &&
        closedByClick &&
        summaryPanelOpen &&
        childExpanded &&
        childRowShown &&
        panelSurvivedExpand &&
        summaryClosed &&
        childStillExpanded &&
        childRowStillShown,
      detail: `点章节行=${clickedOnce} 面板开出=${openedOnce}（面板里有「收起」）；点「收起」=${collapsed} 面板消失=${closedByButton}；再点这一行又开=${reopened} 再点一次又收（${closedByClick}）；汇总节点面板开出=${summaryPanelOpen}，展开它的子节点后 子节点展开=${childExpanded} 子行渲染=${childRowShown} 面板仍在=${panelSurvivedExpand}；点「收起」收面板=${summaryClosed} 之后 子节点仍展开=${childStillExpanded} 子行仍渲染=${childRowStillShown}`
    })
  } catch (error) {
    record({
      id: 'P8-W9',
      prd: '修改-§8.3',
      name: '学习页就地面板可收起：点章节开面板 → 面板里有「收起」→ 点它面板消失，子节点仍展开着；再点这一行也能收',
      passed: false,
      detail: `${String(error)}；${diagnostics()}`
    })
  }

  // ---- W1 学习页未进入主题时：下区提示卡随页面滚，左栏一直可见 ----
  try {
    if (seed === null) throw new Error('样本没造出来')
    await closeFloaters(context)
    // 先滚回顶部再退出主题，免得退出后量到的是一个已经滚到底的内容区
    await evaluate(
      context,
      `(() => {
         const workspace = document.querySelector('[data-testid="workspace"]')
         if (workspace) workspace.scrollTop = 0
         return true
       })()`
    )
    await wait(200)
    // 复位：如果还"在主题里"，点一下退出（同一个按钮，决定 1）
    await evaluate(
      context,
      `(() => {
         const button = document.querySelector('[data-testid="learning-enter-topic"]')
         if (!button) return false
         if (button.getAttribute('data-entered') === '1') button.click()
         return true
       })()`
    )
    const lockedShown = await untilTrue(
      context,
      `window.__verify.exists('learning-tree-locked')`,
      12,
      250
    )
    if (!lockedShown) throw new Error('点了「退出主题」，下区提示卡没有出现')
    await wait(200)
    const shot = await until<{
      hintOverflow: string
      hintScroll: number
      hintClient: number
      hintHeight: number
      mainOverflow: string
      mainScroll: number
      mainClient: number
      mainHeight: number
      workspaceOverflow: string
      workspaceGutter: string
      workspaceScrollHeight: number
      workspaceClientHeight: number
      sidebarScroll: number
      sidebarClient: number
      sidebarOverflow: string
      bottomTop: number
      bottomBottom: number
      viewportHeight: number
      pageScrollHeight: number
      pageClientHeight: number
      cards: number
    } | null>(
      context,
      `(() => {
         const hint = document.querySelector('[data-testid="learning-tree-locked"]')
         const main = document.querySelector('[data-testid="bands-main"]')
         const workspace = document.querySelector('[data-testid="workspace"]')
         const sidebar = document.querySelector('[data-testid="sidebar"]')
         const bottom = document.querySelector('[data-testid="sidebar-bottom"]')
         if (!hint || !main || !workspace) return null
         const box = (node) => (node ? node.getBoundingClientRect() : null)
         const round = (value) => (typeof value === 'number' ? Math.round(value) : -1)
         const hintRect = box(hint)
         const bottomRect = box(bottom)
         const doc = document.scrollingElement
         return {
           hintOverflow: getComputedStyle(hint).overflowY,
           hintScroll: hint.scrollHeight,
           hintClient: hint.clientHeight,
           hintHeight: round(hintRect ? hintRect.height : 0),
           mainOverflow: getComputedStyle(main).overflowY,
           mainScroll: main.scrollHeight,
           mainClient: main.clientHeight,
           mainHeight: round(box(main) ? box(main).height : 0),
           workspaceOverflow: getComputedStyle(workspace).overflowY,
           workspaceGutter: getComputedStyle(workspace).scrollbarGutter,
           workspaceScrollHeight: workspace.scrollHeight,
           workspaceClientHeight: workspace.clientHeight,
           sidebarScroll: sidebar ? sidebar.scrollHeight : -1,
           sidebarClient: sidebar ? sidebar.clientHeight : -1,
           sidebarOverflow: sidebar ? getComputedStyle(sidebar).overflowY : '',
           bottomTop: round(bottomRect ? bottomRect.top : -1),
           bottomBottom: round(bottomRect ? bottomRect.bottom : -1),
           viewportHeight: window.innerHeight,
           pageScrollHeight: doc ? doc.scrollHeight : -1,
           pageClientHeight: doc ? doc.clientHeight : -1,
           cards: document.querySelectorAll('.band-card').length
         }
       })()`,
      (value) => value !== null && value.cards === 2 && value.hintHeight > 0,
      14,
      250
    )
    if (shot === null) throw new Error('没等到下区提示卡渲染出来')
    /*
     * 判据（这正是用户要的那件事）：
     *   - 提示卡与下区**都不内部滚**（旧模型下 `.bands__main` 是 overflow:hidden 的固定高度框，
     *     提示卡就困在里面）→ 现在 main 的 overflow 是 visible，内容高 == 可视高
     *   - 滚动发生在**右侧内容区**（overflow auto + gutter stable）
     *   - 左栏**一直可见**：不被滚走，底部「数据与设置」在屏幕内
     *   - 页面级仍然零溢出
     */
    const hintNotBoxed =
      (shot.mainOverflow === 'visible' || shot.mainOverflow === '') &&
      shot.mainScroll <= shot.mainClient + 1 &&
      (shot.hintOverflow === 'visible' || shot.hintOverflow === '') &&
      shot.hintScroll <= shot.hintClient + 1
    const contentIsScroller =
      (shot.workspaceOverflow === 'auto' || shot.workspaceOverflow === 'scroll') &&
      shot.workspaceGutter === 'stable'
    const leftAlwaysVisible =
      shot.sidebarScroll <= shot.sidebarClient + 1 &&
      (shot.sidebarOverflow === 'hidden' || shot.sidebarOverflow === 'clip') &&
      shot.bottomBottom <= shot.viewportHeight + 1 &&
      shot.bottomTop >= 0
    const pageStillZero = shot.pageScrollHeight <= shot.pageClientHeight + 1
    record({
      id: 'P8-W1',
      prd: '修改-§8.3',
      name: '学习页未进入主题时：下区提示卡随页面滚（不再困在固定高度的小框里），左栏一直可见、底部「数据与设置」可点',
      passed: hintNotBoxed && contentIsScroller && leftAlwaysVisible && pageStillZero,
      detail: `下区提示卡 高=${shot.hintHeight} 内容/可视=${shot.hintScroll}/${shot.hintClient}；下区主体 高=${shot.mainHeight} 内容/可视=${shot.mainScroll}/${shot.mainClient} overflow=${shot.mainOverflow}（不再是一块固定高度的框=${hintNotBoxed}）；右侧内容区 overflow=${shot.workspaceOverflow} gutter=${shot.workspaceGutter} 内容/可视=${shot.workspaceScrollHeight}/${shot.workspaceClientHeight}（是滚动容器=${contentIsScroller}）；左栏 内容/可视=${shot.sidebarScroll}/${shot.sidebarClient} overflow=${shot.sidebarOverflow}，底部「数据与设置」top=${shot.bottomTop} bottom=${shot.bottomBottom} 视口=${shot.viewportHeight}（一直可见=${leftAlwaysVisible}）；页面级 zero 溢出=${pageStillZero}`
    })
  } catch (error) {
    record({
      id: 'P8-W1',
      prd: '修改-§8.3',
      name: '学习页未进入主题时：下区提示卡随页面滚（不再困在固定高度的小框里），左栏一直可见、底部「数据与设置」可点',
      passed: false,
      detail: `${String(error)}；${diagnostics()}`
    })
  }

  // =========================================================================
  // V. 读书页（第 11 块 · `MASTER.md` §7.7 + 决定 22–24）
  //
  // 编号说明：A–N、R、S、U 都已被前面的块占用，本块从 **V** 开始数。
  //
  // 自带前提（四条硬规矩第 2 条）：现场造三本书（在读 / 想读 / 读完）、一棵三层章节树、
  // 8 条阅读记录（其中一条挂第 1 章）与 2 条摘录，**全部带本趟前缀**，
  // 断言只认这几个 id，不依赖前面任何块留下的状态。
  // =========================================================================
  const readingMarker = `阶段11读书（第${passNumber}趟）`
  /**
   * 本块的样本：
   *   书（在读）：ch1 勾了 / ch2 汇总（2.1 勾了、2.2 没勾）
   *   → 最小单元 = ch1、2.1、2.2 → **2/3 = 67%**（页码 128/320 = 40%，两者不同，才好验"页码不影响进度"）
   */
  interface ReadingSeed {
    bookId: string
    wantId: string
    finishedId: string
    ch1: string
    ch2: string
    sub21: string
    sub22: string
  }
  const EMPTY_READING_SEED: ReadingSeed = {
    bookId: '',
    wantId: '',
    finishedId: '',
    ch1: '',
    ch2: '',
    sub21: '',
    sub22: ''
  }
  let seeded: ReadingSeed | null = null
  try {
    seeded = await evaluate<ReadingSeed>(
      context,
      `(async () => {
         const add = (payload) => window.api.data.add('reading', payload)
         const book = await add({ kind: 'book', title: ${JSON.stringify(
           `${readingMarker} 之书`
         )}, author: 'Randal Bryant', format: 'paper', status: 'reading', totalPages: 320, currentPage: 128, percent: 0, finishedAt: null, rating: 0, review: '' })
         const want = await add({ kind: 'book', title: ${JSON.stringify(
           `${readingMarker} 想读的书`
         )}, author: '', format: 'paper', status: 'want', totalPages: 200, currentPage: 0, percent: 0, finishedAt: null, rating: 0, review: '' })
         const finished = await add({ kind: 'book', title: ${JSON.stringify(
           `${readingMarker} 读完的书`
         )}, author: '', format: 'ebook', status: 'finished', totalPages: 0, currentPage: 0, percent: 100, finishedAt: '2026-10-01', rating: 5, review: '' })
         const ch1 = await add({ kind: 'node', ownerId: book.id, parentId: null, order: 0, title: ${JSON.stringify(
           `${readingMarker} 第1章`
         )}, done: true })
         const ch2 = await add({ kind: 'node', ownerId: book.id, parentId: null, order: 1, title: ${JSON.stringify(
           `${readingMarker} 第2章`
         )}, done: false })
         const sub21 = await add({ kind: 'node', ownerId: book.id, parentId: String(ch2.id), order: 0, title: ${JSON.stringify(
           `${readingMarker} 2.1`
         )}, done: true })
         const sub22 = await add({ kind: 'node', ownerId: book.id, parentId: String(ch2.id), order: 1, title: ${JSON.stringify(
           `${readingMarker} 2.2`
         )}, done: false })
         // 「读完的书」给一章并勾上，免得"读完"却显示 0%（章节进度只数章，不看状态）
         const doneChapter = await add({ kind: 'node', ownerId: finished.id, parentId: null, order: 0, title: ${JSON.stringify(
           `${readingMarker} 读完的章`
         )}, done: true })
         void doneChapter
         // 阅读记录：一条挂第 1 章 + 七条书级（够让中区那块真的滚起来）
         await add({ kind: 'progress', bookId: book.id, nodeId: String(ch1.id), date: '2026-10-09', minutes: 30, fromPage: 90, toPage: 128 })
         await add({ kind: 'progress', bookId: book.id, date: '2026-10-08', minutes: 45, fromPage: 60, toPage: 90 })
         for (let index = 0; index < 6; index += 1) {
           await add({ kind: 'progress', bookId: book.id, date: '2026-09-2' + String(index + 1), minutes: 20, fromPage: index * 10, toPage: (index + 1) * 10 })
         }
         // 摘录与想法：**只进中区列表，不进树**（决定 24）
         await add({ kind: 'excerpt', bookId: book.id, type: 'quote', locator: 'p.11', content: ${JSON.stringify(
           `${readingMarker} 摘录正文`
         )} })
         await add({ kind: 'excerpt', bookId: book.id, type: 'thought', locator: 'p.20', content: ${JSON.stringify(
           `${readingMarker} 想法正文`
         )} })
         await window.api.data.flush()
         return {
           bookId: String(book.id),
           wantId: String(want.id),
           finishedId: String(finished.id),
           ch1: String(ch1.id),
           ch2: String(ch2.id),
           sub21: String(sub21.id),
           sub22: String(sub22.id)
         }
       })()`
    )
    await wait(200)
  } catch (error) {
    console.log(`[phase8] 造读书页样本失败：${String(error)}`)
  }

  /** 切到读书页并选中本块那本书（先离开再回来，强制重读盘） */
  const openReadingBook = async (bookId: string): Promise<boolean> => {
    await evaluate(context, `window.__verify.clickNav('home')`)
    await wait(200)
    await evaluate(context, `window.__verify.clickNav('reading')`)
    await wait(400)
    await evaluate(context, `window.__verify.key('Escape')`)
    await wait(150)
    return untilTrue(
      context,
      `(() => {
         const button = document.querySelector('[data-testid="reading-book"][data-book-id="${bookId}"]')
         if (!button) return false
         button.click()
         return true
       })()`,
      12,
      250
    )
  }

  const readingSeed: ReadingSeed = seeded ?? EMPTY_READING_SEED
  /** 页面准备工作（样本在 + 书架里能点到那本书）；没准备好时下面八项各自记失败 */
  const readingPageReady = seeded === null ? false : await openReadingBook(seeded.bookId)
  const requireReadingReady = (): void => {
    if (seeded === null) throw new Error('本块样本没造出来')
    if (!readingPageReady) throw new Error(`左栏书架里找不到本块那本书 ${readingSeed.bookId.slice(0, 6)}`)
  }

  {
    await wait(300)

    // ---- V8 三步走：选中 → 预览 → 点「进入书」→ 下方展开树（预览与卡片留在上面） ----
    try {
      requireReadingReady()
      interface StepSnapshot {
        entered: string
        tree: boolean
        hint: boolean
        previewTop: number
        previewHeight: number
        cards: number
        previewTexts: string
        mainTop: number
      }
      const before = await until<StepSnapshot>(
        context,
        `(() => {
           const button = document.querySelector('[data-testid="reading-enter-book"]')
           const preview = document.querySelector('[data-testid="bands-preview"]')
           const main = document.querySelector('[data-testid="bands-main"]')
           if (!button || !preview) return null
           const rect = preview.getBoundingClientRect()
           const mainRect = main ? main.getBoundingClientRect() : null
           return {
             entered: button.getAttribute('data-entered') || '',
             tree: !!document.querySelector('[data-testid="reading-tree-root"]'),
             hint: !!document.querySelector('[data-testid="reading-tree-locked"]'),
             previewTop: Math.round(rect.top),
             previewHeight: Math.round(rect.height),
             cards: document.querySelectorAll('.band-card').length,
             previewTexts: ((document.querySelector('[data-testid="reading-detail"]') || {}).textContent || '').trim(),
             mainTop: mainRect ? Math.round(mainRect.top) : -1
           }
         })()`,
        (value) => value !== null && value.entered !== '',
        12,
        250
      )
      if (before === null) throw new Error('没等到预览区渲染出来')
      const clicked = await evaluate<boolean>(
        context,
        `window.__verify.click('[data-testid="reading-enter-book"]')`
      )
      const after = await until<StepSnapshot>(
        context,
        `(() => {
           const button = document.querySelector('[data-testid="reading-enter-book"]')
           const preview = document.querySelector('[data-testid="bands-preview"]')
           const main = document.querySelector('[data-testid="bands-main"]')
           if (!button || !preview) return null
           const rect = preview.getBoundingClientRect()
           const mainRect = main ? main.getBoundingClientRect() : null
           return {
             entered: button.getAttribute('data-entered') || '',
             tree: !!document.querySelector('[data-testid="reading-tree-root"]'),
             hint: !!document.querySelector('[data-testid="reading-tree-locked"]'),
             previewTop: Math.round(rect.top),
             previewHeight: Math.round(rect.height),
             cards: document.querySelectorAll('.band-card').length,
             previewTexts: ((document.querySelector('[data-testid="reading-detail"]') || {}).textContent || '').trim(),
             mainTop: mainRect ? Math.round(mainRect.top) : -1
           }
         })()`,
        (value) => value !== null && value.entered === '1' && value.tree,
        14,
        250
      )
      if (after === null) throw new Error('点了「进入书」，下方树没有展开')
      const previewStable =
        Math.abs(after.previewTop - before.previewTop) <= 1 &&
        Math.abs(after.previewHeight - before.previewHeight) <= 1
      record({
        id: 'P8-V8',
        prd: 'TASKS11-§6.7',
        name: '三步走：选中书 → 看预览（含中区两块）→ 点「进入书」→ 下方展开树；预览与卡片留在上面',
        passed:
          before.entered === '0' &&
          before.tree === false &&
          before.hint === true &&
          before.cards === 2 &&
          before.previewTexts.includes('章节') &&
          clicked &&
          after.entered === '1' &&
          after.tree === true &&
          after.hint === false &&
          after.cards === 2 &&
          previewStable &&
          after.mainTop >= after.previewTop,
        detail: `未进入时 data-entered=${before.entered} 树在=${before.tree} 提示卡在=${before.hint} 中区=${before.cards} 块；点「进入书」=${clicked}；进入后 data-entered=${after.entered} 树在=${after.tree} 提示卡在=${after.hint}；预览 top ${before.previewTop}→${after.previewTop}、高 ${before.previewHeight}→${after.previewHeight}（期望不动）稳定=${previewStable}；中区仍是 ${after.cards} 块；主体 top=${after.mainTop}`
      })
    } catch (error) {
      record({
        id: 'P8-V8',
        prd: 'TASKS11-§6.7',
        name: '三步走：选中书 → 看预览（含中区两块）→ 点「进入书」→ 下方展开树；预览与卡片留在上面',
        passed: false,
        detail: `${String(error)}；${diagnostics()}`
      })
    }

    // ---- V1 左栏书架：封面色块 + 首字、三档状态、**按章节算**的进度细线 ----
    try {
      requireReadingReady()
      interface ShelfRowSnapshot {
        id: string
        status: string
        percent: number
        coverText: string
        coverWidth: number
        coverHeight: number
        coverBg: string
        meta: string
        barWidth: number
      }
      const shelf = await evaluate<{
        total: number
        ours: ShelfRowSnapshot[]
        listOverflow: string
        listGutter: string
        listClient: number
        listScroll: number
      }>(
        context,
        `(() => {
           const ids = [${JSON.stringify(readingSeed.bookId)}, ${JSON.stringify(
             readingSeed.wantId
           )}, ${JSON.stringify(readingSeed.finishedId)}]
           const rows = Array.from(document.querySelectorAll('[data-testid="reading-book"]'))
           const ours = rows
             .filter((row) => ids.indexOf(row.getAttribute('data-book-id') || '') >= 0)
             .map((row) => {
               const cover = row.querySelector('[data-testid="reading-book-cover"]')
               const bar = row.querySelector('[data-testid="reading-book-bar"]')
               const meta = row.querySelector('[data-testid="reading-book-progress"]')
               const rect = cover ? cover.getBoundingClientRect() : null
               const style = cover ? getComputedStyle(cover) : null
               const width = bar ? Number.parseFloat(bar.style.width || '0') : -1
               return {
                 id: row.getAttribute('data-book-id') || '',
                 status: row.getAttribute('data-status') || '',
                 percent: Number(row.getAttribute('data-percent') || '-1'),
                 coverText: cover ? (cover.textContent || '').trim() : '',
                 coverWidth: rect ? Math.round(rect.width) : 0,
                 coverHeight: rect ? Math.round(rect.height) : 0,
                 coverBg: style ? style.backgroundColor : '',
                 meta: meta ? (meta.textContent || '').trim() : '',
                 barWidth: Number.isFinite(width) ? Math.round(width) : -1
               }
             })
           const list = document.querySelector('[data-testid="sidebar-list"]')
           return {
             total: rows.length,
             ours,
             listOverflow: list ? getComputedStyle(list).overflowY : '',
             listGutter: list ? getComputedStyle(list).scrollbarGutter : '',
             listClient: list ? list.clientHeight : 0,
             listScroll: list ? list.scrollHeight : 0
           }
         })()`
      )
      const mine = shelf.ours.find((row) => row.id === readingSeed.bookId)
      const statuses = shelf.ours.map((row) => row.status).sort()
      const metaShaped = shelf.ours.every((row) => /^(想读|在读|读完) · \d+%$/.test(row.meta))
      const coversOk = shelf.ours.every(
        (row) =>
          row.coverText === '阶' &&
          row.coverWidth >= 18 &&
          row.coverHeight >= 28 &&
          row.coverBg !== 'rgba(0, 0, 0, 0)' &&
          row.coverBg !== 'transparent'
      )
      const chapterPercent = 67
      const mineOk =
        mine !== undefined &&
        mine.percent === chapterPercent &&
        mine.meta === `在读 · ${chapterPercent}%` &&
        mine.barWidth === chapterPercent
      record({
        id: 'P8-V1',
        prd: 'TASKS11-§6.1',
        name: '左栏书架：封面色块 + 书名首字、想读/在读/读完三档、进度细线**按章节算**（不是页码）',
        passed:
          shelf.ours.length === 3 &&
          statuses.join(',') === 'finished,reading,want' &&
          metaShaped &&
          coversOk &&
          mineOk &&
          shelf.listOverflow === 'auto' &&
          shelf.listGutter === 'stable',
        detail: `书架共 ${shelf.total} 行，本块 3 书都在=${shelf.ours.length === 3}；三档状态=[${shelf.ours
          .map((row) => `${row.status}→${row.meta}`)
          .join(' / ')}]；封面（首字/宽×高/底色）=${shelf.ours
          .map((row) => `${row.coverText}/ ${row.coverWidth}×${row.coverHeight}/ ${row.coverBg}`)
          .join(' | ')}；在读那本：data-percent=${mine?.percent} 细线宽=${mine?.barWidth}%（期望 67 = 2/3 章，页码 128/320 是 40%）；中段列表 overflow=${shelf.listOverflow} gutter=${shelf.listGutter}（内容高 ${shelf.listScroll} / 可视 ${shelf.listClient}）`
      })
    } catch (error) {
      record({
        id: 'P8-V1',
        prd: 'TASKS11-§6.1',
        name: '左栏书架：封面色块 + 书名首字、想读/在读/读完三档、进度细线**按章节算**（不是页码）',
        passed: false,
        detail: `${String(error)}；${diagnostics()}`
      })
    }

    // ---- V2 预览区：读到 N/M 页 + 章节 n/m 章；进度条 = 章节完成度 ----
    try {
      requireReadingReady()
      interface PreviewSnapshot {
        pages: string
        chapters: string
        percentText: string
        fillPercent: string
        fillWidth: number
        basis: string
        records: string
        notes: string
        coverFacts: string
      }
      const preview = await until<PreviewSnapshot>(
        context,
        `(() => {
           const text = (id) => ((document.querySelector('[data-testid="' + id + '"]') || {}).textContent || '').trim()
           const fill = document.querySelector('[data-testid="reading-progress-fill"]')
           const width = fill ? Number.parseFloat(fill.style.width || '0') : -1
           return {
             pages: text('reading-detail-progress'),
             chapters: text('reading-chapter-progress'),
             percentText: text('reading-progress-percent'),
             fillPercent: fill ? fill.getAttribute('data-percent') || '' : '',
             fillWidth: Number.isFinite(width) ? Math.round(width) : -1,
             basis: text('reading-progress-basis'),
             records: text('reading-fact-records'),
             notes: text('reading-fact-notes'),
             coverFacts: text('reading-info')
           }
         })()`,
        (value) => value !== null && value.chapters !== '',
        12,
        250
      )
      if (preview === null) throw new Error('没等到预览区的六行信息')
      const chapterOk =
        preview.chapters === '2/3 章 · 67%' &&
        preview.percentText === '67%' &&
        preview.fillPercent === '67' &&
        preview.fillWidth === 67
      const pageTextOk = preview.pages === '128/320 页'
      // 页码 128/320 = 40%，章节 2/3 = 67%：两个数不一样，才说明进度条不是按页码画的
      const pageNotUsedAsProgress = !preview.percentText.startsWith('40')
      record({
        id: 'P8-V2',
        prd: 'TASKS11-§6.2',
        name: '预览区显示 `读到 N/M 页` 与 `章节 n/m 章`；**进度条 = 章节完成度**（不是页码百分比）',
        passed:
          pageTextOk &&
          chapterOk &&
          pageNotUsedAsProgress &&
          preview.notes === '1 / 1' &&
          preview.records === '8 次 · 195 分钟' &&
          preview.coverFacts.includes('Randal Bryant') &&
          preview.coverFacts.includes('纸质书'),
        detail: `读到="${preview.pages}"（期望 128/320 页 = 40%）；章节="${preview.chapters}"（期望 2/3 章 · 67%）；进度条文字="${preview.percentText}" 填充 data-percent=${preview.fillPercent} 宽度=${preview.fillWidth}%；依据="${preview.basis}"；阅读记录="${preview.records}"（8 条 195 分钟）；摘录/想法="${preview.notes}"；信息卡含作者/格式=${preview.coverFacts.includes('Randal Bryant')}/${preview.coverFacts.includes('纸质书')}`
      })
    } catch (error) {
      record({
        id: 'P8-V2',
        prd: 'TASKS11-§6.2',
        name: '预览区显示 `读到 N/M 页` 与 `章节 n/m 章`；**进度条 = 章节完成度**（不是页码百分比）',
        passed: false,
        detail: `${String(error)}；${diagnostics()}`
      })
    }

    // ---- V3 把页码改大，进度条不变（页码不影响进度） ----
    try {
      requireReadingReady()
      const opened = await evaluate<boolean>(
        context,
        `window.__verify.click('[data-testid="reading-log-reading"]')`
      )
      const drawer = opened
        ? await untilTrue(context, `window.__verify.exists('reading-log-drawer')`, 10, 200)
        : false
      await evaluate(context, `window.__verify.setText('reading-progress-input', '320')`)
      await evaluate(context, `window.__verify.setText('reading-minutes-input', '15')`)
      await wait(150)
      await evaluate(context, `window.__verify.click('[data-testid="reading-progress-save"]')`)
      const closed = await untilTrue(
        context,
        `!window.__verify.exists('reading-log-drawer')`,
        14,
        250
      )
      const persisted = await until<{ currentPage: number; percent: number }>(
        context,
        `(async () => {
           const records = await window.api.data.listAlive('reading')
           const book = records.find((item) => item['id'] === ${JSON.stringify(readingSeed.bookId)})
           return {
             currentPage: book ? Number(book['currentPage']) : -1,
             percent: book ? Number(book['percent']) : -1
           }
         })()`,
        (value) => value !== null && value.currentPage === 320,
        14,
        250
      )
      const after = await evaluate<{
        pages: string
        chapters: string
        percentText: string
        fillPercent: string
        shelfPercent: string
        shelfBarWidth: number
      }>(
        context,
        `(() => {
           const text = (id) => ((document.querySelector('[data-testid="' + id + '"]') || {}).textContent || '').trim()
           const fill = document.querySelector('[data-testid="reading-progress-fill"]')
           const row = document.querySelector('[data-testid="reading-book"][data-book-id="${readingSeed.bookId}"]')
           const bar = row ? row.querySelector('[data-testid="reading-book-bar"]') : null
           const width = bar ? Number.parseFloat(bar.style.width || '0') : -1
           return {
             pages: text('reading-detail-progress'),
             chapters: text('reading-chapter-progress'),
             percentText: text('reading-progress-percent'),
             fillPercent: fill ? fill.getAttribute('data-percent') || '' : '',
             shelfPercent: row ? row.getAttribute('data-percent') || '' : '',
             shelfBarWidth: Number.isFinite(width) ? Math.round(width) : -1
           }
         })()`
      )
      // 页码已经改到 320/320（= 100%），但"按章节算"的进度仍然是 2/3 = 67%
      const progressUnchanged =
        after.percentText === '67%' &&
        after.fillPercent === '67' &&
        after.chapters === '2/3 章 · 67%' &&
        after.shelfPercent === '67' &&
        after.shelfBarWidth === 67
      record({
        id: 'P8-V3',
        prd: 'TASKS11-§6.6',
        name: '把页码改大（128→320 = 读完），**进度条与左栏细线一个数都不动**（页码不参与进度计算）',
        passed:
          drawer &&
          closed &&
          persisted !== null &&
          persisted.currentPage === 320 &&
          after.pages === '320/320 页' &&
          progressUnchanged,
        detail: `抽屉打开=${drawer} 关闭=${closed}；落库 currentPage=${persisted?.currentPage}（期望 320）；预览"读到"="${after.pages}"；改完后 进度条文字=${after.percentText} 填充=${after.fillPercent}% 章节="${after.chapters}"；左栏 data-percent=${after.shelfPercent} 细线=${after.shelfBarWidth}%（三者期望都还是 67）`
      })
    } catch (error) {
      record({
        id: 'P8-V3',
        prd: 'TASKS11-§6.6',
        name: '把页码改大（128→320 = 读完），**进度条与左栏细线一个数都不动**（页码不参与进度计算）',
        passed: false,
        detail: `${String(error)}；${diagnostics()}`
      })
    }

    // ---- V4 中区两块固定高度、各自内部滚；树吃满剩余高度、内部滚 ----
    try {
      requireReadingReady()
      // 先等上面那条"已记一次阅读"的提示条自己消失：它是内容流里的一行，
      // 占着的时候会把三段骨架整体往下推 56px（量到的是被挤扁的树，不是常态）。
      await untilTrue(context, `!window.__verify.exists('reading-flash')`, 14, 250)
      const layout = await until<{
        cards: number
        cardHeights: number[]
        cardOverflow: string[]
        cardScroll: number[]
        cardClient: number[]
        mainTop: number
        mainBottom: number
        mainHeight: number
        contentBottom: number
        panelTop: number
        panelBottom: number
        panelHeadHeight: number
        treeHeight: number
        treeToolbarHeight: number
        treeList: boolean
        treeListOverflow: string
        treeListClient: number
        treeListScroll: number
        treeListBottom: number
        previewHeight: number
        headerHeight: number
        toolbarHeight: number
      }>(
        context,
        `(() => {
           const cards = Array.from(document.querySelectorAll('.band-card'))
           const bodies = cards.map((card) => card.querySelector('.band-card__body'))
           const main = document.querySelector('[data-testid="bands-main"]')
           const content = document.querySelector('.page__content')
           const mainRect = main ? main.getBoundingClientRect() : null
           const contentRect = content ? content.getBoundingClientRect() : null
           const panel = document.querySelector('[data-testid="reading-chapters"]')
           const panelRect = panel ? panel.getBoundingClientRect() : null
           const panelHead = panel ? panel.querySelector('.panel__head') : null
           const tree = main ? main.querySelector('.tree') : null
           const treeRect = tree ? tree.getBoundingClientRect() : null
           const treeToolbar = tree ? tree.querySelector('.tree__toolbar') : null
           const treeList = document.querySelector('[data-testid="reading-tree-list"]')
           const treeListRect = treeList ? treeList.getBoundingClientRect() : null
           const preview = document.querySelector('[data-testid="bands-preview"]')
           const header = document.querySelector('.page__header')
           const toolbar = document.querySelector('.page__toolbar')
           const round = (value) => (typeof value === 'number' ? Math.round(value) : -1)
           return {
             cards: cards.length,
             cardHeights: cards.map((card) => Math.round(card.getBoundingClientRect().height)),
             cardOverflow: bodies.map((body) => (body ? getComputedStyle(body).overflowY : '')),
             cardScroll: bodies.map((body) => (body ? body.scrollHeight : 0)),
             cardClient: bodies.map((body) => (body ? body.clientHeight : 0)),
             mainTop: round(mainRect ? mainRect.top : NaN),
             mainBottom: round(mainRect ? mainRect.bottom : NaN),
             mainHeight: round(mainRect ? mainRect.height : NaN),
             contentBottom: round(contentRect ? contentRect.bottom : NaN),
             panelTop: round(panelRect ? panelRect.top : NaN),
             panelBottom: round(panelRect ? panelRect.bottom : NaN),
             panelHeadHeight: round(panelHead ? panelHead.getBoundingClientRect().height : NaN),
             treeHeight: round(treeRect ? treeRect.height : NaN),
             treeToolbarHeight: round(treeToolbar ? treeToolbar.getBoundingClientRect().height : NaN),
             treeList: !!treeList,
             treeListOverflow: treeList ? getComputedStyle(treeList).overflowY : '',
             treeListClient: treeList ? treeList.clientHeight : 0,
             treeListScroll: treeList ? treeList.scrollHeight : 0,
             treeListBottom: round(treeListRect ? treeListRect.bottom : NaN),
             previewHeight: round(preview ? preview.getBoundingClientRect().height : NaN),
             headerHeight: round(header ? header.getBoundingClientRect().height : NaN),
             toolbarHeight: round(toolbar ? toolbar.getBoundingClientRect().height : NaN)
           }
         })()`,
        (value) =>
          value !== null &&
          value.cards === 2 &&
          value.treeListClient > 0 &&
          value.cardClient.every((height) => height > 0),
        14,
        250
      )
      if (layout === null) throw new Error('没等到中区两块与树同时渲染出来')
      const heightsFixed = layout.cardHeights.every((height) => height === 132)
      const bodiesScroll = layout.cardOverflow.every((value) => value === 'auto')
      const someBodyOverflows = layout.cardScroll.some(
        (scroll, index) => scroll > layout.cardClient[index] + 2
      )
      /*
       * 2026-10 修订：口径反过来。
       *
       * 旧口径要"章节面板填满主体、树列表贴到面板底边、树列表自己滚"——
       * 那是"下区自己内部滚"那一版模型的产物。现在三模块页改成**下区跟随整页滚**，
       * 所以现在要判的是：面板与树都**按内容高**（面板底边 = 树列表底边 + 面板内边距），
       * 而且树列表**不再内部滚**。不变的是中区那两块 132px。
       */
      const panelGrowsWithTree = layout.panelBottom >= layout.treeListBottom
      const treeListUnderPanel =
        layout.panelBottom - layout.treeListBottom >= 0 &&
        layout.panelBottom - layout.treeListBottom <= 36
      const treeNotInternalScroll =
        (layout.treeListOverflow === 'visible' || layout.treeListOverflow === '') &&
        layout.treeListScroll <= layout.treeListClient + 1
      record({
        id: 'P8-V4',
        prd: 'TASKS11-§6.3',
        name: '中区两块固定 132px、各自**内部滚**；章节面板与树**按内容高**、树不再内部滚（滚轮规矩 2026-10 修订）',
        passed:
          layout.cards === 2 &&
          heightsFixed &&
          bodiesScroll &&
          someBodyOverflows &&
          panelGrowsWithTree &&
          treeListUnderPanel &&
          layout.treeList &&
          treeNotInternalScroll,
        detail: `中区 ${layout.cards} 块，高度=[${layout.cardHeights.join(',')}]（期望 132/132）；卡片体 overflow=[${layout.cardOverflow.join(',')}]；内容高/可视高=[${layout.cardScroll
          .map((scroll, index) => `${scroll}/${layout.cardClient[index]}`)
          .join(' ')}]（有能滚的=${someBodyOverflows}）；主体 ${layout.mainTop}→${layout.mainBottom}（高 ${layout.mainHeight}）内容区底边=${layout.contentBottom}；章节面板 ${layout.panelTop}→${layout.panelBottom}（面板头 ${layout.panelHeadHeight}、树 ${layout.treeHeight}、树工具条 ${layout.treeToolbarHeight}）；树列表 overflow=${layout.treeListOverflow} 可视=${layout.treeListClient} 内容=${layout.treeListScroll} 底边=${layout.treeListBottom} 贴面板底=${treeListUnderPanel} 不再内部滚=${treeNotInternalScroll}（旧口径要的"填满主体 / 树里滚"已作废）；上预览高=${layout.previewHeight} 页头=${layout.headerHeight} 工具条=${layout.toolbarHeight}`
      })
    } catch (error) {
      record({
        id: 'P8-V4',
        prd: 'TASKS11-§6.3',
        name: '中区两块固定 132px、各自**内部滚**；章节面板与树**按内容高**、树不再内部滚（滚轮规矩 2026-10 修订）',
        passed: false,
        detail: `${String(error)}；${diagnostics()}`
      })
    }

    // ---- V5 摘录与想法在列表里、**不在树里**（决定 24） ----
    try {
      requireReadingReady()
      // 先把第 2 章展开，让全部四行章节都渲染出来（树最"满"的时候再查一遍）
      await evaluate(
        context,
        `(() => {
           const row = document.querySelector('[data-testid="reading-tree-row"][data-node-id="${readingSeed.ch2}"]')
           const caret = row && row.querySelector('[data-testid="reading-tree-toggle"]')
           if (caret) caret.click()
           return !!caret
         })()`
      )
      await untilTrue(
        context,
        `!!document.querySelector('[data-testid="reading-tree-row"][data-node-id="${readingSeed.sub21}"]')`,
        10,
        250
      )
      const snapshot = await evaluate<{
        rowCount: number
        texts: string[]
        types: string[]
        treeContainsQuote: boolean
        treeContainsThought: boolean
        treeRowCount: number
        treeRowTitles: string[]
        summaryDisabled: boolean
        leafDisabled: boolean
        summaryTag: string
        leafTag: string
      }>(
        context,
        `(() => {
           const rows = Array.from(document.querySelectorAll('[data-testid="reading-excerpt"]'))
           const texts = rows.map((row) => (row.textContent || '').trim())
           const types = rows.map((row) => ((row.querySelector('[data-testid="reading-excerpt-type"]') || {}).textContent || '').trim())
           const tree = document.querySelector('[data-testid="reading-tree-root"]')
           const html = tree ? tree.innerHTML : ''
           const treeRows = Array.from(document.querySelectorAll('[data-testid="reading-tree-row"]'))
           const checkOf = (id) => {
             const row = document.querySelector('[data-testid="reading-tree-row"][data-node-id="' + id + '"]')
             const check = row ? row.querySelector('[data-testid="reading-tree-check"]') : null
             return { row: row, check: check }
           }
           const summary = checkOf(${JSON.stringify(readingSeed.ch2)})
           const leaf = checkOf(${JSON.stringify(readingSeed.ch1)})
           return {
             rowCount: rows.length,
             texts,
             types,
             treeContainsQuote: html.includes('摘录正文'),
             treeContainsThought: html.includes('想法正文'),
             treeRowCount: treeRows.length,
             treeRowTitles: treeRows.map((row) => ((row.querySelector('[data-testid="reading-tree-title"]') || {}).textContent || '').trim()),
             summaryDisabled: summary.check ? summary.check.disabled === true : false,
             leafDisabled: leaf.check ? leaf.check.disabled === true : true,
             summaryTag: summary.row ? summary.row.getAttribute('data-summary') || '' : '',
             leafTag: leaf.row ? leaf.row.getAttribute('data-summary') || '' : ''
           }
         })()`
      )
      const inList =
        snapshot.rowCount === 2 &&
        snapshot.texts.some((text) => text.includes('摘录正文')) &&
        snapshot.texts.some((text) => text.includes('想法正文')) &&
        snapshot.types.some((text) => text.includes('原文') && text.includes('p.11')) &&
        snapshot.types.some((text) => text.includes('想法') && text.includes('p.20'))
      const onlyChapters =
        snapshot.treeRowCount === 4 &&
        snapshot.treeRowTitles.every(
          (title) =>
            !title.includes('摘录正文') && !title.includes('想法正文') && !title.includes('摘录')
        )
      // 虚线框 = 汇总（勾是只读的）；实心框 = 最小单元（勾可点）——与学习树同一套组件、同一套判据
      const boxesOk =
        snapshot.summaryTag === '1' &&
        snapshot.summaryDisabled &&
        snapshot.leafTag === '0' &&
        snapshot.leafDisabled === false
      record({
        id: 'P8-V5',
        prd: 'TASKS11-§6.5',
        name: '摘录与想法**在列表里、不在树里**（树节点集合只有章节；决定 24）；虚线框=汇总、实心框=最小单元',
        passed: inList && !snapshot.treeContainsQuote && !snapshot.treeContainsThought && onlyChapters && boxesOk,
        detail: `中区列表 ${snapshot.rowCount} 条（原文/想法都在=${inList}），分类标签=[${snapshot.types.join(' | ')}]；树里出现"摘录正文"=${snapshot.treeContainsQuote}、"想法正文"=${snapshot.treeContainsThought}（期望都是 false）；树 ${snapshot.treeRowCount} 行且全是章节=${onlyChapters}（[${snapshot.treeRowTitles.join(' / ')}]）；汇总章 data-summary=${snapshot.summaryTag} 勾只读=${snapshot.summaryDisabled}、最小单元 data-summary=${snapshot.leafTag} 勾可点=${!snapshot.leafDisabled}（框样式=${boxesOk}）`
      })
    } catch (error) {
      record({
        id: 'P8-V5',
        prd: 'TASKS11-§6.5',
        name: '摘录与想法**在列表里、不在树里**（树节点集合只有章节；决定 24）；虚线框=汇总、实心框=最小单元',
        passed: false,
        detail: `${String(error)}；${diagnostics()}`
      })
    }

    // ---- V6 点章节就地展开：该章的阅读记录 + 五个操作 ----
    try {
      requireReadingReady()
      // 第 2 章刚才是展开的，先收起，免得"点一次"变成"收起"
      await evaluate(
        context,
        `(() => {
           const row = document.querySelector('[data-testid="reading-tree-row"][data-node-id="${readingSeed.ch2}"]')
           const caret = row && row.querySelector('[data-testid="reading-tree-toggle"]')
           if (caret && caret.getAttribute('aria-expanded') === 'true') caret.click()
           return true
         })()`
      )
      await wait(250)
      const clicked = await evaluate<boolean>(
        context,
        `(() => {
           const row = document.querySelector('[data-testid="reading-tree-row"][data-node-id="${readingSeed.ch1}"]')
           const line = row && row.querySelector('.tree__line')
           if (line) line.click()
           return !!line
         })()`
      )
      const panel = clicked
        ? await until<{
            records: number
            recordText: string
            log: boolean
            addSub: boolean
            rename: boolean
            markDone: boolean
            remove: boolean
            empty: boolean
          }>(
            context,
            `(() => {
               const detail = document.querySelector('[data-testid="reading-chapter-detail"]')
               if (!detail) return null
               const records = Array.from(detail.querySelectorAll('[data-testid="reading-chapter-record"]'))
               return {
                 records: records.length,
                 recordText: records.map((item) => (item.textContent || '').trim()).join(' | '),
                 log: !!detail.querySelector('[data-testid="reading-chapter-log"]'),
                 addSub: !!detail.querySelector('[data-testid="reading-chapter-add-sub"]'),
                 rename: !!detail.querySelector('[data-testid="reading-chapter-rename"]'),
                 markDone: !!detail.querySelector('[data-testid="reading-chapter-mark-done"]'),
                 remove: !!detail.querySelector('[data-testid="reading-chapter-delete"]'),
                 empty: !!detail.querySelector('[data-testid="reading-chapter-record-empty"]')
               }
             })()`,
            (value) => value !== null,
            12,
            250
          )
        : null
      if (panel === null) throw new Error('点了章节行，就地面板没有出现')
      const fiveOps =
        panel.log && panel.addSub && panel.rename && panel.markDone && panel.remove
      record({
        id: 'P8-V6',
        prd: 'TASKS11-§6.4',
        name: '点章节就地展开：**该章的阅读记录** + 记一次阅读 / 加子章 / 重命名 / 标记读完 / 删除',
        passed: panel.records === 1 && panel.recordText.includes('30 分钟') && fiveOps && panel.empty === false,
        detail: `点第 1 章=${clicked}；面板里的"这一章的阅读记录" ${panel.records} 条（期望 1 条、含 30 分钟）：「${panel.recordText}」；五个操作齐=${fiveOps}（记一次阅读=${panel.log} 加子章=${panel.addSub} 重命名=${panel.rename} 标记读完=${panel.markDone} 删除=${panel.remove}）；空提示在=${panel.empty}（期望 false）`
      })
    } catch (error) {
      record({
        id: 'P8-V6',
        prd: 'TASKS11-§6.4',
        name: '点章节就地展开：**该章的阅读记录** + 记一次阅读 / 加子章 / 重命名 / 标记读完 / 删除',
        passed: false,
        detail: `${String(error)}；${diagnostics()}`
      })
    }

    // ---- V7 读书页的滚轮规矩（2026-10 修订：用户点名要复查的那一条） ----
    try {
      requireReadingReady()
      const view = await readModuleScroll(context)
      if (view === null) throw new Error('没等到读书页的三段骨架渲染出来')
      const verdict = judgeModuleScroll(view)
      record({
        id: 'P8-V7',
        prd: 'TASKS11-§7.3',
        name: '读书页滚轮规矩（2026-10 修订）：页面级零滚动条、滚动发生在右侧内容区，左栏不跟着滚、底部「数据与设置」始终可点、中区两块仍 132px 内部滚',
        passed: verdict.passed,
        detail: verdict.detail
      })
    } catch (error) {
      record({
        id: 'P8-V7',
        prd: 'TASKS11-§7.3',
        name: '读书页滚轮规矩（2026-10 修订）：页面级零滚动条、滚动发生在右侧内容区，左栏不跟着滚、底部「数据与设置」始终可点、中区两块仍 132px 内部滚',
        passed: false,
        detail: `${String(error)}；${diagnostics()}`
      })
    }

    // ---- W10 读书页就地面板可收起（「收起」/ 再点这一行 / Esc；与子节点展开解耦） ----
    try {
      requireReadingReady()
      const ch1 = readingSeed.ch1
      const ch2 = readingSeed.ch2
      const panelOpenOf = (nodeId: string): string => `(() => {
        const row = document.querySelector('[data-testid="reading-tree-row"][data-node-id="${nodeId}"]')
        if (!row) return false
        const detail = row.querySelector('[data-testid="reading-tree-detail"]')
        return !!detail && !!detail.querySelector('[data-testid="reading-chapter-panel-collapse"]')
      })()`
      const caretExpandedOf = (nodeId: string): string => `(() => {
        const row = document.querySelector('[data-testid="reading-tree-row"][data-node-id="${nodeId}"]')
        const caret = row && row.querySelector('.tree__caret')
        return !!caret && caret.getAttribute('aria-expanded') === 'true'
      })()`
      const clickLineOf = (nodeId: string): string => `(() => {
        const row = document.querySelector('[data-testid="reading-tree-row"][data-node-id="${nodeId}"]')
        const line = row && row.querySelector('.tree__line')
        if (line) line.click()
        return !!line
      })()`
      const clickCollapseOf = (nodeId: string): string => `(() => {
        const row = document.querySelector('[data-testid="reading-tree-row"][data-node-id="${nodeId}"]')
        const detail = row && row.querySelector('[data-testid="reading-tree-detail"]')
        const button = detail && detail.querySelector('[data-testid="reading-chapter-panel-collapse"]')
        if (button) button.click()
        return !!button
      })()`

      // 复位：上一条检查（V6）留下的是"第 1 章面板开着"，先关掉（先复位再操作）
      for (const id of [ch1, ch2]) {
        if (await evaluate<boolean>(context, panelOpenOf(id))) {
          await evaluate(context, clickCollapseOf(id))
          await wait(200)
        }
      }

      // ① 点章节行 → 面板开，面板里有「收起」
      const clickedOnce = await evaluate<boolean>(context, clickLineOf(ch1))
      const openedOnce = await untilTrue(context, panelOpenOf(ch1), 10, 200)
      // ② 点「收起」→ 面板消失
      const collapsed = await evaluate<boolean>(context, clickCollapseOf(ch1))
      const closedByButton = await untilTrue(context, `!${panelOpenOf(ch1)}`, 10, 200)
      // ③ 再点这一行 → 又开；再点一次 → 又收
      await evaluate(context, clickLineOf(ch1))
      const reopened = await untilTrue(context, panelOpenOf(ch1), 10, 200)
      await evaluate(context, clickLineOf(ch1))
      const closedByClick = await untilTrue(context, `!${panelOpenOf(ch1)}`, 10, 200)
      // ④ Esc 也能收
      await evaluate(context, clickLineOf(ch1))
      const beforeEsc = await untilTrue(context, panelOpenOf(ch1), 10, 200)
      await evaluate(context, `window.__verify.key('Escape')`)
      const closedByEsc = await untilTrue(context, `!${panelOpenOf(ch1)}`, 10, 200)

      // ⑤ 拆开后互不影响：汇总章（第 2 章，有子节点）面板开着时展开子章，面板仍在；
      //    收面板以后子章仍然展开着
      if (!(await evaluate<boolean>(context, caretExpandedOf(ch2)))) {
        await evaluate(
          context,
          `(() => {
             const row = document.querySelector('[data-testid="reading-tree-row"][data-node-id="${ch2}"]')
             const caret = row && row.querySelector('[data-testid="reading-tree-toggle"]')
             if (caret) caret.click()
             return true
           })()`
        )
        await wait(250)
      }
      await evaluate(context, clickLineOf(ch2))
      const summaryPanelOpen = await untilTrue(context, panelOpenOf(ch2), 10, 200)
      if (!(await evaluate<boolean>(context, caretExpandedOf(ch2)))) {
        await evaluate(
          context,
          `(() => {
             const row = document.querySelector('[data-testid="reading-tree-row"][data-node-id="${ch2}"]')
             const caret = row && row.querySelector('[data-testid="reading-tree-toggle"]')
             if (caret) caret.click()
             return true
           })()`
        )
        await wait(250)
      }
      const childExpanded = await evaluate<boolean>(context, caretExpandedOf(ch2))
      const childRowShown = await evaluate<boolean>(
        context,
        `!!document.querySelector('[data-testid="reading-tree-row"][data-node-id="${readingSeed.sub21}"]')`
      )
      const panelSurvivedExpand = await evaluate<boolean>(context, panelOpenOf(ch2))
      await evaluate(context, clickCollapseOf(ch2))
      const summaryClosed = await untilTrue(context, `!${panelOpenOf(ch2)}`, 10, 200)
      const childStillExpanded = await evaluate<boolean>(context, caretExpandedOf(ch2))
      const childRowStillShown = await evaluate<boolean>(
        context,
        `!!document.querySelector('[data-testid="reading-tree-row"][data-node-id="${readingSeed.sub21}"]')`
      )

      record({
        id: 'P8-W10',
        prd: '修改-§8.3',
        name: '读书页就地面板可收起（与学习页同一套）：点章节开面板 → 「收起」→ 面板消失、子节点仍展开；再点这一行也能收；Esc 也能收',
        passed:
          clickedOnce &&
          openedOnce &&
          collapsed &&
          closedByButton &&
          reopened &&
          closedByClick &&
          beforeEsc &&
          closedByEsc &&
          summaryPanelOpen &&
          childExpanded &&
          childRowShown &&
          panelSurvivedExpand &&
          summaryClosed &&
          childStillExpanded &&
          childRowStillShown,
        detail: `点章节行=${clickedOnce} 面板开出=${openedOnce}（面板里有「收起」）；点「收起」=${collapsed} 面板消失=${closedByButton}；再点这一行又开=${reopened} 再点一次又收（${closedByClick}）；点行开后按 Esc=${closedByEsc}；汇总章面板开出=${summaryPanelOpen}，展开子章后 子章展开=${childExpanded} 子行渲染=${childRowShown} 面板仍在=${panelSurvivedExpand}；点「收起」收面板=${summaryClosed} 之后 子章仍展开=${childStillExpanded} 子行仍渲染=${childRowStillShown}`
      })
    } catch (error) {
      record({
        id: 'P8-W10',
        prd: '修改-§8.3',
        name: '读书页就地面板可收起（与学习页同一套）：点章节开面板 → 「收起」→ 面板消失、子节点仍展开；再点这一行也能收；Esc 也能收',
        passed: false,
        detail: `${String(error)}；${diagnostics()}`
      })
    }
  } // 读书页那一组检查结束

  // =========================================================================
  // W（续）：复习页中区删除入口 + 防扩散
  //
  // 放在最后跑：W6/W7 会现场造一张复习卡并删掉它，
  // 排在后面就不会影响任何一条既有的"今天到期 N 张"读数。
  // =========================================================================

  // ---- W6 复习页「今天到期的卡片」行有 ⋯，且与树里卡片行取到**同一批菜单项 id** ----
  try {
    const marker = `阶段W（第${passNumber}趟）`
    const frontText = `${marker} 中区菜单要有删除`
    await closeFloaters(context)
    /*
     * 自带前提：现场造一个学习主题 + 一张今天到期的卡挂在它下面。
     * 这样"树里那张卡"与"中区那一行"指的是同一张卡，菜单项才可比。
     */
    const fixture = await evaluate<{ cardId: string; topicId: string }>(
      context,
      `(async () => {
         const topic = await window.api.data.add('learning', {
           kind: 'topic',
           title: ${JSON.stringify(`${marker} 菜单主题`)},
           status: 'active',
           progress: 0
         })
         const card = await window.api.data.add('review', {
           front: ${JSON.stringify(frontText)},
           back: '背面',
           source: String(topic.title),
           stage: 0,
           dueDate: ${JSON.stringify(todayKey)},
           reviewCount: 0,
           lastReviewedAt: null
         })
         await window.api.data.flush()
         return { cardId: String(card.id), topicId: String(topic.id) }
       })()`
    )
    await evaluate(
      context,
      `(window.dispatchEvent(new CustomEvent('worklife:data-changed', { detail: { module: 'review' } })),
        window.dispatchEvent(new CustomEvent('worklife:data-changed', { detail: { module: 'learning' } })),
        true)`
    )
    await evaluate(context, `window.__verify.clickNav('home')`)
    await wait(250)
    await evaluate(context, `window.__verify.clickNav('review')`)
    const listReady = await untilTrue(
      context,
      `window.__verify.exists('review-due-card')`,
      16,
      250
    )
    if (!listReady) throw new Error('复习页没有渲染出来')

    // ① 中区「今天到期的卡片」这一行的 ⋯（不选主题 = 显示全部到期卡）
    await closeMenu(context)
    const rowSelector = `[data-testid="review-due-row"][data-card-id="${fixture.cardId}"]`
    const bandRowExists = await untilTrue(
      context,
      `!!document.querySelector('${rowSelector}')`,
      14,
      250
    )
    if (!bandRowExists) throw new Error('中区「今天到期的卡片」里没有刚造的那张卡')
    const bandOpened = await clickMenuButton(context, 'review-due-row-menu', rowSelector)
    const bandMenu = bandOpened ? await waitForMenu(context) : null
    if (bandMenu === null) throw new Error('点卡片行的 ⋯ 没有出菜单')
    const bandIds = bandMenu.ids
    await evaluate(context, `window.__verify.key('Escape')`)
    await wait(150)

    // ② 树里同一张卡（选中它的主题 → 开始复习 → 展开到卡片行 → 右键）
    await closeFloaters(context)
    const topicClicked = await evaluate<boolean>(
      context,
      `(() => {
         const rows = Array.from(document.querySelectorAll('[data-testid="review-topic"]'))
         const row = rows.find((item) => item.getAttribute('data-topic-key') === ${JSON.stringify(`topic:${fixture.topicId}`)})
         if (!row) return false
         row.click()
         return true
       })()`
    )
    if (!topicClicked) throw new Error('左栏里找不到刚造的那个主题')
    await wait(250)
    await evaluate(context, `window.__verify.click('[data-testid="review-enter-topic"]')`)
    const treeReady = await untilTrue(
      context,
      `!!document.querySelector('[data-testid="review-card-tree"]')`,
      14,
      250
    )
    if (!treeReady) throw new Error('点「开始复习这个主题」后树没有展开')
    // 卡片行的右键挂点（ReviewTree 的行）
    const cardRowSelector = `[data-testid="review-card-row"][data-card-id="${fixture.cardId}"]`
    const cardRowShown = await untilTrue(context, `!!document.querySelector('${cardRowSelector}')`, 12, 250)
    if (!cardRowShown) throw new Error('树里找不到这张卡（到期卡应该在树里可见）')
    const rightClicked = await rightClickSelector(context, cardRowSelector)
    const treeMenu = rightClicked ? await waitForMenu(context) : null
    if (treeMenu === null) throw new Error('树里那张卡右键没有出菜单')
    const treeIds = treeMenu.ids
    await evaluate(context, `window.__verify.key('Escape')`)
    await wait(150)

    const same = bandIds.join('|') === treeIds.join('|')
    record({
      id: 'P8-W6',
      prd: '修改-§8.3',
      name: '复习页「今天到期的卡片」行有 ⋯；与树里同一张卡取到**同一批菜单项 id**（菜单项只定义一份）',
      passed: bandIds.length > 0 && bandIds.includes('card-delete') && same,
      detail: `中区卡片行 ⋯ 打开=${bandOpened} 菜单来源=${bandMenu.source} 项=[${bandIds.join(',')}]；树里同一张卡右键=${rightClicked} 菜单来源=${treeMenu.source} 项=[${treeIds.join(',')}]；两处完全相同=${same}；两处都有「删除」=${bandIds.includes('card-delete') && treeIds.includes('card-delete')}`
    })
  } catch (error) {
    record({
      id: 'P8-W6',
      prd: '修改-§8.3',
      name: '复习页「今天到期的卡片」行有 ⋯；与树里同一张卡取到**同一批菜单项 id**（菜单项只定义一份）',
      passed: false,
      detail: `${String(error)}；${diagnostics()}`
    })
  }

  // ---- W7 从卡片行菜单删除 → 进回收站 → 可恢复 ----
  try {
    const frontText = `阶段W（第${passNumber}趟） 中区菜单要有删除`
    // 自带前提：重新回到"没选主题"的中区列表（全部到期卡都在里面）
    await closeFloaters(context)
    await evaluate(context, `window.__verify.clickNav('home')`)
    await wait(250)
    await evaluate(context, `window.__verify.clickNav('review')`)
    const ready = await untilTrue(context, `window.__verify.exists('review-due-card')`, 16, 250)
    if (!ready) throw new Error('复习页没有渲染出来')

    const cardId = await evaluate<string>(
      context,
      `(async () => {
         const alive = await window.api.data.listAlive('review')
         const hit = alive.find(
           (item) => item['kind'] === undefined && String(item['front'] || '') === ${JSON.stringify(frontText)}
         )
         return hit ? String(hit['id']) : ''
       })()`
    )
    if (cardId === '') throw new Error('W6 造的那张卡不在存活列表里')
    const rowSelector = `[data-testid="review-due-row"][data-card-id="${cardId}"]`
    const rowShown = await untilTrue(context, `!!document.querySelector('${rowSelector}')`, 14, 250)
    if (!rowShown) throw new Error('中区列表里找不到那张卡')

    // ① 从这一行的 ⋯ 选「删除」（复习卡的删除**没有**二次确认，直接进回收站）
    await closeMenu(context)
    const opened = await clickMenuButton(context, 'review-due-row-menu', rowSelector)
    const menu = opened ? await waitForMenu(context) : null
    if (menu === null) throw new Error('点卡片行的 ⋯ 没有出菜单')
    const clickedDelete = await clickMenuItem(context, 'card-delete')

    // ② 进回收站，存活列表里消失，中区那一行也消失
    let inTrash = false
    let aliveAfterDelete = true
    let rowGone = false
    for (let attempt = 0; attempt < 14; attempt += 1) {
      const trash = await evaluate<Array<Record<string, unknown>>>(context, `window.api.trash.list()`)
      inTrash = trash.some((item) => String(item['id'] ?? '') === cardId)
      const alive = await evaluate<Array<Record<string, unknown>>>(
        context,
        `window.api.data.listAlive('review')`
      )
      aliveAfterDelete = alive.some((item) => String(item['id'] ?? '') === cardId)
      rowGone = await evaluate<boolean>(context, `!document.querySelector('${rowSelector}')`)
      if (inTrash && !aliveAfterDelete) break
      await wait(200)
    }

    // ③ 从回收站恢复（软删除必须可逆）
    const restored = await evaluate<boolean>(
      context,
      `window.api.trash.restore('review', ${JSON.stringify(cardId)})`
    )
    const backAlive = await untilTrue(
      context,
      `(async () => {
         const alive = await window.api.data.listAlive('review')
         return alive.some((item) => String(item['id'] || '') === ${JSON.stringify(cardId)})
       })()`,
      12,
      200
    )
    record({
      id: 'P8-W7',
      prd: '修改-§8.3',
      name: '从「今天到期的卡片」行菜单点删除 → 进回收站（软删，界面里那一行也消失）→ 可从回收站恢复',
      passed:
        opened &&
        menu.ids.includes('card-delete') &&
        clickedDelete &&
        inTrash &&
        !aliveAfterDelete &&
        rowGone &&
        restored &&
        backAlive,
      detail: `⋯ 打开=${opened}（项=[${menu.ids.join(',')}]）点「删除」=${clickedDelete}；进回收站=${inTrash} 存活列表里已消失=${!aliveAfterDelete} 中区那一行也消失=${rowGone}；恢复=${restored} 回到存活列表=${backAlive}`
    })
  } catch (error) {
    record({
      id: 'P8-W7',
      prd: '修改-§8.3',
      name: '从「今天到期的卡片」行菜单点删除 → 进回收站（软删，界面里那一行也消失）→ 可从回收站恢复',
      passed: false,
      detail: `${String(error)}；${diagnostics()}`
    })
  }

  // ---- W8 计划页 / 设置页**仍然**零页面级滚动条（防扩散） ----
  try {
    await closeFloaters(context)
    /** 读页面级溢出（这几页**不**使用 page--scroll，一条都不许变） */
    const readPageFixed = async (label: string): Promise<{
      label: string
      pageOverflow: boolean
      pageMaxScroll: number
      workspaceOverflow: string
      workspaceScrolls: boolean
      view: string
    }> => {
      const shot = await until<{
        view: string
        pageScrollHeight: number
        pageClientHeight: number
        pageMaxScrollTop: number
        workspaceOverflow: string
        workspaceScrollHeight: number
        workspaceClientHeight: number
      } | null>(
        context,
        `(() => {
           const doc = document.scrollingElement
           const workspace = document.querySelector('[data-testid="workspace"]')
           if (!doc || !workspace) return null
           return {
             view: workspace.getAttribute('data-view') || '',
             pageScrollHeight: doc.scrollHeight,
             pageClientHeight: doc.clientHeight,
             pageMaxScrollTop: Math.max(0, doc.scrollHeight - doc.clientHeight),
             workspaceOverflow: getComputedStyle(workspace).overflowY,
             workspaceScrollHeight: workspace.scrollHeight,
             workspaceClientHeight: workspace.clientHeight
           }
         })()`,
        (value) => value !== null && value.pageClientHeight > 0,
        14,
        250
      )
      if (shot === null) throw new Error(`${label}：没读到页面`)
      return {
        label,
        pageOverflow: shot.pageScrollHeight <= shot.pageClientHeight + 1,
        pageMaxScroll: shot.pageMaxScrollTop,
        workspaceOverflow: shot.workspaceOverflow,
        workspaceScrolls: shot.workspaceScrollHeight > shot.workspaceClientHeight,
        view: shot.view
      }
    }

    // 计划页（含日历那一档：日历主体自己内部滚，页面级零滚动条）
    await evaluate(context, `window.__verify.clickNav('plan')`)
    await untilTrue(
      context,
      `window.__verify.activeView() === 'plan' && (window.__verify.exists('plan-state') || window.__verify.exists('calendar'))`,
      16,
      250
    )
    const planFixed = await readPageFixed('计划页')
    const planCalendar = await openPlanCalendar(context, 'week')
    const planWeek = planCalendar ? await readPageFixed('计划页·周视图') : null

    // 设置页
    await evaluate(context, `window.__verify.clickNav('settings')`)
    await untilTrue(context, `window.__verify.exists('settings-guide')`, 16, 250)
    const settingsFixed = await readPageFixed('设置页')

    const all = [planFixed, settingsFixed, ...(planWeek === null ? [] : [planWeek])]
    const zeroPageOverflow = all.every((item) => item.pageOverflow)
    /*
     * 计划页只有**日历那一档**是 `page--fill`（靠"工作区 overflow:hidden + 主体内部滚"
     * 那一条），列表档本来就不是 fill 页（工作区按内容滚）。所以：
     *   - 列表档要求：页面级零溢出（工作区 overflow 是 auto 属正常）
     *   - 日历档要求：页面级零溢出 **且** 工作区仍是 hidden ——
     *     一旦被这次改动顺手改成 auto，就说明 `:has(> .page--fill:not(.page--scroll))`
     *     那个选择器写漏了（日历会立刻长出页面级滚动条）
     */
    const planCalendarStillHidden = planWeek !== null && planWeek.workspaceOverflow === 'hidden'
    const planListNotForcedTrimmed = planFixed.workspaceOverflow === 'auto' || planFixed.workspaceOverflow === 'hidden'
    record({
      id: 'P8-W8',
      prd: '修改-§8.3',
      name: '计划页（含日历周视图）/ 设置页**仍然**零页面级滚动条（这次改动没有扩散到别的页）',
      passed: zeroPageOverflow && planCalendarStillHidden && planListNotForcedTrimmed,
      detail: `${all
        .map(
          (item) =>
            `${item.label}（view=${item.view}）页面级可滚=${item.pageMaxScroll}px（0 才好）、工作区 overflow=${item.workspaceOverflow}`
        )
        .join('；')}；全部零页面级溢出=${zeroPageOverflow}；日历周视图工作区仍 overflow:hidden=${planCalendarStillHidden}；列表档没被强行改成 hidden=${planListNotForcedTrimmed}`
    })
  } catch (error) {
    record({
      id: 'P8-W8',
      prd: '修改-§8.3',
      name: '计划页（含日历周视图）/ 设置页**仍然**零页面级滚动条（这次改动没有扩散到别的页）',
      passed: false,
      detail: `${String(error)}；${diagnostics()}`
    })
  }

  // =========================================================================
  // 修改 2 轮（对应 `修改-2.md`）：树的四个移动动作 + 复习页主题可隐藏
  //
  // 用户原话两句：
  //   ① 「树里面的建立的分支**无法移动**，只能删除重写，能不能主动使分支往上移动或
  //      往下移动，**从 1.1 变成 1**。」
  //   ② 「复习无法删除主题。」
  //
  // 硬规矩照旧：轮询等待、自带前提（每个检查先把样本复位成同一棵树）、
  // 先复位再操作（右键 / `⋯` 前先关掉别的浮层）、受控组件用原生 setter。
  //
  // ⚠️ 两条顺序上的讲究，改顺序前先看清：
  //   1. **X10（隐藏状态持久化）必须排在 X9 之前** —— X9 最后会把隐藏取消掉，
  //      之后再查"磁盘上还藏着吗"就没有意义了
  //   2. **本块结束时必须把 `reviewHiddenTopicIds` 清回空** —— 上一趟的
  //      `P8-U1` 要求"左栏各主题到期数之和 = 汇总总数"，留着隐藏项会让它变红
  // =========================================================================
  const move2Marker = `${marker} 修改2`
  const moveFixture = {
    topicId: '',
    resA: '',
    resB: '',
    ch1: '',
    ch2: '',
    sec: '',
    reviewA: '',
    reviewB: '',
    cardA: '',
    cardB: ''
  }
  let moveFixtureError = ''
  try {
    // 自带前提：一棵"资料甲 →（第一章 → 1.1）/ 第二章 + 资料乙"的三层树，
    // 外加两个各带一张到期卡的复习主题（用来验"隐藏不漏复习"）
    const built = await evaluate<typeof moveFixture>(
      context,
      `(async () => {
         const topic = await window.api.data.add('learning', {
           kind: 'topic', title: ${JSON.stringify(`${move2Marker} 移动主题`)}, status: 'active', progress: 0
         })
         const resA = await window.api.data.add('learning', {
           kind: 'node', ownerId: topic.id, topicId: topic.id, parentId: null, order: 0,
           title: ${JSON.stringify(`${move2Marker} 资料甲`)}, resourceType: '书', group: '教材', done: false
         })
         const resB = await window.api.data.add('learning', {
           kind: 'node', ownerId: topic.id, topicId: topic.id, parentId: null, order: 1,
           title: ${JSON.stringify(`${move2Marker} 资料乙`)}, resourceType: '书', group: '教材', done: false
         })
         const ch1 = await window.api.data.add('learning', {
           kind: 'node', ownerId: topic.id, topicId: topic.id, parentId: resA.id, order: 0,
           title: ${JSON.stringify(`${move2Marker} 第一章`)}, done: false
         })
         const ch2 = await window.api.data.add('learning', {
           kind: 'node', ownerId: topic.id, topicId: topic.id, parentId: resA.id, order: 1,
           title: ${JSON.stringify(`${move2Marker} 第二章`)}, done: false
         })
         const sec = await window.api.data.add('learning', {
           kind: 'node', ownerId: topic.id, topicId: topic.id, parentId: ch1.id, order: 0,
           title: ${JSON.stringify(`${move2Marker} 1.1`)}, done: false
         })
         const reviewA = await window.api.data.add('learning', {
           kind: 'topic', title: ${JSON.stringify(`${move2Marker} 复习主题甲`)}, status: 'active', progress: 0
         })
         const reviewB = await window.api.data.add('learning', {
           kind: 'topic', title: ${JSON.stringify(`${move2Marker} 复习主题乙`)}, status: 'active', progress: 0
         })
         const base = { stage: 0, reviewCount: 0, lastReviewedAt: null }
         const cardA = await window.api.data.add('review', {
           ...base,
           front: ${JSON.stringify(`${move2Marker} 被隐藏主题的卡`)},
           back: ${JSON.stringify(`${move2Marker} 被隐藏主题的答案`)},
           source: ${JSON.stringify(`${move2Marker} 复习主题甲`)},
           topicId: reviewA.id,
           // 逾期十年 → 到期队列里**永远排第一**：这样"隐藏之后汇总复习还能复习到
           // 被隐藏主题的卡"一次点击就能断言，不必把整条队列遍历一遍
           dueDate: ${JSON.stringify(addDaysToKey(todayKey, -3650))}
         })
         const cardB = await window.api.data.add('review', {
           ...base,
           front: ${JSON.stringify(`${move2Marker} 一般主题的卡`)},
           back: ${JSON.stringify(`${move2Marker} 一般主题的答案`)},
           source: ${JSON.stringify(`${move2Marker} 复习主题乙`)},
           topicId: reviewB.id,
           dueDate: ${JSON.stringify(todayKey)}
         })
         await window.api.data.flush()
         return {
           topicId: topic.id, resA: resA.id, resB: resB.id,
           ch1: ch1.id, ch2: ch2.id, sec: sec.id,
           reviewA: reviewA.id, reviewB: reviewB.id, cardA: cardA.id, cardB: cardB.id
         }
       })()`
    )
    Object.assign(moveFixture, built)
    await evaluate(
      context,
      `window.dispatchEvent(new CustomEvent('worklife:data-changed', { detail: { module: 'review' } })), true`
    )
    await evaluate(
      context,
      `window.dispatchEvent(new CustomEvent('worklife:data-changed', { detail: { module: 'learning' } })), true`
    )
    await wait(400)
  } catch (error) {
    moveFixtureError = String(error)
  }

  /** 把这棵树复位成"标准形状"：每个检查自己把前提摆好，不依赖上一个检查留下的位置 */
  const resetMoveTree = async (): Promise<void> => {
    await evaluate(
      context,
      `(async () => {
         const set = async (id, patch) => { await window.api.data.update('learning', id, patch) }
         await set(${JSON.stringify(moveFixture.resA)}, { parentId: null, order: 0 })
         await set(${JSON.stringify(moveFixture.resB)}, { parentId: null, order: 1 })
         await set(${JSON.stringify(moveFixture.ch1)}, { parentId: ${JSON.stringify(moveFixture.resA)}, order: 0 })
         await set(${JSON.stringify(moveFixture.ch2)}, { parentId: ${JSON.stringify(moveFixture.resA)}, order: 1 })
         await set(${JSON.stringify(moveFixture.sec)}, { parentId: ${JSON.stringify(moveFixture.ch1)}, order: 0 })
         await window.api.data.flush()
         return true
       })()`
    )
    await wait(250)
  }

  /** 读这棵树的落库状态（只取 id / parentId / order，够断言就行） */
  const readMoveNodes = async (): Promise<
    Array<{ id: string; parentId: string | null; order: number }>
  > =>
    evaluate<Array<{ id: string; parentId: string | null; order: number }>>(
      context,
      `(async () => {
         const alive = await window.api.data.listAlive('learning')
         return alive
           .filter((item) => item['kind'] === 'node' && item['ownerId'] === ${JSON.stringify(moveFixture.topicId)})
           .map((item) => ({
             id: String(item['id']),
             parentId: item['parentId'] === undefined ? null : item['parentId'],
             order: Number(item['order'] || 0)
           }))
       })()`
    )

  /** 打开某个树行的菜单（先复位浮层、沿祖先链展开、再点 `⋯`） */
  const openMoveRowMenu = async (nodeId: string): Promise<MenuSnapshot | null> => {
    await closeFloaters(context)
    const shown = await expandAncestorsOf(context, 'learning-tree', nodeId)
    if (!shown) return null
    const selector = `[data-testid="learning-tree-row"][data-node-id="${nodeId}"]`
    const clicked = await clickMenuButton(context, 'learning-tree-menu', selector)
    if (!clicked) return null
    return await waitForMenu(context)
  }

  /** 树行在界面上从上到下的顺序（用来验"重挂后顺序仍然对"） */
  const readLearningRowOrder = async (): Promise<string[]> =>
    evaluate<string[]>(
      context,
      `Array.from(document.querySelectorAll('[data-testid="learning-tree-row"]')).map((row) => row.getAttribute('data-node-id') || '')`
    )

  // ---- X1 章节的 `⋯` 里有四项移动动作；第一个的上移"禁用 + 带原因" ----
  try {
    if (moveFixtureError !== '') throw new Error(`样本没造出来：${moveFixtureError}`)
    await resetMoveTree()
    await openLearningTopic(context, moveFixture.topicId)
    const menu = await openMoveRowMenu(moveFixture.ch1)
    if (menu === null) throw new Error('章节行的 ⋯ 没有出菜单')
    const ids = menu.ids
    const hasFour = MOVE2_IDS.every((id) => ids.includes(id))
    const hasLabels = ['上移', '下移', '升一级', '降一级'].every((label) => menu.labels.includes(label))
    // 第一章是资料甲的第一个孩子 → 上移用不了，且必须**说明原因**（不是消失）
    const upIndex = ids.indexOf('node-move-up')
    const upDisabled = upIndex >= 0 && menu.disabledIds.includes('node-move-up')
    const upHint = upIndex >= 0 ? menu.hints[upIndex] ?? '' : ''
    // 同一行里"下移"此刻是可用的（后面还有第二章）→ 不灰、也没有原因
    const downIndex = ids.indexOf('node-move-down')
    const downEnabled = downIndex >= 0 && !menu.disabledIds.includes('node-move-down')
    await closeFloaters(context)
    record({
      id: 'P8-X1',
      prd: '修改-2 §8.3',
      name: '树里章节行的 ⋯ / 右键里有「上移 / 下移 / 升一级 / 降一级」四项；用不了的项是**禁用 + 说明原因**（不是消失）',
      passed: hasFour && hasLabels && upDisabled && upHint.includes('最上面') && downEnabled,
      detail: `菜单项=[${ids.join(',')}]；四项齐全=${hasFour}；文案齐全=${hasLabels}；上移禁用=${upDisabled} 原因="${upHint}"（要含"最上面"）；下移可用=${downEnabled}；分组=[${menu.groups.join(',')}]`
    })
  } catch (error) {
    record({
      id: 'P8-X1',
      prd: '修改-2 §8.3',
      name: '树里章节行的 ⋯ / 右键里有「上移 / 下移 / 升一级 / 降一级」四项；用不了的项是**禁用 + 说明原因**（不是消失）',
      passed: false,
      detail: `${String(error)}；${diagnostics()}`
    })
  }

  // ---- X2 上移 / 下移：落库位置真的变了（重挂后顺序仍然对） ----
  try {
    if (moveFixtureError !== '') throw new Error(`样本没造出来：${moveFixtureError}`)
    await resetMoveTree()
    await openLearningTopic(context, moveFixture.topicId)
    const before = await readMoveNodes()
    const orderBefore = (id: string): number => before.find((node) => node.id === id)?.order ?? -1
    const startOk = orderBefore(moveFixture.ch1) === 0 && orderBefore(moveFixture.ch2) === 1

    // ① 点「下移」→ 第一章 与 第二章 换位
    const menu1 = await openMoveRowMenu(moveFixture.ch1)
    if (menu1 === null) throw new Error('章节行的 ⋯ 没有出菜单')
    const clickedDown = await clickMenuItem(context, 'node-move-down')
    const afterDown = await until<Array<{ id: string; parentId: string | null; order: number }>>(
      context,
      `(async () => {
         const alive = await window.api.data.listAlive('learning')
         return alive
           .filter((item) => item['kind'] === 'node' && item['ownerId'] === ${JSON.stringify(moveFixture.topicId)})
           .map((item) => ({ id: String(item['id']), parentId: item['parentId'] === undefined ? null : item['parentId'], order: Number(item['order'] || 0) }))
       })()`,
      (rows) =>
        rows.find((row) => row.id === moveFixture.ch1)?.order === 1 &&
        rows.find((row) => row.id === moveFixture.ch2)?.order === 0,
      14,
      250
    )
    const downOk = afterDown !== null
    /*
     * 界面上的**行序**要轮询着等 —— 落库（`until` 已经等到）与 React 重渲染
     * 不是同一帧：落库一到位就读 DOM，读到的还是**上一帧**的顺序，
     * 于是这条会红成"落库对了但界面没动"（第一次全量跑就是这样红的）。
     */
    const domOk = await untilTrue(
      context,
      `(() => {
         const rows = Array.from(document.querySelectorAll('[data-testid="learning-tree-row"]')).map((row) => row.getAttribute('data-node-id') || '')
         const ch2At = rows.indexOf(${JSON.stringify(moveFixture.ch2)})
         const ch1At = rows.indexOf(${JSON.stringify(moveFixture.ch1)})
         return ch2At >= 0 && ch1At >= 0 && ch2At < ch1At
       })()`,
      14,
      250
    )
    const rowOrderAfterDown = await readLearningRowOrder()
    // 父级不变（同级上下移不动层级）
    const parentStayed = (afterDown ?? []).find((row) => row.id === moveFixture.ch1)?.parentId === moveFixture.resA

    // ② 再点一次「上移」→ 回到原样（上移也得真的动）
    const menu2 = await openMoveRowMenu(moveFixture.ch1)
    if (menu2 === null) throw new Error('第二次打开章节行的 ⋯ 失败')
    const clickedUp = await clickMenuItem(context, 'node-move-up')
    const afterUp = await until<Array<{ id: string; parentId: string | null; order: number }>>(
      context,
      `(async () => {
         const alive = await window.api.data.listAlive('learning')
         return alive
           .filter((item) => item['kind'] === 'node' && item['ownerId'] === ${JSON.stringify(moveFixture.topicId)})
           .map((item) => ({ id: String(item['id']), parentId: item['parentId'] === undefined ? null : item['parentId'], order: Number(item['order'] || 0) }))
       })()`,
      (rows) =>
        rows.find((row) => row.id === moveFixture.ch1)?.order === 0 &&
        rows.find((row) => row.id === moveFixture.ch2)?.order === 1,
      14,
      250
    )
    // 顺序连续、无空洞（被牵连的兄弟 order 也重排了）
    const orders = (afterUp ?? [])
      .filter((row) => row.parentId === moveFixture.resA)
      .map((row) => row.order)
      .sort((a, b) => a - b)
    const noGap = orders.length === 2 && orders[0] === 0 && orders[1] === 1

    record({
      id: 'P8-X2',
      prd: '修改-2 §8.3',
      name: '上移 / 下移真的落库：点「下移」后第一章排到第二章后面（父级不变、DOM 顺序跟着变），再点「上移」回到原样',
      passed: startOk && clickedDown && downOk && domOk && parentStayed && clickedUp && afterUp !== null && noGap,
      detail: `起始位置对=${startOk}；点「下移」=${clickedDown} 落库=${downOk}（第一章 order=${(afterDown ?? []).find((r) => r.id === moveFixture.ch1)?.order ?? '?'}、第二章 order=${(afterDown ?? []).find((r) => r.id === moveFixture.ch2)?.order ?? '?'}）；父级没变=${parentStayed}；界面上第二章排在第一章前面=${domOk}（行序=[${rowOrderAfterDown.join(',')}]）；点「上移」=${clickedUp} 回到原样=${afterUp !== null}；order 连续无空洞=${noGap}（[${orders.join(',')}]）`
    })
  } catch (error) {
    record({
      id: 'P8-X2',
      prd: '修改-2 §8.3',
      name: '上移 / 下移真的落库：点「下移」后第一章排到第二章后面（父级不变、DOM 顺序跟着变），再点「上移」回到原样',
      passed: false,
      detail: `${String(error)}；${diagnostics()}`
    })
  }

  // ---- X3 升级（1.1 → 1）：挂到"爷爷"下面，紧跟在原父节点之后 ----
  try {
    if (moveFixtureError !== '') throw new Error(`样本没造出来：${moveFixtureError}`)
    await resetMoveTree()
    await openLearningTopic(context, moveFixture.topicId)
    const nodeCountBefore = (await readMoveNodes()).length
    const menu = await openMoveRowMenu(moveFixture.sec)
    if (menu === null) throw new Error('1.1 那一行的 ⋯ 没有出菜单')
    const promoteEnabled = !menu.disabledIds.includes('node-promote')
    const clicked = await clickMenuItem(context, 'node-promote')
    const after = await until<Array<{ id: string; parentId: string | null; order: number }>>(
      context,
      `(async () => {
         const alive = await window.api.data.listAlive('learning')
         return alive
           .filter((item) => item['kind'] === 'node' && item['ownerId'] === ${JSON.stringify(moveFixture.topicId)})
           .map((item) => ({ id: String(item['id']), parentId: item['parentId'] === undefined ? null : item['parentId'], order: Number(item['order'] || 0) }))
       })()`,
      (rows) => rows.find((row) => row.id === moveFixture.sec)?.parentId === moveFixture.resA,
      14,
      250
    )
    const sec = (after ?? []).find((row) => row.id === moveFixture.sec)
    const ch1Row = (after ?? []).find((row) => row.id === moveFixture.ch1)
    // 位置紧跟原父节点之后：order = 父节点 order + 1，且父节点仍是资料甲
    const rightAfterParent =
      sec !== undefined && ch1Row !== undefined && sec.order === ch1Row.order + 1 && ch1Row.order === 0
    // 子树跟着走（这一行本来没有子节点，用"移动前后节点数不变"代替）
    const nodeCountOk = (after ?? []).length === nodeCountBefore
    record({
      id: 'P8-X3',
      prd: '修改-2 §8.3',
      name: '升级（1.1 → 1）：parentId 变成原来父节点的 parentId（资料甲），位置紧跟在原父节点之后',
      passed: promoteEnabled && clicked && after !== null && rightAfterParent && nodeCountOk,
      detail: `「升一级」可用=${promoteEnabled} 点击=${clicked}；升级后 1.1 的 parentId=${String(sec?.parentId)}（期望 ${moveFixture.resA}）order=${String(sec?.order)}；原父节点（第一章）order=${String(ch1Row?.order)}；紧跟其后=${rightAfterParent}；节点数 ${nodeCountBefore} → ${(after ?? []).length}（不变=${nodeCountOk}）`
    })
  } catch (error) {
    record({
      id: 'P8-X3',
      prd: '修改-2 §8.3',
      name: '升级（1.1 → 1）：parentId 变成原来父节点的 parentId（资料甲），位置紧跟在原父节点之后',
      passed: false,
      detail: `${String(error)}；${diagnostics()}`
    })
  }

  // ---- X4 降级（1 → 1.1）：挂到上一个兄弟的最后 ----
  try {
    if (moveFixtureError !== '') throw new Error(`样本没造出来：${moveFixtureError}`)
    await resetMoveTree()
    await openLearningTopic(context, moveFixture.topicId)
    const menu = await openMoveRowMenu(moveFixture.ch2)
    if (menu === null) throw new Error('第二章那一行的 ⋯ 没有出菜单')
    const demoteEnabled = !menu.disabledIds.includes('node-demote')
    const clicked = await clickMenuItem(context, 'node-demote')
    const after = await until<Array<{ id: string; parentId: string | null; order: number }>>(
      context,
      `(async () => {
         const alive = await window.api.data.listAlive('learning')
         return alive
           .filter((item) => item['kind'] === 'node' && item['ownerId'] === ${JSON.stringify(moveFixture.topicId)})
           .map((item) => ({ id: String(item['id']), parentId: item['parentId'] === undefined ? null : item['parentId'], order: Number(item['order'] || 0) }))
       })()`,
      (rows) => rows.find((row) => row.id === moveFixture.ch2)?.parentId === moveFixture.ch1,
      14,
      250
    )
    const ch2Row = (after ?? []).find((row) => row.id === moveFixture.ch2)
    // 挂在第一章孩子里的**最后**：没有别的孩子 order 比它大
    const siblingsUnderCh1 = (after ?? []).filter((row) => row.parentId === moveFixture.ch1)
    const isLast =
      ch2Row !== undefined &&
      siblingsUnderCh1.every((row) => row.id === moveFixture.ch2 || row.order < ch2Row.order)
    const parentOk = ch2Row?.parentId === moveFixture.ch1
    record({
      id: 'P8-X4',
      prd: '修改-2 §8.3',
      name: '降级（1 → 1.1）：parentId 变成上一个兄弟（第一章），且排在它孩子里的最后',
      passed: demoteEnabled && clicked && after !== null && parentOk && isLast && siblingsUnderCh1.length === 2,
      detail: `「降一级」可用=${demoteEnabled} 点击=${clicked}；降级后 第二章 parentId=${String(ch2Row?.parentId)}（期望 ${moveFixture.ch1}）order=${String(ch2Row?.order)}；第一章的孩子=[${siblingsUnderCh1.map((row) => `${row.id.slice(0, 6)}@${row.order}`).join(',')}]；排在最后=${isLast}`
    })
  } catch (error) {
    record({
      id: 'P8-X4',
      prd: '修改-2 §8.3',
      name: '降级（1 → 1.1）：parentId 变成上一个兄弟（第一章），且排在它孩子里的最后',
      passed: false,
      detail: `${String(error)}；${diagnostics()}`
    })
  }

  // ---- X5 中区「资料」行的菜单里**没有**那四项（只有树里有） ----
  try {
    if (moveFixtureError !== '') throw new Error(`样本没造出来：${moveFixtureError}`)
    await resetMoveTree()
    await openLearningTopic(context, moveFixture.topicId)
    await closeFloaters(context)
    const rowSelector = `[data-testid="learning-resource-row"][data-resource-id="${moveFixture.resA}"]`
    const rowShown = await untilTrue(context, `!!document.querySelector('${rowSelector}')`, 14, 250)
    const bandOpened = rowShown
      ? await clickMenuButton(context, 'learning-resource-menu', rowSelector)
      : false
    const bandMenu = bandOpened ? await waitForMenu(context) : null
    const bandIds = bandMenu?.ids ?? []
    await closeFloaters(context)
    // 同一份资料在**树里**那一行：四项必须在（中区少的就是它们）
    const treeMenu = await openMoveRowMenu(moveFixture.resA)
    const treeIds = treeMenu?.ids ?? []
    await closeFloaters(context)

    const bandHasNone = MOVE2_IDS.every((id) => !bandIds.includes(id))
    const treeHasAll = MOVE2_IDS.every((id) => treeIds.includes(id))
    const bandStillHasDelete = bandIds.includes('node-delete')
    // 资料是顶层：升一级 / 降一级在树里也应该是禁用的
    const rootMovesDisabled =
      treeMenu !== null &&
      treeMenu.disabledIds.includes('node-promote') &&
      treeMenu.disabledIds.includes('node-demote')
    record({
      id: 'P8-X5',
      prd: '修改-2 §8.3',
      name: '中区「资料」行的菜单里**没有**那四个移动项（扁平列表里没意义），而树里同一行有；资料（顶层）的升 / 降级在树里是禁用的',
      passed:
        rowShown && bandOpened && bandMenu !== null && bandHasNone && bandStillHasDelete && treeHasAll && rootMovesDisabled,
      detail: `中区资料行渲染=${rowShown} ⋯ 打开=${bandOpened} 项=[${bandIds.join(',')}]；四项一个都没有=${bandHasNone}；仍有「删除」=${bandStillHasDelete}；树里同一行项=[${treeIds.join(',')}] 四项齐全=${treeHasAll}；资料（顶层）升/降级都禁用=${rootMovesDisabled}`
    })
  } catch (error) {
    record({
      id: 'P8-X5',
      prd: '修改-2 §8.3',
      name: '中区「资料」行的菜单里**没有**那四个移动项（扁平列表里没意义），而树里同一行有；资料（顶层）的升 / 降级在树里是禁用的',
      passed: false,
      detail: `${String(error)}；${diagnostics()}`
    })
  }

  // ---- 复习页那一段的公共工具 ----
  /** 把"隐藏了哪些主题"直接写回偏好（复位用；正常用户路径走界面） */
  const setHiddenTopics = async (keys: string[]): Promise<void> => {
    await evaluate(
      context,
      `(async () => {
         const records = await window.api.data.list('app')
         const existing = records.find((item) => item['id'] === 'preferences')
         if (existing) {
           await window.api.data.update('app', 'preferences', { reviewHiddenTopicIds: ${JSON.stringify(keys)} })
         } else {
           await window.api.data.add('app', { id: 'preferences', reviewHiddenTopicIds: ${JSON.stringify(keys)} })
         }
         await window.api.data.flush()
         return true
       })()`
    )
    await evaluate(
      context,
      `window.dispatchEvent(new CustomEvent('worklife:data-changed', { detail: { module: 'app' } })), true`
    )
    await wait(300)
  }

  interface ReviewBarSnapshot {
    due: number
    topicDueTotal: number
    totalText: string
    buttonText: string
    navBadge: string
    visibleCount: number
    hiddenCount: number
    topicCount: number
    distribution: string
    sidebarSum: number
  }
  const reviewBarExpr = `(() => {
    const summary = window.__verify.byTestId('review-summary')
    if (!summary) return null
    const list = window.__verify.byTestId('review-topics')
    const nav = document.querySelector('[data-nav-id="review"]')
    const badge = nav ? nav.querySelector('.nav__badge') : null
    const rows = Array.from(document.querySelectorAll('[data-testid="review-topic"]'))
    return {
      due: Number(summary.getAttribute('data-due') || '-1'),
      topicDueTotal: Number(summary.getAttribute('data-topic-due-total') || '-1'),
      totalText: ((window.__verify.byTestId('review-summary-total') || {}).textContent || '').trim(),
      buttonText: ((window.__verify.byTestId('review-summary-start') || {}).textContent || '').trim(),
      navBadge: badge ? (badge.textContent || '').trim() : '',
      visibleCount: Number((list || { getAttribute: () => '-1' }).getAttribute('data-visible-count')),
      hiddenCount: Number((list || { getAttribute: () => '-1' }).getAttribute('data-hidden-count')),
      topicCount: Number(((window.__verify.byTestId('review-topics-count') || {}).textContent || '-1').trim()),
      distribution: ((window.__verify.byTestId('review-summary-topics') || {}).textContent || '').trim(),
      sidebarSum: rows.reduce((sum, row) => sum + Number(row.getAttribute('data-due') || '0'), 0)
    }
  })()`
  const readReviewBar = async (): Promise<ReviewBarSnapshot | null> =>
    until<ReviewBarSnapshot | null>(
      context,
      reviewBarExpr,
      (value) => value !== null && value.topicDueTotal >= 0 && value.due >= 0,
      16,
      250
    )

  /** 复习页左栏里某个主题那一行（按 key 精确定位，不做字符串转义） */
  const topicRowSelector = (key: string): string =>
    `[data-testid="review-topic-row"][data-topic-key="${key}"]`
  const reviewAKey = `topic:${moveFixture.reviewA}`

  // ---- X6 左栏主题行有 ⋯ 与右键；点「隐藏」→ 该行从左栏消失 ----
  try {
    if (moveFixtureError !== '') throw new Error(`样本没造出来：${moveFixtureError}`)
    await setHiddenTopics([])
    await openReviewIdle(context)
    const selector = topicRowSelector(reviewAKey)
    const rowShown = await untilTrue(context, `!!document.querySelector('${selector}')`, 16, 250)
    if (!rowShown) throw new Error('左栏里找不到刚造的复习主题甲')

    // ① 右键
    await closeFloaters(context)
    const rightClicked = await rightClickSelector(context, selector)
    const rightMenu = rightClicked ? await waitForMenu(context) : null
    await closeFloaters(context)
    // ② 行尾 `⋯`
    const buttonClicked = await clickMenuButton(context, 'review-topic-menu', selector)
    const buttonMenu = buttonClicked ? await waitForMenu(context) : null
    const sameByTwoWays = rightMenu !== null && buttonMenu !== null && sameItems(rightMenu, buttonMenu)
    const hasHide = (buttonMenu?.ids ?? []).includes('review-topic-hide')
    // ③ 点「隐藏」→ 这一行从左栏消失
    const clickedHide = buttonMenu !== null ? await clickMenuItem(context, 'review-topic-hide') : false
    const rowGone = await untilTrue(context, `!document.querySelector('${selector}')`, 14, 250)
    const hiddenMark = await evaluate<number>(
      context,
      `Number((window.__verify.byTestId('review-topics') || { getAttribute: () => '-1' }).getAttribute('data-hidden-count'))`
    )
    record({
      id: 'P8-X6',
      prd: '修改-2 §8.3',
      name: '复习页左栏每一行有 ⋯ 与右键（取同一份菜单项）；点「隐藏」→ 该行从左栏消失，隐藏计数变成 1',
      passed:
        rowShown && rightClicked && buttonClicked && sameByTwoWays && hasHide && clickedHide && rowGone && hiddenMark === 1,
      detail: `行渲染=${rowShown}；右键=${rightClicked} 项=[${(rightMenu?.ids ?? []).join(',')}]；⋯=${buttonClicked} 项=[${(buttonMenu?.ids ?? []).join(',')}]；两路一致=${sameByTwoWays}；有「隐藏」=${hasHide}；点隐藏=${clickedHide} 行消失=${rowGone}；隐藏计数=${hiddenMark}（期望 1）`
    })
  } catch (error) {
    record({
      id: 'P8-X6',
      prd: '修改-2 §8.3',
      name: '复习页左栏每一行有 ⋯ 与右键（取同一份菜单项）；点「隐藏」→ 该行从左栏消失，隐藏计数变成 1',
      passed: false,
      detail: `${String(error)}；${diagnostics()}`
    })
  }

  // ---- X7 ★防漏：隐藏之后总数 / 分布 / 汇总复习按钮 / 导航角标一个都没变 ----
  try {
    if (moveFixtureError !== '') throw new Error(`样本没造出来：${moveFixtureError}`)
    await setHiddenTopics([])
    await openReviewIdle(context)
    const selector = topicRowSelector(reviewAKey)
    await untilTrue(context, `!!document.querySelector('${selector}')`, 16, 250)
    const before = await readReviewBar()
    if (before === null) throw new Error('没读到汇总横条')

    // 通过界面隐藏（与用户操作同一条路）
    await closeFloaters(context)
    const opened = await clickMenuButton(context, 'review-topic-menu', selector)
    const menu = opened ? await waitForMenu(context) : null
    if (menu === null) throw new Error('主题行的 ⋯ 没有出菜单')
    await clickMenuItem(context, 'review-topic-hide')
    const rowGone = await untilTrue(context, `!document.querySelector('${selector}')`, 14, 250)
    const after = await readReviewBar()
    if (after === null) throw new Error('隐藏之后没读到汇总横条')

    // 期望值按数据自己算一遍（不靠界面自证）
    const expectedDue = dueQueue(await reviewCardsNormalized(), todayKey).length
    const numbersUnchanged =
      before.due === after.due &&
      before.topicDueTotal === after.topicDueTotal &&
      before.totalText === after.totalText &&
      before.buttonText === after.buttonText &&
      before.navBadge === after.navBadge &&
      before.topicCount === after.topicCount
    const matchesData = after.due === expectedDue && after.topicDueTotal === expectedDue
    const badgeMatches = after.navBadge === (expectedDue > 99 ? '99+' : String(expectedDue))
    const listShrunk = after.visibleCount === before.visibleCount - 1 && after.hiddenCount === 1
    // 分布明细：被隐藏的主题**还在**，只是多了「（已隐藏）」
    const distributionKept =
      after.distribution.includes('（已隐藏）') &&
      after.distribution.includes(`${move2Marker} 复习主题甲`)

    record({
      id: 'P8-X7',
      prd: '修改-2 §4.1/决定19',
      name: '★防漏：隐藏一个主题后，汇总总数 / 分布张数 / 「汇总复习（N）」/ 导航角标**一个都没变**；分布里那一行还在并标着「（已隐藏）」',
      passed:
        before.topicDueTotal > 0 &&
        rowGone &&
        numbersUnchanged &&
        matchesData &&
        badgeMatches &&
        listShrunk &&
        distributionKept,
      detail: `隐藏前：data-due=${before.due} data-topic-due-total=${before.topicDueTotal} 文案="${before.totalText}" 按钮="${before.buttonText}" 角标="${before.navBadge}" 可见=${before.visibleCount} 主题数=${before.topicCount}；隐藏后：data-due=${after.due} data-topic-due-total=${after.topicDueTotal} 文案="${after.totalText}" 按钮="${after.buttonText}" 角标="${after.navBadge}" 可见=${after.visibleCount} 隐藏=${after.hiddenCount}；六个数字全等=${numbersUnchanged}；按数据算=${expectedDue} 横条对=${matchesData} 角标对=${badgeMatches}；左栏只少了一行=${listShrunk}；分布仍含该主题且标「（已隐藏）」=${distributionKept}（"${after.distribution}"）`
    })
  } catch (error) {
    record({
      id: 'P8-X7',
      prd: '修改-2 §4.1/决定19',
      name: '★防漏：隐藏一个主题后，汇总总数 / 分布张数 / 「汇总复习（N）」/ 导航角标**一个都没变**；分布里那一行还在并标着「（已隐藏）」',
      passed: false,
      detail: `${String(error)}；${diagnostics()}`
    })
  }

  // ---- X8 ★防漏：「汇总复习(N)」仍然能复习到被隐藏主题的卡 ----
  try {
    if (moveFixtureError !== '') throw new Error(`样本没造出来：${moveFixtureError}`)
    // 前提：复习主题甲 仍然是隐藏的（X7 留下的状态；不依赖它，这里显式再写一次）
    await setHiddenTopics([reviewAKey])
    await openReviewIdle(context)
    await untilTrue(context, `!document.querySelector('${topicRowSelector(reviewAKey)}')`, 16, 250)
    const bar = await readReviewBar()
    if (bar === null) throw new Error('没读到汇总横条')
    const expectedDue = dueQueue(await reviewCardsNormalized(), todayKey).length

    const clicked = await evaluate<boolean>(
      context,
      `(() => {
         const button = document.querySelector('[data-testid="review-summary-start"]')
         if (!button) return false
         button.click()
         return true
       })()`
    )
    // 被隐藏主题的那张卡逾期十年 → 到期队列里排第一
    const firstCardId = await until<string>(
      context,
      `(() => {
         const card = window.__verify.byTestId('review-card')
         return card ? card.getAttribute('data-card-id') || '' : ''
       })()`,
      (value) => value !== '' && value === moveFixture.cardA,
      16,
      250
    )
    await pressKeyOn(context, 'Escape')
    const sessionClosed = await untilTrue(context, `!window.__verify.exists('review-session')`, 12, 200)
    record({
      id: 'P8-X8',
      prd: '修改-2 §4.1/决定19',
      name: '★防漏：主题被隐藏后，「汇总复习(N)」的队列**仍然包含**它的到期卡（不漏复习）',
      passed:
        clicked &&
        firstCardId === moveFixture.cardA &&
        bar.due === expectedDue &&
        sessionClosed,
      detail: `隐藏后左栏里看不到主题甲=${bar.visibleCount} 可见；横条 data-due=${bar.due}（按数据算 ${expectedDue}）；点「汇总复习」=${clicked}；队列第一张=${firstCardId || '（没出现）'}（期望被隐藏主题的卡 ${moveFixture.cardA}）；Esc 退出会话=${sessionClosed}`
    })
  } catch (error) {
    record({
      id: 'P8-X8',
      prd: '修改-2 §4.1/决定19',
      name: '★防漏：主题被隐藏后，「汇总复习(N)」的队列**仍然包含**它的到期卡（不漏复习）',
      passed: false,
      detail: `${String(error)}；${diagnostics()}`
    })
  }

  // ---- X10 隐藏状态落进 app 偏好（重开应用仍然生效） ----
  // ⚠️ 必须排在 X9 之前：X9 最后会把隐藏取消掉
  try {
    if (moveFixtureError !== '') throw new Error(`样本没造出来：${moveFixtureError}`)
    await setHiddenTopics([reviewAKey])
    // 落盘：文件里要能看到这个 key（重开程序才会保持隐藏）
    let diskKeys: string[] | null = null
    for (let attempt = 0; attempt < 12; attempt += 1) {
      try {
        const raw = readFileSync(join(context.paths.data, 'app.json'), 'utf8')
        const parsed = JSON.parse(raw) as { records?: Array<Record<string, unknown>> }
        const found = (parsed.records ?? []).find((item) => item['id'] === 'preferences')
        const value = found?.['reviewHiddenTopicIds']
        diskKeys = Array.isArray(value) ? value.map((item) => String(item)) : []
        if (diskKeys.includes(reviewAKey)) break
      } catch {
        /* 文件还没写出来就再等一轮 */
      }
      await wait(200)
    }
    // 再进一次页面（等价于重开后的展现）：那个主题仍然是隐藏的
    await openReviewIdle(context)
    const stillHidden = await until<boolean>(
      context,
      `(() => {
         const list = window.__verify.byTestId('review-topics')
         const row = document.querySelector('${topicRowSelector(reviewAKey)}')
         return !!list && !row && Number(list.getAttribute('data-hidden-count')) >= 1
       })()`,
      (value) => value === true,
      16,
      250
    )
    record({
      id: 'P8-X10',
      prd: '修改-2 §8.3',
      name: '隐藏状态写进 app 偏好并落盘：重开应用（重新进页面、从磁盘重读）之后那个主题仍然是隐藏的',
      passed: (diskKeys ?? []).includes(reviewAKey) && stillHidden === true,
      detail: `app.json 里 reviewHiddenTopicIds=[${(diskKeys ?? []).join(',')}]（要含 ${reviewAKey}）；重新进页面后仍然是隐藏的=${stillHidden}`
    })
  } catch (error) {
    record({
      id: 'P8-X10',
      prd: '修改-2 §8.3',
      name: '隐藏状态写进 app 偏好并落盘：重开应用（重新进页面、从磁盘重读）之后那个主题仍然是隐藏的',
      passed: false,
      detail: `${String(error)}；${diagnostics()}`
    })
  }

  // ---- X9 打开「显示已隐藏(N)」→ 灰显行出现；点「取消隐藏」→ 回到正常列表 ----
  try {
    if (moveFixtureError !== '') throw new Error(`样本没造出来：${moveFixtureError}`)
    await openReviewIdle(context)
    const selector = topicRowSelector(reviewAKey)
    // 前提：此刻它是隐藏的（X10 留下的状态）；不是就先藏起来
    const alreadyHidden = await evaluate<boolean>(context, `!document.querySelector('${selector}')`)
    if (!alreadyHidden) {
      await setHiddenTopics([reviewAKey])
      await openReviewIdle(context)
    }
    const toggleShown = await untilTrue(
      context,
      `window.__verify.exists('review-topics-show-hidden')`,
      16,
      250
    )
    const toggleText = await evaluate<string>(
      context,
      `(((window.__verify.byTestId('review-topics-show-hidden') || {}).textContent) || '').trim()`
    )
    const toggled = await evaluate<boolean>(
      context,
      `(() => {
         const button = window.__verify.byTestId('review-topics-show-hidden')
         if (!button) return false
         button.click()
         return true
       })()`
    )
    // 灰显行出现
    const grayShown = await until<{ shown: boolean; hiddenAttr: string; visibleCount: number } | null>(
      context,
      `(() => {
         const row = document.querySelector('${selector}')
         const button = document.querySelector('${selector} [data-testid="review-topic"]')
         const list = window.__verify.byTestId('review-topics')
         if (!row || !button || !list) return null
         return {
           shown: true,
           hiddenAttr: button.getAttribute('data-hidden') || '',
           visibleCount: Number(list.getAttribute('data-visible-count'))
         }
       })()`,
      (value) => value !== null && value.hiddenAttr === '1',
      14,
      250
    )
    // 行尾的「取消隐藏」直接把它找回来
    const clickedUnhide = await evaluate<boolean>(
      context,
      `(() => {
         const button = document.querySelector('${selector} [data-testid="review-topic-unhide"]')
         if (!button) return false
         button.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }))
         return true
       })()`
    )
    const backToNormal = await until<{ hidden: string; count: number; summaryTotal: number } | null>(
      context,
      `(() => {
         const button = document.querySelector('${selector} [data-testid="review-topic"]')
         const list = window.__verify.byTestId('review-topics')
         const summary = window.__verify.byTestId('review-summary')
         if (!button || !list || !summary) return null
         return {
           hidden: button.getAttribute('data-hidden') || '',
           count: Number(list.getAttribute('data-hidden-count')),
           summaryTotal: Number(summary.getAttribute('data-due') || '-1')
         }
       })()`,
      (value) => value !== null && value.hidden === '0' && value.count === 0,
      14,
      250
    )
    const expectedDue = dueQueue(await reviewCardsNormalized(), todayKey).length
    record({
      id: 'P8-X9',
      prd: '修改-2 §8.3',
      name: '打开「显示已隐藏(N)」→ 隐藏行灰显出现（行尾有「取消隐藏」）；点它 → 回到正常列表，总数始终不变',
      passed:
        toggleShown &&
        toggleText.includes('显示已隐藏') &&
        toggled &&
        grayShown !== null &&
        clickedUnhide &&
        backToNormal !== null &&
        backToNormal.summaryTotal === expectedDue,
      detail: `开关文案="${toggleText}"；点开关=${toggled}；灰显行出现=${grayShown !== null}（data-hidden="${grayShown?.hiddenAttr ?? '?'}"）；点「取消隐藏」=${clickedUnhide}；回到隐藏计数 0=${backToNormal !== null}（data-hidden="${backToNormal?.hidden ?? '?'}"，count=${backToNormal?.count ?? '?'}）；全程汇总总数=${backToNormal?.summaryTotal ?? '?'}（按数据算 ${expectedDue}）`
    })
  } catch (error) {
    record({
      id: 'P8-X9',
      prd: '修改-2 §8.3',
      name: '打开「显示已隐藏(N)」→ 隐藏行灰显出现（行尾有「取消隐藏」）；点它 → 回到正常列表，总数始终不变',
      passed: false,
      detail: `${String(error)}；${diagnostics()}`
    })
  }

  // 收尾：把隐藏清回空 —— 上一趟的 `P8-U1` 要求"左栏各主题到期数之和 = 汇总总数"，
  // 留着隐藏项会让它变红（这条不是放宽断言，是本检查自己的复位义务）
  try {
    await setHiddenTopics([])
  } catch {
    /* 复位失败不影响本次结论；下一次 openReviewIdle 会重新读盘 */
  }

  // =========================================================================
  // 修改 3 轮（对应 `修改-3.md`）：复习页左栏的**来源档**可以删
  //
  // 用户原话：「这个还是删不掉。」（截图指左栏那个叫「手动新建」的主题）
  //
  // 上一轮按"只在复习页隐藏它"做的最小集，左栏**压根没有删除项** —— 用户说得没错。
  // 决定（用户已确认）：**只给来源档加删除**（删它 = 把它下面的卡片一起删掉，
  // 进回收站可恢复）；`topic:` / `book:` 档仍然只能隐藏。
  //
  // 硬规矩照旧：轮询等待、自带前提（每一条自己现场造样本）、先复位再操作
  // （点 `⋯` 前先关掉其它浮层）、受控组件用原生 setter。
  //
  // ⚠️ 这一块会**真删**（再恢复）那一档的卡片：Y2 删、Y3 从回收站恢复、
  // Y5 再删一次再恢复。所以 Y3/Y5 末尾都要恢复干净，别把这一趟的数据留在回收站里。
  // =========================================================================
  const move3Marker = `${marker} 修改3`

  /** 左栏某一档的那一行（用 JS 比对 key，**不把中文来源名拼进 CSS 选择器**） */
  const topicRowExprOf = (key: string): string =>
    `Array.from(document.querySelectorAll('[data-testid="review-topic-row"]')).find((row) => row.getAttribute('data-topic-key') === ${JSON.stringify(key)})`

  /** 某张卡现在被页面归到哪一档 —— 读页面自己写的映射，验收**不重算归属** */
  const topicKeyOfCard = async (cardId: string): Promise<string> => {
    const key = await until<string>(
      context,
      `(((window.__reviewCardTopics || {})[${JSON.stringify(cardId)}]) || '')`,
      (value) => typeof value === 'string' && value !== '',
      16,
      250
    )
    return key ?? ''
  }

  /** 这一档在页面眼里有哪些卡（= `buildReviewTopics()` 分出来的那一桶） */
  const bucketCardIdsOf = async (key: string): Promise<string[]> =>
    evaluate<string[]>(
      context,
      `(() => {
         const map = window.__reviewCardTopics || {}
         return Object.keys(map).filter((cardId) => map[cardId] === ${JSON.stringify(key)})
       })()`
    )

  /** Y1 那张手写卡的 id（后面几条靠它找那一档；Y1 没造出来时它们自己补一张） */
  let move3CardId = ''

  /** 补造一张"与手写新建同一条口径"的卡（没有 topicId / bookId，来源名就是「手动新建」） */
  const addHandwrittenCard = async (front: string): Promise<string> => {
    const created = await evaluate<{ id: string }>(
      context,
      `window.api.data.add('review', {
         front: ${JSON.stringify(front)},
         back: ${JSON.stringify(`${move3Marker} 的答案`)},
         source: '手动新建',
         stage: 0,
         reviewCount: 0,
         lastReviewedAt: null,
         dueDate: ${JSON.stringify(todayKey)}
       })`
    )
    await evaluate(context, `window.api.data.flush()`)
    await evaluate(
      context,
      `window.dispatchEvent(new CustomEvent('worklife:data-changed', { detail: { module: 'review' } })), true`
    )
    await wait(400)
    return String(created.id)
  }

  /** 保证"没有归属主题的手写卡"存在（回收站里的不算 → 那就再写一张） */
  const ensureHandwrittenCard = async (): Promise<string> => {
    if (move3CardId !== '') {
      const alive = await evaluate<boolean>(
        context,
        `(async () => (await window.api.data.listAlive('review')).some((item) => String(item['id'] || '') === ${JSON.stringify(move3CardId)}))()`
      )
      if (alive) return move3CardId
    }
    move3CardId = await addHandwrittenCard(`${move3Marker} 补造的手写卡`)
    return move3CardId
  }

  /** 点左栏某一行的 `⋯` 并等菜单（先复位浮层：硬规矩第 3 条） */
  const openTopicRowMenu = async (key: string): Promise<MenuSnapshot | null> => {
    await closeFloaters(context)
    const clicked = await evaluate<boolean>(
      context,
      `(() => {
         const row = ${topicRowExprOf(key)}
         if (!row) return false
         const button = row.querySelector('[data-testid="review-topic-menu"]')
         if (!button) return false
         button.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }))
         return true
       })()`
    )
    if (!clicked) return null
    return await waitForMenu(context)
  }

  /** 走界面删掉一个来源档：`⋯` →「删除这个来源档」→ 二次确认 → 确认；每一步的结果都带回来 */
  const deleteSourceTopicViaUi = async (
    key: string
  ): Promise<{
    opened: boolean
    clicked: boolean
    dialogShown: boolean
    summaryText: string
    confirmed: boolean
    rowGone: boolean
  }> => {
    const menu = await openTopicRowMenu(key)
    const clicked = menu !== null ? await clickMenuItem(context, REVIEW_TOPIC_DELETE_ID) : false
    const dialogShown = clicked
      ? await untilTrue(context, `window.__verify.exists('review-topic-delete-dialog')`, 10, 200)
      : false
    const summaryText = dialogShown
      ? (await evaluate<string>(
          context,
          `(((window.__verify.byTestId('review-topic-delete-summary') || {}).textContent) || '').trim()`
        )) || ''
      : ''
    const confirmed = dialogShown
      ? await evaluate<boolean>(context, `window.__verify.click('[data-testid="dialog-confirm"]')`)
      : false
    const rowGone = confirmed
      ? await untilTrue(context, `!${topicRowExprOf(key)}`, 16, 250)
      : false
    return { opened: menu !== null, clicked, dialogShown, summaryText, confirmed, rowGone }
  }

  /** 把一批卡从回收站恢复回来（软删除必须可逆；也顺带把这一档还回左栏） */
  const restoreReviewCards = async (
    ids: string[]
  ): Promise<{ restored: number; backAlive: boolean }> => {
    let restored = 0
    for (const id of ids) {
      const ok = await evaluate<boolean>(
        context,
        `window.api.trash.restore('review', ${JSON.stringify(id)})`
      )
      if (ok) restored += 1
    }
    await evaluate(context, `window.api.data.flush()`)
    await evaluate(
      context,
      `window.dispatchEvent(new CustomEvent('worklife:data-changed', { detail: { module: 'review' } })), true`
    )
    const backAlive = await untilTrue(
      context,
      `(async () => {
         const alive = await window.api.data.listAlive('review')
         const ids = ${JSON.stringify(ids)}
         return ids.every((id) => alive.some((item) => String(item['id'] || '') === id))
       })()`,
      14,
      250
    )
    await wait(200)
    return { restored, backAlive }
  }

  /**
   * 保证"手写来源档"在左栏是**看得见的一行**，并返回它的 key 与卡片 id。
   *
   * 先把隐藏清空（隐藏着的行不会显示，这一条只是复位，不改隐藏行为）；
   * 上一趟把它删光了就再写一张 —— 这一档因此总是存在。
   */
  const ensureSourceBucket = async (): Promise<{ key: string; ids: string[] }> => {
    await setHiddenTopics([])
    const cardId = await ensureHandwrittenCard()
    await openReviewIdle(context)
    const key = await topicKeyOfCard(cardId)
    if (key === '') throw new Error('手写的卡没有被页面归到任何一档')
    const shown = await untilTrue(context, `!!${topicRowExprOf(key)}`, 16, 250)
    if (!shown) throw new Error(`来源档 ${key} 没有出现在左栏`)
    const ids = await bucketCardIdsOf(key)
    return { key, ids }
  }

  // ---- Y1 手写建一张卡（无归属主题）→ 左栏出现 source: 档，其 ⋯ 里有「删除这个来源档」 ----
  try {
    await setHiddenTopics([])
    await openReviewIdle(context)
    await closeFloaters(context)

    // ① 走界面手写建一张卡（表单里「关联学习项」留空 = 没有归属主题）
    const front = `${move3Marker} 手写卡的正面`
    await evaluate(context, `window.__verify.click('[data-testid="review-new-card"]')`)
    const formOpen = await untilTrue(context, `window.__verify.exists('review-form')`, 12, 200)
    if (!formOpen) throw new Error('新建复习卡表单没有打开')
    await setNativeValue(context, 'review-form-front', front)
    await setNativeValue(context, 'review-form-back', '手写卡的答案')
    await evaluate(context, `window.__verify.click('[data-testid="review-form-submit"]')`)
    const formClosed = await untilTrue(context, `!window.__verify.exists('review-form')`, 12, 250)
    await evaluate(context, `window.api.data.flush()`)

    // ② 它落库了吗（按正面找，别依赖界面状态）
    const createdId = await until<string>(
      context,
      `(async () => {
         const alive = await window.api.data.listAlive('review')
         const hit = alive.find((item) => String(item['front'] || '') === ${JSON.stringify(front)})
         return hit ? String(hit.id) : ''
       })()`,
      (value) => typeof value === 'string' && value !== '',
      14,
      250
    )
    if (createdId === null || createdId === '') throw new Error('手写的卡没有落库')
    move3CardId = createdId

    // ③ 它被归到 `source:` 档（页面自己写的映射，验收不重算归属）
    const sourceKey = await topicKeyOfCard(createdId)
    const isSourceBucket = sourceKey.startsWith('source:')
    const rowShown = await untilTrue(context, `!!${topicRowExprOf(sourceKey)}`, 16, 250)

    // ④ 那一行的 ⋯ 里有「删除这个来源档」，且带张数、排在最后
    const menu = await openTopicRowMenu(sourceKey)
    const ids = menu?.ids ?? []
    const deleteIndex = ids.indexOf(REVIEW_TOPIC_DELETE_ID)
    const labelOf = deleteIndex >= 0 ? menu?.labels[deleteIndex] ?? '' : ''
    const hintOf = deleteIndex >= 0 ? menu?.hints[deleteIndex] ?? '' : ''
    const isLast = deleteIndex >= 0 && deleteIndex === ids.length - 1
    const bucketCards = sourceKey === '' ? [] : await bucketCardIdsOf(sourceKey)
    await closeFloaters(context)

    record({
      id: 'P8-Y1',
      prd: '修改-3 §8.3',
      name: '手写建一张卡（无归属主题）→ 左栏出现 `source:` 档，那一行的 ⋯ 里有「删除这个来源档」（文案带「来源档」、hint 带张数、排在最末）',
      passed:
        formOpen &&
        formClosed &&
        isSourceBucket &&
        rowShown &&
        menu !== null &&
        deleteIndex >= 0 &&
        labelOf === REVIEW_TOPIC_DELETE_LABEL &&
        hintOf.includes('张卡片') &&
        hintOf.includes(String(bucketCards.length)) &&
        isLast,
      detail: `表单打开=${formOpen} 提交后关闭=${formClosed} 卡 id=${move3CardId}；归到的那一档="${sourceKey}"（是 source: 档=${isSourceBucket}）；左栏那一行渲染=${rowShown}；菜单项=[${ids.join(',')}]；「删除这个来源档」在第 ${deleteIndex + 1} 项（共 ${ids.length} 项，在最后=${isLast}）；文案="${labelOf}"（期望 ${REVIEW_TOPIC_DELETE_LABEL}）；hint="${hintOf}"（要含 "${bucketCards.length} 张卡片"）`
    })
  } catch (error) {
    record({
      id: 'P8-Y1',
      prd: '修改-3 §8.3',
      name: '手写建一张卡（无归属主题）→ 左栏出现 `source:` 档，那一行的 ⋯ 里有「删除这个来源档」（文案带「来源档」、hint 带张数、排在最末）',
      passed: false,
      detail: `${String(error)}；${diagnostics()}`
    })
  }

  // ---- Y2 点它 → 弹 review-topic-delete-dialog（正文含卡片数）→ 确认后该档从左栏消失 ----
  let move3DeletedIds: string[] = []
  try {
    const bucket = await ensureSourceBucket()
    if (!bucket.key.startsWith('source:')) {
      throw new Error(`这一档不是来源档（${bucket.key}），不该有删除项`)
    }
    if (bucket.ids.length === 0) throw new Error('这一档一张卡都没有，没法验"连带删"')
    // 正文要写清三件事：哪个档、会删几张卡、能恢复
    const expectedTitle = bucket.key.slice('source:'.length)
    const ui = await deleteSourceTopicViaUi(bucket.key)
    if (ui.confirmed) move3DeletedIds = bucket.ids
    const saysBucket = ui.summaryText.includes(`「${expectedTitle}」`)
    const saysCount = ui.summaryText.includes(`${bucket.ids.length} 张卡片`)
    const saysRestore = ui.summaryText.includes('回收站')
    record({
      id: 'P8-Y2',
      prd: '修改-3 §8.3',
      name: '来源档的 ⋯ 里点「删除这个来源档」→ 弹二次确认（正文写明「哪个档 + 几张卡 + 可恢复」）→ 确认后该档从左栏消失',
      passed:
        bucket.ids.length > 0 &&
        ui.opened &&
        ui.clicked &&
        ui.dialogShown &&
        saysBucket &&
        saysCount &&
        saysRestore &&
        ui.confirmed &&
        ui.rowGone,
      detail: `这一档="${bucket.key}"（${bucket.ids.length} 张卡）；⋯ 打开=${ui.opened} 点「删除这个来源档」=${ui.clicked}；二次确认弹出=${ui.dialogShown} 正文="${ui.summaryText}"（含档名=${saysBucket}、含"${bucket.ids.length} 张卡片"=${saysCount}、含"回收站"=${saysRestore}）；确认=${ui.confirmed} 该档从左栏消失=${ui.rowGone}`
    })
  } catch (error) {
    record({
      id: 'P8-Y2',
      prd: '修改-3 §8.3',
      name: '来源档的 ⋯ 里点「删除这个来源档」→ 弹二次确认（正文写明「哪个档 + 几张卡 + 可恢复」）→ 确认后该档从左栏消失',
      passed: false,
      detail: `${String(error)}；${diagnostics()}`
    })
  }

  // ---- Y3 被删的卡片在回收站里能看到，且能恢复 ----
  try {
    // 前提：这一档已经被删掉（Y2）。没删就自己删一遍，不依赖前面那条检查的结果。
    let ids = move3DeletedIds
    const bucketProbe = await ensureSourceBucket().catch(() => null)
    if (bucketProbe !== null && ids.length === 0) {
      const ui = await deleteSourceTopicViaUi(bucketProbe.key)
      if (ui.confirmed) ids = bucketProbe.ids
    }
    if (ids.length === 0) throw new Error('没有删掉任何卡片（这一档的卡片 id 没拿到）')

    // ① 回收站里能看到：按"本趟的标记"在回收站里找这批卡
    const inTrash = await until<Array<{ id: string; module: string; title: string }>>(
      context,
      `window.api.trash.list()`,
      (list) =>
        Array.isArray(list) &&
        ids.every((id) => list.some((entry) => String(entry.id || '') === id)),
      14,
      250
    )
    const trashTitles =
      inTrash === null
        ? []
        : inTrash
            .filter((entry) => entry.module === 'review' && ids.includes(String(entry.id || '')))
            .map((entry) => entry.title)
    // ② 存活列表里已经没有了（软删除）
    const aliveAfterDelete = await evaluate<boolean>(
      context,
      `(async () => {
         const alive = await window.api.data.listAlive('review')
         const ids = ${JSON.stringify(ids)}
         return alive.some((item) => ids.includes(String(item['id'] || '')))
       })()`
    )
    // ③ 从回收站恢复回来（软删除必须可逆）
    const back = await restoreReviewCards(ids)
    // ④ 恢复之后左栏那一档回来了（数据没错，只是被删过又还原）
    await openReviewIdle(context)
    const keyAfterRestore = await topicKeyOfCard(ids[0] ?? '')
    const rowBack = await untilTrue(context, `!!${topicRowExprOf(keyAfterRestore)}`, 16, 250)

    record({
      id: 'P8-Y3',
      prd: '修改-3 §8.3',
      name: '被删的卡片在回收站里能看到（软删除），并且能恢复回来——恢复后那一档重新出现在左栏',
      passed:
        inTrash !== null &&
        trashTitles.length === ids.length &&
        !aliveAfterDelete &&
        back.restored === ids.length &&
        back.backAlive &&
        rowBack,
      detail: `删掉的卡片 ${ids.length} 张；回收站里都找到了=${inTrash !== null}（${trashTitles
        .map((title) => `"${title}"`)
        .join(',')}）；删后存活列表里已无这些卡=${!aliveAfterDelete}；恢复了 ${back.restored} 张 回到存活列表=${back.backAlive}；恢复后那一档（"${keyAfterRestore}"）重新出现在左栏=${rowBack}`
    })
  } catch (error) {
    record({
      id: 'P8-Y3',
      prd: '修改-3 §8.3',
      name: '被删的卡片在回收站里能看到（软删除），并且能恢复回来——恢复后那一档重新出现在左栏',
      passed: false,
      detail: `${String(error)}；${diagnostics()}`
    })
  }

  // ---- Y4 `topic:` / `book:` 档的 ⋯ 里**没有**删除项（只有隐藏）—— 防扩散 ----
  try {
    await setHiddenTopics([])
    // 自带前提：现场造一个学习主题 + 一本没有卡片的书（两类真实实体，都不该出现删除项）
    const pair = await evaluate<{ topicId: string; bookId: string }>(
      context,
      `(async () => {
         const topic = await window.api.data.add('learning', {
           kind: 'topic',
           title: ${JSON.stringify(`${move3Marker} 对照主题`)},
           status: 'active',
           progress: 0
         })
         const reading = await window.api.data.listAlive('reading')
         const title = ${JSON.stringify(`${move3Marker} 对照书`)}
         const existing = reading.find((item) => item['kind'] === 'book' && String(item['title'] || '') === title)
         const book = existing ?? (await window.api.data.add('reading', {
           kind: 'book', title, author: '验收', format: 'paper', status: 'reading',
           totalPages: 100, currentPage: 0, percent: 0, finishedAt: null, rating: 0, review: ''
         }))
         await window.api.data.flush()
         return { topicId: String(topic.id), bookId: String(book.id) }
       })()`
    )
    await evaluate(
      context,
      `window.dispatchEvent(new CustomEvent('worklife:data-changed', { detail: { module: 'learning' } })), true`
    )
    await evaluate(
      context,
      `window.dispatchEvent(new CustomEvent('worklife:data-changed', { detail: { module: 'reading' } })), true`
    )
    await openReviewIdle(context)

    const topicKey = `topic:${pair.topicId}`
    const bookKey = `book:${pair.bookId}`
    const topicRow = await untilTrue(context, `!!${topicRowExprOf(topicKey)}`, 16, 250)
    const bookRow = await untilTrue(context, `!!${topicRowExprOf(bookKey)}`, 16, 250)
    const topicMenu = topicRow ? await openTopicRowMenu(topicKey) : null
    const bookMenu = bookRow ? await openTopicRowMenu(bookKey) : null
    await closeFloaters(context)

    const topicIds = topicMenu?.ids ?? []
    const bookIds = bookMenu?.ids ?? []
    const topicNoDelete = !topicIds.includes(REVIEW_TOPIC_DELETE_ID)
    const bookNoDelete = !bookIds.includes(REVIEW_TOPIC_DELETE_ID)
    const topicHasHide = topicIds.includes('review-topic-hide')
    const bookHasHide = bookIds.includes('review-topic-hide')
    // 而且不是"菜单空了"：正好只剩隐藏那一项
    const onlyHide = topicIds.length === 1 && bookIds.length === 1

    record({
      id: 'P8-Y4',
      prd: '修改-3 §4/§6.4',
      name: '`topic:` / `book:` 档的 ⋯ 里**没有**删除项（只有「隐藏这个主题」）—— 真实实体只能在对应的模块里删，防扩散',
      passed:
        topicRow &&
        bookRow &&
        topicMenu !== null &&
        bookMenu !== null &&
        topicNoDelete &&
        bookNoDelete &&
        topicHasHide &&
        bookHasHide &&
        onlyHide,
      detail: `学习主题那一行（${topicKey}）渲染=${topicRow} 菜单项=[${topicIds.join(',')}] 无删除=${topicNoDelete} 有隐藏=${topicHasHide}；书那一行（${bookKey}）渲染=${bookRow} 菜单项=[${bookIds.join(',')}] 无删除=${bookNoDelete} 有隐藏=${bookHasHide}；两类都只剩隐藏一项=${onlyHide}`
    })
  } catch (error) {
    record({
      id: 'P8-Y4',
      prd: '修改-3 §4/§6.4',
      name: '`topic:` / `book:` 档的 ⋯ 里**没有**删除项（只有「隐藏这个主题」）—— 真实实体只能在对应的模块里删，防扩散',
      passed: false,
      detail: `${String(error)}；${diagnostics()}`
    })
  }

  // ---- Y5 删的是**当前选中**的那一档 → 预览区不残留（选中态已复位） ----
  try {
    const bucket = await ensureSourceBucket()
    // ① 选中这一档（点左栏那一行）→ 预览区显示的就是它
    const clickedRow = await untilTrue(
      context,
      `(() => {
         const row = ${topicRowExprOf(bucket.key)}
         if (!row) return false
         const button = row.querySelector('[data-testid="review-topic"]')
         if (!button) return false
         if (button.getAttribute('data-active') !== '1') button.click()
         return true
       })()`,
      14,
      250
    )
    const previewBefore = await until<string>(
      context,
      `(() => {
         const detail = window.__verify.byTestId('review-detail')
         return detail ? detail.getAttribute('data-topic-key') || '' : ''
       })()`,
      (value) => value === bucket.key,
      16,
      250
    )
    if (previewBefore === null) throw new Error('点了这一行，预览区没有切到这一档')

    // ② 删掉它（走界面，与 Y2 同一条路）
    const ui = await deleteSourceTopicViaUi(bucket.key)
    // ③ 预览区不许再留着它：要么换成别的档，要么回到"左侧选一个主题"的空态
    const previewAfter = await until<string>(
      context,
      `(() => {
         const detail = window.__verify.byTestId('review-detail')
         if (!detail) return '__empty__'
         return detail.getAttribute('data-topic-key') || ''
       })()`,
      (value) => value !== bucket.key,
      16,
      250
    )
    // ④ 选中态落到"第一个可见主题"（一个都没有才算清空）
    const selection = await evaluate<{ active: string; first: string; rows: number }>(
      context,
      `(() => {
         const rows = Array.from(document.querySelectorAll('[data-testid="review-topic"]'))
         const active = rows.find((row) => row.getAttribute('data-active') === '1')
         return {
           active: active ? active.getAttribute('data-topic-key') || '' : '',
           first: rows.length > 0 ? rows[0].getAttribute('data-topic-key') || '' : '',
           rows: rows.length
         }
       })()`
    )
    const expectedActive = selection.rows === 0 ? '' : selection.first
    // 收尾：把删掉的卡恢复回来（别把这一趟的数据留在回收站里）
    const back = await restoreReviewCards(bucket.ids)
    await openReviewIdle(context)

    record({
      id: 'P8-Y5',
      prd: '修改-3 §6.3-5',
      name: '删的正好是**当前选中**的那一档时：预览区不残留它的数据，选中态复位到第一个可见主题（一个都没有才清空）',
      passed:
        clickedRow &&
        previewBefore === bucket.key &&
        ui.opened &&
        ui.clicked &&
        ui.confirmed &&
        ui.rowGone &&
        previewAfter !== null &&
        previewAfter !== bucket.key &&
        selection.active === expectedActive &&
        selection.active !== bucket.key &&
        back.backAlive,
      detail: `删之前：点中=${clickedRow} 预览区 data-topic-key="${previewBefore}"（= "${bucket.key}"）；删时：⋯ 打开=${ui.opened} 点删除=${ui.clicked} 确认=${ui.confirmed} 该档消失=${ui.rowGone}；删之后：预览区="${previewAfter}"（不再是那一档）；选中态="${selection.active}"（期望 "${expectedActive}"，可见主题 ${selection.rows} 个）；收尾恢复 ${back.restored} 张=${back.backAlive}`
    })
  } catch (error) {
    record({
      id: 'P8-Y5',
      prd: '修改-3 §6.3-5',
      name: '删的正好是**当前选中**的那一档时：预览区不残留它的数据，选中态复位到第一个可见主题（一个都没有才清空）',
      passed: false,
      detail: `${String(error)}；${diagnostics()}`
    })
  }

  // =========================================================================
  // 修改 4 轮（对应 `修改-4.md`）：学习主题状态可逆 + 计划任务第三态「放弃」
  //
  // 用户原话：
  //   「无法把已归档的转为未归档（学习），顺便检查其他模块。」
  //   「**标记完成不能取消**。**归档和标记完成不能同时出现**。」
  //   「计划，我要能**手动添加未完成和放弃两个选项**（和逾期功能不相关）。」
  //
  // 硬规矩照旧：轮询等待 / 自带前提（每条自己现场造样本）/ 先复位再操作
  // （点 `⋯` 前先关其它浮层）/ 受控组件用原生 setter。
  // =========================================================================
  const move4Marker = `${marker} 修改4`

  /** 学习主题在数据里的状态（按 id 读盘，不信界面） */
  const topicStatusInData = async (topicId: string): Promise<string> =>
    evaluate<string>(
      context,
      `(async () => {
         const alive = await window.api.data.listAlive('learning')
         const hit = alive.find((item) => String(item['id'] || '') === ${JSON.stringify(topicId)})
         return hit ? String(hit['status'] || '') : ''
       })()`
    )

  /** 一条计划任务在数据里的样子（`abandoned` / `done` / `date` 都看它） */
  const planTaskInData = async (taskId: string): Promise<Record<string, unknown> | null> =>
    evaluate<Record<string, unknown> | null>(
      context,
      `(async () => {
         const alive = await window.api.data.listAlive('plan')
         const hit = alive.find((item) => String(item['id'] || '') === ${JSON.stringify(taskId)})
         return hit || null
       })()`
    )

  /** 造一条样本任务（自带前提：不依赖别处留下的状态），返回 id */
  const addMove4Task = async (
    title: string,
    extra: Record<string, unknown> = {}
  ): Promise<string> =>
    addPlanSample(context, {
      title,
      date: todayKey,
      timeSlot: 'none',
      recurrence: 'none',
      done: false,
      carriedOver: 0,
      doneAt: null,
      ...extra
    })

  /**
   * 在某条任务的 `⋯` 上点一下并取回菜单读数。
   *
   * **刻意不负责切页面**：调用方必须已经把计划页打开。切模块会重挂载计划页、
   * 触发一次自动顺延，那会把"3 天前的逾期样本"当场挪到今天——
   * 于是 `P8-Z4` 想验的"逾期"根本看不到了（已踩过同类坑）。
   */
  const openTaskRowMenu = async (taskId: string): Promise<MenuSnapshot | null> => {
    await closeMenu(context) // 先复位：上一段检查可能把菜单留着
    const rowSelector = `[data-testid="task-row"][data-task-id="${taskId}"]`
    const clicked = await clickMenuButton(context, 'task-menu', rowSelector)
    if (!clicked) return null
    return waitForMenu(context)
  }

  /**
   * 走界面把一条任务标成「放弃」。
   *
   * 在「全部」视图里做：放弃之后它正好落进「已放弃（N）」那一组，
   * 所以还在同一个视图里找得到（「今天 / 本周」里它会消失，那是另一条检查）。
   */
  const abandonTaskViaUi = async (
    taskId: string
  ): Promise<{ opened: boolean; ids: string[]; label: string; clicked: boolean; state: string; labelText: string }> => {
    await openPlanList(context, 'all')
    const shown = await untilTrue(context, planRowExpr(taskId), 16, 250)
    const menu = shown ? await openTaskRowMenu(taskId) : null
    const ids = menu?.ids ?? []
    const index = ids.indexOf('task-abandon')
    const clicked = menu !== null ? await clickMenuItem(context, 'task-abandon') : false
    const state = clicked
      ? ((await until<string>(
          context,
          taskRowStateExpr(taskId),
          (value) => value === 'abandoned',
          16,
          250
        )) ?? '')
      : ''
    const labelText = clicked
      ? await evaluate<string>(context, taskAbandonedLabelExpr(taskId))
      : ''
    return {
      opened: menu !== null,
      ids,
      label: index >= 0 ? (menu?.labels[index] ?? '') : '',
      clicked,
      state,
      labelText
    }
  }

  /** 读页头统计；一直读到两次相邻读数相同为止（顺延是异步的，不能在它跑完之前取基线） */
  const stableHeaderCounts = async (view: string): Promise<PlanHeaderCounts | null> => {
    for (let attempt = 0; attempt < 10; attempt += 1) {
      const first = await evaluate<PlanHeaderCounts>(context, planHeaderCountsExpr)
      await wait(300)
      const second = await evaluate<PlanHeaderCounts>(context, planHeaderCountsExpr)
      if (first.view === view && second.view === view && first.overdue === second.overdue) {
        return second
      }
    }
    return null
  }

  // ---- Z1 学习：active 主题有「标记完成」+「归档」；点标记完成 → 变成「标记未完成」→ 再点回去 ----
  try {
    const topicId = String(
      (
        await evaluate<{ id: string }>(
          context,
          `window.api.data.add('learning', {
             kind: 'topic',
             title: ${JSON.stringify(`${move4Marker} 可逆主题一`)},
             status: 'active',
             progress: 0
           })`
        )
      ).id
    )
    await evaluate(context, `window.api.data.flush()`)
    await openLearningTopic(context, topicId)

    // ① 起点：进行中 → 「标记完成」+「归档」，反向的两个按钮都不该在
    const atActive = await until<LearningStatusButtons>(
      context,
      learningStatusButtonsExpr,
      (value) =>
        value.status === '进行中' &&
        value.markDone &&
        value.archive &&
        !value.markUndone &&
        !value.unarchive,
      16,
      250
    )
    const activeDataStatus = await topicStatusInData(topicId)

    // ② 点「标记完成」→ 已完成，按钮换成「标记未完成」（标记完成可以取消了）
    const clickedDone = await evaluate<boolean>(
      context,
      `window.__verify.click('[data-testid="learning-mark-done"]')`
    )
    const atDone = clickedDone
      ? await until<LearningStatusButtons>(
          context,
          learningStatusButtonsExpr,
          (value) =>
            value.status === '已完成' && value.markUndone && value.archive && !value.markDone,
          16,
          250
        )
      : null
    const doneDataStatus = await topicStatusInData(topicId)

    // ③ 再点「标记未完成」→ 回到进行中
    const clickedUndone = await evaluate<boolean>(
      context,
      `window.__verify.click('[data-testid="learning-mark-undone"]')`
    )
    const backActive = clickedUndone
      ? await until<LearningStatusButtons>(
          context,
          learningStatusButtonsExpr,
          (value) =>
            value.status === '进行中' && value.markDone && value.archive && !value.markUndone,
          16,
          250
        )
      : null
    const restoredDataStatus = await topicStatusInData(topicId)

    record({
      id: 'P8-Z1',
      prd: '修改-4 §8.3',
      name: '学习：active 主题有「标记完成」+「归档」→ 点标记完成后变成「标记未完成」→ 再点回去（标记完成可以取消了）',
      passed:
        atActive !== null &&
        activeDataStatus === 'active' &&
        atDone !== null &&
        doneDataStatus === 'done' &&
        backActive !== null &&
        restoredDataStatus === 'active',
      detail: `①（进行中）${describeLearningButtons(atActive)} 落盘=${activeDataStatus}；②（点「标记完成」后）${describeLearningButtons(atDone)} 落盘=${doneDataStatus}；③（点「标记未完成」后）${describeLearningButtons(backActive)} 落盘=${restoredDataStatus}`
    })
  } catch (error) {
    record({
      id: 'P8-Z1',
      prd: '修改-4 §8.3',
      name: '学习：active 主题有「标记完成」+「归档」→ 点标记完成后变成「标记未完成」→ 再点回去（标记完成可以取消了）',
      passed: false,
      detail: `${String(error)}；${diagnostics()}`
    })
  }

  // ---- Z2 学习：归档后只剩「取消归档」；点它 → 回到进行中 ----
  try {
    const topicId = String(
      (
        await evaluate<{ id: string }>(
          context,
          `window.api.data.add('learning', {
             kind: 'topic',
             title: ${JSON.stringify(`${move4Marker} 可逆主题二`)},
             status: 'active',
             progress: 0
           })`
        )
      ).id
    )
    await evaluate(context, `window.api.data.flush()`)
    await openLearningTopic(context, topicId)

    // 先把「显示已归档」打开：这样归档之后那一行仍在左栏，
    // 用户点完归档不至于当场找不到它（与真实使用路径一致）
    await evaluate(context, `window.__verify.click('[data-testid="learning-toggle-archived"]')`)
    await wait(300)

    // ① 点「归档」
    const clickedArchive = await evaluate<boolean>(
      context,
      `window.__verify.click('[data-testid="learning-archive"]')`
    )
    const atArchived = clickedArchive
      ? await until<LearningStatusButtons>(
          context,
          learningStatusButtonsExpr,
          (value) =>
            value.status === '已归档' &&
            value.unarchive &&
            !value.markDone &&
            !value.markUndone &&
            !value.archive,
          16,
          250
        )
      : null
    const archivedDataStatus = await topicStatusInData(topicId)
    const rowStillShown = await evaluate<boolean>(
      context,
      `!!document.querySelector('[data-testid="learning-topic"][data-topic-id="${topicId}"]')`
    )
    // ② 点「取消归档」→ 回到进行中（一律回 active，不记忆归档前的状态）
    const clickedUnarchive = await evaluate<boolean>(
      context,
      `window.__verify.click('[data-testid="learning-unarchive"]')`
    )
    const backActive = clickedUnarchive
      ? await until<LearningStatusButtons>(
          context,
          learningStatusButtonsExpr,
          (value) =>
            value.status === '进行中' &&
            value.markDone &&
            value.archive &&
            !value.unarchive &&
            !value.markUndone,
          16,
          250
        )
      : null
    const restoredDataStatus = await topicStatusInData(topicId)

    record({
      id: 'P8-Z2',
      prd: '修改-4 §8.3',
      name: '学习：归档后**只有「取消归档」**（标记完成 / 标记未完成都不出现）→ 点取消归档回到进行中',
      passed:
        atArchived !== null &&
        archivedDataStatus === 'archived' &&
        rowStillShown &&
        backActive !== null &&
        restoredDataStatus === 'active',
      detail: `①（点「归档」后）${describeLearningButtons(atArchived)} 落盘=${archivedDataStatus}；左栏那一行仍在=${rowStillShown}；②（点「取消归档」后）${describeLearningButtons(backActive)} 落盘=${restoredDataStatus}`
    })
  } catch (error) {
    record({
      id: 'P8-Z2',
      prd: '修改-4 §8.3',
      name: '学习：归档后**只有「取消归档」**（标记完成 / 标记未完成都不出现）→ 点取消归档回到进行中',
      passed: false,
      detail: `${String(error)}；${diagnostics()}`
    })
  }

  // ---- Z3 计划：任务行 ⋯ 里有「放弃这项」→ 点了之后行上出现 data-state="abandoned" 与标签 ----
  try {
    const taskId = await addMove4Task(`${move4Marker} 放弃样本`)
    await closeFloaters(context)
    await evaluate(context, `window.__verify.clickNav('plan')`)
    await wait(300)
    const flow = await abandonTaskViaUi(taskId)
    await evaluate(context, `window.api.data.flush()`)
    const inData = await planTaskInData(taskId)
    const hasAbandonItem = flow.ids.includes('task-abandon')
    const hasNoRestoreItem = !flow.ids.includes('task-restore')

    record({
      id: 'P8-Z3',
      prd: '修改-4 §8.3',
      name: '计划：任务行 `⋯` 里有「放弃这项」（条件项，没有「恢复为未完成」）→ 点了之后行上 data-state="abandoned" 并出现「已放弃」标签',
      passed:
        flow.opened &&
        hasAbandonItem &&
        hasNoRestoreItem &&
        flow.label === '放弃这项' &&
        flow.clicked &&
        flow.state === 'abandoned' &&
        flow.labelText === '已放弃' &&
        inData !== null &&
        inData['abandoned'] === true &&
        // 互斥：放弃的任务 done 必须是 false（`normalizePlanTask` 强保证）
        inData['done'] === false,
      detail: `⋯ 打开=${flow.opened}；菜单项=[${flow.ids.join(',')}] 有「放弃这项」=${hasAbandonItem}（文案="${flow.label}"） 没有「恢复为未完成」=${hasNoRestoreItem}；点它=${flow.clicked}；行上 data-state="${flow.state}"（期望 abandoned） 标签="${flow.labelText}"（期望 已放弃）；落盘 abandoned=${String(inData?.['abandoned'])} done=${String(inData?.['done'])}`
    })
  } catch (error) {
    record({
      id: 'P8-Z3',
      prd: '修改-4 §8.3',
      name: '计划：任务行 `⋯` 里有「放弃这项」（条件项，没有「恢复为未完成」）→ 点了之后行上 data-state="abandoned" 并出现「已放弃」标签',
      passed: false,
      detail: `${String(error)}；${diagnostics()}`
    })
  }

  // ---- Z4 计划：放弃后页头「逾期 N 项」不再数它；「今天 / 本周」里也不显示它；不自动顺延 ----
  try {
    // ① 先把「今天」视图的页头统计读到稳定（顺延是异步的，不能在它跑完前取基线）
    await closeFloaters(context)
    await evaluate(context, `window.__verify.clickNav('plan')`)
    await wait(400)
    await openPlanList(context, 'today')
    const before = await stableHeaderCounts('today')
    if (before === null) throw new Error('页头「逾期 N 项」一直在变，取不到稳定基线')

    // ② 现场造一条 3 天前没做完的任务：页头「逾期」应当 +1，行落在逾期组里
    const overdueDate = addDaysToKey(todayKey, -3)
    const taskId = await addMove4Task(`${move4Marker} 逾期样本`, { date: overdueDate })
    const counted = await until<PlanHeaderCounts>(
      context,
      planHeaderCountsExpr,
      (value) => value.overdue === before.overdue + 1,
      16,
      250
    )
    const inOverdueGroup = await untilTrue(
      context,
      `!!document.querySelector('[data-testid="group-overdue"] [data-testid="task-row"][data-task-id="${taskId}"]')`,
      16,
      250
    )

    // ③ 走界面放弃它（与 Z3 同一条路；不切模块，所以不会触发顺延）
    const flow = await abandonTaskViaUi(taskId)

    // ④ 回到「今天」：页头「逾期」退回基线，这一行不在任何一组里
    await openPlanList(context, 'today')
    const after = await until<PlanHeaderCounts>(
      context,
      planHeaderCountsExpr,
      (value) => value.overdue === before.overdue,
      16,
      250
    )
    const stillListed = await evaluate<boolean>(
      context,
      `!!document.querySelector('[data-testid="task-row"][data-task-id="${taskId}"]')`
    )

    // ⑤ 「本周」（日历）里也不该出现它：把周视图翻到它所在的那一周再找
    const weekShown = await openPlanCalendar(context, 'week')
    if (!weekShown) throw new Error('周视图没有渲染出来')
    await setNativeValue(context, 'calendar-jump', overdueDate)
    const weekTitleOk = await untilTrue(
      context,
      `((window.__verify.byTestId('calendar-title') || {}).textContent || '').includes(${JSON.stringify(`${monthOfKey(overdueDate)}月`)})`,
      16,
      250
    )
    const cardInWeek = await evaluate<boolean>(
      context,
      `!!document.querySelector('[data-testid="week-card"][data-task-id="${taskId}"]')`
    )

    /**
     * ⑥ 放弃的任务**不会被搬回"今天"**。
     *
     * ⚠️ **这一段的判据在修改 5 轮改写了（不是删掉）** —— 旧口径是
     * "离开再回来会跑一次**自动顺延**，同一天的对照任务必须被搬到今天，
     * 否则'放弃的没被搬走'就是一句空话（判据不能空转）"。
     * 现在自动顺延**没有了**（用户要求改成手动），那条对照任务当然也不会自己动，
     * 于是旧判据的前提消失、整条会假失败。
     *
     * 新口径用的是**同一份防空转的要求**，只是把"自动顺延"换成"手动批量移动"：
     *   - 同一天再放一条**未放弃**的对照任务
     *   - 用页头的「移动某天未完成的…」把这一天搬到"今天"
     *   - ★ 预览数量必须是 **1**（只数出对照任务，放弃的那条被筛掉）
     *   - ★ 对照任务必须**真的**被搬今天（证明这趟搬运确实发生了）
     *   - ★ 放弃的那条必须**仍在原地**、顺延次数不变
     * 这样"放弃的不被搬"才是在"有东西被搬"的前提下验出来的，而不是空转。
     */
    const controlId = await addMove4Task(`${move4Marker} 移动对照样本`, { date: overdueDate })
    await closeFloaters(context)
    const openedMovePanel = await evaluate<boolean>(
      context,
      `window.__verify.click('[data-testid="plan-move-open"]')`
    )
    const movePanelShown = openedMovePanel
      ? (await until<boolean>(
          context,
          `!!window.__verify.byTestId('plan-move-panel')`,
          (value) => value === true,
          16,
          250
        )) !== null
      : false
    if (movePanelShown) {
      // 源 = 这条逾期样本所在的那一天；目标 = 今天
      await setNativeValue(context, 'plan-move-source', overdueDate)
      await setNativeValue(context, 'plan-move-target', todayKey)
    }
    const moveReady = movePanelShown
      ? await until<{ count: number; disabled: boolean }>(
          context,
          `(() => {
             const preview = window.__verify.byTestId('plan-move-preview')
             const confirm = window.__verify.byTestId('plan-move-confirm')
             return {
               count: preview ? Number(preview.getAttribute('data-count')) : -1,
               disabled: confirm ? confirm.disabled === true : true
             }
           })()`,
          (value) => value.count >= 1 && value.disabled === false,
          16,
          250
        )
      : null
    const confirmedMove = moveReady !== null
      ? await evaluate<boolean>(context, `window.__verify.click('[data-testid="plan-move-confirm"]')`)
      : false
    const controlCarried = confirmedMove
      ? (await until<boolean>(
          context,
          `(async () => {
             const alive = await window.api.data.listAlive('plan')
             const hit = alive.find((item) => String(item['id'] || '') === ${JSON.stringify(controlId)})
             return !!hit && String(hit['date'] || '') === ${JSON.stringify(todayKey)}
           })()`,
          (value) => value === true,
          20,
          250
        )) !== null
      : false
    await evaluate(context, `window.api.data.flush()`)
    const afterMove = await planTaskInData(taskId)
    const dateKept = String(afterMove?.['date'] ?? '') === overdueDate
    const abandonedCarriedOver = Number(afterMove?.['carriedOver'] ?? -1)

    record({
      id: 'P8-Z4',
      prd: '修改-4 §8.3（修改 5 轮改写 ⑥）',
      name: '计划：放弃后页头「逾期 N 项」不再数它、「今天 / 本周」都不再显示它，而且**不会被搬回今天**（手动批量移动会跳过它，同一天的未放弃任务照旧能搬走）',
      passed:
        counted !== null &&
        inOverdueGroup &&
        flow.clicked &&
        flow.state === 'abandoned' &&
        after !== null &&
        !stillListed &&
        weekTitleOk &&
        !cardInWeek &&
        moveReady !== null &&
        moveReady.count === 1 &&
        confirmedMove &&
        controlCarried &&
        dateKept &&
        abandonedCarriedOver === 0,
      detail: `逾期基线=${before.overdue}（页头="${before.text}"）；造一条 ${overdueDate} 的未完成任务后逾期=${counted?.overdue ?? '?'}（期望 ${before.overdue + 1}）落在逾期组=${inOverdueGroup}；点「放弃这项」=${flow.clicked}（data-state="${flow.state}"）；放弃后逾期=${after?.overdue ?? '?'}（期望 ${before.overdue}）页头="${after?.text ?? ''}" 今天视图里还能找到它=${stillListed}（期望 false）；周视图翻到 ${overdueDate} 那周=${weekTitleOk} 日历上有它=${cardInWeek}（期望 false）；手动批量移动（${overdueDate} → 今天）时：面板打开=${movePanelShown} 预览数量=${moveReady?.count ?? '?'}（期望 1 —— 放弃那条被筛掉）、同一天的**未放弃对照**任务被搬走=${controlCarried}，而放弃的那一条日期=${String(afterMove?.['date'] ?? '?')}（期望仍是 ${overdueDate}，没被搬走=${dateKept}）顺延次数=${abandonedCarriedOver}（期望 0）`
    })
  } catch (error) {
    record({
      id: 'P8-Z4',
      prd: '修改-4 §8.3（修改 5 轮改写 ⑥）',
      name: '计划：放弃后页头「逾期 N 项」不再数它、「今天 / 本周」都不再显示它，而且**不会被搬回今天**（手动批量移动会跳过它，同一天的未放弃任务照旧能搬走）',
      passed: false,
      detail: `${String(error)}；${diagnostics()}`
    })
  }

  // ---- Z5 计划：「全部」里有「已放弃（N）」分组，能找到它；点「恢复为未完成」能回来 ----
  try {
    const taskId = await addMove4Task(`${move4Marker} 恢复样本`)
    await closeFloaters(context)
    await evaluate(context, `window.__verify.clickNav('plan')`)
    await wait(300)
    const flow = await abandonTaskViaUi(taskId)
    if (flow.state !== 'abandoned') throw new Error(`这一条没被放弃成（data-state="${flow.state}"）`)

    // ① 「全部」里出现「已放弃（N）」分组，这一条就在里面
    const groupShown = await untilTrue(
      context,
      `!!document.querySelector('[data-testid="group-abandoned"]')`,
      16,
      250
    )
    const groupTitle = await evaluate<string>(
      context,
      `(() => {
         const group = document.querySelector('[data-testid="group-abandoned"]')
         const title = group ? group.querySelector('.group__title') : null
         return title ? (title.textContent || '').trim() : ''
       })()`
    )
    const rowInGroup = await untilTrue(
      context,
      `!!document.querySelector('[data-testid="group-abandoned"] [data-testid="task-row"][data-task-id="${taskId}"]')`,
      16,
      250
    )
    const titleMatches = /^已放弃（\d+）$/.test(groupTitle)

    // ② 那一行的 ⋯ 里换成「恢复为未完成」
    const menu = await openTaskRowMenu(taskId)
    const ids = menu?.ids ?? []
    const restoreIndex = ids.indexOf('task-restore')
    const restoreLabel = restoreIndex >= 0 ? (menu?.labels[restoreIndex] ?? '') : ''
    const noAbandonItem = !ids.includes('task-abandon')
    const clicked = menu !== null ? await clickMenuItem(context, 'task-restore') : false

    // ③ 恢复后回到「全部任务」那一组，状态回到未完成
    const backState = clicked
      ? ((await until<string>(context, taskRowStateExpr(taskId), (value) => value === 'pending', 16, 250)) ?? '')
      : ''
    const backInAllGroup = await untilTrue(
      context,
      `!!document.querySelector('[data-testid="group-all"] [data-testid="task-row"][data-task-id="${taskId}"]')`,
      16,
      250
    )
    await evaluate(context, `window.api.data.flush()`)
    const inData = await planTaskInData(taskId)

    record({
      id: 'P8-Z5',
      prd: '修改-4 §8.3',
      name: '计划：「全部」里有「已放弃（N）」分组能查到它；那一行的 `⋯` 是「恢复为未完成」→ 点了回到未完成、回到「全部任务」组',
      passed:
        groupShown &&
        titleMatches &&
        rowInGroup &&
        menu !== null &&
        restoreIndex >= 0 &&
        restoreLabel === '恢复为未完成' &&
        noAbandonItem &&
        clicked &&
        backState === 'pending' &&
        backInAllGroup &&
        inData !== null &&
        inData['abandoned'] === false,
      detail: `「已放弃」分组出现=${groupShown} 标题="${groupTitle}"（形如 已放弃（N）=${titleMatches}）；这一条在这一组里=${rowInGroup}；⋯ 菜单项=[${ids.join(',')}]「恢复为未完成」在第 ${restoreIndex + 1} 项（文案="${restoreLabel}"）没有「放弃这项」=${noAbandonItem}；点它=${clicked}；恢复后 data-state="${backState}"（期望 pending）回到「全部任务」组=${backInAllGroup}；落盘 abandoned=${String(inData?.['abandoned'])}（期望 false）`
    })
  } catch (error) {
    record({
      id: 'P8-Z5',
      prd: '修改-4 §8.3',
      name: '计划：「全部」里有「已放弃（N）」分组能查到它；那一行的 `⋯` 是「恢复为未完成」→ 点了回到未完成、回到「全部任务」组',
      passed: false,
      detail: `${String(error)}；${diagnostics()}`
    })
  }

  // ---- Z6 计划：年视图某月完成率**不因放弃而下降**（★这条最容易做漏） ----
  try {
    // 挑一个"原本空着"的月份造样本：判据才不含别处留下的数据，期望值可以手算
    const targetYear = yearOfKey(todayKey) + 2
    const yearShown = await openPlanCalendar(context, 'year')
    if (!yearShown) throw new Error('年视图没有渲染出来')
    const jumpValue = await setNativeValue(context, 'calendar-jump', `${targetYear}-06-15`)
    if (jumpValue === '__missing__') throw new Error('年视图的日期跳转框找不到')
    const onTargetYear = await untilTrue(
      context,
      `((window.__verify.byTestId('calendar-title') || {}).textContent || '').includes(${JSON.stringify(`${targetYear}年`)})`,
      16,
      250
    )
    const cells = await until<YearMonthCellView[]>(
      context,
      yearCellsExpr,
      (list) => Array.isArray(list) && list.length === 12,
      16,
      250
    )
    const clean = (cells ?? []).find((cell) => cell.count === 0)
    if (clean === undefined) {
      throw new Error(`年视图 ${targetYear} 里找不到空月份，没法手算期望值：${JSON.stringify(cells)}`)
    }

    // 造 3 条同月任务：1 完成 + 1 未完成 + 1 放弃。
    // 分母排除放弃 ⇒ 2 项 / 完成率 50%；若把放弃算进分母则是 3 项 / 33%。
    const monthKey = String(clean.month).padStart(2, '0')
    const dayOf = (day: number): string => `${targetYear}-${monthKey}-${String(day).padStart(2, '0')}`
    await addMove4Task(`${move4Marker} 完成样本`, {
      date: dayOf(5),
      done: true,
      doneAt: `${dayOf(5)}T09:00:00.000Z`
    })
    await addMove4Task(`${move4Marker} 未完成样本`, { date: dayOf(6) })
    await addMove4Task(`${move4Marker} 放弃样本`, { date: dayOf(7), abandoned: true })

    const afterCell = await until<YearMonthCellView>(
      context,
      yearMonthCellExpr(clean.month),
      (cell) => cell !== null && cell.count === 2 && cell.rate === 50,
      16,
      250
    )

    record({
      id: 'P8-Z6',
      prd: '修改-4 §8.3',
      name: '计划：年视图某月完成率**不因放弃而下降**（分母排除放弃：1 完成 + 1 未完成 + 1 放弃 → 2 项 / 50%，不是 3 项 / 33%）',
      passed:
        onTargetYear &&
        clean !== undefined &&
        afterCell !== null &&
        afterCell.countText.includes('2 项') &&
        afterCell.rateText.includes('50%'),
      detail: `年视图切到 ${targetYear} 年=${onTargetYear}；挑出的空月份=${clean.month}（造样本前 ${clean.count} 项 / 完成率 ${clean.rate}%，文字="${clean.countText} ${clean.rateText}"）；造 1 完成 + 1 未完成 + 1 放弃之后：${afterCell?.count ?? '?'} 项 / 完成率 ${afterCell?.rate ?? '?'}%（文字="${afterCell?.countText ?? ''} ${afterCell?.rateText ?? ''}"，期望 2 项 / 50%；若把放弃算进分母会是 3 项 / 33%）`
    })
  } catch (error) {
    record({
      id: 'P8-Z6',
      prd: '修改-4 §8.3',
      name: '计划：年视图某月完成率**不因放弃而下降**（分母排除放弃：1 完成 + 1 未完成 + 1 放弃 → 2 项 / 50%，不是 3 项 / 33%）',
      passed: false,
      detail: `${String(error)}；${diagnostics()}`
    })
  }

  // =========================================================================
  // 修改 5 轮（对应 `修改-5.md`）：取消自动顺延
  //                              + 「把某一天没完成的移到指定的某一天」
  //                              + 手动「未完成」标记（held）
  //
  // 用户原话：
  //   「未完成的任务会不会主动移到今天？这个我要改成手动。」
  //   「未完成要手动标记，标记后就显示未完成就行。」
  //   「我要把**某一天**未完成的移动到**指定的某一天**。」
  //   「我手动标记未完成的不移动（除非我手动移动）。」
  //
  // 编号用 **P8-P**：`A–N`、`R`、`S`、`U–Z` 已被前面几块占用；`O` / `Q` / `T` 也空着，
  // 取 `P` 最直观（与 `修改-5.md` §8.3 的建议一致）。
  //
  // 硬规矩照旧：轮询等待 / 自带前提（每条自己现场造样本）/ 先复位再操作
  // （点入口前先关浮层）/ 受控组件用原生 setter。
  // =========================================================================
  const move5Marker = `${marker} 修改5`

  /**
   * 样本日期统一放在"今年 + 3"那一年，并按趟错开一个月。
   *
   * 为什么不用今天附近的日期：这一块造的是"很久以后/很久以前"的固定日子，
   * 三趟之间、以及与本文件其它块（它们用 +2 年、今天那一周）都不会撞车。
   */
  const move5Year = yearOfKey(todayKey) + 3
  const move5Month = passNumber === 1 ? '04' : '05'
  /** 造一个固定日期键（某年 + 某月 + 第几天） */
  const move5Key = (month: string, day: number): string =>
    `${move5Year}-${month}-${String(day).padStart(2, '0')}`

  /** 造一条计划样本（自带前提：不依赖别处留下的状态），返回 id */
  const addMove5Task = async (
    title: string,
    extra: Record<string, unknown> = {}
  ): Promise<string> =>
    addPlanSample(context, {
      title,
      date: todayKey,
      timeSlot: 'none',
      recurrence: 'none',
      done: false,
      carriedOver: 0,
      doneAt: null,
      ...extra
    })

  /** 一条任务在数据里的形状（这一块只看这几个字段） */
  interface Move5TaskData {
    date: string
    carriedOver: number
    held: boolean
    done: boolean
    abandoned: boolean
  }

  /** 按 id 读盘（不信界面） */
  const move5TaskData = async (taskId: string): Promise<Move5TaskData> => {
    const hit = await planTaskInData(taskId)
    return {
      date: String(hit?.['date'] ?? ''),
      carriedOver: Number(hit?.['carriedOver'] ?? -1),
      held: hit?.['held'] === true,
      done: hit?.['done'] === true,
      abandoned: hit?.['abandoned'] === true
    }
  }

  /** 某条任务行的 `data-held` 读数（行不在就空串） */
  const taskHeldExpr = (taskId: string): string =>
    `(() => {
       const row = document.querySelector('[data-testid="task-row"][data-task-id="${taskId}"]')
       return row ? String(row.getAttribute('data-held') || '') : ''
     })()`

  /** 行上「未完成」标签的文字（没有就是空串） */
  const taskHeldLabelExpr = (taskId: string): string =>
    `(() => {
       const row = document.querySelector('[data-testid="task-row"][data-task-id="${taskId}"]')
       const tag = row ? row.querySelector('[data-testid="plan-task-held"]') : null
       return tag ? (tag.textContent || '').trim() : ''
     })()`

  /** 「移动某天未完成的…」面板的读数 */
  interface Move5Panel {
    open: boolean
    source: string
    target: string
    text: string
    count: number
    confirmDisabled: boolean
    confirmLabel: string
    reason: string
  }

  const move5PanelExpr = `(() => {
    const panel = window.__verify.byTestId('plan-move-panel')
    const source = window.__verify.byTestId('plan-move-source')
    const target = window.__verify.byTestId('plan-move-target')
    const preview = window.__verify.byTestId('plan-move-preview')
    const confirm = window.__verify.byTestId('plan-move-confirm')
    const reason = window.__verify.byTestId('plan-move-reason')
    return {
      open: !!panel,
      source: source ? String(source.value || '') : '',
      target: target ? String(target.value || '') : '',
      text: preview ? (preview.textContent || '').trim() : '',
      count: preview ? Number(preview.getAttribute('data-count')) : -1,
      confirmDisabled: confirm ? confirm.disabled === true : true,
      confirmLabel: confirm ? (confirm.textContent || '').trim() : '',
      reason: reason ? (reason.textContent || '').trim() : ''
    }
  })()`

  /** 打开面板（先把浮层关掉再点入口 —— 验收台硬规矩第 3 条） */
  const openMove5Panel = async (): Promise<Move5Panel | null> => {
    await closeFloaters(context)
    await evaluate(context, `window.__verify.clickNav('plan')`)
    await wait(300)
    const clicked = await evaluate<boolean>(
      context,
      `window.__verify.click('[data-testid="plan-move-open"]')`
    )
    if (!clicked) return null
    return until<Move5Panel>(
      context,
      move5PanelExpr,
      (value) => value.open === true,
      16,
      250
    )
  }

  /** 写源 / 目标日期（受控输入框用原生 setter），并等预览跟着变 */
  const setMove5Dates = async (source: string, target: string): Promise<Move5Panel | null> => {
    const wroteSource = await setNativeValue(context, 'plan-move-source', source)
    const wroteTarget = await setNativeValue(context, 'plan-move-target', target)
    if (wroteSource === '__missing__' || wroteTarget === '__missing__') return null
    return until<Move5Panel>(
      context,
      move5PanelExpr,
      (value) => value.source === source && value.target === target,
      16,
      250
    )
  }

  /** 点确认，并等面板真的关掉（逐条 patch + 落盘是异步的） */
  const confirmMove5 = async (): Promise<boolean> => {
    const clicked = await evaluate<boolean>(
      context,
      `window.__verify.click('[data-testid="plan-move-confirm"]')`
    )
    if (!clicked) return false
    return untilTrue(context, `!window.__verify.byTestId('plan-move-panel')`, 24, 250)
  }

  /** 走界面把一条任务标成 / 取消「未完成」（菜单项 task-hold / task-unhold） */
  const toggleHoldViaUi = async (
    taskId: string,
    expected: boolean
  ): Promise<{ opened: boolean; ids: string[]; clicked: boolean; heldAttr: string; labelText: string }> => {
    await openPlanList(context, 'all')
    const shown = await untilTrue(context, planRowExpr(taskId), 16, 250)
    if (!shown) return { opened: false, ids: [], clicked: false, heldAttr: '', labelText: '' }
    const menu = await openTaskRowMenu(taskId)
    const ids = menu?.ids ?? []
    const wanted = expected ? 'task-hold' : 'task-unhold'
    const clicked = ids.includes(wanted) ? await clickMenuItem(context, wanted) : false
    const heldAttr = clicked
      ? ((await until<string>(
          context,
          taskHeldExpr(taskId),
          (value) => value === (expected ? 'true' : 'false'),
          16,
          250
        )) ?? '')
      : ''
    const labelText = clicked ? await evaluate<string>(context, taskHeldLabelExpr(taskId)) : ''
    return { opened: menu !== null, ids, clicked, heldAttr, labelText }
  }

  // ---- P1 打开计划页**不再自动顺延**（★核心）----
  try {
    await closeFloaters(context)
    await evaluate(context, `window.__verify.clickNav('plan')`)
    await wait(300)

    // 自带前提：现场造一条 3 天前没做完的任务（旧逻辑会把它一次搬到今天）
    const staleKey = addDaysToKey(todayKey, -3)
    const taskId = await addMove5Task(`${move5Marker} 不再顺延样本`, { date: staleKey })

    /**
     * 反复进出计划页（旧逻辑正是靠"页面挂载"这一下把它搬走的），
     * 每一轮里**取样观察 2 秒**：只要它中途动过一次就算失败。
     * 这是轮询取样，不是"赌一次固定延时"（硬规矩第 1 条）。
     */
    let movedAtAnyPoint = false
    let lastDate = ''
    let lastCarried = -1
    for (let round = 0; round < 3; round += 1) {
      await evaluate(context, `window.__verify.clickNav('home')`)
      await wait(250)
      await evaluate(context, `window.__verify.clickNav('plan')`)
      for (let sample = 0; sample < 8; sample += 1) {
        await wait(250)
        const data = await move5TaskData(taskId)
        lastDate = data.date
        lastCarried = data.carriedOver
        if (data.date !== staleKey || data.carriedOver !== 0) {
          movedAtAnyPoint = true
          break
        }
      }
      if (movedAtAnyPoint) break
    }
    await evaluate(context, `window.api.data.flush()`)

    record({
      id: 'P8-P1',
      prd: '修改-5 §8.3',
      name: '计划：**打开计划页不再自动顺延** —— 3 天前的未完成任务进出计划页三轮后，日期仍是 3 天前、顺延次数仍是 0',
      passed: !movedAtAnyPoint && lastDate === staleKey && lastCarried === 0,
      detail: `样本日期=${staleKey}（今天=${todayKey}）；进出计划页 3 轮（每轮取样 2 秒）后：日期=${lastDate || '（没读到）'} 顺延次数=${lastCarried}；中途被搬走过=${movedAtAnyPoint}`
    })
  } catch (error) {
    record({
      id: 'P8-P1',
      prd: '修改-5 §8.3',
      name: '计划：**打开计划页不再自动顺延** —— 3 天前的未完成任务进出计划页三轮后，日期仍是 3 天前、顺延次数仍是 0',
      passed: false,
      detail: `${String(error)}；${diagnostics()}`
    })
  }

  // ---- P2 页头有「移动某天未完成的…」；打开后源与目标默认都是今天，且因"同一天"确认按钮禁用 ----
  try {
    await closeFloaters(context)
    await evaluate(context, `window.__verify.clickNav('plan')`)
    await wait(300)

    // ① 入口**任何时候都在**（它按日期操作，与"今天有没有逾期"无关）
    const entry = await until<{ text: string; alwaysVisible: boolean }>(
      context,
      `(() => {
         const el = window.__verify.byTestId('plan-move-open')
         return { text: el ? (el.textContent || '').trim() : '', alwaysVisible: !!el }
       })()`,
      (value) => value.alwaysVisible === true,
      12,
      250
    )

    // ② 打开面板：源与目标默认都是今天 → 同一天 → 确认按钮禁用 + 说明原因
    const panel = await openMove5Panel()
    const defaultSource = panel?.source ?? ''
    const defaultTarget = panel?.target ?? ''
    const confirmDisabled = panel?.confirmDisabled === true
    const reason = panel?.reason ?? ''
    const confirmLabel = panel?.confirmLabel ?? ''
    const previewText = panel?.text ?? ''
    // 按钮上的数字跟着预览走（今天本来就有别的任务，所以数字不硬写成 0）
    const labelFollowsPreview =
      /^移动这 \d+ 项$/.test(confirmLabel) && confirmLabel === `移动这 ${panel?.count ?? -1} 项`
    await closeFloaters(context)

    record({
      id: 'P8-P2',
      prd: '修改-5 §8.3',
      name: '计划：页头有「移动某天未完成的…」；打开后**源与目标默认都是今天**，且因"源和目标不能是同一天"确认按钮**禁用**',
      passed:
        entry !== null &&
        panel !== null &&
        defaultSource === todayKey &&
        defaultTarget === todayKey &&
        confirmDisabled &&
        reason === '源和目标不能是同一天' &&
        labelFollowsPreview &&
        previewText.includes(todayKey) &&
        previewText.includes(`${panel?.count ?? -1} 项未完成任务可移动`),
      detail: `入口文案="${entry?.text ?? '（没找到 plan-move-open）'}" 一直在=${entry !== null}；面板打开=${panel !== null} 源默认="${defaultSource}" 目标默认="${defaultTarget}"（今天=${todayKey}）；确认按钮禁用=${confirmDisabled} 原因="${reason}" 按钮文案="${confirmLabel}"（跟着预览走=${labelFollowsPreview}）；预览="${previewText}"`
    })
  } catch (error) {
    record({
      id: 'P8-P2',
      prd: '修改-5 §8.3',
      name: '计划：页头有「移动某天未完成的…」；打开后**源与目标默认都是今天**，且因"源和目标不能是同一天"确认按钮**禁用**',
      passed: false,
      detail: `${String(error)}；${diagnostics()}`
    })
  }

  // ---- P3 造 3 条未完成 + 1 条已完成 → 预览显示 3 → 只有那 3 条换了日期 ----
  try {
    const sourceKey = move5Key(move5Month, 15)
    const targetKey = move5Key('07', passNumber === 1 ? 20 : 21)
    const neighborKey = move5Key(move5Month, 16)
    const pendingIds: string[] = []
    for (let index = 1; index <= 3; index += 1) {
      pendingIds.push(
        await addMove5Task(`${move5Marker} 待搬 ${index}（${passNumber}趟）`, { date: sourceKey })
      )
    }
    const doneId = await addMove5Task(`${move5Marker} 已完成样本（${passNumber}趟）`, {
      date: sourceKey,
      done: true,
      doneAt: `${sourceKey}T09:00:00.000Z`
    })
    const neighborId = await addMove5Task(`${move5Marker} 相邻日期样本（${passNumber}趟）`, {
      date: neighborKey
    })

    const panel = await openMove5Panel()
    const dated = panel !== null ? await setMove5Dates(sourceKey, targetKey) : null
    const previewCount = dated?.count ?? -1
    const previewText = dated?.text ?? ''
    const label = dated?.confirmLabel ?? ''
    const enabled = dated !== null && dated.confirmDisabled === false
    const confirmed = enabled ? await confirmMove5() : false

    // 轮询到 3 条都落到目标日期
    const movedAll = confirmed
      ? await untilTrue(
          context,
          `(async () => {
             const alive = await window.api.data.listAlive('plan')
             const target = ${JSON.stringify(targetKey)}
             const ids = ${JSON.stringify(pendingIds)}
             return ids.every((id) => {
               const hit = alive.find((item) => String(item['id'] || '') === id)
               return !!hit && String(hit['date'] || '') === target && Number(hit['carriedOver'] || 0) === 1
             })
           })()`,
          20,
          250
        )
      : false
    await evaluate(context, `window.api.data.flush()`)

    const afterPending = await Promise.all(pendingIds.map((id) => move5TaskData(id)))
    const afterDone = await move5TaskData(doneId)
    const afterNeighbor = await move5TaskData(neighborId)
    const notice = await evaluate<string>(
      context,
      `((window.__verify.byTestId('carryover-notice') || {}).textContent || '').trim()`
    )
    await closeFloaters(context)

    record({
      id: 'P8-P3',
      prd: '修改-5 §8.3',
      name: `计划：${sourceKey} 造 3 条未完成 + 1 条已完成 → 预览显示 **3** → 移到 ${targetKey} 后**只有那 3 条**换了日期，已完成那条与相邻日期那条都没动`,
      passed:
        panel !== null &&
        previewCount === 3 &&
        label === '移动这 3 项' &&
        enabled &&
        confirmed &&
        movedAll &&
        afterPending.every((item) => item.date === targetKey && item.carriedOver === 1) &&
        afterDone.date === sourceKey &&
        afterNeighbor.date === neighborKey &&
        notice.includes(sourceKey) &&
        notice.includes(targetKey),
      detail: `源=${sourceKey} 目标=${targetKey}；预览="${previewText}"（数量=${previewCount}，期望 3）按钮文案="${label}" 可用=${enabled}；点确认=${confirmed} 轮询到 3 条都搬走=${movedAll}；搬完后 3 条日期=[${afterPending.map((item) => item.date).join(',')}] 顺延次数=[${afterPending.map((item) => item.carriedOver).join(',')}]（期望全为 ${targetKey} / 1）；已完成那条日期=${afterDone.date}（期望仍为 ${sourceKey}）；相邻日期 ${neighborKey} 那条日期=${afterNeighbor.date}（期望不动）；提示="${notice}"`
    })
  } catch (error) {
    record({
      id: 'P8-P3',
      prd: '修改-5 §8.3',
      name: '计划：某天造 3 条未完成 + 1 条已完成 → 预览显示 3 → 移到目标日期后只有那 3 条换了日期，已完成那条与相邻日期那条都没动',
      passed: false,
      detail: `${String(error)}；${diagnostics()}`
    })
  }

  // ---- P4 **钉住的任务不被批量移动**（★核心）----
  try {
    const sourceKey = move5Key(move5Month, 18)
    const targetKey = move5Key('08', passNumber === 1 ? 20 : 21)
    const heldId = await addMove5Task(`${move5Marker} 钉住样本（${passNumber}趟）`, { date: sourceKey })
    const plainId = await addMove5Task(`${move5Marker} 可搬样本（${passNumber}趟）`, { date: sourceKey })

    // 走界面把其中 1 条标成「未完成」（与 P6 同一条路：菜单里的 task-hold）
    const flow = await toggleHoldViaUi(heldId, true)
    const heldInData = await move5TaskData(heldId)

    // 重开面板：预览应当变成 2
    const panel = await openMove5Panel()
    const dated = panel !== null ? await setMove5Dates(sourceKey, targetKey) : null
    const previewCount = dated?.count ?? -1
    const confirmed = dated !== null && dated.confirmDisabled === false ? await confirmMove5() : false

    const moved = confirmed
      ? await until<Move5TaskData>(
          context,
          `(async () => {
             const alive = await window.api.data.listAlive('plan')
             const hit = alive.find((item) => String(item['id'] || '') === ${JSON.stringify(plainId)})
             return {
               date: hit ? String(hit['date'] || '') : '',
               carriedOver: hit ? Number(hit['carriedOver'] || 0) : -1,
               held: false,
               done: false,
               abandoned: false
             }
           })()`,
          (value) => value.date === targetKey,
          20,
          250
        )
      : null
    await evaluate(context, `window.api.data.flush()`)
    const heldAfter = await move5TaskData(heldId)
    await closeFloaters(context)

    record({
      id: 'P8-P4',
      prd: '修改-5 §8.3',
      name: '计划：**钉住（手动标「未完成」）的任务不被批量移动** —— 2 条里标 1 条后预览变成 1，移动后它仍在源日期（★核心）',
      passed:
        flow.opened &&
        flow.clicked &&
        flow.heldAttr === 'true' &&
        heldInData.held &&
        panel !== null &&
        previewCount === 1 &&
        confirmed &&
        moved !== null &&
        heldAfter.date === sourceKey,
      detail: `源=${sourceKey} 目标=${targetKey}；⋯ 打开=${flow.opened} 菜单项=[${flow.ids.join(',')}] 点了标记=${flow.clicked} 行上 data-held="${flow.heldAttr}"；落盘 held=${heldInData.held}；重开面板预览数量=${previewCount}（期望 1，因为 2 条里有 1 条被钉住）；点确认=${confirmed}；可搬那条日期=${moved?.date ?? '?'}（期望 ${targetKey}） 钉住那条日期=${heldAfter.date}（期望仍在 ${sourceKey}）`
    })
  } catch (error) {
    record({
      id: 'P8-P4',
      prd: '修改-5 §8.3',
      name: '计划：**钉住（手动标「未完成」）的任务不被批量移动** —— 2 条里标 1 条后预览变成 1，移动后它仍在源日期（★核心）',
      passed: false,
      detail: `${String(error)}；${diagnostics()}`
    })
  }

  // ---- P5 逐条「移动到指定日期…」对**钉住的任务也生效** ----
  try {
    const sourceKey = move5Key(move5Month, 28)
    const targetKey = move5Key('09', passNumber === 1 ? 20 : 21)
    const taskId = await addMove5Task(`${move5Marker} 逐条移动样本（${passNumber}趟）`, {
      date: sourceKey
    })
    const holdFlow = await toggleHoldViaUi(taskId, true)
    const heldBefore = await move5TaskData(taskId)

    // 在「全部」里再打开它的 ⋯，点「移动到指定日期…」
    const rowShown = await untilTrue(context, planRowExpr(taskId), 16, 250)
    const menu = rowShown ? await openTaskRowMenu(taskId) : null
    const ids = menu?.ids ?? []
    const clicked = ids.includes('task-move-to') ? await clickMenuItem(context, 'task-move-to') : false
    const drawerShown = clicked
      ? await untilTrue(context, `!!window.__verify.byTestId('task-date-move-input')`, 16, 250)
      : false
    const wroteDate = drawerShown
      ? await setNativeValue(context, 'task-date-move-input', targetKey)
      : '__missing__'
    const submitted =
      wroteDate === targetKey
        ? await evaluate<boolean>(
            context,
            `window.__verify.click('[data-testid="task-date-move-form-submit"]')`
          )
        : false
    const moved = submitted
      ? await until<Move5TaskData>(
          context,
          `(async () => {
             const alive = await window.api.data.listAlive('plan')
             const hit = alive.find((item) => String(item['id'] || '') === ${JSON.stringify(taskId)})
             return {
               date: hit ? String(hit['date'] || '') : '',
               carriedOver: hit ? Number(hit['carriedOver'] || 0) : -1,
               held: hit ? hit['held'] === true : false,
               done: false,
               abandoned: false
             }
           })()`,
          (value) => value.date === targetKey && value.carriedOver === 1,
          20,
          250
        )
      : null
    await evaluate(context, `window.api.data.flush()`)
    await closeFloaters(context)

    record({
      id: 'P8-P5',
      prd: '修改-5 §8.3',
      name: `计划：逐条「移动到指定日期…」对**钉住的任务也生效**（${sourceKey} → ${targetKey}，顺延次数 +1）`,
      passed:
        holdFlow.clicked &&
        heldBefore.held &&
        menu !== null &&
        ids.includes('task-move-to') &&
        clicked &&
        drawerShown &&
        wroteDate === targetKey &&
        submitted &&
        moved !== null &&
        moved.held,
      detail: `先把样本钉住=${holdFlow.clicked}（落盘 held=${heldBefore.held}）；⋯ 菜单项=[${ids.join(',')}] 有「移动到指定日期…」=${ids.includes('task-move-to')} 点了=${clicked}；日期抽屉出现=${drawerShown} 写入日期="${wroteDate}" 提交=${submitted}；搬完后日期=${moved?.date ?? '?'}（期望 ${targetKey}） 顺延次数=${moved?.carriedOver ?? '?'}（期望 1） 仍然是钉住的=${moved?.held ?? '?'}（期望 true）`
    })
  } catch (error) {
    record({
      id: 'P8-P5',
      prd: '修改-5 §8.3',
      name: '计划：逐条「移动到指定日期…」对**钉住的任务也生效**',
      passed: false,
      detail: `${String(error)}；${diagnostics()}`
    })
  }

  // ---- P6 行上出现「未完成」标签；「取消未完成标记」后标签消失、又能被批量移动 ----
  try {
    const sourceKey = move5Key(move5Month, 22)
    const targetKey = move5Key('10', passNumber === 1 ? 20 : 21)
    const taskId = await addMove5Task(`${move5Marker} 标签样本（${passNumber}趟）`, { date: sourceKey })
    // 对照组：同一天再放一条「已放弃」的，用来证明两种标签**视觉上能区分**
    const abandonedId = await addMove5Task(`${move5Marker} 放弃对照样本（${passNumber}趟）`, {
      date: sourceKey,
      abandoned: true
    })

    const holdFlow = await toggleHoldViaUi(taskId, true)
    const labelText = await evaluate<string>(context, taskHeldLabelExpr(taskId))
    const heldAttr = await evaluate<string>(context, taskHeldExpr(taskId))

    /** 两个标签的计算样式（描边样式 / 颜色各取一份） */
    const styles = await evaluate<{
      held: { text: string; borderStyle: string; color: string }
      abandoned: { text: string; borderStyle: string; color: string }
    }>(
      context,
      `(() => {
         const read = (taskId, testId) => {
           const row = document.querySelector('[data-testid="task-row"][data-task-id="' + taskId + '"]')
           const tag = row ? row.querySelector('[data-testid="' + testId + '"]') : null
           if (!tag) return { text: '', borderStyle: '', color: '' }
           const style = getComputedStyle(tag)
           return {
             text: (tag.textContent || '').trim(),
             borderStyle: style.borderStyle || '',
             color: style.color || ''
           }
         }
         return {
           held: read(${JSON.stringify(taskId)}, 'plan-task-held'),
           abandoned: read(${JSON.stringify(abandonedId)}, 'task-abandoned-label')
         }
       })()`
    )

    // 取消标记 → 标签消失，而且它又能被批量移动了
    const unholdFlow = await toggleHoldViaUi(taskId, false)
    const labelAfter = await evaluate<string>(context, taskHeldLabelExpr(taskId))
    const dataAfter = await move5TaskData(taskId)

    const panel = await openMove5Panel()
    const dated = panel !== null ? await setMove5Dates(sourceKey, targetKey) : null
    const previewCount = dated?.count ?? -1
    const confirmed = dated !== null && dated.confirmDisabled === false ? await confirmMove5() : false
    const movedAfter = confirmed
      ? await until<Move5TaskData>(
          context,
          `(async () => {
             const alive = await window.api.data.listAlive('plan')
             const hit = alive.find((item) => String(item['id'] || '') === ${JSON.stringify(taskId)})
             return {
               date: hit ? String(hit['date'] || '') : '',
               carriedOver: hit ? Number(hit['carriedOver'] || 0) : -1,
               held: hit ? hit['held'] === true : false,
               done: false,
               abandoned: false
             }
           })()`,
          (value) => value.date === targetKey,
          20,
          250
        )
      : null
    await evaluate(context, `window.api.data.flush()`)
    const abandonedAfter = await move5TaskData(abandonedId)
    await closeFloaters(context)

    record({
      id: 'P8-P6',
      prd: '修改-5 §8.3',
      name: '计划：钉住的任务行上出现「未完成」标签（`plan-task-held`），与「已放弃」**视觉可区分**；点「取消未完成标记」后标签消失、**又能被批量移动**',
      passed:
        holdFlow.clicked &&
        labelText === '未完成' &&
        heldAttr === 'true' &&
        styles.held.borderStyle === 'solid' &&
        styles.abandoned.borderStyle === 'dashed' &&
        unholdFlow.clicked &&
        labelAfter === '' &&
        dataAfter.held === false &&
        previewCount === 1 &&
        confirmed &&
        movedAfter !== null &&
        abandonedAfter.date === sourceKey,
      detail: `标签文字="${labelText}"（期望 未完成） data-held="${heldAttr}"；与「已放弃」对比：held 标签描边=${styles.held.borderStyle} 颜色=${styles.held.color}／abandoned 标签描边=${styles.abandoned.borderStyle} 颜色=${styles.abandoned.color}（期望 solid ≠ dashed）；点「取消未完成标记」=${unholdFlow.clicked} 之后标签="${labelAfter}"（期望空） 落盘 held=${dataAfter.held}（期望 false）；取消后重开面板预览数量=${previewCount}（期望 1） 点确认=${confirmed} 搬完日期=${movedAfter?.date ?? '?'}（期望 ${targetKey}）；同一天的放弃对照样本仍在源日期=${abandonedAfter.date === sourceKey}`
    })
  } catch (error) {
    record({
      id: 'P8-P6',
      prd: '修改-5 §8.3',
      name: '计划：钉住的任务行上出现「未完成」标签（plan-task-held），与「已放弃」视觉可区分；点「取消未完成标记」后标签消失、又能被批量移动',
      passed: false,
      detail: `${String(error)}；${diagnostics()}`
    })
  }

  // ---- P7 页头「逾期 N 项」**不包含**被标记「未完成」的任务（★修改 7 轮反转）----
  //
  // 旧口径（`修改-5.md` §四）：页头把钉住的也数进去（"钉住 ≠ 放弃"）。
  // 新口径（`修改-7.md` §三）：钉住的**不算逾期**，但
  //   ① 仍然在列表里（「全部」视图的「已标未完成」组，行上有 `plan-task-held`）
  //   ② 导航红点**不因它亮起**（但普通逾期照样亮）
  //   ③ 完成率分母**仍然算它**
  //
  // 这是**反转改写**，不是删除：判据从 2 条（数进去 + 在逾期组）变成下面 6 个子条件
  // （页头只 +1 / 不在逾期组 / 在「已标未完成」组 / 红点能力还在 / 内联提示数字跟着页头 /
  //  年视图本月格子与"含 held 的分母"一致）。判断没有变松，覆盖面比原来更大。
  try {
    await setOverdueHintDismissedOn(context, addDaysToKey(todayKey, -1))
    await closeFloaters(context)
    await evaluate(context, `window.__verify.clickNav('plan')`)
    await wait(400)
    await openPlanList(context, 'today')
    const before = await stableHeaderCounts('today')
    if (before === null) throw new Error('页头「逾期 N 项」一直在变，取不到稳定基线')

    // 现场造两条 3 天前的未完成任务：一条普通、一条**标了「未完成」**
    const overdueKey = addDaysToKey(todayKey, -3)
    const plainId = await addMove5Task(`${move5Marker} 逾期普通样本（${passNumber}趟）`, {
      date: overdueKey
    })
    const heldId = await addMove5Task(`${move5Marker} 逾期已标记样本（${passNumber}趟）`, {
      date: overdueKey,
      held: true
    })

    // ① 页头只 +1（旧口径是 +2）
    const counted = await until<PlanHeaderCounts>(
      context,
      planHeaderCountsExpr,
      (value) => value.view === 'today' && value.overdue === before.overdue + 1,
      20,
      250
    )
    const headerText = await evaluate<string>(
      context,
      `((window.__verify.byTestId('page-description') || {}).textContent || '').trim()`
    )
    // ② 普通那条在「逾期」组；标了「未完成」的**不在**
    //    （先等普通那条出现 —— 说明这一轮重新渲染已经落定，再去断言"不在"才不会读到旧 DOM）
    const plainInOverdue = await untilTrue(
      context,
      `!!document.querySelector('[data-testid="group-overdue"] [data-testid="task-row"][data-task-id="${plainId}"]')`,
      16,
      250
    )
    const heldInOverdue = await evaluate<boolean>(
      context,
      `!!document.querySelector('[data-testid="group-overdue"] [data-testid="task-row"][data-task-id="${heldId}"]')`
    )
    // ③ 「全部」视图：「已标未完成」组里有它、行上有标签；「全部任务」组里**没有**它（不许一屏两见）
    await openPlanList(context, 'all')
    const heldInHeldGroup = await untilTrue(
      context,
      `!!document.querySelector('[data-testid="group-held"] [data-testid="task-row"][data-task-id="${heldId}"]')`,
      16,
      250
    )
    const heldGroupTitle = await evaluate<string>(
      context,
      `(() => {
         const group = window.__verify.byTestId('group-held')
         const title = group ? group.querySelector('.group__title') : null
         return title ? (title.textContent || '').trim() : ''
       })()`
    )
    const heldTagText = await evaluate<string>(context, taskHeldLabelExpr(heldId))
    const heldInAllGroup = await evaluate<boolean>(
      context,
      `!!document.querySelector('[data-testid="group-all"] [data-testid="task-row"][data-task-id="${heldId}"]')`
    )
    // ④ 导航红点仍然因普通逾期亮着（红点能力没被顺手关掉）
    const dotShown = await untilTrue(
      context,
      `!!document.querySelector('[data-nav-id="plan"] .nav__dot')`,
      12,
      250
    )
    // ⑤ 切回「今天」：工具栏里那条内联提示仍然在，且数字 = 页头数字（排除 held 后同一个数）
    await openPlanList(context, 'today')
    const hintShown = await untilTrue(context, `!!window.__verify.byTestId('plan-overdue-inline')`, 16, 250)
    const hint = await evaluate<{
      count: number
      text: string
      inToolbar: boolean
      hasEntry: boolean
      hasDismiss: boolean
      oldHintGone: boolean
    }>(
      context,
      `(() => {
         const inline = window.__verify.byTestId('plan-overdue-inline')
         return {
           count: inline ? Number(inline.getAttribute('data-count')) : -1,
           text: inline ? (inline.textContent || '').trim() : '',
           inToolbar: !!document.querySelector('.page__toolbar [data-testid="plan-overdue-inline"]'),
           hasEntry: !!document.querySelector('[data-testid="plan-overdue-inline"] [data-testid="plan-overdue-move-open"]'),
           hasDismiss: !!document.querySelector('[data-testid="plan-overdue-inline"] [data-testid="plan-overdue-dismiss"]'),
           oldHintGone: !document.querySelector('[data-testid="plan-overdue-hint"]')
         }
       })()`
    )
    // ⑥ 完成率分母**仍然算它**：年视图本月格子必须与"数据里含 held 的口径"一致
    //    （把已放弃的先滤掉，其余交给 `expectedMonthStats`；它不知道 held，因此 held 天然留在分母里）
    const yearShown = await openPlanCalendar(context, 'year')
    const jumped = yearShown ? await setNativeValue(context, 'calendar-jump', todayKey) : '__missing__'
    const thisMonth = monthOfKey(todayKey)
    const cell =
      jumped === todayKey
        ? await until<YearMonthCellView>(
            context,
            yearMonthCellExpr(thisMonth),
            (value) => value !== null && value.month === thisMonth,
            16,
            250
          )
        : null
    const statRecords = (await planRecords(context)).filter((record) => record['abandoned'] !== true)
    const expectedMonth = expectedMonthStats(statRecords, yearOfKey(todayKey), thisMonth)
    await openPlanList(context, 'today')

    record({
      id: 'P8-P7',
      prd: '修改-7 §八.2（反转改写自 修改-5 §8.3）',
      name: '计划：页头「逾期 N 项」**不包含**被标记「未完成」的任务——但它**仍然在列表里**（「全部」的「已标未完成」组 + `plan-task-held` 标签）、**不点亮导航红点**（普通逾期照旧点亮）、**仍然算完成率分母**',
      passed:
        counted !== null &&
        headerText.includes(`逾期 ${before.overdue + 1} 项`) &&
        plainInOverdue &&
        heldInOverdue === false &&
        heldInHeldGroup &&
        // 标题右侧还有一句「不计入逾期」小灰字，所以只锚定开头
        /^已标未完成（\d+）/.test(heldGroupTitle) &&
        heldTagText === '未完成' &&
        heldInAllGroup === false &&
        dotShown &&
        hintShown &&
        hint.count === counted?.overdue &&
        hint.inToolbar &&
        hint.hasEntry &&
        hint.hasDismiss &&
        hint.oldHintGone &&
        cell !== null &&
        cell.count === expectedMonth.total &&
        cell.rate === expectedMonth.rate,
      detail: `逾期基线=${before.overdue}（页头="${before.text}"）；造 2 条 ${overdueKey} 的未完成任务（1 普通 + 1 已标未完成）后逾期=${counted?.overdue ?? '?'}（期望 ${before.overdue + 1}，**不是 +2**）页头="${headerText}"；普通那条在「逾期」组=${plainInOverdue} 已标记那条在「逾期」组=${heldInOverdue}（期望 false）；「全部」里它落在「已标未完成（N）」组=${heldInHeldGroup}（组标题="${heldGroupTitle}"）行上标签="${heldTagText}"（期望 未完成）它**不在**「全部任务」组=${heldInAllGroup === false}（期望 true）；导航红点亮着=${dotShown}（普通逾期在，红点能力没关掉）；工具栏内联提示=${hintShown}（在工具栏那排里=${hint.inToolbar}）数字=${hint.count}（页头=${counted?.overdue ?? '?'}）入口=${hint.hasEntry} × 关闭=${hint.hasDismiss} 旧块级黄条已删=${hint.oldHintGone}；年视图本月（${thisMonth} 月）格子 ${cell?.count ?? '?'} 项 / 完成率 ${cell?.rate ?? '?'}%（按数据算 = ${expectedMonth.total} 项 / ${expectedMonth.rate}% —— **含被标记的那条**，说明分母没被排掉）`
    })
  } catch (error) {
    record({
      id: 'P8-P7',
      prd: '修改-7 §八.2（反转改写自 修改-5 §8.3）',
      name: '计划：页头「逾期 N 项」不包含被标记「未完成」的任务（但它仍然看得见、红点不因它亮、完成率分母仍算它）',
      passed: false,
      detail: `${String(error)}；${diagnostics()}`
    })
  }

  // ---- P8 放弃 / 重复 仍然不被批量移动；**相邻日期**的任务不受影响 ----
  try {
    const sourceKey = move5Key(move5Month, 25)
    const prevKey = move5Key(move5Month, 24)
    const nextKey = move5Key(move5Month, 26)
    const targetKey = move5Key('11', passNumber === 1 ? 20 : 21)
    const plainId = await addMove5Task(`${move5Marker} P8 可搬（${passNumber}趟）`, { date: sourceKey })
    const abandonedId = await addMove5Task(`${move5Marker} P8 放弃（${passNumber}趟）`, {
      date: sourceKey,
      abandoned: true
    })
    const recurringId = await addMove5Task(`${move5Marker} P8 重复（${passNumber}趟）`, {
      date: sourceKey,
      recurrence: 'daily'
    })
    const prevId = await addMove5Task(`${move5Marker} P8 前一天（${passNumber}趟）`, { date: prevKey })
    const nextId = await addMove5Task(`${move5Marker} P8 后一天（${passNumber}趟）`, { date: nextKey })

    const panel = await openMove5Panel()
    const dated = panel !== null ? await setMove5Dates(sourceKey, targetKey) : null
    const previewCount = dated?.count ?? -1
    const confirmed = dated !== null && dated.confirmDisabled === false ? await confirmMove5() : false
    const moved = confirmed
      ? await until<Move5TaskData>(
          context,
          `(async () => {
             const alive = await window.api.data.listAlive('plan')
             const hit = alive.find((item) => String(item['id'] || '') === ${JSON.stringify(plainId)})
             return {
               date: hit ? String(hit['date'] || '') : '',
               carriedOver: hit ? Number(hit['carriedOver'] || 0) : -1,
               held: false,
               done: false,
               abandoned: false
             }
           })()`,
          (value) => value.date === targetKey,
          20,
          250
        )
      : null
    await evaluate(context, `window.api.data.flush()`)
    const abandonedAfter = await move5TaskData(abandonedId)
    const recurringAfter = await move5TaskData(recurringId)
    const prevAfter = await move5TaskData(prevId)
    const nextAfter = await move5TaskData(nextId)
    await closeFloaters(context)

    record({
      id: 'P8-P8',
      prd: '修改-5 §8.3',
      name: `计划：放弃 / 重复 仍然不被批量移动；**相邻日期**（${prevKey} / ${nextKey}）的任务一条都没动`,
      passed:
        panel !== null &&
        previewCount === 1 &&
        confirmed &&
        moved !== null &&
        abandonedAfter.date === sourceKey &&
        recurringAfter.date === sourceKey &&
        prevAfter.date === prevKey &&
        nextAfter.date === nextKey &&
        abandonedAfter.carriedOver === 0 &&
        recurringAfter.carriedOver === 0,
      detail: `源=${sourceKey} 目标=${targetKey}；面板上预览数量=${previewCount}（期望 1：这一天只有 1 条能搬）；点确认=${confirmed} 可搬那条日期=${moved?.date ?? '?'}（期望 ${targetKey}）；放弃那条日期=${abandonedAfter.date}（期望 ${sourceKey}） 重复那条日期=${recurringAfter.date}（期望 ${sourceKey}）；前一天 ${prevKey} 那条=${prevAfter.date} 后一天 ${nextKey} 那条=${nextAfter.date}（期望都不动）`
    })
  } catch (error) {
    record({
      id: 'P8-P8',
      prd: '修改-5 §8.3',
      name: '计划：放弃 / 重复 仍然不被批量移动；相邻日期的任务一条都没动',
      passed: false,
      detail: `${String(error)}；${diagnostics()}`
    })
  }

  // =========================================================================
  // 修改 6 轮（对应 `修改-6.md`）：
  //   ① 首页「今日计划」**只显示今天的**（逾期不再混进来）
  //   ② 逾期提醒挪进计划页工具栏 + **当天可关闭**（第二天自动回来）
  //
  // 用户原话：
  //   「今日计划不要显示昨天的计划（未移动），这个提醒放在上面按个框框里，
  //     然后可以关闭。」
  //
  // 编号用 **P8-Q**：`A–N`、`R`、`S`、`U–Z` 已被前面几块占用；`P` 上一轮用了，
  // `O` / `Q` / `T` 还空着（与 `修改-6.md` §8.3 的建议一致）。
  //
  // 硬规矩照旧：轮询等待 / 自带前提（每条自己现场造样本）/ 先复位再操作 /
  // 受控组件用原生 setter。
  // =========================================================================
  const modify6Marker = `${marker} 修改6`

  /** 首页「今日计划」一行的读数 */
  interface HomePlanRow {
    id: string
    title: string
    overdueRow: boolean
    tags: string[]
  }

  const homePlanRowsExpr = `Array.from(document.querySelectorAll('[data-testid="home-task-row"]')).map((row) => ({
    id: String(row.getAttribute('data-task-id') || ''),
    title: ((row.querySelector('.task__title') || {}).textContent || '').trim(),
    overdueRow: String(row.className || '').indexOf('task--overdue') >= 0,
    tags: Array.from(row.querySelectorAll('.task__meta')).map((el) => String((el.textContent || '')).trim())
  }))`

  /**
   * 打开首页并把「今日计划」**全部展开**。
   *
   * 不展开只能看到前 3 项——"只显示今天的"这件事会被「还有 N 项」截断藏起来，
   * 逾期有没有混进来就看不全。所以这一块每次都先展开再数。
   *
   * 首页只在**挂载时**读盘（自己造的数据靠重新挂载才看得见），所以先进出一次。
   */
  const openHomePlanFull = async (): Promise<boolean> => {
    await closeFloaters(context)
    await evaluate(context, `window.__verify.clickNav('memo')`)
    await wait(150)
    await evaluate(context, `window.__verify.clickNav('home')`)
    // 轮询等"数据已经读回来"：`home-today-plan` 的 data-loaded 由首页在读盘完成后置 1。
    // 不能只看"有没有行 / 有没有空状态"——数据还没到时那也是空状态，会读到假基线。
    const ready = await untilTrue(
      context,
      `(function () {
         const section = window.__verify.byTestId('home-today-plan')
         return !!section && section.getAttribute('data-loaded') === '1'
       })()`,
      20,
      250
    )
    if (!ready) return false
    const hasMore = await evaluate<boolean>(context, `!!window.__verify.byTestId('home-expand-plan')`)
    if (hasMore) {
      await evaluate(context, `window.__verify.click('[data-testid="home-expand-plan"]')`)
      await untilTrue(context, `!window.__verify.byTestId('home-expand-plan')`, 12, 250)
    }
    return true
  }

  /** 现场造一条计划样本（日期可指定；其余字段给全，避免走默认值） */
  const addModify6Task = async (title: string, date: string): Promise<string> =>
    addPlanSample(context, {
      title,
      date,
      timeSlot: 'none',
      recurrence: 'none',
      done: false,
      carriedOver: 0,
      doneAt: null
    })

  /**
   * 按数据算"逾期条数"（与首页关注卡、页头统计同一个口径：放弃 / 已完成 / 待安排都不算）。
   *
   * 修改 7 轮：`isOverdue` → `countsAsOverdue`（用户「标记未完成不显示逾期」）。
   * 这不是放宽断言：关注卡与页头本来就该与产品同一个函数，而产品改成了统计口径。
   */
  const overdueCountFromData = async (): Promise<number> => {
    const tasks = (await planRecords(context)).map((record) => normalizePlanTask(record))
    return tasks.filter(
      (task) => task.id !== '' && task.title !== '' && countsAsOverdue(task, todayKey)
    ).length
  }

  /** 逾期提醒的状态读数（`plan-overdue-state`，不可见）：分清"偏好还没读回来"与"今天关过" */
  interface OverdueHintState {
    ready: boolean
    dismissedOn: string
    shown: boolean
    count: number
  }

  const overdueHintStateExpr = `(() => {
    const el = window.__verify.byTestId('plan-overdue-state')
    if (!el) return { ready: false, dismissedOn: '', shown: false, count: -1 }
    return {
      ready: el.getAttribute('data-ready') === '1',
      dismissedOn: String(el.getAttribute('data-dismissed-on') || ''),
      shown: el.getAttribute('data-shown') === '1',
      count: Number(el.getAttribute('data-count'))
    }
  })()`

  const untilOverdueHintState = async (
    accept: (value: OverdueHintState) => boolean,
    attempts = 20
  ): Promise<OverdueHintState | null> =>
    until<OverdueHintState>(context, overdueHintStateExpr, accept, attempts, 250)

  // ---- Q1 首页「今日计划」只显示今天的：2 条逾期 + 1 条今天 → 只多出今天那一条 ----
  try {
    // 复位①：提醒"今天没关过"（否则后面的提示类断言会连带失败）
    await setOverdueHintDismissedOn(context, addDaysToKey(todayKey, -1))

    // 自带前提：先量一次基线，之后只核对"**新增的**"那一行——别处留下的数据不算
    const baselineReady = await openHomePlanFull()
    if (!baselineReady) throw new Error('首页没有渲染出来（拿不到基线）')
    const beforeRows = await evaluate<HomePlanRow[]>(context, homePlanRowsExpr)
    const beforeIds = beforeRows.map((row) => row.id)

    // 现场造样本：2 条逾期（2 天前 / 3 天前）+ 1 条今天
    const overdueA = await addModify6Task(
      `${modify6Marker} 逾期样本一（${passNumber}趟）`,
      addDaysToKey(todayKey, -2)
    )
    const overdueB = await addModify6Task(
      `${modify6Marker} 逾期样本二（${passNumber}趟）`,
      addDaysToKey(todayKey, -3)
    )
    const todayId = await addModify6Task(`${modify6Marker} 今天样本（${passNumber}趟）`, todayKey)

    // 复位②：重新进首页（重新读盘）+ 展开，拿到全量
    const ready = await openHomePlanFull()
    if (!ready) throw new Error('造完样本后首页没有渲染出来')
    const afterRows = await evaluate<HomePlanRow[]>(context, homePlanRowsExpr)

    const added = afterRows.filter((row) => !beforeIds.includes(row.id))
    const overdueShown = afterRows.filter((row) => row.id === overdueA || row.id === overdueB)
    const todayShown = afterRows.some((row) => row.id === todayId)
    const overdueStyled = afterRows.filter((row) => row.overdueRow)
    const yesterdayTags = afterRows.filter((row) => row.tags.some((tag) => tag.includes('昨天')))

    record({
      id: 'P8-Q1',
      prd: '修改-6 §8.3',
      name: '首页：「今日计划」**只显示今天那一组**——现场造 2 条逾期 + 1 条今天，清单里只多出今天那一条，逾期一条都不出现（★核心）',
      passed:
        todayShown &&
        overdueShown.length === 0 &&
        added.length === 1 &&
        added[0]?.id === todayId &&
        overdueStyled.length === 0,
      detail: `首页基线 ${beforeRows.length} 行 → 造样本后 ${afterRows.length} 行；新增 ${added.length} 行（期望 1，且正是今天那条=${added[0]?.id === todayId}，"${added[0]?.title ?? ''}"）；今天样本在清单里=${todayShown}；两条逾期样本出现 ${overdueShown.length} 条（期望 0）；被标成逾期样式的行=${overdueStyled.length}（期望 0）带「昨天」标签的行=${yesterdayTags.length}（期望 0）`
    })
  } catch (error) {
    record({
      id: 'P8-Q1',
      prd: '修改-6 §8.3',
      name: '首页：「今日计划」只显示今天那一组（2 条逾期 + 1 条今天 → 只显示 1 条）',
      passed: false,
      detail: `${String(error)}；${diagnostics()}`
    })
  }

  // ---- Q2 同一场景：关注卡「逾期未完成」仍然在，数量与数据一致（★别改坏了） ----
  try {
    const card = await until<{ exists: boolean; label: string; count: number }>(
      context,
      `(() => {
         const card = window.__verify.byTestId('attention-overdue')
         if (!card) return { exists: false, label: '', count: -1 }
         const label = card.querySelector('.attention__label')
         const count = card.querySelector('.attention__count')
         return {
           exists: true,
           label: label ? (label.textContent || '').trim() : '',
           count: count ? Number((count.textContent || '').trim()) : -1
         }
       })()`,
      (value) => value.exists === true,
      16,
      250
    )
    const expected = await overdueCountFromData()
    record({
      id: 'P8-Q2',
      prd: '修改-6 §8.3',
      name: '首页：「需要你的关注」里**仍然有「逾期未完成」那张卡**，数量与数据一致（★它 PRD 规定的三张卡之一，不能因为"今日计划不显示逾期"就一起删了）',
      passed:
        card !== null && card.label === '逾期未完成' && card.count === expected && expected >= 2,
      detail: `关注卡存在=${card?.exists ?? false} 标签="${card?.label ?? ''}" 数量=${card?.count ?? '?'}（按数据算=${expected}，含本块现场造的 2 条所以必须 ≥2）`
    })
  } catch (error) {
    record({
      id: 'P8-Q2',
      prd: '修改-6 §8.3',
      name: '首页：「需要你的关注」里的「逾期未完成」卡仍然保留且数量正确',
      passed: false,
      detail: `${String(error)}；${diagnostics()}`
    })
  }

  // ---- Q3 计划页工具栏那排里有内联提示（短文案 + 入口 + ×），点它打开移动面板 ----
  try {
    // 复位：写成昨天 = 今天没关过 → 提示应当出现
    await setOverdueHintDismissedOn(context, addDaysToKey(todayKey, -1))
    await closeFloaters(context)
    await evaluate(context, `window.__verify.clickNav('plan')`)
    await wait(500)
    await openPlanList(context, 'today')

    // 先等两件事都成立：偏好读完（data-ready=1）+ 任务也读完（count > 0）。
    // 只看"提示在不在"不行——偏好没读回来时它本来就不该渲染，会把失败伪装成通过。
    const prefState = await untilOverdueHintState(
      (value) => value.ready === true && value.count > 0
    )
    const shown =
      prefState !== null &&
      (await evaluate<boolean>(context, `!!window.__verify.byTestId('plan-overdue-inline')`))
    const snap = await evaluate<{
      text: string
      count: number
      inToolbar: boolean
      hasEntry: boolean
      hasDismiss: boolean
      oldHintGone: boolean
      headerText: string
      headerCount: number
    }>(
      context,
      `(() => {
         const inline = window.__verify.byTestId('plan-overdue-inline')
         const state = window.__verify.byTestId('plan-state')
         return {
           text: inline ? (inline.textContent || '').trim() : '',
           count: inline ? Number(inline.getAttribute('data-count')) : -1,
           inToolbar: !!document.querySelector('.page__toolbar [data-testid="plan-overdue-inline"]'),
           hasEntry: !!document.querySelector('[data-testid="plan-overdue-inline"] [data-testid="plan-overdue-move-open"]'),
           hasDismiss: !!document.querySelector('[data-testid="plan-overdue-inline"] [data-testid="plan-overdue-dismiss"]'),
           oldHintGone: !document.querySelector('[data-testid="plan-overdue-hint"]'),
           headerText: ((window.__verify.byTestId('page-description') || {}).textContent || '').trim(),
           headerCount: state ? Number(state.getAttribute('data-count-overdue')) : -1
         }
       })()`
    )
    const expected = snap.headerCount
    const textOk = snap.text.includes(`${expected} 项逾期`)
    const clicked = snap.hasEntry
      ? await evaluate<boolean>(context, `window.__verify.click('[data-testid="plan-overdue-move-open"]')`)
      : false
    const panelOpen = clicked
      ? await untilTrue(context, `!!window.__verify.byTestId('plan-move-panel')`, 16, 250)
      : false
    await closeFloaters(context)

    record({
      id: 'P8-Q3',
      prd: '修改-6 §8.3',
      name: '计划：逾期提示是**工具栏那排里的内联控件**（`plan-overdue-inline`，短文案「N 项逾期」+ 入口 + `×`），原来那条独占一行的 `plan-overdue-hint` 已删；点提示打开「移动某天未完成的…」面板',
      passed:
        prefState !== null &&
        prefState.dismissedOn === addDaysToKey(todayKey, -1) &&
        shown &&
        snap.inToolbar &&
        expected > 0 &&
        snap.count === expected &&
        textOk &&
        snap.hasEntry &&
        snap.hasDismiss &&
        snap.oldHintGone &&
        clicked &&
        panelOpen,
      detail: `偏好已读回=${prefState?.ready ?? false}（dismissed-on="${prefState?.dismissedOn ?? ''}"，复位成昨天）内联提示出现=${shown} 在工具栏那排里=${snap.inToolbar}；文案="${snap.text}"（期望含「${expected} 项逾期」，data-count=${snap.count}）页头="${snap.headerText}"；入口=${snap.hasEntry} × 关闭=${snap.hasDismiss}；旧的块级黄条已删=${snap.oldHintGone}；点提示=${clicked} 打开移动面板=${panelOpen}`
    })
  } catch (error) {
    record({
      id: 'P8-Q3',
      prd: '修改-6 §8.3',
      name: '计划：逾期提示内联在工具栏那排里，点它能打开移动面板',
      passed: false,
      detail: `${String(error)}；${diagnostics()}`
    })
  }

  // ---- Q4 点 × → 提示立刻消失；页头「逾期 N 项」仍然在（★只关提示，不关统计） ----
  try {
    // 复位：重新挂载一次，确认起点是"提示在"（否则"消失了"没有意义）
    await closeFloaters(context)
    await evaluate(context, `window.__verify.clickNav('memo')`)
    await wait(150)
    await evaluate(context, `window.__verify.clickNav('plan')`)
    await wait(400)
    const beforeState = await untilOverdueHintState(
      (value) => value.ready === true && value.shown === true
    )
    const beforeShown =
      beforeState !== null &&
      (await evaluate<boolean>(context, `!!window.__verify.byTestId('plan-overdue-inline')`))
    const before = await evaluate<{ headerText: string; headerCount: number }>(
      context,
      `(() => {
         const state = window.__verify.byTestId('plan-state')
         return {
           headerText: ((window.__verify.byTestId('page-description') || {}).textContent || '').trim(),
           headerCount: state ? Number(state.getAttribute('data-count-overdue')) : -1
         }
       })()`
    )

    const clicked = beforeShown
      ? await evaluate<boolean>(context, `window.__verify.click('[data-testid="plan-overdue-dismiss"]')`)
      : false
    const afterState = clicked
      ? await untilOverdueHintState(
          (value) => value.shown === false && value.dismissedOn === todayKey,
          16
        )
      : null
    const gone =
      afterState !== null &&
      !(await evaluate<boolean>(context, `!!window.__verify.byTestId('plan-overdue-inline')`))
    const after = await evaluate<{ headerText: string; headerCount: number }>(
      context,
      `(() => {
         const state = window.__verify.byTestId('plan-state')
         return {
           headerText: ((window.__verify.byTestId('page-description') || {}).textContent || '').trim(),
           headerCount: state ? Number(state.getAttribute('data-count-overdue')) : -1
         }
       })()`
    )
    const pref = await readOverdueHintDismissedOn(context)

    record({
      id: 'P8-Q4',
      prd: '修改-6 §8.3',
      name: '计划：点 `×`（`plan-overdue-dismiss`）提示立刻消失、偏好记下"今天关过"；**页头「逾期 N 项」仍然在**（★关的只是提示，不是统计）',
      passed:
        beforeShown &&
        clicked &&
        afterState !== null &&
        gone &&
        before.headerCount > 0 &&
        after.headerCount === before.headerCount &&
        after.headerText.includes(`逾期 ${before.headerCount} 项`) &&
        pref === todayKey,
      detail: `点 × 前提示在=${beforeShown}（data-shown=${beforeState?.shown ?? false}）；点 ×=${clicked} 之后提示消失=${gone}（data-shown=${afterState?.shown ?? '?'} dismissed-on="${afterState?.dismissedOn ?? ''}"）；页头 前="${before.headerText}"（逾期 ${before.headerCount}）→ 后="${after.headerText}"（逾期 ${after.headerCount}；期望与页头统计都不变且 >0）；落库偏好 overdueHintDismissedOn="${pref}"（期望 ${todayKey}）`
    })
  } catch (error) {
    record({
      id: 'P8-Q4',
      prd: '修改-6 §8.3',
      name: '计划：点 × 之后提示消失，页头「逾期 N 项」统计不受影响',
      passed: false,
      detail: `${String(error)}；${diagnostics()}`
    })
  }

  // ---- Q5 关闭状态持久化：重进计划页仍不显示；改成"昨天关的" → 提示自动回来 ----
  try {
    // ① 重新挂载计划页（挂载时会重新读偏好）→ 仍然不显示；页头统计照旧
    await closeFloaters(context)
    await evaluate(context, `window.__verify.clickNav('memo')`)
    await wait(150)
    await evaluate(context, `window.__verify.clickNav('plan')`)
    await wait(600)
    await openPlanList(context, 'today')
    // 等两件事同时成立：数据已读回（overdue > 0）+ 偏好已读回（dismissed-on = 今天）
    const state = await until<{ view: string; overdue: number }>(
      context,
      `(() => {
         const state = window.__verify.byTestId('plan-state')
         return {
           view: state ? String(state.getAttribute('data-view') || '') : '',
           overdue: state ? Number(state.getAttribute('data-count-overdue')) : -1
         }
       })()`,
      (value) => value.view === 'today' && value.overdue > 0,
      16,
      250
    )
    const hiddenState = await untilOverdueHintState(
      (value) => value.ready === true && value.dismissedOn === todayKey && value.shown === false
    )
    // 在 1.5 秒窗口里反复看：一冒出来就算失败（不是"某一瞬间看了一眼"）
    let stayedHidden = true
    for (let attempt = 0; attempt < 6; attempt += 1) {
      const present = await evaluate<boolean>(
        context,
        `!!window.__verify.byTestId('plan-overdue-inline')`
      )
      if (present) {
        stayedHidden = false
        break
      }
      await wait(250)
    }
    const headerStillThere = await evaluate<string>(
      context,
      `((window.__verify.byTestId('page-description') || {}).textContent || '').trim()`
    )
    const expectedCount = state?.overdue ?? -1

    // ② 把"关掉的那一天"改成昨天 = 第二天到了 → 提示**自动回来**（没有任何定时器）
    const yesterdayKey = addDaysToKey(todayKey, -1)
    await setOverdueHintDismissedOn(context, yesterdayKey)
    await evaluate(context, `window.__verify.clickNav('memo')`)
    await wait(150)
    await evaluate(context, `window.__verify.clickNav('plan')`)
    await wait(500)
    const backState = await untilOverdueHintState(
      (value) => value.ready === true && value.dismissedOn === yesterdayKey && value.shown === true
    )
    const back =
      backState !== null &&
      (await evaluate<boolean>(context, `!!window.__verify.byTestId('plan-overdue-inline')`))
    const backText = await evaluate<string>(
      context,
      `((window.__verify.byTestId('plan-overdue-inline') || {}).textContent || '').trim()`
    )
    const prefNow = await readOverdueHintDismissedOn(context)

    record({
      id: 'P8-Q5',
      prd: '修改-6 §8.3',
      name: '计划：关闭状态**持久化**——重进计划页仍不显示（页头统计照旧）；把 `overdueHintDismissedOn` 改成昨天 → 提示**回来**（"当天不再出现、第二天自动回来"）',
      passed:
        state !== null &&
        hiddenState !== null &&
        stayedHidden &&
        headerStillThere.includes(`逾期 ${expectedCount} 项`) &&
        back &&
        backText.includes(`${expectedCount} 项逾期`),
      detail: `重进计划页后：偏好已读回=${hiddenState?.ready ?? false}（dismissed-on="${hiddenState?.dismissedOn ?? ''}"，期望 ${todayKey}）data-shown=${hiddenState?.shown ?? '?'}；1.5 秒窗口内提示一次都没出现=${stayedHidden}；页头="${headerStillThere}"（期望含「逾期 ${expectedCount} 项」，说明只关了提示）；把偏好改成昨天（现为 "${prefNow}"）再进页面 → data-shown=${backState?.shown ?? '?'} 提示回来=${back} 文案="${backText}"（期望含「${expectedCount} 项逾期」）`
    })
  } catch (error) {
    record({
      id: 'P8-Q5',
      prd: '修改-6 §8.3',
      name: '计划：关闭状态持久化，改成昨天之后提示自动回来',
      passed: false,
      detail: `${String(error)}；${diagnostics()}`
    })
  }

  // =========================================================================
  // 修改 7 轮（对应 `修改-7.md`）：**标记未完成的任务不算逾期**
  //
  // 用户原话：「标记未完成不显示逾期。」
  // 用户确认过的三条边界（**方向不同，别合并处理**）：
  //   ① 「逾期 N 项」**不数**它（页头 / 工具栏提示 / 导航红点 / 首页关注卡 / 日历逾期色）
  //   ② 「今天 / 本周」的数字与**完成率分母仍然算**它（它确实没做完）
  //   ③ 它仍然看得见：「全部」视图单独一组「已标未完成（N）」；
  //      「今天 / 本周」与首页都**不显示**它；日历**照旧把它画在自己的日期上**，只是不标红
  //
  // 编号用 **P8-T**：`A–N`、`R`、`S`、`U–Z` 已被前面几块占用；`P` 是修改-5、`Q` 是修改-6，
  // `O` / `T` 还空着（与 `修改-7.md` §八.2 的建议一致）。
  //
  // 硬规矩照旧：轮询等待 / 自带前提（每条自己现场造样本）/ 先复位再操作 /
  // 受控组件用原生 setter。
  // =========================================================================
  const move7Marker = `${marker} 修改7`

  /** 现场造一条修改 7 轮的样本（日期与额外字段都要显式给，避免走默认值） */
  const addMove7Task = async (
    title: string,
    date: string,
    extra: Record<string, unknown> = {}
  ): Promise<string> =>
    addPlanSample(context, {
      title,
      date,
      timeSlot: 'none',
      recurrence: 'none',
      done: false,
      carriedOver: 0,
      doneAt: null,
      ...extra
    })

  /**
   * 数据口径的逾期统计（在**主进程**里算，用产品那份实现：`countsAsOverdue` / `isOverdue`）。
   *
   *   plain = 计入逾期统计的（页头 / 红点 / 关注卡 / 日历红读的就是这个数）
   *   held  = 日期已过、但被手动标了「未完成」的（**只有它**时红点必须不亮）
   *
   * 为什么不在渲染进程里算：那边拿不到共享函数；在验收里手写一份判据会变成
   * "双份真值"（`phase2.ts` 曾经就这么红过），所以统一回主进程用同一份实现。
   */
  interface Move7OverdueStats {
    plain: number
    held: number
  }
  const move7OverdueStats = async (): Promise<Move7OverdueStats> => {
    const tasks = (await planRecords(context))
      .map((record) => normalizePlanTask(record))
      .filter((task) => task.id !== '' && task.title !== '')
    return {
      plain: tasks.filter((task) => countsAsOverdue(task, todayKey)).length,
      held: tasks.filter((task) => isOverdue(task, todayKey) && isHeld(task)).length
    }
  }

  /** 导航「计划」的红点在不在 */
  const planDotExpr = `!!document.querySelector('[data-nav-id="plan"] .nav__dot')`

  /** 「已标未完成」那一组的标题文字（不在就空串） */
  const heldGroupTitleExpr = `(() => {
    const group = window.__verify.byTestId('group-held')
    const title = group ? group.querySelector('.group__title') : null
    return title ? (title.textContent || '').trim() : ''
  })()`

  /** 某条任务行是不是在某个分组里 */
  const rowInGroupExpr = (groupId: string, taskId: string): string =>
    `!!document.querySelector('[data-testid="${groupId}"] [data-testid="task-row"][data-task-id="${taskId}"]')`

  // ---- T1 页头「逾期 N 项」：1 条普通逾期 + 1 条已标记 → 逾期只 +1（★核心）----
  //
  // 同一条判据同时钉住用户那两条方向相反的边界：
  //   - 逾期 **+1**（不是 +2）→ 说明 held 没被算进逾期
  //   - 今天 / 本周 **各 +1**（那条"今天到期 + 已标记"的任务）→ 说明 held 仍在这两个数字里
  try {
    await setOverdueHintDismissedOn(context, addDaysToKey(todayKey, -1))
    await closeFloaters(context)
    await evaluate(context, `window.__verify.clickNav('plan')`)
    await wait(400)
    await openPlanList(context, 'today')
    const before = await stableHeaderCounts('today')
    if (before === null) throw new Error('页头「逾期 N 项」一直在变，取不到稳定基线')

    // 过期样本放在 10 天前：**一定不在本周**（本周最多跨到 6 天前），
    // 这样"本周 +1"只可能来自下面那条今天到期的任务，数字可手算。
    const overdueKey = addDaysToKey(todayKey, -10)
    const plainId = await addMove7Task(`${move7Marker} 普通逾期样本（${passNumber}趟）`, overdueKey)
    const heldId = await addMove7Task(`${move7Marker} 已标记逾期样本（${passNumber}趟）`, overdueKey, {
      held: true
    })
    const heldTodayId = await addMove7Task(
      `${move7Marker} 今天到期且已标记（${passNumber}趟）`,
      todayKey,
      { held: true }
    )

    const counted = await until<PlanHeaderCounts>(
      context,
      planHeaderCountsExpr,
      (value) =>
        value.view === 'today' &&
        value.overdue === before.overdue + 1 &&
        value.today === before.today + 1 &&
        value.week === before.week + 1,
      20,
      250
    )
    const headerText = await evaluate<string>(
      context,
      `((window.__verify.byTestId('page-description') || {}).textContent || '').trim()`
    )
    const plainData = await move5TaskData(plainId)
    const heldData = await move5TaskData(heldId)
    const heldTodayData = await move5TaskData(heldTodayId)

    record({
      id: 'P8-T1',
      prd: '修改-7 §八.2',
      name: `计划：造 1 条普通逾期 + 2 条已标记（1 条逾期、1 条**今天到期**）→ 页头「逾期」**只 +1**（不是 +2），而「今天 / 本周」各 **+1**（数字仍算它）（★核心）`,
      passed:
        counted !== null &&
        headerText.includes(`逾期 ${before.overdue + 1} 项`) &&
        plainData.held === false &&
        heldData.held === true &&
        heldTodayData.held === true &&
        heldData.date === overdueKey &&
        counted.today === before.today + 1 &&
        counted.week === before.week + 1,
      detail: `基线：逾期=${before.overdue} 今天=${before.today} 本周=${before.week}（页头="${before.text}"）；造 3 条（${overdueKey} 普通 / ${overdueKey} 已标记 / ${todayKey} 今天到期且已标记）后：逾期=${counted?.overdue ?? '?'}（期望 ${before.overdue + 1}，**不是 +2**）今天=${counted?.today ?? '?'}（期望 ${before.today + 1}）本周=${counted?.week ?? '?'}（期望 ${before.week + 1}）页头="${headerText}"；落盘 held：普通=${plainData.held}（期望 false）已标记=${heldData.held}（期望 true）今天那条=${heldTodayData.held}（期望 true），日期=${heldData.date}（期望 ${overdueKey}，没被挪走）`
    })
  } catch (error) {
    record({
      id: 'P8-T1',
      prd: '修改-7 §八.2',
      name: '计划：页头「逾期」不数已标记的，但「今天 / 本周」仍算它（★核心）',
      passed: false,
      detail: `${String(error)}；${diagnostics()}`
    })
  }

  // ---- T2 「全部」视图：那两条**都在页面上**（★别让它凭空消失）----
  try {
    const overdueKey = addDaysToKey(todayKey, -11)
    const plainId = await addMove7Task(`${move7Marker} T2 普通样本（${passNumber}趟）`, overdueKey)
    const heldId = await addMove7Task(`${move7Marker} T2 已标记样本（${passNumber}趟）`, overdueKey, {
      held: true
    })

    await closeFloaters(context)
    await evaluate(context, `window.__verify.clickNav('plan')`)
    await wait(300)
    await openPlanList(context, 'all')

    const plainShown = await untilTrue(context, rowInGroupExpr('group-all', plainId), 16, 250)
    const heldInHeldGroup = await untilTrue(context, rowInGroupExpr('group-held', heldId), 16, 250)
    // 「全部任务」里不许再出现它（同一屏出现两次会让人以为任务翻倍了）
    const heldInAllGroup = await evaluate<boolean>(context, rowInGroupExpr('group-all', heldId))
    const heldDateText = await evaluate<string>(
      context,
      `(() => {
         const row = document.querySelector('[data-testid="group-held"] [data-testid="task-row"][data-task-id="${heldId}"]')
         const date = row ? row.querySelector('[data-testid="task-date"]') : null
         return date ? (date.textContent || '').trim() : ''
       })()`
    )
    // 组标题的 N 必须等于组里的行数（"数量与行数一致"）
    const heldGroupTitle = await evaluate<string>(context, heldGroupTitleExpr)
    const heldGroupRows = await evaluate<number>(
      context,
      `document.querySelectorAll('[data-testid="group-held"] [data-testid="task-row"]').length`
    )
    const titleCount = Number(/（(\d+)）/.exec(heldGroupTitle)?.[1] ?? -1)
    await openPlanList(context, 'today')

    record({
      id: 'P8-T2',
      prd: '修改-7 §八.2',
      name: `计划：切到「全部」视图后**两条都在页面上** —— 普通那条在「全部任务」，标了「未完成」的那条在「已标未完成」组里、日期仍是 ${overdueKey}（★别让它消失）`,
      passed:
        plainShown &&
        heldInHeldGroup &&
        heldInAllGroup === false &&
        heldDateText === overdueKey &&
        /^已标未完成（\d+）/.test(heldGroupTitle) &&
        titleCount === heldGroupRows,
      detail: `普通那条在「全部任务」组=${plainShown}；已标记那条在「已标未完成」组=${heldInHeldGroup}、**不在**「全部任务」组=${heldInAllGroup === false}（期望 true）；它的日期列="${heldDateText}"（期望 ${overdueKey}，**日期没被挪走**）；组标题="${heldGroupTitle}" 标题里的数量=${titleCount} 组里实际行数=${heldGroupRows}（期望相等）`
    })
  } catch (error) {
    record({
      id: 'P8-T2',
      prd: '修改-7 §八.2',
      name: '计划：「全部」视图里两条都在（普通在「全部任务」、已标记在「已标未完成」组）',
      passed: false,
      detail: `${String(error)}；${diagnostics()}`
    })
  }

  // ---- T3 导航「计划」红点：只有普通逾期时为 true；只有 held 时为 **false** ----
  //
  // 这条必须**真的造出"只剩 held"的局面**才有分辨力（数据里本来就有别的普通逾期）：
  // 做法是把当前所有"计入逾期的"任务**临时**标成 held → 红点必须灭；再全部还原 → 红点必须回来。
  // 只改 `held` 这一个字段，且**无论如何都会还原**（try/finally）。
  try {
    await closeFloaters(context)
    await evaluate(context, `window.__verify.clickNav('plan')`)
    await wait(300)
    await openPlanList(context, 'today')
    // 自带前提：现有 1 条普通逾期（否则红点本来就该灭，验不出东西）
    const plainId = await addMove7Task(`${move7Marker} 红点普通样本（${passNumber}趟）`, addDaysToKey(todayKey, -2))
    const plainIsCounted = (await planRecords(context))
      .map((record) => normalizePlanTask(record))
      .some((task) => task.id === plainId && countsAsOverdue(task, todayKey))
    const dotBefore = await untilTrue(context, planDotExpr, 16, 250)
    const statsBefore = await move7OverdueStats()

    /** 把当前所有"计入逾期"的任务临时标成 held（返回被改的 id） */
    const holdAllPlainOverdue = async (): Promise<string[]> => {
      const tasks = (await planRecords(context))
        .map((record) => normalizePlanTask(record))
        .filter((task) => task.id !== '' && task.title !== '')
      const ids = tasks.filter((task) => countsAsOverdue(task, todayKey)).map((task) => task.id)
      if (ids.length === 0) return []
      await evaluate(
        context,
        `(async () => {
           const ids = ${JSON.stringify(ids)}
           for (const id of ids) await window.api.data.update('plan', id, { held: true })
           await window.api.data.flush()
           return true
         })()`
      )
      await evaluate(
        context,
        `window.dispatchEvent(new CustomEvent('worklife:data-changed', { detail: { module: 'plan' } })), true`
      )
      return ids
    }

    /** 还原：把刚才那些 id 的 held 清掉 */
    const releaseAll = async (ids: string[]): Promise<void> => {
      if (ids.length === 0) return
      await evaluate(
        context,
        `(async () => {
           const ids = ${JSON.stringify(ids)}
           for (const id of ids) await window.api.data.update('plan', id, { held: false })
           await window.api.data.flush()
           return true
         })()`
      )
      await evaluate(
        context,
        `window.dispatchEvent(new CustomEvent('worklife:data-changed', { detail: { module: 'plan' } })), true`
      )
    }

    let heldIds: string[] = []
    let dotOnlyHeld: boolean | null = null
    let statsOnlyHeld: Move7OverdueStats | null = null
    let dotRestored = false
    try {
      heldIds = await holdAllPlainOverdue()
      // 期望红点**灭**（等到 value === false 才算数）
      dotOnlyHeld = await until<boolean>(context, planDotExpr, (value) => value === false, 16, 250)
      statsOnlyHeld = await move7OverdueStats()
    } finally {
      await releaseAll(heldIds)
      dotRestored = await untilTrue(context, planDotExpr, 16, 250)
    }

    record({
      id: 'P8-T3',
      prd: '修改-7 §八.2',
      name: '计划：导航「计划」的红点**不因标了「未完成」的任务亮起** —— 有普通逾期时亮（true）；把普通逾期全临时标成「未完成」后**灭**（false）；还原后又亮回来',
      passed:
        plainIsCounted &&
        dotBefore &&
        statsBefore.plain >= 1 &&
        statsBefore.held >= 1 &&
        heldIds.length >= 1 &&
        dotOnlyHeld === false &&
        statsOnlyHeld !== null &&
        statsOnlyHeld.plain === 0 &&
        statsOnlyHeld.held >= 1 &&
        dotRestored,
      detail: `新造的那条普通逾期确实计入逾期=${plainIsCounted}；初始：红点=${dotBefore}（期望 true）数据口径 普通逾期=${statsBefore.plain} 已标记逾期=${statsBefore.held}（都期望 ≥1）；临时把 ${heldIds.length} 条"计入逾期的"标成 held 后：红点在=${dotOnlyHeld === null ? '一直没灭' : dotOnlyHeld}（期望 false）数据口径 普通逾期=${statsOnlyHeld?.plain ?? '?'}（期望 0）已标记逾期=${statsOnlyHeld?.held ?? '?'}（期望 ≥1，说明"只有 held"的局面真的造出来了）；还原后红点回来=${dotRestored}（期望 true）`
    })
  } catch (error) {
    record({
      id: 'P8-T3',
      prd: '修改-7 §八.2',
      name: '计划：导航「计划」的红点不因标了「未完成」的任务亮起（只有 held 时灭）',
      passed: false,
      detail: `${String(error)}；${diagnostics()}`
    })
  }

  // ---- T4 「已标未完成」组的行：有 `plan-task-held` 标签、**没有逾期红色**；组标题带「不计入逾期」----
  try {
    const heldId = await addMove7Task(
      `${move7Marker} T4 标签样本（${passNumber}趟）`,
      addDaysToKey(todayKey, -12),
      { held: true }
    )
    await closeFloaters(context)
    await evaluate(context, `window.__verify.clickNav('plan')`)
    await wait(300)
    await openPlanList(context, 'all')
    const shown = await untilTrue(context, rowInGroupExpr('group-held', heldId), 16, 250)
    const rowFacts = await evaluate<{
      className: string
      borderLeftWidth: string
      plainBorderLeftWidth: string
      tagText: string
      hasOverdueTag: boolean
      hintText: string
    }>(
      context,
      `(() => {
         const row = document.querySelector('[data-testid="group-held"] [data-testid="task-row"][data-task-id="${heldId}"]')
         if (!row) {
           return {
             className: '',
             borderLeftWidth: '',
             plainBorderLeftWidth: '',
             tagText: '',
             hasOverdueTag: false,
             hintText: ''
           }
         }
         const tag = row.querySelector('[data-testid="plan-task-held"]')
         const style = getComputedStyle(row)
         // 对照：同一屏里"普通行"的左边框宽（带缩放的屏幕上 1px 可能报成 0.8px，
         // 所以不能硬写 1px —— 要比的是"和普通行一样"，不是"等于 1px"）
         const plain = document.querySelector('[data-testid="group-all"] [data-testid="task-row"]')
         const plainStyle = plain ? getComputedStyle(plain) : null
         const hint = window.__verify.byTestId('group-held-hint')
         return {
           className: String(row.className || ''),
           borderLeftWidth: style.borderLeftWidth || '',
           plainBorderLeftWidth: plainStyle ? plainStyle.borderLeftWidth || '' : '',
           tagText: tag ? (tag.textContent || '').trim() : '',
           hasOverdueTag: !!row.querySelector('.task__meta--warn'),
           hintText: hint ? (hint.textContent || '').trim() : ''
         }
       })()`
    )
    await openPlanList(context, 'today')

    record({
      id: 'P8-T4',
      prd: '修改-7 §八.2',
      name: '计划：「已标未完成」组的行上有 `plan-task-held` 标签、**没有逾期红色**（不是 `task--overdue`、左边框不比普通行粗、没有「逾期」小标签），组标题右侧写着「不计入逾期」',
      passed:
        shown &&
        rowFacts.tagText === '未完成' &&
        rowFacts.className.indexOf('task--overdue') < 0 &&
        rowFacts.plainBorderLeftWidth !== '' &&
        rowFacts.borderLeftWidth === rowFacts.plainBorderLeftWidth &&
        rowFacts.hasOverdueTag === false &&
        rowFacts.hintText === '不计入逾期',
      detail: `行在「已标未完成」组里=${shown}；标签文字="${rowFacts.tagText}"（期望 未完成）；行 class="${rowFacts.className}"（**不含** task--overdue=${rowFacts.className.indexOf('task--overdue') < 0}）左边框宽=${rowFacts.borderLeftWidth}（普通行=${rowFacts.plainBorderLeftWidth || '（没读到）'}，期望**一样粗**；逾期行是 3px 的红色左边框）有「逾期」小标签=${rowFacts.hasOverdueTag}（期望 false）；组标题右侧提示="${rowFacts.hintText}"（期望 不计入逾期）`
    })
  } catch (error) {
    record({
      id: 'P8-T4',
      prd: '修改-7 §八.2',
      name: '计划：「已标未完成」组的行有「未完成」标签、没有逾期红色',
      passed: false,
      detail: `${String(error)}；${diagnostics()}`
    })
  }

  // ---- T5 年视图完成率**仍把 held 算进分母**：1 完成 + 1 已标记 → 50%（★本功能的目的）----
  try {
    // 挑一个"原本空着"的月份造样本（判据才可以手算），年份取 +5（前面几块用掉了 +2 / +3）
    const targetYear = yearOfKey(todayKey) + 5
    const yearShown = await openPlanCalendar(context, 'year')
    if (!yearShown) throw new Error('年视图没有渲染出来')
    const jumpValue = await setNativeValue(context, 'calendar-jump', `${targetYear}-06-15`)
    if (jumpValue === '__missing__') throw new Error('年视图的日期跳转框找不到')
    const onTargetYear = await untilTrue(
      context,
      `((window.__verify.byTestId('calendar-title') || {}).textContent || '').includes(${JSON.stringify(`${targetYear}年`)})`,
      16,
      250
    )
    const cells = await until<YearMonthCellView[]>(
      context,
      yearCellsExpr,
      (list) => Array.isArray(list) && list.length === 12,
      16,
      250
    )
    const clean = (cells ?? []).find((cell) => cell.count === 0)
    if (clean === undefined) {
      throw new Error(`年视图 ${targetYear} 里找不到空月份，没法手算期望值：${JSON.stringify(cells)}`)
    }

    // 1 条已完成 + 1 条已标记（未完成）。
    // 分母**含** held ⇒ 2 项 / 50%；若把 held 排掉会是 1 项 / 100%。
    const monthKey = String(clean.month).padStart(2, '0')
    const dayOf = (day: number): string =>
      `${targetYear}-${monthKey}-${String(day).padStart(2, '0')}`
    await addMove7Task(`${move7Marker} T5 完成样本（${passNumber}趟）`, dayOf(5), {
      done: true,
      doneAt: `${dayOf(5)}T09:00:00.000Z`
    })
    await addMove7Task(`${move7Marker} T5 已标记样本（${passNumber}趟）`, dayOf(6), { held: true })

    const afterCell = await until<YearMonthCellView>(
      context,
      yearMonthCellExpr(clean.month),
      (cell) => cell !== null && cell.count === 2 && cell.rate === 50,
      16,
      250
    )
    await openPlanList(context, 'today')

    record({
      id: 'P8-T5',
      prd: '修改-7 §八.2',
      name: '计划：年视图完成率**仍把「未完成」算进分母** —— 1 完成 + 1 已标记 → 2 项 / **50%**（若把 held 排掉会变成 1 项 / 100%，那等于把执行率算高）（★本功能的目的）',
      passed:
        onTargetYear &&
        clean !== undefined &&
        afterCell !== null &&
        afterCell.countText.includes('2 项') &&
        afterCell.rateText.includes('50%'),
      detail: `年视图切到 ${targetYear} 年=${onTargetYear}；挑出的空月份=${clean.month}（造样本前 ${clean.count} 项 / 完成率 ${clean.rate}%）；造 1 完成 + 1 已标记之后：${afterCell?.count ?? '?'} 项 / 完成率 ${afterCell?.rate ?? '?'}%（文字="${afterCell?.countText ?? ''} ${afterCell?.rateText ?? ''}"，期望 2 项 / **50%**；把 held 从分母排掉会是 1 项 / 100%）`
    })
  } catch (error) {
    record({
      id: 'P8-T5',
      prd: '修改-7 §八.2',
      name: '计划：年视图完成率仍把「未完成」算进分母（1 完成 + 1 已标记 → 50%）',
      passed: false,
      detail: `${String(error)}；${diagnostics()}`
    })
  }

  // ---- T6 取消「未完成」标记后**立刻回到「逾期」组**、页头逾期 +1（往返可用）----
  try {
    await closeFloaters(context)
    await evaluate(context, `window.__verify.clickNav('plan')`)
    await wait(400)
    await openPlanList(context, 'today')
    const before = await stableHeaderCounts('today')
    if (before === null) throw new Error('页头统计一直在变，取不到稳定基线')

    const overdueKey = addDaysToKey(todayKey, -13)
    const taskId = await addMove7Task(`${move7Marker} T6 往返样本（${passNumber}趟）`, overdueKey, {
      held: true
    })

    // ① 标着的时候：页头逾期一直**不动**（不数它）
    let stayedUncounted = true
    for (let attempt = 0; attempt < 6; attempt += 1) {
      const snapshot = await evaluate<PlanHeaderCounts>(context, planHeaderCountsExpr)
      if (snapshot.view === 'today' && snapshot.overdue !== before.overdue) {
        stayedUncounted = false
        break
      }
      await wait(250)
    }

    // ② 走界面取消标记（「全部」视图 → 行菜单 → task-unhold）
    const flow = await toggleHoldViaUi(taskId, false)
    const unheldData = await move5TaskData(taskId)

    // ③ 回到「今天」：页头 +1，而且它回到「逾期」组里
    await openPlanList(context, 'today')
    const counted = await until<PlanHeaderCounts>(
      context,
      planHeaderCountsExpr,
      (value) => value.view === 'today' && value.overdue === before.overdue + 1,
      20,
      250
    )
    const backInGroup = await untilTrue(
      context,
      rowInGroupExpr('group-overdue', taskId),
      16,
      250
    )

    record({
      id: 'P8-T6',
      prd: '修改-7 §八.2',
      name: `计划：取消「未完成」标记后**立刻回到「逾期」组**、页头逾期 **+1**（往返可用，不是单向门）——${overdueKey} 那条`,
      passed:
        stayedUncounted &&
        flow.clicked &&
        unheldData.held === false &&
        counted !== null &&
        backInGroup,
      detail: `基线逾期=${before.overdue}；造 1 条 ${overdueKey} 的"已标记"任务后，1.5 秒内页头逾期一直没变=${stayedUncounted}（期望 true，说明不数它）；点「取消未完成标记」=${flow.clicked} 落盘 held=${unheldData.held}（期望 false）；回到「今天」后：逾期=${counted?.overdue ?? '?'}（期望 ${before.overdue + 1}）它回到「逾期」组=${backInGroup}`
    })
  } catch (error) {
    record({
      id: 'P8-T6',
      prd: '修改-7 §八.2',
      name: '计划：取消「未完成」标记后立刻回到「逾期」组、页头 +1',
      passed: false,
      detail: `${String(error)}；${diagnostics()}`
    })
  }

  // ---- T7 首页「今日计划」**看不到** held（哪怕它的日期就是今天）----
  try {
    const controlId = await addMove7Task(`${move7Marker} T7 首页对照（${passNumber}趟）`, todayKey)
    const heldId = await addMove7Task(`${move7Marker} T7 首页已标记（${passNumber}趟）`, todayKey, {
      held: true
    })
    const ready = await openHomePlanFull()
    if (!ready) throw new Error('造完样本后首页没有渲染出来')
    const rows = await evaluate<HomePlanRow[]>(context, homePlanRowsExpr)
    const controlShown = rows.some((row) => row.id === controlId)
    const heldShown = rows.some((row) => row.id === heldId)
    const heldStyled = rows.filter((row) => row.id === heldId && row.overdueRow).length

    record({
      id: 'P8-T7',
      prd: '修改-7 §八.2',
      name: '首页：「今日计划」里**看不到**标了「未完成」的任务（哪怕它的日期就是今天）——同一天造的对照那条在、被标记的那条不在',
      passed: controlShown && heldShown === false && heldStyled === 0,
      detail: `首页「今日计划」读到 ${rows.length} 行；同一天的**对照**那条在=${controlShown}（期望 true，证明数据已经读回来了）；标了「未完成」的那条在=${heldShown}（期望 false）被标成逾期样式的=${heldStyled}（期望 0）`
    })
  } catch (error) {
    record({
      id: 'P8-T7',
      prd: '修改-7 §八.2',
      name: '首页：「今日计划」里看不到标了「未完成」的任务',
      passed: false,
      detail: `${String(error)}；${diagnostics()}`
    })
  }

  // ---- T8 「今天」「本周」都看不到 held 的**行**（但日历仍画着它、且不标红）；「全部」里有它 ----
  try {
    const controlId = await addMove7Task(`${move7Marker} T8 对照（${passNumber}趟）`, todayKey)
    const heldId = await addMove7Task(`${move7Marker} T8 已标记（${passNumber}趟）`, todayKey, {
      held: true
    })

    // ① 「今天」视图：它 0 行（对照那条在 ⇒ 数据已经读回、页面确实渲染了）
    await closeFloaters(context)
    await evaluate(context, `window.__verify.clickNav('plan')`)
    await wait(300)
    await openPlanList(context, 'today')
    const controlShownToday = await untilTrue(context, planRowExpr(controlId), 16, 250)
    const heldRowInToday = await evaluate<boolean>(context, planRowExpr(heldId))

    // ② 「本周」（日历周视图）：没有它的**行**、也没有「已标未完成」组；
    //    但日历上**仍然把它画在自己的日期上**，只是不标逾期色（用户确认的边界）
    const weekShown = await openPlanCalendar(context, 'week')
    const cardShown = weekShown
      ? await untilTrue(
          context,
          `!!document.querySelector('[data-testid="week-card"][data-task-id="${heldId}"]')`,
          16,
          250
        )
      : false
    const card = await evaluate<{ state: string; held: string } | null>(
      context,
      `(() => {
         const bar = document.querySelector('[data-testid="week-card"][data-task-id="${heldId}"]')
         return bar
           ? { state: String(bar.getAttribute('data-state') || ''), held: String(bar.getAttribute('data-held') || '') }
           : null
       })()`
    )
    const heldRowInWeek = await evaluate<boolean>(context, planRowExpr(heldId))
    const heldGroupInWeek = await evaluate<boolean>(
      context,
      `!!document.querySelector('[data-testid="group-held"]')`
    )

    // ③ 「全部」视图：它还在（唯一能看见它的地方）
    await openPlanList(context, 'all')
    const heldInAll = await untilTrue(context, rowInGroupExpr('group-held', heldId), 16, 250)
    await openPlanList(context, 'today')

    record({
      id: 'P8-T8',
      prd: '修改-7 §八.2',
      name: '计划：「今天」与「本周」视图里**都没有它的行**（也不渲染「已标未完成」组），但**日历上仍然画着它**（日期不变、颜色不是逾期红），而且「全部」视图里有它',
      passed:
        controlShownToday &&
        heldRowInToday === false &&
        cardShown &&
        card?.state === 'todo' &&
        card?.held === 'true' &&
        heldRowInWeek === false &&
        heldGroupInWeek === false &&
        heldInAll,
      detail: `「今天」视图：对照那条在=${controlShownToday}（期望 true）已标记那条的行在=${heldRowInToday}（期望 false）；「本周」周视图：日历里仍然画着它=${cardShown}（期望 true，用户要的"日期不变、只是不标红"）它的条状态=${card?.state ?? '?'}（期望 todo，不是 overdue）data-held=${card?.held ?? '?'}（期望 true）；它在这个视图里的**行**=${heldRowInWeek}（期望 false）「已标未完成」组渲染了=${heldGroupInWeek}（期望 false）；「全部」视图里它在「已标未完成」组=${heldInAll}（期望 true）`
    })
  } catch (error) {
    record({
      id: 'P8-T8',
      prd: '修改-7 §八.2',
      name: '计划：「今天」「本周」看不到 held 的行，但日历仍画着它（不标红），「全部」里有它',
      passed: false,
      detail: `${String(error)}；${diagnostics()}`
    })
  }

  // 收尾：把可能开着的浮层关掉，别让最后的退出流程带着一个抽屉
  await closeFloaters(context)
  await evaluate(context, `window.__verify.key('Escape')`)
  await wait(120)
}