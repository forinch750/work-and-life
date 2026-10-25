/**
 * 《操作指南》同源生成脚本（第 07 块 / `docs\TASKS\07` §5.2 路线 A）
 *
 * **源头**：`src\shared\guide.ts`（零 import 的纯数据文件 + 渲染函数）
 * **生成物**：`docs\操作指南-正文.md`（仓库里那份面向用户的说明，**不要手改**）
 *
 * 为什么不是"读 md 生成 ts"（路线 B）：正文本来就是 md，读运行时 md 需要额外素材
 * 进打包、还要一套 Markdown 解析；反过来让 ts 当源头，界面直接渲染结构化数据，
 * 既不需要 md 解析器，也不需要把 md 打进 `out/**`。
 *
 * 为什么用 `typescript` 的 `transpileModule`：本机没有 esbuild / tsx，
 * 而 `src\shared\*.ts` 之间是无扩展名相互 import，`node --experimental-strip-types`
 * 直接跑不通（已实测）。`guide.ts` 刻意保持零 import，所以转成 CommonJS
 * 之后在内存里跑一下就行——不需要落临时文件，也不需要 spawn 子进程。
 *
 * 用法：
 *   node scripts/export-guide.mjs           # 写回 docs\操作指南-正文.md
 *   node scripts/export-guide.mjs --check   # 只比对，不一致就退出码 1（不写文件）
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join, resolve } from 'node:path'

const ROOT = resolve(import.meta.dirname, '..')
const GUIDE_TS = join(ROOT, 'src', 'shared', 'guide.ts')
const GUIDE_MD = join(ROOT, 'docs', '操作指南-正文.md')

const require = createRequire(import.meta.url)

/**
 * 加载 `guide.ts`：转成 CommonJS 后在内存里执行。
 *
 * 只用 `transpileModule`（不做类型检查、不做模块解析）——类型检查是
 * `scripts\typecheck.mjs` 的活，这里只管"把数据拿出来"。
 */
function loadGuideModule() {
  const typescript = require(join(ROOT, 'node_modules', 'typescript'))
  const source = readFileSync(GUIDE_TS, 'utf8')
  const output = typescript.transpileModule(source, {
    fileName: GUIDE_TS,
    compilerOptions: {
      module: typescript.ModuleKind.CommonJS,
      target: typescript.ScriptTarget.ES2022,
      removeComments: true
    }
  }).outputText

  const module = { exports: {} }
  // eslint-disable-next-line no-new-func -- 构建脚本里跑自己仓库的纯数据文件，没有外部输入
  const run = new Function('exports', 'module', 'require', output)
  run(module.exports, module, require)
  return module.exports
}

const guide = loadGuideModule()
if (typeof guide.renderGuideMarkdown !== 'function' || !guide.GUIDE) {
  process.stdout.write('[guide] 失败：guide.ts 里没有导出 GUIDE / renderGuideMarkdown\n')
  process.exit(1)
}

const markdown = guide.renderGuideMarkdown(guide.GUIDE)
const checkOnly = process.argv.includes('--check')

let existing = null
try {
  existing = readFileSync(GUIDE_MD, 'utf8')
} catch {
  existing = null
}

/**
 * 行尾归一后再比。
 *
 * 本仓库 `core.autocrlf=true`：别的机器 checkout 出来的工作区可能是 CRLF，
 * 而这里固定输出 LF。只在行尾不同时不该动不动就重写文件（否则每次构建
 * 都"改了"一次，`git status` 永远脏）。
 */
const normalized = (text) => (typeof text === 'string' ? text.replace(/\r\n/g, '\n') : null)
const upToDate = normalized(existing) === markdown

if (checkOnly) {
  if (upToDate) {
    process.stdout.write(`[guide] docs\\操作指南-正文.md 已是最新 ✓\n`)
    process.exit(0)
  }
  process.stdout.write(
    '[guide] 与生成结果不一致：请运行 node scripts/export-guide.mjs（或 node scripts/build.mjs）\n'
  )
  process.exit(1)
}

if (upToDate) {
  process.stdout.write('[guide] 已是最新，无需改写\n')
} else {
  // 'utf8' 写入不带 BOM；内容里统一用 `\n`（与仓库其它源码一致）
  writeFileSync(GUIDE_MD, markdown, 'utf8')
  process.stdout.write(`[guide] 已生成 docs\\操作指南-正文.md（${markdown.split('\n').length - 1} 行）\n`)
}
