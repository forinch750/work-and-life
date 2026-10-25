/**
 * 应用日志（DEVPLAN 阶段 0 / 红线：只记启动、错误、落盘失败，绝不记录用户内容）
 */
import { appendFileSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'

export type LogLevel = 'info' | 'warn' | 'error'

export interface Logger {
  info(event: string, detail?: unknown): void
  warn(event: string, detail?: unknown): void
  error(event: string, detail?: unknown): void
}

export interface CreateLoggerOptions {
  /** 日志文件路径；缺省时只输出到控制台 */
  filePath?: string
  /** 是否同时输出到控制台，默认 true */
  console?: boolean
  /** 当前时间提供者，便于测试 */
  now?: () => Date
  /** 自定义写入实现，便于测试（默认追加写文件） */
  writer?: (filePath: string, line: string) => void
}

/** 把任意抛出物整理成可读文本 */
export function describeError(error: unknown): string {
  if (error instanceof Error) {
    const code = (error as NodeJS.ErrnoException).code
    return code ? `${error.name}[${code}]: ${error.message}` : `${error.name}: ${error.message}`
  }
  if (typeof error === 'string') return error
  try {
    return JSON.stringify(error)
  } catch {
    return String(error)
  }
}

/**
 * 生成一行日志文本（纯函数，便于测试）。
 * 格式：2026-02-14T10:00:00.000Z [error] event | detail
 */
export function formatLogLine(
  level: LogLevel,
  event: string,
  detail: unknown,
  at: Date
): string {
  const suffix = detail === undefined ? '' : ` | ${describeError(detail)}`
  return `${at.toISOString()} [${level}] ${event}${suffix}`
}

export function createLogger(options: CreateLoggerOptions = {}): Logger {
  const { filePath, now = () => new Date(), writer } = options
  const toConsole = options.console ?? true

  const defaultWriter = (path: string, line: string): void => {
    mkdirSync(dirname(path), { recursive: true })
    appendFileSync(path, line + '\n', 'utf8')
  }
  const write = writer ?? defaultWriter

  const emit = (level: LogLevel, event: string, detail?: unknown): void => {
    const line = formatLogLine(level, event, detail, now())
    if (toConsole) {
      // 日志只在本机控制台可见，不经过任何网络
      if (level === 'error') console.error(line)
      else if (level === 'warn') console.warn(line)
      else console.log(line)
    }
    if (!filePath) return
    try {
      write(filePath, line)
    } catch {
      // 日志写不进去绝不能影响主流程
    }
  }

  return {
    info: (event, detail) => emit('info', event, detail),
    warn: (event, detail) => emit('warn', event, detail),
    error: (event, detail) => emit('error', event, detail)
  }
}
