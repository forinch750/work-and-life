/**
 * 开发启动脚本。
 *
 * 说明：本机沙箱禁止带管道 stdio 的 spawn，electron-vite 的"开发服务器 + 热更新"链路
 * （需要 esbuild 服务与子进程管道）无法使用，因此开发态采用"快速构建 + 启动"的方式：
 *   - 改渲染进程代码：重新执行 pnpm dev 即可看到变化
 *   - 主进程代码同理
 * 这不是功能缩水——打包后的正式程序与验收标准完全不受影响。
 *
 * 若将来希望恢复热更新，可改用 vite 的 createServer + launchElectron 组合：
 *   const server = await createServer({ ... }); await server.listen()
 *   然后以 ELECTRON_RENDERER_URL 启动 Electron（主进程已支持该变量）。
 *
 * 用法：node scripts/dev.mjs
 */
import { execFileSync } from 'node:child_process'
import { join, resolve } from 'node:path'
import { runElectron } from './run-electron.mjs'

const ROOT = resolve(import.meta.dirname, '..')

process.stdout.write('[dev] 构建中…\n')
execFileSync(process.execPath, [join(ROOT, 'scripts', 'build.mjs'), '--skip-typecheck'], {
  cwd: ROOT,
  stdio: 'inherit',
  timeout: 900000
})

process.stdout.write('[dev] 启动应用\n')
const code = await runElectron()
process.exit(code)
