/**
 * 主窗口创建（DEVPLAN 阶段 0）
 *
 * 关键点：
 *  - 关闭拼写检查（Electron 默认会去下载词典，属于联网行为）
 *  - 关闭所有网络相关开关，渲染进程只加载本地文件
 *  - webview 标签禁用，防止绕过窗口级安全策略
 */
import { BrowserWindow } from 'electron'
import { join } from 'node:path'
import { installWindowSecurity } from './security'

export interface CreateWindowOptions {
  /** 开发态由开发服务器提供的渲染进程地址 */
  rendererDevUrl?: string
  /** 打包后加载的本地 HTML 路径 */
  rendererFile?: string
  /**
   * 是否在窗口就绪后显示。
   * 正式启动为 true；无人值守验证时用 false，由验证台自行控制显示时机，
   * 避免窗口在自动流程里抢焦点。
   */
  show?: boolean
}

export function createMainWindow(options: CreateWindowOptions): BrowserWindow {
  const win = new BrowserWindow({
    width: 1280,
    height: 840,
    minWidth: 1024,
    minHeight: 680,
    show: false,
    autoHideMenuBar: true,
    backgroundColor: '#f5f6f8',
    title: '工作生活',
    webPreferences: {
      preload: join(__dirname, '..', 'preload', 'index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      webviewTag: false,
      spellcheck: false,
      devTools: !__dirname.includes('app.asar')
    }
  })

  installWindowSecurity(win)

  // 任何外部链接都不允许在应用内打开，也不交给系统浏览器（保持"不联网"的产品承诺）
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))

  win.once('ready-to-show', () => {
    if (options.show !== false) win.show()
  })

  if (options.rendererDevUrl) {
    void win.loadURL(options.rendererDevUrl)
  } else if (options.rendererFile) {
    void win.loadFile(options.rendererFile)
  }

  return win
}
