/**
 * 构建脚本。
 *
 * 分工（原因见 vite.config.mjs 顶部注释：本机沙箱禁止带管道 stdio 的 spawn，
 * esbuild 的服务模式因此不可用）：
 *   - 主进程 / 预加载：tsc 编译为 CommonJS → out/main、out/preload
 *   - 渲染进程：vite 打包 → out/renderer（Vite 8 内置转换器，不需要 esbuild 服务）
 *
 * 全部子进程用 stdio: 'inherit'，不创建管道。
 *
 * 用法：node scripts/build.mjs [--skip-typecheck]
 */
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

const ROOT = resolve(import.meta.dirname, '..')
const skipTypecheck = process.argv.includes('--skip-typecheck')

function step(label, run) {
  process.stdout.write(`\n[${label}]\n`)
  const started = Date.now()
  run()
  process.stdout.write(`      完成（${((Date.now() - started) / 1000).toFixed(1)}s）\n`)
}

function tsc(args) {
  execFileSync(process.execPath, [join(ROOT, 'node_modules', 'typescript', 'bin', 'tsc'), ...args], {
    cwd: ROOT,
    stdio: 'inherit',
    timeout: 600000
  })
}

function vite(args) {
  execFileSync(process.execPath, [join(ROOT, 'node_modules', 'vite', 'bin', 'vite.js'), ...args], {
    cwd: ROOT,
    stdio: 'inherit',
    timeout: 900000
  })
}

/** 跑仓库里的构建脚本（同 `stdio: 'inherit'`：本机沙箱禁止带管道的 spawn） */
function script(name) {
  execFileSync(process.execPath, [join(ROOT, 'scripts', name)], {
    cwd: ROOT,
    stdio: 'inherit',
    timeout: 300000
  })
}

// 1) 清理产物
step('清理 out/', () => {
  rmSync(join(ROOT, 'out'), { recursive: true, force: true })
  mkdirSync(join(ROOT, 'out'), { recursive: true })
})

// 2) 《操作指南》Markdown 同源生成（第 07 块）
//    `src\shared\guide.ts` 是唯一源头；`docs\操作指南-正文.md` 是它的生成物。
//    放在类型检查之前：这样"改了 guide.ts 忘了重新生成"当场就被纠正，
//    而不是等提交时才发现仓库里那份 md 落后了。
step('同步操作指南 Markdown（guide.ts → docs\\操作指南-正文.md）', () => script('export-guide.mjs'))

// 3) 类型检查（默认执行；编译本身也会做一次检查）
if (!skipTypecheck) {
  step('类型检查：主进程 / 预加载', () => tsc(['--noEmit', '-p', 'tsconfig.main.json']))
  step('类型检查：渲染进程', () => tsc(['--noEmit', '-p', 'tsconfig.web.json']))
  step('类型检查：测试', () => tsc(['--noEmit', '-p', 'tsconfig.tests.json']))
}

// 4) 主进程 + 预加载
step('编译主进程 / 预加载（tsc → out/）', () => tsc(['-p', 'tsconfig.main.json']))

// 5) 渲染进程
step('打包渲染进程（vite → out/renderer）', () => {
  vite(['build', '--config', 'vite.config.mjs'])
})

// 6) 产物校验
step('校验产物', () => {
  const required = [
    join(ROOT, 'out', 'main', 'index.js'),
    join(ROOT, 'out', 'preload', 'index.js'),
    join(ROOT, 'out', 'renderer', 'index.html')
  ]
  const missing = required.filter((file) => !existsSync(file))
  if (missing.length > 0) {
    throw new Error(`缺少构建产物：\n${missing.join('\n')}`)
  }
  writeFileSync(
    join(ROOT, 'out', 'build-info.json'),
    JSON.stringify({ builtAt: new Date().toISOString() }, null, 2),
    'utf8'
  )
})

process.stdout.write('\n构建成功：out/main、out/preload、out/renderer 均已生成 ✓\n')
