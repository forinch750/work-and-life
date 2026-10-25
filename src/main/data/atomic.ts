/**
 * 原子写入（DEVPLAN 阶段 1 / PRD §7.3）
 *
 * 目标：任何时刻断电或崩溃，磁盘上要么是完整的旧文件，要么是完整的新文件，
 * 绝不会出现"写了一半"的坏文件。
 *
 * 步骤：
 *   1. 先把当前正式文件复制为 .bak（保留上一份内容）
 *   2. 写 <file>.<pid>.<seq>.tmp
 *   3. flush 到磁盘
 *   4. rename 覆盖正式文件（同目录 rename 是原子操作）
 *
 * 读取时若主文件损坏，可以回退到 .bak。
 */
import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync,
  writeSync
} from 'node:fs'
import { dirname } from 'node:path'

export interface AtomicWriteOptions {
  /** 重试次数（Windows 上杀毒软件或索引服务可能短暂占用文件） */
  retries?: number
  /** 首次重试的等待毫秒数，之后指数退避 */
  retryDelayMs?: number
  /** 同步睡眠实现，便于测试注入 */
  sleep?: (ms: number) => void
}

const defaultSleep = (ms: number): void => {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

export function backupPathFor(filePath: string): string {
  return `${filePath}.bak`
}

let sequence = 0

function nextTempPath(filePath: string): string {
  sequence += 1
  return `${filePath}.${process.pid}.${sequence}.tmp`
}

/** 判断两次路径是否指向同一位置（忽略大小写与结尾分隔符） */
export function isSamePath(a: string, b: string): boolean {
  const normalize = (value: string): string =>
    value.replace(/[\\/]+$/, '').replace(/\//g, '\\').toLowerCase()
  return normalize(a) === normalize(b)
}

/**
 * 原子写入。
 * @returns 实际写入的字节数
 */
export function writeFileAtomic(
  filePath: string,
  content: string,
  options: AtomicWriteOptions = {}
): number {
  const retries = options.retries ?? 4
  const sleep = options.sleep ?? defaultSleep
  mkdirSync(dirname(filePath), { recursive: true })

  const tmpPath = nextTempPath(filePath)

  // 1) 写临时文件并落盘
  const fd = openSync(tmpPath, 'w')
  try {
    const buffer = Buffer.from(content, 'utf8')
    writeSync(fd, buffer)
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }

  // 2) 备份当前正式文件（存在才备份）
  const backup = backupPathFor(filePath)
  if (existsSync(filePath)) {
    try {
      writeFileSync(backup, readFileSync(filePath))
    } catch {
      // 备份失败不阻断主流程：真正重要的是下面的替换能成功
    }
  }

  // 3) 替换正式文件，失败则重试
  let lastError: unknown = null
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      renameSync(tmpPath, filePath)
      return Buffer.byteLength(content, 'utf8')
    } catch (error) {
      lastError = error
      if (attempt < retries) sleep((options.retryDelayMs ?? 30) * 2 ** attempt)
    }
  }

  // 全部失败：清掉临时文件再抛出
  try {
    if (existsSync(tmpPath)) unlinkSync(tmpPath)
  } catch {
    /* 清理失败无所谓 */
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError))
}

export interface AtomicReadResult {
  content: string
  /** 来源：主文件还是备份 */
  source: 'file' | 'backup'
}

/**
 * 读取文件内容，主文件不可用时回退到 .bak。
 * 找不到任何可用内容时返回 null。
 */
export function readFileWithFallback(filePath: string): AtomicReadResult | null {
  if (existsSync(filePath)) {
    try {
      return { content: readFileSync(filePath, 'utf8'), source: 'file' }
    } catch {
      /* 落到备份 */
    }
  }
  const backup = backupPathFor(filePath)
  if (existsSync(backup)) {
    try {
      return { content: readFileSync(backup, 'utf8'), source: 'backup' }
    } catch {
      return null
    }
  }
  return null
}

/** 删除文件与其备份（测试与清理用） */
export function removeFileWithBackup(filePath: string): void {
  rmSync(filePath, { force: true })
  rmSync(backupPathFor(filePath), { force: true })
}
