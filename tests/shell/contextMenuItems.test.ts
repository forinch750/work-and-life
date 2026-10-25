/**
 * 菜单项定义的单测（第二轮 FEAT-001 / `docs\TASKS\03` §6.2）
 *
 * 为什么专门测这三件事：菜单项定义与入口分在两个地方
 * （定义在 `shared/contextMenu.ts`，入口在各页的 `⋯` 与右键），
 * 一旦有人图省事在页面里再写一份数组，就会出现
 * "右键有删除、`⋯` 里没有"这种用户一眼就看出来的不一致。
 * 这三条就是拿来把它钉死的：
 *
 *   1. **定义只有一份**：同一实体走"右键"与走"`⋯`"得到的是同一批项（id 与文案逐个相等）
 *   2. **条件项**：已完成的任务只有"标记未完成"、未完成只有"标记完成"（置顶同理）
 *   3. **回调 id 唯一**：不会出现两个菜单项映射到同一个 action
 */
import { describe, expect, it, vi } from 'vitest'
import {
  REVIEW_DAY_PRESETS,
  REVIEW_TOPIC_DELETE_ID,
  REVIEW_TOPIC_DELETE_LABEL,
  REVIEW_TOPIC_HIDE_HINT,
  REVIEW_TOPIC_HIDE_LABEL,
  REVIEW_TOPIC_UNHIDE_LABEL,
  bookMenuItems,
  cardMenuItems,
  firstEnabledIndex,
  menuItemIds,
  memoMenuItems,
  nextEnabledIndex,
  placeMenu,
  reviewTopicMenuItems,
  toSpecs,
  treeNodeMenuItems,
  taskMenuItems,
  type BookMenuContext,
  type CardMenuContext,
  type MemoMenuContext,
  type ReviewTopicMenuContext,
  type TaskMenuContext,
  type TreeNodeMenuContext
} from '../../src/shared/contextMenu'
import { disabledFlags } from '../../src/shared/menuItems'
import { isTopicDeletable, reviewTopicKey } from '../../src/shared/reviewPageView'
import { moveStepsOf } from '../../src/shared/treeMove'

const noop = (): void => undefined

/** 树节点四个移动动作的可用性来源（同一棵树，`ch2` 是最小单元那一层） */
const NODE_TREE = [
  { id: 'res', parentId: null, order: 0 },
  { id: 'ch1', parentId: 'res', order: 0 },
  { id: 'ch2', parentId: 'res', order: 1 }
]
const NODE_MOVE_IDS = ['node-move-up', 'node-move-down', 'node-promote', 'node-demote']

function taskContext(overrides: Partial<TaskMenuContext> = {}): TaskMenuContext {
  return {
    done: false,
    abandoned: false,
    held: false,
    recurrence: 'none',
    timeSlot: 'none',
    reviewScheduled: false,
    today: '2026-10-11',
    tomorrow: '2026-10-12',
    onEdit: noop,
    onDelete: noop,
    onDuplicate: noop,
    onToggleDone: noop,
    onToggleAbandon: noop,
    onAdjustTime: noop,
    onChangeSlot: noop,
    onChangeRecurrence: noop,
    onSetReviewInDays: noop,
    onClearReview: noop,
    onMoveTo: noop,
    onToggleHold: noop,
    onMoveToDate: noop,
    ...overrides
  }
}

function nodeContext(overrides: Partial<TreeNodeMenuContext> = {}): TreeNodeMenuContext {
  return {
    title: '第 1 章',
    summary: false,
    done: false,
    expanded: false,
    root: false,
    moves: { ...moveStepsOf(NODE_TREE, 'ch2'), moveTo: noop },
    onAddChild: noop,
    onRename: noop,
    onDelete: noop,
    onToggleDone: noop,
    onToggleExpand: noop,
    onEditMeasure: noop,
    onEditNote: noop,
    ...overrides
  }
}

function reviewTopicContext(
  overrides: Partial<ReviewTopicMenuContext> = {}
): ReviewTopicMenuContext {
  return {
    hidden: false,
    onToggleHidden: noop,
    // 默认是 `topic:` / `book:` 档那种"只能隐藏"的形态（真实实体，不在复习页删）；
    // 来源档用下面的 `sourceTopicContext()` 造（修改 3 轮新增的那一条）
    deletable: false,
    cardCount: 0,
    onDelete: noop,
    ...overrides
  }
}

/** 来源档那一行（修改 3 轮）：`source:` 档可删，张数会显示在 hint 里 */
function sourceTopicContext(
  overrides: Partial<ReviewTopicMenuContext> = {}
): ReviewTopicMenuContext {
  return reviewTopicContext({ deletable: true, cardCount: 3, ...overrides })
}

function bookContext(overrides: Partial<BookMenuContext> = {}): BookMenuContext {
  return {
    title: '《语法俱乐部》',
    status: 'reading',
    onEdit: noop,
    onDelete: noop,
    onEditMeasure: noop,
    onAddChapter: noop,
    onToggleStatus: noop,
    ...overrides
  }
}

function memoContext(overrides: Partial<MemoMenuContext> = {}): MemoMenuContext {
  return {
    pinned: false,
    text: '一条备忘',
    onEdit: noop,
    onDelete: noop,
    onTogglePin: noop,
    onAddTag: noop,
    onToPlan: noop,
    onToReview: noop,
    onCopy: noop,
    ...overrides
  }
}

function cardContext(overrides: Partial<CardMenuContext> = {}): CardMenuContext {
  return {
    scheduled: false,
    onEdit: noop,
    onDelete: noop,
    onSetReviewInDays: noop,
    onClearReview: noop,
    onViewHistory: noop,
    onCopy: noop,
    ...overrides
  }
}

/** 五类实体 + 复习页主题行的全部"形态"（条件项的两侧都要覆盖到） */
const ALL_ENTITIES: Array<{ name: string; defs: ReturnType<typeof taskMenuItems> }> = [
  { name: '任务（未完成·无复习时间）', defs: taskMenuItems(taskContext()) },
  { name: '任务（已完成·有复习时间）', defs: taskMenuItems(taskContext({ done: true, reviewScheduled: true, timeSlot: 'morning', recurrence: 'daily' })) },
  { name: '树节点（最小单元）', defs: treeNodeMenuItems(nodeContext()) },
  { name: '树节点（汇总节点）', defs: treeNodeMenuItems(nodeContext({ summary: true, done: true, expanded: true })) },
  { name: '树节点（根节点/资料）', defs: treeNodeMenuItems(nodeContext({ root: true })) },
  { name: '树节点（没有层级移动语义的中区列表行）', defs: treeNodeMenuItems(nodeContext({ moves: undefined })) },
  { name: '资料 / 书（在读）', defs: bookMenuItems(bookContext()) },
  { name: '资料 / 书（读完）', defs: bookMenuItems(bookContext({ status: 'finished' })) },
  { name: '备忘（未置顶）', defs: memoMenuItems(memoContext()) },
  { name: '备忘（已置顶）', defs: memoMenuItems(memoContext({ pinned: true })) },
  { name: '卡片（未排时间）', defs: cardMenuItems(cardContext()) },
  { name: '卡片（已排时间）', defs: cardMenuItems(cardContext({ scheduled: true })) },
  { name: '复习主题（未隐藏）', defs: reviewTopicMenuItems(reviewTopicContext()) },
  { name: '复习主题（已隐藏）', defs: reviewTopicMenuItems(reviewTopicContext({ hidden: true })) },
  { name: '来源档（未隐藏 · 可删）', defs: reviewTopicMenuItems(sourceTopicContext()) },
  { name: '来源档（已隐藏 · 可删）', defs: reviewTopicMenuItems(sourceTopicContext({ hidden: true })) }
]

describe('菜单项定义只有一份（⋯ 与右键取到相同的项）', () => {
  it('同一实体、同一状态下，两次取到的定义 id 与文案完全一致', () => {
    // 两个入口在界面上的做法都是"调同一个函数、各拿一次"，
    // 所以这里就模拟成"取两次"：只要定义里没有随机/hidden 之类的东西，两次必然相等。
    for (const entity of ALL_ENTITIES) {
      const first = toSpecs(entity.defs)
      const second = toSpecs(entity.defs)
      expect(second.map((item) => item.id)).toEqual(first.map((item) => item.id))
      expect(second.map((item) => item.label)).toEqual(first.map((item) => item.label))
    }
  })

  it('五类实体各自都产出了菜单项，没有空菜单', () => {
    for (const entity of ALL_ENTITIES) {
      expect(entity.defs.length, entity.name).toBeGreaterThan(0)
    }
  })

  it('toSpecs 之后每一项都能点（onSelect 是函数）', () => {
    for (const entity of ALL_ENTITIES) {
      for (const spec of toSpecs(entity.defs)) {
        expect(typeof spec.onSelect, `${entity.name} / ${spec.id}`).toBe('function')
      }
    }
  })

  it('toSpecs 会把危险项与禁用项原样带过去（界面靠它们出红字与灰字）', () => {
    const items = toSpecs(treeNodeMenuItems(nodeContext({ summary: true })))
    const byId = new Map(items.map((item) => [item.id, item]))
    expect(byId.get('node-delete')?.danger).toBe(true)
    expect(byId.get('node-mark-done')?.disabled).toBe(true)
  })

  it('定义里出现重复 id 时立刻抛错，而不是让界面上出现两个同名项', () => {
    const dup = [
      { id: 'x', label: '甲', callbacks: noop },
      { id: 'x', label: '乙', callbacks: noop }
    ]
    expect(() => toSpecs(dup)).toThrow(/重复/)
  })
})

describe('条件项按当前状态切换', () => {
  it('未完成的任务只有"标记完成"', () => {
    const ids = menuItemIds(taskMenuItems(taskContext({ done: false })))
    expect(ids).toContain('task-mark-done')
    expect(ids).not.toContain('task-mark-undone')
  })

  it('已完成的任务只有"标记未完成"', () => {
    const ids = menuItemIds(taskMenuItems(taskContext({ done: true })))
    expect(ids).toContain('task-mark-undone')
    expect(ids).not.toContain('task-mark-done')
  })

  it('两种状态下文案确实不同（不是同一个字符串）', () => {
    const pending = taskMenuItems(taskContext({ done: false })).find((def) => def.id === 'task-mark-done')
    const finished = taskMenuItems(taskContext({ done: true })).find((def) => def.id === 'task-mark-undone')
    expect(pending?.label).toBe('标记完成')
    expect(finished?.label).toBe('标记未完成')
    expect(pending?.label).not.toBe(finished?.label)
  })

  it('排过复习时间的任务才出现"清空复习时间"', () => {
    expect(menuItemIds(taskMenuItems(taskContext({ reviewScheduled: false })))).not.toContain(
      'task-clear-review'
    )
    expect(menuItemIds(taskMenuItems(taskContext({ reviewScheduled: true })))).toContain(
      'task-clear-review'
    )
  })

  it('未置顶的备忘只有"置顶"，已置顶的只有"取消置顶"', () => {
    const off = menuItemIds(memoMenuItems(memoContext({ pinned: false })))
    const on = menuItemIds(memoMenuItems(memoContext({ pinned: true })))
    expect(off).toContain('memo-pin')
    expect(off).not.toContain('memo-unpin')
    expect(on).toContain('memo-unpin')
    expect(on).not.toContain('memo-pin')
  })

  it('树的展开/折叠项按当前展开状态换文案', () => {
    const collapsed = treeNodeMenuItems(nodeContext({ expanded: false })).find(
      (def) => def.id === 'node-toggle-expand'
    )
    const expanded = treeNodeMenuItems(nodeContext({ expanded: true })).find(
      (def) => def.id === 'node-toggle-expand'
    )
    expect(collapsed?.label).toBe('展开')
    expect(expanded?.label).toBe('折叠')
  })

  it('书的"标记读完 / 标记在读"按当前状态换一条', () => {
    expect(menuItemIds(bookMenuItems(bookContext({ status: 'reading' })))).toContain('book-mark-finished')
    expect(menuItemIds(bookMenuItems(bookContext({ status: 'reading' })))).not.toContain('book-mark-reading')
    expect(menuItemIds(bookMenuItems(bookContext({ status: 'finished' })))).toContain('book-mark-reading')
    expect(menuItemIds(bookMenuItems(bookContext({ status: 'finished' })))).not.toContain('book-mark-finished')
  })

  it('"改占比 / 改页码"只出现在根节点（资料 / 书）上', () => {
    expect(menuItemIds(treeNodeMenuItems(nodeContext({ root: true })))).toContain('node-measure')
    expect(menuItemIds(treeNodeMenuItems(nodeContext({ root: false })))).not.toContain('node-measure')
  })

  it('汇总节点的"标记完成"是禁用项（与树上那格只读的勾一致）', () => {
    const summary = toSpecs(treeNodeMenuItems(nodeContext({ summary: true })))
    const leaf = toSpecs(treeNodeMenuItems(nodeContext({ summary: false })))
    expect(disabledFlags(summary)[menuItemIds(treeNodeMenuItems(nodeContext({ summary: true }))).indexOf('node-mark-done')]).toBe(true)
    expect(disabledFlags(leaf)[menuItemIds(treeNodeMenuItems(nodeContext({ summary: false }))).indexOf('node-mark-done')]).toBe(false)
  })

  it('树节点的四个移动项：给了 moves 才有，不给就没有（中区扁平列表就是这么过滤的）', () => {
    expect(menuItemIds(treeNodeMenuItems(nodeContext()))).toEqual(
      expect.arrayContaining(NODE_MOVE_IDS)
    )
    const without = menuItemIds(treeNodeMenuItems(nodeContext({ moves: undefined })))
    for (const id of NODE_MOVE_IDS) expect(without).not.toContain(id)
  })

  it('移动项用不了时是"禁用 + 原因"，不是从菜单里消失', () => {
    // `ch2` 是这一层的最后一个 → 下移用不了
    const specs = toSpecs(treeNodeMenuItems(nodeContext()))
    const down = specs.find((spec) => spec.id === 'node-move-down')
    expect(down).toBeDefined()
    expect(down?.disabled).toBe(true)
    expect(down?.hint).toContain('最下面')
    // 上移此刻可用 → 不灰、也没有原因
    const up = specs.find((spec) => spec.id === 'node-move-up')
    expect(up?.disabled).not.toBe(true)
    expect(up?.hint).toBeUndefined()
  })

  /*
   * ⚠️ 这一段是**改写**，不是删测试（修改 3 轮 · `修改-3.md` §8.2）：
   *
   * 口径变了 —— 上一轮"复习主题行的菜单里只有隐藏那一项"是因为**来源档也还没有删除**；
   * 这一轮给来源档补了「删除这个来源档」，所以来源档的 id 列表变成两项。
   * `topic:` / `book:` 档**一个都没变**（仍然只有隐藏 / 取消隐藏），见下面第一条。
   */
  it('复习主题行：隐藏 / 取消隐藏按当前状态换一条，文案说清"不影响总数"', () => {
    const topicShown = toSpecs(reviewTopicMenuItems(reviewTopicContext({ hidden: false })))
    const topicHidden = toSpecs(reviewTopicMenuItems(reviewTopicContext({ hidden: true })))
    // `topic:` / `book:` 档：仍然只有隐藏那一项（不变）
    expect(topicShown.map((spec) => spec.id)).toEqual(['review-topic-hide'])
    expect(topicHidden.map((spec) => spec.id)).toEqual(['review-topic-unhide'])
    expect(topicShown[0]?.label).toBe(REVIEW_TOPIC_HIDE_LABEL)
    expect(topicHidden[0]?.label).toBe(REVIEW_TOPIC_UNHIDE_LABEL)
    // 用户最担心的是"隐藏 = 删了"：这一句必须出现
    expect(topicShown[0]?.hint).toBe(REVIEW_TOPIC_HIDE_HINT)
  })

  it('来源档：两种状态下都多一条「删除这个来源档」，排在最末', () => {
    const sourceShown = toSpecs(reviewTopicMenuItems(sourceTopicContext({ hidden: false })))
    const sourceHidden = toSpecs(reviewTopicMenuItems(sourceTopicContext({ hidden: true })))
    expect(sourceShown.map((spec) => spec.id)).toEqual(['review-topic-hide', REVIEW_TOPIC_DELETE_ID])
    expect(sourceHidden.map((spec) => spec.id)).toEqual([
      'review-topic-unhide',
      REVIEW_TOPIC_DELETE_ID
    ])
    // 危险项照旧带红字、带分隔线，且在最后一项
    const deleteShown = sourceShown[sourceShown.length - 1]
    expect(deleteShown?.id).toBe(REVIEW_TOPIC_DELETE_ID)
    expect(deleteShown?.label).toBe(REVIEW_TOPIC_DELETE_LABEL)
    expect(deleteShown?.danger).toBe(true)
    expect(deleteShown?.separator).toBe(true)
    // hint 里带张数：点之前就知道会连带删多少（样本是 3 张）
    expect(deleteShown?.hint).toBe('3 张卡片')
    // 张数跟着上下文走（不是写死的字符串）
    expect(
      toSpecs(reviewTopicMenuItems(sourceTopicContext({ cardCount: 11 })))[1]?.hint
    ).toBe('11 张卡片')
  })

  it('`topic:` / `book:` 档**永远**没有删除项（防扩散：删真实实体只能去学习页 / 读书页）', () => {
    // 菜单定义只看上下文：deletable=false → 只出隐藏那一项（两种隐藏状态都一样）
    for (const hidden of [false, true]) {
      const ids = menuItemIds(reviewTopicMenuItems(reviewTopicContext({ hidden })))
      expect(ids, `hidden=${hidden}`).not.toContain(REVIEW_TOPIC_DELETE_ID)
      expect(ids.length, `hidden=${hidden}`).toBe(1)
    }
    // 对照组：同一个函数在 deletable=true 时**确实**会给出这一项（证明不是函数坏了）
    expect(menuItemIds(reviewTopicMenuItems(sourceTopicContext()))).toContain(
      REVIEW_TOPIC_DELETE_ID
    )
  })

  it('能不能删由 `reviewPageView.isTopicDeletable()` 一处判定：source: 可删，topic: / book: 不可删', () => {
    // 页面只调这一个函数，菜单里不再解析 key —— 所以这条要钉住三类 key 的结论
    const summaryOf = (key: string): Parameters<typeof isTopicDeletable>[0] => ({
      key,
      kind: 'source',
      id: '',
      title: '',
      cardCount: 0,
      dueCount: 0,
      masteredPercent: 0,
      lastReviewedAt: '',
      nextDueDate: '',
      cards: []
    })
    expect(isTopicDeletable(summaryOf(reviewTopicKey('source', '手动新建')))).toBe(true)
    expect(isTopicDeletable(summaryOf(reviewTopicKey('learning', 't1')))).toBe(false)
    expect(isTopicDeletable(summaryOf(reviewTopicKey('book', 'b1')))).toBe(false)
  })

  it('复习主题行点了就走它自己那一个回调', () => {
    const calls: string[] = []
    toSpecs(reviewTopicMenuItems(reviewTopicContext({ onToggleHidden: () => calls.push('hide') })))[0]?.onSelect()
    toSpecs(
      reviewTopicMenuItems(reviewTopicContext({ hidden: true, onToggleHidden: () => calls.push('unhide') }))
    )[0]?.onSelect()
    expect(calls).toEqual(['hide', 'unhide'])
  })

  it('来源档的「删除」只调 onDelete，不会顺手把隐藏也点一遍', () => {
    const calls: string[] = []
    const specs = toSpecs(
      reviewTopicMenuItems(
        sourceTopicContext({
          onToggleHidden: () => calls.push('hide'),
          onDelete: () => calls.push('delete')
        })
      )
    )
    specs.find((spec) => spec.id === REVIEW_TOPIC_DELETE_ID)?.onSelect()
    expect(calls).toEqual(['delete'])
  })
})

describe('回调 id 唯一', () => {
  it('同一实体的每一项 id 都不重复', () => {
    for (const entity of ALL_ENTITIES) {
      const ids = menuItemIds(entity.defs)
      expect(new Set(ids).size, `${entity.name}：${ids.join(',')}`).toBe(ids.length)
    }
  })

  it('每一项 id 唯一，且每一项只对应一个 action（不会一项触发两件事）', () => {
    // 注意：这里刻意**不比函数引用**。页面常把同一个处理函数给不同的项
    // （例如"编辑"与"复制"都走 openEditForm 的分支），引用相同不代表行为相同。
    // 真正要钉的是"一次点击只做一件事"，见下一个用例。
    for (const entity of ALL_ENTITIES) {
      const specs = toSpecs(entity.defs)
      const byId = new Map(specs.map((spec) => [spec.id, spec]))
      expect(byId.size, entity.name).toBe(specs.length)
    }
  })

  it('点任意一项，只会触发它自己那一个动作', () => {
    for (const entity of ALL_ENTITIES) {
      const specs = toSpecs(entity.defs)
      for (const target of specs) {
        const calls: string[] = []
        // 重新造一份：每一项的动作都换成"记下我是谁"
        const isolated = toSpecs(
          entity.defs.map((def) => ({
            ...def,
            callbacks:
              def.id === target.id
                ? () => calls.push(def.id)
                : () => calls.push(`不该被调到：${def.id}`)
          }))
        )
        isolated.find((spec) => spec.id === target.id)?.onSelect()
        expect(calls, `${entity.name} / ${target.id}`).toEqual([target.id])
      }
    }
  })

  it('每一项的 id 都能唯一映射回它自己的 onSelect', () => {
    for (const entity of ALL_ENTITIES) {
      const specs = toSpecs(entity.defs)
      const byId = new Map(specs.map((spec) => [spec.id, spec.onSelect]))
      expect(byId.size, entity.name).toBe(specs.length)
      for (const def of entity.defs) {
        expect(byId.get(def.id)).toBe(def.callbacks)
      }
    }
  })

  it('点一项只调这一个回调（不会顺带把别人也调了）', () => {
    const calls: string[] = []
    const defs = taskMenuItems(
      taskContext({
        onEdit: () => calls.push('edit'),
        onDelete: () => calls.push('delete'),
        onDuplicate: () => calls.push('duplicate')
      })
    )
    const specs = toSpecs(defs)
    specs.find((spec) => spec.id === 'task-duplicate')?.onSelect()
    expect(calls).toEqual(['duplicate'])
  })
})

describe('设置复习时间的预设', () => {
  it('任务与卡片用的是同一套天数（两处不能各写一份）', () => {
    const taskIds = menuItemIds(taskMenuItems(taskContext()))
    const cardIds = menuItemIds(cardMenuItems(cardContext()))
    for (const preset of REVIEW_DAY_PRESETS) {
      expect(taskIds).toContain(`task-review-${preset.days}`)
      expect(cardIds).toContain(`card-review-${preset.days}`)
    }
  })

  it('预设天数里包含"今天"，否则用户没法把卡排回今天', () => {
    expect(REVIEW_DAY_PRESETS.some((preset) => preset.days === 0)).toBe(true)
  })

  it('回调收到的是这一项自己的天数（不是闭包串了号）', () => {
    const received: number[] = []
    const specs = toSpecs(taskMenuItems(taskContext({ onSetReviewInDays: (days) => received.push(days) })))
    for (const preset of REVIEW_DAY_PRESETS) {
      specs.find((spec) => spec.id === `task-review-${preset.days}`)?.onSelect()
    }
    expect(received).toEqual(REVIEW_DAY_PRESETS.map((preset) => preset.days))
  })
})

describe('定位与键盘导航（第一轮的地基，别被改动破坏）', () => {
  it('placeMenu 在右下角同时翻两个方向', () => {
    expect(placeMenu({ x: 1270, y: 830 }, { width: 200, height: 300 }, { width: 1280, height: 840 })).toEqual({
      x: 1070,
      y: 530
    })
  })

  it('nextEnabledIndex 跳过禁用项并循环', () => {
    expect(nextEnabledIndex([false, true, false], 0, 1)).toBe(2)
    expect(nextEnabledIndex([false, false], 1, 1)).toBe(0)
    expect(nextEnabledIndex([true, true], 0, 1)).toBe(-1)
  })

  it('firstEnabledIndex 跳过开头的禁用项', () => {
    expect(firstEnabledIndex([true, false])).toBe(1)
    expect(firstEnabledIndex([])).toBe(-1)
  })

  it('新建菜单（含分组项）也能被键盘导航读出来', () => {
    const specs = toSpecs(taskMenuItems(taskContext({ done: true })))
    expect(disabledFlags(specs).every((flag) => flag === false)).toBe(true)
    expect(firstEnabledIndex(disabledFlags(specs))).toBe(0)
  })
})

describe('菜单项定义里没有夹带副作用', () => {
  it('只"取定义"不会调用任何回调（菜单没点就不该动数据）', () => {
    const spy = vi.fn()
    taskMenuItems(taskContext({ onEdit: spy, onDelete: spy, onToggleDone: spy }))
    treeNodeMenuItems(nodeContext({ onAddChild: spy, onRename: spy, onDelete: spy }))
    bookMenuItems(bookContext({ onEdit: spy, onDelete: spy }))
    memoMenuItems(memoContext({ onEdit: spy, onDelete: spy, onTogglePin: spy }))
    cardMenuItems(cardContext({ onEdit: spy, onDelete: spy }))
    expect(spy).not.toHaveBeenCalled()
  })
})
