/**
 * 日历三档（第 05 块 · FEAT-003 / FEAT-005 / BUG-009）
 *
 * **这是「计划」页的一种视图，不是新模块**：它不新增页面、不新增导航入口，
 * 只是把那排视图按钮从三个变五个（今天 / 本周 / 月 / 年 / 全部）。
 *
 * 三档粒度（同一个日历，只换网格密度）：
 *
 * | 视图 | 网格 | 一格代表 | 格子里放什么 |
 * |---|---|---|---|
 * | 本周 | 7 天 × **完整 24 小时** + 顶部固定的"全天"行 | 一小时 | 有 startTime 的任务按时段落格 |
 * | 月   | 7 列 × 6 行 | 一天 | 当天任务数 + 最多 3 条标题 + "还有 N 项…" |
 * | 年   | 4 列 × 3 行 = 12 个月 | 一个月 | 任务数 + 完成率（进度条＝完成率，绿色）|
 *
 * **网格计算全部是纯函数**（`weekGrid.ts` / `monthGrid.ts` / `yearGrid.ts`），
 * 这里只负责画与响应点击 —— 因为 `vitest` 是 `environment: 'node'`，没有 jsdom，
 * 界面行为只能交给端到端验收（`src\main\verify\phase8.ts`）。
 *
 * 复制到别处会坏掉的两条约定：
 *   1. 周视图的 7 个列**必须**是 `data-testid="week-column"`、且**只有这 7 个**
 *      （阶段 4 的 P4-E3 断言"周视图显示 7 列"并按这个 testid 计数）
 *   2. 周视图的任务条**必须**是 `data-testid="week-card"` 且可拖拽
 *      （P4-E3 会派发 dragstart/drop 来改期）
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  addDaysToKey,
  addMonthsToKey,
  addYearsToKey,
  dayOfKey,
  formatMonthLabel,
  fromDateKey,
  monthOfKey,
  weekKeysFor,
  weekdayLabel,
  yearOfKey,
  type WeekStart
} from '../../../shared/date'
import {
  UNSCHEDULED,
  timeLabel,
  type PlanTask
} from '../../../shared/plan'
import { countsAsOverdue } from '../../../shared/planLogic'
import { barStateOf } from './barState'
import {
  MONTH_CELL_MAX_TASKS,
  monthCellOverflow,
  monthGridFor,
  monthWeekdayHeaders
} from './monthGrid'
import {
  WEEK_HOURS,
  WEEK_HOUR_HEIGHT,
  hourLabel,
  initialScrollTop,
  layoutWeek,
  weekHourLabels
} from './weekGrid'
import { yearGridFor } from './yearGrid'

/** 三档视图（`今天` / `全部` 仍是原来的列表，不在这个组件里） */
export type CalendarMode = 'week' | 'month' | 'year'

export interface CalendarPageProps {
  mode: CalendarMode
  tasks: PlanTask[]
  /** 今天（测试可注入） */
  todayKey: string
  /** 每周从周几开始（偏好，必须被日历遵守） */
  weekStart: WeekStart
  /** 当前锚点日期（翻页只改它） */
  anchorKey: string
  onAnchorChange: (key: string) => void
  /** 月视图点某天 / 点"还有 N 项…" → 切到那一天的"今天"列表 */
  onPickDay: (key: string) => void
  /** 年视图点某月 → 切到那个月的月视图 */
  onPickMonth: (key: string) => void
  /** 点空白格新建：日期 + 预填的开始时间（null = 全天行） */
  onCreateAt: (date: string, startTime: string | null) => void
  /** 任务条右键 / `⋯`：复用计划页那一份菜单定义 */
  onTaskContextMenu: (task: PlanTask, event: React.MouseEvent) => void
  /** 拖拽改期的三个回调（与计划页共用一份 ref，见 PlanPage） */
  onDragStartTask: (taskId: string) => void
  onDragEndTask: () => void
  onDropToDate: (key: string) => void
  /** 任务条点开的小面板：编辑 / 标记完成 / 改时间 / 删除 */
  onEditTask: (task: PlanTask) => void
  onToggleDone: (task: PlanTask) => void
  onAdjustTime: (task: PlanTask) => void
  onDeleteTask: (task: PlanTask) => void
}

const MODE_LABELS: Record<CalendarMode, { prev: string; next: string; back: string }> = {
  week: { prev: '上一周', next: '下一周', back: '回到本周' },
  month: { prev: '上一月', next: '下一月', back: '回到本月' },
  year: { prev: '上一年', next: '下一年', back: '回到今年' }
}

/**
 * 任务条的状态色**移到纯逻辑里**（修改 7 轮）：`./barState.ts`。
 *
 * 抽出去的理由只有一条：`vitest` 是 `environment: 'node'`，
 * `.tsx` 里的函数测不到，而"标了「未完成」的任务在日历上不标逾期红"
 * 是 `修改-7.md` §六 要求单测钉住的一条。
 */

/** 翻页：周 +7 天、月 +1 月、年 +1 年 */
export function shiftAnchor(mode: CalendarMode, anchorKey: string, step: number): string {
  if (mode === 'week') return addDaysToKey(anchorKey, 7 * step)
  if (mode === 'month') return addMonthsToKey(anchorKey, step)
  return addYearsToKey(anchorKey, step)
}

/** 导航条上的标题：这一周 / 这个月 / 这一年 */
export function calendarTitle(mode: CalendarMode, anchorKey: string, todayKey: string, weekStart: WeekStart): string {
  if (mode === 'week') {
    const keys = weekKeysFor(anchorKey, weekStart)
    const first = keys[0] ?? anchorKey
    const last = keys[keys.length - 1] ?? anchorKey
    const isCurrent = keys.includes(todayKey)
    const head = `${yearOfKey(first)}年${monthOfKey(first)}月${dayOfKey(first)}日 ~ ${
      yearOfKey(last) === yearOfKey(first) ? '' : `${yearOfKey(last)}年`
    }${monthOfKey(last)}月${dayOfKey(last)}日`
    return `${head}${isCurrent ? '（本周）' : ''}`
  }
  if (mode === 'month') {
    const label = formatMonthLabel(yearOfKey(anchorKey), monthOfKey(anchorKey))
    return isSameMonth(anchorKey, todayKey) ? `${label}（本月）` : label
  }
  const year = yearOfKey(anchorKey)
  return year === yearOfKey(todayKey) ? `${year}年（今年）` : `${year}年`
}

function isSameMonth(a: string, b: string): boolean {
  return yearOfKey(a) === yearOfKey(b) && monthOfKey(a) === monthOfKey(b)
}

export function CalendarPage(props: CalendarPageProps): React.JSX.Element {
  const {
    mode,
    tasks,
    todayKey,
    weekStart,
    anchorKey,
    onAnchorChange,
    onPickDay,
    onPickMonth,
    onCreateAt,
    onTaskContextMenu,
    onDragStartTask,
    onDragEndTask,
    onDropToDate,
    onEditTask,
    onToggleDone,
    onAdjustTime,
    onDeleteTask
  } = props

  /**
   * 任务条的"就地小面板"。
   *
   * 用 fixed 定位贴在点击位置（不依赖表格的滚动偏移），
   * 并且**一换视图就关掉** —— 否则翻页后它还挂在上一屏的坐标上。
   */
  const [panel, setPanel] = useState<{ task: PlanTask; x: number; y: number } | null>(null)
  const weekScrollRef = useRef<HTMLDivElement | null>(null)

  const closePanel = useCallback(() => setPanel(null), [])

  useEffect(() => {
    closePanel()
  }, [mode, anchorKey, closePanel])

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setPanel(null)
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [])

  /**
   * 打开周视图时自动滚到 08:00 附近。
   * 只在**进入周视图时**执行一次：翻周不该把用户刚滚到的位置弹回去。
   */
  useEffect(() => {
    if (mode !== 'week') return
    const element = weekScrollRef.current
    if (!element) return
    element.scrollTop = initialScrollTop()
  }, [mode])

  const openPanel = useCallback((task: PlanTask, event: React.MouseEvent) => {
    setPanel({ task, x: event.clientX, y: event.clientY })
  }, [])

  /**
   * 日历上只画"还在账上"的任务（修改 4 轮 §7.2）。
   *
   * 放弃的任务退出了逾期、顺延与所有统计，也不该再占着周 / 月 / 年的格子
   * （用户说的"这件我不做了"）。它们在「全部」视图的「已放弃」组里查得到、能恢复。
   * 年视图的分母另有 `yearGrid.monthTaskStats` 兜底（纯函数、有单测），
   * 两处口径一致：**放弃的彻底不参与日历**。
   */
  const visibleTasks = useMemo(() => tasks.filter((task) => task.abandoned !== true), [tasks])

  /**
   * 全天行里要额外收的"逾期未完成"（红色标出）。
   *
   * 修改 7 轮：判定换成 `countsAsOverdue` —— 手动标了「未完成」的任务
   * **不再被当成逾期**收进这一份（它仍然会由 `layoutWeek` 按自己的日期画在
   * 对应那一天的格子里，只是**蓝色**，见 `barState.ts`）。
   * 这里若继续用 `isOverdue`，日历上它还是红的，等于"只改了一半"。
   */
  const overdueUnfinished = useMemo(
    () =>
      visibleTasks.filter(
        (task) => !task.done && task.date !== UNSCHEDULED && countsAsOverdue(task, todayKey)
      ),
    [visibleTasks, todayKey]
  )

  const title = calendarTitle(mode, anchorKey, todayKey, weekStart)
  const labels = MODE_LABELS[mode]

  /** 任务条（周视图与全天行共用；testid 是 P4-E3 的契约，不许改） */
  const renderBar = (task: PlanTask, variant: 'slot' | 'allday' = 'slot'): React.JSX.Element => {
    const state = barStateOf(task, todayKey)
    return (
      <div
        key={task.id}
        className={`calendar-bar calendar-bar--${state}${
          variant === 'allday' ? ' calendar-bar--inline' : ''
        }`}
        data-testid="week-card"
        data-task-id={task.id}
        data-state={state}
        data-held={task.held === true ? 'true' : 'false'}
        data-start-time={task.startTime ?? ''}
        draggable
        title={`${task.title}（${timeLabel(task)}）`}
        onDragStart={() => onDragStartTask(task.id)}
        onDragEnd={onDragEndTask}
        onContextMenu={(event) => onTaskContextMenu(task, event)}
        onClick={(event) => {
          // 点任务条不该同时"在空白处新建"，所以拦住冒泡
          event.stopPropagation()
          openPanel(task, event)
        }}
      >
        <span className="calendar-bar__time" data-testid="calendar-bar-time">
          {timeLabel(task)}
        </span>
        <span className="calendar-bar__title">{task.title}</span>
      </div>
    )
  }

  // --------------------------------------------------------------- 周视图
  const weekKeys = useMemo(() => weekKeysFor(anchorKey, weekStart), [anchorKey, weekStart])
  const weekLayout = useMemo(() => layoutWeek(visibleTasks, weekKeys), [visibleTasks, weekKeys])
  /** 全天行里的逾期任务：同一份数据，红色标出，不重复堆进小时格 */
  const overdueByDate = useMemo(() => {
    const map = new Map<string, PlanTask[]>()
    for (const task of overdueUnfinished) {
      const list = map.get(task.date) ?? []
      list.push(task)
      map.set(task.date, list)
    }
    return map
  }, [overdueUnfinished])

  const renderWeek = (): React.JSX.Element => (
    <>
      <div className="week__header" data-testid="week-header">
        <span className="week__gutter-head">时间</span>
        {weekKeys.map((key) => (
          <span
            key={key}
            className={`week__head${key === todayKey ? ' week__head--today' : ''}`}
            data-date={key}
            data-today={key === todayKey ? 'true' : 'false'}
          >
            <span className="week__weekday">{weekdayLabel(fromDateKey(key))}</span>
            <span className="week__date">{`${monthOfKey(key)}/${dayOfKey(key)}`}</span>
          </span>
        ))}
      </div>

      <div className="week__scroll" data-testid="calendar-week-scroll" ref={weekScrollRef}>
        <div className="week" data-testid="week-grid">
          <div className="week__gutter">
            <div className="week__allday-label">全天</div>
            {weekHourLabels().map((label, index) => (
              <div
                key={label}
                className="week__hour-label"
                data-testid="week-hour-label"
                data-hour={WEEK_HOURS[index]}
                style={{ height: `${WEEK_HOUR_HEIGHT}px` }}
              >
                {label}
              </div>
            ))}
          </div>

          {weekKeys.map((key) => {
            const isTodayKey = key === todayKey
            /**
             * 全天行 = 没具体时间的任务 + 顺延来的逾期任务。
             * 两者可能重叠（同一条任务既没时间又逾期），按 id 去重，
             * 否则同一个 key 会在同一个父节点里渲染两次。
             */
            const allDayMap = new Map<string, PlanTask>()
            for (const task of weekLayout.cells.get(`${key}|allday`) ?? []) {
              allDayMap.set(task.id, task)
            }
            for (const task of overdueByDate.get(key) ?? []) {
              allDayMap.set(task.id, task)
            }
            const allDay = Array.from(allDayMap.values())
            return (
              <div
                key={key}
                className={`week__column${isTodayKey ? ' week__column--today' : ''}`}
                data-testid="week-column"
                data-date={key}
                data-today={isTodayKey ? 'true' : 'false'}
                onDragOver={(event) => {
                  event.preventDefault()
                  event.currentTarget.dataset['dropActive'] = 'true'
                }}
                onDragLeave={(event) => {
                  delete event.currentTarget.dataset['dropActive']
                }}
                onDrop={(event) => {
                  delete event.currentTarget.dataset['dropActive']
                  onDropToDate(key)
                }}
              >
                <div
                  className="week__allday"
                  data-testid="week-allday"
                  data-date={key}
                  onClick={() => onCreateAt(key, null)}
                >
                  {allDay.length === 0 ? (
                    <span className="week__allday-empty">—</span>
                  ) : (
                    allDay.map((task) => renderBar(task, 'allday'))
                  )}
                </div>

                {WEEK_HOURS.map((hour) => (
                  <div
                    key={hour}
                    className="week__slot"
                    data-testid="week-slot"
                    data-date={key}
                    data-hour={hour}
                    style={{ height: `${WEEK_HOUR_HEIGHT}px` }}
                    onClick={() => onCreateAt(key, hourLabel(hour))}
                  >
                    {(weekLayout.cells.get(`${key}|${hour}`) ?? []).map((task) => renderBar(task))}
                  </div>
                ))}
              </div>
            )
          })}
        </div>
      </div>
    </>
  )

  // --------------------------------------------------------------- 月视图
  const monthGrid = useMemo(() => monthGridFor(anchorKey, weekStart), [anchorKey, weekStart])
  const monthHeaders = useMemo(() => monthWeekdayHeaders(weekStart), [weekStart])
  const byDate = useMemo(() => {
    const map = new Map<string, PlanTask[]>()
    for (const task of visibleTasks) {
      if (task.date === UNSCHEDULED) continue
      const list = map.get(task.date) ?? []
      list.push(task)
      map.set(task.date, list)
    }
    for (const list of map.values()) {
      // 未完成的排在前面，同状态按标题（月份格子只看前 3 条，顺序必须稳定）
      list.sort((a, b) => {
        if (a.done !== b.done) return a.done ? 1 : -1
        return a.title.localeCompare(b.title, 'zh-Hans-CN')
      })
    }
    return map
  }, [visibleTasks])

  const renderMonth = (): React.JSX.Element => (
    <>
      <div className="month__header" data-testid="month-header">
        {monthHeaders.map((label) => (
          <span key={label} className="month__weekday">
            {label}
          </span>
        ))}
      </div>
      <div className="month__scroll" data-testid="calendar-month-scroll">
        <div className="month" data-testid="month-grid">
          {monthGrid.weeks.map((week, rowIndex) => (
            <div className="month__week" key={week[0]?.key ?? rowIndex} data-testid="month-week">
              {week.map((cell) => {
                const dayTasks = byDate.get(cell.key) ?? []
                const overflow = monthCellOverflow(dayTasks.length, MONTH_CELL_MAX_TASKS)
                const isTodayKey = cell.key === todayKey
                return (
                  <div
                    key={cell.key}
                    className={`month__cell${cell.inMonth ? '' : ' month__cell--outside'}${
                      isTodayKey ? ' month__cell--today' : ''
                    }`}
                    data-testid="month-cell"
                    data-date={cell.key}
                    data-in-month={cell.inMonth ? 'true' : 'false'}
                    data-today={isTodayKey ? 'true' : 'false'}
                    onClick={() => onCreateAt(cell.key, null)}
                  >
                    <button
                      type="button"
                      className="month__day"
                      data-testid="month-cell-day"
                      data-date={cell.key}
                      onClick={(event) => {
                        // 点日期号 = "点某天" → 切到那一天的"今天"列表
                        event.stopPropagation()
                        onPickDay(cell.key)
                      }}
                    >
                      {isTodayKey ? <span className="month__dot" data-testid="month-today-dot" /> : null}
                      {cell.day}
                    </button>
                    <span className="month__count" data-testid="month-cell-count">
                      {dayTasks.length} 项
                    </span>
                    <ul className="month__tasks">
                      {dayTasks.slice(0, overflow.shown).map((task) => (
                        <li
                          key={task.id}
                          className={`month__task${task.done ? ' month__task--done' : ''}`}
                          data-testid="month-task"
                          data-task-id={task.id}
                          data-held={task.held === true ? 'true' : 'false'}
                          title={task.title}
                          onContextMenu={(event) => onTaskContextMenu(task, event)}
                          onClick={(event) => {
                            event.stopPropagation()
                            openPanel(task, event)
                          }}
                        >
                          {task.title}
                        </li>
                      ))}
                    </ul>
                    {overflow.showMore ? (
                      <button
                        type="button"
                        className="month__more"
                        data-testid="month-more"
                        data-date={cell.key}
                        data-hidden={overflow.hidden}
                        onClick={(event) => {
                          event.stopPropagation()
                          onPickDay(cell.key)
                        }}
                      >
                        {`还有 ${overflow.hidden} 项…`}
                      </button>
                    ) : null}
                  </div>
                )
              })}
            </div>
          ))}
        </div>
      </div>
    </>
  )

  // --------------------------------------------------------------- 年视图
  const yearGrid = useMemo(() => yearGridFor(visibleTasks, anchorKey), [visibleTasks, anchorKey])
  const currentYear = yearOfKey(todayKey)
  const currentMonth = monthOfKey(todayKey)

  const renderYear = (): React.JSX.Element => (
    <div className="year__scroll" data-testid="calendar-year-scroll">
      <div className="year" data-testid="year-grid">
        {yearGrid.months.map((cell) => {
          const isCurrent = yearGrid.year === currentYear && cell.month === currentMonth
          return (
            <button
              type="button"
              key={cell.month}
              className={`year__month${isCurrent ? ' year__month--current' : ''}`}
              data-testid="year-month"
              data-month={cell.month}
              data-current={isCurrent ? 'true' : 'false'}
              data-count={cell.total}
              data-rate={cell.rate}
              onClick={() => onPickMonth(cell.startKey)}
            >
              <span className="year__month-head">
                <span className="year__month-name">{`${cell.month}月`}</span>
                {/* 两个数：任务数与完成率（脱钩是刻意的，见 §5.5） */}
                <span className="year__month-count" data-testid="year-month-count">
                  {`${cell.total} 项`}
                </span>
                <span className="year__month-rate" data-testid="year-month-rate">
                  {`完成率 ${cell.rate}%`}
                </span>
              </span>
              <span className="year__bar">
                <span
                  className="year__bar-fill"
                  data-testid="year-month-bar"
                  style={{ width: `${cell.rate}%` }}
                />
              </span>
            </button>
          )
        })}
      </div>
    </div>
  )

  return (
    <div className={`calendar calendar--${mode}`} data-testid="calendar" data-mode={mode}>
      <div className="calendar__nav" data-testid="calendar-nav">
        <span className="calendar__title" data-testid="calendar-title">
          {title}
        </span>
        <span className="toolbar__spacer" />
        <button
          type="button"
          className="button"
          data-testid="calendar-prev"
          onClick={() => onAnchorChange(shiftAnchor(mode, anchorKey, -1))}
        >
          {labels.prev}
        </button>
        <button
          type="button"
          className="button"
          data-testid="calendar-next"
          onClick={() => onAnchorChange(shiftAnchor(mode, anchorKey, 1))}
        >
          {labels.next}
        </button>
        <button
          type="button"
          className="button"
          data-testid="calendar-today"
          onClick={() => onAnchorChange(todayKey)}
        >
          {labels.back}
        </button>
        {/* 日期选择器跳转（§5.1） */}
        <input
          type="date"
          className="calendar__jump"
          aria-label="跳到某一天"
          data-testid="calendar-jump"
          value={anchorKey}
          onChange={(event) => {
            const value = event.target.value
            if (value !== '') onAnchorChange(value)
          }}
        />
      </div>

      <div className="calendar__legend" data-testid="calendar-legend">
        <span className="calendar__legend-item calendar__legend-item--todo">待办</span>
        <span className="calendar__legend-item calendar__legend-item--done">已完成</span>
        <span className="calendar__legend-item calendar__legend-item--overdue">逾期</span>
      </div>

      <div className="calendar__body" data-testid="calendar-body">
        {mode === 'week' ? renderWeek() : mode === 'month' ? renderMonth() : renderYear()}
      </div>

      {panel !== null ? (
        <div
          className="calendar__panel"
          data-testid="calendar-task-panel"
          data-task-id={panel.task.id}
          style={{ left: `${panel.x}px`, top: `${panel.y}px` }}
          onClick={(event) => event.stopPropagation()}
        >
          <p className="calendar__panel-title">{panel.task.title}</p>
          <button
            type="button"
            className="button"
            data-testid="calendar-panel-edit"
            onClick={() => {
              closePanel()
              onEditTask(panel.task)
            }}
          >
            编辑
          </button>
          <button
            type="button"
            className="button"
            data-testid="calendar-panel-done"
            onClick={() => {
              closePanel()
              onToggleDone(panel.task)
            }}
          >
            {panel.task.done ? '标记未完成' : '标记完成'}
          </button>
          <button
            type="button"
            className="button"
            data-testid="calendar-panel-time"
            onClick={() => {
              closePanel()
              onAdjustTime(panel.task)
            }}
          >
            改时间
          </button>
          <button
            type="button"
            className="button button--danger"
            data-testid="calendar-panel-delete"
            onClick={() => {
              closePanel()
              onDeleteTask(panel.task)
            }}
          >
            删除
          </button>
          <button
            type="button"
            className="button"
            data-testid="calendar-panel-close"
            onClick={closePanel}
          >
            关闭
          </button>
        </div>
      ) : null}
    </div>
  )
}
