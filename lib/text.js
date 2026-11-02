import { win32 } from './win32.js'

/**
 * Text rendering through GDI.
 *
 * The toolbar font in `overlay.js` is a 5x7 bitmap covering Latin capitals only,
 * which is fine for `COPY` but useless for recognised Chinese. Everything that
 * has to show real text goes through `DrawTextW` into the same DIB the layered
 * window presents, so no font file or extra dependency is involved.
 */

/** `SetBkMode` constant meaning "leave the background untouched". */
const TRANSPARENT = 1
const DT_LEFT = 0x0000
const DT_TOP = 0x0000
const DT_CENTER = 0x0001
const DT_WORDBREAK = 0x0010
const DT_NOPREFIX = 0x0800
const DT_CALCRECT = 0x0400
const DT_END_ELLIPSIS = 0x8000
const DT_SINGLELINE = 0x0020

/** GDI wants `0x00BBGGRR`, the reverse of the `{ r, g, b }` used everywhere else. */
export function colorRef(colour) {
  return (((colour.b & 0xff) << 16) | ((colour.g & 0xff) << 8) | (colour.r & 0xff)) >>> 0
}

/** Faces tried in order; the first one Windows resolves wins. */
const FACES = ['Microsoft YaHei UI', 'Microsoft YaHei', 'Segoe UI']

/**
 * A drawing context bound to one bitmap's DIB section.
 *
 * GDI writes straight into the DIB, so callers must `bitmap.upload()` first and
 * present with `{ upload: false }` afterwards.
 */
export class TextContext {
  /**
   * @param bitmap - the DIB-backed target.
   * @param options - `size` in pixels, `bold`, and an optional face override.
   */
  constructor(bitmap, options = {}) {
    const { api } = win32()
    this.bitmap = bitmap
    this.disposed = false
    bitmap.ensureNative()
    this.dc = api.gdiCreateCompatibleDC(0)
    if (!this.dc) throw new Error('dsh-screenshot: CreateCompatibleDC failed')
    this.previousBitmap = api.gdiSelectObject(this.dc, bitmap.handle)
    api.gdiSetBkMode(this.dc, TRANSPARENT)
    this.fonts = new Map()
    this.size = options.size ?? 14
    this.bold = options.bold === true
    this.face = options.face
    this.font = this.fontFor(this.size, this.bold, this.face)
    this.previousFont = this.font ? api.gdiSelectObject(this.dc, this.font) : 0
  }

  /** Create (and cache) a font for one size/weight pair. */
  fontFor(size, bold, face) {
    const key = `${size}:${bold ? 1 : 0}:${face ?? ''}`
    const cached = this.fonts.get(key)
    if (cached !== undefined) return cached
    const { api } = win32()
    const faces = face === undefined ? FACES : [face, ...FACES]
    let handle = 0
    for (const candidate of faces) {
      // A negative height asks for character height rather than cell height.
      handle = api.gdiCreateFontW(
        -Math.round(size), 0, 0, 0,
        bold ? 700 : 400,
        0, 0, 0,
        1, // DEFAULT_CHARSET, so CJK resolves through the system fallback
        0, 0,
        5, // CLEARTYPE_QUALITY
        0,
        candidate,
      )
      if (handle) break
    }
    this.fonts.set(key, handle)
    return handle
  }

  /** Select a size/weight for the next draws. */
  use(size, bold = this.bold) {
    const font = this.fontFor(size, bold, this.face)
    if (!font || font === this.font) return
    const { api } = win32()
    api.gdiSelectObject(this.dc, font)
    this.font = font
  }

  /**
   * Measure how tall `text` becomes when wrapped to `width`.
   * @returns the height in pixels.
   */
  measure(text, width) {
    const { api } = win32()
    const rect = { left: 0, top: 0, right: Math.max(1, Math.round(width)), bottom: 0 }
    api.gdiDrawTextW(this.dc, text, -1, rect, DT_CALCRECT | DT_WORDBREAK | DT_NOPREFIX)
    return Math.max(0, rect.bottom)
  }

  /** Measure a single line's width. */
  measureLine(text) {
    return this.extent(text).cx
  }

  /**
   * Measure a single line's width and text height.
   *
   * The height is what centres a label inside a button: `DrawTextW` anchors to
   * the top of the box, so the caller has to offset by half the text height.
   * @returns `{ cx, cy }` in pixels.
   */
  extent(text) {
    const { api } = win32()
    const size = { cx: 0, cy: 0 }
    api.gdiGetTextExtentPoint32W(this.dc, text, [...text].length, size)
    return size
  }

  /**
   * Draw wrapped text clipped to a box.
   * @returns the number of pixels actually used.
   */
  draw(text, box, options = {}) {
    const { api } = win32()
    const rect = {
      left: Math.round(box.left),
      top: Math.round(box.top),
      right: Math.round(box.right),
      bottom: Math.round(box.bottom),
    }
    api.gdiSetTextColor(this.dc, colorRef(options.colour ?? { r: 235, g: 238, b: 244 }))
    let flags = DT_LEFT | DT_TOP | DT_WORDBREAK | DT_NOPREFIX
    if (options.ellipsis === true) flags |= DT_END_ELLIPSIS
    if (options.singleLine === true) flags = DT_LEFT | DT_TOP | DT_NOPREFIX | DT_SINGLELINE
    if (options.center === true) flags = (flags & ~DT_LEFT) | DT_CENTER
    return api.gdiDrawTextW(this.dc, text, -1, rect, flags)
  }

  /** Release the DC and every font created for it. */
  dispose() {
    if (this.disposed) return
    this.disposed = true
    const { api } = win32()
    try {
      if (this.previousFont) api.gdiSelectObject(this.dc, this.previousFont)
      for (const handle of this.fonts.values()) {
        if (handle) api.gdiDeleteObject(handle)
      }
      this.fonts.clear()
      if (this.previousBitmap) api.gdiSelectObject(this.dc, this.previousBitmap)
      api.gdiDeleteDC(this.dc)
    } catch { /* the window may already be gone */ }
  }
}
