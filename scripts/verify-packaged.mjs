/**
 * 打包产物验收启动器（DEVPLAN 阶段 7）
 *
 * 用 release 目录里的"工作生活.exe"跑与开发态同一套验收场景，
 * 证明打包后的程序同样能开窗、能读写数据、能备份、能导出导入。
 *
 * 与 scripts/verify.mjs 的区别：那个跑的是开发目录里的 electron + out/，
 * 这个跑的是真正交付给你的可执行文件。
 *
 * 用法：node scripts/verify-packaged.mjs [--exe=<路径>] [--passes=3]
 */
import { spawn } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const ROOT = resolve(import.meta.dirname, '..')

function log(message) {
  process.stdout.write(`${message}\n`)
}

// 找到最新的打包目录
const packDirArg = process.argv.find((arg) => arg.startsWith('--exe='))
let exePath = packDirArg ? packDirArg.slice('--exe='.length) : null

if (!exePath) {
  const candidates = readdirSync(ROOT, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name.startsWith('pack-'))
    .map((entry) => entry.name)
    .sort()
    .reverse()
  for (const dir of candidates) {
    const candidate = join(ROOT, dir, 'win-unpacked', '工作生活.exe')
    if (existsSync(candidate)) {
      exePath = candidate
      break
    }
  }
}

if (!exePath || !existsSync(exePath)) {
  log('失败：找不到打包后的可执行文件（请先运行 node scripts/package.mjs）')
  process.exit(1)
}

const passesArg = process.argv.find((arg) => arg.startsWith('--passes='))
const PASSES = passesArg ? Number.parseInt(passesArg.slice('--passes='.length), 10) : 3

log(`打包产物：${exePath}`)

/** 启动一次打包后的应用 */
async function runPass(passNumber) {
  const resultDir = mkdtempSync(join(tmpdir(), `worklife-pkg-p${passNumber}-`))
  const resultFile = join(resultDir, 'report.json')
  // 与 verify.mjs 同理：清空前的自动导出必须指到工作区，不能污染真实桌面
  const exportDir = join(ROOT, 'logs', 'diagnostics')
  mkdirSync(exportDir, { recursive: true })

  const child = spawn(exePath, [], {
    cwd: ROOT,
    stdio: ['ignore', 'inherit', 'inherit'],
    windowsHide: true,
    env: {
      ...process.env,
      WORKLIFE_VERIFY: '1',
      WORKLIFE_VERIFY_PASS: String(passNumber),
      WORKLIFE_VERIFY_RESULT: resultFile,
      WORKLIFE_EXPORT_DIR: exportDir,
      // 打包后默认数据放 %APPDATA%；这里显式指定到工作区，
      // 既验证了 WORKLIFE_ROOT 这条便携路径可用，也让验收数据看得见。
      WORKLIFE_ROOT: ROOT
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

const all = []
let hardFailure = null
let env = null

log(`分 ${PASSES} 趟运行打包后的应用`)
for (let pass = 1; pass <= PASSES; pass += 1) {
  log(`      第 ${pass}/${PASSES} 趟…`)
  const { report, exit } = await runPass(pass)
  if (!report) {
    hardFailure = `第 ${pass} 趟没有产出报告（退出码 ${exit.code ?? '未知'}）`
    break
  }
  env = report
  for (const check of report.checks) all.push({ ...check, pass })
  log(`          ${report.passed}/${report.total} 项通过`)
  for (const check of report.checks.filter((c) => !c.passed)) {
    log(`          失败：${check.id} ${check.name}`)
  }
}

const passed = all.filter((check) => check.passed).length
const failed = all.length - passed

const summary = {
  source: 'packaged',
  exe: exePath,
  passCount: PASSES,
  appRoot: env?.appRoot ?? '',
  electron: env?.electron ?? '',
  chrome: env?.chrome ?? '',
  node: env?.node ?? '',
  finishedAt: new Date().toISOString(),
  total: all.length,
  passed,
  failed,
  checks: all
}
writeFileSync(join(ROOT, 'logs', 'verify-packaged.json'), JSON.stringify(summary, null, 2), 'utf8')

log('')
log('==== 打包产物验收结果 ====')
if (env) {
  log(`环境：Electron ${env.electron} / Chromium ${env.chrome} / Node ${env.node}`)
  log(`数据根目录：${env.appRoot}`)
}
log('')
for (const check of all) {
  const mark = check.passed ? '通过' : '失败'
  log(`  [${mark}] 第${check.pass}趟 ${check.id} (PRD ${check.prd}) ${check.name}`)
  if (check.detail) log(`         ${check.detail}`)
}
log('')
if (hardFailure) log(`致命问题：${hardFailure}`)
log(`合计：${passed}/${all.length} 项通过，${failed} 项失败`)
log('报告文件：logs\\verify-packaged.json')

process.exit(hardFailure || failed > 0 ? 1 : 0)
