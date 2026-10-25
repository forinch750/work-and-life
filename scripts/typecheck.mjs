/**
 * 类型检查（三套配置：主进程 / 渲染进程 / 测试）。
 * 用法：node scripts/typecheck.mjs [--project=main|web|tests]
 */
import { execFileSync } from 'node:child_process'
import { join, resolve } from 'node:path'

const ROOT = resolve(import.meta.dirname, '..')
const tscEntry = join(ROOT, 'node_modules', 'typescript', 'bin', 'tsc')

const all = [
  ['主进程 / 预加载', 'tsconfig.main.json'],
  ['渲染进程', 'tsconfig.web.json'],
  ['测试', 'tsconfig.tests.json']
]

const only = process.argv
  .filter((arg) => arg.startsWith('--project='))
  .map((arg) => arg.slice('--project='.length))[0]

const selected =
  only === 'main'
    ? [all[0]]
    : only === 'web'
      ? [all[1]]
      : only === 'tests'
        ? [all[2]]
        : all

let failed = 0
for (const [label, project] of selected) {
  process.stdout.write(`\n[类型检查] ${label}（${project}）\n`)
  try {
    execFileSync(process.execPath, [tscEntry, '--noEmit', '-p', project], {
      cwd: ROOT,
      stdio: 'inherit',
      timeout: 600000
    })
    process.stdout.write('      通过\n')
  } catch {
    failed += 1
    process.stdout.write('      失败\n')
  }
}

if (failed > 0) {
  process.stdout.write(`\n类型检查未通过：${failed} 项失败\n`)
  process.exit(1)
}
process.stdout.write('\n类型检查全部通过 ✓\n')
