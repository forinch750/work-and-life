/**
 * 验证台启动器（DEVPLAN 各阶段通用）。
 *
 * 做四件事：
 *   1) 构建（可选跳过）
 *   2) 记录端口基线
 *   3) 分趟启动应用，跑完整套验收场景
 *   4) 汇总各趟报告并打印
 *
 * 为什么要分趟：
 *   验收里含"导出 → 清空 → 导入"这种真实破坏性操作，会把当次数据抹掉。
 *   只有跨两趟运行才能证明"关掉再打开数据还在"（PRD A1/A2）。因此：
 *     第 1 趟：非破坏性检查（写入、落盘、备份），退出时写下数据快照
 *     第 2 趟：完整检查（含清空与导入），再次写下快照
 *     第 3 趟：只核对"上一趟退出时的数据这一趟还在"
 *
 * 注意：Electron 需要完整访问权限才能启动（沙箱禁止 Chromium 的多进程通信），
 * 因此本脚本需要在可用的权限下运行一次，即可覆盖一整个阶段的所有验收项。
 *
 * 用法：node scripts/verify.mjs [--skip-build] [--passes=3]
 */
import { spawn, execFileSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const ROOT = resolve(import.meta.dirname, '..')
const electronExe = join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe')
const REPORT_FILE = join(ROOT, 'logs', 'verify-report.json')
const skipBuild = process.argv.includes('--skip-build')
const passesArg = process.argv.find((arg) => arg.startsWith('--passes='))
const PASSES = passesArg ? Number.parseInt(passesArg.slice('--passes='.length), 10) : 3

function log(message) {
  process.stdout.write(`${message}\n`)
}

function runNode(script, args = []) {
  execFileSync(process.execPath, [join(ROOT, 'scripts', script), ...args], {
    cwd: ROOT,
    stdio: 'inherit',
    timeout: 900000
  })
}

/** 启动一次应用并取回该趟报告 */
async function runPass(passNumber) {
  const resultDir = mkdtempSync(join(tmpdir(), `worklife-verify-p${passNumber}-`))
  const resultFile = join(resultDir, 'report.json')
  // 验收里"清空前自动导出"这一步的落点。
  // 必须显式指定：否则每跑一次验收就往真实桌面丢一份备份文件（实测攒了 39 个）。
  const exportDir = join(ROOT, 'logs', 'diagnostics')
  mkdirSync(exportDir, { recursive: true })

  const child = spawn(electronExe, ['.'], {
    cwd: ROOT,
    stdio: ['ignore', 'inherit', 'inherit'],
    windowsHide: true,
    env: {
      ...process.env,
      WORKLIFE_VERIFY: '1',
      WORKLIFE_VERIFY_PASS: String(passNumber),
      WORKLIFE_VERIFY_RESULT: resultFile,
      WORKLIFE_EXPORT_DIR: exportDir
    }
  })

  const exit = await new Promise((resolvePromise) => {
    // 不看门狗：进程跑多久就等多久，要不要中断由使用者自己决定（Ctrl+C）。
    child.on('exit', (code) => {
      resolvePromise({ code })
    })
    child.on('error', (error) => {
      log(`      启动失败：${error.message}`)
      resolvePromise({ code: null, error: error.message })
    })
  })

  let report = null
  if (existsSync(resultFile)) {
    try {
      report = JSON.parse(readFileSync(resultFile, 'utf8'))
    } catch (error) {
      log(`      报告解析失败：${error.message}`)
    }
  }
  rmSync(resultDir, { recursive: true, force: true })
  return { report, exit }
}

// ---- 1) 构建 ----
if (!skipBuild) {
  log('[1/4] 构建应用')
  runNode('build.mjs')
} else {
  log('[1/4] 跳过构建')
}

if (!existsSync(join(ROOT, 'out', 'main', 'index.js'))) {
  log('失败：构建产物不存在，请先执行 node scripts/build.mjs')
  process.exit(1)
}
if (!existsSync(electronExe)) {
  log(`失败：找不到 Electron 运行时 ${electronExe}`)
  process.exit(1)
}

// ---- 2) 端口基线 ----
log('[2/4] 记录端口基线')
runNode('port-check.mjs', ['before'])

// ---- 3) 分趟运行 ----
log(`[3/4] 分 ${PASSES} 趟启动应用并运行验收场景`)
const allChecks = []
let hardFailure = null
let stageLabel = ''
let env = null

for (let pass = 1; pass <= PASSES; pass += 1) {
  log(`      第 ${pass}/${PASSES} 趟…`)
  const { report, exit } = await runPass(pass)

  if (!report) {
    hardFailure = `第 ${pass} 趟没有产出报告（退出码 ${exit.code ?? '未知'}）`
    break
  }

  stageLabel = report.stage
  env = { electron: report.electron, chrome: report.chrome, node: report.node, appRoot: report.appRoot }
  for (const check of report.checks) {
    allChecks.push({ ...check, pass })
  }

  const failed = report.checks.filter((check) => !check.passed)
  log(`          ${report.passed}/${report.total} 项通过`)
  if (failed.length > 0) {
    for (const check of failed) log(`          失败：${check.id} ${check.name}`)
  }
}

// ---- 4) 汇总 ----
const passed = allChecks.filter((check) => check.passed).length
const failed = allChecks.length - passed
const summary = {
  stage: stageLabel || '未知阶段',
  appRoot: env?.appRoot ?? '',
  electron: env?.electron ?? '',
  chrome: env?.chrome ?? '',
  node: env?.node ?? '',
  finishedAt: new Date().toISOString(),
  passes: PASSES,
  total: allChecks.length,
  passed,
  failed,
  checks: allChecks
}
writeFileSync(REPORT_FILE, JSON.stringify(summary, null, 2), 'utf8')
copyFileSync(REPORT_FILE, join(ROOT, 'logs', `verify-report-${Date.now()}.json`))

log('')
log('[4/4] 验证结果')
if (env) {
  log(`阶段：${summary.stage}`)
  log(`环境：Electron ${env.electron} / Chromium ${env.chrome} / Node ${env.node}`)
  log(`数据根目录：${env.appRoot}`)
}
log('')
for (const check of allChecks) {
  const mark = check.passed ? '通过' : '失败'
  log(`  [${mark}] 第${check.pass}趟 ${check.id} (PRD ${check.prd}) ${check.name}`)
  if (check.detail) log(`         ${check.detail}`)
}
log('')
if (hardFailure) log(`致命问题：${hardFailure}`)
log(`合计：${passed}/${allChecks.length} 项通过，${failed} 项失败`)
log(`报告文件：${REPORT_FILE}`)

process.exit(hardFailure || failed > 0 ? 1 : 0)
