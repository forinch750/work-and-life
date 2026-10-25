/**
 * 应用外壳的左侧栏（DEVPLAN 阶段 2；第 08 块改成三段可滚）
 *
 * 结构（`TASKS\08` §5.1 / `MASTER.md` §7.2，**三段的位置由 CSS `order` 显式控制**）：
 *
 * ```
 * 1. 顶部  日期 + 收起按钮        ← 固定，永不被推走
 * 2. 导航  总览/计划/学习/…        ← 固定
 * 3. 列表  当前模块的条目          ← 只有这一段滚（页面用 portal 塞进来）
 * 4. 底部  搜索 + 数据与设置       ← 固定
 * ```
 *
 * ⚠️ **为什么必须写 `order`**：DOM 顺序里"列表"在"底部"之前，如果只靠
 * `margin-top: auto` 把底部推下去，列表一长就会把"数据与设置"挤出屏幕
 * （`MASTER.md` §7.2 写明"已踩过"）。有了 `order` + `min-height: 0`，
 * 列表再长也只会自己滚，底部那一段永远在。
 *
 * ## 收起 / 展开（决定 6）
 *
 * - 按钮在**侧栏右上角**，收起后 54px 窄条、**只留图标**
 * - 收起时隐藏：日期、文字标签、快捷键提示、中段列表
 * - 唯一的箭头就是它（"收起/展开"不是选中指示，决定 5）
 */
import { NAV_ITEMS, SEARCH_ITEM, type NavItem } from '../../shared/navigation'

export interface SidebarProps {
  activeView: string
  onSelect: (viewId: string) => void
  /** 今天的日期文字，例如 2026年2月14日 星期六 */
  dateLabel: string
  /** 复习今日到期张数；为 0 或未提供时不显示角标 */
  reviewDue?: number
  /** 计划是否有逾期任务 */
  planOverdue?: boolean
  onOpenSearch: () => void
  /** 是否收起成 54px 窄条（决定 6） */
  collapsed: boolean
  /** 点右上角那个按钮：收起 / 展开 */
  onToggleCollapsed: () => void
  /**
   * 中段列表容器的挂载点。
   *
   * 外壳不认识任何模块的条目形状，只把这个空节点交给页面，
   * 页面用 `SidebarListPortal` 把自己的列表塞进来（见 `SidebarSlot.tsx`）。
   */
  onListRef?: (node: HTMLDivElement | null) => void
}

function Badge({ count }: { count: number }): React.JSX.Element {
  return <span className="nav__badge">{count > 99 ? '99+' : count}</span>
}

function NavButton({
  item,
  active,
  reviewDue,
  planOverdue,
  onSelect
}: {
  item: NavItem
  active: boolean
  reviewDue?: number
  planOverdue?: boolean
  onSelect: (viewId: string) => void
}): React.JSX.Element {
  const classes = ['nav__item']
  if (active) classes.push('nav__item--active')
  if (!item.ready) classes.push('nav__item--planned')

  const showBadge = item.badge === 'reviewDue' && typeof reviewDue === 'number' && reviewDue > 0
  const showDot = item.dot === 'planOverdue' && planOverdue === true

  return (
    <button
      type="button"
      className={classes.join(' ')}
      data-nav-id={item.id}
      data-ready={item.ready ? 'true' : 'false'}
      data-active={active ? 'true' : 'false'}
      aria-current={active ? 'page' : undefined}
      title={item.label}
      onClick={() => onSelect(item.id)}
    >
      {/* 收起后只剩这个图标（决定 6），所以每个导航项都必须有 icon */}
      <span className="nav__icon" aria-hidden="true">
        {item.icon}
      </span>
      <span className="nav__label">{item.label}</span>
      {showBadge ? <Badge count={reviewDue} /> : null}
      {showDot ? <span className="nav__dot" title="有逾期任务" /> : null}
      {!item.ready ? <span className="nav__tag">待开发</span> : null}
    </button>
  )
}

export function Sidebar({
  activeView,
  onSelect,
  dateLabel,
  reviewDue,
  planOverdue,
  onOpenSearch,
  collapsed,
  onToggleCollapsed,
  onListRef
}: SidebarProps): React.JSX.Element {
  const main = NAV_ITEMS.filter((item) => item.section === 'main')
  const planned = NAV_ITEMS.filter((item) => item.section === 'planned')
  const tool = NAV_ITEMS.filter((item) => item.section === 'tool')

  const renderGroup = (items: NavItem[]): React.JSX.Element => (
    <>
      {items.map((item) => (
        <NavButton
          key={item.id}
          item={item}
          active={activeView === item.id}
          reviewDue={reviewDue}
          planOverdue={planOverdue}
          onSelect={onSelect}
        />
      ))}
    </>
  )

  return (
    <nav
      className={`sidebar${collapsed ? ' sidebar--collapsed' : ''}`}
      data-testid="sidebar"
      data-collapsed={collapsed ? '1' : '0'}
      /* 三段的位置与谁滚，验收要能直接读出来（见 phase8 的 P8-L2） */
      data-segment-order="top:1,nav:2,list:3,bottom:4"
      aria-label="主导航"
    >
      {/* ① 顶部：日期 + 收起按钮（按钮必须在右上角） */}
      <div className="sidebar__top" data-testid="sidebar-top" data-segment="top">
        <div className="sidebar__date" data-testid="sidebar-date">
          {dateLabel}
        </div>
        <button
          type="button"
          className="sidebar__collapse"
          data-testid="sidebar-collapse"
          aria-label={collapsed ? '展开侧栏' : '收起侧栏'}
          aria-expanded={!collapsed}
          title={collapsed ? '展开侧栏' : '收起侧栏'}
          onClick={onToggleCollapsed}
        >
          {/* 全部界面里**唯一**的箭头（决定 5） */}
          {collapsed ? '›' : '‹'}
        </button>
      </div>

      {/* ② 导航：固定，不参与滚动 */}
      <div className="sidebar__nav" data-testid="sidebar-nav" data-segment="nav">
        <div className="sidebar__group">{renderGroup(main)}</div>
        <div className="sidebar__divider" />
        <div className="sidebar__group">{renderGroup(planned)}</div>
      </div>

      {/* ③ 中段列表：**只有这一段滚**；内容由当前模块用 portal 塞进来 */}
      <div
        className="sidebar__list"
        data-testid="sidebar-list"
        data-segment="list"
        ref={onListRef}
      />

      {/* ④ 底部：搜索 + 数据与设置，固定（order 保证它永不被挤出屏幕） */}
      <div className="sidebar__bottom" data-testid="sidebar-bottom" data-segment="bottom">
        <div className="sidebar__divider" />
        <button
          type="button"
          className="nav__search"
          data-testid="nav-search"
          title={`搜索（${SEARCH_ITEM.shortcut}）`}
          onClick={onOpenSearch}
        >
          <span className="nav__icon" aria-hidden="true">
            {SEARCH_ITEM.icon}
          </span>
          <span className="nav__label">{SEARCH_ITEM.label}</span>
          <span className="nav__kbd">{SEARCH_ITEM.shortcut}</span>
        </button>
        <div className="sidebar__group">{renderGroup(tool)}</div>
      </div>
    </nav>
  )
}
