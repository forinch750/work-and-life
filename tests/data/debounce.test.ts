/**
 * 阶段 1 测试：写入防抖
 *
 * 验收目标：连续改动合并成一次落盘，但绝不让改动无限期停留在内存里。
 */
import { describe, expect, it, vi } from 'vitest'
import { createDebouncedWriter } from '../../src/main/data/debounce'

/** 可控的假定时器 */
function makeFakeTimers() {
  let current = 0
  const tasks: Array<{ id: number; at: number; handler: () => void }> = []
  let nextId = 1

  return {
    now: () => current,
    setTimer: (handler: () => void, ms: number) => {
      const id = nextId++
      tasks.push({ id, at: current + ms, handler })
      return id
    },
    clearTimer: (handle: unknown) => {
      const index = tasks.findIndex((task) => task.id === handle)
      if (index >= 0) tasks.splice(index, 1)
    },
    /** 推进时间并触发到期的定时器 */
    advance(ms: number) {
      current += ms
      const due = tasks.filter((task) => task.at <= current).sort((a, b) => a.at - b.at)
      for (const task of due) {
        const index = tasks.indexOf(task)
        if (index >= 0) tasks.splice(index, 1)
        task.handler()
      }
    },
    pendingCount: () => tasks.length
  }
}

describe('createDebouncedWriter', () => {
  it('单次 schedule 在延迟后落盘一次', () => {
    const timers = makeFakeTimers()
    const write = vi.fn()
    const writer = createDebouncedWriter({ write, ...timers, delayMs: 300 })

    writer.schedule()
    expect(write).not.toHaveBeenCalled()
    expect(writer.hasPending()).toBe(true)

    timers.advance(300)
    expect(write).toHaveBeenCalledTimes(1)
    expect(writer.hasPending()).toBe(false)
  })

  it('连续 schedule 合并成一次落盘', () => {
    const timers = makeFakeTimers()
    const write = vi.fn()
    const writer = createDebouncedWriter({ write, ...timers, delayMs: 300 })

    for (let i = 0; i < 10; i += 1) {
      writer.schedule()
      timers.advance(50)
    }
    // 每次都重置了延迟，所以还没写
    expect(write).toHaveBeenCalledTimes(0)

    timers.advance(300)
    expect(write).toHaveBeenCalledTimes(1)
  })

  it('持续不断的改动不会让内容无限期留在内存里（最长等待上限生效）', () => {
    const timers = makeFakeTimers()
    const write = vi.fn()
    const writer = createDebouncedWriter({ write, ...timers, delayMs: 300, maxDelayMs: 1000 })

    // 每 100ms 改一次，一直不让 300ms 的合并窗口自然到期
    for (let i = 0; i < 10; i += 1) {
      writer.schedule()
      timers.advance(100)
    }

    // 已过 1000ms，必须已经被强制落盘过
    expect(write.mock.calls.length).toBeGreaterThanOrEqual(1)

    for (let i = 0; i < 10; i += 1) {
      writer.schedule()
      timers.advance(100)
    }

    // 再过 1000ms，又落盘一次；但绝不会变成"每次改动都写"（那要 20 次）
    expect(write.mock.calls.length).toBeGreaterThanOrEqual(2)
    expect(write.mock.calls.length).toBeLessThanOrEqual(4)
  })

  it('落盘之后重新计时，不会残留旧的定时器', () => {
    const timers = makeFakeTimers()
    const write = vi.fn()
    const writer = createDebouncedWriter({ write, ...timers, delayMs: 100, maxDelayMs: 500 })

    writer.schedule()
    timers.advance(100)
    expect(write).toHaveBeenCalledTimes(1)

    // 没有新改动时不应再有落盘
    timers.advance(5000)
    expect(write).toHaveBeenCalledTimes(1)
  })

  it('flush 立即落盘并返回是否有待写内容', () => {
    const timers = makeFakeTimers()
    const write = vi.fn()
    const writer = createDebouncedWriter({ write, ...timers })

    expect(writer.flush()).toBe(false)
    expect(write).not.toHaveBeenCalled()

    writer.schedule()
    expect(writer.flush()).toBe(true)
    expect(write).toHaveBeenCalledTimes(1)
    expect(writer.hasPending()).toBe(false)

    // flush 之后定时器不应再触发第二次写
    timers.advance(1000)
    expect(write).toHaveBeenCalledTimes(1)
  })

  it('cancel 丢弃待写内容，不落盘', () => {
    const timers = makeFakeTimers()
    const write = vi.fn()
    const writer = createDebouncedWriter({ write, ...timers })

    writer.schedule()
    writer.cancel()
    expect(writer.hasPending()).toBe(false)

    timers.advance(1000)
    expect(write).not.toHaveBeenCalled()
  })

  it('落盘失败不会让异常冒泡，并回调 onError', () => {
    const timers = makeFakeTimers()
    const onError = vi.fn()
    const writer = createDebouncedWriter({
      write: () => {
        throw new Error('disk full')
      },
      onError,
      ...timers
    })

    writer.schedule()
    expect(() => timers.advance(300)).not.toThrow()
    expect(onError).toHaveBeenCalledTimes(1)
    expect((onError.mock.calls[0]?.[0] as Error).message).toBe('disk full')
  })

  it('落盘失败后 pending 已清除，下次改动可再次触发', () => {
    const timers = makeFakeTimers()
    let shouldThrow = true
    const write = vi.fn(() => {
      if (shouldThrow) throw new Error('boom')
    })
    const writer = createDebouncedWriter({ write, onError: () => {}, ...timers })

    writer.schedule()
    timers.advance(300)
    expect(writer.hasPending()).toBe(false)

    shouldThrow = false
    writer.schedule()
    timers.advance(300)
    expect(write).toHaveBeenCalledTimes(2)
  })
})
