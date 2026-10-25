/**
 * 计划页（DEVPLAN 阶段 4 / PRD §5.2；第 05 块补上周 / 月 / 年三档日历视图）
 *
 * 五个视图：今天（默认）/ 本周 / 月 / 年 / 全部。
 * 其中 **本周 / 月 / 年 是同一个日历的三档粒度**（`modules/calendar/`），
 * `今天` 与 `全部` 仍是原来的列表 —— 日历是**视图**，不是新页面、不是新模块入口。
 * 页头统计、行内快速新建、勾选完成沉底、按行操作、拖拽改期、逾期标红都保留。
 *
 * ## 修改 5 轮：**不再自动顺延**
 *
 * 用户原话：「未完成的任务会不会主动移到今天？这个我要改成手动。」
 *          「我要把某一天未完成的移动到指定的某一天。」
 *
 * 所以这里**没有**"启动时自动顺延"的 effect 了，改成两条手动入口：
 *   1. 页头「移动某天未完成的…」→ 选源日期 + 看数量 + 选目标日期（批量）
 *   2. 行菜单「移动到指定日期…」→ 单条移动（对钉住的任务也生效）
 *
 * 手动标记「未完成」（`held`）的任务**不会被批量移动**——
 * 这是"别自动搬我"，不是"当我不做这件事"（`修改-5.md` §四）。
 *
 * ## 修改 6 轮：逾期提示挪进工具栏 + 可关闭
 *
 * 用户原话：「今日计划不要显示昨天的计划（未移动），这个提醒放在上面按个框框里，
 *          然后可以关闭。」
 *
 * 计划页这边：原来独占一行的黄色横条（`plan-overdue-hint`）**删掉了**，
 * 换成工具栏那排里的内联小控件（`plan-overdue-inline`，「N 项逾期」+ `×`）。
 * 关掉 = **当天不再出现**（偏好 `overdueHintDismissedOn` 存"哪一天关的"），
 * 第二天自动回来；页头「逾期 N 项」是常驻统计，**关提示不动它**。
 *
 * ## 修改 7 轮：标了「未完成」的**不算逾期**（反转 `修改-5` 那个决定）
 *
 * 用户原话：「标记未完成不显示逾期。」
 *
 * 落地是两条（**方向相反，别合并**）：
 *   1. **统计与提醒不再数它**：页头「逾期 N 项」、工具栏那条「N 项逾期」、
 *      导航红点、首页关注卡、日历逾期色 —— 全部改用 `countsAsOverdue`
 *   2. **但它仍然看得见**：从「逾期」组里拆出来，在「全部」视图单独一组
 *      「**已标未完成（N）**」收着（`groups.held`，`group-held`）——
 *      这一组是唯一能看见它的地方；「今天 / 本周」与首页都**不显示**它
 *
 * ⚠️ `isOverdue` **一个字都没改**（它仍是显示口径，`held` 也算）：
 * 改了它，被标记的任务会从「今天」视图里彻底消失（`修改-7.md` §四）。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { addDaysToKey, dateKey, relativeDayLabel, weekKeysFor } from '../../../shared/date'
import {
  RECURRENCE_LABELS,
  TIME_SLOT_LABELS,
  UNSCHEDULED,
  PLAN_TASK_STATE_LABELS,
  isAbandoned,
  isHeld,
  normalizeTimeRange,
  planTaskStateOf,
  timeRangeError,
  type PlanTask,
  type RecurrenceType,
  type TimeSlot
} from '../../../shared/plan'
import { normalizeRichText } from '../../../shared/richText'
import {
  carryoverLabel,
  countForHeader,
  dateMoveConfirmLabel,
  dateMovePreviewText,
  dateMovedNotice,
  groupForToday,
  partitionAbandoned,
  planDateMove,
  reschedulePatch,
  shouldShowOverdueHint,
  taskDateMovePatch
} from '../../../shared/planLogic'
import { taskReviewPatch, reviewTimeLabel, isDueForReview } from '../../../shared/plan'
import { PageShell } from '../../shell/PageShell'
import { EmptyState } from '../../shell/EmptyState'
import { Drawer, FormDrawer, InlineInput, type FormFormats, type FormValues } from '../../shell/Editors'
import { RichTextView } from '../../shell/RichTextView'
import { MenuButton, ContextMenu, useContextMenu } from '../../shell/ContextMenu'
import { taskMenuItems, toSpecs } from '../../../shared/contextMenu'
import type { MenuItemSpec } from '../../../shared/menuItems'
import { CalendarPage } from '../calendar/CalendarPage'
import { useSignal } from '../../lib/useSignal'
import { loadPreferences, saveOverdueHintDismissedOn } from '../../lib/prefsClient'
import { usePlanTasks } from './usePlanTasks'

type ViewMode = 'today' | 'week' | 'month' | 'year' | 'all'

const VIEW_LABELS: Record<ViewMode, string> = {
  today: '今天',
  week: '本周',
  month: '月',
  year: '年',
  all: '全部'
}

/** 哪几个视图是日历（要让出高度给内部滚动） */
const CALENDAR_VIEWS: ViewMode[] = ['week', 'month', 'year']

function isCalendarView(mode: ViewMode): boolean {
  return CALENDAR_VIEWS.includes(mode)
}

/**
 * 新建 / 编辑任务的表单字段。
 *
 * 日期用原生 date 输入，可选过去、今天、未来任意一天，也能选"待安排"。
 * 这是 BUG-001 的修复点：以前行内新建写死今天，用户只能建在今天就靠拖拽挪。
 */
function taskFormFields(): Parameters<typeof FormDrawer>[0]['fields'] {
  return [
    {
      kind: 'text',
      key: 'title',
      label: '任务',
      placeholder: '要做什么…',
      required: true,
      testId: 'task-form-title'
    },
    {
      kind: 'date',
      key: 'date',
      label: '日期',
      testId: 'task-form-date',
      hint: '可任意选择过去、今天或未来的一天'
    },
    {
      kind: 'select',
      key: 'unscheduled',
      label: '或',
      testId: 'task-form-unscheduled',
      options: [
        { value: 'no', label: '按上面的日期安排' },
        { value: 'yes', label: '待安排（先不排期）' }
      ]
    },
    {
      kind: 'select',
      key: 'timeSlot',
      label: '时段',
      testId: 'task-form-slot',
      options: (Object.keys(TIME_SLOT_LABELS) as TimeSlot[]).map((slot) => ({
        value: slot,
        label: TIME_SLOT_LABELS[slot]
      }))
    },
    {
      kind: 'time',
      key: 'startTime',
      label: '开始时间',
      testId: 'task-form-start',
      hint: '可选；填了就会落在日历的具体小时格上'
    },
    {
      kind: 'time',
      key: 'endTime',
      label: '结束时间',
      testId: 'task-form-end',
      hint: '可选；必须晚于开始时间'
    },
    {
      kind: 'select',
      key: 'recurrence',
      label: '重复',
      testId: 'task-form-recurrence',
      options: (Object.keys(RECURRENCE_LABELS) as RecurrenceType[]).map((rule) => ({
        value: rule,
        label: RECURRENCE_LABELS[rule]
      }))
    },
    {
      // 备注改成富文本（第 04 块）：值仍是字符串，内容是净化后的 HTML
      kind: 'rich',
      key: 'note',
      label: '备注',
      placeholder: '可留空（可以用工具条加粗、分点）',
      minHeight: 100,
      testId: 'task-form-note'
    }
  ]
}

export interface PlanPageProps {
  /** 测试注入用：当前时间 */
  now?: Date
  /** 每周从周几开始 */
  weekStart?: 1 | 7
  /** 热键 `N`（当前模块新建一条）：数字变一次 = 打开一次"新建任务"表单 */
  newSignal?: number
  /** 热键 `T`（回到今天）：数字变一次 = 视图切回"今天"并选中今天 */
  todaySignal?: number
}

export function PlanPage({
  now,
  weekStart = 1,
  newSignal,
  todaySignal
}: PlanPageProps): React.JSX.Element {
  const today = useMemo(() => now ?? new Date(), [now])
  const todayKeyValue = dateKey(today)
  const weekKeys = useMemo(() => weekKeysFor(todayKeyValue, weekStart), [todayKeyValue, weekStart])

  const { tasks, error, addTask, patchTask, toggleDone, toggleAbandon, removeTask } =
    usePlanTasks()
  const [view, setView] = useState<ViewMode>('today')
  /**
   * 日历的锚点日期：翻周 / 翻月 / 翻年**只改它**，网格每次按它重算。
   * 这样"1 月 31 日 → 下一月"这种月末收敛只由 `addMonthsToKey` 负责，页面不管。
   */
  const [anchorKey, setAnchorKey] = useState(todayKeyValue)
  /**
   * "今天"视图显示哪一天：默认今天，月视图点某天后切到这里（§5.4）。
   * 点顶部「今天」按钮会把它复位成今天。
   */
  const [activeDayKey, setActiveDayKey] = useState(todayKeyValue)
  /**
   * 移动完成后的那一条提示（`data-testid="carryover-notice"`）。
   *
   * 修改 5 轮之前它写的是"已把 N 项**昨天**没做完的任务挪到今天"——
   * 而那会儿实际搬的是**所有过去日期**的，文案与事实不符。
   * 现在它只在**手动移动之后**出现，并且带源日期与目标日期。
   */
  const [carryoverNotice, setCarryoverNotice] = useState<string | null>(null)
  /**
   * 「移动某天未完成的…」面板（修改 5 轮 §6.3）。
   *
   * 源 / 目标默认都是今天：一打开就看得见"今天有几项可以搬"，
   * 但因为源 == 目标，确认按钮是禁用的（并说明"源和目标不能是同一天"）。
   */
  const [moveOpen, setMoveOpen] = useState(false)
  const [moveSource, setMoveSource] = useState(todayKeyValue)
  const [moveTarget, setMoveTarget] = useState(todayKeyValue)
  /** 正在「移动到指定日期…」的那一条（逐条移动，对钉住的任务也生效） */
  const [dateMoveTask, setDateMoveTask] = useState<PlanTask | null>(null)
  /**
   * 行操作菜单（`⋯` 与右键**共用一份定义**，见 §5.1）。
   *
   * 第 03 块之前这里是各页自己写的一份下拉；现在统一交给
   * `shell/ContextMenu.tsx`，菜单项内容出自 `shared/contextMenu.ts`，
   * 因此 `⋯` 与右键不可能出现两套不同的项。
   */
  const menu = useContextMenu()
  /**
   * 任务表单（新建与编辑共用一份）。
   * editingId 为 null 表示新建；否则是正在编辑的任务 id。
   */
  const [formOpen, setFormOpen] = useState(false)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [formInitial, setFormInitial] = useState<FormValues>({})
  /** 富文本字段（备注）的格式标记；旧任务没有这个字段即 plain（零改写） */
  const [formFormats, setFormFormats] = useState<FormFormats>({})
  /** 「调整时间」专用表单：正在调的那条任务 */
  const [timeTask, setTimeTask] = useState<PlanTask | null>(null)
  /**
   * 正在拖拽的任务 id 必须放在 ref 里。
   * dragstart 与 drop 可能发生在同一次渲染内（真实浏览器里也不会等 React 重渲染），
   * 用 state 会因为闭包捕获旧值而读到 null，导致拖拽看起来生效、实际没改期。
   */
  const dragIdRef = useRef<string | null>(null)
  /**
   * 逾期提醒（工具栏里那条「N 项逾期」）**被关掉的那一天**（修改 6 轮）。
   *
   * 用户原话：「这个提醒放在上面按个框框里，然后可以关闭。」
   * 口径是"**当天不再出现**"：存的是"哪一天关的"，而不是布尔——
   * 第二天日期一变，`shouldShowOverdueHint` 的 `!== 今天` 自然不成立，提示就回来了。
   *
   * 进页面时从偏好读一次（跟着数据走：重开程序、换电脑、恢复备份都还在）；
   * 读不到就当"没关过"，提示照常显示。
   */
  const [overdueHintDismissedOn, setOverdueHintDismissedOn] = useState<string | undefined>(undefined)
  /**
   * 偏好读回来了没有。
   *
   * 不等到它再渲染提示的理由：关掉过的那一天如果先按"没关过"渲染，
   * 用户每次进计划页都会看到提示闪一下再消失——那就不叫"当天不再出现"了。
   * 读盘是毫秒级的，等它不影响手感；读失败也照样把 ready 置上（按"没关过"处理）。
   */
  const [overdueHintPrefsReady, setOverdueHintPrefsReady] = useState(false)
  useEffect(() => {
    let alive = true
    void loadPreferences()
      .then((prefs) => {
        if (alive) setOverdueHintDismissedOn(prefs.overdueHintDismissedOn)
      })
      .catch(() => {
        /* 读不到偏好就当没关过：提示照常显示，不影响任务本身 */
      })
      .finally(() => {
        if (alive) setOverdueHintPrefsReady(true)
      })
    return () => {
      alive = false
    }
  }, [])

  /**
   * 修改 5 轮：**这里原来有一个"启动时自动顺延一次"的 effect，已经删掉**。
   *
   * 用户原话：「未完成的任务会不会主动移到今天？这个我要改成手动。」
   * 旧行为还比文案更激进：它把**所有过去日期**的未完成任务一次全搬到今天
   * （`computeCarryover` 只跳过"今天与未来"，不设天数上限），
   * 而提示却写"已把 N 项昨天没做完的任务挪到今天"。
   *
   * `computeCarryover` / `runCarryover` 函数**保留不动**（它们本来就是"可手动调用"的，
   * 既有单测还在用）；这一轮只是**不再自动调**，批量移动改走下面那条
   * "源日期 → 目标日期"的新入口。
   */

  const groups = useMemo(() => groupForToday(tasks, activeDayKey), [tasks, activeDayKey])
  /**
   * 「全部」视图分两拨（修改 4 轮 §7.2 第 5 条）：还在账上的 + 已放弃的。
   * 放弃的任务从今天 / 本周退出，但**必须**能在「全部」里查到并恢复。
   */
  const allTasks = useMemo(() => partitionAbandoned(tasks), [tasks])
  /**
   * 「全部」视图里"还在账上"的那些行要**减掉标了「未完成」的**（修改 7 轮）：
   * 它们在下面单独一组「已标未完成（N）」里出现，同一屏出现两次等于让人以为
   * 任务翻倍了。`held` 那一组是**唯一能看见它们的地方**，不能连这里也不显示。
   */
  const activeRows = useMemo(
    () => allTasks.active.filter((task) => !isHeld(task)),
    [allTasks]
  )
  /** 全部 / 已标未完成 / 已放弃 三组共用的排序：按日期，同日按标题 */
  const byDateThenTitle = useCallback(
    (a: PlanTask, b: PlanTask): number => {
      if (a.date !== b.date) return a.date < b.date ? -1 : 1
      return a.title.localeCompare(b.title, 'zh-Hans-CN')
    },
    []
  )
  const counts = useMemo(
    () => countForHeader(tasks, todayKeyValue, weekKeys),
    [tasks, todayKeyValue, weekKeys]
  )

  /**
   * 工具栏里那条逾期提示该不该显示（修改 6 轮）。
   *
   * 判据在 `planLogic.shouldShowOverdueHint`（纯逻辑，单测覆盖）：
   * **逾期 > 0 且 关掉的那一天 !== 今天**。
   *
   * ⚠️ 关掉的只是这条提示：页头「逾期 N 项」是常驻统计、不读这个状态，
   * 关掉之后它仍然写着真实数字（这一点很重要，别顺手把它也藏了）。
   */
  const showOverdueHint =
    overdueHintPrefsReady &&
    shouldShowOverdueHint(counts.overdue, overdueHintDismissedOn, todayKeyValue)

  /**
   * 点 `×` 关掉提示：**先改界面再落盘**（和侧栏收起同一个套路）——
   * 点一下要立刻消失，不能等磁盘；写盘失败也保留本次会话的关闭状态。
   */
  const dismissOverdueHint = useCallback((): void => {
    setOverdueHintDismissedOn(todayKeyValue)
    void saveOverdueHintDismissedOn(todayKeyValue).catch(() => {
      /* 偏好写不进去不影响本次使用 */
    })
  }, [todayKeyValue])

  /**
   * 「移动某天未完成的…」的**实时预览**（修改 5 轮 §6.3）。
   *
   * 数量、能不能按、为什么不能按，全部来自 `planLogic.planDateMove` ——
   * 落在库里的那一步也读它，所以"预览说 5 项、实际搬了 3 项"不可能发生。
   */
  const movePreview = useMemo(
    () => planDateMove(tasks, moveSource, moveTarget),
    [tasks, moveSource, moveTarget]
  )

  /**
   * 打开批量移动面板。
   *
   * 每次打开都复位成「源 = 目标 = 今天」：一打开先看得见"今天有几项"，
   * 同时因为同一天而**禁用**确认按钮（这正是 `修改-5.md` §6.3 要的边界行为）。
   */
  const openMovePanel = useCallback(
    (source?: string) => {
      setMoveSource(source !== undefined && source !== '' ? source : todayKeyValue)
      setMoveTarget(todayKeyValue)
      setMoveOpen(true)
    },
    [todayKeyValue]
  )

  /**
   * 真的搬：**逐条** `patchTask(id, { date: 目标, carriedOver: n + 1 })`。
   *
   * 不走任何新 IPC、不做批量删改接口（`修改-5.md` §6.3 的明确要求）：
   * 用的就是既有那条更新路径（`usePlanTasks.patchTask`，自带 flush → reload → 广播）。
   */
  const onConfirmMove = useCallback(async () => {
    const preview = movePreview
    if (!preview.canMove) return
    for (const task of preview.movable) {
      await patchTask(task.id, taskDateMovePatch(task, preview.target))
    }
    // 提示带**源日期与目标日期**（旧文案"昨天没做完的"与实际不符，已改准）
    setCarryoverNotice(dateMovedNotice(preview.source, preview.target, preview.movable.length))
    setMoveOpen(false)
  }, [movePreview, patchTask])

  const onQuickAdd = useCallback(
    async (value: string) => {
      await addTask({ title: value, date: todayKeyValue, timeSlot: 'none' })
    },
    [addTask, todayKeyValue]
  )

  /**
   * 打开"新建任务"表单。
   *
   * 不带参数 = 页头「＋ 新建任务」，日期默认今天；
   * 带 `{ date, startTime }` = 日历里点了某一格（§5.3 / §5.4 的"点空白格子新建"），
   * 日期与开始时间都预填好，省得用户再填一遍。
   */
  const openCreateForm = useCallback(
    (preset?: { date?: string; startTime?: string | null }) => {
      setEditingId(null)
      setFormInitial({
        title: '',
        date: preset?.date ?? activeDayKey,
        unscheduled: 'no',
        timeSlot: 'none',
        startTime: preset?.startTime ?? '',
        endTime: '',
        recurrence: 'none',
        note: ''
      })
      setFormFormats({})
      setFormOpen(true)
    },
    [activeDayKey]
  )

  /** 打开编辑表单，带上任务现有值（BUG-002：已建任务要能改） */
  const openEditForm = useCallback((task: PlanTask) => {
    setEditingId(task.id)
    setFormInitial({
      title: task.title,
      date: task.date === UNSCHEDULED ? '' : task.date,
      unscheduled: task.date === UNSCHEDULED ? 'yes' : 'no',
      timeSlot: task.timeSlot,
      startTime: task.startTime ?? '',
      endTime: task.endTime ?? '',
      recurrence: task.recurrence,
      note: task.note ?? ''
    })
    setFormFormats(task.noteFormat === 'rich' ? { note: 'rich' } : {})
    setFormOpen(true)
  }, [])

  /** 提交表单：新建走 addTask，编辑走 patchTask */
  const onSubmitForm = useCallback(
    async (values: FormValues, formats: FormFormats) => {
      /**
       * 时间区间先校验再落库（§5.7 / P8-C8）：
       * `endTime` 早于或等于 `startTime` 时**明确拒绝**，并把原因显示在表单里。
       * 以前这里是 `normalizeTimeRange` 直接丢掉非法值 —— 用户看不出发生了什么，
       * 保存"成功"了但结束时间凭空消失，正是要比掉的毛病。
       */
      const rangeError = timeRangeError(values['startTime'], values['endTime'])
      if (rangeError !== null) throw new Error(rangeError)

      const unscheduled = values['unscheduled'] === 'yes'
      const rawDate = (values['date'] ?? '').trim()
      const date = unscheduled || rawDate === '' ? UNSCHEDULED : rawDate
      // 备注是富文本：落库前用 normalizeRichText 再收一次口（编辑器已净化过）
      const note = normalizeRichText(values['note'], formats['note'])
      const timeSlot = (values['timeSlot'] ?? 'none') as TimeSlot
      const recurrence = (values['recurrence'] ?? 'none') as RecurrenceType
      // 时间区间统一走 shared/plan.ts 的规范化（非法的一律丢掉，不写进数据）
      const range = normalizeTimeRange(values['startTime'], values['endTime'])
      // 格式标记只在富文本时写；不写即 plain，与旧任务口径一致
      const noteFields = {
        note: note.text,
        ...(note.contentFormat ? { noteFormat: note.contentFormat } : {})
      }

      if (editingId === null) {
        await addTask({
          title: (values['title'] ?? '').trim(),
          date,
          timeSlot,
          recurrence,
          ...range,
          note: noteFields.note,
          ...(note.contentFormat ? { noteFormat: note.contentFormat } : {})
        })
        return
      }
      await patchTask(editingId, {
        title: (values['title'] ?? '').trim(),
        date,
        timeSlot,
        recurrence,
        ...noteFields,
        // 先清空再写回：用户把时间删掉时旧值必须真的消失。
        // 传 null（不是 undefined）——写盘走 JSON，undefined 会被整条丢掉，
        // 那就成了"没提这件事"，旧值会留在数据里（已踩过）。
        startTime: null,
        endTime: null,
        ...range
      } as unknown as Partial<PlanTask>)
    },
    [addTask, editingId, patchTask]
  )

  const onDropToDate = useCallback(
    async (dateKey: string) => {
      const dragged = dragIdRef.current
      if (!dragged) return
      dragIdRef.current = null
      const patch = reschedulePatch(dateKey, new Date().toISOString())
      await patchTask(dragged, { date: patch.date })
    },
    [patchTask]
  )

  const tomorrowKey = addDaysToKey(todayKeyValue, 1)

  /**
   * `T` = 回到今天（决定 29）：**视图切回"今天"，并且日历锚点也复位到今天**。
   *
   * 为什么锚点也要复位：05 块的交接记录里写着"锚点在三档之间共享"——
   * 用户翻到 2027 年再切回"今天"，日历那三档其实还停在 2027。
   * `T` 的语义是"我看的是今天"，所以两个状态一起复位，不留半截。
   */
  const goToday = useCallback(() => {
    setActiveDayKey(todayKeyValue)
    setAnchorKey(todayKeyValue)
    setView('today')
  }, [todayKeyValue])

  // 热键分发（App 已按"当前页面支持什么"过滤过，这里只管打开自己的入口）
  useSignal(newSignal, () => openCreateForm())
  useSignal(todaySignal, goToday)

  /** 复制一条任务：标题加"（副本）"，其余字段照抄，新任务默认未完成 */
  const duplicateTask = useCallback(
    async (task: PlanTask) => {
      await addTask({
        title: `${task.title}（副本）`,
        date: task.date,
        timeSlot: task.timeSlot,
        recurrence: task.recurrence,
        ...(task.note ? { note: task.note } : {}),
        // 备注是富文本时，格式标记要跟着走，否则副本会把 HTML 当纯文本显示
        ...(task.noteFormat ? { noteFormat: task.noteFormat } : {})
      })
    },
    [addTask]
  )

  /**
   * 拼出这一行的菜单项。
   *
   * **唯一的定义来源**是 `shared/contextMenu.ts` 的 `taskMenuItems`——
   * `⋯` 按钮与右键都调这一个函数，因此两处取到的项必然相同（有单测盯住）。
   */
  const taskItems = useCallback(
    (task: PlanTask): MenuItemSpec[] =>
      toSpecs(
        taskMenuItems({
          done: task.done,
          abandoned: isAbandoned(task),
          held: isHeld(task),
          recurrence: task.recurrence,
          timeSlot: task.timeSlot,
          reviewScheduled: task.reviewAt !== undefined && task.reviewAt !== '',
          today: todayKeyValue,
          tomorrow: tomorrowKey,
          onEdit: () => openEditForm(task),
          onDelete: () => void removeTask(task.id),
          onDuplicate: () => void duplicateTask(task),
          onToggleDone: () => void toggleDone(task.id),
          onToggleAbandon: () => void toggleAbandon(task.id),
          onAdjustTime: () => setTimeTask(task),
          onChangeSlot: (slot) => void patchTask(task.id, { timeSlot: slot }),
          onChangeRecurrence: (rule) => void patchTask(task.id, { recurrence: rule }),
          // 复习时间的落库规则在 shared/plan.ts（taskReviewPatch），页面不重写一份
          onSetReviewInDays: (days) =>
            void patchTask(task.id, taskReviewPatch(todayKeyValue, days)),
          onClearReview: () => void patchTask(task.id, taskReviewPatch(todayKeyValue, null)),
          onMoveTo: (day) => void patchTask(task.id, { date: day }),
          // 「未完成」标记：同一个开关按当前状态取反（与放弃那一项同一套写法）
          onToggleHold: () => void patchTask(task.id, { held: !isHeld(task) }),
          // 逐条移动到任意一天：**不受 held 限制**（用户单独点它就是要动）
          onMoveToDate: () => setDateMoveTask(task)
        })
      ),
    [
      duplicateTask,
      openEditForm,
      patchTask,
      removeTask,
      todayKeyValue,
      tomorrowKey,
      toggleAbandon,
      toggleDone
    ]
  )

  const renderTaskRow = (
    task: PlanTask,
    options: { overdue?: boolean; showDate?: boolean } = {}
  ): React.JSX.Element => {
    const carry = carryoverLabel(task)
    const review = reviewTimeLabel(task, todayKeyValue)
    /**
     * 三态（修改 4 轮）：`data-state` 供验收读，`task--abandoned` 负责灰显。
     * 已放弃的行还要在行上写一个「已放弃」标签——只灰不标的话，
     * 用户容易把"放弃了"和"做完了"看混（两者都不在待办里）。
     */
    const state = planTaskStateOf(task)
    const abandoned = state === 'abandoned'
    /**
     * 「未完成」标记（修改 5 轮）。
     *
     * 用户原话："标记后就显示未完成就行" —— 所以标签文字就是**「未完成」**
     * （复用 `PLAN_TASK_STATE_LABELS.pending`，不发明"已钉住"这种词），
     * 视觉上是**灰色描边**的小徽标：与「已放弃」的虚线框、以及状态色（红/绿）
     * 都能区分开。
     */
    const held = isHeld(task) && state === 'pending'
    return (
      <li
        key={task.id}
        className={`task${options.overdue ? ' task--overdue' : ''}${task.done ? ' task--done' : ''}${
          abandoned ? ' task--abandoned' : ''
        }`}
        data-testid="task-row"
        data-task-id={task.id}
        data-done={task.done ? 'true' : 'false'}
        data-state={state}
        data-held={held ? 'true' : 'false'}
        draggable
        onContextMenu={(event) => menu.openFromEvent(event, taskItems(task), `task-row:${task.id}`)}
        onDragStart={() => { dragIdRef.current = task.id }}
        onDragEnd={() => { dragIdRef.current = null }}
      >
        <button
          type="button"
          className="task__check"
          aria-label={task.done ? '标记为未完成' : '标记为已完成'}
          data-testid="task-toggle"
          onClick={() => void toggleDone(task.id)}
        >
          {task.done ? '✓' : '○'}
        </button>

        {/* 「全部」视图里多一列日期（其它视图按分组已经知道是哪一天了） */}
        {options.showDate === true ? (
          <span className="task__date" data-testid="task-date">
            {task.date === UNSCHEDULED ? '待安排' : task.date}
          </span>
        ) : null}

        {/*
          标题与备注放在同一个竖排容器里：任务行本身是横向 flex，
          备注另起一行才不会被标题挤成一团（第 04 块）。
        */}
        <span className="task__main">
          <span className="task__title">{task.title}</span>
          {/* 按 contentFormat 渲染：旧任务（无此字段）走纯文本，显示不变 */}
          <RichTextView
            value={task.note ?? ''}
            format={task.noteFormat}
            className="task__note"
            testId="task-note"
          />
        </span>

        {abandoned ? (
          <span className="task__meta task__meta--abandoned" data-testid="task-abandoned-label">
            {PLAN_TASK_STATE_LABELS.abandoned}
          </span>
        ) : null}
        {/* 手动标了「未完成」的行：灰色描边小徽标（与已放弃的虚线框能区分开） */}
        {held ? (
          <span
            className="task__meta task__meta--held"
            data-testid="plan-task-held"
            title="已手动标记未完成：批量移动会跳过它，也不算逾期（「今天 / 本周」的数字与完成率仍算它）"
          >
            {PLAN_TASK_STATE_LABELS.pending}
          </span>
        ) : null}
        {task.timeSlot !== 'none' ? (
          <span className="task__meta">{TIME_SLOT_LABELS[task.timeSlot]}</span>
        ) : null}
        {task.recurrence !== 'none' ? (
          <span className="task__meta task__meta--repeat" title={RECURRENCE_LABELS[task.recurrence]}>
            🔁{RECURRENCE_LABELS[task.recurrence]}
          </span>
        ) : null}
        {options.overdue ? <span className="task__meta task__meta--warn">逾期</span> : null}
        {carry ? <span className="task__meta task__meta--carry">⚠ {carry}</span> : null}
        {/* 设置了复习时间的任务在行上看得见（没设就什么都不显示，旧任务零影响） */}
        {review ? (
          <span
            className={`task__meta${isDueForReview(task, todayKeyValue) ? ' task__meta--warn' : ' task__meta--review'}`}
            data-testid="task-review-at"
            data-review-at={task.reviewAt ?? ''}
          >
            {review}
          </span>
        ) : null}

        {/* `⋯` 与右键取到的是同一批菜单项（同一个 taskItems） */}
        <MenuButton menu={menu} items={() => taskItems(task)} testId="task-menu" />
      </li>
    )
  }

  return (
    <PageShell
      title="计划"
      /*
        关掉自动顺延之后，「逾期 N 项」是唯一常驻的提醒手段（`修改-5.md` §五），
        所以逾期 > 0 时把这一段标出来（样式 `.page__description-strong`）。
        整句的 textContent 一个字都没变，验收照旧按整句读。
      */
      description={
        <>
          <span className={counts.overdue > 0 ? 'page__description-strong' : undefined}>
            逾期 {counts.overdue} 项
          </span>
          {` · 今天 ${counts.today} 项 · 本周 ${counts.week} 项`}
        </>
      }
      // 日历三档要"吃满剩余高度、内部滚动"（§5.9），列表视图照旧随页面长
      fill={isCalendarView(view)}
      primaryAction={{
        label: '新建任务',
        testId: 'plan-new-task',
        // BUG-003：以前这个按钮只是把光标聚焦到行内输入框，
        // 输入框本来就在屏幕顶部且已聚焦时，用户完全看不出反应。
        // 现在改为打开一个看得见的表单，日期也能选了（BUG-001）。
        onClick: () => openCreateForm()
      }}
      toolbar={
        <>
          {/*
            视图按钮从三个变五个：今天 / 本周 / 月 / 年 / 全部（§5.1）。
            **不新增页面、不新增导航入口** —— 日历只是这一排里的两个新按钮。
          */}
          {(Object.keys(VIEW_LABELS) as ViewMode[]).map((mode) => (
            <button
              key={mode}
              type="button"
              className={`chip${view === mode ? ' chip--active' : ''}`}
              data-testid={`plan-view-${mode}`}
              aria-pressed={view === mode}
              onClick={() => {
                if (mode === 'today') setActiveDayKey(todayKeyValue)
                setView(mode)
              }}
            >
              {VIEW_LABELS[mode]}
            </button>
          ))}
          <span className="toolbar__spacer" />
          {/*
            逾期提示（修改 6 轮）：从"独占一行的黄色横条"改成**这一排里的内联小控件**。
            用户原话：「这个提醒放在上面按个框框里，然后可以关闭。」

            - 文案必须短（「N 项逾期」），否则会把这一排挤坏
            - 主体可点 → 打开「移动某天未完成的…」面板（与原来的入口同一个行为）
            - `×` → 当天不再显示（存 `overdueHintDismissedOn`，第二天自动回来）
            - 仍然留一个暖色小圆点 + 暖色描边，不至于被忽略，但不再是"警告条"
          */}
          {showOverdueHint ? (
            <span
              className="plan-overdue"
              data-testid="plan-overdue-inline"
              data-count={counts.overdue}
              title={`有 ${counts.overdue} 项已经过了日期还没做完（不会再自动挪到今天了）`}
            >
              <button
                type="button"
                className="plan-overdue__open"
                data-testid="plan-overdue-move-open"
                onClick={() => openMovePanel(groups.overdue[0]?.date)}
              >
                <span className="plan-overdue__dot" aria-hidden="true" />
                {`${counts.overdue} 项逾期`}
              </button>
              <button
                type="button"
                className="plan-overdue__dismiss"
                data-testid="plan-overdue-dismiss"
                aria-label="关闭逾期提醒（今天不再显示）"
                title="今天不再显示"
                onClick={dismissOverdueHint}
              >
                ×
              </button>
            </span>
          ) : null}
          {/*
            「移动某天未完成的…」（修改 5 轮 §6.3）。
            **任何时候都显示**：它按日期操作，与"今天有没有逾期"无关。
          */}
          <button
            type="button"
            className="chip"
            data-testid="plan-move-open"
            onClick={() => openMovePanel()}
          >
            移动某天未完成的…
          </button>
          <input
            className="toolbar__search"
            placeholder="搜索任务…"
            data-testid="plan-search"
            onChange={(event) => {
              const term = event.target.value.trim()
              document
                .querySelectorAll<HTMLElement>('[data-testid="task-row"]')
                .forEach((row) => {
                  const title = row.querySelector('.task__title')?.textContent ?? ''
                  row.style.display = term === '' || title.includes(term) ? '' : 'none'
                })
            }}
          />
        </>
      }
    >
      {error ? <p className="notice notice--error">读取失败：{error}</p> : null}
      {carryoverNotice ? (
        <p className="notice notice--ok" data-testid="carryover-notice">
          {carryoverNotice}
        </p>
      ) : null}

      <InlineInput
        placeholder="加一项…（回车即创建，默认今天）"
        hint="已添加"
        testId="plan-quick-add"
        onSubmit={onQuickAdd}
      />

      {/*
        计划页当前状态的读数（不可见）。
        验收要能一眼分清"今天视图里没有这条任务"与"根本不在今天视图"——
        这两种情况在 DOM 上都是"找不到那一行"，没有这个读数就只能靠猜。
        修改 4 轮又加了三个统计数：页头那三个数（逾期 / 今天 / 本周）
        现在是"放弃的任务不计入"的口径，验收要能读数核对（`P8-Z4`）。
      */}
      <div
        className="plan__state"
        data-testid="plan-state"
        data-view={view}
        data-active-day={activeDayKey}
        data-today={todayKeyValue}
        data-count-overdue={counts.overdue}
        data-count-today={counts.today}
        data-count-week={counts.week}
        data-count-abandoned={allTasks.abandoned.length}
        data-count-held={tasks.filter((task) => isHeld(task)).length}
        hidden
      />

      {/*
        逾期提醒的状态读数（不可见，修改 6 轮）。
        验收要能分清三件事：提示"真的该显示却没有" / "偏好还没读回来" / "今天关过"——
        这三者在 DOM 上都表现为"找不到 plan-overdue-inline"，只靠找元素分不清，
        所以把 `ready` 与 `dismissed-on` 也读出来（与 plan-state 同一个用途）。
      */}
      <div
        className="plan__state"
        data-testid="plan-overdue-state"
        data-ready={overdueHintPrefsReady ? '1' : '0'}
        data-dismissed-on={overdueHintDismissedOn ?? ''}
        data-shown={showOverdueHint ? '1' : '0'}
        data-count={counts.overdue}
        hidden
      />

      {view === 'today' ? (
        <>
          {groups.overdue.length > 0 ? (
            <section className="group" data-testid="group-overdue">
              <h2 className="group__title group__title--danger">逾期（{groups.overdue.length}）</h2>
              <ul className="task-list">{groups.overdue.map((task) => renderTaskRow(task, { overdue: true }))}</ul>
            </section>
          ) : null}

          <section className="group" data-testid="group-today">
            <h2 className="group__title">今天 · {relativeDayLabel(activeDayKey, today)}</h2>
            {groups.today.length === 0 ? (
              <EmptyState message="今天还没有安排。" testId="plan-today-empty" />
            ) : (
              <ul className="task-list">{groups.today.map((task) => renderTaskRow(task))}</ul>
            )}
          </section>

          {groups.doneToday.length > 0 ? (
            <section className="group" data-testid="group-done">
              <h2 className="group__title">已完成（{groups.doneToday.length}）</h2>
              <ul className="task-list">
                {groups.doneToday.map((task) => renderTaskRow(task))}
              </ul>
            </section>
          ) : null}

          {groups.upcoming.length > 0 ? (
            <section className="group" data-testid="group-upcoming">
              <h2 className="group__title">接下来</h2>
              <ul className="task-list">
                {groups.upcoming.slice(0, 8).map((task) => (
                  <li
                    key={task.id}
                    className="task task--compact"
                    data-testid="task-row"
                    data-task-id={task.id}
                    onContextMenu={(event) =>
                      menu.openFromEvent(event, taskItems(task), `task-row:${task.id}`)
                    }
                  >
                    <span className="task__date">{relativeDayLabel(task.date, today)}</span>
                    <span className="task__title">{task.title}</span>
                    <MenuButton menu={menu} items={() => taskItems(task)} testId="task-menu" />
                  </li>
                ))}
              </ul>
            </section>
          ) : null}
        </>
      ) : null}

      {/*
        日历三档（本周 / 月 / 年）——**同一个日历，只换网格密度**。
        组件在 `modules/calendar/CalendarPage.tsx`，网格计算是纯函数，
        这里只把数据与回调接上（拖拽改期的 ref、右键菜单、任务小面板的四个动作）。
      */}
      {isCalendarView(view) ? (
        <CalendarPage
          mode={view as 'week' | 'month' | 'year'}
          tasks={tasks}
          todayKey={todayKeyValue}
          weekStart={weekStart}
          anchorKey={anchorKey}
          onAnchorChange={setAnchorKey}
          onPickDay={(key) => {
            // 点某天 → 切到那一天的"今天"列表（§5.4）
            setActiveDayKey(key)
            setView('today')
          }}
          onPickMonth={(key) => {
            // 点某月 → 跳到那个月的月视图（§5.5）
            setAnchorKey(key)
            setView('month')
          }}
          onCreateAt={(date, startTime) => openCreateForm({ date, startTime })}
          onTaskContextMenu={(task, event) =>
            menu.openFromEvent(event, taskItems(task), `week-card:${task.id}`)
          }
          onDragStartTask={(taskId) => {
            dragIdRef.current = taskId
          }}
          onDragEndTask={() => {
            dragIdRef.current = null
          }}
          onDropToDate={(key) => void onDropToDate(key)}
          onEditTask={openEditForm}
          onToggleDone={(task) => void toggleDone(task.id)}
          onAdjustTime={(task) => setTimeTask(task)}
          onDeleteTask={(task) => void removeTask(task.id)}
        />
      ) : null}

      {view === 'all' ? (
        <>
          <section className="group" data-testid="group-all">
            <h2 className="group__title">全部任务（{activeRows.length}）</h2>
            {activeRows.length === 0 ? (
              <EmptyState message="还没有任何任务。" />
            ) : (
              <ul className="task-list">
                {activeRows
                  .slice()
                  .sort(byDateThenTitle)
                  .map((task) => renderTaskRow(task, { showDate: true }))}
              </ul>
            )}
          </section>

          {/*
            已标未完成（修改 7 轮 · `修改-7.md` §四 4.2）：
            它们**不算逾期**、不在「今天 / 本周」、首页也不显示——
            所以这里是**唯一还能看见它们的地方**。少了这一组，
            用户一按「标记未完成」那条任务就从界面上凭空消失了。
            组标题右边那句小灰字是给用户吃定心丸的：标记不等于丢了。
          */}
          {groups.held.length > 0 ? (
            <section className="group" data-testid="group-held">
              <h2 className="group__title group__title--held">
                {`已标未完成（${groups.held.length}）`}
                <span className="group__title-hint" data-testid="group-held-hint">
                  不计入逾期
                </span>
              </h2>
              <ul className="task-list">
                {groups.held
                  .slice()
                  .sort(byDateThenTitle)
                  .map((task) => renderTaskRow(task, { showDate: true }))}
              </ul>
            </section>
          ) : null}

          {/*
            已放弃的单独一组（修改 4 轮 §7.2 第 5 条）：
            它们退出了今天 / 本周与所有统计，但**没有消失**——
            在这里查得到，也能一键恢复成未完成。
          */}
          {allTasks.abandoned.length > 0 ? (
            <section className="group" data-testid="group-abandoned">
              <h2 className="group__title group__title--muted">
                已放弃（{allTasks.abandoned.length}）
              </h2>
              <ul className="task-list">
                {allTasks.abandoned
                  .slice()
                  .sort(byDateThenTitle)
                  .map((task) => renderTaskRow(task, { showDate: true }))}
              </ul>
            </section>
          ) : null}
        </>
      ) : null}

      {/* 新建 / 编辑任务表单（BUG-001 日期可选、BUG-002 可修改、BUG-003 按钮有反馈） */}
      <FormDrawer
        open={formOpen}
        title={editingId === null ? '新建任务' : '编辑任务'}
        fields={taskFormFields()}
        initialValues={formInitial}
        initialFormats={formFormats}
        onClose={() => setFormOpen(false)}
        onSubmit={onSubmitForm}
        testId="task-form"
      />

      {/*
        「移动某天未完成的…」批量移动面板（修改 5 轮 §6.3）。

        用现有的 `Drawer`（不新造一套交互）：里面的日期控件与任务表单里那个
        `type="date"` 同一个样式类 `.field__control`。
        预览区（`plan-move-preview`）**点之前就显示数量**，确认按钮的数字跟着它走。
      */}
      <Drawer
        open={moveOpen}
        title="移动某天未完成的…"
        onClose={() => setMoveOpen(false)}
        testId="plan-move-panel"
        footer={
          <div className="form__footer">
            {movePreview.reason !== null ? (
              <span className="inline-input__hint" data-testid="plan-move-reason">
                {movePreview.reason}
              </span>
            ) : null}
            <span className="toolbar__spacer" />
            <button type="button" className="button" onClick={() => setMoveOpen(false)}>
              取消
            </button>
            <button
              type="button"
              className="button button--primary"
              data-testid="plan-move-confirm"
              disabled={!movePreview.canMove}
              onClick={() => void onConfirmMove()}
            >
              {dateMoveConfirmLabel(movePreview)}
            </button>
          </div>
        }
      >
        <label className="field" htmlFor="plan-move-source-input">
          <span className="field__label">从哪一天</span>
          <input
            id="plan-move-source-input"
            type="date"
            className="field__control"
            data-testid="plan-move-source"
            value={moveSource}
            onChange={(event) => setMoveSource(event.target.value)}
          />
          <span className="field__hint">可以选过去、今天或未来的任意一天</span>
        </label>

        <p
          className="notice notice--ok"
          data-testid="plan-move-preview"
          data-count={movePreview.movable.length}
        >
          {dateMovePreviewText(movePreview)}
        </p>

        <label className="field" htmlFor="plan-move-target-input">
          <span className="field__label">移到哪一天</span>
          <input
            id="plan-move-target-input"
            type="date"
            className="field__control"
            data-testid="plan-move-target"
            value={moveTarget}
            onChange={(event) => setMoveTarget(event.target.value)}
          />
          <span className="field__hint">
            只搬这一天里「未完成」的任务；标了「未完成」的、已放弃的、重复的都不搬
          </span>
        </label>
      </Drawer>

      {/*
        逐条「移动到指定日期…」（修改 5 轮 §6.5）。
        **不受 held 限制**：用户单独点它就是要动这一条。
      */}
      <FormDrawer
        open={dateMoveTask !== null}
        title="移动到指定日期"
        fields={[{ kind: 'date', key: 'date', label: '新日期', testId: 'task-date-move-input', required: true }]}
        initialValues={{
          date:
            dateMoveTask !== null && dateMoveTask.date !== UNSCHEDULED
              ? dateMoveTask.date
              : todayKeyValue
        }}
        onClose={() => setDateMoveTask(null)}
        submitLabel="移动"
        onSubmit={async (values) => {
          const task = dateMoveTask
          if (task === null) return
          const next = (values['date'] ?? '').trim()
          if (next === '') throw new Error('请选择要移到哪一天')
          // 与批量移动同一条落库规则（`taskDateMovePatch`）：日期 + 顺延次数 +1
          await patchTask(task.id, taskDateMovePatch(task, next))
          setCarryoverNotice(dateMovedNotice(task.date, next, 1))
          setDateMoveTask(null)
        }}
        testId="task-date-move-form"
      />

      {/* 调整时间（右键菜单 / ⋯ 菜单的"调整时间"）：起始与结束时间 */}
      <FormDrawer
        open={timeTask !== null}
        title="调整时间"
        fields={[
          { kind: 'time', key: 'startTime', label: '开始时间', testId: 'task-time-start' },
          {
            kind: 'time',
            key: 'endTime',
            label: '结束时间',
            testId: 'task-time-end',
            hint: '留空表示只记开始时间'
          },
          {
            kind: 'select',
            key: 'timeSlot',
            label: '时段',
            testId: 'task-time-slot',
            options: (Object.keys(TIME_SLOT_LABELS) as TimeSlot[]).map((slot) => ({
              value: slot,
              label: TIME_SLOT_LABELS[slot]
            }))
          }
        ]}
        initialValues={{
          startTime: timeTask?.startTime ?? '',
          endTime: timeTask?.endTime ?? '',
          timeSlot: timeTask?.timeSlot ?? 'none'
        }}
        onClose={() => setTimeTask(null)}
        onSubmit={async (values) => {
          if (!timeTask) return
          // 与新建 / 编辑表单同一条校验：结束时间必须晚于开始时间（P8-C8）
          const rangeError = timeRangeError(values['startTime'], values['endTime'])
          if (rangeError !== null) throw new Error(rangeError)
          const range = normalizeTimeRange(values['startTime'], values['endTime'])
          await patchTask(timeTask.id, {
            // 先清掉旧值再写新值，避免"改完还剩一个旧结束时间"。
            // 传 null 而不是 undefined：undefined 会被 JSON 序列化整条丢掉，
            // 旧值就清不掉了（已踩过）。
            startTime: null,
            endTime: null,
            ...range,
            timeSlot: (values['timeSlot'] ?? 'none') as TimeSlot
          } as unknown as Partial<PlanTask>)
          setTimeTask(null)
        }}
        testId="task-time-form"
      />

      {/* 全页只放一个菜单实例：`⋯` 与右键都往它里面塞同一批菜单项 */}
      <ContextMenu state={menu.state} onClose={menu.close} />
    </PageShell>
  )
}
