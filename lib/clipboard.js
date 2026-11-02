import { win32 } from './win32.js'
import { deflateSync } from 'node:zlib'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/** `CF_DIB` is the un-numbered clipboard format every Windows image sink reads. */
const CF_DIB = 8
/** `CF_UNICODETEXT` is UTF-16LE text, which every editor pastes cleanly. */
const CF_UNICODETEXT = 13
/** `GlobalAlloc` flag for a handle the clipboard can take ownership of. */
const GMEM_MOVEABLE = 0x0002

const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let index = 0; index < 256; index += 1) {
    let value = index
    for (let bit = 0; bit < 8; bit += 1) {
      value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1
    }
    table[index] = value >>> 0
  }
  return table
})()

/** @returns the CRC-32 of a buffer, as PNG expects it. */
function crc32(buffer) {
  let crc = 0xffffffff
  for (const byte of buffer) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8)
  return (crc ^ 0xffffffff) >>> 0
}

/** Build one PNG chunk. */
function chunk(type, data) {
  const length = Buffer.alloc(4)
  length.writeUInt32BE(data.length, 0)
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const checksum = Buffer.alloc(4)
  checksum.writeUInt32BE(crc32(body), 0)
  return Buffer.concat([length, body, checksum])
}

/**
 * Encode a BGRA bitmap as PNG.
 *
 * Alpha is emitted only when the image actually carries transparency, so a
 * desktop screenshot stays an RGB image and compresses well.
 * @param bitmap - a captured bitmap.
 * @returns the PNG file bytes.
 */
export function encodePng(bitmap) {
  const { width, height, stride } = bitmap
  const pixels = bitmap.bytes()
  let opaque = true
  for (let index = 3; index < pixels.length; index += 4) {
    if (pixels[index] !== 255) {
      opaque = false
      break
    }
  }
  const channels = opaque ? 3 : 4
  // Filter 0 (`None`) per row: no prediction, but zlib still finds the runs.
  const raw = Buffer.alloc((width * channels + 1) * height)
  let offset = 0
  for (let y = 0; y < height; y += 1) {
    raw[offset] = 0
    offset += 1
    const row = y * stride
    for (let x = 0; x < width; x += 1) {
      const index = row + x * 4
      raw[offset] = pixels[index + 2]
      raw[offset + 1] = pixels[index + 1]
      raw[offset + 2] = pixels[index]
      offset += 3
      if (channels === 4) {
        raw[offset] = pixels[index + 3]
        offset += 1
      }
    }
  }
  const header = Buffer.alloc(13)
  header.writeUInt32BE(width, 0)
  header.writeUInt32BE(height, 4)
  header[8] = 8
  header[9] = channels === 4 ? 6 : 2
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(raw, { level: 6 })),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

/**
 * Encode a 32-bit DIB in the canonical clipboard layout.
 *
 * The bitmap itself is top-down, but `CF_DIB` consumers — Word, Paint, WeChat —
 * expect a bottom-up image with a positive height, so the rows are flipped here.
 * @param bitmap - a captured bitmap.
 * @returns the DIB bytes.
 */
export function encodeDib(bitmap) {
  const { width, height, stride } = bitmap
  const header = Buffer.alloc(40)
  header.writeUInt32LE(40, 0)
  header.writeInt32LE(width, 4)
  header.writeInt32LE(height, 8)
  header.writeUInt16LE(1, 12)
  header.writeUInt16LE(32, 14)
  header.writeUInt32LE(0, 16) // BI_RGB
  header.writeUInt32LE(stride * height, 20)
  const source = bitmap.bytes()
  const body = Buffer.alloc(stride * height)
  for (let row = 0; row < height; row += 1) {
    // Bottom-up: the last source row becomes the first stored row.
    source.copy(body, row * stride, (height - 1 - row) * stride, (height - row) * stride)
  }
  return Buffer.concat([header, body])
}

/**
 * Copy raw bytes into a fresh HGLOBAL, transferring ownership to the clipboard.
 * @returns the handle, or `0` when the allocation failed.
 */
function globalFromBuffer(bytes) {
  const { koffi, api } = win32()
  const handle = api.kernelGlobalAlloc(GMEM_MOVEABLE, bytes.length)
  if (!handle) return 0
  const pointer = api.kernelGlobalLock(handle)
  if (!pointer) {
    api.kernelGlobalFree(handle)
    return 0
  }
  // `koffi.decode` hands back a copy, so writing through it would leave the
  // native block untouched; `koffi.encode` stores straight into native memory.
  koffi.encode(pointer, 'uint8', bytes, bytes.length)
  api.kernelGlobalUnlock(handle)
  return handle
}

/**
 * Put plain text on the clipboard as `CF_UNICODETEXT`.
 * @param value - the text to publish.
 * @returns `true` when the clipboard accepted it.
 */
export function writeClipboardText(value) {
  const { api } = win32()
  const text = String(value ?? '')
  if (text.length === 0) return false
  // The format is UTF-16 with a terminating NUL.
  const body = Buffer.from(`${text}\0`, 'utf16le')
  let opened = false
  for (let attempt = 0; attempt < 16 && !opened; attempt += 1) {
    opened = api.openClipboard(null)
  }
  if (!opened) return false
  try {
    if (!api.emptyClipboard()) return false
    const handle = globalFromBuffer(body)
    if (!handle) return false
    if (!api.setClipboardData(CF_UNICODETEXT, handle)) {
      api.kernelGlobalFree(handle)
      return false
    }
    return true
  } finally {
    api.closeClipboard()
  }
}

/**
 * Put a screenshot on the clipboard as `CF_DIB`, plus `PNG` when the shell
 * exposes that format, so both classic image sinks and modern apps are happy.
 * @param bitmap - the selection to publish.
 * @returns `true` when the DIB was accepted.
 */
export function writeClipboard(bitmap) {
  const { api } = win32()
  const dib = encodeDib(bitmap)
  const pngFormat = api.registerClipboardFormatW('PNG')
  const png = pngFormat !== 0 ? encodePng(bitmap) : undefined
  // Another process can hold the clipboard open for a moment; retry briefly
  // rather than dropping the shot.
  let opened = false
  for (let attempt = 0; attempt < 16 && !opened; attempt += 1) {
    opened = api.openClipboard(null)
  }
  if (!opened) return false
  try {
    if (!api.emptyClipboard()) return false
    const dibHandle = globalFromBuffer(dib)
    if (!dibHandle) return false
    if (!api.setClipboardData(CF_DIB, dibHandle)) {
      api.kernelGlobalFree(dibHandle)
      return false
    }
    if (png !== undefined) {
      const pngHandle = globalFromBuffer(png)
      if (pngHandle && !api.setClipboardData(pngFormat, pngHandle)) api.kernelGlobalFree(pngHandle)
    }
    return true
  } finally {
    api.closeClipboard()
  }
}

/** @returns a `yyyyMMdd-HHmmss` stamp for file names. */
function stamp(date = new Date()) {
  const pad = (value) => String(value).padStart(2, '0')
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}`
    + `-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`
}

/**
 * Write a selection to disk as PNG, never overwriting an existing file.
 * @param bitmap - the selection to save.
 * @param directory - the target directory; created when missing.
 * @returns the absolute path that was written.
 */
export function savePng(bitmap, directory) {
  mkdirSync(directory, { recursive: true })
  const bytes = encodePng(bitmap)
  const base = `screenshot-${stamp()}`
  for (let attempt = 0; attempt < 1000; attempt += 1) {
    const name = attempt === 0 ? `${base}.png` : `${base}-${attempt}.png`
    const target = join(directory, name)
    try {
      writeFileSync(target, bytes, { flag: 'wx' })
      return target
    } catch (error) {
      if (error?.code === 'EEXIST') continue
      throw error
    }
  }
  throw new Error(`dsh-screenshot: could not pick a free file name in ${directory}`)
}
