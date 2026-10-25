/**
 * 端口快照工具（对应 PRD K2：本程序运行期间不新增任何监听端口）
 *
 * 用法：
 *   node scripts/port-check.mjs before     # 启动应用之前：记录基线
 *   node scripts/port-check.mjs now        # 启动应用之后：记录当前快照
 *
 * 对比逻辑在应用内的验证台里完成（见 src/main/verify/runner.ts comparePortSnapshot），
 * 这样"对比"与"运行"发生在同一时间点，证据更可靠。
 *
 * 注意：沙箱禁止捕获子进程的管道输出（EPERM），因此这里让 PowerShell 自己把结果
 * 写进文件（Out-File，不经过管道），再由本脚本读回。
 */
import { execFileSync } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'

const ROOT = resolve(import.meta.dirname, '..')
const DIAG_DIR = resolve(ROOT, 'logs', 'diagnostics')
const RAW_FILE = resolve(DIAG_DIR, 'ports-raw.txt')

export function readListeningPorts() {
  const script = `Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue | Select-Object -ExpandProperty LocalPort | Out-File -FilePath '${RAW_FILE}' -Encoding ascii`
  execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
    stdio: 'ignore',
    timeout: 30000,
    windowsHide: true
  })

  const raw = readFileSync(RAW_FILE, 'utf8').replace(/^\uFEFF/, '')
  const ports = new Set()
  for (const line of raw.split(/\r?\n/)) {
    const value = Number.parseInt(line.trim(), 10)
    if (Number.isInteger(value) && value > 0 && value <= 65535) ports.add(value)
  }
  return [...ports].sort((a, b) => a - b)
}

const mode = process.argv[2] ?? 'now'
const target = mode === 'before' ? 'ports-baseline.json' : 'ports-after.json'

mkdirSync(DIAG_DIR, { recursive: true })
const ports = readListeningPorts()
const file = resolve(DIAG_DIR, target)
writeFileSync(file, JSON.stringify({ takenAt: new Date().toISOString(), ports }, null, 2), 'utf8')

process.stdout.write(
  `已记录${mode === 'before' ? '基线' : '当前快照'}：${ports.length} 个监听端口\n`
)
process.stdout.write(ports.length ? `${ports.join(', ')}\n` : '（当前无任何监听端口）\n')
process.stdout.write(`文件：${file}\n`)
