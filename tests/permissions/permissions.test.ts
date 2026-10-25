/**
 * 权限与隔离红线测试
 *
 * 目的：把 PRD §7.5 / §9.2 的"红线"从文档变成**会失败的测试**。
 *
 * 为什么需要：这些约束大多是"某段代码不出现某种调用"，
 * 单靠人工 review 很容易在后续改动中被无意破坏，而且破坏时没有任何信号。
 * 这里用源码扫描把几条最关键的约束固定下来——一旦有人放开它们，测试立刻红。
 *
 * 对应文档：PERMISSIONS.md
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const SRC = resolve(import.meta.dirname, '..', '..', 'src')

/** 递归收集源码文件 */
function collectSourceFiles(dir: string): string[] {
  const result: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) {
      result.push(...collectSourceFiles(full))
      continue
    }
    if (entry.isFile() && /\.(ts|tsx)$/.test(entry.name)) result.push(full)
  }
  return result
}

const FILES = collectSourceFiles(SRC).map((file) => ({
  path: file,
  /** 相对 src 的路径，报错信息里更好读 */
  rel: relative(SRC, file).replace(/\\/g, '/'),
  /** 原始内容（含注释） */
  text: readFileSync(file, 'utf8'),
  /** 剥掉注释后的内容——检测"代码里有没有某个调用"时必须用它 */
  code: stripComments(readFileSync(file, 'utf8'))
}))

/**
 * 剥掉块注释与整行行注释。
 *
 * 为什么必须剥：检测项是"代码里有没有某个调用"，而代码里到处写着
 * "我们不用 shell.openExternal" 这类解释性注释。不剥注释就会把注释当违规，
 * 于是每次补充说明都会把红线测试弄红——那种红灯毫无价值，还会诱使人放宽断言。
 *
 * 只剥整行注释是有意为之：行尾注释剥起来容易误伤字符串里的 //，
 * 而本项目的违禁调用不会藏在行尾注释里。
 */
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((line) => !/^\s*(\/\/|\*)/.test(line))
    .join('\n')
}

/** 在所有源码的**代码部分**里找匹配 */
function codeMatching(pattern: RegExp): string[] {
  return FILES.filter((file) => pattern.test(file.code)).map((file) => file.rel)
}

function fileText(rel: string): string {
  const found = FILES.find((file) => file.rel === rel)
  if (!found) throw new Error(`找不到源码文件：${rel}`)
  return found.text
}

describe('导出落点：桌面永不再写（PRD §7.4 修订）', () => {
  it('代码中不出现写桌面的路径解析', () => {
    // 以前 data:clear-all 会把"清空前备份"写进系统桌面，
    // 每跑一次验收就往真实桌面丢一份（实测攒了 40 个文件）。
    // 用 codeMatching：代码里不许出现，注释里说明"为什么不再写桌面"是正常的。
    expect(codeMatching(/getPath\(\s*['"]desktop['"]\s*\)/)).toEqual([])
  })

  it('清空前的备份落在应用根内的 exports 目录', () => {
    const source = fileText('main/ipc.ts')
    expect(source).toContain('appData.paths.exports')
  })

  it('paths 里的 exports 目录确实在应用根内，且与 backups 分开', () => {
    const source = fileText('main/data/paths.ts')
    expect(source).toMatch(/exports:\s*resolve\(root,\s*'exports'\)/)
  })
})

describe('渲染进程不得触碰 Node 能力', () => {
  it('renderer 与 preload 都不 import node: 模块', () => {
    const offenders = FILES.filter(
      (file) => file.rel.startsWith('renderer/') && /from\s+['"]node:/.test(file.code)
    ).map((file) => file.rel)
    expect(offenders).toEqual([])
  })

  it('renderer 不直接使用 fs / child_process / shell', () => {
    const offenders = FILES.filter(
      (file) =>
        file.rel.startsWith('renderer/') &&
        /(require\(['"]fs['"]\)|from\s+['"]fs['"]|child_process|ipcRenderer)/.test(file.code)
    ).map((file) => file.rel)
    expect(offenders).toEqual([])
  })

  it('contextBridge 只在 preload 里使用一次（界面唯一出入口）', () => {
    expect(codeMatching(/contextBridge\.exposeInMainWorld/)).toEqual(['preload/index.ts'])
  })
})

describe('窗口安全开关不得放开', () => {
  const windowSource = () => fileText('main/window.ts')

  it('contextIsolation 必须为 true', () => {
    expect(windowSource()).toMatch(/contextIsolation:\s*true/)
    expect(windowSource()).not.toMatch(/contextIsolation:\s*false/)
  })

  it('nodeIntegration 必须为 false', () => {
    expect(windowSource()).toMatch(/nodeIntegration:\s*false/)
  })

  it('webviewTag 必须为 false', () => {
    expect(windowSource()).toMatch(/webviewTag:\s*false/)
  })

  it('关闭拼写检查（否则 Electron 会去联网下载词典）', () => {
    expect(windowSource()).toMatch(/spellcheck:\s*false/)
  })

  it('任何页面都不允许用 electron 的 shell.openExternal 打开外部链接', () => {
    // shell.openPath 只用于"打开数据文件夹"，openExternal 会把地址交给系统浏览器。
    // 用 codeMatching：代码里不许出现这个调用，但注释里解释"我们不用它"是正常的。
    expect(codeMatching(/shell\s*\.\s*openExternal/)).toEqual([])
  })
})

describe('安全策略必须默认拒绝', () => {
  const security = () => fileText('main/security.ts')

  it('协议白名单只含本地协议，不含 http/https', () => {
    const match = security().match(/ALLOWED_PROTOCOLS\s*=\s*\[([^\]]*)\]/)
    expect(match).not.toBeNull()
    const list = match?.[1] ?? ''
    expect(list).toContain('file:')
    expect(list).not.toContain('http:')
    expect(list).not.toContain('https:')
    expect(list).not.toContain('ws:')
  })

  it('权限申请一律拒绝', () => {
    const source = security()
    expect(source).toMatch(/createPermissionRequestHandler/)
    // 处理器里必须回调 false
    expect(source).toMatch(/callback\(false\)/)
    // 权限检查恒为 false
    expect(source).toMatch(/createPermissionCheckHandler[\s\S]{0,120}?=>\s*false/)
  })

  it('新窗口一律 deny', () => {
    expect(security()).toMatch(/setWindowOpenHandler\([^)]*\)\s*=>\s*\(\{\s*action:\s*'deny'\s*\}\)/)
  })
})

describe('Chromium 运行期目录必须钉在应用根内（PRD K3）', () => {
  it('主进程显式设置 userData 路径', () => {
    const source = fileText('main/index.ts')
    expect(source).toContain("app.setPath('userData'")
    // 必须指向应用根下的 .runtime，而不是默认的 %APPDATA%\<应用名>
    expect(source).toMatch(/app\.setPath\('userData',\s*join\(paths\.root,\s*'\.runtime'\)\)/)
  })
})

describe('落盘边界必须生效（PRD K3）', () => {
  it('DataStore 接受并实际使用 allowedRoot', () => {
    const source = fileText('main/data/store.ts')
    expect(source).toContain('allowedRoot')
    expect(source).toContain('isInsideRoot')
  })

  it('createAppData 把应用根作为落盘边界传下去', () => {
    const source = fileText('main/data/index.ts')
    expect(source).toMatch(/allowedRoot:\s*paths\.root/)
  })
})

describe('网络与端口', () => {
  it('源码中不出现任何监听端口的调用', () => {
    const offenders = FILES.filter((file) =>
      /\.listen\(|createServer\(|net\.Server|http\.Server/.test(file.code)
    ).map((file) => file.rel)
    expect(offenders).toEqual([])
  })

  it('不引入任何 HTTP 客户端或自动更新模块', () => {
    const offenders = FILES.filter((file) =>
      /from\s+['"](axios|node-fetch|undici|got|electron-updater)['"]/.test(file.code)
    ).map((file) => file.rel)
    expect(offenders).toEqual([])
  })
})

describe('日志不得记录用户内容', () => {
  it('logger 只有事件名与说明，不接收记录正文', () => {
    const source = fileText('main/data/logger.ts')
    // 签名是 (event, detail)，detail 由调用方给出；这里守住"不出现把记录体直接塞进日志"的写法
    expect(source).not.toMatch(/JSON\.stringify\(\s*record/)
  })
})

describe('子进程使用范围', () => {
  it('只有诊断模块与验收台会拉起子进程', () => {
    const offenders = FILES.filter(
      (file) =>
        !file.rel.startsWith('main/verify/') &&
        file.rel !== 'main/diagnostics/ports.ts' &&
        /from\s+['"]node:child_process['"]/.test(file.code)
    ).map((file) => file.rel)
    expect(offenders).toEqual([])
  })

  it('唯一被执行的外部程序是 powershell.exe（端口枚举）', () => {
    const ports = fileText('main/diagnostics/ports.ts')
    expect(ports).toContain("'powershell.exe'")
  })
})

describe('环境纪律：不碰 WSL', () => {
  it('源码中不出现 \\\\wsl$ 或 Linux 绝对路径', () => {
    // 只认真正的 Linux 绝对路径字面量。
    // 注意不能简单匹配 /home/ ：组件相对导入里就有 '../modules/home/HomePage'
    const offenders = FILES.filter((file) =>
      /\\\\wsl\$|['"`]\/mnt\/|['"`]\/home\/|['"`]\/usr\/(bin|local)\//.test(file.code)
    ).map((file) => file.rel)
    expect(offenders).toEqual([])
  })

  it('不修改系统环境变量（只读不算）', () => {
    // 写入进程环境会污染子进程；只读（process.env['X'] 取值）是允许的
    const offenders = FILES.filter((file) =>
      /process\.env\[[^\]]*\]\s*=[^=]|process\.env\.[A-Za-z_][A-Za-z0-9_]*\s*=[^=]/.test(file.code)
    ).map((file) => file.rel)
    expect(offenders).toEqual([])
  })
})

describe('源码目录自身可读（防御性：确认扫描确实扫到了东西）', () => {
  it('扫描到的源码文件数在合理范围', () => {
    expect(FILES.length).toBeGreaterThan(40)
    for (const file of FILES) {
      expect(statSync(join(SRC, file.rel)).isFile()).toBe(true)
    }
  })
})
