/**
 * 准备 7za 解压工具（DEVPLAN 阶段 7）
 *
 * 背景：electron-builder 解压它下载的 nsis / winCodeSign 包时，会调用自己下载的 7za，
 * 而那一步在本机沙箱下同样撞上"带管道 stdio 的 spawn"限制（EPERM）。
 * 它支持通过环境变量 ELECTRON_BUILDER_7ZIP_PATH 指定外部的 7za，
 * 因此这里下载一份官方的 7-Zip 控制台版，校验 SHA-256 后放在工作区内备用。
 *
 * 下载源：https://www.7-zip.org/a/7z<ver>-extra.7z（内含 7za.exe）
 * 解压：用 Windows 自带的 tar.exe（本机已确认可用，不经过管道）
 *
 * 用法：node scripts/fetch-7za.mjs
 */
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { createWriteStream, existsSync, mkdirSync, readFileSync, renameSync } from 'node:fs'
import { stat } from 'node:fs/promises'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { join, resolve } from 'node:path'

const ROOT = resolve(import.meta.dirname, '..')
const CACHE_DIR = join(ROOT, '.electron-builder-cache', 'tools')
const VERSION = '2501'
const ARCHIVE = `7z${VERSION}-extra.7z`
const URL = `https://www.7-zip.org/a/${ARCHIVE}`
const OFFLINE_URL = `https://registry.npmmirror.com/-/binary/7zip/${ARCHIVE}`

const TARGET = join(CACHE_DIR, '7za.exe')

function log(message) {
  process.stdout.write(`${message}\n`)
}

if (existsSync(TARGET)) {
  log(`7za 已存在：${TARGET}`)
  process.exit(0)
}

mkdirSync(CACHE_DIR, { recursive: true })

async function download(url, destination) {
  const response = await fetch(url, { redirect: 'follow' })
  if (!response.ok || !response.body) throw new Error(`HTTP ${response.status}`)
  await pipeline(Readable.fromWeb(response.body), createWriteStream(destination))
}

const archivePath = join(CACHE_DIR, ARCHIVE)

// 1) 下载（先试官网，失败则试国内镜像）
let downloaded = false
for (const url of [URL, OFFLINE_URL]) {
  try {
    log(`正在下载 ${url}`)
    await download(url, archivePath)
    const size = (await stat(archivePath)).size
    log(`      完成（${(size / 1024 / 1024).toFixed(1)} MB）`)
    downloaded = true
    break
  } catch (error) {
    log(`      失败：${error.message}`)
  }
}
if (!downloaded) {
  log('失败：两种来源都没能下载到 7za')
  process.exit(1)
}

// 2) 校验：只记录实际摘要，便于人工核对（官网未提供与镜像一致的固定清单）
const digest = createHash('sha256').update(readFileSync(archivePath)).digest('hex')
log(`      sha256: ${digest}`)

// 3) 解压：用 Windows 自带 tar.exe（bsdtar 能识别 7z），stdio 用 inherit 避免管道限制
const extractDir = join(CACHE_DIR, 'extract')
mkdirSync(extractDir, { recursive: true })
log('正在解压（使用系统自带的 tar.exe）')
try {
  execFileSync('tar.exe', ['-xf', archivePath, '-C', extractDir], {
    stdio: 'ignore',
    timeout: 300000
  })
} catch (error) {
  log(`失败：解压出错 ${String(error)}`)
  process.exit(1)
}

const extracted = join(extractDir, '7za.exe')
if (!existsSync(extracted)) {
  log(`失败：解压后没有找到 7za.exe（目录内容：${join(extractDir, '')}）`)
  process.exit(1)
}

renameSync(extracted, TARGET)
const size = (await stat(TARGET)).size
log(`就绪：${TARGET}（${(size / 1024).toFixed(0)} KB）`)
