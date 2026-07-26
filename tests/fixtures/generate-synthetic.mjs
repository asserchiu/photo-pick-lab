import { writeFileSync } from 'node:fs'
import { deflateSync } from 'node:zlib'

const WIDTH = 800
const HEIGHT = 600

function crc32(buffer) {
  let crc = 0xffffffff
  for (const byte of buffer) {
    crc ^= byte
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0)
    }
  }
  return (crc ^ 0xffffffff) >>> 0
}

function chunk(type, data) {
  const name = Buffer.from(type)
  const length = Buffer.alloc(4)
  length.writeUInt32BE(data.length)
  const checksum = Buffer.alloc(4)
  checksum.writeUInt32BE(crc32(Buffer.concat([name, data])))
  return Buffer.concat([length, name, data, checksum])
}

function png(width, height, rgba) {
  const header = Buffer.alloc(13)
  header.writeUInt32BE(width, 0)
  header.writeUInt32BE(height, 4)
  header[8] = 8
  header[9] = 6
  const rows = Buffer.alloc(height * (width * 4 + 1))
  for (let y = 0; y < height; y += 1) {
    const rowOffset = y * (width * 4 + 1)
    rows[rowOffset] = 0
    rgba.copy(rows, rowOffset + 1, y * width * 4, (y + 1) * width * 4)
  }
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(rows, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

function clampByte(value) {
  return Math.max(0, Math.min(255, Math.round(value)))
}

function moonImage({ radius, softness = 0, texture = 1, clipped = false }) {
  const rgba = Buffer.alloc(WIDTH * HEIGHT * 4)
  const centerX = WIDTH / 2
  const centerY = HEIGHT / 2
  const craters = [
    [-0.32, -0.18, 0.17, -34],
    [0.26, -0.28, 0.12, -28],
    [0.21, 0.24, 0.2, -25],
    [-0.15, 0.31, 0.1, 22],
  ]
  for (let y = 0; y < HEIGHT; y += 1) {
    for (let x = 0; x < WIDTH; x += 1) {
      const offset = (y * WIDTH + x) * 4
      const dx = x + 0.5 - centerX
      const dy = y + 0.5 - centerY
      const distance = Math.hypot(dx, dy)
      const edgeCoverage = softness <= 0
        ? (distance <= radius ? 1 : 0)
        : Math.max(0, Math.min(1, (radius + softness - distance) / (softness * 2)))
      let value = 5 + ((x * 17 + y * 31) % 29 === 0 ? 2 : 0)
      if (edgeCoverage > 0) {
        let surface = clipped ? 255 : 205
        if (!clipped) {
          surface += texture * (
            Math.sin(x * 0.21) * 9 + Math.cos(y * 0.17) * 8 +
            Math.sin((x + y) * 0.08) * 6
          )
          for (const [cx, cy, craterRadius, delta] of craters) {
            const craterDistance = Math.hypot(dx / radius - cx, dy / radius - cy)
            if (craterDistance < craterRadius) surface += delta * texture
          }
        }
        value = value * (1 - edgeCoverage) + surface * edgeCoverage
      }
      const byte = clampByte(value)
      rgba[offset] = byte
      rgba[offset + 1] = clampByte(byte * 0.98)
      rgba[offset + 2] = clampByte(byte * 0.9)
      rgba[offset + 3] = 255
    }
  }
  return png(WIDTH, HEIGHT, rgba)
}

writeFileSync(new URL('./generated/moon-small-sharp.png', import.meta.url), moonImage({ radius: 82 }))
writeFileSync(new URL('./generated/moon-large-sharp.png', import.meta.url), moonImage({ radius: 108 }))
writeFileSync(
  new URL('./generated/moon-large-soft.png', import.meta.url),
  moonImage({ radius: 108, softness: 8, texture: 0.12 }),
)
writeFileSync(
  new URL('./generated/moon-large-clipped.png', import.meta.url),
  moonImage({ radius: 108, clipped: true }),
)
writeFileSync(new URL('./generated/corrupt.png', import.meta.url), Buffer.from('not a png'))
