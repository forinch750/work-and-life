/**
 * 中区列表行的菜单项 = 树里同一行的菜单项（2026-10 修订）
 *
 * ## 为什么专门测这个
 *
 * 用户提的原始问题是：「学习中添加的资料无法删除」「复习的卡片无法删除」——
 * 删除入口只在**树**里，而中区那张列表卡是最显眼的位置（以前那张卡上
 * 一个 `button` 都没有）。补入口时最容易走的歪路是"在页面里再写一份数组"，
 * 那样一定会漂移成"树里有删除、列表里没有"。
 *
 * 所以这里钉两件事：
 *   1. **逐项 id 与文案比对**：中区入口与树里入口取到的是同一批项
 *   2. **条件项按状态切换**：`root` / `summary` / `done` 三个字段决定
 *      出现哪一条、能不能点（与树里完全同一套判据）
 *
 * ## 口径修订（修改 2 轮 · 2026-10）
 *
 * 树里新增了四个移动动作（上移 / 下移 / 升一级 / 降一级），而**中区刻意不要这四项**：
 * 中区那张卡是**扁平的资料列表**，里面没有"上一个兄弟""上一层"这些概念，
 * 层级移动只在树里有意义。所以断言从
 *
 *     中区行菜单 ≡ 树里行菜单
 *
 * 改成
 *
 *     中区行菜单 ≡ 树里行菜单中**适用于列表视图的那些**
 *
 * 并**新增一条**「树里比中区多出的项，正好是那 4 个移动项」，
 * 把"差异只有这四项"也钉住（否则以后少一项、多一项都能悄悄过关）。
 *
 * 菜单项本身的定义在 `src/shared/contextMenu.ts`（唯一一份）；
 * 这里测的是"两个入口翻译出来的结果"。
 */
import { describe, expect, it, vi } from 'vitest'
import {
  NODE_MEASURE_LABEL,
  NODE_MOVE_LABELS,
  cardMenuItems,
  dueCardRowMenuItems,
  menuItemIds,
  resourceRowMenuItems,
  toSpecs,
  treeNodeMenuFromActions,
  type CardMenuContext,
  type ResourceRowMenuContext
} from '../../src/shared/contextMenu'
import { disabledFlags } from '../../src/shared/menuItems'
import { moveStepsOf } from '../../src/shared/treeMove'
import type { TreeViewItem } from '../../src/shared/treeView'

const noop = (): void => undefined

/** 中区那份是**扁平**列表，树里则是一整棵树 —— 四个移动项只可能在树里出现 */
const MOVE_IDS = ['node-move-up', 'node-move-down', 'node-promote', 'node-demote']

/** 树里那一行（资料 = 根节点） */
function treeItem(overrides: Partial<TreeViewItem> = {}): TreeViewItem {
  return { id: 'res-1', parentId: null, order: 0, title: '资料A', done: false, ...overrides }
}

/**
 * 树里那份「资料」行所在的整棵树。
 *
 * 必须给全，因为四个移动动作的可用性取决于**兄弟表**：
 * `res-1` 是第一个 → 上移禁用；后面还有 `res-2` → 下移可用。
 */
function treeItems(): TreeViewItem[] {
  return [
    { id: 'res-1', parentId: null, order: 0, title: '资料A', done: false },
    { id: 'res-2', parentId: null, order: 1, title: '资料B', done: false },
    { id: 'ch-1', parentId: 'res-1', order: 0, title: '第一章', done: false },
    { id: 'ch-2', parentId: 'res-1', order: 1, title: '第二章', done: false }
  ]
}

/** `TreeView` 交给页面的那一份 `TreeMenuActions`（含四个移动动作，与真实组件同一套算法） */
function treeActions(item: TreeViewItem, hasChildren: boolean) {
  return {
    addChild: noop,
    rename: noop,
    remove: noop,
    toggleDone: noop,
    toggleExpand: noop,
    moves: moveStepsOf(treeItems(), item.id),
    moveTo: noop,
    isSummary: () => hasChildren
  }
}

/** 中区「资料」行的一行 */
function resourceRow(overrides: Partial<ResourceRowMenuContext> = {}): ResourceRowMenuContext {
  return {
    title: '资料A',
    done: false,
    hasChildren: false,
    expanded: false,
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

/** 卡片的一行（树里与中区用的是同一个形状） */
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

/** 树里资料行的菜单项（走 `TreeView` 的那条路） */
function treeResourceIds(hasChildren: boolean, expanded: boolean): string[] {
  const item = treeItem()
  return menuItemIds(
    treeNodeMenuFromActions(item, treeActions(item, hasChildren), {
      expanded,
      onEditMeasure: noop,
      onEditNote: noop
    })
  )
}

/** 中区资料行的菜单项（走列表卡的那条路） */
function bandResourceIds(hasChildren: boolean, expanded: boolean): string[] {
  return menuItemIds(resourceRowMenuItems(resourceRow({ hasChildren, expanded })))
}

/** 树里那一批项里"适用于列表视图的那些"（= 去掉四个移动项） */
function listViewOf(treeIds: string[]): string[] {
  return treeIds.filter((id) => !MOVE_IDS.includes(id))
}

describe('中区「资料」行的菜单项 = 树里资料行里适用于列表视图的那些', () => {
  it('最小单元（没有子节点）：去掉四个移动项后与树里逐项相同', () => {
    expect(bandResourceIds(false, false)).toEqual(listViewOf(treeResourceIds(false, false)))
  })

  it('汇总节点（有子节点）+ 已展开：去掉四个移动项后与树里逐项相同', () => {
    expect(bandResourceIds(true, true)).toEqual(listViewOf(treeResourceIds(true, true)))
  })

  it('树里比中区多出的项，正好是那 4 个移动项（不多不少）', () => {
    // 这是本轮**改写**的那条断言的新增部分：差异必须**恰好**是这四项，
    // 否则以后漏一项 / 多一项都会被"过滤掉再比"蒙过去
    const treeIds = treeResourceIds(true, true)
    const bandIds = bandResourceIds(true, true)
    const extra = treeIds.filter((id) => !bandIds.includes(id))
    expect(extra).toEqual(MOVE_IDS)
    // 反方向：中区不许有树里没有的项
    expect(bandIds.filter((id) => !treeIds.includes(id))).toEqual([])
  })

  it('四个移动项在中区一个都不出现（扁平列表里做层级移动没有意义）', () => {
    const specs = toSpecs(resourceRowMenuItems(resourceRow({ hasChildren: true })))
    for (const id of MOVE_IDS) {
      expect(specs.find((item) => item.id === id), id).toBeUndefined()
    }
  })

  it('文案也逐项相同（不只是 id）', () => {
    const item = treeItem()
    const band = toSpecs(resourceRowMenuItems(resourceRow({ hasChildren: true, expanded: true })))
    const tree = toSpecs(
      treeNodeMenuFromActions(item, treeActions(item, true), {
        expanded: true,
        onEditMeasure: noop,
        onEditNote: noop
      })
    ).filter((spec) => !MOVE_IDS.includes(spec.id))
    expect(band.map((item) => item.label)).toEqual(tree.map((item) => item.label))
    expect(band.map((item) => item.danger === true)).toEqual(tree.map((item) => item.danger === true))
    expect(band.map((item) => item.disabled === true)).toEqual(tree.map((item) => item.disabled === true))
  })

  it('中区资料行一定有「删除」，且是危险项（用户提的第一个问题的入口）', () => {
    const specs = toSpecs(resourceRowMenuItems(resourceRow()))
    const remove = specs.find((item) => item.id === 'node-delete')
    expect(remove).toBeDefined()
    expect(remove?.danger).toBe(true)
    expect(remove?.disabled).not.toBe(true)
  })

  it('资料行的菜单项里含「改占比」（root 条件项），与树里一致', () => {
    const ids = menuItemIds(resourceRowMenuItems(resourceRow()))
    expect(ids).toContain('node-measure')
  })

  it('中区资料行发出的回调就是它自己那一个（不会串到树里那一份）', () => {
    const calls: string[] = []
    const specs = toSpecs(
      resourceRowMenuItems(
        resourceRow({
          onDelete: () => calls.push('band-delete'),
          onRename: () => calls.push('band-rename'),
          onEditMeasure: () => calls.push('band-measure')
        })
      )
    )
    specs.find((item) => item.id === 'node-delete')?.onSelect()
    expect(calls).toEqual(['band-delete'])
  })
})

describe('树里那四项移动动作：文案、可用性、以及"用不了就说明原因"', () => {
  /** 取树里某一行那四项的 spec（走真实算法：`moveStepsOf`） */
  function moveSpecs(itemId: string) {
    const item = treeItems().find((candidate) => candidate.id === itemId) as TreeViewItem
    const specs = toSpecs(
      treeNodeMenuFromActions(item, treeActions(item, false), {
        expanded: false,
        onEditMeasure: noop,
        onEditNote: noop
      })
    )
    return {
      ids: specs.map((spec) => spec.id),
      byId: new Map(specs.map((spec) => [spec.id, spec]))
    }
  }

  it('四项都叫「上移 / 下移 / 升一级 / 降一级」，且都在同一组里', () => {
    const { ids, byId } = moveSpecs('res-1')
    expect(ids).toEqual(expect.arrayContaining(MOVE_IDS))
    expect(byId.get('node-move-up')?.label).toBe(NODE_MOVE_LABELS.up)
    expect(byId.get('node-move-down')?.label).toBe(NODE_MOVE_LABELS.down)
    expect(byId.get('node-promote')?.label).toBe(NODE_MOVE_LABELS.promote)
    expect(byId.get('node-demote')?.label).toBe(NODE_MOVE_LABELS.demote)
    for (const id of MOVE_IDS) expect(byId.get(id)?.group).toBe('移动')
  })

  it('资料（顶层、第一个）：上移 / 升一级 / 降一级 都禁用，且每个都带原因', () => {
    const { byId } = moveSpecs('res-1')
    expect(byId.get('node-move-up')?.disabled).toBe(true)
    expect(byId.get('node-move-up')?.hint).toContain('最上面')
    expect(byId.get('node-promote')?.disabled).toBe(true)
    expect(byId.get('node-promote')?.hint).toContain('顶层')
    // 学习树的顶层是"资料"：降成章节会让层级语义乱掉
    expect(byId.get('node-demote')?.disabled).toBe(true)
    expect(byId.get('node-demote')?.hint).toContain('不能降级')
    // 下移可用（后面还有 res-2），**用不了的项也不会从菜单里消失**
    expect(byId.get('node-move-down')?.disabled).not.toBe(true)
    expect(byId.get('node-move-down')?.hint).toBeUndefined()
  })

  it('章（有父级、有上一个兄弟）：上移 / 升一级 / 降一级 都可用', () => {
    const { byId } = moveSpecs('ch-2')
    expect(byId.get('node-move-up')?.disabled).not.toBe(true)
    expect(byId.get('node-promote')?.disabled).not.toBe(true)
    expect(byId.get('node-demote')?.disabled).not.toBe(true)
    // 它已经是这一层的最后一个
    expect(byId.get('node-move-down')?.disabled).toBe(true)
    expect(byId.get('node-move-down')?.hint).toContain('最下面')
  })

  it('点了「下移」只会把目标位置交回去（落库仍由页面的 onMove 做）', () => {
    const item = treeItems().find((candidate) => candidate.id === 'res-1') as TreeViewItem
    const calls: Array<{ parentId: string | null; index: number }> = []
    const specs = toSpecs(
      treeNodeMenuFromActions(
        item,
        { ...treeActions(item, false), moveTo: (target) => calls.push(target) },
        { expanded: false, onEditMeasure: noop, onEditNote: noop }
      )
    )
    specs.find((spec) => spec.id === 'node-move-down')?.onSelect()
    expect(calls).toEqual([{ parentId: null, index: 1 }])
  })
})

describe('中区「今天到期的卡片」行的菜单项 = 树里卡片行的菜单项', () => {
  it('未排复习时间：中区这条路径与定义文件里那一份逐项相同（适配层 0 个新增项）', () => {
    const context = cardContext({ scheduled: false })
    expect(menuItemIds(dueCardRowMenuItems(context))).toEqual(menuItemIds(cardMenuItems(context)))
  })

  it('已排复习时间：同样逐项相同', () => {
    const context = cardContext({ scheduled: true })
    expect(menuItemIds(dueCardRowMenuItems(context))).toEqual(menuItemIds(cardMenuItems(context)))
  })

  it('文案也逐项相同', () => {
    const context = cardContext({ scheduled: true })
    expect(toSpecs(dueCardRowMenuItems(context)).map((item) => item.label)).toEqual(
      toSpecs(cardMenuItems(context)).map((item) => item.label)
    )
  })

  it('中区卡片行一定有「删除」，且是危险项（用户提的第二个问题的入口）', () => {
    const specs = toSpecs(dueCardRowMenuItems(cardContext()))
    const remove = specs.find((item) => item.id === 'card-delete')
    expect(remove).toBeDefined()
    expect(remove?.danger).toBe(true)
  })

  it('中区卡片行的菜单含「设置复习时间」的四个预设与「看历史」', () => {
    const ids = menuItemIds(dueCardRowMenuItems(cardContext()))
    expect(ids).toEqual(
      expect.arrayContaining(['card-edit', 'card-copy', 'card-view-history', 'card-delete'])
    )
    expect(ids).toEqual(
      expect.arrayContaining([
        'card-review-0',
        'card-review-1',
        'card-review-3',
        'card-review-7'
      ])
    )
  })

  it('中区卡片行发出的回调就是它自己那一个', () => {
    const calls: string[] = []
    const specs = toSpecs(
      dueCardRowMenuItems(
        cardContext({ onDelete: () => calls.push('card-delete'), onEdit: () => calls.push('edit') })
      )
    )
    specs.find((item) => item.id === 'card-delete')?.onSelect()
    expect(calls).toEqual(['card-delete'])
  })
})

describe('中区行菜单的条件项：状态对了才取到对的那一条', () => {
  it('root：资料行永远有「改占比 / 改页码」，且文案与定义里那一个相同', () => {
    const spec = toSpecs(resourceRowMenuItems(resourceRow())).find(
      (item) => item.id === 'node-measure'
    )
    expect(spec?.label).toBe(NODE_MEASURE_LABEL)
  })

  it('summary：有子节点时「标记完成」被禁用并带提示（与树里那格只读的勾一致）', () => {
    const summary = toSpecs(resourceRowMenuItems(resourceRow({ hasChildren: true })))
    const leaf = toSpecs(resourceRowMenuItems(resourceRow({ hasChildren: false })))
    const indexOf = (specs: typeof summary, id: string): number =>
      specs.findIndex((item) => item.id === id)
    expect(disabledFlags(summary)[indexOf(summary, 'node-mark-done')]).toBe(true)
    expect(disabledFlags(leaf)[indexOf(leaf, 'node-mark-done')]).toBe(false)
    expect(summary.find((item) => item.id === 'node-mark-done')?.hint).toContain('汇总节点')
  })

  it('done：未完成只有「标记完成」，已完成只有「标记未完成」（中区分支同树）', () => {
    const pending = menuItemIds(resourceRowMenuItems(resourceRow({ done: false })))
    const finished = menuItemIds(resourceRowMenuItems(resourceRow({ done: true })))
    expect(pending).toContain('node-mark-done')
    expect(pending).not.toContain('node-mark-undone')
    expect(finished).toContain('node-mark-undone')
    expect(finished).not.toContain('node-mark-done')
  })

  it('expanded：子节点展开与否换「展开 / 折叠」的文案（面板开不开与它无关）', () => {
    const collapsed = resourceRowMenuItems(resourceRow({ expanded: false })).find(
      (item) => item.id === 'node-toggle-expand'
    )
    const expanded = resourceRowMenuItems(resourceRow({ expanded: true })).find(
      (item) => item.id === 'node-toggle-expand'
    )
    expect(collapsed?.label).toBe('展开')
    expect(expanded?.label).toBe('折叠')
  })

  it('scheduled：排过复习时间的卡片才出现「清空复习时间」一侧', () => {
    const off = menuItemIds(dueCardRowMenuItems(cardContext({ scheduled: false })))
    const on = menuItemIds(dueCardRowMenuItems(cardContext({ scheduled: true })))
    // 这一项在 `cardMenuItems` 里是无条件存在的（清空 = 把到期日设回今天），
    // 所以两个状态都有它；这里钉的是"两个状态取到的 id 集合完全相同"，
    // 也就是适配层没有偷偷按状态增删项。
    expect(on).toEqual(off)
  })
})

describe('中区行菜单不许夹带副作用', () => {
  it('只"取定义"不会调用任何回调（菜单没点就不该动数据）', () => {
    const spy = vi.fn()
    resourceRowMenuItems(
      resourceRow({
        onAddChild: spy,
        onRename: spy,
        onDelete: spy,
        onToggleDone: spy,
        onToggleExpand: spy,
        onEditMeasure: spy,
        onEditNote: spy
      })
    )
    dueCardRowMenuItems(
      cardContext({
        onEdit: spy,
        onDelete: spy,
        onSetReviewInDays: spy,
        onClearReview: spy,
        onViewHistory: spy,
        onCopy: spy
      })
    )
    expect(spy).not.toHaveBeenCalled()
  })

  it('中区行与树里行都不会出现重复 id（两份定义漂移会直接抛错）', () => {
    const ids = menuItemIds(resourceRowMenuItems(resourceRow({ hasChildren: true })))
    expect(new Set(ids).size).toBe(ids.length)
  })
})
