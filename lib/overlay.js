import {
  win32,
  AC_SRC_ALPHA,
  ULW_ALPHA,
  WS_POPUP,
  WS_EX_LAYERED,
  WS_EX_TOPMOST,
  WS_EX_TOOLWINDOW,
  SWP_NOACTIVATE,
  SWP_SHOWWINDOW,
  SW_HIDE,
} from './win32.js'
import { Bitmap } from './screen.js'
import { TextContext } from './text.js'
import { record } from './diag.js'

/** `GWL_EXSTYLE`: the window style slot that holds `WS_EX_LAYERED`. */
const GWL_EXSTYLE = -20

/**
 * One line per shot describing how the frame reached the layered window.
 *
 * A layered window that is never updated stays fully transparent while still
 * sitting on top of the desktop, so "nothing happened" and "the application
 * swallowed every click" look identical from the outside. Recording the handles,
 * the verdict of `UpdateLayeredWindow`, its error code and whether the DIB
 * actually holds the pixels turns that into something readable.
 */
function diagnosePresent(surface, dibtarget, previous, ok, error) {
  try {
    const pixels = surface.bitmap.pixels
    let alphaMin = 255
    let alphaMax = 0
    for (let i = 3; i < pixels.length; i += 4 * 401) {
      const alpha = pixels[i]
      if (alpha < alphaMin) alphaMin = alpha
      if (alpha > alphaMax) alphaMax = alpha
    }
    let match = 'n/a'
    try {
      const back = surface.bitmap.download()
      if (back !== undefined && back.length === pixels.length) {
        let same = 0
        let total = 0
        for (let i = 0; i < pixels.length; i += 4 * 997) {
          total += 1
          if (back[i] === pixels[i] && back[i + 1] === pixels[i + 1] && back[i + 2] === pixels[i + 2]) same += 1
        }
        match = `${same}/${total}`
      }
    } catch { /* inspecting the DIB is optional */ }
    record(`present ${surface.width}x${surface.height} hwnd=${surface.handle} ex=0x${(Number(win32().api.getWindowLongPtrW(surface.handle, GWL_EXSTYLE)) >>> 0).toString(16)} dib=${dibtarget} previous=${previous} ulw=${ok} err=${error} alpha=${alphaMin}..${alphaMax} dibmatch=${match}`)
  } catch (failure) {
    record(`present diagnose failed: ${failure?.message ?? failure}`)
  }
}

/** Toolbar metrics, in 96-DPI units. */
const TOOLBAR = {
  height: 46,
  radius: 14,
  padding: 7,
  gap: 2,
  offset: 10,
  margin: 8,
  button: { height: 32, radius: 9, padX: 11, icon: 15, iconGap: 7, font: 13 },
}

/** Selection readout chip, in 96-DPI units. */
const CHIP = { height: 24, radius: 7, padding: 9, font: 12 }

/** Brightness handling for the frozen desktop behind the selection. */
// A pure multiply turns a dark UI into a black rectangle, so the veil also
// lifts the black point: `out = src * VEIL_GAIN + VEIL_LIFT`. Dark content
// stays legible instead of collapsing to black.
const VEIL_GAIN = 0.64
const VEIL_LIFT = 10

/** Palette: a neutral dark glass card with one accent and no chrome. */
const SURFACE = { r: 24, g: 26, b: 32 }
const SURFACE_ALPHA = 0.93
const EDGE = { r: 255, g: 255, b: 255 }
const INK = { r: 234, g: 238, b: 245 }
const PRIMARY = { r: 58, g: 134, b: 255 }
const PRIMARY_HOT = { r: 84, g: 154, b: 255 }
const DANGER = { r: 255, g: 98, b: 98 }
const SHADE = { r: 0, g: 0, b: 0 }
const ACCENT = { r: 64, g: 158, b: 255 }

/** Precomputed veil table: one lookup per channel instead of a multiply. */
const VEIL_LUT = new Uint8Array(256)
for (let value = 0; value < 256; value += 1) {
  VEIL_LUT[value] = Math.min(255, Math.round(value * VEIL_GAIN + VEIL_LIFT))
}

/**
 * Blend a colour onto one already-opaque BGRA pixel.
 *
 * The overlay buffer is kept fully opaque on purpose: the frozen desktop is
 * baked into the pixels, so dimming must happen here rather than through the
 * window's alpha, which would let the *live* desktop show through instead.
 */
function blend(pixels, index, colour, alpha) {
  if (alpha <= 0) return
  if (alpha >= 1) {
    pixels[index] = colour.b
    pixels[index + 1] = colour.g
    pixels[index + 2] = colour.r
    pixels[index + 3] = 255
    return
  }
  const keep = 1 - alpha
  pixels[index] = Math.round(colour.b * alpha + pixels[index] * keep)
  pixels[index + 1] = Math.round(colour.g * alpha + pixels[index + 1] * keep)
  pixels[index + 2] = Math.round(colour.r * alpha + pixels[index + 2] * keep)
  pixels[index + 3] = 255
}

/**
 * Build the veiled copy of a frozen surface, once per shot.
 *
 * Doing this here rather than per frame is what makes dragging smooth: the
 * per-frame path becomes two memory copies instead of a full-screen blend.
 * @param source - the untouched frozen pixels.
 * @param target - buffer of the same length to fill.
 */
function veilInto(source, target) {
  const length = source.length
  for (let index = 0; index < length; index += 4) {
    target[index] = VEIL_LUT[source[index]]
    target[index + 1] = VEIL_LUT[source[index + 1]]
    target[index + 2] = VEIL_LUT[source[index + 2]]
    target[index + 3] = 255
  }
}

/**
 * How much of one pixel a rounded rectangle covers, 0..1.
 *
 * Anti-aliasing matters here: the card's corners and its one-pixel border are
 * the whole visual signature, and an aliased corner reads as a bug.
 */
function roundedCoverage(px, py, left, top, right, bottom, radius) {
  const inX = px < left + radius || px >= right - radius
  const inY = py < top + radius || py >= bottom - radius
  if (!inX || !inY) return 1
  let inside = 0
  for (const dx of [0.25, 0.75]) {
    for (const dy of [0.25, 0.75]) {
      const sx = px + dx
      const sy = py + dy
      if (sx < left || sx >= right || sy < top || sy >= bottom) continue
      const cx = sx < left + radius ? left + radius : (sx > right - radius ? right - radius : sx)
      const cy = sy < top + radius ? top + radius : (sy > bottom - radius ? bottom - radius : sy)
      if ((sx - cx) ** 2 + (sy - cy) ** 2 <= radius * radius) inside += 1
    }
  }
  return inside / 4
}

/** Fill a rounded rectangle, anti-aliased, blended over the frozen desktop. */
function fillRound(pixels, stride, height, left, top, right, bottom, radius, colour, alpha) {
  const x0 = Math.max(0, Math.round(left))
  const y0 = Math.max(0, Math.round(top))
  const x1 = Math.min(stride / 4, Math.round(right))
  const y1 = Math.min(height, Math.round(bottom))
  if (x1 <= x0 || y1 <= y0 || alpha <= 0) return
  const corner = Math.max(0, Math.min(radius, (x1 - x0) / 2, (y1 - y0) / 2))
  for (let y = y0; y < y1; y += 1) {
    const row = y * stride
    for (let x = x0; x < x1; x += 1) {
      const coverage = corner > 0 ? roundedCoverage(x, y, x0, y0, x1, y1, corner) : 1
      if (coverage <= 0) continue
      blend(pixels, row + x * 4, colour, alpha * coverage)
    }
  }
}

/** Draw a rounded-rectangle outline of the given thickness. */
function strokeRound(pixels, stride, height, left, top, right, bottom, radius, thickness, colour, alpha) {
  const x0 = Math.max(0, Math.round(left))
  const y0 = Math.max(0, Math.round(top))
  const x1 = Math.min(stride / 4, Math.round(right))
  const y1 = Math.min(height, Math.round(bottom))
  if (x1 <= x0 || y1 <= y0) return
  const corner = Math.max(0, radius)
  const inner = Math.max(1, thickness)
  for (let y = y0; y < y1; y += 1) {
    const row = y * stride
    for (let x = x0; x < x1; x += 1) {
      const outer = corner > 0 ? roundedCoverage(x, y, x0, y0, x1, y1, corner) : 1
      if (outer <= 0) continue
      const inset = Math.max(0, corner - inner)
      const covered = roundedCoverage(x, y, x0 + inner, y0 + inner, x1 - inner, y1 - inner, inset)
      const ring = outer - covered
      if (ring <= 0) continue
      blend(pixels, row + x * 4, colour, alpha * ring)
    }
  }
}

/** Fill an axis-aligned rectangle. */
function fillRect(pixels, stride, height, left, top, right, bottom, colour, alpha) {
  const x0 = Math.max(0, Math.round(left))
  const y0 = Math.max(0, Math.round(top))
  const x1 = Math.min(stride / 4, Math.round(right))
  const y1 = Math.min(height, Math.round(bottom))
  if (x1 <= x0 || y1 <= y0) return
  for (let y = y0; y < y1; y += 1) {
    const row = y * stride
    for (let x = x0; x < x1; x += 1) blend(pixels, row + x * 4, colour, alpha)
  }
}

/** Draw one anti-aliased line segment, used for the button icons. */
function strokeLine(pixels, stride, height, x0, y0, x1, y1, width, colour, alpha) {
  const half = width / 2
  const minX = Math.max(0, Math.floor(Math.min(x0, x1) - half))
  const maxX = Math.min(stride / 4, Math.ceil(Math.max(x0, x1) + half))
  const minY = Math.max(0, Math.floor(Math.min(y0, y1) - half))
  const maxY = Math.min(height, Math.ceil(Math.max(y0, y1) + half))
  const dx = x1 - x0
  const dy = y1 - y0
  const lengthSquared = dx * dx + dy * dy
  for (let y = minY; y < maxY; y += 1) {
    const row = y * stride
    for (let x = minX; x < maxX; x += 1) {
      let inside = 0
      for (const sx of [0.25, 0.75]) {
        for (const sy of [0.25, 0.75]) {
          const px = x + sx
          const py = y + sy
          let t = lengthSquared === 0 ? 0 : ((px - x0) * dx + (py - y0) * dy) / lengthSquared
          t = t < 0 ? 0 : (t > 1 ? 1 : t)
          const nx = x0 + dx * t
          const ny = y0 + dy * t
          if ((px - nx) ** 2 + (py - ny) ** 2 <= half * half) inside += 1
        }
      }
      if (inside === 0) continue
      blend(pixels, row + x * 4, colour, alpha * (inside / 4))
    }
  }
}

/**
 * One layered window per monitor. The windows show a frozen copy of the desktop
 * plus the selection chrome; the service decides what the interaction means.
 */
export class Overlay {
  /**
   * @param options - `className` is the window class registered by the service.
   */
  constructor(options) {
    this.className = options.className
    this.wndproc = options.wndproc
    this.surfaces = []
  }

  /**
   * Create (or recreate) one window per monitor and reveal them.
   * @param capture - `{ bitmap, bounds }` of the frozen desktop.
   * @param displays - as returned by `listDisplays`.
   * @param onCreated - called with each new window handle so the service can
   *   route its messages.
   */
  open(capture, displays, onCreated) {
    this.close()
    const { api } = win32()
    const instance = api.kernelGetModuleHandleW(null)
    const surfaces = []
    for (const display of displays) {
      const width = display.right - display.left
      const height = display.bottom - display.top
      if (width <= 0 || height <= 0) continue
      // No `WS_EX_NOACTIVATE`: the overlay must take the foreground so `Esc` and
      // `Enter` reach its window procedure. The service restores the previously
      // focused window when the shot ends.
      const handle = api.createWindowExW(
        WS_EX_LAYERED | WS_EX_TOPMOST | WS_EX_TOOLWINDOW,
        this.className,
        '',
        WS_POPUP,
        display.left,
        display.top,
        width,
        height,
        null,
        null,
        instance,
        null,
      )
      if (!handle) continue
      const surface = {
        handle,
        display,
        width,
        height,
        scale: Math.max(1, Math.round((display.dpi / 96) * 2) / 2),
        bitmap: new Bitmap(width, height),
        // `clean` keeps the untouched frozen frame, `base` its veiled twin.
        clean: Buffer.alloc(width * height * 4),
        base: Buffer.alloc(width * height * 4),
        buttons: [],
        copySource: capture,
        lastPaint: undefined,
        text: undefined,
      }
      // Seed the buffer with this monitor's slice of the frozen desktop so the
      // user is looking at exactly the pixels the copy will take.
      this.seed(surface, capture)
      api.setWindowPos(handle, -1, display.left, display.top, width, height, SWP_NOACTIVATE | SWP_SHOWWINDOW)
      onCreated?.(handle, surface)
      surfaces.push(surface)
    }
    this.surfaces = surfaces
    if (surfaces.length === 0) throw new Error('dsh-screenshot: could not create an overlay window')
    return surfaces
  }

  /** Copy this monitor's slice of the frozen desktop into its surface buffers. */
  seed(surface, capture) {
    const pixels = surface.bitmap.refresh()
    const source = capture.bitmap
    const sourcePixels = source.bytes()
    const left = surface.display.left - capture.bounds.left
    const top = surface.display.top - capture.bounds.top
    for (let row = 0; row < surface.height; row += 1) {
      const sourceRow = top + row
      if (sourceRow < 0 || sourceRow >= source.height) continue
      const from = sourceRow * source.stride + left * 4
      if (from < 0 || from + surface.width * 4 > sourcePixels.length) continue
      sourcePixels.copy(pixels, row * surface.bitmap.stride, from, from + surface.width * 4)
    }
    // Two cached copies per surface: the untouched frame (restored inside the
    // selection) and the veiled frame (the base every paint starts from).
    surface.clean.set(pixels)
    veilInto(pixels, surface.base)
  }

  /** @returns the surface whose monitor contains a screen point, if any. */
  surfaceAt(x, y) {
    return this.surfaces.find((surface) => (
      x >= surface.display.left && x < surface.display.right
      && y >= surface.display.top && y < surface.display.bottom
    ))
  }

  /** @returns the surface a window handle belongs to, if any. */
  surfaceOf(handle) {
    return this.surfaces.find((surface) => surface.handle === handle)
  }

  /** The GDI text context for a surface, created on first use. */
  textFor(surface) {
    surface.text ??= new TextContext(surface.bitmap, { size: Math.round(13 * surface.scale) })
    return surface.text
  }

  /**
   * Push a surface's buffer to its layered window.
   *
   * `upload` defaults to true; `paint()` passes false because `finish()` has just
   * copied the composited pixels into the DIB and drawn the labels on top of
   * them — uploading again would erase the labels.
   */
  present(surface, options = {}) {
    const { api } = win32()
    if (options.upload !== false) surface.bitmap.upload()
    const screen = api.getDC(null)
    if (!screen) {
      record('present: GetDC(null) returned 0')
      return false
    }
    // The bitmap can only be selected into one device context at a time. Once the
    // frame carries GDI text, `TextContext` owns that context — a second
    // `SelectObject` fails, and `UpdateLayeredWindow` is then handed a DC with a
    // 1x1 default bitmap and fails with ERROR_GEN_FAILURE while the window stays
    // transparent. Its context already holds the finished frame, labels included,
    // so present from there.
    const host = surface.text?.dc
    const memory = host ?? api.gdiCreateCompatibleDC(screen)
    if (!memory) {
      record('present: CreateCompatibleDC returned 0')
      api.releaseDC(null, screen)
      return false
    }
    const borrowed = host === undefined
    const previous = borrowed ? api.gdiSelectObject(memory, surface.bitmap.handle) : 0
    if (borrowed && !previous) {
      record(`present: SelectObject failed (dib=${surface.bitmap.handle})`)
    }
    try {
      const ok = api.gdiUpdateLayeredWindow(
        surface.handle,
        screen,
        { x: surface.display.left, y: surface.display.top },
        { cx: surface.width, cy: surface.height },
        memory,
        { x: 0, y: 0 },
        0,
        { BlendOp: 0, BlendFlags: 0, SourceConstantAlpha: 255, AlphaFormat: AC_SRC_ALPHA },
        ULW_ALPHA,
      )
      const error = ok ? 0 : api.kernelGetLastError()
      // The binding reports `false` even for frames that do appear, so the return
      // value is not a success signal — it is only recorded.
      if (surface.diagnosed !== true) {
        surface.diagnosed = true
        diagnosePresent(surface, surface.bitmap.handle, `${borrowed ? 'temp' : 'text'}:${previous}`, ok, error)
      }
      return ok
    } finally {
      if (borrowed) {
        api.gdiSelectObject(memory, previous)
        api.gdiDeleteDC(memory)
      }
      api.releaseDC(null, screen)
    }
  }

  /**
   * Repaint one frame and show it.
   *
   * Shapes are composited in JS memory, then uploaded, then the labels are
   * drawn by GDI straight into the DIB, so the final present must not upload
   * again or the text would be overwritten by the pre-text pixels.
   */
  paint(surface, state) {
    render(surface, state)
    return this.present(surface, { upload: false })
  }

  /** Hide and release every surface window. */
  close() {
    const { api } = win32()
    for (const surface of this.surfaces) {
      if (surface.handle) {
        api.showWindow(surface.handle, SW_HIDE)
        api.destroyWindow(surface.handle)
      }
      try {
        surface.text?.dispose()
      } catch { /* the DC may already be gone */ }
      surface.bitmap.dispose()
    }
    this.surfaces = []
  }
}

/** Scale a 96-DPI unit to this surface, never below one pixel. */
function unit(value, scale) {
  return Math.max(1, Math.round(value * scale))
}

/**
 * Draw one button icon centred on a point.
 * @param id - `copy`, `save`, `text` or `cancel`.
 */
function drawIcon(pixels, stride, height, id, cx, cy, size, colour, alpha) {
  const half = size / 2
  const weight = Math.max(1, size / 9.5)
  const line = (x0, y0, x1, y1) => strokeLine(pixels, stride, height, x0, y0, x1, y1, weight, colour, alpha)
  if (id === 'copy') {
    // Two offset sheets: the back one only shows its top and right edge.
    const w = size * 0.62
    const h = size * 0.72
    line(cx - half + w * 0.42, cy - half, cx + half, cy - half)
    line(cx + half, cy - half, cx + half, cy - half + h * 0.55)
    const left = cx - half
    const top = cy - half + h * 0.28
    const right = left + w
    const bottom = top + h * 0.72
    const r = size * 0.12
    strokeRound(pixels, stride, height, left, top, right, bottom, r, weight, colour, alpha)
    return
  }
  if (id === 'save') {
    line(cx, cy - half, cx, cy + half * 0.32)
    line(cx - half * 0.5, cy - half * 0.18, cx, cy + half * 0.34)
    line(cx + half * 0.5, cy - half * 0.18, cx, cy + half * 0.34)
    line(cx - half * 0.72, cy + half, cx + half * 0.72, cy + half)
    return
  }
  if (id === 'text') {
    line(cx - half * 0.72, cy - half * 0.78, cx + half * 0.72, cy - half * 0.78)
    line(cx, cy - half * 0.78, cx, cy + half * 0.78)
    return
  }
  const inset = half * 0.66
  line(cx - inset, cy - inset, cx + inset, cy + inset)
  line(cx + inset, cy - inset, cx - inset, cy + inset)
}

/**
 * Lay out and paint the toolbar, recording where its buttons landed.
 * @returns the hit boxes.
 */
function drawToolbar(surface, state, pixels, stride, height, scale, text, labels) {
  const items = [
    { id: 'copy', label: '复制', primary: true },
    { id: 'save', label: '保存', primary: false },
    { id: 'text', label: '文字', primary: false },
    { id: 'cancel', label: '取消', primary: false, danger: true },
  ]
  const font = unit(TOOLBAR.button.font, scale)
  const icon = unit(TOOLBAR.button.icon, scale)
  const padX = unit(TOOLBAR.button.padX, scale)
  const iconGap = unit(TOOLBAR.button.iconGap, scale)
  const barHeight = unit(TOOLBAR.height, scale)
  const barPadding = unit(TOOLBAR.padding, scale)
  const buttonHeight = unit(TOOLBAR.button.height, scale)
  const buttonGap = unit(TOOLBAR.gap, scale)
  const gap = unit(TOOLBAR.offset, scale)

  text.use(font)
  const widths = items.map((item) => padX * 2 + icon + iconGap + text.extent(item.label).cx)
  const dividerGap = unit(6, scale)
  const dividerWidth = unit(1, scale)
  const barWidth = barPadding * 2
    + widths.reduce((sum, width) => sum + width, 0)
    + buttonGap * (items.length - 1)
    + dividerGap * 2 + dividerWidth

  const { x, y, w, h } = state.selection
  const margin = unit(TOOLBAR.margin, scale)
  // The bar hangs under the selection, centred on it — the arrangement every
  // screenshot tool uses, and the one that keeps it clear of the content being
  // captured. `gap` is measured from the selection's bottom edge.
  let left = x + Math.round((w - barWidth) / 2)
  let top = y + h + gap
  if (top + barHeight > surface.height - margin) {
    // No room underneath (bottom of the screen, or the taskbar): flip above.
    top = y - barHeight - gap
    if (top < margin) {
      // Neither side fits, so the bar goes inside the selection's bottom edge
      // rather than off-screen.
      top = Math.max(margin, Math.min(y + h - barHeight - gap, surface.height - barHeight - margin))
    }
  }
  left = Math.max(margin, Math.min(left, surface.width - barWidth - margin))
  top = Math.max(margin, Math.min(top, surface.height - barHeight - margin))
  // Published so the result card can dodge the bar: both want the strip under
  // the selection, and the card losing that contest would hide the buttons.
  surface.toolbar = { left, top, right: left + barWidth, bottom: top + barHeight }

  const radius = unit(TOOLBAR.radius, scale)
  const shadow = unit(6, scale)
  // Three stacked shadows approximate a soft one without a blur pass.
  fillRound(pixels, stride, height, left - shadow * 0.4, top + shadow * 0.6, left + barWidth + shadow * 0.4, top + barHeight + shadow, radius, SHADE, 0.16)
  fillRound(pixels, stride, height, left - shadow * 0.2, top + shadow * 0.3, left + barWidth + shadow * 0.2, top + barHeight + shadow * 0.6, radius, SHADE, 0.2)
  fillRound(pixels, stride, height, left, top, left + barWidth, top + barHeight, radius, SURFACE, SURFACE_ALPHA)
  strokeRound(pixels, stride, height, left, top, left + barWidth, top + barHeight, radius, 1, EDGE, 0.1)

  const hit = []
  const buttonRadius = unit(TOOLBAR.button.radius, scale)
  const buttonTop = top + Math.round((barHeight - buttonHeight) / 2)
  const buttonBottom = buttonTop + buttonHeight
  let cursor = left + barPadding
  items.forEach((item, index) => {
    const width = widths[index]
    if (item.id === 'cancel') {
      // A hairline divider sets the destructive action apart from the rest.
      const dividerX = cursor + dividerGap
      fillRound(pixels, stride, height, dividerX, buttonTop + unit(7, scale), dividerX + dividerWidth, buttonBottom - unit(7, scale), 0, EDGE, 0.12)
      cursor += dividerGap * 2 + dividerWidth
    }
    const hovered = surface.handle === state.toolbarSurface
      && state.pointerX >= cursor && state.pointerX < cursor + width
      && state.pointerY >= buttonTop && state.pointerY < buttonBottom
      && state.hover === item.id
    const pressed = hovered && state.pressed === item.id
    // Once text has been pulled out, the button that did it stays marked: the
    // shot is still on screen, so the marker says which action produced the card
    // floating beside it.
    const done = state.textDone === true && item.id === 'text'
    if (item.primary) {
      fillRound(pixels, stride, height, cursor, buttonTop, cursor + width, buttonBottom, buttonRadius, pressed ? PRIMARY_HOT : PRIMARY, pressed ? 0.85 : 1)
    } else if (hovered || done) {
      const tint = item.danger ? DANGER : (done ? PRIMARY : EDGE)
      const strength = done ? 0.22 : (pressed ? 0.28 : (item.danger ? 0.16 : 0.1))
      fillRound(pixels, stride, height, cursor, buttonTop, cursor + width, buttonBottom, buttonRadius, tint, strength)
    }
    const labelColour = done
      ? PRIMARY_HOT
      : (item.primary ? INK : (item.danger && hovered ? DANGER : INK))
    const iconColour = labelColour
    const iconCx = cursor + padX + icon / 2
    const iconCy = (buttonTop + buttonBottom) / 2
    drawIcon(pixels, stride, height, item.id, iconCx, iconCy, icon, iconColour, 1)
    const labelLeft = cursor + padX + icon + iconGap
    const labelWidth = width - padX - icon - iconGap
    labels.push({
      text: item.label,
      size: font,
      colour: labelColour,
      box: { left: labelLeft, right: labelLeft + labelWidth, top: iconCy - font * 0.62, bottom: buttonBottom },
    })
    hit.push({ id: item.id, left: cursor, top: buttonTop, right: cursor + width, bottom: buttonBottom })
    cursor += width + buttonGap
  })
  return hit
}

/**
 * Render one frame of the selection UI.
 *
 * @param surface - the surface to draw into.
 * @param state - the interaction state from the service.
 * @returns the toolbar buttons for later hit-testing.
 */
export function render(surface, state) {
  const pixels = surface.bitmap.refresh()
  const { stride } = surface.bitmap
  const height = surface.height
  const scale = surface.scale
  const text = surface.text ??= new TextContext(surface.bitmap, { size: unit(13, scale) })
  const labels = []

  // Every frame starts from the cached veiled frame: one memcpy instead of a
  // full-screen per-pixel blend, which is what keeps dragging smooth.
  surface.base.copy(pixels)

  if (!state.selection) {
    const label = '拖动选择区域  ·  Esc 取消'
    const font = unit(13, scale)
    text.use(font)
    const padX = unit(16, scale)
    const boxHeight = unit(36, scale)
    const boxWidth = text.extent(label).cx + padX * 2
    const left = Math.round((surface.width - boxWidth) / 2)
    const top = Math.round(surface.height / 2 - boxHeight / 2)
    const radius = unit(10, scale)
    fillRound(pixels, stride, height, left, top + unit(3, scale), left + boxWidth, top + boxHeight + unit(5, scale), radius, SHADE, 0.22)
    fillRound(pixels, stride, height, left, top, left + boxWidth, top + boxHeight, radius, SURFACE, SURFACE_ALPHA)
    strokeRound(pixels, stride, height, left, top, left + boxWidth, top + boxHeight, radius, 1, EDGE, 0.1)
    labels.push({
      text: label,
      size: font,
      colour: INK,
      box: { left, right: left + boxWidth, top: top + Math.round((boxHeight - font) / 2) - unit(1, scale), bottom: top + boxHeight },
      center: true,
    })
    surface.buttons = []
    surface.toolbar = undefined
    finish(surface, text, labels)
    return surface.buttons
  }

  const { x, y, w, h } = state.selection
  // Restore the selected pixels from the untouched frozen frame so the area
  // reads at full brightness.
  const clean = surface.clean
  const rowBytes = w * 4
  for (let row = 0; row < h; row += 1) {
    const offset = (y + row) * stride + x * 4
    clean.copy(pixels, offset, (y + row) * stride + x * 4, (y + row) * stride + x * 4 + rowBytes)
  }

  // One hairline frame: a dark ring for contrast on light content, the accent
  // on top of it. No grips or brackets — the drag itself is the handle.
  const edge = Math.max(1, Math.round(1.5 * scale))
  fillRect(pixels, stride, height, x - edge - 1, y - edge - 1, x + w + edge + 1, y, SHADE, 0.28)
  fillRect(pixels, stride, height, x - edge - 1, y + h, x + w + edge + 1, y + h + edge + 1, SHADE, 0.28)
  fillRect(pixels, stride, height, x - edge - 1, y, x, y + h, SHADE, 0.28)
  fillRect(pixels, stride, height, x + w, y, x + w + edge + 1, y + h, SHADE, 0.28)
  fillRect(pixels, stride, height, x - edge, y - edge, x + w + edge, y, ACCENT, 1)
  fillRect(pixels, stride, height, x - edge, y + h, x + w + edge, y + h + edge, ACCENT, 1)
  fillRect(pixels, stride, height, x - edge, y, x, y + h, ACCENT, 1)
  fillRect(pixels, stride, height, x + w, y, x + w + edge, y + h, ACCENT, 1)

  // Size readout, inside the top-left corner like the reference, nudged out
  // above the selection when the box is too small to hold it.
  const label = `${w} × ${h}`
  const font = unit(CHIP.font, scale)
  const padX = unit(CHIP.padding, scale)
  const chipHeight = unit(CHIP.height, scale)
  const gap = unit(TOOLBAR.offset, scale)
  text.use(font)
  const chipWidth = text.extent(label).cx + padX * 2
  const radius = unit(CHIP.radius, scale)
  let chipLeft = x + gap
  let chipTop = y + gap
  if (h < chipHeight + gap * 2 || w < chipWidth + gap * 2) {
    chipTop = y - chipHeight - unit(4, scale)
    if (chipTop < 0) chipTop = y + gap
  }
  chipLeft = Math.max(0, Math.min(chipLeft, surface.width - chipWidth))
  fillRound(pixels, stride, height, chipLeft, chipTop + unit(1, scale), chipLeft + chipWidth, chipTop + chipHeight + unit(2, scale), radius, SHADE, 0.2)
  fillRound(pixels, stride, height, chipLeft, chipTop, chipLeft + chipWidth, chipTop + chipHeight, radius, SURFACE, 0.7)
  labels.push({
    text: label,
    size: font,
    colour: INK,
    box: { left: chipLeft, right: chipLeft + chipWidth, top: chipTop + Math.round((chipHeight - font) / 2) - unit(1, scale), bottom: chipTop + chipHeight },
    center: true,
  })

  const message = state.busy === true ? '正在识别…' : state.notice
  if (message !== undefined) {
    const messageFont = unit(13, scale)
    text.use(messageFont)
    const pad = unit(14, scale)
    const boxHeight = unit(38, scale)
    const boxWidth = text.extent(message).cx + pad * 2 + unit(14, scale)
    let left = x + Math.round((w - boxWidth) / 2)
    let top = y + h + gap
    if (top + boxHeight > surface.height) top = y - boxHeight - gap
    if (top < 0) top = Math.max(0, Math.min(surface.height - boxHeight, y + h - boxHeight))
    left = Math.max(0, Math.min(left, surface.width - boxWidth))
    const radius2 = unit(10, scale)
    fillRound(pixels, stride, height, left, top + unit(2, scale), left + boxWidth, top + boxHeight + unit(3, scale), radius2, SHADE, 0.28)
    fillRound(pixels, stride, height, left, top, left + boxWidth, top + boxHeight, radius2, SURFACE, 0.95)
    strokeRound(pixels, stride, height, left, top, left + boxWidth, top + boxHeight, radius2, 1, EDGE, 0.1)
    // A small accent bar doubles as the "working" marker.
    fillRound(pixels, stride, height, left + pad - unit(6, scale), top + Math.round((boxHeight - unit(14, scale)) / 2), left + pad - unit(3, scale), top + Math.round((boxHeight + unit(14, scale)) / 2), unit(2, scale), ACCENT, 1)
    labels.push({
      text: message,
      size: messageFont,
      colour: INK,
      box: { left: left + pad, right: left + boxWidth - unit(8, scale), top: top + Math.round((boxHeight - messageFont) / 2) - unit(1, scale), bottom: top + boxHeight },
    })
    surface.buttons = []
    surface.toolbar = undefined
    finish(surface, text, labels)
    return surface.buttons
  }

  surface.toolbar = undefined
  surface.buttons = surface.handle === state.toolbarSurface
    ? drawToolbar(surface, state, pixels, stride, height, scale, text, labels)
    : []
  finish(surface, text, labels)
  return surface.buttons
}

/** Upload the composited pixels, then let GDI draw the labels into the DIB. */
function finish(surface, text, labels) {
  surface.bitmap.upload()
  for (const item of labels) {
    text.use(item.size)
    text.draw(item.text, item.box, {
      colour: item.colour,
      singleLine: true,
      ...(item.center === true ? { center: true } : {}),
    })
  }
}

/** @returns the first button whose box contains a surface-local point. */
export function buttonAt(surface, x, y) {
  return surface.buttons.find((button) => (
    x >= button.left && x < button.right && y >= button.top && y < button.bottom
  ))
}

/** @returns whether a surface-local point falls inside the selection. */
export function selectionAt(state, x, y) {
  const selection = state.selection
  if (!selection) return false
  return x >= selection.left && x < selection.right && y >= selection.top && y < selection.bottom
}
