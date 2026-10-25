/**
 * 通用右键菜单（第二轮 FEAT-001 的地基；03 块补齐分组与 `⋯` 入口）
 *
 * 定位与键盘导航的算法在 src\shared\contextMenu.ts（可单测），
 * 这里只负责：打开/关闭、鼠标与键盘事件、把菜单渲染到界面上。
 *
 * ## 两个入口，同一份定义
 *
 * 菜单项的**内容**来自 `src\shared\contextMenu.ts`（`taskMenuItems` 等），
 * 这个文件只负责渲染。因此：
 *
 *   - **右键**：元素上挂 `onContextMenu={(event) => openMenuFromEvent(event, items)}`
 *   - **`⋯` 小菜单**：用下面的 `<MenuButton>`（它内部就是同一个 `ContextMenu`）
 *
 * 两条路径渲染的是同一个组件、同一批 `MenuItemSpec`，所以不会出现
 * "右键里有删除、`⋯` 里没有"这种两处不同步。
 *
 * 用法：
 *
 *   const menu = useContextMenu()
 *   <li onContextMenu={(e) => menu.openFromEvent(e, items)}>…</li>
 *   <MenuButton menu={menu} items={items} testId="task-menu" />
 *   <ContextMenu state={menu.state} onClose={menu.close} />
 */
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import {
  firstEnabledIndex,
  nextEnabledIndex,
  placeMenu,
  type MenuPoint
} from '../../shared/contextMenu'
import { disabledFlags, type MenuItemSpec } from '../../shared/menuItems'

export interface ContextMenuState {
  open: boolean
  point: MenuPoint
  items: MenuItemSpec[]
  /** 触发这次菜单的元素（`⋯` 按钮或右键的那一行），供验收核对来源 */
  source: string
}

export interface UseContextMenuResult {
  state: ContextMenuState
  /** 从任意鼠标事件打开（右键或左键点 `⋯`） */
  openAt: (event: { clientX: number; clientY: number }, items: MenuItemSpec[], source?: string) => void
  /** 直接以坐标打开 */
  openAtPoint: (point: MenuPoint, items: MenuItemSpec[], source?: string) => void
  /** 右键专用：阻止系统默认菜单后打开 */
  openFromEvent: (event: React.MouseEvent, items: MenuItemSpec[], source?: string) => void
  close: () => void
}

const CLOSED: ContextMenuState = { open: false, point: { x: 0, y: 0 }, items: [], source: '' }

export function useContextMenu(): UseContextMenuResult {
  const [state, setState] = useState<ContextMenuState>(CLOSED)

  const openAtPoint = useCallback(
    (point: MenuPoint, items: MenuItemSpec[], source = ''): void => {
      if (items.length === 0) return
      setState({ open: true, point, items, source })
    },
    []
  )

  const openAt = useCallback(
    (event: { clientX: number; clientY: number }, items: MenuItemSpec[], source = ''): void => {
      openAtPoint({ x: event.clientX, y: event.clientY }, items, source)
    },
    [openAtPoint]
  )

  const openFromEvent = useCallback(
    (event: React.MouseEvent, items: MenuItemSpec[], source = ''): void => {
      // 拦掉系统的浏览器右键菜单——本程序是本地应用，不该出现"网页另存为"那套
      event.preventDefault()
      event.stopPropagation()
      openAt(event, items, source)
    },
    [openAt]
  )

  const close = useCallback((): void => setState(CLOSED), [])

  return { state, openAt, openAtPoint, openFromEvent, close }
}

export interface ContextMenuProps {
  state: ContextMenuState
  onClose: () => void
}

export function ContextMenu({ state, onClose }: ContextMenuProps): React.JSX.Element | null {
  const boxRef = useRef<HTMLDivElement | null>(null)
  const [position, setPosition] = useState<MenuPoint>(state.point)
  const [activeIndex, setActiveIndex] = useState(-1)

  const flags = disabledFlags(state.items)

  // 每次打开：先按触发点摆好，再按实际尺寸修正（尺寸只有渲染后才知道）
  useLayoutEffect(() => {
    if (!state.open) return
    const box = boxRef.current
    if (!box) {
      setPosition(state.point)
      return
    }
    const rect = box.getBoundingClientRect()
    setPosition(
      placeMenu(state.point, { width: rect.width, height: rect.height }, {
        width: window.innerWidth,
        height: window.innerHeight
      })
    )
    setActiveIndex(firstEnabledIndex(flags))
    // 菜单项数量变化时重算即可；flags 每次都重建，不能进依赖数组
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.open, state.point, state.items.length])

  /**
   * 打开后把焦点收到菜单上。
   *
   * 两个理由：
   *   1. 方向键与回车要落在菜单里（不聚焦的话键盘导航看着有、实际按不动）
   *   2. 复习页那套全局热键（空格 / 1 / 2 / 3）不该在菜单开着时抢键
   */
  useEffect(() => {
    if (!state.open) return
    boxRef.current?.focus()
  }, [state.open])

  // 点击别处 / 窗口尺寸变化就关掉
  useEffect(() => {
    if (!state.open) return
    const onPointerDown = (event: MouseEvent): void => {
      if (boxRef.current && event.target instanceof Node && boxRef.current.contains(event.target)) {
        return
      }
      onClose()
    }
    const onResize = (): void => onClose()
    window.addEventListener('mousedown', onPointerDown)
    window.addEventListener('resize', onResize)
    return () => {
      window.removeEventListener('mousedown', onPointerDown)
      window.removeEventListener('resize', onResize)
    }
  }, [state.open, onClose])

  /**
   * 键盘：Esc 关闭、上下移动高亮、回车/空格选项。
   *
   * ⚠️ 两个坑，都踩过：
   *
   * 1. **必须挂原生 window 监听，不能用 React 的 `onKeyDown`。**
   *    React 18 把事件代理挂在 `#root` 上，只有从页面里真实冒泡上去的事件才会走到它；
   *    验收脚本（以及任何"在 window 上派发键盘事件"的代码）派发的事件是**从 window 出发**的，
   *    压根不经过 `#root` —— 于是菜单里的 `onKeyDown` 永远收不到，
   *    表现就是"按 Esc 关不掉菜单"。
   * 2. **必须用捕获阶段 + `stopPropagation`。**
   *    抽屉（`Editors.tsx` 的 `Drawer`）与确认框也各自在 window 上听 Esc。
   *    菜单开在抽屉里面时（例如读书：书的详情本身就是抽屉，章节行在抽屉里），
   *    Esc 冒泡到 window 会**同时**关掉菜单和抽屉 —— 用户只是想关菜单，
   *    结果整个详情页被关掉了（已踩过：P8-J8 里抽屉消失导致章节行找不到）。
   *    捕获阶段先拿到事件、再拦住它，抽屉那份监听就收不到了。
   */
  useEffect(() => {
    if (!state.open) return
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        event.preventDefault()
        event.stopPropagation()
        onClose()
        return
      }
      if (event.key === 'ArrowDown') {
        event.preventDefault()
        event.stopPropagation()
        setActiveIndex((current) => nextEnabledIndex(flags, current, 1))
        return
      }
      if (event.key === 'ArrowUp') {
        event.preventDefault()
        event.stopPropagation()
        setActiveIndex((current) => nextEnabledIndex(flags, current, -1))
        return
      }
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault()
        event.stopPropagation()
        const item = state.items[activeIndex]
        if (item && item.disabled !== true) {
          onClose()
          item.onSelect()
        }
      }
    }
    // 捕获阶段：抢在抽屉 / 全局热键之前处理，并挡住它们
    window.addEventListener('keydown', onKeyDown, true)
    return () => window.removeEventListener('keydown', onKeyDown, true)
    // flags / state.items 每次渲染都会重建，不能进依赖数组；
    // 菜单开着期间 items 不会变（点了就关），activeIndex 用最新一次渲染的值即可
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.open, state.items, activeIndex, onClose])

  if (!state.open) return null

  /**
   * 上一项的分组，用来判断"要不要画组标题"。
   * 同一个 `group` 只在组里第一项上画一次，后面几项不重复画。
   */
  let lastGroup: string | undefined

  return (
    <div
      ref={boxRef}
      className="context-menu"
      role="menu"
      tabIndex={-1}
      data-testid="context-menu"
      data-menu-source={state.source}
      style={{ left: position.x, top: position.y }}
      // 菜单内部右键不应再弹系统菜单
      onContextMenu={(event) => event.preventDefault()}
    >
      {state.items.map((item, index) => {
        const showGroup = item.group !== undefined && item.group !== lastGroup
        lastGroup = item.group
        return (
          <div className="context-menu__slot" key={item.id}>
            {item.separator === true && index > 0 ? (
              <div className="context-menu__sep" aria-hidden="true" />
            ) : null}
            {showGroup ? <div className="context-menu__group">{item.group}</div> : null}
            <button
              type="button"
              role="menuitem"
              className={`context-menu__item${item.danger ? ' is-danger' : ''}${
                index === activeIndex ? ' is-active' : ''
              }`}
              data-testid={`context-menu-${item.id}`}
              disabled={item.disabled === true}
              onMouseEnter={() => setActiveIndex(index)}
              onClick={() => {
                if (item.disabled === true) return
                onClose()
                item.onSelect()
              }}
            >
              <span className="context-menu__label">{item.label}</span>
              {item.hint ? <span className="context-menu__hint">{item.hint}</span> : null}
            </button>
          </div>
        )
      })}
    </div>
  )
}

export interface MenuButtonProps {
  menu: UseContextMenuResult
  /** 每次打开时现算菜单项：状态（完成 / 置顶）可能刚变过 */
  items: () => MenuItemSpec[]
  /** 按钮的 testid（沿用各页原有的 `task-menu` / `memo-menu` 等，验收不必改） */
  testId?: string
  /** 无障碍与提示文案 */
  label?: string
  /**
   * 按钮样式。
   * 默认 `task__menu-button` 是"行上平时半透明、悬停才明显"的那一套；
   * 列表类实体（备忘 / 卡片 / 树行）想让按钮一直可见时传 `row-menu-button`。
   */
  className?: string
}

/**
 * `⋯` 小菜单按钮。
 *
 * **刻意不做成"锚在按钮下方的下拉"**：那样就得再维护一套定位与键盘导航，
 * 于是又变成"右键一套、`⋯` 一套"。这里统一交给 `ContextMenu`：
 * 位置取按钮自己的 `clientX/clientY`，其余（翻转、Esc、方向键、点别处关闭）全共用。
 */
export function MenuButton({
  menu,
  items,
  testId,
  label = '更多操作',
  className = 'task__menu-button'
}: MenuButtonProps): React.JSX.Element {
  return (
    <button
      type="button"
      className={className}
      aria-label={label}
      aria-haspopup="menu"
      data-testid={testId}
      onClick={(event) => {
        // 行本身可能挂着自己的 onClick（例如树行会展开/折叠），别把菜单点没了
        event.stopPropagation()
        menu.openAt(event, items(), testId ?? 'menu-button')
      }}
    >
      ⋯
    </button>
  )
}
