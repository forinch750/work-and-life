/**
 * 安全策略（DEVPLAN 阶段 0）
 *
 * 产品要求"不联网、数据不出本机"，所以这里做三件事：
 *   1. 拒绝一切权限申请（摄像头、麦克风、通知、地理位置……）
 *   2. 拦截一切非本地网络请求，只放行 file / data / blob / devtools
 *   3. 禁止渲染进程开新窗口、加载 webview
 *
 * 之所以把 Session 抽象成接口，是为了能在没有 Electron 运行时的测试里直接验证策略。
 */

/** Electron session 中本模块用到的部分 */
export interface PermissionRequestLike {
  permission: string
  requestingUrl?: string
}

export interface WebRequestLike {
  onBeforeRequest(
    filter: { urls: string[] },
    listener: (details: { url: string }, callback: (response: { cancel: boolean }) => void) => void
  ): void
}

export interface MessageBoxLike {
  showMessageBox(options: {
    type?: string
    title?: string
    message: string
    detail?: string
    buttons?: string[]
  }): Promise<{ response: number }>
}

export interface SessionLike {
  setPermissionRequestHandler(handler: ((...args: any[]) => void) | null): void
  setPermissionCheckHandler(handler: ((...args: any[]) => boolean) | null): void
  webRequest: WebRequestLike
}

export interface WindowLike {
  webContents: {
    setWindowOpenHandler(handler: (details: { url: string }) => { action: 'deny' | 'allow' }): void
    on(event: string, listener: (...args: any[]) => void): void
  }
}

/** 允许的协议：全部是本地协议，不存在对外请求 */
const ALLOWED_PROTOCOLS = ['file:', 'data:', 'blob:', 'devtools:']

/**
 * 判定一个 URL 是否为本地资源。
 * 只按协议白名单判定；http/https 一律视为外部请求并拦截。
 */
export function isLocalRendererUrl(rawUrl: string | undefined | null): boolean {
  if (!rawUrl) return false
  try {
    const parsed = new URL(rawUrl)
    return ALLOWED_PROTOCOLS.includes(parsed.protocol)
  } catch {
    return false
  }
}

/** 拒绝一切权限申请：本程序不需要任何系统能力 */
export function createPermissionRequestHandler(): (...args: any[]) => void {
  return (...args: any[]) => {
    const callback = args[args.length - 1]
    if (typeof callback === 'function') callback(false)
  }
}

/** 权限检查一律返回 false */
export function createPermissionCheckHandler(): (...args: any[]) => boolean {
  return () => false
}

/** 请求过滤器：只让本地资源通过 */
export function createRequestFilter(): (
  details: { url: string },
  callback: (response: { cancel: boolean }) => void
) => void {
  return (details, callback) => {
    callback({ cancel: !isLocalRendererUrl(details.url) })
  }
}

/**
 * 把安全策略装到 session 上。
 * 返回实际安装的处理器，便于测试直接调用断言。
 */
export function installSessionSecurity(session: SessionLike) {
  const permissionRequest = createPermissionRequestHandler()
  const permissionCheck = createPermissionCheckHandler()
  const requestFilter = createRequestFilter()

  session.setPermissionRequestHandler(permissionRequest)
  session.setPermissionCheckHandler(permissionCheck)
  session.webRequest.onBeforeRequest({ urls: ['*://*/*'] }, requestFilter)

  return { permissionRequest, permissionCheck, requestFilter }
}

/**
 * 把安全策略装到窗口上：禁止新窗口、禁止 webview 挂载、拦截站内跳转到外部地址。
 */
export function installWindowSecurity(win: WindowLike): void {
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  win.webContents.on('will-attach-webview', (event: any) => {
    if (event && typeof event.preventDefault === 'function') event.preventDefault()
  })
  win.webContents.on('will-navigate', (event: any, url: string) => {
    if (!isLocalRendererUrl(url) && event && typeof event.preventDefault === 'function') {
      event.preventDefault()
    }
  })
}

/**
 * 在窗口创建前就把策略装好，并在绝对必要时才显示错误弹窗。
 * 返回已安装的处理器集合。
 */
export function bootstrapSecurity(session: SessionLike, win: WindowLike) {
  const handlers = installSessionSecurity(session)
  installWindowSecurity(win)
  return handlers
}
