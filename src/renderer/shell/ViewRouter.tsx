/**
 * 页面路由（DEVPLAN 阶段 2 起，随阶段推进逐步接入真实模块）
 *
 * 每接入一个模块，只需要在这里替换掉对应的占位条目。
 *
 * `newSignal` / `todaySignal` 是第 06 块加的**热键信号**：
 * `N`（当前模块新建一条）与 `T`（回到今天）由 `App.tsx` 统一注册，
 * 再按"当前页面支持什么"（`shared/hotkeys.ts`）往下发一个自增数字。
 * 页面只认信号、不认识键盘，所以：
 *   - 复习页拿不到 `N`（复习卡从别处生成，"新建"在那儿没有含义，决定 29）
 *   - `T` 只发给计划页
 */
import { findNavItem } from '../../shared/navigation'
import { HomePage } from '../modules/home/HomePage'
import { LearningPage } from '../modules/learning/LearningPage'
import { MemoPage } from '../modules/memo/MemoPage'
import { PlanPage } from '../modules/plan/PlanPage'
import { ReadingPage } from '../modules/reading/ReadingPage'
import { ReviewPage } from '../modules/review/ReviewPage'
import { SettingsPage } from '../modules/settings/SettingsPage'
import { EmptyState } from '../shell/EmptyState'
import { PageShell } from '../shell/PageShell'
import { PlaceholderCard } from '../shell/PlaceholderCard'

export interface ViewRouterProps {
  viewId: string
  /** 页面内跳转（首页的"查看完整计划"等） */
  onNavigate?: (viewId: string) => void
  /** 测试注入用：当前时间 */
  now?: Date
  /** 每周从周几开始 */
  weekStart?: 1 | 7
  /** 复习间隔强度（来自设置） */
  reviewIntensity?: 'standard' | 'relaxed' | 'intense'
  /** 热键 `N`：数字变了就该打开"新建"入口（页面自己决定打开什么） */
  newSignal?: number
  /** 热键 `T`：数字变了就回到今天（只有计划页用） */
  todaySignal?: number
}

export function ViewRouter({
  viewId,
  onNavigate,
  now,
  weekStart = 1,
  reviewIntensity = 'standard',
  newSignal = 0,
  todaySignal = 0
}: ViewRouterProps): React.JSX.Element {
  const navItem = findNavItem(viewId)

  // 待开发模块：说明卡（灰项点进去的交代）
  if (navItem && !navItem.ready && navItem.placeholder) {
    return (
      <PlaceholderCard
        moduleLabel={navItem.label}
        plannedVersion={navItem.plannedVersion ?? '后续版本'}
        content={navItem.placeholder}
      />
    )
  }

  switch (viewId) {
    case 'home':
      return <HomePage now={now} onNavigate={onNavigate} />
    case 'plan':
      return <PlanPage now={now} weekStart={weekStart} newSignal={newSignal} todaySignal={todaySignal} />
    case 'learning':
      return <LearningPage newSignal={newSignal} />
    case 'review':
      // 刻意不传 newSignal：复习页不注册 N（决定 29）
      return <ReviewPage now={now} intensity={reviewIntensity} />
    case 'memo':
      return <MemoPage newSignal={newSignal} />
    case 'reading':
      return <ReadingPage newSignal={newSignal} />
    case 'settings':
      return <SettingsPage />
    default:
      break
  }

  return (
    <PageShell title="未找到页面">
      <EmptyState message="这个页面不存在。请从左侧导航选择。" testId="placeholder-unknown" />
    </PageShell>
  )
}
