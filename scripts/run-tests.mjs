/**
 * 测试入口。
 *
 * 为什么不让 npm script 直接写 `vitest run`：
 * npm 会把 bin 放进 PATH，实际启动时可能再套一层 shell/子进程，
 * 而本机沙箱对 spawn 有限制。这里直接以子进程方式调用 vitest，
 * 并用 stdio: 'inherit' 避免输出管道（EPERM 的另一种触发方式）。
 */
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join, resolve } from 'node:path'

const ROOT = resolve(import.meta.dirname, '..')
const vitestEntry = join(ROOT, 'node_modules', 'vitest', 'vitest.mjs')

if (!existsSync(vitestEntry)) {
  process.stdout.write(`找不到 vitest：${vitestEntry}\n请先运行 pnpm install\n`)
  process.exit(1)
}

const args = process.argv.slice(2)
const child = spawn(process.execPath, [vitestEntry, 'run', ...args], {
  cwd: ROOT,
  stdio: 'inherit',
  windowsHide: true
})

child.on('exit', (code, signal) => {
  if (signal) {
    process.stdout.write(`测试进程被信号中断：${signal}\n`)
    process.exit(1)
  }
  process.exit(code ?? 1)
})

child.on('error', (error) => {
  process.stdout.write(`无法启动测试进程：${error.message}\n`)
  process.exit(1)
})
