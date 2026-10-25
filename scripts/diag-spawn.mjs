// 诊断脚本：定位 Vite/Vitest 在哪一步 spawn 子进程
// 用法：node scripts/diag-spawn.mjs
const steps = []

function note(name, ok, detail) {
  steps.push({ name, ok, detail })
  process.stdout.write(`${ok ? 'OK  ' : 'FAIL'}  ${name}${detail ? '  -> ' + detail : ''}\n`)
}

// 1) net use：确认沙箱是否拒绝该 spawn
try {
  const { execFileSync } = await import('node:child_process')
  execFileSync('cmd.exe', ['/c', 'echo probe'], { stdio: 'ignore', timeout: 10000 })
  note('spawn cmd.exe', true)
} catch (e) {
  note('spawn cmd.exe', false, `${e.code ?? ''} ${e.message}`)
}

try {
  const { execSync } = await import('node:child_process')
  execSync('net use', { stdio: 'ignore', timeout: 10000, windowsHide: true })
  note('exec net use', true)
} catch (e) {
  note('exec net use', false, `${e.code ?? ''} ${e.message}`)
}

// 2) 直接加载 vite 的 resolveConfig，分别测三种写法
const { resolveConfig } = await import('vite')

const cases = {
  'empty config object': {},
  'config with empty plugins': { plugins: [] }
}

for (const [name, config] of Object.entries(cases)) {
  try {
    await resolveConfig(config, 'serve')
    note(`vite resolveConfig [${name}]`, true)
  } catch (e) {
    note(`vite resolveConfig [${name}]`, false, `${e.code ?? ''} ${e.message}`)
  }
}

// 3) 用 externalizeDepsPlugin 再测一次
try {
  const { externalizeDepsPlugin } = await import('electron-vite')
  await resolveConfig({ plugins: [externalizeDepsPlugin()] }, 'serve')
  note('vite resolveConfig [externalizeDepsPlugin]', true)
} catch (e) {
  note('vite resolveConfig [externalizeDepsPlugin]', false, `${e.code ?? ''} ${e.message}`)
}

// 4) 加载真实配置文件
try {
  await resolveConfig({}, 'serve', 'D:\\工作生活\\electron.vite.config.ts')
  note('load electron.vite.config.ts', true)
} catch (e) {
  note('load electron.vite.config.ts', false, `${e.code ?? ''} ${e.message}`)
}

process.stdout.write('\n==== 汇总 ====\n')
for (const s of steps) process.stdout.write(`${s.ok ? 'OK  ' : 'FAIL'}  ${s.name}\n`)
