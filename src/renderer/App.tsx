/**
 * 应用外壳（DEVPLAN 阶段 2 / 热键在第二轮 FEAT-008 接线）
 *
 * 左侧固定导航栏 + 右侧工作区；全局热键、快速记一笔、主题都在这里接上。
 * 具体页面由 ViewRouter 按当前视图分发。
 *
 * ## 热键的接线方式（第 06 块）
 *
 * 1. 绑定表从 `app` 模块的偏好里读（`resolveHotkeys`：默认值打底，改过的覆盖），
 *    通过 `HotkeyBindingsContext` 发给整棵树 —— 设置页改了键，这里收到
 *    `worklife:data-changed` 就重读，**当场生效**，不用重启。
 * 2. 全局动作（保存 / 搜索 / 快速记一笔 / 切模块 / Esc）直接在这里注册。
 * 3. `N` / `T` 是**按当前页面分发**的：哪个页面支持什么由 `shared/hotkeys.ts` 决定
 *    （复习页刻意不支持 `N`）。页面只收到一个自增的"信号"，自己决定打开什么，
 *    这样 App 不需要知道每个页面的表单长什么样。
 */
import { useCallback, useEffect, useMemo, useState } from 'react'
import { DEFAULT_VIEW_ID, findNavItem } from '../shared/navigation'
import { formatFullDate } from '../shared/date'
import { newEntryKindOfView, todayHotkeyAppliesTo } from '../shared/hotkeys'
import {
  DEFAULT_HOTKEYS,
  isSidebarCollapsed,
  readPreferences,
  resolveHotkeys,
  type HotkeyAction,
  type ReviewIntensity,
  type WeekStart
} from '../shared/preferences'
import { getDataApi } from './lib/dataClient'
import { subscribeDataChanged } from './lib/dataEvents'
import { HotkeyBindingsContext, type HotkeyBindings } from './lib/hotkeyBindings'
import { useHotkeys } from './lib/hotkeys'
import { saveSidebarCollapsed } from './lib/prefsClient'
import { applyTheme, loadTheme } from './lib/theme'
import { Sidebar } from './shell/Sidebar'
import { SidebarListTargetContext } from './shell/SidebarSlot'
import { QuickCapture } from './shell/QuickCapture'
import { SearchDrawer } from './shell/SearchDrawer'
import { ViewRouter } from './shell/ViewRouter'
import { useBadges } from './shell/badges'

export interface AppProps {
  /** 初始视图（测试注入用） */
  initialView?: string
  /** 测试注入用：当前时间 */
  now?: Date
}

export function App({ initialView, now }: AppProps): React.JSX.Element {
  const today = useMemo(() => now ?? new Date(), [now])
  const [view, setView] = useState<string>(initialView ?? DEFAULT_VIEW_ID)
  const [quickCaptureOpen, setQuickCaptureOpen] = useState(false)
  const [searchOpen, setSearchOpen] = useState(false)
  const badges = useBadges()
  const [flash, setFlash] = useState<string | null>(null)
  /**
   * 跟着数据走的偏好（第 05 块接线周起始日与复习强度，第 06 块接上快捷键绑定）。
   *
   * `weekStart` 决定日历与周视图**每周从周几开始**（§5.11：日历必须遵守这条偏好），
   * `reviewIntensity` 决定复习间隔的缩放。
   * 两者以前只"存得下"、没"用得上"——设置页改了不生效，等于没接。
   */
  const [weekStart, setWeekStart] = useState<WeekStart>(1)
  const [reviewIntensity, setReviewIntensity] = useState<ReviewIntensity>('standard')
  /** 完整绑定表（默认值打底 + 用户改过的覆盖） */
  const [hotkeys, setHotkeys] = useState<HotkeyBindings>({ ...DEFAULT_HOTKEYS })
  /**
   * `N` / `T` 的分发信号。
   *
   * 用一个自增的数字而不是回调：App 只表达"用户按了 N"，
   * 具体打开哪个表单是各页面自己的事（复习页不在支持列表里，因此永远收不到）。
   */
  const [newSignal, setNewSignal] = useState(0)
  const [todaySignal, setTodaySignal] = useState(0)
  /**
   * 侧栏收起状态（第 08 块 · 决定 6）。
   *
   * 存在 `data\app.json` 的偏好里，**重新打开程序还是原样**——
   * 收起侧栏是"我把界面收拾成这样"的决定，不该每次重启都弹回去。
   */
  const [collapsed, setCollapsed] = useState(false)
  /**
   * 侧栏中段的容器节点。
   *
   * 外壳不认识任何模块的条目形状：它只把空节点交给页面，
   * 页面用 `SidebarListPortal` 把自己的列表塞进来（见 `shell/SidebarSlot.tsx`）。
   */
  const [listTarget, setListTarget] = useState<HTMLDivElement | null>(null)

  useEffect(() => {
    let alive = true
    const load = async (): Promise<void> => {
      try {
        const records = await getDataApi().list('app')
        if (!alive) return
        const preferences = readPreferences(records as unknown as Array<Record<string, unknown>>)
        setWeekStart(preferences.weekStart)
        setReviewIntensity(preferences.reviewIntensity)
        setHotkeys(resolveHotkeys(preferences.hotkeys))
        setCollapsed(isSidebarCollapsed(preferences))
      } catch {
        /* 读不到偏好就用默认值，不影响使用 */
      }
    }
    void load()
    const unsubscribe = subscribeDataChanged(() => {
      void load()
    })
    return () => {
      alive = false
      unsubscribe()
    }
  }, [])

  // 启动时先把已保存的主题应用上，避免闪一下浅色再变深色
  useEffect(() => {
    const saved = loadTheme()
    applyTheme(saved)
  }, [])

  const showFlash = useCallback((message: string) => {
    setFlash(message)
    setTimeout(() => setFlash(null), 1800)
  }, [])

  const navigate = useCallback((target: string) => setView(target), [])

  /**
   * 收起 / 展开侧栏（决定 6）。
   *
   * 先改界面再落盘：点一下要"立刻"收起来，不能等磁盘。
   * 写盘失败也保留本次会话的状态（用不了偏好不该让界面卡住）。
   */
  const toggleSidebar = useCallback((): void => {
    const next = !collapsed
    setCollapsed(next)
    void saveSidebarCollapsed(next).catch(() => {
      /* 偏好写不进去不影响本次使用 */
    })
  }, [collapsed])

  // ---- 全局热键 ----
  const hotkeySpecs = useMemo(() => {
    const specs: Array<{ combo: string; handler: () => void }> = []
    const push = (action: HotkeyAction, handler: () => void): void => {
      const combo = hotkeys[action]
      // 空组合键不注册：宁可没有这条热键，也不要在每次按键时都命中
      if (combo !== '') specs.push({ combo, handler })
    }

    push('search', () => setSearchOpen(true))
    push('save', () => {
      // 手动保存（第二轮 BUG-006）：写操作平时会自动保存，
      // 这里给一个"我现在就要落盘"的明确出口，避免用户不放心。
      void (async () => {
        try {
          const hadPending = await getDataApi().flush()
          showFlash(hadPending ? '已保存到磁盘' : '没有待保存的改动')
        } catch (reason) {
          showFlash(`保存失败：${reason instanceof Error ? reason.message : String(reason)}`)
        }
      })()
    })
    // 快速记一笔（PRD §2.5 的 Ctrl+Alt+M）：任何页面都能唤出小条
    push('memo', () => setQuickCaptureOpen(true))
    push('review', () => navigate('review'))
    push('plan', () => navigate('plan'))
    push('learning', () => navigate('learning'))
    push('reading', () => navigate('reading'))
    push('new', () => {
      // 决定 29：复习页不注册 N（newEntryKindOfView('review') === null）
      if (newEntryKindOfView(view) === null) return
      setNewSignal((value) => value + 1)
    })
    push('today', () => {
      if (!todayHotkeyAppliesTo(view)) return
      setTodaySignal((value) => value + 1)
    })
    // Esc 永远排在最后：它要与其他页面自己的 Esc（退出复习）共存，且不属于可改绑定
    specs.push({
      combo: 'escape',
      handler: () => {
        setQuickCaptureOpen(false)
        setSearchOpen(false)
      }
    })
    return specs
  }, [hotkeys, navigate, showFlash, view])

  useHotkeys(hotkeySpecs)

  return (
    <HotkeyBindingsContext.Provider value={hotkeys}>
      <div className="app" data-testid="app-shell">
        <Sidebar
          activeView={view}
          onSelect={setView}
          dateLabel={formatFullDate(today)}
          reviewDue={badges.reviewDue}
          planOverdue={badges.planOverdue}
          onOpenSearch={() => setSearchOpen(true)}
          collapsed={collapsed}
          onToggleCollapsed={toggleSidebar}
          onListRef={setListTarget}
        />

        {/*
          中段列表的容器在这里传下去：页面 portal 进来的是**自己那份列表**，
          数据与选中状态都留在页面里，外壳不需要认识任何模块的形状。
        */}
        <SidebarListTargetContext.Provider value={listTarget}>
          <main className="workspace" data-testid="workspace" data-view={view}>
            <ViewRouter
              viewId={view}
              onNavigate={setView}
              now={now}
              weekStart={weekStart}
              reviewIntensity={reviewIntensity}
              newSignal={newSignal}
              todaySignal={todaySignal}
            />
          </main>
        </SidebarListTargetContext.Provider>
        {/* 快速记一笔：任何页面都能用 Ctrl+Alt+M 唤出 */}
        <QuickCapture
          open={quickCaptureOpen}
          onClose={() => setQuickCaptureOpen(false)}
          onSaved={(message) => showFlash(message)}
        />

        {/* 全局搜索：Ctrl+K 打开，结果按模块分组 */}
        <SearchDrawer
          open={searchOpen}
          onClose={() => setSearchOpen(false)}
          onNavigate={setView}
        />

        {flash ? (
          <div className="flash" data-testid="flash" role="status">
            {flash}
          </div>
        ) : null}
      </div>
    </HotkeyBindingsContext.Provider>
  )
}

/** 供测试确认数据接口是否可用 */
export async function probeDataApi(): Promise<boolean> {
  try {
    await getDataApi().list('memo')
    return true
  } catch {
    return false
  }
}

/** 当前视图是否为已完成的模块（外露面，便于测试与调试） */
export function isReadyView(viewId: string): boolean {
  return findNavItem(viewId)?.ready === true
}
