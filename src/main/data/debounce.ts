/**
 * 写入防抖（DEVPLAN 阶段 1）
 *
 * 目的：连续多次改动合并成一次落盘，避免频繁重写整个文件。
 * 约束：不能让改动无限期停留在内存里——所以同时设置"最长等待"上限，
 *       并且程序退出前必须强制落盘（见 flush）。
 */

export interface DebouncedWriterOptions {
  /** 合并窗口：最后一次调用后等待多久落盘 */
  delayMs?: number
  /** 最长等待：距第一次待写起，最多拖多久必须落盘 */
  maxDelayMs?: number
  /** 落盘实现 */
  write: () => void
  /** 落盘失败回调 */
  onError?: (error: unknown) => void
  /** 定时器实现，便于测试注入 */
  setTimer?: (handler: () => void, ms: number) => unknown
  clearTimer?: (handle: unknown) => void
  /** 当前时间，便于测试注入 */
  now?: () => number
}

export interface DebouncedWriter {
  /** 标记有改动待写入 */
  schedule(): void
  /** 立即落盘（若没有待写内容则什么也不做），返回是否真的写了 */
  flush(): boolean
  /** 丢弃待写内容（不落盘） */
  cancel(): void
  /** 是否还有未落盘的改动 */
  hasPending(): boolean
}

export function createDebouncedWriter(options: DebouncedWriterOptions): DebouncedWriter {
  const delayMs = options.delayMs ?? 300
  const maxDelayMs = options.maxDelayMs ?? 2000
  const setTimer =
    options.setTimer ?? ((handler, ms) => setTimeout(handler, ms) as unknown as number)
  const clearTimer = options.clearTimer ?? ((handle) => clearTimeout(handle as number))
  const now = options.now ?? (() => Date.now())

  let pending = false
  let firstPendingAt = 0
  let timer: unknown = null

  const clear = (): void => {
    if (timer !== null) {
      clearTimer(timer)
      timer = null
    }
  }

  const doWrite = (): void => {
    clear()
    if (!pending) return
    pending = false
    firstPendingAt = 0
    try {
      options.write()
    } catch (error) {
      options.onError?.(error)
    }
  }

  return {
    schedule(): void {
      if (!pending) {
        pending = true
        firstPendingAt = now()
      }
      clear()
      const elapsed = now() - firstPendingAt
      const wait = Math.max(0, Math.min(delayMs, maxDelayMs - elapsed))
      timer = setTimer(doWrite, wait)
    },

    flush(): boolean {
      const had = pending
      doWrite()
      return had
    },

    cancel(): void {
      clear()
      pending = false
      firstPendingAt = 0
    },

    hasPending(): boolean {
      return pending
    }
  }
}
