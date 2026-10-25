/**
 * 阶段 0 验收检查（DEVPLAN 阶段 0 / PRD §10.3 C4 之外的基础项）
 *
 * 覆盖：窗口能开、界面真的渲染出来、IPC 通道通、安全策略生效、无监听端口、
 *       单实例锁生效（第二个实例被拒绝）。
 */
import { spawn } from 'node:child_process'
import type { BrowserWindow } from 'electron'
import type { VerifyCheck, VerifyContext } from './runner'

type Recorder = (check: VerifyCheck) => void

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** 等待窗口加载完成，最长 timeout 毫秒 */
async function waitForLoad(win: BrowserWindow, timeout = 15000): Promise<boolean> {
  if (!win.webContents.isLoading()) return true
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), timeout)
    win.webContents.once('did-finish-load', () => {
      clearTimeout(timer)
      resolve(true)
    })
    win.webContents.once('did-fail-load', () => {
      clearTimeout(timer)
      resolve(false)
    })
  })
}

export async function runPhase0Checks(context: VerifyContext, record: Recorder): Promise<void> {
  const { window: win, paths } = context

  // ---- 1. 主窗口已创建 ----
  record({
    id: 'P0-1',
    prd: 'L2',
    name: '主窗口已创建',
    passed: !win.isDestroyed(),
    detail: win.isDestroyed() ? '窗口对象已销毁' : '窗口对象可用'
  })

  // ---- 2. 界面加载并渲染成功 ----
  const loaded = await waitForLoad(win)
  let title = ''
  let rootHtmlLength = 0
  if (loaded) {
    try {
      const probe = (await win.webContents.executeJavaScript(
        `(() => { const el = document.getElementById('root'); return { title: document.title, len: el ? el.innerHTML.length : -1 } })()`
      )) as { title: string; len: number }
      title = probe.title
      rootHtmlLength = probe.len
    } catch (error) {
      record({
        id: 'P0-2',
        prd: 'L2',
        name: '界面加载并渲染',
        passed: false,
        detail: `渲染进程探测失败：${String(error)}`
      })
    }
  }
  record({
    id: 'P0-2',
    prd: 'L2',
    name: '界面加载并渲染',
    passed: loaded && rootHtmlLength > 0,
    detail: loaded
      ? `标题="${title}"，#root 内容长度=${rootHtmlLength}`
      : '窗口未在 15 秒内完成加载'
  })

  // ---- 3. 窗口可见性与尺寸 ----
  // 无人值守时窗口不会自动显示，这里主动调用 showInactive：
  // 既不抢焦点，又能真实检验"窗口能被显示出来"这条要求。
  if (!win.isVisible()) {
    win.showInactive()
    // 等待系统真正把窗口标记为可见，最多 5 秒
    for (let attempt = 0; attempt < 50 && !win.isVisible(); attempt += 1) {
      await wait(100)
    }
  }
  const [width, height] = win.getSize()
  record({
    id: 'P0-3',
    prd: 'L2',
    name: '窗口可见且有合理尺寸',
    passed: win.isVisible() && width >= 1024 && height >= 680,
    detail: `visible=${win.isVisible()} size=${width}x${height}`
  })

  // ---- 4. IPC 通道（预加载 → 主进程 → 返回）----
  let envResult: { appRoot?: string; appVersion?: string } | null = null
  let ipcError: string | null = null
  try {
    envResult = (await win.webContents.executeJavaScript(
      'window.api.getEnvironment()'
    )) as { appRoot?: string; appVersion?: string }
  } catch (error) {
    ipcError = String(error)
  }
  record({
    id: 'P0-4',
    prd: 'K3',
    name: '预加载 IPC 通道可用且返回正确根目录',
    passed: !!envResult && envResult.appRoot === paths.root,
    detail: ipcError
      ? `调用失败：${ipcError}`
      : `返回 appRoot=${envResult?.appRoot}（期望 ${paths.root}）version=${envResult?.appVersion}`
  })

  // ---- 5. 权限申请被拒绝 ----
  let permissionGranted: boolean | null = null
  try {
    permissionGranted = await win.webContents.executeJavaScript(
      `navigator.permissions.query({ name: 'geolocation' }).then(r => r.state === 'granted').catch(() => false)`
    )
  } catch {
    permissionGranted = false
  }
  record({
    id: 'P0-5',
    prd: 'K2',
    name: '系统权限申请被拒绝',
    passed: permissionGranted === false,
    detail: `geolocation 是否被授予=${permissionGranted}`
  })

  // ---- 6. 外部网络请求被拦截 ----
  let fetchOutcome = ''
  try {
    fetchOutcome = (await win.webContents.executeJavaScript(
      `fetch('https://registry.npmmirror.com/electron').then(() => 'RESOLVED').catch(e => 'REJECTED:' + (e && e.message ? e.message : 'unknown'))`
    )) as string
  } catch (error) {
    fetchOutcome = `REJECTED:${String(error)}`
  }
  record({
    id: 'P0-6',
    prd: 'K2',
    name: '渲染进程无法发起外部网络请求',
    passed: fetchOutcome.startsWith('REJECTED'),
    detail: `fetch 结果=${fetchOutcome.slice(0, 160)}`
  })

  // ---- 7. 单实例锁：第二个实例被拒绝并聚焦已有窗口 ----
  const secondInstance = await runSecondInstanceProbe()
  record({
    id: 'P0-7',
    prd: 'A4',
    name: '第二个实例被拒绝（单实例锁生效）',
    passed: secondInstance.ok,
    detail: secondInstance.detail
  })
}

/**
 * 启动第二个 Electron 实例，验证它会被单实例锁挡住并且自己退出。
 * 第一个实例会收到 second-instance 事件。
 */
async function runSecondInstanceProbe(): Promise<{ ok: boolean; detail: string }> {
  const exe = process.execPath
  const second = spawn(exe, ['.'], {
    stdio: ['ignore', 'ignore', 'ignore'],
    windowsHide: true,
    env: { ...process.env, WORKLIFE_SECOND_INSTANCE_PROBE: '1' }
  })

  const outcome = await new Promise<{ code: number | null; timedOut: boolean }>((resolve) => {
    const timer = setTimeout(() => {
      second.kill()
      resolve({ code: null, timedOut: true })
    }, 20000)
    second.on('exit', (code) => {
      clearTimeout(timer)
      resolve({ code, timedOut: false })
    })
    second.on('error', () => {
      clearTimeout(timer)
      resolve({ code: null, timedOut: false })
    })
  })

  await wait(400)

  if (outcome.timedOut) {
    return { ok: false, detail: '第二个实例 20 秒内没有自行退出（可能未被锁挡住）' }
  }
  if (outcome.code !== 0) {
    return { ok: false, detail: `第二个实例退出码 ${outcome.code}（期望 0）` }
  }
  return { ok: true, detail: `第二个实例被拒绝并自行退出（退出码 ${outcome.code}）` }
}
