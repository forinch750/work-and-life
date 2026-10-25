/**
 * 启动 Electron 的通用封装。
 *
 * 直接用 spike 方式启动 electron.exe，不经过任何 shell 或 bin 包装，
 * 且 stdio 用 inherit（沙箱禁止带管道的 spawn）。
 *
 * 用法：node scripts/run-electron.mjs [--smoke] [-- <额外参数>]
 */
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join, resolve } from 'node:path'

const ROOT = resolve(import.meta.dirname, '..')
const electronExe = join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe')

export function launchElectron({ smoke = false, env = {}, extraArgs = [] } = {}) {
  if (!existsSync(electronExe)) {
    throw new Error(`找不到 Electron 运行时：${electronExe}\n请先运行 node scripts/fetch-binaries.mjs`)
  }

  const child = spawn(electronExe, ['.', ...extraArgs], {
    cwd: ROOT,
    stdio: ['ignore', 'inherit', 'inherit'],
    windowsHide: true,
    env: {
      ...process.env,
      ...(smoke ? { WORKLIFE_SMOKE: '1' } : {}),
      ...env
    }
  })

  return child
}

/** 以函数方式运行，返回退出码 */
export function runElectron(options = {}) {
  return new Promise((resolvePromise) => {
    const child = launchElectron(options)
    child.on('exit', (code) => resolvePromise(code ?? 1))
    child.on('error', (error) => {
      process.stdout.write(`启动失败：${error.message}\n`)
      resolvePromise(1)
    })
  })
}

// 直接执行时：等同"启动应用"
if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) {
  const smoke = process.argv.includes('--smoke')
  const code = await runElectron({ smoke })
  process.exit(code)
}
