/**
 * 通用树界面组件（第二轮 FEAT-006 / `MASTER.md` §6.1）
 *
 * 学习主题下的"资料 → 章 → 子章 → 条目"与读书的"章 → 子章"**共用这一个组件**，
 * 但**数据各建各的**（两处是两棵树，见 `MASTER.md` 决定 3）——
 * 组件本身不认识任何模块，只认 `parentId` / `order` 这两件事。
 *
 * ## 界面规矩（`MASTER.md` §7.5 / §7.9）
 *
 *   - **虚线框** = 汇总节点（有子节点，不参与进度计数，**不能打勾**）
 *   - **实心方框** = 最小单元（没有子节点，可打勾）
 *   - **层数不限**：1.1.1.1 也能建；第 5 层起缩进从 20px 收窄到 12px
 *   - 同一层里允许"既有子节点、又能直接打勾"（不严格分层）
 *     —— 在本组件里的体现是：**一旦某个节点有了子节点，它自己那格勾就变成
 *     只读的汇总状态**（虚线框）；想给这一层打勾，就再建一个没有子节点的兄弟节点
 *   - 树自己**内部滚动**（§7.2 滚轮规矩：整页永不出现滚动条）
 *     ⚠️ 2026-10 修订：学习 / 复习 / 读书三页改成**下区跟随整页滚**
 *     （`styles/layout.css` 的 `page--scroll`），树按内容自然变高、不再内部滚。
 *     这一条现在只对"页面级不滚"的页面（日历那一类）成立。
 *
 * ## 纯逻辑在哪
 *
 * 组装行、拖拽落点、可见性判定在 `src\shared\treeView.ts`（有单测）；
 * 缩进、最小单元、占比归一化在 `src\shared\treeProgress.ts`（有单测）；
 * 层级移动的防成环 / 跨 owner 拒绝在 `src\shared\tree.ts`（有单测）。
 * 本文件只做渲染与交互，所以**它的行为由端到端验收覆盖**
 * （`src\main\verify\phase8.ts`；vitest 是 `environment: 'node'`，不测组件，
 * 也**不许为了测组件引入 jsdom**）。
 *
 * ## 右键菜单挂点（03 块用）
 *
 * 每一行的 `onContextMenu` 都会调 `onContextMenuItems?.(item, actions)`；
 * `actions` 里已经把"加子节点 / 重命名 / 删除 / 打勾 / 展开 / **四个移动动作**"
 * 算好了层级语义，03 块只需返回菜单项数组，不必自己再算一遍。
 * **本块不定义任何菜单项内容**（那是 03 块的事）。
 *
 * 四个移动动作（2026-10 修订 · 修改 2 轮）在 `actions.moves` 里，每一项自带
 * "此刻能不能用 + 为什么不能用"（`MoveStep`），菜单据此出"禁用 + 原因"；
 * 真正的移动走 `actions.moveTo(target)` → 页面的 `onMove`，**与拖拽同一条路**。
 *
 * ## 拖拽
 *
 * 用浏览器原生的 HTML5 拖拽（`draggable` + dataTransfer），**不引第三方拖拽库**
 * （`dependencies` 必须保持为空，这是项目立场）。
 * 落点有三种：目标行**上边**、**下边**（同级前后插入）、行**中间**（变成子节点）。
 * 拖拽与四个菜单动作**并存**：本轮只补菜单入口，拖拽行为一个字没改。
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import { indentForDepth } from '../../shared/treeProgress'
import { moveStepsOf, type MoveStep, type MoveTarget } from '../../shared/treeMove'
import {
  assembleRows,
  isRowVisible,
  resolveDropTarget,
  type TreeDropPosition,
  type TreeDropTarget,
  type TreeRow,
  type TreeViewItem
} from '../../shared/treeView'
import type { MenuItemSpec } from '../../shared/menuItems'
import { ContextMenu, MenuButton, useContextMenu } from './ContextMenu'

export type { TreeDropPosition, TreeDropTarget, TreeViewItem }
export { assembleRows, resolveDropTarget }

export interface TreeViewProps {
  /** 这棵树的归属（学习主题 id 或书 id）——只用于定位与验收，不参与渲染 */
  ownerId: string
  /** **平铺**的全部节点；组件自己按 parentId 组装 */
  items: TreeViewItem[]
  /** 工具栏上的"加根节点"按钮文案；不传则不出这个按钮 */
  addRootLabel?: string
  /** 空树时的提示 */
  emptyHint?: string
  loading?: boolean
  error?: string | null
  /** 行的补充信息，例如资料行的 `占比 50% · 已学 43%（3/7）` */
  progressOf?: (item: TreeViewItem) => string | null
  /** 行首分组名（"书 / 视频 / 课程"），只有资料行有 */
  badgeOf?: (item: TreeViewItem) => string | null
  /** 就地展开的节点内容（学习：该章节的记一次学习与学习记录） */
  nodeContent?: (item: TreeViewItem) => React.ReactNode
  /** 受控的展开集合；不传则组件自己管 */
  expandedIds?: string[]
  onToggleExpand?: (item: TreeViewItem, expanded: boolean) => void
  /**
   * 受控的**就地面板**集合（决定 18 / 2026-10 修订）。
   *
   * 为什么与 `expandedIds` **分开**：这两件事以前共用一个数组，
   * 于是"想收面板但保留子节点展开"做不到、"收子节点把面板也弄没了"。
   * 现在：
   *   - `expandedIds`    只决定**子节点**露不露、箭头朝哪
   *   - `openDetailIds`  只决定**就地面板**（`nodeContent`）开不开
   *
   * 不传时退回旧行为（面板跟着 `expandedIds` 走），别的树不用改。
   */
  openDetailIds?: string[]
  /** 点行主体的回调（不传则汇总节点点击只做展开/折叠） */
  onOpenDetail?: (item: TreeViewItem) => void
  /** 树内容区的高度上限（px）；不传就交给外层 CSS */
  height?: number
  /** 树的 testid 前缀；行是 `${testIdPrefix}-row` */
  testIdPrefix?: string

  onToggleDone: (item: TreeViewItem, done: boolean) => void
  /** 新增子节点；`parent.id === ''` 表示新增一个根节点（资料 / 顶层章） */
  onAddChild: (parent: TreeViewItem) => void
  onRename: (item: TreeViewItem) => void
  onDelete: (item: TreeViewItem) => void
  /** 拖动完成：调用方拿它去调 `tree.ts` 的 `moveNode`（防成环已有单测） */
  onMove?: (dragId: string, target: TreeDropTarget) => void
  /**
   * 顶层节点能不能「降一级」（变成上一个兄弟的子节点）。
   *
   * 三处树各建各的（决定 3），顶层节点的语义不一样：
   *   - **学习树**：顶层是**资料**。把资料降到章节层会让"资料 → 章 → 子章"
   *     这套层级语义乱掉（复习页按 `depth === 0` 认资料）→ **默认不给降**
   *   - **读书树**：顶层是**章**。章降到上一章底下就是"子章"，是正常动作 → 传 `true`
   *
   * 不传 = 不给降（学习页因此不用改一行）。
   */
  allowRootDemote?: boolean
  /**
   * 右键菜单挂点（03 块接线）。
   * 返回菜单项数组即可；定位与渲染由 `ContextMenu.tsx` 负责。
   */
  onContextMenuItems?: (
    item: TreeViewItem,
    actions: TreeMenuActions,
    event: { clientX: number; clientY: number }
  ) => MenuItemSpec[]
  /**
   * 行尾的 `⋯` 菜单（第 03 块）。
   *
   * 与右键**取同一批菜单项**：这里拿到的是同一个 `actions`，
   * 只需要把它翻译成 `shared/contextMenu.ts` 里的那一份定义即可。
   * 不传就不出这个按钮（保持"树只有行内按钮"的旧样子）。
   */
  onMenuItems?: (item: TreeViewItem, actions: TreeMenuActions) => MenuItemSpec[]
  /**
   * 点行尾 `⋯` 时把"要打开的菜单"交回给页面。
   *
   * 为什么交回给页面：一屏**只能有一个**菜单实例——两个实例各自监听
   * "点别处关闭"，会互相把对方关掉（实测：点开一个，另一个立刻消失）。
   * 页面本来就已经有一个（右键用的那个），所以这里只上报，不自己再渲染一个。
   *
   * 不传 `onRequestMenu` 时，组件退化成"自己渲染"（单棵树、无其它菜单的页够用）。
   */
  onRequestMenu?: (
    item: TreeViewItem,
    actions: TreeMenuActions,
    point: { x: number; y: number }
  ) => void
}

/** 右键菜单能直接用的动作（层级语义已经算好） */
export interface TreeMenuActions {
  addChild: () => void
  rename: () => void
  remove: () => void
  toggleDone: () => void
  toggleExpand: () => void
  /**
   * 四个显式移动动作（2026-10 修订 · 修改 2 轮）。
   *
   * 每一项自带"此刻能不能用 + 为什么不能用"：界面把它翻成菜单项的
   * `disabled` / `hint`，于是用不了的动作是**灰掉并说明原因**，
   * 而不是从菜单里消失（消失 = 用户以为功能不存在，这正是本轮要修的病）。
   *
   * 目标位置由 `shared/treeMove.ts` 的 `moveStepsOf` 算出（纯逻辑、有单测），
   * 落库仍走 `moveTo` → 页面传进来的 `onMove`，**与拖拽完全同一条路**。
   */
  moves: {
    up: MoveStep
    down: MoveStep
    promote: MoveStep
    demote: MoveStep
  }
  /** 真的要移动：调用方拿它去调 `moveNode`（与拖拽同一个落库函数） */
  moveTo: (target: MoveTarget) => void
  /** 这一行当前是不是汇总节点（有子节点） */
  isSummary: () => boolean
}

interface Assembled extends TreeRow {}

export function TreeView(props: TreeViewProps): React.JSX.Element {
  const {
    items,
    addRootLabel,
    emptyHint = '还没有内容，点上面的按钮开始加。',
    loading = false,
    error = null,
    progressOf,
    badgeOf,
    nodeContent,
    expandedIds,
    onToggleExpand,
    openDetailIds,
    height,
    testIdPrefix = 'tree'
  } = props

  const [innerExpanded, setInnerExpanded] = useState<string[]>([])
  const expanded = useMemo(
    () => new Set(expandedIds ?? innerExpanded),
    [expandedIds, innerExpanded]
  )
  /**
   * 就地面板开在哪几行上。
   *
   * 传了 `openDetailIds` 就只认它（面板与子节点彻底解耦）；
   * 没传则退回旧行为（面板跟着展开集合走），保证别的调用方不受影响。
   */
  const detailOpen = useMemo(
    () => (openDetailIds === undefined ? expanded : new Set(openDetailIds)),
    [openDetailIds, expanded]
  )

  const byId = useMemo(() => new Map(items.map((item) => [item.id, item])), [items])
  const rows = useMemo(() => assembleRows(items), [items])
  const visibleRows = useMemo(
    () => rows.filter((row) => isRowVisible(byId, row.item, expanded)),
    [rows, byId, expanded]
  )

  // 数据变了以后把已经不存在的 id 从展开集合里清掉，避免集合无限增长
  useEffect(() => {
    setInnerExpanded((current) => {
      const alive = current.filter((id) => byId.has(id))
      return alive.length === current.length ? current : alive
    })
  }, [byId])

  const [dragId, setDragId] = useState<string | null>(null)
  const [dropTarget, setDropTarget] = useState<{ id: string; position: TreeDropPosition } | null>(
    null
  )
  /**
   * 落点的**即时**副本。
   *
   * `dragover` 与 `drop` 之间不一定隔着一次重渲染（真实拖拽里间隔很短，
   * 验收脚本里更是可以同一帧连着派发）。所以落点除了给渲染用的 state，
   * 还必须有一份同步写入的 ref，否则 drop 时读到的可能是上一帧的 null。
   */
  const dropRef = useRef<{ id: string; position: TreeDropPosition } | null>(null)
  const [editingId, setEditingId] = useState<string | null>(null)
  const renameRef = useRef<HTMLInputElement | null>(null)
  /**
   * 行尾 `⋯` 的菜单实例（第 03 块）。
   *
   * 放在组件内部，是因为 `actions` 是**按行**算出来的：
   * 只有渲染到那一行时才知道"这一行能不能展开、是不是汇总节点"。
   * 页面通过 `onMenuItems` 提供菜单项内容，定位与渲染仍由 `ContextMenu.tsx` 负责。
   */
  const rowMenu = useContextMenu()

  const setExpanded = (item: TreeViewItem, next: boolean): void => {
    if (expandedIds === undefined) {
      setInnerExpanded((current) =>
        next ? [...new Set([...current, item.id])] : current.filter((id) => id !== item.id)
      )
    }
    // 受控模式下由页面决定展开集合；页面会顺带回落为"单开"（手风琴），这里不做假设
    onToggleExpand?.(item, next)
  }

  const moveTo = (movedId: string, parentId: string | null, index: number): void => {
    props.onMove?.(movedId, { parentId, index })
  }

  const startRename = (item: TreeViewItem): void => {
    setEditingId(item.id)
  }

  useEffect(() => {
    if (editingId === null) return
    renameRef.current?.focus()
    renameRef.current?.select()
  }, [editingId])

  /**
   * 就地改名的提交。
   *
   * **标题以输入框里的实际值为准**（调用方从事件里取 `currentTarget.value` 传进来），
   * 不用 React 的受控 state：受控值要靠 onChange 同步，而"输入 → 立刻回车"
   * 在同一次事件循环里完成时，state 可能还是旧值，改名会被 `title === item.title`
   * 这条守卫静默吃掉（已踩过：表现是"输入框收起来了，但名字没变"）。
   */
  const commitRename = (item: TreeViewItem, rawTitle: string): void => {
    const title = rawTitle.trim()
    setEditingId(null)
    if (title === '' || title === item.title) return
    props.onRename({ ...item, title })
  }

  const buildActions = (row: Assembled): TreeMenuActions => {
    const item = row.item
    return {
      addChild: () => props.onAddChild(item),
      rename: () => startRename(item),
      remove: () => props.onDelete(item),
      toggleDone: () => {
        if (row.summary) return
        props.onToggleDone(item, !item.done)
      },
      toggleExpand: () => setExpanded(item, !expanded.has(item.id)),
      // 四个移动动作：算位置的是纯逻辑（`moveStepsOf`），落库复用 `onMove`
      moves: moveStepsOf(items, item.id, { allowRootDemote: props.allowRootDemote === true }),
      moveTo: (target) => moveTo(item.id, target.parentId, target.index),
      isSummary: () => row.summary
    }
  }

  return (
    <div
      className="tree"
      data-testid={`${testIdPrefix}-root`}
      data-tree-owner={props.ownerId}
      // 展开集合的直接读数：验收与排查都能一眼看出"点到底有没有生效"
      data-expanded-ids={[...expanded].join(',')}
    >
      {error ? <p className="notice notice--error">读取失败：{error}</p> : null}
      {addRootLabel ? (
        <div className="tree__toolbar">
          <button
            type="button"
            className="button"
            data-testid={`${testIdPrefix}-add-root`}
            onClick={() =>
              props.onAddChild({
                id: '',
                parentId: null,
                order: items.filter((item) => item.parentId === null).length,
                title: '',
                done: false
              })
            }
          >
            {addRootLabel}
          </button>
          <span className="tree__hint">
            虚线框＝汇总节点（不计数）· 实心方框＝最小单元（可打勾）
          </span>
        </div>
      ) : null}

      {visibleRows.length === 0 ? (
        <p className="panel__hint" data-testid={`${testIdPrefix}-empty`}>
          {loading ? '读取中…' : emptyHint}
        </p>
      ) : (
        <ul
          className="tree__list"
          role="tree"
          data-testid={`${testIdPrefix}-list`}
          style={height === undefined ? undefined : { maxHeight: height }}
        >
          {visibleRows.map((row) => {
            const item = row.item
            const summary = row.summary
            const isEditing = editingId === item.id
            const progress = progressOf?.(item) ?? null
            const badge = badgeOf?.(item) ?? null
            const dropped = dropTarget?.id === item.id ? dropTarget.position : ''
            return (
              <li
                key={item.id}
                className={`tree__row${dropped === '' ? '' : ` is-drop-${dropped}`}`}
                role="treeitem"
                aria-expanded={summary ? expanded.has(item.id) : undefined}
                data-testid={`${testIdPrefix}-row`}
                data-node-id={item.id}
                data-depth={row.depth}
                data-summary={summary ? '1' : '0'}
                data-done={item.done ? '1' : '0'}
                data-drop={dropped}
              >
                <div
                  className="tree__line"
                  style={{ paddingLeft: indentForDepth(row.depth) }}
                  data-indent={indentForDepth(row.depth)}
                  onClick={() => {
                    // 汇总节点的行也可以点：既算"点这一行"（资料行 → 就地改占比），
                    // 也顺手展开/折叠它下面的内容
                    props.onOpenDetail?.(item)
                    if (summary) setExpanded(item, !expanded.has(item.id))
                  }}
                  onContextMenu={(event) => {
                    const builder = props.onContextMenuItems
                    if (!builder) return
                    event.preventDefault()
                    // 挂点：菜单项内容由 03 块给，定位与渲染由 ContextMenu.tsx 负责
                    void builder(item, buildActions(row), {
                      clientX: event.clientX,
                      clientY: event.clientY
                    })
                  }}
                  onDragOver={(event) => {
                    if (props.onMove === undefined) return
                    event.preventDefault()
                    const rect = event.currentTarget.getBoundingClientRect()
                    const offset = event.clientY - rect.top
                    const position: TreeDropPosition =
                      offset < rect.height * 0.3
                        ? 'before'
                        : offset > rect.height * 0.7
                          ? 'after'
                          : 'onto'
                    dropRef.current = { id: item.id, position }
                    setDropTarget({ id: item.id, position })
                  }}
                  onDragLeave={() => {
                    if (dropRef.current?.id !== item.id) return
                    dropRef.current = null
                    setDropTarget(null)
                  }}
                  onDrop={(event) => {
                    event.preventDefault()
                    const dragged = dragId ?? event.dataTransfer.getData('text/plain')
                    // 以即时副本为准，state 只负责画那条提示线
                    const landed = dropRef.current?.id === item.id ? dropRef.current : null
                    const position = landed?.position ?? 'onto'
                    dropRef.current = null
                    setDropTarget(null)
                    setDragId(null)
                    if (dragged === null || dragged === '') return
                    const target = resolveDropTarget(items, dragged, item.id, position)
                    if (!target) return
                    if (position === 'onto') setExpanded(item, true)
                    props.onMove?.(dragged, target)
                  }}
                >
                  {summary ? (
                    <button
                      type="button"
                      className="tree__caret"
                      data-testid={`${testIdPrefix}-toggle`}
                      aria-expanded={expanded.has(item.id)}
                      title={expanded.has(item.id) ? '折叠' : '展开'}
                      onClick={(event) => {
                        // 这个按钮自己处理展开，别再让行的 onClick 处理一遍
                        // （两处都处理会在同一次点击里展开完又收起，看起来就是"点了没反应"）
                        event.preventDefault()
                        event.stopPropagation()
                        setExpanded(item, !expanded.has(item.id))
                      }}
                    >
                      {expanded.has(item.id) ? '▾' : '▸'}
                    </button>
                  ) : (
                    <span className="tree__caret tree__caret--blank" aria-hidden="true" />
                  )}

                  <input
                    type="checkbox"
                    className={`tree__check${summary ? ' tree__check--summary' : ''}`}
                    data-testid={`${testIdPrefix}-check`}
                    data-summary={summary ? '1' : '0'}
                    checked={item.done}
                    disabled={summary}
                    title={
                      summary ? '汇总节点不参与计数（它只汇总下面的最小单元）' : '标记这段学完'
                    }
                    onClick={(event) => event.stopPropagation()}
                    onChange={(event) => props.onToggleDone(item, event.target.checked)}
                  />

                  {badge ? (
                    <span className="tree__badge" data-testid={`${testIdPrefix}-badge`}>
                      {badge}
                    </span>
                  ) : null}

                  {isEditing ? (
                    <input
                      ref={renameRef}
                      className="tree__rename"
                      defaultValue={item.title}
                      data-testid={`${testIdPrefix}-rename`}
                      onClick={(event) => event.stopPropagation()}
                      onBlur={(event) => commitRename(item, event.currentTarget.value)}
                      onKeyDown={(event) => {
                        if (event.key === 'Enter') {
                          event.preventDefault()
                          commitRename(item, event.currentTarget.value)
                        }
                        if (event.key === 'Escape') {
                          event.preventDefault()
                          setEditingId(null)
                        }
                      }}
                    />
                  ) : (
                    <span className="tree__title" data-testid={`${testIdPrefix}-title`}>
                      {item.title || '（未命名）'}
                    </span>
                  )}

                  {progress ? (
                    <span className="tree__progress" data-testid={`${testIdPrefix}-progress`}>
                      {progress}
                    </span>
                  ) : null}

                  {summary && !progress ? (
                    <span className="tree__summary-tag" data-testid={`${testIdPrefix}-summary-tag`}>
                      ⌐汇总⌐
                    </span>
                  ) : null}

                  <span className="tree__spacer" />

                  {/* 行尾 `⋯`：与右键取同一批菜单项（第 03 块） */}
                  {props.onMenuItems === undefined ? null : props.onRequestMenu !== undefined ? (
                    <button
                      type="button"
                      className="row-menu-button"
                      aria-label="这一行的更多操作"
                      aria-haspopup="menu"
                      data-testid={`${testIdPrefix}-menu`}
                      onClick={(event) => {
                        // 行的 onClick 会展开/折叠，别把菜单点没了
                        event.stopPropagation()
                        props.onRequestMenu!(item, buildActions(row), {
                          x: event.clientX,
                          y: event.clientY
                        })
                      }}
                    >
                      ⋯
                    </button>
                  ) : (
                    <MenuButton
                      menu={rowMenu}
                      items={() => props.onMenuItems!(item, buildActions(row))}
                      testId={`${testIdPrefix}-menu`}
                      label="这一行的更多操作"
                      className="row-menu-button"
                    />
                  )}

                  <span
                    className="tree__grip"
                    draggable
                    role="button"
                    tabIndex={-1}
                    aria-label="拖动排序"
                    data-testid={`${testIdPrefix}-drag`}
                    title="拖动：上/下边＝同级前后，行中间＝变成子节点"
                    onClick={(event) => event.stopPropagation()}
                    onDragStart={(event) => {
                      setDragId(item.id)
                      event.dataTransfer.setData('text/plain', item.id)
                      event.dataTransfer.effectAllowed = 'move'
                    }}
                    onDragEnd={() => {
                      setDragId(null)
                      dropRef.current = null
                      setDropTarget(null)
                    }}
                  >
                    ⠿
                  </span>

                  <button
                    type="button"
                    className="link"
                    data-testid={`${testIdPrefix}-add-child`}
                    onClick={(event) => {
                      event.stopPropagation()
                      props.onAddChild(item)
                    }}
                  >
                    +子节点
                  </button>
                  <button
                    type="button"
                    className="link"
                    data-testid={`${testIdPrefix}-rename-open`}
                    onClick={(event) => {
                      // 必须停住冒泡：行的 onClick 会顺带展开/折叠这一行，
                      // 一折叠就把刚打开的就地输入框又渲染掉了（已踩过）
                      event.stopPropagation()
                      startRename(item)
                    }}
                  >
                    改名
                  </button>
                  <button
                    type="button"
                    className="link link--danger"
                    data-testid={`${testIdPrefix}-delete`}
                    onClick={(event) => {
                      event.stopPropagation()
                      props.onDelete(item)
                    }}
                  >
                    删除
                  </button>
                </div>

                {/* 就地面板：只看 `openDetailIds`（不传时退回 `expandedIds`）——
                    与子节点展开彻底解耦，所以"收面板但子节点还开着"是可能的 */}
                {detailOpen.has(item.id) && nodeContent ? (
                  <div className="tree__detail" data-testid={`${testIdPrefix}-detail`}>
                    {nodeContent(item)}
                  </div>
                ) : null}
              </li>
            )
          })}
        </ul>
      )}

      {/* 没有人接管时，组件自己渲染一个（接管时由页面那个唯一的实例渲染） */}
      {props.onRequestMenu === undefined ? (
        <ContextMenu state={rowMenu.state} onClose={rowMenu.close} />
      ) : null}
    </div>
  )
}
