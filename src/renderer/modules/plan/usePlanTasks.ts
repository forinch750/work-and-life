/**
 * 计划模块的数据接口（DEVPLAN 阶段 4）
 *
 * 界面通过这里读写 data\plan.json。
 * 所有"规则"都来自 src/shared/planLogic.ts，这里只负责与主进程打交道。
 *
 * 关于并发的处理：
 * 早期版本里 toggleDone 从"渲染时的 tasks 快照"里找目标并计算新状态，
 * 连续点击会读到过期快照，出现"界面变了、数据没变"的错位。
 * 现在所有写操作都先向主进程要一次最新记录，再据此计算，杜绝过期读。
 */
import { useCallback, useEffect, useState } from 'react'
import type { RecordEnvelope } from '../../../shared/types'
import { isAbandoned, isHeld, normalizePlanTask, UNSCHEDULED, type PlanTask } from '../../../shared/plan'
import { computeCarryover } from '../../../shared/planLogic'
import { getDataApi } from '../../lib/dataClient'
import { notifyDataChanged } from '../../lib/dataEvents'

export interface UsePlanTasksResult {
  tasks: PlanTask[]
  loading: boolean
  error: string | null
  reload: () => Promise<void>
  addTask: (input: Partial<PlanTask> & { title: string }) => Promise<PlanTask>
  patchTask: (id: string, patch: Partial<PlanTask>) => Promise<void>
  toggleDone: (id: string) => Promise<void>
  /**
   * 放弃 / 恢复为未完成（修改 4 轮）：同一个开关按当前状态取反。
   *
   * 放弃时**同时**把 `done` 归零、`doneAt` 清空——两件事一次写完，
   * 不给"done 与 abandoned 同时为 true"留窗口（`normalizePlanTask` 还会再兜一层）。
   */
  toggleAbandon: (id: string) => Promise<void>
  removeTask: (id: string) => Promise<void>
  /**
   * 手动触发一次顺延（`修改-5` 起**不再自动调用**）。
   *
   * 函数本身原样保留：它本来就是"可手动调用"的，既有单测（`abandon.test.ts` /
   * `planLogic.test.ts`）也还在用 `computeCarryover`。这一轮只是**没有人自动调它**了，
   * 批量移动改走「源日期 → 目标日期」（`planLogic.planDateMove`）。
   */
  runCarryover: (todayKey: string) => Promise<number>
}

/** 把记录体规范成 PlanTask，并过滤掉已删除的 */
export function toPlanTasks(records: RecordEnvelope[]): PlanTask[] {
  return records
    .filter((record) => record.deletedAt === undefined || record.deletedAt === null)
    .map((record) => normalizePlanTask(record as unknown as Record<string, unknown>))
    .filter((task) => task.id !== '' && task.title !== '')
}

export function usePlanTasks(): UsePlanTasksResult {
  const [tasks, setTasks] = useState<PlanTask[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const reload = useCallback(async () => {
    try {
      const records = await getDataApi().list('plan')
      setTasks(toPlanTasks(records))
      setError(null)
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void reload()
  }, [reload])

  // 数据被外部改动（例如验收脚本注入）时重新加载
  useEffect(() => {
    const handler = (): void => {
      void reload()
    }
    window.addEventListener('worklife:data-changed', handler)
    return () => window.removeEventListener('worklife:data-changed', handler)
  }, [reload])

  const addTask = useCallback(
    async (input: Partial<PlanTask> & { title: string }) => {
      const record = {
        title: input.title,
        date: input.date ?? UNSCHEDULED,
        timeSlot: input.timeSlot ?? 'none',
        recurrence: input.recurrence ?? 'none',
        done: false,
        carriedOver: 0,
        doneAt: null,
        ...(input.note ? { note: input.note } : {}),
        // 备注是富文本时格式标记必须一起写（第 04 块），否则 HTML 会被当纯文本显示
        ...(input.noteFormat ? { noteFormat: input.noteFormat } : {}),
        // 新建任务表单填的开始/结束时间也要真的落库
        // （以前这里漏了：表单传进来、但记录没带上，等于白填）
        ...(input.startTime ? { startTime: input.startTime } : {}),
        ...(input.endTime ? { endTime: input.endTime } : {}),
        ...(input.seriesId ? { seriesId: input.seriesId } : {})
      }
      const created = await getDataApi().add('plan', record)
      await reload()
      notifyDataChanged('plan')
      return normalizePlanTask(created as unknown as Record<string, unknown>)
    },
    [reload]
  )

  const patchTask = useCallback(
    async (id: string, patch: Partial<PlanTask>) => {
      await getDataApi().update('plan', id, { ...patch })
      await getDataApi().flush()
      await reload()
      notifyDataChanged('plan')
    },
    [reload]
  )

  const toggleDone = useCallback(
    async (id: string) => {
      // 关键：以主进程的最新记录为准，而不是渲染时的快照
      const fresh = await getDataApi().list('plan')
      const current = toPlanTasks(fresh).find((task) => task.id === id)
      if (!current) {
        await reload()
        return
      }
      const nowDone = !current.done
      await getDataApi().update('plan', id, {
        done: nowDone,
        doneAt: nowDone ? new Date().toISOString() : null,
        /**
         * 勾选框**语义不变**（仍然只是"完成 / 未完成"，决定见 `修改-4.md` §7.5）。
         *
         * 但已放弃的行上勾选必须能落地：`normalizePlanTask` 强制 `abandoned ⇒ done === false`，
         * 所以如果只写 `done: true`，数据会被再规范回未完成 —— 看起来就是"点了没反应"。
         * 因此勾上时顺手把放弃标记一起清掉（= 恢复并完成），取消勾选时不动它。
         *
         * 同理，勾上时也要把「未完成」标记（`held`）清掉：做完了就不再是"还没做"。
         * 不在这里写的话，`normalizePlanTask` 读盘时虽然会清掉，但记录里那个 `held: true`
         * 还留着——日后取消勾选它会**自己冒回来**（修改 5 轮补的口子）。
         */
        ...(nowDone && isAbandoned(current) ? { abandoned: false } : {}),
        ...(nowDone && isHeld(current) ? { held: false } : {})
      })
      await getDataApi().flush()
      await reload()
      notifyDataChanged('plan')
    },
    [reload]
  )

  /**
   * 放弃 / 恢复为未完成（修改 4 轮·第三态）。
   *
   * 与 `toggleDone` 一样先向主进程要一次最新记录再算，避免连续点击读到过期快照。
   * 放弃时一次写完三件事：`abandoned: true` + `done: false` + `doneAt: null`
   * （互斥由这里和 `normalizePlanTask` 双层保证）。
   * 顺手把 `held` 清掉：已放弃的任务不存在"别批量搬我"这回事。
   */
  const toggleAbandon = useCallback(
    async (id: string) => {
      const fresh = await getDataApi().list('plan')
      const current = toPlanTasks(fresh).find((task) => task.id === id)
      if (!current) {
        await reload()
        return
      }
      const nowAbandoned = !isAbandoned(current)
      await getDataApi().update(
        'plan',
        id,
        nowAbandoned
          ? { abandoned: true, done: false, doneAt: null, ...(isHeld(current) ? { held: false } : {}) }
          : { abandoned: false }
      )
      await getDataApi().flush()
      await reload()
      notifyDataChanged('plan')
    },
    [reload]
  )

  const removeTask = useCallback(
    async (id: string) => {
      await getDataApi().remove('plan', id)
      await getDataApi().flush()
      await reload()
      notifyDataChanged('plan')
    },
    [reload]
  )

  const runCarryover = useCallback(
    async (todayKey: string) => {
      // 同样以最新记录为准，避免用在旧快照上算顺延
      const fresh = await getDataApi().list('plan')
      const { moved } = computeCarryover(toPlanTasks(fresh), todayKey)
      if (moved.length === 0) return 0
      for (const item of moved) {
        await getDataApi().update('plan', item.id, {
          date: item.to,
          carriedOver: item.carriedOver
        })
      }
      await getDataApi().flush()
      await reload()
      if (moved.length > 0) notifyDataChanged('plan')
      return moved.length
    },
    [reload]
  )

  return {
    tasks,
    loading,
    error,
    reload,
    addTask,
    patchTask,
    toggleDone,
    toggleAbandon,
    removeTask,
    runCarryover
  }
}
