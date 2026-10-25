/**
 * 首页总览（DEVPLAN 阶段 4 / PRD §3）
 *
 * 严格四个区块：快速记一笔 / 今日计划 / 需要你的关注 / 最近备忘。
 * 关键规则：
 *   - 今日计划**只列今天安排的**（修改 6 轮：逾期不混进来，归关注卡），最多 3 项，
 *     超出显示"还有 N 项"；**手动标了「未完成」的也不列**（修改 7 轮）
 *   - 可以现场勾选完成
 *   - 关注卡有内容才出现，全为 0 时整块隐藏（「逾期未完成」那张卡**不数**被标记的）
 */
import { useCallback, useEffect, useMemo, useState } from 'react'
import { dateKey, formatFullDate, greeting, relativeDayLabel } from '../../../shared/date'
import { getDataApi } from '../../lib/dataClient'
import { type PlanTask, isHeld } from '../../../shared/plan'
import { countsAsOverdue, groupForToday } from '../../../shared/planLogic'
import { normalizeMemos, type MemoRecord } from '../memo/MemoPage'
import { memoPlainText } from '../../../shared/memo'
import { HOME_TODAY_LIMIT, selectHomePlan, toTaskList } from './selectHomePlan'
import { EmptyState } from '../../shell/EmptyState'
import { InlineInput } from '../../shell/Editors'

const TODAY_LIMIT = HOME_TODAY_LIMIT

export interface HomePageProps {
  /** 测试注入用：当前时间 */
  now?: Date
  /** 点击"查看完整计划"等跳转 */
  onNavigate?: (viewId: string) => void
}

interface AttentionCard {
  id: string
  label: string
  count: number
  actionLabel: string
  viewId: string
}

export function HomePage({ now, onNavigate }: HomePageProps): React.JSX.Element {
  const today = useMemo(() => now ?? new Date(), [now])
  const todayKeyValue = dateKey(today)

  const [tasks, setTasks] = useState<PlanTask[]>([])
  const [memos, setMemos] = useState<MemoRecord[]>([])
  const [reviewDue, setReviewDue] = useState(0)
  const [learningActive, setLearningActive] = useState(0)
  const [error, setError] = useState<string | null>(null)
  const [flash, setFlash] = useState<string | null>(null)
  const [expanded, setExpanded] = useState(false)
  /**
   * 数据读回来没有（`home-today-plan` 的 `data-loaded`）。
   *
   * 为什么要这个读数：验收要区分"这里真的没有今天的任务"与"数据还没到"——
   * 两者在 DOM 上都是"一条 `home-task-row` 也没有"，只靠行数是分不清的
   * （与计划页的 `plan-state` 同一个用途）。
   */
  const [loaded, setLoaded] = useState(false)

  const reload = useCallback(async () => {
    try {
      const [planRecords, memoRecords, reviewRecords, learningRecords] = await Promise.all([
        getDataApi().list('plan'),
        getDataApi().list('memo'),
        getDataApi().list('review'),
        getDataApi().list('learning')
      ])

      setTasks(
        toTaskList(planRecords)
      )
      setMemos(normalizeMemos(memoRecords))

      // 复习到期：到期日 <= 今天的卡片
      const due = reviewRecords.filter((record) => {
        if (record.deletedAt) return false
        const card = record as unknown as Record<string, unknown>
        const stage = Number.isFinite(card['stage']) ? Number(card['stage']) : 0
        if (stage >= 5) return false
        const dueDate = typeof card['dueDate'] === 'string' ? card['dueDate'] : todayKeyValue
        return dueDate <= todayKeyValue
      })
      setReviewDue(due.length)

      // 学习进行中：状态为进行中的主题数
      const active = learningRecords.filter((record) => {
        if (record.deletedAt) return false
        return (record as unknown as Record<string, unknown>)['status'] === 'active'
      })
      setLearningActive(active.length)

      setError(null)
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      // 读失败也算"读过一遍"：否则验收会一直等下去，看不出真正的错误
      setLoaded(true)
    }
  }, [todayKeyValue])

  useEffect(() => {
    void reload()
  }, [reload])

  const groups = useMemo(() => groupForToday(tasks, todayKeyValue), [tasks, todayKeyValue])

  /**
   * 今日清单 = **只今天**，并且**不含手动标了「未完成」的**（修改 6 → 修改 7 轮）。
   *
   * 用户原话（修改 6）：「今日计划不要显示昨天的计划（未移动）」。
   * 旧口径是"逾期 + 今天，逾期排前面（与计划页一致）"，首页因此混进带
   * 「昨天」标签的任务；现在逾期一条都不进这份清单，它们归下面的
   * 「需要你的关注 → 逾期未完成」那张卡（PRD §3 规定的固定三张卡之一）。
   *
   * 修改 7 轮又加了一层（`修改-7.md` §五 第 8 条）：**标了「未完成」的也不显示**——
   * 哪怕它的日期就是今天。`groupForToday` 已经把 `held` 拆进单独一组，
   * 这里再显式挡一道，免得将来有人改分组时把它漏回首页。
   *
   * `overdue` 字段仍然保留在条目上、行上的「昨天」标签也留着——
   * 只是按新数据源永远走不到那个分支（不删类型/字段，免得牵扯别处）。
   */
  const todayList = useMemo(
    () => groups.today.filter((task) => !isHeld(task)).map((task) => ({ task, overdue: false })),
    [groups]
  )
  const visibleList = expanded ? todayList : todayList.slice(0, TODAY_LIMIT)
  const hiddenCount = todayList.length - visibleList.length

  /**
   * 逾期关注卡的数量：**统计口径**（修改 7 轮换成 `countsAsOverdue`）。
   *
   * 用户原话：「标记未完成不显示逾期。」——所以关注卡也不数被标记的那几条。
   * 它与页头「逾期 N 项」、导航红点、日历逾期色读同一个判定（一处定义、四处受益）。
   */
  const overdueCount = useMemo(
    () => tasks.filter((task) => countsAsOverdue(task, todayKeyValue)).length,
    [tasks, todayKeyValue]
  )

  const cards: AttentionCard[] = useMemo(() => {
    const list: AttentionCard[] = []
    if (reviewDue > 0) {
      list.push({ id: 'review', label: '复习到期', count: reviewDue, actionLabel: '开始复习', viewId: 'review' })
    }
    if (overdueCount > 0) {
      list.push({
        id: 'overdue',
        label: '逾期未完成',
        count: overdueCount,
        actionLabel: '去处理',
        viewId: 'plan'
      })
    }
    if (learningActive > 0) {
      list.push({
        id: 'learning',
        label: '学习进行中',
        count: learningActive,
        actionLabel: '继续学习',
        viewId: 'learning'
      })
    }
    return list
  }, [reviewDue, overdueCount, learningActive])

  const toggleTask = async (task: PlanTask): Promise<void> => {
    // 与计划页一致：以主进程最新记录为准，避免连续点击时用过期状态
    const fresh = await getDataApi().list('plan')
    const current = toTaskList(fresh).find((item) => item.id === task.id)
    const nowDone = !(current?.done ?? task.done)
    await getDataApi().update('plan', task.id, {
      done: nowDone,
      doneAt: nowDone ? new Date().toISOString() : null
    })
    await getDataApi().flush()
    await reload()
  }

  const quickCapture = async (text: string): Promise<void> => {
    await getDataApi().add('memo', { text, pinned: false })
    await reload()
    setFlash('已记为备忘')
    setTimeout(() => setFlash(null), 1600)
  }

  const recentMemos = memos.slice(0, 5)

  return (
    <div className="page" data-testid="home-page">
      <header className="home__header">
        <h1 className="home__greeting page__title" data-testid="home-greeting">
          {greeting(today)}
        </h1>
        <p className="home__date" data-testid="home-date">
          {formatFullDate(today)}
        </p>
      </header>

      {error ? <p className="notice notice--error">读取失败：{error}</p> : null}

      {/* ① 快速记一笔 */}
      <section data-testid="home-quick-capture">
        <InlineInput
          placeholder="快速记一笔…（回车存为备忘）"
          hint={flash ?? '已保存'}
          testId="home-quick-input"
          onSubmit={quickCapture}
        />
      </section>

      {/* ② 今日计划 */}
      <section className="panel" data-testid="home-today-plan" data-loaded={loaded ? '1' : '0'}>
        <div className="panel__head">
          <h2 className="panel__title">今日计划</h2>
          <button
            type="button"
            className="link"
            data-testid="home-view-full-plan"
            onClick={() => onNavigate?.('plan')}
          >
            查看完整计划 →
          </button>
        </div>

        {todayList.length === 0 ? (
          // 空状态**不提逾期**（修改 6 轮）：逾期不在这块显示，归「需要你的关注」那张卡。
          <EmptyState message="今天没有安排的任务。" testId="home-plan-empty" />
        ) : (
          <>
            <ul className="task-list">
              {visibleList.map(({ task, overdue }) => (
                <li
                  key={task.id}
                  className={`task${overdue ? ' task--overdue' : ''}${task.done ? ' task--done' : ''}`}
                  data-testid="home-task-row"
                  data-task-id={task.id}
                >
                  <button
                    type="button"
                    className="task__check"
                    data-testid="home-task-toggle"
                    aria-label={task.done ? '标记为未完成' : '标记为已完成'}
                    onClick={() => void toggleTask(task)}
                  >
                    {task.done ? '✓' : '○'}
                  </button>
                  <span className="task__title">{task.title}</span>
                  {overdue ? (
                    <span className="task__meta task__meta--warn">
                      {relativeDayLabel(task.date, today)}
                    </span>
                  ) : null}
                </li>
              ))}
            </ul>
            {hiddenCount > 0 ? (
              <button
                type="button"
                className="link"
                data-testid="home-expand-plan"
                onClick={() => setExpanded(true)}
              >
                还有 {hiddenCount} 项，展开
              </button>
            ) : null}
            {expanded && todayList.length > TODAY_LIMIT ? (
              <button
                type="button"
                className="link"
                data-testid="home-collapse-plan"
                onClick={() => setExpanded(false)}
              >
                收起
              </button>
            ) : null}
          </>
        )}
      </section>

      {/* ③ 需要你的关注：有内容才出现 */}
      {cards.length > 0 ? (
        <section className="attention" data-testid="home-attention">
          <h2 className="panel__title">需要你的关注</h2>
          <div className="attention__grid">
            {cards.map((card) => (
              <div key={card.id} className="attention__card" data-testid={`attention-${card.id}`}>
                <span className="attention__label">{card.label}</span>
                <span className="attention__count">{card.count}</span>
                <button
                  type="button"
                  className="button"
                  onClick={() => onNavigate?.(card.viewId)}
                >
                  {card.actionLabel}
                </button>
              </div>
            ))}
          </div>
        </section>
      ) : null}

      {/* ④ 最近备忘 */}
      <section className="panel" data-testid="home-recent-memos">
        <div className="panel__head">
          <h2 className="panel__title">最近备忘</h2>
          <button
            type="button"
            className="link"
            data-testid="home-view-all-memos"
            onClick={() => onNavigate?.('memo')}
          >
            全部 →
          </button>
        </div>
        {recentMemos.length === 0 ? (
          <EmptyState message="还没有备忘。" testId="home-memo-empty" />
        ) : (
          <ul className="memo-mini" data-testid="home-memo-list">
            {recentMemos.map((memo) => (
              <li key={memo.id} className="memo-mini__item" data-testid="home-memo-item">
                {/* 首页只显示一行摘要：富文本先抽纯文本，否则会露出 <p> 这种标签 */}
                <span className="memo-mini__text">{memoPlainText(memo)}</span>
                <span className="memo-mini__time">
                  {String(memo.createdAt).slice(0, 10).replace(/-0?/g, '/').replace(/^\//, '')}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  )
}

/** 供测试与调试：首页今日计划的条数上限 */
export { HOME_TODAY_LIMIT, selectHomePlan }
