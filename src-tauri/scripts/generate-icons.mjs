/**
 * 生成桌面图标集合（无第三方依赖，Node 内置 zlib 即可）。
 *
 * 造型与应用内 .brand-mark 一致：圆角色块 + 白色坐标轴 + 右上数据点。
 * 关键点：不同尺寸做光学补偿 —— 尺寸越小，图形占画布比例越大、线宽越粗，
 * 保证 Windows 16/24/32 这类小尺寸下视觉重量足够，而不是沿用大图的等比缩小。
 *
 * 用法：node src-tauri/scripts/generate-icons.mjs
 */
import { deflateSync } from 'node:zlib'
import { writeFileSync, mkdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const HERE = dirname(fileURLToPath(import.meta.url))
const ICONS = join(HERE, '..', 'icons')
const TAURI = join(HERE, '..')

const TILE = [0x4a, 0x7c, 0x7b]
const WHITE = [255, 255, 255]

/** 各尺寸的几何参数（均为画布比例）：留白、线宽、数据点直径 */
function geo(S) {
  const t =
    S <= 16 ? { inset: 0.19, stroke: 0.125, dot: 0.1875 } :
    S <= 24 ? { inset: 0.18, stroke: 0.1, dot: 0.167 } :
    S <= 32 ? { inset: 0.17, stroke: 0.075, dot: 0.15 } :
    S <= 48 ? { inset: 0.18, stroke: 0.068, dot: 0.15 } :
    S <= 64 ? { inset: 0.185, stroke: 0.065, dot: 0.152 } :
    S <= 128 ? { inset: 0.19, stroke: 0.064, dot: 0.158 } :
    { inset: 0.2002, stroke: 0.0645, dot: 0.1602 }
  const x0 = t.inset * S
  const x1 = S - x0
  const box = x1 - x0
  return {
    x0,
    y0: x0,
    x1,
    y1: x1,
    stroke: t.stroke * S,
    dotR: (t.dot * S) / 2,
    // 数据点沿用造型里的位置：右上、略超出坐标轴右端
    dotX: x1 - 0.0554 * box,
    dotY: x0 + 0.1808 * box,
    radius: 0.219 * S
  }
}

function distSeg(px, py, ax, ay, bx, by) {
  const dx = bx - ax
  const dy = by - ay
  const len2 = dx * dx + dy * dy
  const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len2))
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy))
}

/** 超采样渲染，返回 RGBA 像素 */
function render(S) {
  const g = geo(S)
  const ss = S <= 32 ? 8 : S <= 64 ? 6 : S <= 256 ? 4 : 2
  const W = S * ss
  const tile = new Float32Array(S * S)
  const glyph = new Float32Array(S * S)
  const half = S / 2
  const inner = half - g.radius
  const strokeHalf = g.stroke / 2

  for (let sy = 0; sy < W; sy++) {
    const py = (sy + 0.5) / ss
    const row = Math.floor(py) * S
    for (let sx = 0; sx < W; sx++) {
      const px = (sx + 0.5) / ss
      const qx = Math.abs(px - half) - inner
      const qy = Math.abs(py - half) - inner
      const sd = Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - g.radius
      if (sd > 0) continue
      const i = row + Math.floor(px)
      tile[i] += 1
      const dv = distSeg(px, py, g.x0, g.y0, g.x0, g.y1)
      const dh = distSeg(px, py, g.x0, g.y1, g.x1, g.y1)
      const dc = Math.hypot(px - g.dotX, py - g.dotY)
      if (Math.min(dv, dh) <= strokeHalf || dc <= g.dotR) glyph[i] += 1
    }
  }

  const out = Buffer.alloc(S * S * 4)
  const n = ss * ss
  for (let i = 0; i < S * S; i++) {
    const ta = tile[i] / n
    const ga = glyph[i] / n
    const k = ta > 0 ? Math.min(1, ga / ta) : 0
    out[i * 4] = Math.round(TILE[0] * (1 - k) + WHITE[0] * k)
    out[i * 4 + 1] = Math.round(TILE[1] * (1 - k) + WHITE[1] * k)
    out[i * 4 + 2] = Math.round(TILE[2] * (1 - k) + WHITE[2] * k)
    out[i * 4 + 3] = Math.round(ta * 255)
  }
  return out
}

const CRC = (() => {
  const table = new Int32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c
  }
  return table
})()

function crc32(buf) {
  let c = -1
  for (const b of buf) c = CRC[(c ^ b) & 255] ^ (c >>> 8)
  return (c ^ -1) >>> 0
}

function chunk(type, data) {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length)
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(body))
  return Buffer.concat([len, body, crc])
}

function png(S, rgba) {
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(S, 0)
  ihdr.writeUInt32BE(S, 4)
  ihdr[8] = 8
  ihdr[9] = 6
  const raw = Buffer.alloc((S * 4 + 1) * S)
  for (let y = 0; y < S; y++) {
    raw[y * (S * 4 + 1)] = 0
    rgba.copy(raw, y * (S * 4 + 1) + 1, y * S * 4, (y + 1) * S * 4)
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0))
  ])
}

const cache = new Map()
function pngOf(S) {
  if (!cache.has(S)) cache.set(S, png(S, render(S)))
  return cache.get(S)
}

function ico(sizes) {
  const frames = sizes.map((S) => pngOf(S))
  const head = Buffer.alloc(6 + sizes.length * 16)
  head.writeUInt16LE(0, 0)
  head.writeUInt16LE(1, 2)
  head.writeUInt16LE(sizes.length, 4)
  let offset = head.length
  sizes.forEach((S, i) => {
    const o = 6 + i * 16
    head[o] = S >= 256 ? 0 : S
    head[o + 1] = S >= 256 ? 0 : S
    head[o + 2] = 0
    head[o + 3] = 0
    head.writeUInt16LE(1, o + 4)
    head.writeUInt16LE(32, o + 6)
    head.writeUInt32LE(frames[i].length, o + 8)
    head.writeUInt32LE(offset, o + 12)
    offset += frames[i].length
  })
  return Buffer.concat([head, ...frames])
}

function icns(entries) {
  const parts = entries.map(([type, S]) => {
    const data = pngOf(S)
    const head = Buffer.alloc(8)
    head.write(type, 0, 'ascii')
    head.writeUInt32BE(data.length + 8, 4)
    return Buffer.concat([head, data])
  })
  const body = Buffer.concat(parts)
  const head = Buffer.alloc(8)
  head.write('icns', 0, 'ascii')
  head.writeUInt32BE(body.length + 8, 4)
  return Buffer.concat([head, body])
}

mkdirSync(ICONS, { recursive: true })
const written = []
function put(path, buf) {
  writeFileSync(path, buf)
  written.push([path.replace(TAURI + '\\', ''), buf.length])
}

put(join(ICONS, 'icon.ico'), ico([16, 24, 32, 48, 64, 128, 256]))
put(join(ICONS, '32x32.png'), pngOf(32))
put(join(ICONS, '64x64.png'), pngOf(64))
put(join(ICONS, '128x128.png'), pngOf(128))
put(join(ICONS, '128x128@2x.png'), pngOf(256))
put(join(ICONS, 'icon.png'), pngOf(512))
put(join(TAURI, 'app-icon.png'), pngOf(1024))
put(join(ICONS, 'icon.icns'), icns([
  ['icp4', 16], ['icp5', 32], ['icp6', 64],
  ['ic07', 128], ['ic08', 256], ['ic09', 512], ['ic10', 1024],
  ['ic11', 32], ['ic12', 64], ['ic13', 256], ['ic14', 512]
]))
for (const [name, S] of [
  ['StoreLogo.png', 50],
  ['Square30x30Logo.png', 30],
  ['Square44x44Logo.png', 44],
  ['Square71x71Logo.png', 71],
  ['Square89x89Logo.png', 89],
  ['Square107x107Logo.png', 107],
  ['Square142x142Logo.png', 142],
  ['Square150x150Logo.png', 150],
  ['Square284x284Logo.png', 284],
  ['Square310x310Logo.png', 310]
]) put(join(ICONS, name), pngOf(S))

for (const [f, size] of written) console.log(`${String(size).padStart(8)}  ${f}`)
