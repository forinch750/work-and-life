/**
 * 验证台上下文与报告结构（DEVPLAN 各阶段通用）
 *
 * 为什么需要它：本机沙箱禁止 Chromium 的多进程通信（命名管道），
 * Electron 只能在完整访问权限下启动。为了让"运行验证"这件事开销最小，
 * 这里把一整个阶段的验收项做成一次性跑完并输出机器可读报告的形式，
 * 每次验证只需启动一次应用。
 */
import type { BrowserWindow } from 'electron'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { AppData } from '../data'
import type { DataPaths } from '../data/paths'
import type { Logger } from '../data/logger'
import { runPhase0Checks } from './phase0'
import { runPhase1Checks } from './phase1'
import { runPhase2Checks } from './phase2'
import { runPhase3Checks } from './phase3'
import { runPhase4Checks } from './phase4'
import { runPhase5Checks } from './phase5'
import { runPhase6Checks } from './phase6'
import { runPhase7Checks } from './phase7'
import { runPhase8Checks } from './phase8'

export interface VerifyContext {
  window: BrowserWindow
  paths: DataPaths
  logger: Logger
  appData: AppData
  appRoot: string
  /** 启动时写入的端口快照文件 */
  snapshotFile: string | null
  rendererFile: string
  rendererDevUrl?: string
  /** 允许的端口豁免（默认无） */
  ignorePorts?: number[]
  /**
   * 第几趟验收。
   *   1 = 只做非破坏性检查，并把退出时的数据状态写入交接文件
   *   2 = 完整检查（含"导出→清空→导入"这类破坏性步骤），并写下新的交接文件
   *   3 = 只做"重启后数据还在"的核对
   * 之所以分趟：破坏性步骤会抹掉当次数据，只有跨两趟才能真正验证持久化。
   */
  passNumber?: number
}

/**
 * 跨启动交接文件。
 *
 * 为什么需要：验收里有一项是"导出 → 清空 → 导入"，其中"清空"是真实的破坏性操作，
 * 会把当次运行的数据抹掉。为了仍然能验证"关掉再打开数据还在"这条最核心的要求，
 * 这里把"退出时的数据快照"写盘，下一趟启动时比对。
 *
 * 路径写在 logs\diagnostics\ 下，不属于用户数据。
 */
export interface HandoffSnapshot {
  runAt: string
  pass: number
  memoAlive: number
  memoAll: number
  /** 本趟运行是否做过破坏性操作（清空/导入覆盖） */
  destructive: boolean
  totalRecords: number
}

export function handoffFilePath(paths: DataPaths): string {
  return join(paths.diagnostics, 'verify-handoff.json')
}

export function readHandoff(paths: DataPaths): HandoffSnapshot | null {
  const file = handoffFilePath(paths)
  if (!existsSync(file)) return null
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as HandoffSnapshot
  } catch {
    return null
  }
}

export function writeHandoff(paths: DataPaths, snapshot: HandoffSnapshot): void {
  try {
    writeFileSync(handoffFilePath(paths), JSON.stringify(snapshot, null, 2), 'utf8')
  } catch {
    /* 交接文件写不进去不该影响验收本身 */
  }
}

export interface VerifyCheck {
  id: string
  /** 对应 PRD 验收编号，便于回溯 */
  prd: string
  name: string
  passed: boolean
  detail?: string
}

export interface VerifyReport {
  stage: string
  appRoot: string
  electron: string
  chrome: string
  node: string
  startedAt: string
  finishedAt: string
  total: number
  passed: number
  failed: number
  checks: VerifyCheck[]
}

/**
 * 对比"启动前基线"与"启动后快照"，确认运行期间没有新增监听端口。
 * 允许端口减少（别的程序自己关掉了），只把"新增"判为失败。
 */
export function comparePortSnapshot(context: VerifyContext): VerifyCheck {
  const baselineFile = join(context.paths.diagnostics, 'ports-baseline.json')
  const check: VerifyCheck = {
    id: 'PORT',
    prd: 'K2',
    name: '运行期间未新增监听端口',
    passed: false
  }

  if (!context.snapshotFile) {
    check.detail = '启动时没有生成端口快照'
    return check
  }
  if (!existsSync(baselineFile)) {
    check.detail = `缺少基线文件 ${baselineFile}，请先运行：node scripts/port-check.mjs before`
    return check
  }

  try {
    const baseline = JSON.parse(readFileSync(baselineFile, 'utf8')) as { ports: number[] }
    const after = JSON.parse(readFileSync(context.snapshotFile, 'utf8')) as { ports: number[] }
    const ignore = new Set(context.ignorePorts ?? [])
    const added = after.ports.filter((port) => !baseline.ports.includes(port) && !ignore.has(port))
    check.passed = added.length === 0
    check.detail = `基线 ${baseline.ports.length} 个 → 运行中 ${after.ports.length} 个；新增 ${added.length} 个${
      added.length ? `（${added.join(', ')}）` : ''
    }`
  } catch (error) {
    check.detail = `读取端口快照失败：${String(error)}`
  }
  return check
}

export async function runVerificationScenarios(context: VerifyContext): Promise<VerifyReport> {
  const startedAt = new Date().toISOString()
  const passNumber = context.passNumber ?? 2
  const checks: VerifyCheck[] = []

  /**
   * 把渲染进程的报错写进 app.log。
   *
   * 为什么需要：`webContents.executeJavaScript` 失败时给出的只是一句
   * "Script failed to execute, this normally means an error was thrown"，
   * **不带表达式、也不带真正的错误**。没有这层记录就只能靠猜
   * （第 04 块就撞到过一次：学习页新建主题的输入框在一次验收里凭空消失，
   * 报告里只有一个空泛的报错，完全定不了位）。
   */
  context.window.webContents.on('console-message', (event) => {
    if (event.level === 'error') {
      context.logger.error('renderer-console', { message: String(event.message).slice(0, 1200) })
    }
  })

  /** 导出验收用的落点：无人值守时通过参数指定，绕开系统保存对话框 */
  const exportFile = join(context.paths.diagnostics, `verify-export-pass${passNumber}.json`)

  const record = (check: VerifyCheck): void => {
    checks.push(check)
    context.logger.info('verify-check', {
      id: check.id,
      passed: check.passed,
      detail: check.detail
    })
  }

  // 端口对比要赶在"第二个实例探针"之前完成，避免被探针干扰
  record(comparePortSnapshot(context))

  let destructive = false
  if (passNumber >= 3) {
    // 第 3 趟：只核对"上一趟退出时的数据，这一趟打开后还在不在"。
    // 这一趟刻意不做任何写入——否则验的就不是"重启后还在"，而是"刚刚写进去"。
    record(restartCheck(context))
  } else {
    // 顺序很重要：数据检查必须在前。
    // 阶段 1 要读"启动时加载了什么"，阶段 2/3/4 会通过界面写数据，
    // 先跑它们会把启动状态改掉，那条判据就失效了。
    await runPhase0Checks(context, record)
    const outcome = await runPhase1Checks(context, record, passNumber === 1)
    destructive = outcome.destructive
    await runPhase2Checks(context, record)
    await runPhase4Checks(context, record, passNumber)
    await runPhase5Checks(context, record, passNumber)
    await runPhase6Checks(context, record, passNumber)
    // 阶段 7（回收站）放在阶段 3 之前：
    // 它的最后一项会执行"清空全部数据"，那会把数据抹掉；
    // 而阶段 3 里也有清空与导入，所以回收站必须先跑，否则它造的数据会被清掉。
    await runPhase7Checks(context, record, passNumber)
    // 阶段 8（树界面与接入）放在阶段 3 之前：阶段 3 末尾会清空数据，
    // 而阶段 8 要跨检查项保留自己造的样本（同一趟里逐个核对层级与进度）
    await runPhase8Checks(context, record, passNumber)
    // 阶段 3 末尾会清空数据，因此放在最后，且只在第 2 趟（完整验收）执行
    if (passNumber === 2) {
      await runPhase3Checks(context, record, exportFile)
    }
  }

  // 把退出时的数据状态写盘，供下一趟启动比对。
  // 先强制落盘再取数：否则"内存里的数"可能还没到磁盘上，快照与磁盘会错位。
  context.appData.flushAll()
  writeHandoff(context.paths, {
    runAt: new Date().toISOString(),
    pass: passNumber,
    memoAlive: context.appData.module('memo').list().length,
    memoAll: context.appData.module('memo').all().length,
    destructive,
    totalRecords: context.appData.getStats().recordCount
  })
  context.appData.flushAll()

  const passed = checks.filter((check) => check.passed).length
  return {
    stage: `阶段 0-8 · 七大模块 + 回收站 + 树界面（第 ${passNumber} 趟）`,
    appRoot: context.paths.root,
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    node: process.versions.node,
    startedAt,
    finishedAt: new Date().toISOString(),
    total: checks.length,
    passed,
    failed: checks.length - passed,
    checks
  }
}

/**
 * 重启核对：上一趟退出时磁盘上的记录，这一趟启动后必须原样读到。
 * 这是 PRD A1/A2 最直接的证据。
 */
export function restartCheck(context: VerifyContext): VerifyCheck {
  const handoff = readHandoff(context.paths)
  const check: VerifyCheck = {
    id: 'P1-R',
    prd: 'A1',
    name: '重启后读回上次退出时的全部记录',
    passed: false
  }

  if (!handoff) {
    check.detail = '没有找到上一趟的交接快照，无法核对'
    return check
  }

  const loaded = context.appData.module('memo').all().length
  const startupInfo = context.appData.startup.find((item) => item.module === 'memo')
  const noRecovery = context.appData.startup.every(
    (item) => item.status !== 'corrupted' && item.status !== 'recovered-from-backup'
  )

  // 判据是"不丢"：重启后加载到的记录数不得少于上一趟退出时的数量
  const noLoss = loaded >= handoff.memoAll
  check.passed = noLoss && noRecovery
  check.detail = `上一趟（第 ${handoff.pass} 趟，${handoff.runAt}）退出时 ≥${handoff.memoAll} 条 → 本次启动加载 ${loaded} 条；无记录丢失=${noLoss}；自检状态=${startupInfo?.status ?? '未知'}；启动无损坏/无备份恢复=${noRecovery}`
  return check
}
