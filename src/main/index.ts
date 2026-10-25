/**
 * 主进程入口（DEVPLAN 阶段 0-1）
 *
 * 顺序：解析根目录 → 建目录 → 写日志 → Chromium 开关 → 单实例锁
 *       → 初始化数据层（自检 + 每日备份）→ 装安全策略 → 注册 IPC → 开窗口
 * 全程不监听任何网络端口。
 */
import { app, BrowserWindow, session, dialog, ipcMain } from 'electron'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { currentAppRoot } from './appRoot'
import { createAppData } from './data'
import { createLogger } from './data/logger'
import { ensureDataDirs, resolveDataPaths } from './data/paths'
import { savePortSnapshot } from './diagnostics/ports'
import { installSessionSecurity } from './security'
import { registerDataIpc } from './ipc'
import { runVerificationScenarios } from './verify/runner'
import { createMainWindow } from './window'

// 打包后数据放 %APPDATA%\工作生活；开发态放项目根；WORKLIFE_ROOT 可覆盖（便携模式）
const appRoot = currentAppRoot(app.isPackaged, app.getPath('userData'))
const paths = resolveDataPaths({ appRoot })
ensureDataDirs(paths)

/**
 * 把 Chromium 自己的运行期目录也钉到应用根内（PRD K3：数据只出现在应用根下）。
 *
 * 为什么必须显式设置：app.getPath('userData') 默认取"应用名"，
 * 打包产物的 package.json 里 name 是 work-life-app，于是 Chromium 会把
 * Preferences / Local Storage / Cache / Network 等写到
 * %APPDATA%\work-life-app\ —— 落在应用根之外，与 K3 的说法冲突（实测 2.9 MB）。
 *
 * 时机：必须在 whenReady 之前调用，否则 Chromium 已经按旧路径建好目录了。
 * 该调用在 ready 前可用（已实测）。
 */
app.setPath('userData', join(paths.root, '.runtime'))

const logger = createLogger({ filePath: paths.logFile })

/**
 * Chromium 开关。
 *
 * 本程序是单机本地应用，不需要 GPU 加速、崩溃上报和后台网络活动。
 * 关掉这些既符合"不联网、数据不出本机"的产品要求，也降低受限环境下的初始化风险。
 */
app.disableHardwareAcceleration()
app.commandLine.appendSwitch('disable-crash-reporter')
app.commandLine.appendSwitch('disable-breakpad')
app.commandLine.appendSwitch('no-default-browser-check')
app.commandLine.appendSwitch('disable-background-networking')
app.commandLine.appendSwitch('disable-component-update')
app.commandLine.appendSwitch('disable-domain-reliability')
app.commandLine.appendSwitch('disable-sync')
app.commandLine.appendSwitch('metrics-recording-only')
app.commandLine.appendSwitch('no-first-run')

/** 开发态渲染进程地址（若由开发服务器提供） */
const rendererDevUrl = process.env['ELECTRON_RENDERER_URL']
/** 生产态直接加载本地文件 */
const rendererFile = join(__dirname, '..', 'renderer', 'index.html')

let mainWindow: BrowserWindow | null = null
/** 数据层持有的引用，供退出前强制落盘使用 */
let appData: ReturnType<typeof createAppData> | null = null

/** 冒烟模式：把结果写到文件，供无人值守的测试脚本判定 */
function writeSmokeResult(exitCode: number): void {
  const resultFile = process.env['WORKLIFE_SMOKE_RESULT']
  if (!resultFile) return
  try {
    writeFileSync(resultFile, JSON.stringify({ exitCode, at: new Date().toISOString() }), 'utf8')
  } catch (error) {
    logger.warn('smoke-result-write-failed', error)
  }
}

function focusExistingWindow(): void {
  if (!mainWindow) return
  if (mainWindow.isMinimized()) mainWindow.restore()
  mainWindow.show()
  mainWindow.focus()
}

// ---- 单实例锁（对应 PRD A4：二次双击图标不再开第二个窗口）----
const gotTheLock = app.requestSingleInstanceLock()
if (!gotTheLock) {
  logger.info('second-instance-blocked')
  app.quit()
} else {
  app.on('second-instance', () => {
    logger.info('second-instance-focused')
    focusExistingWindow()
  })

  void app.whenReady().then(async () => {
    logger.info('app-ready', {
      appRoot: paths.root,
      // 记下 Chromium 运行期目录，便于核对"是否还有东西落在应用根之外"
      chromiumUserData: app.getPath('userData'),
      packaged: app.isPackaged,
      electron: process.versions.electron,
      chrome: process.versions.chrome
    })

    // 数据层：启动自检 + 每日备份，全部在开窗之前完成
    appData = createAppData({
      paths,
      appVersion: app.getVersion(),
      logger
    })

    // 安全策略必须在创建窗口之前装好
    installSessionSecurity(session.defaultSession)

    // 界面能拿到的环境信息与数据接口
    ipcMain.handle('app:environment', () => ({
      appRoot: paths.root,
      appVersion: app.getVersion(),
      platform: process.platform,
      isPackaged: app.isPackaged
    }))
    registerDataIpc({ appData, logger, getWindow: () => mainWindow })

    // 记录启动时刻的端口快照，作为"不新增监听端口"的可检查证据
    let snapshotFile: string | null = null
    try {
      snapshotFile = savePortSnapshot(paths.diagnostics, 'after-start')
      logger.info('port-snapshot-saved', { file: snapshotFile })
    } catch (error) {
      logger.warn('port-snapshot-failed', error)
    }

    // 验证模式与冒烟模式都不自动显示窗口（避免自动流程抢焦点）
    const verifyMode = process.env['WORKLIFE_VERIFY'] === '1'
    mainWindow = createMainWindow({ rendererDevUrl, rendererFile, show: !verifyMode })

    mainWindow.on('closed', () => {
      mainWindow = null
    })

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) {
        mainWindow = createMainWindow({ rendererDevUrl, rendererFile })
      } else {
        focusExistingWindow()
      }
    })

    // ---- 验证模式：无人值守跑完整套场景并输出报告 ----
    if (verifyMode) {
      const resultFile = process.env['WORKLIFE_VERIFY_RESULT']
      const passNumber = Number.parseInt(process.env['WORKLIFE_VERIFY_PASS'] ?? '1', 10)
      const result = await runVerificationScenarios({
        window: mainWindow,
        paths,
        logger,
        appData,
        snapshotFile,
        rendererFile,
        rendererDevUrl,
        appRoot,
        passNumber: Number.isInteger(passNumber) ? passNumber : 1
      })
      if (resultFile) {
        try {
          writeFileSync(resultFile, JSON.stringify(result, null, 2), 'utf8')
        } catch (error) {
          logger.error('verify-result-write-failed', error)
        }
      }
      appData.flushAll()
      app.exit(result.failed === 0 ? 0 : 1)
      return
    }

    // ---- 冒烟模式：开窗后立即退出 ----
    if (process.env['WORKLIFE_SMOKE'] === '1') {
      logger.info('smoke-mode-window-created')
      writeSmokeResult(0)
      setTimeout(() => app.quit(), 300)
    }
  })

  app.on('window-all-closed', () => {
    app.quit()
  })

  // 退出前强制落盘：绝不允许把改动留在内存里就走人
  app.on('before-quit', () => {
    logger.info('app-before-quit')
    try {
      appData?.flushAll()
    } catch (error) {
      logger.error('flush-on-quit-failed', error)
    }
  })

  process.on('uncaughtException', (error) => {
    logger.error('uncaught-exception', error)
    void dialog.showErrorBox('工作生活 · 发生错误', String(error))
  })

  process.on('unhandledRejection', (reason) => {
    logger.error('unhandled-rejection', reason)
  })
}
