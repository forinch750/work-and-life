/**
 * 打包脚本（DEVPLAN 阶段 7）
 *
 * 步骤：生成图标 → 构建（tsc + vite）→ 前置准备 → electron-builder 打 Windows 免安装版
 *       → 清理历史产物 → 汇总
 *
 * 输出目录：每次打包生成 pack-<时间戳>，通过 --config.directories.output 传给
 * electron-builder（实测该点号覆盖会与 electron-builder.yml 深合并，yaml 里的
 * directories.output 只作为"直接调用 electron-builder"时的兜底默认值）。
 * 这样每次产物各占一个目录，不会互相覆盖，历史版本可以留着对比或回滚。
 *
 * 注意：本机沙箱禁止带管道 stdio 的 spawn，因此子进程一律用 stdio: 'inherit'。
 * electron-builder 需要的二进制（winCodeSign / nsis）走国内镜像下载。
 *
 * 用法：node scripts/package.mjs [--skip-build]
 */
import { spawn, execFileSync } from 'node:child_process'
import { existsSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

const ROOT = resolve(import.meta.dirname, '..')
const skipBuild = process.argv.includes('--skip-build')

/** 保留多少个历史 pack-* 目录（含本次）。更早的会被清理，避免磁盘越占越多。 */
const KEEP_PACKS = 2

function log(message) {
  process.stdout.write(`${message}\n`)
}

function runNode(script, args = []) {
  execFileSync(process.execPath, [join(ROOT, 'scripts', script), ...args], {
    cwd: ROOT,
    stdio: 'inherit',
    timeout: 900000
  })
}

/** 本地时间戳，例如 20261010-150738（与旧产物命名保持一致，便于排序） */
function timestamp(date = new Date()) {
  const pad = (value) => `${value}`.padStart(2, '0')
  return (
    `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}` +
    `-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`
  )
}

const outputDirName = `pack-${timestamp()}`
const outputDir = join(ROOT, outputDirName)

/**
 * 删除一个目录，带重试。
 *
 * Windows 上文件句柄释放有延迟（杀毒 / 索引服务会临时占用刚生成的文件），
 * 常见"进程已退出但文件仍被占用"，所以这里做多次重试。
 * 仍失败就返回 false，由调用方决定是"改名让路"还是"原样留着"。
 */
function removeDirWithRetry(dir, attempts = 5) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      rmSync(dir, { recursive: true, force: true })
      return true
    } catch {
      // 同步等待：这几百毫秒的代价远小于把整个打包流程作废
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 400 * (attempt + 1))
    }
  }
  return false
}

/** 列出根目录下形如 pack-YYYYMMDD-HHMMSS 的产物目录（新的在前） */
function listPackDirs() {
  return readdirSync(ROOT, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && /^pack-\d{8}-\d{6}$/.test(entry.name))
    .map((entry) => entry.name)
    .sort()
    .reverse()
}

// 1) 图标
if (!existsSync(join(ROOT, 'build', 'icon.ico'))) {
  log('[1/5] 生成图标')
  runNode('make-icon.mjs')
} else {
  log('[1/5] 图标已存在，跳过')
}

// 2) 构建
if (!skipBuild) {
  log('[2/5] 构建应用')
  runNode('build.mjs')
} else {
  log('[2/5] 跳过构建')
}

if (!existsSync(join(ROOT, 'out', 'main', 'index.js'))) {
  log('失败：构建产物不存在')
  process.exit(1)
}

// 3) 打包前置条件
log('[3/5] 检查打包前置条件')
runNode('patch-deps.mjs')
runNode('fetch-7za.mjs')
runNode('prepare-electron-dist.mjs')

log(`[3/5] 本次产物目录：${outputDirName}`)
const builderBin = join(ROOT, 'node_modules', 'electron-builder', 'out', 'cli', 'cli.js')
if (!existsSync(builderBin)) {
  log(`失败：找不到 electron-builder 入口 ${builderBin}`)
  process.exit(1)
}

const exitCode = await new Promise((resolvePromise) => {
  // @electron/get 5.x 用 env-paths 决定下载缓存目录，认的是 LOCALAPPDATA。
  // 本机沙箱禁止写 C:\Users\...\AppData，因此把它指到工作区内。
  // 这是此环境下唯一可行的做法，不影响产出的安装包本身。
  const localAppData = join(ROOT, '.electron-builder-cache', 'localappdata')
  const child = spawn(
    process.execPath,
    [
      builderBin,
      '--win',
      '--config',
      'electron-builder.yml',
      // 产物目录每次不同：点号覆盖会与 yml 深合并（yaml 里的值只是兜底默认）
      `--config.directories.output=${outputDir}`
    ],
    {
      cwd: ROOT,
      stdio: ['ignore', 'inherit', 'inherit'],
      windowsHide: true,
      env: {
        ...process.env,
        LOCALAPPDATA: localAppData,
        // 本地自用：不签名。electron-builder 默认会尝试签名，
        // 在 Windows 上会走 Wine 兼容层——那条路径在本机会被沙箱拦下。
        CSC_IDENTITY_AUTO_DISCOVERY: 'false',
        // electron-builder 解压工具包时要用 7za；自己下载的那份在本机会被沙箱拦下，
        // 因此指定用我们预先取好的外部 7za（见 scripts/fetch-7za.mjs）
        ELECTRON_BUILDER_7ZIP_PATH:
          process.env['ELECTRON_BUILDER_7ZIP_PATH'] ??
          join(ROOT, '.electron-builder-cache', 'tools', '7za.exe'),
        // Electron 运行时从国内镜像取（本机访问 GitHub 不通）
        ELECTRON_MIRROR:
          process.env['ELECTRON_MIRROR'] ?? 'https://registry.npmmirror.com/-/binary/electron/',
        ELECTRON_BUILDER_BINARIES_MIRROR:
          process.env['ELECTRON_BUILDER_BINARIES_MIRROR'] ??
          'https://registry.npmmirror.com/-/binary/electron-builder-binaries/',
        ELECTRON_CACHE: process.env['ELECTRON_CACHE'] ?? join(ROOT, '.electron-cache'),
        ELECTRON_BUILDER_CACHE:
          process.env['ELECTRON_BUILDER_CACHE'] ?? join(ROOT, '.electron-builder-cache')
      }
    }
  )
  child.on('exit', (code) => resolvePromise(code ?? 1))
  child.on('error', (error) => {
    log(`      打包进程启动失败：${error.message}`)
    resolvePromise(1)
  })
})

// 4) 收尾：清掉产物里的 Electron 占位入口
//
// prepare-electron-dist.mjs 已从源头删除了它，这里是第二道保险：
// 万一某次打包用了没清干净的 .electron-dist，也要在产物目录里把它拿掉，
// 否则这个被系统组件锁住的文件会让整个 pack-* 目录删不掉。
log('[4/5] 清理产物里的 Electron 占位入口')
const unpackedResources = join(outputDir, 'win-unpacked', 'resources')
const leftoverPlaceholder = join(unpackedResources, 'default_app.asar')
if (existsSync(leftoverPlaceholder)) {
  try {
    rmSync(leftoverPlaceholder, { force: true })
    log('      已移除 win-unpacked\\resources\\default_app.asar')
  } catch (error) {
    log(`      警告：无法移除 ${leftoverPlaceholder}（${String(error)}）`)
    log('      该文件被系统组件占用，可能导致本目录日后无法删除；不影响程序运行')
  }
} else {
  log('      产物中没有占位入口，无需清理')
}

// 5) 汇总产物
log('[5/5] 产物清单')
if (!existsSync(outputDir)) {
  log(`失败：没有生成产物目录 ${outputDirName}（打包退出码 ${exitCode}）`)
  process.exit(exitCode === 0 ? 1 : exitCode)
}

const artifacts = readdirSync(outputDir)
  .filter((name) => name.endsWith('.exe') || name.endsWith('.blockmap') || name.endsWith('.yml'))
  .map((name) => {
    const info = statSync(join(outputDir, name))
    return { name, size: info.size }
  })

for (const artifact of artifacts) {
  log(`      ${artifact.name}（${(artifact.size / 1024 / 1024).toFixed(1)} MB）`)
}

const unpackedExe = join(outputDir, 'win-unpacked', '工作生活.exe')
if (existsSync(unpackedExe)) {
  log(`      免安装可执行文件：${outputDirName}\\win-unpacked\\工作生活.exe`)
}

// 只保留最近 KEEP_PACKS 个产物目录，更早的清掉。
// 每个 pack-* 约 460 MB，不清理会一直堆积；清不掉的（被占用）就改名让路，
// 保持"目录名即状态"：pack-* 是有效产物，parked-* 是等着人工/重启后删除的。
log(`      保留最近 ${KEEP_PACKS} 个产物目录，清理更早的…`)
const packDirs = listPackDirs()
for (const oldName of packDirs.slice(KEEP_PACKS)) {
  const oldDir = join(ROOT, oldName)
  if (removeDirWithRetry(oldDir)) {
    log(`      已清理历史产物 ${oldName}`)
    continue
  }
  const parkedName = `parked-${oldName.slice('pack-'.length)}`
  try {
    renameSync(oldDir, join(ROOT, parkedName))
    log(`      历史产物 ${oldName} 被占用，已改名为 ${parkedName}（可稍后手动删除）`)
  } catch {
    log(`      警告：历史产物 ${oldName} 无法删除也无法改名，请手动清理`)
  }
}

// 写一份打包信息，供验收报告引用
const info = {
  packagedAt: new Date().toISOString(),
  exitCode,
  outputDir: outputDirName,
  artifacts,
  unpackedExe: existsSync(unpackedExe) ? unpackedExe : null
}
writeFileSync(join(ROOT, 'logs', 'package-info.json'), JSON.stringify(info, null, 2), 'utf8')

if (exitCode !== 0) {
  log(`打包失败，退出码 ${exitCode}`)
  process.exit(exitCode)
}
log('')
log('打包成功：免安装版 exe 与未打包目录都已生成 ✓')
