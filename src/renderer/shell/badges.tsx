/**
 * 导航角标数据（DEVPLAN 阶段 5 / PRD §2.2；第 10 块把纯函数搬到 `shared/badges.ts`）
 *
 * 只给"复习"数字角标（今日到期张数）与"计划"红点（有逾期任务），
 * 其它模块一律不加，避免界面到处是提醒。
 *
 * 用 Context 而不是在每个组件里各自查询：角标影响整个导航栏，
 * 数据变化时需要统一刷新。
 *
 * **算法本身不在这里**：`computeBadges` 在 `shared/badges.ts`（纯函数、有单测）。
 * 第 10 块要钉"角标 = 复习页汇总横条总数"，那条等式只有搬成共享函数才验得了。
 */
import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react'
import { dateKey } from '../../shared/date'
import { EMPTY_BADGES, computeBadges, type BadgeState } from '../../shared/badges'
import { getDataApi } from '../lib/dataClient'
import { subscribeDataChanged } from '../lib/dataEvents'

export { computeBadges, type BadgeState }

const INITIAL: BadgeState = EMPTY_BADGES

const BadgeContext = createContext<BadgeState>(INITIAL)

export function useBadges(): BadgeState {
  return useContext(BadgeContext)
}

export function BadgeProvider({ children }: { children: ReactNode }): React.JSX.Element {
  const [state, setState] = useState<BadgeState>(INITIAL)

  useEffect(() => {
    let alive = true

    const refresh = async (): Promise<void> => {
      try {
        const [plan, review] = await Promise.all([
          getDataApi().list('plan'),
          getDataApi().list('review')
        ])
        if (!alive) return
        setState(
          computeBadges(
            plan as unknown as Array<Record<string, unknown>>,
            review as unknown as Array<Record<string, unknown>>,
            dateKey(new Date())
          )
        )
      } catch {
        /* 角标拿不到数据不该影响使用 */
      }
    }

    void refresh()
    const unsubscribe = subscribeDataChanged(() => {
      void refresh()
    })
    return () => {
      alive = false
      unsubscribe()
    }
  }, [])

  const value = useMemo(() => state, [state])
  return <BadgeContext.Provider value={value}>{children}</BadgeContext.Provider>
}
