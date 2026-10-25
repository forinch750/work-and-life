/**
 * 补齐 Electron 与 esbuild 的预编译二进制。
 *
 * 背景：pnpm 的生命周期脚本在本机沙箱下无法 spawn（EPERM），
 * 因此 electron 的 postinstall（下载运行时）与 esbuild 的 postinstall（放置原生可执行文件）
 * 都不会执行。本脚本完成它们本该完成的工作，且不改变任何验收标准：
 *
 *   esbuild  —— 平台包 @esbuild/win32-x64 已在依赖树中，只需把 exe 放到 bin/esbuild
 *   electron —— 从镜像站下载 zip，校验 SHA-256 后解压到 node_modules/electron/dist，
 *               并写出 path.txt
 *
 * 用法：node scripts/fetch-binaries.mjs [--force]
 */
import { createHash } from 'node:crypto'
import { createWriteStream, existsSync, mkdirSync } from 'node:fs'
import { copyFile, readFile, stat, writeFile } from 'node:fs/promises'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { join, resolve } from 'node:path'

const ROOT = resolve(import.meta.dirname, '..')
const ELECTRON_PKG = join(ROOT, 'node_modules', 'electron')
const MIRROR = process.env['ELECTRON_MIRROR'] ?? 'https://registry.npmmirror.com/-/binary/electron/'
const ELECTRON_CACHE = process.env['ELECTRON_CACHE'] ?? join(ROOT, '.electron-cache')

function log(message) {
  process.stdout.write(`${message}\n`)
}

function formatSize(bytes) {
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

async function fileSize(path) {
  try {
    const info = await stat(path)
    return info.size
  } catch {
    return 0
  }
}

// ---------------------------------------------------------------------------
// esbuild（可选）
//
// Vite 8 起改用 rolldown + oxc 做转换，不再依赖 esbuild。
// 如果将来某个依赖重新引入 esbuild，它需要把平台二进制放到 bin/esbuild，
// 而那个动作原本由它的 postinstall 完成——在我们这里被 ignore-scripts 跳过了。
// 因此这里保留一段"按需补齐"的逻辑：找不到包就直接跳过，不算失败。
// ---------------------------------------------------------------------------
async function fixEsbuild() {
  const { readdir } = await import('node:fs/promises')
  const pnpmDir = join(ROOT, 'node_modules', '.pnpm')

  if (!existsSync(pnpmDir)) {
    log('[esbuild] 跳过：没有 node_modules/.pnpm 目录')
    return { ok: true, skipped: true }
  }

  const entries = await readdir(pnpmDir)
  const esbuildEntry = entries.find((name) => /^esbuild@\d/.test(name))
  if (!esbuildEntry) {
    log('[esbuild] 跳过：当前依赖树里没有 esbuild（Vite 8 已改用 rolldown）')
    return { ok: true, skipped: true }
  }

  const esbuildDir = join(pnpmDir, esbuildEntry, 'node_modules', 'esbuild')
  const target = join(esbuildDir, 'bin', 'esbuild')

  if (existsSync(target)) {
    log('[esbuild] 已存在，跳过')
    return { ok: true }
  }
  if (!existsSync(esbuildDir)) {
    log(`[esbuild] 跳过：目录不存在 ${esbuildDir}`)
    return { ok: true, skipped: true }
  }

  const platformEntry = entries.find((name) => /^@esbuild\+win32-x64@/.test(name))
  if (!platformEntry) {
    log('[esbuild] 失败：有 esbuild 包但缺少 win32-x64 平台包')
    return { ok: false, reason: 'platform package missing' }
  }

  const source = join(pnpmDir, platformEntry, 'node_modules', '@esbuild', 'win32-x64', 'esbuild.exe')
  if (!existsSync(source)) {
    log(`[esbuild] 失败：平台二进制不存在 ${source}`)
    return { ok: false, reason: 'platform binary missing' }
  }

  mkdirSync(join(esbuildDir, 'bin'), { recursive: true })
  await copyFile(source, target)
  log(`[esbuild] 已放置 bin/esbuild（${formatSize(await fileSize(target))}）`)
  return { ok: true }
}

// ---------------------------------------------------------------------------
// Electron
// ---------------------------------------------------------------------------
async function readElectronVersion() {
  const raw = await readFile(join(ELECTRON_PKG, 'package.json'), 'utf8')
  const parsed = JSON.parse(raw)
  return { version: parsed.version, abi: parsed.abi_version ?? parsed.abi }
}

async function download(url, destination) {
  const response = await fetch(url, { redirect: 'follow' })
  if (!response.ok || !response.body) {
    throw new Error(`下载失败 HTTP ${response.status}: ${url}`)
  }
  mkdirSync(resolve(destination, '..'), { recursive: true })
  await pipeline(Readable.fromWeb(response.body), createWriteStream(destination))
}

async function sha256(path) {
  const hash = createHash('sha256')
  hash.update(await readFile(path))
  return hash.digest('hex')
}

async function fixElectron(force) {
  const distExe = join(ELECTRON_PKG, 'dist', 'electron.exe')
  if (existsSync(distExe) && !force) {
    log('[electron] 已存在，跳过')
    return { ok: true }
  }
  if (!existsSync(join(ELECTRON_PKG, 'package.json'))) {
    log('[electron] 跳过：未找到 electron 包目录')
    return { ok: false, reason: 'electron package missing' }
  }

  const { version } = await readElectronVersion()
  const zipName = `electron-v${version}-win32-x64.zip`
  const baseUrl = `${MIRROR}v${version}/`

  log(`[electron] 版本 ${version}，准备下载 ${zipName}`)
  // 校验值就近取：优先版本目录下的 SHASUMS256.txt，退化到镜像根目录的汇总文件
  let expected
  for (const sumsUrl of [`${baseUrl}SHASUMS256.txt`, `${MIRROR}SHASUMS256.txt`]) {
    try {
      const response = await fetch(sumsUrl, { redirect: 'follow' })
      if (!response.ok) {
        log(`[electron] 校验文件不可用 HTTP ${response.status}：${sumsUrl}`)
        continue
      }
      const sumsText = await response.text()
      // 官方 SHASUMS256.txt 为 "hash *filename"（二进制模式标记），也兼容 "hash  filename"
      expected = sumsText
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean)
        .map((line) => {
          const [hash, rawName] = line.split(/\s+/)
          return { hash, name: (rawName ?? '').replace(/^\*/, '') }
        })
        .find((entry) => entry.name === zipName)?.hash
      if (expected) {
        log(`[electron] 取到校验值：${sumsUrl}`)
        break
      }
      log(`[electron] 该文件里没有 ${zipName}：${sumsUrl}`)
    } catch (error) {
      log(`[electron] 读取校验文件出错：${sumsUrl} -> ${error.message}`)
    }
  }

  if (!expected) {
    log('[electron] 失败：两处都没有找到校验值')
    return { ok: false, reason: 'checksum unavailable' }
  }

  mkdirSync(ELECTRON_CACHE, { recursive: true })
  const zipPath = join(ELECTRON_CACHE, zipName)
  const started = Date.now()
  await download(`${baseUrl}${zipName}`, zipPath)
  const size = await fileSize(zipPath)
  log(`[electron] 下载完成 ${formatSize(size)}，耗时 ${((Date.now() - started) / 1000).toFixed(1)}s`)

  const actual = await sha256(zipPath)
  if (actual !== expected) {
    log(`[electron] 失败：校验和不匹配\n  期望 ${expected}\n  实际 ${actual}`)
    return { ok: false, reason: 'checksum mismatch' }
  }
  log('[electron] 校验通过')

  // 解压用 Windows 自带的 tar.exe（bsdtar 可识别 zip），不依赖构建脚本
  const distDir = join(ELECTRON_PKG, 'dist')
  mkdirSync(distDir, { recursive: true })
  const { execFileSync } = await import('node:child_process')
  execFileSync('tar.exe', ['-xf', zipPath, '-C', distDir], { stdio: 'ignore' })
  log('[electron] 解压完成')

  if (!existsSync(distExe)) {
    log('[electron] 失败：解压后没有 electron.exe')
    return { ok: false, reason: 'extract failed' }
  }

  await writeFile(join(ELECTRON_PKG, 'path.txt'), 'electron.exe', 'utf8')
  log(`[electron] 已就绪（${formatSize(await fileSize(distExe))}，dist 共 ${formatSize(await fileSize(distExe))} 主体）`)
  return { ok: true }
}

// ---------------------------------------------------------------------------
const force = process.argv.includes('--force')
const results = []
results.push(['esbuild', await fixEsbuild()])
results.push(['electron', await fixElectron(force)])

const failed = results.filter(([, r]) => !r.ok)
log('')
log('==== 汇总 ====')
for (const [name, result] of results) {
  log(`${name.padEnd(10)} ${result.ok ? 'OK' : `FAILED (${result.reason})`}`)
}
process.exitCode = failed.length === 0 ? 0 : 1
