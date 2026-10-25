/**
 * 冒烟测试：构建后真实启动 Electron，验证"能开窗、能自退、不留残留进程"。
 *
 * 关键点：本机沙箱禁止带管道 stdio 的 spawn，因此
 *   - 构建子进程用 stdio: 'inherit'
 *   - 应用自报的结果通过临时文件回传，而不是捕获 stdout
 *
 * 用法：node scripts/smoke-electron.mjs [--skip-build]
 */
import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const ROOT = resolve(import.meta.dirname, '..')
const electronExe = join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe')
const builtMain = join(ROOT, 'out', 'main', 'index.js')
const skipBuild = process.argv.includes('--skip-build')

function log(message) {
  process.stdout.write(`${message}\n`)
}

if (!existsSync(electronExe)) {
  log(`失败：找不到 Electron 运行时 ${electronExe}`)
  log('请先运行：node scripts/fetch-binaries.mjs')
  process.exit(1)
}

// 1) 构建
if (!skipBuild) {
  log('[1/3] 构建应用')
  const { execFileSync } = await import('node:child_process')
  execFileSync(process.execPath, [join(ROOT, 'scripts', 'build.mjs')], {
    cwd: ROOT,
    stdio: 'inherit',
    timeout: 900000
  })
} else {
  log('[1/3] 跳过构建')
}

if (!existsSync(builtMain)) {
  log(`失败：构建产物不存在 ${builtMain}`)
  process.exit(1)
}

// 2) 启动应用（冒烟模式：开窗后立即退出）
const resultDir = mkdtempSync(join(tmpdir(), 'worklife-smoke-'))
const resultFile = join(resultDir, 'result.json')

log('[2/3] 启动 Electron（WORKLIFE_SMOKE=1）')
const child = spawn(electronExe, ['.'], {
  cwd: ROOT,
  stdio: ['ignore', 'inherit', 'inherit'],
  windowsHide: true,
  env: {
    ...process.env,
    WORKLIFE_SMOKE: '1',
    WORKLIFE_SMOKE_RESULT: resultFile
  }
})

const finished = await new Promise((resolvePromise) => {
  const timer = setTimeout(() => {
    log('      超时（30 秒），强制结束进程')
    child.kill()
    resolvePromise({ timedOut: true, code: null })
  }, 30000)

  child.on('error', (error) => {
    clearTimeout(timer)
    log(`      启动失败：${error.message}`)
    resolvePromise({ timedOut: false, code: null, error: error.message })
  })

  child.on('exit', (code) => {
    clearTimeout(timer)
    resolvePromise({ timedOut: false, code })
  })
})

// 3) 判定
log('[3/3] 判定')
let marker = null
if (existsSync(resultFile)) {
  try {
    marker = JSON.parse(readFileSync(resultFile, 'utf8'))
  } catch (error) {
    log(`      结果文件解析失败：${error.message}`)
  }
}

const logFile = join(ROOT, 'logs', 'app.log')
const appLog = existsSync(logFile) ? readFileSync(logFile, 'utf8') : ''
const windowCreated = appLog.includes('smoke-mode-window-created')
const gotLock = !appLog.includes('second-instance-blocked')
const portSnapshotSaved = appLog.includes('port-snapshot-saved')

log(`      退出码：${finished.code}`)
log(`      窗口创建标记：${windowCreated ? '有' : '无'}`)
log(`      单实例锁获取：${gotLock ? '成功' : '失败'}`)
log(`      端口快照已记录：${portSnapshotSaved ? '是' : '否'}`)
if (marker) log(`      应用自报：exitCode=${marker.exitCode}`)

rmSync(resultDir, { recursive: true, force: true })

const problems = []
if (finished.error) problems.push(`启动异常：${finished.error}`)
if (finished.timedOut) problems.push('应用没有自行退出（可能启动失败或未进入冒烟模式）')
if (finished.code !== 0 && finished.code !== null) problems.push(`退出码非 0：${finished.code}`)
if (!windowCreated) problems.push('日志中没有窗口创建标记')
if (!gotLock) problems.push('没有拿到单实例锁')
if (!portSnapshotSaved) problems.push('端口快照未写入')

if (problems.length > 0) {
  log('')
  log('冒烟测试失败：')
  for (const problem of problems) log(`  - ${problem}`)
  process.exit(1)
}

log('')
log('冒烟测试通过：应用能启动、能开窗、能自行退出 ✓')
process.exit(0)
