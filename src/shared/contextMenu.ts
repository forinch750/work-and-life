/**
 * 右键菜单的纯逻辑 + **全量菜单项定义**（第二轮 FEAT-001）
 *
 * ## 一、菜单项只定义一次（`MASTER.md` §6.2 的硬要求）
 *
 * 每个实体（任务 / 日历项、树节点、资料 / 书、备忘、卡片）的菜单项
 * **只在这个文件里定义一份**；`⋯` 小菜单与右键菜单都从这里取，因此
 * "右键里有删除、`⋯` 里没有"这种两处不同步从源头不可能发生。
 *
 * 判定"条件项"（标记完成 / 标记未完成、置顶 / 取消置顶）也在这里做：
 * 定义里带 `when`，由当前实体状态决定显示哪一条、文案是什么。
 * 界面侧只负责把 `onSelect` 接到自己的写数据函数上。
 *
 * ## 三、中区列表行也走这里（2026-10 修订）
 *
 * 学习页「资料」卡与复习页「今天到期的卡片」卡的每一行，以前是**纯展示**
 * （0 个按钮），删除入口只在树里，用户找不到。补入口时**没有**在页面里
 * 另写一份菜单项数组，而是走了本文件末尾的两个适配函数：
 *
 *   - `resourceRowMenuItems` → 复用 `treeNodeMenuItems`（资料就是树的根节点）
 *   - `dueCardRowMenuItems`  → 复用 `cardMenuItems`
 *
 * 中区行与树里行因此取到**完全相同**的一批项，由
 * `tests/shell/bandRowMenus.test.ts` 逐项 id 比对钉住。
 *
 * ## 二、定位与键盘导航（第一轮就在这里的纯算法）
 *
 *   - 靠近屏幕右/下边缘时要把菜单翻到另一侧，否则菜单会跑到窗口外面点不到
 *   - 键盘上下移动要跳过禁用项，并在首尾之间循环
 * 这两件事都容易写错，而且错了以后"看起来能用、偶尔点不到"，所以抽出来单测。
 *
 * 界面绑定见 src\renderer\shell\ContextMenu.tsx。
 */
import type { MenuItemSpec } from './menuItems'
import { RECURRENCE_LABELS, timeSlotWeight, type RecurrenceType, type TimeSlot } from './plan'
import type { MoveStep, MoveTarget } from './treeMove'
import type { TreeViewItem } from './treeView'

export interface MenuPoint {
  x: number
  y: number
}

export interface MenuSize {
  width: number
  height: number
}

export interface Viewport {
  width: number
  height: number
}

/** 菜单与窗口边缘之间至少留出的空隙 */
export const MENU_MARGIN = 6

/**
 * 计算菜单应该出现在哪里。
 *
 * 默认放在触发点右下方；如果会超出窗口，就翻到左/上侧；
 * 如果两侧都放不下（窗口比菜单还小），则夹到可视范围内，
 * 保证菜单整体可见、可点——宁可贴边，也不能跑到窗口外。
 */
export function placeMenu(point: MenuPoint, size: MenuSize, viewport: Viewport): MenuPoint {
  const maxX = viewport.width - size.width - MENU_MARGIN
  const maxY = viewport.height - size.height - MENU_MARGIN

  // 右方放不下就翻到左边（以触发点为右边界）
  let x = point.x + size.width + MENU_MARGIN > viewport.width ? point.x - size.width : point.x
  // 下方放不下就翻到上边（以触发点为下边界）
  let y = point.y + size.height + MENU_MARGIN > viewport.height ? point.y - size.height : point.y

  // 夹到可视范围；窗口极小时 maxX/maxY 可能小于 MENU_MARGIN，此时至少保证不小于 0
  x = Math.max(MENU_MARGIN, Math.min(x, Math.max(MENU_MARGIN, maxX)))
  y = Math.max(MENU_MARGIN, Math.min(y, Math.max(MENU_MARGIN, maxY)))

  return { x: Math.round(x), y: Math.round(y) }
}

/**
 * 键盘移动时下一个可选项的下标。
 *
 * 规则：跳过禁用项；到头之后循环；全是禁用项时返回 -1（不移动）。
 * direction 为 1 向下、-1 向上。
 */
export function nextEnabledIndex(
  disabled: boolean[],
  current: number,
  direction: 1 | -1
): number {
  const total = disabled.length
  if (total === 0) return -1

  // 从当前位置出发绕一圈找下一个可用项
  let index = current
  for (let step = 0; step < total; step += 1) {
    index = (index + direction + total) % total
    if (disabled[index] !== true) return index
  }
  return -1
}

/**
 * 首次打开菜单时的默认高亮项：
 * 从上往下第一个可用项；没有可用项则 -1。
 */
export function firstEnabledIndex(disabled: boolean[]): number {
  for (let index = 0; index < disabled.length; index += 1) {
    if (disabled[index] !== true) return index
  }
  return -1
}

// ===========================================================================
// 菜单项定义（五类实体，唯一一份）
// ===========================================================================

/**
 * 菜单项的书写形态。
 *
 * 比渲染用的 `MenuItemSpec` 多两件东西：
 *   - `group`：分组标题（"时段"、"重复"）。同一组的项共享一个标题，
 *     标题只在组里第一项上写一次，渲染时前面加一条分隔线
 *   - `separator`：在这一项**之前**画一条分隔线（用于"危险操作"单独一组）
 * `callbacks` 里的函数直接成为界面上的 `onSelect`，所以两种入口拿到的是同一批函数。
 */
export interface MenuItemDef {
  id: string
  label: string
  danger?: boolean
  disabled?: boolean
  hint?: string
  /** 这一项属于哪个分组（同组同标题；渲染时只在首项上画标题） */
  group?: string
  /** 在这一项之前画一条分隔线 */
  separator?: boolean
  callbacks: () => void
}

/** 把定义数组变成界面要的 `MenuItemSpec[]`（两种入口共用这一条转换） */
export function toSpecs(defs: MenuItemDef[]): MenuItemSpec[] {
  const seen = new Set<string>()
  const specs: MenuItemSpec[] = []
  for (const def of defs) {
    if (seen.has(def.id)) {
      // 定义里出现重复 id 说明"两份定义漂移了"或写错了；这里直接暴露出来，
      // 而不是让界面上出现两个长得一样、行为不同的项。
      throw new Error(`菜单项 id 重复：${def.id}`)
    }
    seen.add(def.id)
    specs.push({
      id: def.id,
      label: def.label,
      ...(def.danger === true ? { danger: true } : {}),
      ...(def.disabled === true ? { disabled: true } : {}),
      ...(def.hint === undefined ? {} : { hint: def.hint }),
      ...(def.group === undefined ? {} : { group: def.group }),
      ...(def.separator === true ? { separator: true } : {}),
      onSelect: def.callbacks
    })
  }
  return specs
}

/** 供单测与验收：取这批定义的 id（顺序一致，便于比对两种入口） */
export function menuItemIds(defs: MenuItemDef[]): string[] {
  return defs.map((def) => def.id)
}

/** 供单测与验收：按 id 找一项 */
export function findMenuItem(defs: MenuItemDef[], id: string): MenuItemDef | undefined {
  return defs.find((def) => def.id === id)
}

/** 判断一个 id 前缀是否属于某类实体（"回调 id 唯一"的检查要用） */
export const MENU_ID_PREFIX = {
  task: 'task',
  node: 'node',
  book: 'book',
  memo: 'memo',
  card: 'card',
  reviewTopic: 'review-topic'
} as const

// ---------------------------------------------------------------- 任务 / 日历项

export interface TaskMenuContext {
  /**
   * 已完成 → 显示"标记未完成"，未完成 → 显示"标记已完成"。
   * 这是**条件项**：同一次只出现一条，文案随状态变。
   */
  done: boolean
  /**
   * 已放弃（修改 4 轮）：**未放弃 → 「放弃这项」；已放弃 → 「恢复为未完成」**，
   * 同一套条件项写法（与 `done` / 树节点打勾一致）。
   *
   * 放弃是**手动**的第三态，与自动算的"逾期"无关（用户原话：
   * *"我要能手动添加未完成和放弃两个选项（和逾期功能不相关）"*）。
   */
  abandoned: boolean
  /** 当前任务的重复规则（"重复"那一组里把当前项标出来） */
  recurrence: RecurrenceType
  /** 当前任务的时段（"时段"那一组里把当前项标出来） */
  timeSlot: TimeSlot
  /** 已经排过复习时间（有 dueDate）→ 多出一条"清空复习时间" */
  reviewScheduled: boolean
  /**
   * 已经手动标成「未完成」了（`held: true`，修改 5 轮）。
   *
   * **条件项**：未钉住 → 「标记未完成（不自动搬动）」；已钉住 → 「取消未完成标记」。
   * 与 `done` / `abandoned` 一样是"同一次只出现一条、文案随状态变"的写法
   * （照 `node-mark-done` 那套）。
   */
  held: boolean
  /** 正在查看的是哪一天（YYYY-MM-DD），"挪到今天 / 挪到明天"按它算 */
  today: string
  /** 明天（由调用方用 shared/date 算好，避免这里再写一份日期逻辑） */
  tomorrow: string
  onEdit: () => void
  onDelete: () => void
  onDuplicate: () => void
  onToggleDone: () => void
  /** 放弃 / 恢复（同一个回调：按当前状态取反，页面不各写一份判断） */
  onToggleAbandon: () => void
  /** 调整时间：打开起始/结束时间与时段 */
  onAdjustTime: () => void
  onChangeSlot: (slot: TimeSlot) => void
  onChangeRecurrence: (rule: RecurrenceType) => void
  /** 设置复习时间（下一天复习）；days 为距今天数 */
  onSetReviewInDays: (days: number) => void
  onClearReview: () => void
  /** 挪到某一天 */
  onMoveTo: (dateKey: string) => void
  /** 标记 / 取消「未完成」（钉住 = 批量移动跳过它） */
  onToggleHold: () => void
  /**
   * 打开"移动到指定日期…"的小抽屉（**逐条**移动）。
   *
   * 与 `onMoveTo` 的区别：`onMoveTo` 是"今天就 / 明天就"这两个预设；
   * 这一项是用户自己挑任意一天。**不受 `held` 限制**——用户单独点它就是要动。
   */
  onMoveToDate: () => void
}

/** 复习时间预设（卡片与任务共用同一套天数） */
export const REVIEW_DAY_PRESETS: Array<{ days: number; label: string }> = [
  { days: 0, label: '今天' },
  { days: 1, label: '明天' },
  { days: 3, label: '3 天后' },
  { days: 7, label: '7 天后' }
]

/**
 * 「未完成」（钉住）那两条条件项的文案（**唯一一份**）。
 *
 * 用户原话（修改 5 轮）：「未完成要手动标记，标记后就显示未完成就行」
 *                 「我手动标记未完成的不移动（除非我手动移动）」。
 *
 * 所以：**不发明"已钉住"这种词**——菜单与行上标签都说「未完成」。
 */
export const TASK_HOLD_LABEL = '标记未完成（不自动搬动）'
export const TASK_UNHOLD_LABEL = '取消未完成标记'
/** 点之前就说清后果：批量移动会跳过它（不是"删掉它"） */
export const TASK_HOLD_HINT = '批量移动会跳过它'
/** 逐条移动到任意一天（与"挪到今天 / 挪到明天"并存，不是替代它们） */
export const TASK_MOVE_TO_LABEL = '移动到指定日期…'

const SLOT_LABELS: Array<{ slot: TimeSlot; label: string }> = [
  { slot: 'none', label: '全天' },
  { slot: 'morning', label: '上午' },
  { slot: 'afternoon', label: '下午' },
  { slot: 'evening', label: '晚上' }
]

/**
 * 任务 / 日历项的菜单项。
 *
 * "标记完成 / 未完成"、"**放弃 / 恢复**"、"**标记未完成 / 取消未完成标记**"与
 * "清空复习时间"都是**条件项**：同一次只出现一条，文案随状态变，
 * 因此不会出现"两个菜单项映射到同一个动作"。
 *
 * 「未完成」标记与「移动到指定日期…」只长在**未完成的任务**上（修改 5 轮）：
 * 已完成 / 已放弃的任务既不参与批量移动，也不该被打上这个标。
 *
 * 放弃那一项排在最末（`separator` + `danger`）：它是"这件事我不做了"，
 * 与「删除」同属危险收尾，但**不是删除**——数据还在，能在「全部」里恢复。
 */
export function taskMenuItems(ctx: TaskMenuContext): MenuItemDef[] {
  const defs: MenuItemDef[] = [
    { id: 'task-edit', label: '编辑', callbacks: ctx.onEdit },
    { id: 'task-duplicate', label: '复制', callbacks: ctx.onDuplicate },
    {
      id: ctx.done ? 'task-mark-undone' : 'task-mark-done',
      label: ctx.done ? '标记未完成' : '标记完成',
      callbacks: ctx.onToggleDone
    },
    /**
     * 「未完成」标记 + 逐条移动到任意一天（修改 5 轮）。
     *
     * **只在"未完成"的任务上出现**：已完成 / 已放弃的任务本来就不参与批量移动，
     * 给出「标记未完成」只会自相矛盾（`normalizePlanTask` 还会把 held 清掉）。
     * 都不是危险操作，因此**不标 `danger`**、也不画分隔线。
     */
    ...(ctx.done || ctx.abandoned
      ? []
      : [
          {
            id: ctx.held ? 'task-unhold' : 'task-hold',
            label: ctx.held ? TASK_UNHOLD_LABEL : TASK_HOLD_LABEL,
            ...(ctx.held ? {} : { hint: TASK_HOLD_HINT }),
            callbacks: ctx.onToggleHold
          } satisfies MenuItemDef,
          {
            id: 'task-move-to',
            label: TASK_MOVE_TO_LABEL,
            callbacks: ctx.onMoveToDate
          } satisfies MenuItemDef
        ]),
    { id: 'task-move-today', label: '挪到今天', callbacks: () => ctx.onMoveTo(ctx.today) },
    { id: 'task-move-tomorrow', label: '挪到明天', callbacks: () => ctx.onMoveTo(ctx.tomorrow) },
    {
      id: 'task-adjust-time',
      label: '调整时间',
      separator: true,
      callbacks: ctx.onAdjustTime
    },
    ...(ctx.reviewScheduled
      ? [
          {
            id: 'task-clear-review',
            label: '清空复习时间',
            separator: true,
            callbacks: ctx.onClearReview
          } satisfies MenuItemDef
        ]
      : []),
    // 第三态「放弃」：未放弃 → 放弃这项；已放弃 → 恢复为未完成
    ...(ctx.abandoned
      ? [
          {
            id: 'task-restore',
            label: '恢复为未完成',
            separator: true,
            callbacks: ctx.onToggleAbandon
          } satisfies MenuItemDef
        ]
      : [
          {
            id: 'task-abandon',
            label: '放弃这项',
            danger: true,
            separator: true,
            callbacks: ctx.onToggleAbandon
          } satisfies MenuItemDef
        ]),
    { id: 'task-delete', label: '删除', danger: true, separator: true, callbacks: ctx.onDelete }
  ]

  for (const preset of REVIEW_DAY_PRESETS) {
    defs.push({
      id: `task-review-${preset.days}`,
      label: preset.label,
      group: '设置复习时间',
      callbacks: () => ctx.onSetReviewInDays(preset.days)
    })
  }

  for (const item of SLOT_LABELS) {
    defs.push({
      id: `task-slot-${item.slot}`,
      label: item.label,
      ...(ctx.timeSlot === item.slot ? { hint: '当前' } : {}),
      group: '时段',
      callbacks: () => ctx.onChangeSlot(item.slot)
    })
  }

  for (const rule of Object.keys(RECURRENCE_LABELS) as RecurrenceType[]) {
    defs.push({
      id: `task-recurrence-${rule}`,
      label: RECURRENCE_LABELS[rule],
      ...(ctx.recurrence === rule ? { hint: '当前' } : {}),
      group: '重复',
      callbacks: () => ctx.onChangeRecurrence(rule)
    })
  }

  // 时段项按界面习惯排序（上午 → 下午 → 晚上 → 全天）
  const slotDefs = defs.filter((def) => def.group === '时段')
  const others = defs.filter((def) => def.group !== '时段')
  slotDefs.sort(
    (a, b) =>
      timeSlotWeight(a.id.replace('task-slot-', '') as TimeSlot) -
      timeSlotWeight(b.id.replace('task-slot-', '') as TimeSlot)
  )
  return [...others, ...slotDefs]
}

// -------------------------------------------------------------------- 树节点

/**
 * 四个显式移动动作（2026-10 修订 · 修改 2 轮）。
 *
 * ## 为什么要有这一组
 *
 * 用户原话：「树里面建立的分支**无法移动**，只能删除重写，能不能主动使分支
 * 往上移动或往下移动，**从 1.1 变成 1**」。
 * 拖拽其实一直有，但它要求抓住那个小抓手、而且**菜单里一个入口都没有**——
 * 用户于是合理地以为"这个功能不存在，只能删掉重建"。
 *
 * ## 为什么不可用时是"禁用 + 原因"而不是"不显示"
 *
 * 这正是本轮要修的病：**看不见 = 以为没有**。所以四个动作**永远都在**，
 * 只是此刻用不了的会灰掉，并在右边显示一句原因（"已经在最上面"）。
 */
export const NODE_MOVE_GROUP = '移动'

export const NODE_MOVE_LABELS = {
  up: '上移',
  down: '下移',
  promote: '升一级',
  demote: '降一级'
} as const

/**
 * 树节点菜单要的四个移动动作。
 *
 * `up` / `down` / `promote` / `demote` 的可用性与原因由 `shared/treeMove.ts`
 * 的 `moveStepsOf()` 算好（纯逻辑、有单测）；`moveTo` 把目标位置交回页面，
 * 落库**复用拖拽那条路**（`onMove` → `buildMovePatches`），不新写一套。
 */
export interface TreeNodeMoves {
  up: MoveStep
  down: MoveStep
  promote: MoveStep
  demote: MoveStep
  moveTo: (target: MoveTarget) => void
}

export interface TreeNodeMenuContext {
  title: string
  /** 有子节点 = 汇总节点（不参与计数，勾不可点） */
  summary: boolean
  done: boolean
  expanded: boolean
  /** 顶层节点（资料 / 书 / 顶层章）：能改占比、改页码 */
  root: boolean
  /**
   * 四个移动动作。
   *
   * **不给就不出这四项** —— 中区「资料」列表是**扁平视图**，
   * 里面没有"上一个兄弟""上一层"这些概念，做层级移动没有意义
   * （`resourceRowMenuItems` 就是靠不传它来过滤的，见文件末尾）。
   */
  moves?: TreeNodeMoves
  onAddChild: () => void
  onRename: () => void
  onDelete: () => void
  onToggleDone: () => void
  onToggleExpand: () => void
  /** 资料 / 书：改占比（学习）或改页码（读书）——只在根节点上有意义 */
  onEditMeasure: () => void
  /** 章 / 子章：改"读到哪了"的页码（写回 `note` 字段） */
  onEditNote: () => void
}

export const NODE_MEASURE_LABEL = '改占比 / 改页码'

/** 把一个移动动作翻成一条菜单项（可用性 + 原因 + 回调一次说完） */
function moveMenuItem(
  id: string,
  label: string,
  step: MoveStep,
  moves: TreeNodeMoves
): MenuItemDef {
  return {
    id,
    label,
    group: NODE_MOVE_GROUP,
    ...(step.target === null ? { disabled: true, ...(step.reason === null ? {} : { hint: step.reason }) } : {}),
    callbacks: () => {
      if (step.target !== null) moves.moveTo(step.target)
    }
  }
}

export function treeNodeMenuItems(ctx: TreeNodeMenuContext): MenuItemDef[] {
  const moves = ctx.moves
  return [
    { id: 'node-add-child', label: '添加子节点', callbacks: ctx.onAddChild },
    ...(moves === undefined
      ? []
      : [
          moveMenuItem('node-move-up', NODE_MOVE_LABELS.up, moves.up, moves),
          moveMenuItem('node-move-down', NODE_MOVE_LABELS.down, moves.down, moves),
          moveMenuItem('node-promote', NODE_MOVE_LABELS.promote, moves.promote, moves),
          moveMenuItem('node-demote', NODE_MOVE_LABELS.demote, moves.demote, moves)
        ]),
    { id: 'node-rename', label: '编辑', callbacks: ctx.onRename },
    { id: 'node-toggle-expand', label: ctx.expanded ? '折叠' : '展开', callbacks: ctx.onToggleExpand },
    {
      id: ctx.done ? 'node-mark-undone' : 'node-mark-done',
      label: ctx.done ? '标记未完成' : '标记完成',
      // 汇总节点不参与计数，打勾这一项直接禁用（与树上那格只读的勾一致）
      ...(ctx.summary ? { disabled: true, hint: '汇总节点不计数' } : {}),
      callbacks: ctx.onToggleDone
    },
    ...(ctx.root
      ? [
          {
            id: 'node-measure',
            label: NODE_MEASURE_LABEL,
            separator: true,
            callbacks: ctx.onEditMeasure
          } satisfies MenuItemDef
        ]
      : []),
    { id: 'node-note', label: '改页码 / 进度说明', callbacks: ctx.onEditNote },
    { id: 'node-delete', label: '删除', danger: true, separator: true, callbacks: ctx.onDelete }
  ]
}

// -------------------------------------------------------------- 资料 / 书

export interface BookMenuContext {
  title: string
  /** 在读 / 想读 / 读完 */
  status: 'want' | 'reading' | 'finished'
  onEdit: () => void
  onDelete: () => void
  /** 纸质书改页码、电子书改百分比 */
  onEditMeasure: () => void
  onAddChapter: () => void
  onToggleStatus: () => void
}

export function bookMenuItems(ctx: BookMenuContext): MenuItemDef[] {
  return [
    { id: 'book-edit', label: '编辑', callbacks: ctx.onEdit },
    { id: 'book-add-chapter', label: '加章节', callbacks: ctx.onAddChapter },
    { id: 'book-measure', label: NODE_MEASURE_LABEL, callbacks: ctx.onEditMeasure },
    {
      id: ctx.status === 'finished' ? 'book-mark-reading' : 'book-mark-finished',
      label: ctx.status === 'finished' ? '标记在读' : '标记读完',
      callbacks: ctx.onToggleStatus
    },
    { id: 'book-delete', label: '删除', danger: true, separator: true, callbacks: ctx.onDelete }
  ]
}

// ------------------------------------------------------------------ 备忘

export interface MemoMenuContext {
  pinned: boolean
  text: string
  onEdit: () => void
  onDelete: () => void
  onTogglePin: () => void
  onAddTag: () => void
  onToPlan: () => void
  onToReview: () => void
  onCopy: () => void
}

export function memoMenuItems(ctx: MemoMenuContext): MenuItemDef[] {
  return [
    { id: 'memo-edit', label: '编辑', callbacks: ctx.onEdit },
    { id: 'memo-copy', label: '复制内容', callbacks: ctx.onCopy },
    {
      id: ctx.pinned ? 'memo-unpin' : 'memo-pin',
      label: ctx.pinned ? '取消置顶' : '置顶',
      callbacks: ctx.onTogglePin
    },
    { id: 'memo-add-tag', label: '添加标签', callbacks: ctx.onAddTag },
    { id: 'memo-to-plan', label: '排进计划', separator: true, callbacks: ctx.onToPlan },
    { id: 'memo-to-review', label: '生成复习卡', callbacks: ctx.onToReview },
    { id: 'memo-delete', label: '删除', danger: true, separator: true, callbacks: ctx.onDelete }
  ]
}

// ------------------------------------------------------------------ 卡片

export interface CardMenuContext {
  /** 已经排过复习时间（有 dueDate）→ 条件项换成"清空复习时间" */
  scheduled: boolean
  onEdit: () => void
  onDelete: () => void
  /** 设置复习时间：days 为距今天数 */
  onSetReviewInDays: (days: number) => void
  onClearReview: () => void
  /** 看历史（历史界面在 06 块，本块只接菜单项） */
  onViewHistory: () => void
  onCopy: () => void
}

export function cardMenuItems(ctx: CardMenuContext): MenuItemDef[] {
  const defs: MenuItemDef[] = [
    { id: 'card-edit', label: '编辑', callbacks: ctx.onEdit },
    { id: 'card-copy', label: '复制', callbacks: ctx.onCopy },
    { id: 'card-view-history', label: '看历史', callbacks: ctx.onViewHistory },
    { id: 'card-clear-review', label: '清空复习时间', separator: true, callbacks: ctx.onClearReview },
    { id: 'card-delete', label: '删除', danger: true, separator: true, callbacks: ctx.onDelete }
  ]
  for (const preset of REVIEW_DAY_PRESETS) {
    defs.push({
      id: `card-review-${preset.days}`,
      label: preset.label,
      group: '设置复习时间',
      callbacks: () => ctx.onSetReviewInDays(preset.days)
    })
  }
  return defs
}

// ------------------------------------------------------- 树节点 → 菜单项的适配

/**
 * 把 `TreeView` 给的 `TreeMenuActions` 适配成菜单项定义。
 *
 * 层级语义（能不能展开、是不是汇总节点、往哪挪）**全部由 `TreeView` 算好**，
 * 这里只做"翻译"，不再算第二遍——两处各算一遍必然漂移。
 */
export function treeNodeMenuFromActions(
  item: TreeViewItem,
  actions: {
    addChild: () => void
    rename: () => void
    remove: () => void
    toggleDone: () => void
    toggleExpand: () => void
    isSummary: () => boolean
    /** 四个移动动作（可用性 + 目标位置由 `moveStepsOf` 算好，见 `TreeView`） */
    moves?: {
      up: MoveStep
      down: MoveStep
      promote: MoveStep
      demote: MoveStep
    }
    /** 真的移动：落库仍然走页面传进 `TreeView` 的那条 `onMove`（与拖拽同一条路） */
    moveTo?: (target: MoveTarget) => void
  },
  options: { expanded: boolean; onEditMeasure: () => void; onEditNote?: () => void }
): MenuItemDef[] {
  return treeNodeMenuItems({
    title: item.title,
    summary: actions.isSummary(),
    done: item.done,
    expanded: options.expanded,
    root: item.parentId === null,
    // 四项移动动作：两个都给了才出（少一个就等于"点了不动"，比没有更糟）
    ...(actions.moves === undefined || actions.moveTo === undefined
      ? {}
      : { moves: { ...actions.moves, moveTo: actions.moveTo } }),
    onAddChild: actions.addChild,
    onRename: actions.rename,
    onDelete: actions.remove,
    onToggleDone: actions.toggleDone,
    onToggleExpand: actions.toggleExpand,
    onEditMeasure: options.onEditMeasure,
    // 没给"改页码"的实现就退回改名——空回调会让用户点了没反应，比换一个动作更糟
    onEditNote: options.onEditNote ?? actions.rename
  })
}

// ------------------------------------------------- 中区列表行 → 菜单项（2026-10 修订）

/**
 * 中区「资料」卡里的一行 —— 它**就是树里的同一个节点**（资料是树的根节点）。
 *
 * 为什么需要这一段：用户在"资料"列表里找不到删除入口（那张卡以前是纯展示、
 * 0 个按钮），删除只能进树里做。补入口时**绝不能在页面里另写一份菜单项数组**
 * ——`tests/shell/contextMenuItems.test.ts` 与 `tests/shell/bandRowMenus.test.ts`
 * 都钉着"只定义一份"。所以这里只做**翻译**：把列表行上拿得到的字段
 * 翻成 `treeNodeMenuItems` 要的上下文，菜单项本身一个都不新增。
 */
export interface ResourceRowMenuContext {
  title: string
  done: boolean
  /** 有子节点 = 汇总节点（勾不可点，与树里一致） */
  hasChildren: boolean
  /** 这一行的**子节点**展开着吗（不是"面板开着吗"，两件事已经拆开） */
  expanded: boolean
  onAddChild: () => void
  onRename: () => void
  onDelete: () => void
  onToggleDone: () => void
  onToggleExpand: () => void
  /** 资料行：改占比（读书侧对应"改页码"） */
  onEditMeasure: () => void
  /** 章 / 子章：改页码；资料行没有就退回"编辑"（与树里同一条兜底） */
  onEditNote?: () => void
}

/**
 * 中区「资料」行的菜单项。
 *
 * `root: true` 是**写死**的：这张卡里列的就是资料，而资料永远是根节点
 * （`MASTER.md` §7.5：资料为根 → 章 → 子章）。所以中区这一行的菜单
 * 与树里资料行的菜单**完全相同**（编辑 / 改占比 / 加子节点 / 标记完成 / 删除…）。
 *
 * ## 唯一的例外：四个移动动作（2026-10 修订 · 修改 2 轮）
 *
 * **这里刻意不传 `moves`**，所以 `node-move-up` / `node-move-down` /
 * `node-promote` / `node-demote` 这四项在中区**不出现**。
 * 理由不是"少写了一个参数"，而是语义上确实没有意义：中区这张卡是
 * **扁平的资料列表**（一行一份资料），里面没有"上一个兄弟""上一层"这些概念，
 * 层级移动只在树里有意义（树里那四项照样有，资料只有上下移、升/降级禁用）。
 *
 * `tests\shell\bandRowMenus.test.ts` 钉住"树里比中区多出的项，正好是这四项"——
 * 口径因此是「中区行菜单 ≡ 树里行菜单中**适用于列表视图的那些**」。
 */
export function resourceRowMenuItems(ctx: ResourceRowMenuContext): MenuItemDef[] {
  return treeNodeMenuItems({
    title: ctx.title,
    summary: ctx.hasChildren,
    done: ctx.done,
    expanded: ctx.expanded,
    root: true,
    onAddChild: ctx.onAddChild,
    onRename: ctx.onRename,
    onDelete: ctx.onDelete,
    onToggleDone: ctx.onToggleDone,
    onToggleExpand: ctx.onToggleExpand,
    onEditMeasure: ctx.onEditMeasure,
    onEditNote: ctx.onEditNote ?? ctx.onRename
  })
}

/**
 * 中区「今天到期的卡片」行的菜单项。
 *
 * 与树里卡片行走**同一个** `cardMenuItems`：这里只补齐"已排复习时间"
 * 这一个状态字段，菜单项与顺序一个字都不改。
 */
export function dueCardRowMenuItems(
  ctx: CardMenuContext & { scheduled: boolean }
): MenuItemDef[] {
  return cardMenuItems(ctx)
}

// ------------------------------------- 复习页左栏的主题行（2026-10 修订 · 修改 2 轮）

/**
 * 用户原话：「复习无法删除主题。」
 *
 * 那个位置以前是**纯展示 + 点击选中**：没有 `⋯`、没有右键，一个操作入口都没有
 * （同页的中区卡片行、下方的树行早就都有了）。补入口时同样**不另写一份菜单项**，
 * 就在这里定义一次。
 *
 * ## 修改 2 轮只做到"隐藏"（当时的决定）
 *
 * 复习的"主题" = 学习主题 + 读书的书（决定 17），另外还有一类**来源档**
 * （卡片原来的主题/书已经不存在时，按来源名自成一档）——它不是真实实体，
 * 没法按"删学习主题"的方式处置。当时的决定是：**只在复习页隐藏它，不删任何源数据**。
 * 后果是用户那句「还是删不掉」——见下面修改 3 轮那一段。
 *
 * ## 隐藏**绝不能**造成漏复习（决定 19 的硬约束）
 *
 * 隐藏只影响左栏列表的显示：汇总横条的总数、分布、汇总复习按钮、导航角标
 * **一个数都不变**，隐藏主题的到期卡照样会被「汇总复习」抽到。
 * 这条由 `src\shared\reviewPageView.ts` 与三条单测钉住，不靠这里自觉。
 *
 * ## 修改 3 轮：**来源档**多一条「删除这个来源档」（2026-10）
 *
 * 用户又说了一次「这个还是删不掉」（指左栏那个「手动新建」）。上一轮按
 * "只在复习页隐藏它"做的最小集，**从来就没有删除项**，所以用户说得没错。
 *
 * 决定（用户已确认）：**只给来源档加删除**，`topic:` / `book:` 档仍然只能隐藏
 * （那两类是真实实体，删它等于去学习页 / 读书页删东西）。
 *
 * 所以这里多一个 `deletable`：**由页面算好传进来**（`reviewPageView.ts` 的
 * `isTopicDeletable()`），本文件里**不再解析一遍 key** —— 一处判断、两处用会漂移。
 */
export interface ReviewTopicMenuContext {
  /** 这个主题现在是不是已隐藏 */
  hidden: boolean
  onToggleHidden: () => void
  /**
   * 这一档是不是"来源档"（`source:` 开头）。**只有它允许删除**。
   *
   * ⚠️ 这个值必须由页面按 `reviewPageView.ts` 的判断算好传进来，
   * 不要在这里再从 key 反推一次。
   */
  deletable: boolean
  /** 这一档下面有**多少张卡片**（确认文案与 hint 都要用） */
  cardCount: number
  /** 只有 `deletable` 为 true 时才会被调用 */
  onDelete: () => void
}

export const REVIEW_TOPIC_HIDE_LABEL = '隐藏这个主题'
export const REVIEW_TOPIC_UNHIDE_LABEL = '取消隐藏'

/** 隐藏不是删除——这句提示直接显示在菜单项右边，免得用户以为卡被删了 */
export const REVIEW_TOPIC_HIDE_HINT = '不影响今天到期总数'

/**
 * 删除项的文案：写「**来源档**」而不是「删除」。
 *
 * 让用户一眼明白删的是"这一档归类"（连带它下面的卡片），
 * 而不是"删了某个学习主题"—— 后者在复习页本来就不该做。
 */
export const REVIEW_TOPIC_DELETE_LABEL = '删除这个来源档'
export const REVIEW_TOPIC_DELETE_ID = 'review-topic-delete'

export function reviewTopicMenuItems(ctx: ReviewTopicMenuContext): MenuItemDef[] {
  return [
    {
      id: ctx.hidden ? 'review-topic-unhide' : 'review-topic-hide',
      label: ctx.hidden ? REVIEW_TOPIC_UNHIDE_LABEL : REVIEW_TOPIC_HIDE_LABEL,
      ...(ctx.hidden ? {} : { hint: REVIEW_TOPIC_HIDE_HINT }),
      callbacks: ctx.onToggleHidden
    },
    // 危险项排在最后单独一组（与任务 / 树 / 卡片上的「删除」同一个规矩）；
    // hint 里带张数：点之前就知道会连带删多少
    ...(ctx.deletable
      ? [
          {
            id: REVIEW_TOPIC_DELETE_ID,
            label: REVIEW_TOPIC_DELETE_LABEL,
            danger: true,
            separator: true,
            hint: `${ctx.cardCount} 张卡片`,
            callbacks: ctx.onDelete
          } satisfies MenuItemDef
        ]
      : [])
  ]
}

