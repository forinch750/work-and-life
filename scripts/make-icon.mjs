/**
 * 生成应用图标（DEVPLAN 阶段 7）
 *
 * 不引入任何图像库：直接手写 PNG 与 ICO 的字节。
 *   - PNG：单色底 + 中间一个方框（象征"清单"），用 zlib 压缩
 *   - ICO：把多个尺寸的 PNG 装进 ICO 容器（Windows 支持 PNG 压缩的 ICO）
 *
 * 用法：node scripts/make-icon.mjs
 */
import { createHash } from 'node:crypto'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { deflateSync } from 'node:zlib'

const ROOT = resolve(import.meta.dirname, '..')
const BUILD_DIR = join(ROOT, 'build')

const SIZES = [16, 32, 48, 64, 128, 256]

/** 图标配色：与界面主色一致的蓝 */
const BG = { r: 0x2f, g: 0x6f, b: 0xeb, a: 255 }
const FG = { r: 0xff, g: 0xff, b: 0xff, a: 255 }

function crc32(buffer) {
  let crc = 0xffffffff
  for (const byte of buffer) {
    crc ^= byte
    for (let bit = 0; bit < 8; bit += 1) {
      crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1
    }
  }
  return (crc ^ 0xffffffff) >>> 0
}

function chunk(type, data) {
  const length = Buffer.alloc(4)
  length.writeUInt32BE(data.length, 0)
  const typeBuffer = Buffer.from(type, 'ascii')
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuffer, data])), 0)
  return Buffer.concat([length, typeBuffer, data, crc])
}

/** 画一个尺寸的图标像素：圆角方底 + 三条横线（清单的意象） */
function drawPixels(size) {
  const pixels = Buffer.alloc(size * size * 4)
  const radius = Math.max(2, Math.round(size * 0.18))
  const lineHeight = Math.max(1, Math.round(size * 0.08))
  const lineLeft = Math.round(size * 0.26)
  const lineRight = Math.round(size * 0.74)
  const lineRows = [0.34, 0.5, 0.66].map((ratio) => Math.round(size * ratio))

  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      // 圆角判定
      const inCornerX = x < radius ? radius - x : x >= size - radius ? x - (size - radius - 1) : 0
      const inCornerY = y < radius ? radius - y : y >= size - radius ? y - (size - radius - 1) : 0
      const outside = inCornerX > 0 && inCornerY > 0 && inCornerX ** 2 + inCornerY ** 2 > radius ** 2

      let color = outside ? { r: 0, g: 0, b: 0, a: 0 } : BG

      // 横线
      if (!outside && x >= lineLeft && x <= lineRight) {
        for (const row of lineRows) {
          if (y >= row - Math.floor(lineHeight / 2) && y < row - Math.floor(lineHeight / 2) + lineHeight) {
            color = FG
          }
        }
      }

      const offset = (y * size + x) * 4
      pixels[offset] = color.r
      pixels[offset + 1] = color.g
      pixels[offset + 2] = color.b
      pixels[offset + 3] = color.a
    }
  }
  return pixels
}

/** 组装 PNG */
function makePng(size) {
  const pixels = drawPixels(size)
  const raw = Buffer.alloc((size * 4 + 1) * size)
  for (let y = 0; y < size; y += 1) {
    raw[y * (size * 4 + 1)] = 0 // 过滤器：无
    pixels.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4)
  }

  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(size, 0)
  ihdr.writeUInt32BE(size, 4)
  ihdr[8] = 8 // 位深
  ihdr[9] = 6 // 颜色类型：RGBA
  ihdr[10] = 0
  ihdr[11] = 0
  ihdr[12] = 0

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0))
  ])
}

/** 组装 ICO（PNG 压缩格式） */
function makeIco(entries) {
  const header = Buffer.alloc(6)
  header.writeUInt16LE(0, 0) // reserved
  header.writeUInt16LE(1, 2) // type: icon
  header.writeUInt16LE(entries.length, 4)

  const directory = Buffer.alloc(16 * entries.length)
  let offset = 6 + directory.length

  entries.forEach((entry, index) => {
    const base = index * 16
    directory[base] = entry.size >= 256 ? 0 : entry.size
    directory[base + 1] = entry.size >= 256 ? 0 : entry.size
    directory[base + 2] = 0 // 调色板
    directory[base + 3] = 0 // reserved
    directory.writeUInt16LE(1, base + 4) // 颜色平面
    directory.writeUInt16LE(32, base + 6) // 位深
    directory.writeUInt32LE(entry.data.length, base + 8)
    directory.writeUInt32LE(offset, base + 12)
    offset += entry.data.length
  })

  return Buffer.concat([header, directory, ...entries.map((entry) => entry.data)])
}

mkdirSync(BUILD_DIR, { recursive: true })

const entries = SIZES.map((size) => ({ size, data: makePng(size) }))

// 单张 PNG（有些平台会用到）
writeFileSync(join(BUILD_DIR, 'icon.png'), entries[entries.length - 1].data)
// Windows 安装包用的 ICO
const ico = makeIco(entries)
writeFileSync(join(BUILD_DIR, 'icon.ico'), ico)

const digest = createHash('sha256').update(ico).digest('hex').slice(0, 16)
process.stdout.write(`已生成图标：build/icon.ico（${SIZES.join('/')} 六种尺寸，共 ${ico.length} 字节，sha256:${digest}…）\n`)
process.stdout.write('已生成图标：build/icon.png（256×256 预览）\n')
