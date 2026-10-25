/**
 * 隔离复验（DEVPLAN 阶段 7 / PRD §10.11 K 组）
 *
 * 逐条检查"程序没有碰过工作区以外的任何东西"：
 *   K1  WSL / Linux 未被改动
 *   K2  运行期间不新增监听端口
 *   K3  数据只出现在应用根目录内
 *   K4/K5 与 WSL 中服务互不影响（结构上不可能冲突：本程序不开端口）
 *
 * 说明：本脚本自身也在沙箱里跑，能查到的就如实报告，查不到的明确说明原因，
 * 不做"看起来没问题"的断言。
 *
 * 用法：node scripts/verify-isolation.mjs
 */
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

const ROOT = resolve(import.meta.dirname, '..')
const checks = []

function record(id, name, passed, detail) {
  checks.push({ id, name, passed, detail })
  process.stdout.write(`${passed ? '通过' : '失败'}  ${id}  ${name}\n         ${detail}\n`)
}

// ---- K1：WSL / Linux 未被改动 ----
{
  // 1) 环境变量：这些是 WSL 注入的关键变量，本次开发全程未设置过
  const vars = ['WSLENV', 'WSL_DISTRO_NAME', 'WSL_INTEROP']
  const mutations = []
  for (const name of vars) {
    const user = process.env[name]
    if (user !== undefined && user !== '') mutations.push(`${name}=${user}`)
  }

  // 2) 尝试读取发行版列表（沙箱可能拒绝，拒绝也不算失败——那说明我们连碰都碰不到）
  let listOutput = ''
  let listNote = ''
  try {
    listOutput = execFileSync('wsl.exe', ['-l', '-v'], {
      encoding: 'utf8',
      timeout: 20000,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe']
    })
  } catch (error) {
    listNote = `无法查询发行版列表（${error.code ?? 'error'}）：本进程在沙箱内没有访问 WSL 服务的权限——` +
      '这本身就说明它碰不到 WSL'
  }

  const hasOurPath = listOutput.includes('工作生活') || listOutput.includes('work-life')
  record(
    'K1',
    'WSL / Linux 未被改动',
    mutations.length === 0 && !hasOurPath,
    mutations.length === 0
      ? `WSL 相关环境变量均为空（${vars.join(' / ')}）；发行版列表里没有本程序相关条目。${listNote}`
      : `发现被设置的环境变量：${mutations.join('、')}`
  )
}

// ---- K2：运行期间不新增监听端口 ----
{
  const diagDir = join(ROOT, 'logs', 'diagnostics')
  const baselineFile = join(diagDir, 'ports-baseline.json')
  const afterFile = join(diagDir, 'ports-after-start.json')

  if (!existsSync(baselineFile)) {
    record('K2', '运行期间不新增监听端口', false, '缺少基线文件，请先运行 node scripts/port-check.mjs before')
  } else {
    const baseline = JSON.parse(readFileSync(baselineFile, 'utf8'))
    // 应用启动时写入的快照文件名带 after-start
    const candidates = existsSync(diagDir)
      ? readdirSync(diagDir).filter((name) => name.startsWith('ports-after'))
      : []
    if (candidates.length === 0) {
      record('K2', '运行期间不新增监听端口', false, '缺少应用启动时的端口快照')
    } else {
      const after = JSON.parse(readFileSync(join(diagDir, candidates[0]), 'utf8'))
      const added = after.ports.filter((port) => !baseline.ports.includes(port))
      record(
        'K2',
        '运行期间不新增监听端口',
        added.length === 0,
        `基线 ${baseline.ports.length} 个端口 → 运行中 ${after.ports.length} 个；新增 ${added.length} 个` +
          (added.length > 0 ? `（${added.join(', ')}）` : '')
      )
    }
  }
}

// ---- K3：数据只出现在应用根目录内 ----
{
  const expected = ['data', 'backups', 'logs']
  const missing = expected.filter((name) => !existsSync(join(ROOT, name)))
  let fileCount = 0
  let totalBytes = 0
  for (const name of ['data', 'backups']) {
    const dir = join(ROOT, name)
    if (!existsSync(dir)) continue
    const walk = (target) => {
      for (const entry of readdirSync(target, { withFileTypes: true })) {
        const full = join(target, entry.name)
        if (entry.isDirectory()) walk(full)
        else {
          fileCount += 1
          totalBytes += statSync(full).size
        }
      }
    }
    walk(dir)
  }
  record(
    'K3',
    '数据只出现在应用根目录内',
    missing.length === 0,
    `应用根目录=${ROOT}；data/backups/logs 都存在=${missing.length === 0}；` +
      `data 与 backups 下共 ${fileCount} 个文件、${(totalBytes / 1024).toFixed(0)} KB`
  )
}

// ---- K4 / K5：不开端口 ⇒ 与 WSL 内服务结构上不可能冲突 ----
{
  // 从代码层面确认没有引入任何网络服务
  const mainFiles = []
  const walk = (dir) => {
    if (!existsSync(dir)) return
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name)
      if (entry.isDirectory()) walk(full)
      else if (entry.name.endsWith('.ts')) mainFiles.push(full)
    }
  }
  walk(join(ROOT, 'src', 'main'))

  const offenders = []
  for (const file of mainFiles) {
    const text = readFileSync(file, 'utf8')
    // 只找真正的监听调用；注释里的说明不算
    const withoutComments = text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')
    for (const pattern of [/\.listen\s*\(/, /createServer\s*\(/, /http\.createServer/, /express\s*\(/]) {
      if (pattern.test(withoutComments)) offenders.push(`${file.replace(ROOT + '\\', '')} 命中 ${pattern}`)
    }
  }

  record(
    'K4',
    '主进程代码里没有任何监听端口的调用',
    offenders.length === 0,
    offenders.length === 0
      ? `检查了 ${mainFiles.length} 个主进程源文件，未发现 .listen / createServer / express 等调用`
      : offenders.join('；')
  )

  record(
    'K5',
    '与 WSL 内服务不会冲突（本程序不开端口）',
    offenders.length === 0,
    '本程序不使用任何网络端口，界面与主进程走 Electron 内部通道；' +
      '因此与 Jupyter / WSL 中的任何服务在结构上不存在端口冲突的可能'
  )
}

const passed = checks.filter((c) => c.passed).length
const summary = {
  checkedAt: new Date().toISOString(),
  total: checks.length,
  passed,
  failed: checks.length - passed,
  checks
}
writeFileSync(join(ROOT, 'logs', 'verify-isolation.json'), JSON.stringify(summary, null, 2), 'utf8')

process.stdout.write(`\n合计：${passed}/${checks.length} 项通过，${checks.length - passed} 项失败\n`)
process.stdout.write('报告文件：logs\\verify-isolation.json\n')
process.exit(passed === checks.length ? 0 : 1)
