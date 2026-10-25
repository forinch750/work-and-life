/**
 * 阶段 0 测试：安全策略
 *
 * 验收目标：程序在任何情况下都拒绝外部网络请求与系统权限申请。
 * 对应 PRD K2（运行期间不新增监听端口）、"不联网、数据不出本机"。
 */
import { describe, expect, it, vi } from 'vitest'
import {
  bootstrapSecurity,
  createPermissionCheckHandler,
  createPermissionRequestHandler,
  createRequestFilter,
  installSessionSecurity,
  installWindowSecurity,
  isLocalRendererUrl,
  type SessionLike,
  type WindowLike
} from '../../src/main/security'

/** 构造一个只记录行为的假 session */
function makeFakeSession() {
  const state = {
    permissionHandler: null as ((...args: any[]) => void) | null,
    checkHandler: null as ((...args: any[]) => boolean) | null,
    requestListener:
      null as null | ((details: { url: string }, cb: (r: { cancel: boolean }) => void) => void),
    filterUrls: null as string[] | null
  }

  const session: SessionLike = {
    setPermissionRequestHandler: (handler) => {
      state.permissionHandler = handler
    },
    setPermissionCheckHandler: (handler) => {
      state.checkHandler = handler
    },
    webRequest: {
      onBeforeRequest: (filter, listener) => {
        state.filterUrls = filter.urls
        state.requestListener = listener
      }
    }
  }

  return { session, state }
}

function makeFakeWindow() {
  const state = {
    windowOpenHandler: null as null | ((details: { url: string }) => { action: string }),
    listeners: new Map<string, (...args: any[]) => void>()
  }

  const win: WindowLike = {
    webContents: {
      setWindowOpenHandler: (handler) => {
        state.windowOpenHandler = handler
      },
      on: (event, listener) => {
        state.listeners.set(event, listener)
      }
    }
  }

  return { win, state }
}

describe('isLocalRendererUrl', () => {
  it('放行本地协议', () => {
    expect(isLocalRendererUrl('file:///D:/app/out/renderer/index.html')).toBe(true)
    expect(isLocalRendererUrl('data:text/html,<p>hi</p>')).toBe(true)
    expect(isLocalRendererUrl('blob:file:///abc')).toBe(true)
    expect(isLocalRendererUrl('devtools://devtools/bundled/inspector.html')).toBe(true)
  })

  it('拦下一切网络协议', () => {
    expect(isLocalRendererUrl('https://example.com')).toBe(false)
    expect(isLocalRendererUrl('http://127.0.0.1:8888/lab')).toBe(false)
    expect(isLocalRendererUrl('ws://127.0.0.1:8888/ws')).toBe(false)
    expect(isLocalRendererUrl('wss://example.com/socket')).toBe(false)
    expect(isLocalRendererUrl('ftp://example.com/file')).toBe(false)
  })

  it('拦下空值与非法值', () => {
    expect(isLocalRendererUrl(undefined)).toBe(false)
    expect(isLocalRendererUrl(null)).toBe(false)
    expect(isLocalRendererUrl('')).toBe(false)
    expect(isLocalRendererUrl('not a url')).toBe(false)
  })
})

describe('权限申请', () => {
  it('request 处理器一律回绝', () => {
    const handler = createPermissionRequestHandler()
    const callback = vi.fn()
    handler({ permission: 'media' }, 'file:///app/index.html', callback)
    expect(callback).toHaveBeenCalledWith(false)
  })

  it('缺少 callback 时不抛错（Electron 不同版本的签名差异）', () => {
    const handler = createPermissionRequestHandler()
    expect(() => handler({ permission: 'notifications' })).not.toThrow()
  })

  it('check 处理器一律返回 false', () => {
    const check = createPermissionCheckHandler()
    expect(check('media', 'file:///app/index.html')).toBe(false)
    expect(check('geolocation', 'file:///app/index.html')).toBe(false)
  })
})

describe('请求过滤', () => {
  it('本地资源放行，网络请求取消', () => {
    const filter = createRequestFilter()

    const localResult = { cancel: true }
    filter({ url: 'file:///D:/app/index.html' }, (r) => Object.assign(localResult, r))
    expect(localResult.cancel).toBe(false)

    const remoteResult = { cancel: false }
    filter({ url: 'https://registry.npmmirror.com/x' }, (r) => Object.assign(remoteResult, r))
    expect(remoteResult.cancel).toBe(true)
  })
})

describe('installSessionSecurity', () => {
  it('把三件套都装到 session 上，并覆盖所有 URL', () => {
    const { session, state } = makeFakeSession()
    installSessionSecurity(session)

    expect(state.permissionHandler).toBeTypeOf('function')
    expect(state.checkHandler).toBeTypeOf('function')
    expect(state.requestListener).toBeTypeOf('function')
    expect(state.filterUrls).toEqual(['*://*/*'])
  })

  it('装好之后，所有权限申请都被拒、所有网络请求都被取消', () => {
    const { session, state } = makeFakeSession()
    installSessionSecurity(session)

    const granted = vi.fn()
    state.permissionHandler?.({ permission: 'media' }, granted)
    expect(granted).toHaveBeenCalledWith(false)
    expect(state.checkHandler?.('media')).toBe(false)

    const cancelled = { cancel: false }
    state.requestListener?.({ url: 'http://127.0.0.1:8888/lab' }, (r) =>
      Object.assign(cancelled, r)
    )
    expect(cancelled.cancel).toBe(true)
  })
})

describe('installWindowSecurity', () => {
  it('禁止开新窗口', () => {
    const { win, state } = makeFakeWindow()
    installWindowSecurity(win)
    expect(state.windowOpenHandler?.({ url: 'https://example.com' })).toEqual({ action: 'deny' })
  })

  it('禁止挂载 webview', () => {
    const { win, state } = makeFakeWindow()
    installWindowSecurity(win)

    const preventDefault = vi.fn()
    state.listeners.get('will-attach-webview')?.({ preventDefault })
    expect(preventDefault).toHaveBeenCalled()
  })

  it('拦截跳转到外部地址，放行本地跳转', () => {
    const { win, state } = makeFakeWindow()
    installWindowSecurity(win)
    const navigate = state.listeners.get('will-navigate')

    const external = vi.fn()
    navigate?.({ preventDefault: external }, 'https://example.com')
    expect(external).toHaveBeenCalled()

    const internal = vi.fn()
    navigate?.({ preventDefault: internal }, 'file:///D:/app/out/renderer/index.html')
    expect(internal).not.toHaveBeenCalled()
  })
})

describe('bootstrapSecurity', () => {
  it('一次性装好 session 与 window 两层策略', () => {
    const { session, state: sessionState } = makeFakeSession()
    const { win, state: windowState } = makeFakeWindow()

    const handlers = bootstrapSecurity(session, win)

    expect(handlers.requestFilter).toBeTypeOf('function')
    expect(sessionState.permissionHandler).toBeTypeOf('function')
    expect(windowState.windowOpenHandler).toBeTypeOf('function')
  })
})
