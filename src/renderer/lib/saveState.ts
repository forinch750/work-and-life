/**
 * 保存状态的 React 绑定（第二轮 BUG-006）
 *
 * 状态流转本身在 src\shared\saveState.ts 里，是可单测的纯函数；
 * 这里只负责把它接到 React 生命周期上：
 *   - run() 包装一次写操作，自动进入 saving → saved / error
 *   - 成功后过 SAVED_HINT_MS 自动回到 idle
 *   - 组件卸载时清掉定时器，避免对已卸载组件 setState
 *
 * 组件的实际渲染行为由端到端验收覆盖（本项目不引入 jsdom）。
 *
 * ## 第 04 块修掉的一个真问题：怎么判断"这次 run 到底成不成"
 *
 * 以前调用方是这样判断的：
 *
 *     const outcome = await save.run(() => onSubmit(values))
 *     if (outcome === undefined) { /* 当成失败 *\/ }
 *
 * 但 `onSubmit` 基本都是 `Promise<void>`，**成功时返回值也是 undefined**，
 * 于是"保存成功"被当成"保存失败"：表单弹"保存失败"并且不关，
 * 行内输入框保存成功后也不清空。这个坑很隐蔽——数据其实已经写进去了。
 *
 * 现在把结果记在 **ref** 上，并通过 `failed` / `lastError` 两个 getter 暴露：
 * getter 读 ref，所以即使调用方手里的是旧闭包里的对象，读到的也是**这一次**的结果，
 * 不受 React 渲染快照影响。
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import {
  SAVED_HINT_MS,
  beginSave,
  failSave,
  idleSave,
  shouldAutoReset,
  succeedSave,
  type SaveStatus
} from '../../shared/saveState'

export interface SaveStateController extends SaveStatus {
  /**
   * 包装一次写操作。返回原操作的返回值；失败时返回 undefined 并进入 error 状态。
   * 不抛异常——调用方不需要自己 try/catch，界面靠 state 显示结果。
   */
  run: <T>(operation: () => Promise<T>) => Promise<T | undefined>
  /**
   * **上一次 run 是否失败**。
   *
   * 读的是 ref，不受渲染快照影响，所以 `await save.run(...)` 之后立刻读它是准的。
   * 判断成功/失败要用它，**不要**用 `返回值 === undefined`
   * （`Promise<void>` 成功时返回值同样是 undefined，见文件头）。
   */
  readonly failed: boolean
  /** 上一次失败的原因；没有失败时为 null */
  readonly lastError: string | null
  /** 手动回到 idle（例如关闭抽屉时） */
  reset: () => void
}

export function useSaveState(): SaveStateController {
  const [status, setStatus] = useState<SaveStatus>(idleSave)
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const mountedRef = useRef(true)
  /** 最近一次 run 的结果（成功/失败 + 原因），用 ref 才能保证"读完就有" */
  const outcomeRef = useRef<{ failed: boolean; error: string | null }>({ failed: false, error: null })

  const clearTimer = (): void => {
    if (timerRef.current !== null) {
      clearTimeout(timerRef.current)
      timerRef.current = null
    }
  }

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
      clearTimer()
    }
  }, [])

  const reset = useCallback((): void => {
    clearTimer()
    outcomeRef.current = { failed: false, error: null }
    if (!mountedRef.current) return
    setStatus(idleSave())
  }, [])

  const run = useCallback(async <T,>(operation: () => Promise<T>): Promise<T | undefined> => {
    clearTimer()
    outcomeRef.current = { failed: false, error: null }
    if (mountedRef.current) setStatus(beginSave())
    try {
      const result = await operation()
      outcomeRef.current = { failed: false, error: null }
      if (mountedRef.current) {
        const next = succeedSave()
        setStatus(next)
        if (shouldAutoReset(next)) {
          timerRef.current = setTimeout(() => {
            if (mountedRef.current) setStatus(idleSave())
          }, SAVED_HINT_MS)
        }
      }
      return result
    } catch (reason) {
      const failed = failSave(reason)
      outcomeRef.current = { failed: true, error: failed.error }
      if (mountedRef.current) setStatus(failed)
      return undefined
    }
  }, [])

  return {
    ...status,
    run,
    reset,
    // getter：读 ref，所以旧闭包读到的也是"这一次"的结果
    get failed() {
      return outcomeRef.current.failed
    },
    get lastError() {
      return outcomeRef.current.error
    }
  }
}
