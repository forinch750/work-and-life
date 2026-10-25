/**
 * 清理打包输出目录（DEVPLAN 阶段 7）
 *
 * 背景：本机环境下，electron-builder 解包出来的 default_app.asar / app.asar
 * 会被某个系统组件（杀毒实时扫描或索引服务）持续持有句柄，
 * 导致删除与改名都报 EBUSY。常规 rmSync 会直接失败。
 *
 * 本脚本按"由轻到重"尝试多种办法，并把结果如实报告：
 *   1. 等待若干秒后重试（扫描通常是短暂的）
 *   2. 逐个删除文件（跳过被占用的），再删空目录
 *   3. 整目录改名让路（改名比删除更容易成功）
 *   4. 仍不行则报告具体被占用的文件，交由调用方决定换目录
 *
 * 用法：node scripts/clean-output.mjs [目录名...]
 */
import { existsSync, readdirSync, renameSync, rmSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'

const ROOT = resolve(import.meta.dirname, '..')
const targets = process.argv.slice(2)
const dirs = targets.length > 0 ? targets : ['release', 'dist', 'dist2']

function log(message) {
  process.stdout.write(`${message}\n`)
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms))
}

/** 递归尝试删除；返回无法删除的文件列表 */
function purge(path) {
  const blocked = []
  let entries
  try {
    entries = readdirSync(path, { withFileTypes: true })
  } catch {
    return blocked
  }

  for (const entry of entries) {
    const full = join(path, entry.name)
    if (entry.isDirectory()) {
      blocked.push(...purge(full))
      try {
        rmSync(full, { recursive: false, force: false })
      } catch {
        /* 目录非空或占用，无所谓 */
      }
    } else {
      try {
        rmSync(full, { force: true })
      } catch {
        blocked.push(full)
      }
    }
  }
  return blocked
}

let anyBlocked = false

for (const name of dirs) {
  const dir = join(ROOT, name)
  if (!existsSync(dir)) {
    log(`跳过 ${name}：不存在`)
    continue
  }

  // 步骤 1：直接删，最多试 3 次
  let removed = false
  for (let attempt = 0; attempt < 3 && !removed; attempt += 1) {
    try {
      rmSync(dir, { recursive: true, force: true })
      removed = true
    } catch {
      await sleep(1500)
    }
  }
  if (removed) {
    log(`已清理 ${name}`)
    continue
  }

  // 步骤 2：逐个文件删，记录被占用的
  const blocked = purge(dir)
  try {
    rmSync(dir, { recursive: false, force: false })
    log(`已清理 ${name}（逐个文件方式）`)
    continue
  } catch {
    /* 继续 */
  }

  // 步骤 3：改名让路
  const parked = `${dir}-stale-${Date.now()}`
  try {
    renameSync(dir, parked)
    log(`已把 ${name} 改名让路为 ${parked.slice(ROOT.length + 1)}`)
    continue
  } catch {
    /* 继续 */
  }

  anyBlocked = true
  log(`${name} 无法清理，被占用的文件：`)
  for (const file of blocked.slice(0, 10)) {
    let size = 0
    try {
      size = statSync(file).size
    } catch {
      /* ignore */
    }
    log(`   ${file.slice(ROOT.length + 1)}（${size} 字节）`)
  }
}

process.exit(anyBlocked ? 1 : 0)
