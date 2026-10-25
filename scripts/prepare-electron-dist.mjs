/**
 * 预解压 Electron 运行时（DEVPLAN 阶段 7）
 *
 * 为什么需要：
 *   electron-builder 打包时会自己解压 Electron 压缩包，解压完还要删掉
 *   resources\default_app.asar。而在本机环境下那个文件会被系统组件
 *   （杀毒实时扫描 / 索引服务）持续占用，删除必然 EBUSY，整个打包就失败。
 *   把 Electron 预解压到固定目录，再用 electronDist 指过去，
 *   electron-builder 就只做"复制 + 放入我们的代码"，不再碰那个文件。
 *
 * 为什么还要把 default_app.asar 从预解压目录里删掉：
 *   只做"预解压"还不够。electron-builder 会把这个文件**复制**到产物目录，
 *   然后在产物目录里删它——副本同样被系统组件锁住，于是每次打包都会在
 *   pack-*\win-unpacked\resources\ 下留下一个删不掉的 default_app.asar，
 *   导致整个 pack-* 目录无法清理（实测 rd /s /q 也失败）。
 *   default_app.asar 是 Electron 在没有应用代码时的占位入口，我们的程序
 *   有自己的 out\main，这份文件对产物毫无用处。源头不留，产物里就不会有。
 *
 * 做法：复用 scripts/fetch-binaries.mjs 下载并校验过的 zip，
 *       用 Windows 自带的 tar.exe 解压（不经过管道，沙箱允许）。
 *
 * 幂等：已有完整目录时仍会重跑一次"清占位文件"这一步，然后跳过解压。
 * 用法：node scripts/prepare-electron-dist.mjs
 */
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, renameSync } from 'node:fs'
import { join, resolve } from 'node:path'

const ROOT = resolve(import.meta.dirname, '..')
const CACHE = process.env['ELECTRON_CACHE'] ?? join(ROOT, '.electron-cache')
const TARGET = join(ROOT, '.electron-dist')

function log(message) {
  process.stdout.write(`${message}\n`)
}

/** 判断目录里是否有一份可用的 Electron */
function isComplete(dir) {
  return existsSync(join(dir, 'electron.exe')) && existsSync(join(dir, 'resources'))
}

/**
 * 删掉 Electron 的占位入口 resources\default_app.asar。
 *
 * 这一步必须在**复制之前**完成（即针对 .electron-dist 而不是产物目录）：
 * 一旦被复制进产物并被系统组件锁住，就连 rd /s /q 都删不掉。
 * 删不掉时不阻断流程——宁可留一个无用的占位文件，也不要让打包失败。
 */
function stripDefaultAppPlaceholder(dir) {
  const placeholder = join(dir, 'resources', 'default_app.asar')
  if (!existsSync(placeholder)) return true
  try {
    rmSync(placeholder, { force: true })
    log('已移除 Electron 占位入口 resources\\default_app.asar（避免它被复制进产物并锁死产物目录）')
    return true
  } catch (error) {
    log(`警告：无法移除 ${placeholder}（${String(error)}）`)
    log('      该文件会被复制进产物，可能造成产物目录无法清理；不影响程序运行')
    return false
  }
}

if (isComplete(TARGET)) {
  // 幂等分支也要清一次：老的 .electron-dist 里可能还留着这个占位文件
  stripDefaultAppPlaceholder(TARGET)
  log(`Electron 运行时已就绪：${TARGET}`)
  process.exit(0)
}

// 找到已下载并校验过的 zip
const electronPkg = join(ROOT, 'node_modules', 'electron', 'package.json')
if (!existsSync(electronPkg)) {
  log('失败：找不到 electron 包，请先运行 pnpm install 与 node scripts/fetch-binaries.mjs')
  process.exit(1)
}
const version = JSON.parse(readFileSync(electronPkg, 'utf8')).version
const zipName = `electron-v${version}-win32-x64.zip`
const zipPath = join(CACHE, zipName)

if (!existsSync(zipPath)) {
  log(`失败：找不到已下载的 ${zipName}（预期在 ${CACHE}）`)
  log('      请先运行：node scripts/fetch-binaries.mjs')
  process.exit(1)
}

// 解压到临时目录再改名，避免半成品被当成"已就绪"
const staging = `${TARGET}.staging`
rmSync(staging, { recursive: true, force: true })
mkdirSync(staging, { recursive: true })

log(`正在解压 ${zipName} → ${TARGET}`)
try {
  execFileSync('tar.exe', ['-xf', zipPath, '-C', staging], { stdio: 'ignore', timeout: 600000 })
} catch (error) {
  log(`失败：解压出错 ${String(error)}`)
  process.exit(1)
}

if (!isComplete(staging)) {
  log('失败：解压结果里没有 electron.exe 或 resources 目录')
  log(`      目录内容：${readdirSync(staging).slice(0, 10).join(', ')}`)
  process.exit(1)
}

// 改名之前先把占位入口挪掉：将来打包只会复制 .electron-dist 的内容
stripDefaultAppPlaceholder(staging)

rmSync(TARGET, { recursive: true, force: true })
renameSync(staging, TARGET)
log(`就绪：${TARGET}（${readdirSync(TARGET).length} 个条目）`)
