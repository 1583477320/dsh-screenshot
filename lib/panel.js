import {
  win32,
  AC_SRC_ALPHA,
  ULW_ALPHA,
  WS_POPUP,
  WS_EX_LAYERED,
  WS_EX_TOPMOST,
  WS_EX_TOOLWINDOW,
  WS_EX_NOACTIVATE,
  SWP_NOACTIVATE,
  SWP_SHOWWINDOW,
} from './win32.js'
import { Bitmap } from './screen.js'
import { TextContext } from './text.js'
import { record } from './diag.js'

/** Card metrics in 96-DPI units. */
const METRICS = {
  width: 380,
  padding: 16,
  radius: 16,
  // Empty column on the left: the leader line lives there, outside the card.
  gutter: 18,
  // Room around the card for the soft shadow.
  shadow: 14,
  gap: 14,
  glyph: 22,
  headerGap: 12,
  footerGap: 12,
  footer: 15,
  body: 15,
  title: 12,
  meta: 10,
  small: 11,
  fade: 34,
  tether: 26,
  limit: 8,
  maxHeight: 0.62,
  masks: 9000,
}

/**
 * The glass tint. Everything under the card is a heavy blur of the frozen frame,
 * then this colour is laid over it — the same thing `backdrop-filter` does.
 */
const GLASS = { r: 20, g: 22, b: 28 }
const GLASS_MIX = 0.74
const VEIL_GAIN = 0.64
const VEIL_LIFT = 10

const INK = { r: 238, g: 243, b: 251 }
const TITLE_INK = { r: 236, g: 241, b: 250 }
const META_INK = { r: 124, g: 131, b: 146 }
const FOOT_INK = { r: 99, g: 106, b: 120 }
const ACCENT = { r: 58, g: 134, b: 255 }
const FAIL = { r: 255, g: 120, b: 120 }
const WHITE = { r: 255, g: 255, b: 255 }
const BLACK = { r: 0, g: 0, b: 0 }

function clamped(value, low, high) {
  return value < low ? low : (value > high ? high : value)
}

/** Signed distance to a rounded rectangle: negative inside. */
function roundedDistance(x, y, left, top, right, bottom, radius) {
  const halfWidth = (right - left) / 2
  const halfHeight = (bottom - top) / 2
  const centreX = left + halfWidth
  const centreY = top + halfHeight
  const qx = Math.abs(x - centreX) - (halfWidth - radius)
  const qy = Math.abs(y - centreY) - (halfHeight - radius)
  const outside = Math.hypot(Math.max(qx, 0), Math.max(qy, 0))
  const inside = Math.min(Math.max(qx, qy), 0)
  return outside + inside - radius
}

/**
 * Write one pixel.
 *
 * `UpdateLayeredWindow` with `AC_SRC_ALPHA` expects premultiplied colours, so a
 * half-transparent shadow pixel carries half its brightness too.
 */
function put(pixels, index, colour, alpha) {
  if (alpha <= 0) return
  const a = alpha > 1 ? 1 : alpha
  pixels[index] = Math.round(colour.b * a)
  pixels[index + 1] = Math.round(colour.g * a)
  pixels[index + 2] = Math.round(colour.r * a)
  pixels[index + 3] = Math.round(255 * a)
}

/** Blend a colour over an opaque pixel (alpha is left untouched). */
function blend(pixels, index, colour, alpha) {
  if (alpha <= 0) return
  const a = alpha > 1 ? 1 : alpha
  const b = 1 - a
  pixels[index] = Math.round(pixels[index] * b + colour.b * a)
  pixels[index + 1] = Math.round(pixels[index + 1] * b + colour.g * a)
  pixels[index + 2] = Math.round(pixels[index + 2] * b + colour.r * a)
}

/**
 * A floating result card, pinned beside the selection it came from.
 *
 * The point of the card is that the screenshot stays on screen: the overlay, the
 * selection and the toolbar are never torn down, so the text always has a
 * visible source. The card is a separate layered window that never takes the
 * foreground; `Esc` closes it and leaves the shot alone.
 */
export class ResultCard {
  constructor(options) {
    this.className = options.className
    this.handle = 0
    this.scale = 1
    this.frame = undefined
    this.mask = undefined
    this.maskHeight = 0
    this.bitmap = undefined
    this.text = undefined
    this.layout = undefined
    this.scrollOffset = 0
    this.textHeight = 0
    this.visibleBody = 0
    this.scrollable = false
    this.left = 0
    this.top = 0
    this.width = 0
    this.height = 0
  }

  /** @returns whether a window handle belongs to this card. */
  owns(handle) {
    return this.handle !== 0 && String(handle) === String(this.handle)
  }

  /** @returns whether a screen point falls on the card itself. */
  contains(x, y) {
    return this.handle !== 0
      && x >= this.left && x < this.left + this.width
      && y >= this.top && y < this.top + this.height
  }

  /**
   * Build and show the card.
   *
   * @param options - the text to show, its labels, the frozen `capture` the glass
   *   is sampled from, the selection it belongs to, and the monitor to stay on.
   */
  open(options) {
    this.close()
    const scale = options.scale ?? 1
    this.scale = scale
    const unit = (value) => Math.max(1, Math.round(value * scale))

    const text = typeof options.text === 'string' ? options.text : ''
    const title = options.title ?? '已提取文字'
    const meta = options.meta ?? ''
    const count = options.count ?? ''
    const hint = options.hint ?? 'Esc 关闭'
    const failed = options.failed === true
    const accent = failed ? FAIL : ACCENT

    const width = unit(METRICS.width)
    const padding = unit(METRICS.padding)
    const radius = unit(METRICS.radius)
    const gutter = unit(METRICS.gutter)
    const shadow = unit(METRICS.shadow)
    const headerGap = unit(METRICS.headerGap)
    const footerGap = unit(METRICS.footerGap)
    const footerHeight = unit(METRICS.footer)
    const glyph = unit(METRICS.glyph)
    const bodyFont = unit(METRICS.body)
    const titleFont = unit(METRICS.title)
    const metaFont = unit(METRICS.meta)
    const smallFont = unit(METRICS.small)
    const innerWidth = width - padding * 2

    // Measure with a throwaway context so the window is created at its final
    // size; resizing a layered window flashes.
    let textHeight = 0
    let lineHeight = 0
    let metaWidth = 0
    let countWidth = 0
    let hintWidth = 0
    const scratch = new Bitmap(8, 8)
    const measurer = new TextContext(scratch, { size: bodyFont })
    try {
      measurer.use(bodyFont, false)
      textHeight = measurer.measure(text, innerWidth)
      lineHeight = measurer.measure('国', innerWidth)
      textHeight = Math.max(textHeight, lineHeight)
      if (meta.length > 0) {
        measurer.use(metaFont, false)
        metaWidth = measurer.extent(meta).cx
      }
      measurer.use(smallFont, false)
      if (count.length > 0) countWidth = measurer.extent(count).cx
      if (hint.length > 0) hintWidth = measurer.extent(hint).cx
    } finally {
      measurer.dispose()
      scratch.dispose()
    }

    const display = options.display
    const displayHeight = display.bottom - display.top
    const chrome = padding * 2 + glyph + headerGap + footerGap + footerHeight
    const allowed = Math.max(lineHeight * 3, Math.round(displayHeight * METRICS.maxHeight) - chrome)
    const visibleBody = Math.min(textHeight, allowed)
    const cardHeight = chrome + visibleBody
    const scrollable = textHeight > visibleBody + 1

    const headerTop = padding
    const bodyTop = padding + glyph + headerGap
    const footerTop = bodyTop + visibleBody + footerGap

    // ---- placement: right of the selection, then below, left, centred ----
    const selection = options.selection ?? {
      x: display.left, y: display.top, w: 0, h: 0,
    }
    const selectionRight = selection.x + selection.w
    const selectionBottom = selection.y + selection.h
    const gap = unit(METRICS.gap)
    const limit = unit(METRICS.limit)
    let mode = 'right'
    let left = selectionRight + gap
    let top = selection.y
    if (left + width + shadow > display.right - limit) {
      mode = 'below'
      left = selection.x
      top = selectionBottom + gap
      if (top + cardHeight + shadow > display.bottom - limit) {
        mode = 'left'
        left = selection.x - gap - width
        top = selection.y
        if (left - shadow < display.left + limit) {
          mode = 'center'
          left = display.left + (display.right - display.left - width) / 2
          top = display.top + (display.bottom - display.top - cardHeight) / 2
        }
      }
    }
    // The toolbar and the card both want the strip under the selection. If the
    // card landed on the bar, slide past it; failing that sit above it, and as a
    // last resort centre on the monitor.
    const avoid = options.avoid
    if (avoid !== undefined
      && left < avoid.right && left + width > avoid.left
      && top < avoid.bottom && top + cardHeight > avoid.top) {
      const below = avoid.bottom + gap
      const above = avoid.top - cardHeight - gap
      if (below + cardHeight <= display.bottom - limit) top = below
      else if (above >= display.top + limit) top = above
      else top = display.top + Math.round((displayHeight - cardHeight) / 2)
    }
    top = clamped(top, display.top + limit, display.bottom - limit - cardHeight)
    left = clamped(left, display.left + limit, display.right - limit - width)
    left = Math.round(left)
    top = Math.round(top)

    const windowWidth = gutter + width + shadow
    const windowHeight = cardHeight + shadow * 2
    const windowLeft = left - gutter
    const windowTop = top - shadow
    const cardX = gutter
    const cardY = shadow
    const cardLeft = cardX
    const cardTop = cardY
    const cardRight = cardX + width
    const cardBottom = cardY + cardHeight

    const { api } = win32()
    const handle = api.createWindowExW(
      WS_EX_LAYERED | WS_EX_TOPMOST | WS_EX_TOOLWINDOW | WS_EX_NOACTIVATE,
      this.className,
      '',
      WS_POPUP,
      windowLeft,
      windowTop,
      windowWidth,
      windowHeight,
      null,
      null,
      api.kernelGetModuleHandleW(null),
      null,
    )
    if (!handle) {
      record(`card: CreateWindowEx failed (${api.kernelGetLastError()})`)
      return 0
    }

    const bitmap = new Bitmap(windowWidth, windowHeight)
    this.handle = handle
    this.bitmap = bitmap
    this.width = width
    this.height = cardHeight
    this.left = left
    this.top = top
    this.visibleBody = visibleBody
    this.textHeight = textHeight
    this.scrollable = scrollable
    this.scrollOffset = 0

    // ---- pass one: shadow, glass, border and the leader line ----
    const pixels = bitmap.refresh()
    const stride = bitmap.stride
    pixels.fill(0)
    const source = options.capture?.bitmap
    const bounds = options.bounds
    // The card sits over the veiled desktop, so the glass is built from the
    // frozen frame *after* the veil — otherwise it reads brighter than the rest
    // of the shot.
    const sample = (screenX, screenY) => {
      if (source === undefined || source.pixels === undefined || bounds === undefined) return BLACK
      const x = clamped(Math.round(screenX), bounds.left, bounds.left + source.width - 1)
      const y = clamped(Math.round(screenY), bounds.top, bounds.top + source.height - 1)
      const index = (y - bounds.top) * source.stride + (x - bounds.left) * 4
      return {
        r: source.pixels[index + 2] * VEIL_GAIN + VEIL_LIFT,
        g: source.pixels[index + 1] * VEIL_GAIN + VEIL_LIFT,
        b: source.pixels[index] * VEIL_GAIN + VEIL_LIFT,
      }
    }
    // A nine-tap average over a 4 px grid is a cheap heavy blur: the card is
    // small and this runs once per open plus once per scroll.
    const blurStep = Math.max(2, unit(4))
    const blurAt = (x, y) => {
      let r = 0
      let g = 0
      let b = 0
      for (let dy = -1; dy <= 1; dy += 1) {
        for (let dx = -1; dx <= 1; dx += 1) {
          const colour = sample(
            windowLeft + x + dx * blurStep,
            windowTop + y + dy * blurStep,
          )
          r += colour.r
          g += colour.g
          b += colour.b
        }
      }
      return { r: r / 9, g: g / 9, b: b / 9 }
    }

    const finger = Math.max(1, unit(1.6))
    for (let y = 0; y < windowHeight; y += 1) {
      for (let x = 0; x < windowWidth; x += 1) {
        const index = y * stride + x * 4
        const distance = roundedDistance(x, y, cardLeft, cardTop, cardRight, cardBottom, radius)
        if (distance <= 0) {
          const base = blurAt(x, y)
          const colour = {
            r: base.r * (1 - GLASS_MIX) + GLASS.r * GLASS_MIX,
            g: base.g * (1 - GLASS_MIX) + GLASS.g * GLASS_MIX,
            b: base.b * (1 - GLASS_MIX) + GLASS.b * GLASS_MIX,
          }
          // A hairline ring lifts the card off a dark desktop.
          if (distance > -finger) {
            colour.r = colour.r * 0.91 + WHITE.r * 0.09
            colour.g = colour.g * 0.91 + WHITE.g * 0.09
            colour.b = colour.b * 0.91 + WHITE.b * 0.09
          }
          put(pixels, index, colour, 1)
          continue
        }
        // Soft shadow, offset down a touch so it reads as depth.
        const shadowDistance = roundedDistance(
          x, y - unit(4), cardLeft, cardTop, cardRight, cardBottom, radius,
        )
        if (shadowDistance > 0 && shadowDistance < shadow) {
          const falloff = 1 - shadowDistance / shadow
          put(pixels, index, BLACK, falloff * falloff * 0.55)
        }
      }
    }

    // Leader line from the card back to the selection, drawn outside the card.
    if (mode === 'right' || mode === 'left') {
      const length = gutter
      const y = cardY + unit(METRICS.tether)
      for (let step = 0; step < length; step += 1) {
        const x = mode === 'right' ? cardX - 1 - step : cardRight + step
        const alpha = 0.75 * (1 - step / length)
        if (x >= 0 && x < windowWidth) put(pixels, y * stride + x * 4, accent, alpha)
      }
    } else if (mode === 'below') {
      const x = cardX + unit(METRICS.tether)
      for (let step = 0; step < shadow; step += 1) {
        const y = cardY - 1 - step
        const alpha = 0.75 * (1 - step / shadow)
        if (y >= 0) put(pixels, y * stride + x * 4, accent, alpha)
      }
    }

    // ---- pass two: the glyph and every label, straight into the DIB ----
    // The glyph is drawn as pixels rather than a character so it stays crisp at
    // any scale and needs no fallback face.
    const glyphLeft = cardX + padding
    const glyphTop = cardY + headerTop
    const mark = (markLeft, markTop, markWidth, markHeight) => {
      for (let y = markTop; y < markTop + markHeight; y += 1) {
        for (let x = markLeft; x < markLeft + markWidth; x += 1) {
          if (x < cardX || y < cardY || x >= cardRight || y >= cardBottom) continue
          blend(pixels, y * stride + x * 4, accent, 0.9)
        }
      }
    }
    const bar = Math.max(1, Math.round(1.6 * scale))
    const glyphInset = Math.round(glyph * 0.27)
    const glyphSpan = Math.round(glyph * 0.46)
    mark(glyphLeft + glyphInset, glyphTop + Math.round(glyph * 0.29), glyphSpan, bar)
    mark(
      glyphLeft + glyphInset + Math.round((glyphSpan - bar) / 2),
      glyphTop + Math.round(glyph * 0.29),
      bar,
      Math.round(glyph * 0.42),
    )
    mark(
      glyphLeft + glyphInset + Math.round((glyphSpan - bar * 2) / 2),
      glyphTop + Math.round(glyph * 0.71),
      Math.max(bar, Math.round(glyphSpan * 0.6)),
      bar,
    )

    bitmap.upload()
    this.text = new TextContext(bitmap, { size: bodyFont })
    const context = this.text
    const labels = []
    const titleLeft = glyphLeft + glyph + unit(10)
    context.use(titleFont, true)
    const titleExtent = context.extent(title)
    labels.push({
      text: title,
      size: titleFont,
      colour: TITLE_INK,
      box: {
        left: titleLeft,
        top: glyphTop + (glyph - titleExtent.cy) / 2,
        right: titleLeft + width,
        bottom: glyphTop + glyph,
      },
    })
    if (meta.length > 0) {
      context.use(metaFont, false)
      labels.push({
        text: meta,
        size: metaFont,
        colour: META_INK,
        box: {
          left: cardRight - padding - metaWidth - unit(2),
          top: glyphTop + (glyph - unit(METRICS.meta * 1.4)) / 2,
          right: cardRight - padding,
          bottom: glyphTop + glyph,
        },
      })
    }
    // Hairline above the footer.
    const hairline = cardY + footerTop - unit(8)
    for (let x = cardX + padding; x < cardRight - padding; x += 1) {
      blend(pixels, hairline * stride + x * 4, WHITE, 0.07)
    }
    if (count.length > 0) {
      labels.push({
        text: count,
        size: smallFont,
        colour: FOOT_INK,
        box: {
          left: cardX + padding,
          top: cardY + footerTop,
          right: cardX + padding + countWidth + unit(4),
          bottom: cardY + footerTop + footerHeight,
        },
      })
    }
    if (hint.length > 0) {
      labels.push({
        text: hint,
        size: smallFont,
        colour: FOOT_INK,
        box: {
          left: cardRight - padding - hintWidth - unit(4),
          top: cardY + footerTop,
          right: cardRight - padding,
          bottom: cardY + footerTop + footerHeight,
        },
      })
    }
    // The pixels were composed by hand, so upload them first and read the text
    // back afterwards.
    bitmap.upload()
    for (const label of labels) {
      context.use(label.size, label.size === titleFont)
      context.draw(label.text, label.box, {
        colour: label.colour,
        singleLine: true,
      })
    }
    bitmap.download()

    // GDI does not maintain the alpha channel: restate it for the card body,
    // leaving the shadow's own falloff alone.
    for (let y = cardY; y < cardBottom; y += 1) {
      for (let x = cardX; x < cardRight; x += 1) {
        const index = y * stride + x * 4
        if (roundedDistance(x, y, cardLeft, cardTop, cardRight, cardBottom, radius) <= 0) {
          pixels[index + 3] = 255
        }
      }
    }

    this.frame = Buffer.from(pixels.subarray(0, stride * windowHeight))
    this.layout = {
      windowLeft, windowTop, windowWidth, windowHeight, cardX, cardY,
      cardRight, cardBottom, padding, innerWidth, bodyTop, visibleBody,
      stride, unit,
    }

    this.buildMask(text, bodyFont, innerWidth, textHeight)
    this.composite()

    api.setWindowPos(
      handle, -1, windowLeft, windowTop, windowWidth, windowHeight,
      SWP_NOACTIVATE | SWP_SHOWWINDOW,
    )
    record(`card open ${width}x${cardHeight} at ${left},${top} mode=${mode} text=${Math.round(textHeight)}px scroll=${scrollable}`)
    return handle
  }

  /**
   * Rasterise the body text once into a coverage mask.
   *
   * White on black in a scratch bitmap gives antialiased coverage for free, and
   * a mask is what makes scrolling cheap: the card is re-composited per wheel
   * tick without asking GDI for text again.
   */
  buildMask(text, bodyFont, innerWidth, textHeight) {
    const unit = this.layout.unit
    const height = Math.min(Math.max(1, Math.ceil(textHeight) + unit(4)), METRICS.masks)
    const bitmap = new Bitmap(innerWidth, height)
    const pixels = bitmap.refresh()
    pixels.fill(0)
    bitmap.upload()
    const context = new TextContext(bitmap, { size: bodyFont })
    try {
      context.use(bodyFont, false)
      context.draw(text, { left: 0, top: 0, right: innerWidth, bottom: height }, {
        colour: WHITE,
      })
      bitmap.download()
    } finally {
      context.dispose()
      bitmap.dispose()
    }
    const mask = new Uint8Array(innerWidth * height)
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < innerWidth; x += 1) {
        // The glyph is white, so one channel carries the whole coverage.
        mask[y * innerWidth + x] = pixels[y * bitmap.stride + x * 4 + 1]
      }
    }
    this.mask = mask
    this.maskHeight = height
  }

  /** Compose the static frame, the visible slice of text, and the fade. */
  composite() {
    const pixels = this.bitmap.refresh()
    this.frame.copy(pixels)
    const {
      stride, cardX, cardY, padding, innerWidth, bodyTop, visibleBody, unit,
    } = this.layout
    const mask = this.mask
    const scroll = this.scrollOffset
    for (let row = 0; row < visibleBody; row += 1) {
      const source = scroll + row
      if (source >= this.maskHeight) break
      const target = (cardY + bodyTop + row) * stride + (cardX + padding) * 4
      const base = source * innerWidth
      for (let col = 0; col < innerWidth; col += 1) {
        const alpha = mask[base + col]
        if (alpha === 0) continue
        blend(pixels, target + col * 4, INK, alpha / 255)
      }
    }
    // Long text fades into the footer instead of being sliced off.
    if (this.scrollable) {
      const fadeHeight = Math.min(unit(METRICS.fade), visibleBody)
      for (let row = 0; row < fadeHeight; row += 1) {
        const strength = (row / fadeHeight) ** 2
        const y = cardY + bodyTop + visibleBody - fadeHeight + row
        for (let col = 0; col < innerWidth; col += 1) {
          const index = y * stride + (cardX + padding + col) * 4
          blend(pixels, index, GLASS, strength * 0.92)
        }
      }
    }
    this.bitmap.upload()
    this.present()
  }

  /** Scroll the body by `delta` pixels; @returns whether anything moved. */
  scroll(delta) {
    if (this.handle === 0 || this.scrollable !== true) return false
    const max = Math.max(0, this.textHeight - this.visibleBody)
    const next = clamped(this.scrollOffset + delta, 0, max)
    if (next === this.scrollOffset) return false
    this.scrollOffset = next
    this.composite()
    return true
  }

  /** Push the composed bitmap to the layered window. */
  present() {
    const { api } = win32()
    if (this.handle === 0 || this.bitmap === undefined || this.layout === undefined) return
    // Present from the context that already holds the bitmap: a second
    // `SelectObject` of the same DIB into another DC fails silently and leaves
    // `UpdateLayeredWindow` with an empty surface.
    const memory = this.text?.dc
    if (!memory) return
    const screen = api.getDC(null)
    if (!screen) return
    try {
      const ok = api.gdiUpdateLayeredWindow(
        this.handle,
        screen,
        { x: this.layout.windowLeft, y: this.layout.windowTop },
        { cx: this.layout.windowWidth, cy: this.layout.windowHeight },
        memory,
        { x: 0, y: 0 },
        0,
        { BlendOp: 0, BlendFlags: 0, SourceConstantAlpha: 255, AlphaFormat: AC_SRC_ALPHA },
        ULW_ALPHA,
      )
      if (ok !== true) {
        // Recording only: the binding misreports success, so this is a signal to
        // compare against, not a decision.
        record(`card present ulw=false err=${api.kernelGetLastError()}`)
      }
    } finally {
      api.releaseDC(null, screen)
    }
  }

  /** Destroy the window and release everything it owns. */
  close() {
    const { api } = win32()
    if (this.handle !== 0) {
      try {
        api.destroyWindow(this.handle)
      } catch { /* already gone */ }
      this.handle = 0
    }
    try {
      this.text?.dispose()
    } catch { /* the DC may already be gone */ }
    this.text = undefined
    try {
      this.bitmap?.dispose()
    } catch { /* the DIB may already be gone */ }
    this.bitmap = undefined
    this.frame = undefined
    this.mask = undefined
    this.layout = undefined
    this.scrollOffset = 0
  }
}
