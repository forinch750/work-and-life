/**
 * 隔离诊断（对应 PRD K2 / K5：确认本程序运行期间不新增任何监听端口）
 *
 * 用 PowerShell 枚举本机监听端口，快照落到 logs\diagnostics\ 下，
 * 便于开工前后对比，形成可检查的证据而不是口头保证。
 */
import { execFileSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'

/** 解析 Get-NetTCPConnection 的输出，得到去重、升序的端口列表 */
export function parseListeningPorts(stdout: string): number[] {
  const ports = new Set<number>()
  for (const rawLine of stdout.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line) continue
    const value = Number.parseInt(line, 10)
    if (Number.isInteger(value) && value > 0 && value <= 65535) ports.add(value)
  }
  return [...ports].sort((a, b) => a - b)
}

/** 读取当前本机监听端口；失败时返回 null（不抛错，诊断不该影响主流程） */
export function listListeningPorts(): number[] | null {
  try {
    const stdout = execFileSync(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        'Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue | Select-Object -ExpandProperty LocalPort'
      ],
      { encoding: 'utf8', timeout: 20000, windowsHide: true }
    )
    return parseListeningPorts(stdout)
  } catch {
    return null
  }
}

export interface PortSnapshot {
  takenAt: string
  ports: number[]
}

export function capturePortSnapshot(): PortSnapshot {
  return { takenAt: new Date().toISOString(), ports: listListeningPorts() ?? [] }
}

/** 把端口快照写入磁盘，返回文件路径 */
export function savePortSnapshot(diagnosticsDir: string, label: string): string {
  mkdirSync(diagnosticsDir, { recursive: true })
  const snapshot = capturePortSnapshot()
  const filePath = resolve(diagnosticsDir, `ports-${label}.json`)
  writeFileSync(filePath, JSON.stringify(snapshot, null, 2), 'utf8')
  return filePath
}
