import { win32, SRCCOPY, CAPTUREBLT, BI_RGB, DIB_RGB_COLORS } from './win32.js'

/**
 * One monitor rectangle in virtual-screen coordinates, in physical pixels.
 * @typedef {{
 *   left: number, top: number, right: number, bottom: number,
 *   dpi: number, primary: boolean,
 * }} Display
 */

/**
 * `GetDpiForMonitor` lives in `shcore.dll`, which older Windows builds do not
 * ship, so the binding is resolved once and a failure is remembered.
 */
let dpiQuery

/** @returns a `(monitor, kind, outX, outY) => hresult` caller, if available. */
function resolveDpiQuery() {
  if (dpiQuery !== undefined) return dpiQuery
  dpiQuery = null
  try {
    const { koffi } = win32()
    const shcore = koffi.load('shcore.dll')
    dpiQuery = shcore.func('GetDpiForMonitor', 'int32', ['void *', 'int32', 'void *', 'void *'])
  } catch {
    dpiQuery = null
  }
  return dpiQuery
}

/**
 * Read the effective DPI of a monitor.
 * @param hmonitor - the monitor handle.
 * @returns the DPI, or 96 when the query is unavailable.
 */
function dpiOf(hmonitor) {
  const query = resolveDpiQuery()
  if (query === null) return 96
  const outX = Buffer.alloc(4)
  const outY = Buffer.alloc(4)
  try {
    // MDT_EFFECTIVE_DPI: the DPI the monitor is actually scaled to.
    if (query(hmonitor, 0, outX, outY) !== 0) return 96
    const dpi = outX.readUInt32LE(0)
    return dpi >= 48 && dpi <= 480 ? dpi : 96
  } catch {
    return 96
  }
}

/**
 * Enumerate monitors through `EnumDisplayMonitors`.
 * @returns every connected display, in virtual-screen coordinates.
 */
export function listDisplays() {
  const { koffi, api, types } = win32()
  const displays = []
  const size = koffi.sizeof(types.MONITORINFO)
  const callback = koffi.register((hmonitor) => {
    // `GetMonitorInfoW` wants a writable buffer whose leading `cbSize` is preset,
    // and the struct only decodes cleanly when read back through `koffi.decode`.
    const buffer = Buffer.alloc(size)
    buffer.writeUInt32LE(size, 0)
    if (api.getMonitorInfoW(hmonitor, buffer)) {
      const info = koffi.decode(buffer, types.MONITORINFO)
      // `koffi.decode` hands back fixed-size arrays as index-keyed objects.
      const monitor = info.rcMonitor
      const left = monitor[0] ?? monitor.left
      const top = monitor[1] ?? monitor.top
      const right = monitor[2] ?? monitor.right
      const bottom = monitor[3] ?? monitor.bottom
      displays.push({
        left,
        top,
        right,
        bottom,
        dpi: dpiOf(hmonitor),
        primary: (info.dwFlags & 1) === 1,
      })
    }
    return true
  }, koffi.pointer(types.MONITORENUMPROC))
  try {
    api.enumDisplayMonitors(0, 0, callback, 0)
  } finally {
    koffi.unregister(callback)
  }
  if (displays.length === 0) {
    const width = api.getSystemMetrics(0)
    const height = api.getSystemMetrics(1)
    displays.push({ left: 0, top: 0, right: width, bottom: height, dpi: 96, primary: true })
  }
  return displays
}

/**
 * The monitor that contains a point, falling back to the nearest one.
 * @param displays - as returned by {@link listDisplays}.
 * @param x - virtual-screen x.
 * @param y - virtual-screen y.
 * @returns the display that owns the point.
 */
export function displayAt(displays, x, y) {
  for (const display of displays) {
    if (x >= display.left && x < display.right && y >= display.top && y < display.bottom) return display
  }
  let best = displays[0]
  let bestArea = Infinity
  for (const display of displays) {
    const dx = Math.max(display.left - x, 0, x - display.right)
    const dy = Math.max(display.top - y, 0, y - display.bottom)
    const area = dx * dx + dy * dy
    if (area < bestArea) {
      best = display
      bestArea = area
    }
  }
  return best
}

/**
 * The bounding box of every display.
 * @param displays - as returned by {@link listDisplays}.
 * @returns the virtual-screen rectangle.
 */
export function boundsOf(displays) {
  let left = Infinity
  let top = Infinity
  let right = -Infinity
  let bottom = -Infinity
  for (const display of displays) {
    left = Math.min(left, display.left)
    top = Math.min(top, display.top)
    right = Math.max(right, display.right)
    bottom = Math.max(bottom, display.bottom)
  }
  return { left, top, width: right - left, height: bottom - top }
}

/** A 32bpp top-down DIB section with a `BGRA` byte buffer. */
export class Bitmap {
  /**
   * @param width - pixel width.
   * @param height - pixel height.
   */
  constructor(width, height) {
    const { koffi, api, types } = win32()
    if (width <= 0 || height <= 0) throw new Error(`dsh-screenshot: refusing a ${width}x${height} bitmap`)
    this.width = width
    this.height = height
    this.stride = width * 4
    this.header = {
      biSize: koffi.sizeof(types.BITMAPINFOHEADER),
      biWidth: width,
      // A negative height asks for a top-down DIB, so row 0 is the top row and
      // the buffer can be read without flipping it.
      biHeight: -height,
      biPlanes: 1,
      biBitCount: 32,
      biCompression: BI_RGB,
      biSizeImage: width * height * 4,
      biXPelsPerMeter: 0,
      biYPelsPerMeter: 0,
      biClrUsed: 0,
      biClrImportant: 0,
    }
    // Pixels live in plain JS memory. `koffi.view` would alias the DIB section
    // and save the copies, but it aborts the process inside Electron's N-API,
    // so the DIB is filled through `encode` and read back through `decode`
    // instead. The DIB itself is created lazily: cropped bitmaps never touch it.
    this.pixels = Buffer.alloc(this.stride * height)
    this.handle = 0
    this.address = 0
  }

  /**
   * Create the DIB section on first use.
   * @returns the device-independent bitmap handle.
   */
  ensureNative() {
    if (this.handle) return this.handle
    const { api } = win32()
    const bits = Buffer.alloc(8)
    const handle = api.gdiCreateDIBSection(0, this.header, DIB_RGB_COLORS, bits, 0, 0)
    if (!handle) throw new Error(`dsh-screenshot: CreateDIBSection failed (${api.kernelGetLastError()})`)
    this.handle = handle
    this.address = Number(bits.readBigUInt64LE(0))
    if (!this.address) throw new Error('dsh-screenshot: CreateDIBSection returned no pixels')
    return this.handle
  }

  /** Push the JS pixels into the DIB section before a GDI call reads them. */
  upload() {
    const { koffi } = win32()
    this.ensureNative()
    koffi.encode(this.address, 'uint8', this.pixels, this.pixels.length)
  }

  /** Pull the DIB section back into the JS pixels after GDI wrote to it. */
  download() {
    const { koffi } = win32()
    this.ensureNative()
    this.pixels.set(koffi.decode(this.address, 'uint8', this.pixels.length))
  }

  /**
   * The pixel buffer, one row after another, top row first.
   * @returns the BGRA bytes.
   */
  refresh() {
    return this.pixels
  }

  /**
   * Copy a screen rectangle into this bitmap.
   * @param sourceX - virtual-screen x of the source's left edge.
   * @param sourceY - virtual-screen y of the source's top edge.
   * @param width - copy width.
   * @param height - copy height.
   * @param targetX - destination x inside this bitmap.
   * @param targetY - destination y inside this bitmap.
   */
  blitFromScreen(sourceX, sourceY, width, height, targetX = 0, targetY = 0) {
    const { api } = win32()
    const target = this.ensureNative()
    const screen = api.getDC(0)
    if (!screen) throw new Error('dsh-screenshot: GetDC failed')
    const memory = api.gdiCreateCompatibleDC(screen)
    try {
      const previous = api.gdiSelectObject(memory, target)
      // `CAPTUREBLT` keeps layered windows (including our own overlays) out of
      // the copy on some drivers, so plain `SRCCOPY` is enough here.
      const copied = api.gdiBitBlt(memory, targetX, targetY, width, height, screen, sourceX, sourceY, SRCCOPY | CAPTUREBLT)
      if (!copied) throw new Error(`dsh-screenshot: BitBlt failed (${api.kernelGetLastError()})`)
      api.gdiSelectObject(memory, previous)
    } finally {
      api.gdiDeleteDC(memory)
      api.releaseDC(0, screen)
    }
    this.download()
  }

  /**
   * Copy a scaled screen rectangle into this bitmap, for previews that shrink
   * a large monitor to fit an overlay without allocating another surface.
   */
  stretchFromScreen(sourceX, sourceY, width, height) {
    const { api } = win32()
    const target = this.ensureNative()
    const screen = api.getDC(0)
    if (!screen) throw new Error('dsh-screenshot: GetDC failed')
    const memory = api.gdiCreateCompatibleDC(screen)
    try {
      const previous = api.gdiSelectObject(memory, target)
      api.gdiSetStretchBltMode(memory, 0x04)
      api.gdiStretchBlt(memory, 0, 0, this.width, this.height, screen, sourceX, sourceY, width, height, SRCCOPY)
      api.gdiSelectObject(memory, previous)
    } finally {
      api.gdiDeleteDC(memory)
      api.releaseDC(0, screen)
    }
    this.download()
  }

  /** @returns the BGRA bytes, one row after another, top row first. */
  bytes() {
    return this.pixels
  }

  /** Release the native surface. */
  dispose() {
    if (this.handle) {
      win32().api.gdiDeleteObject(this.handle)
      this.handle = 0
    }
    this.pixels = undefined
  }
}

/**
 * Capture the whole virtual screen.
 * @param displays - as returned by {@link listDisplays}.
 * @returns a bitmap covering {@link boundsOf}, plus the geometry it came from.
 */
export function captureDesktop(displays) {
  const bounds = boundsOf(displays)
  const bitmap = new Bitmap(bounds.width, bounds.height)
  try {
    bitmap.blitFromScreen(bounds.left, bounds.top, bounds.width, bounds.height)
  } catch (error) {
    bitmap.dispose()
    throw error
  }
  return { bitmap, bounds, displays }
}

/**
 * Crop a region out of a captured bitmap.
 * @param source - the captured bitmap.
 * @param bounds - the virtual-screen rectangle the capture covers.
 * @param rect - the region to keep, in virtual-screen coordinates.
 * @returns a new bitmap owning only that region.
 */
export function cropBitmap(source, bounds, rect) {
  const left = Math.max(rect.left, bounds.left)
  const top = Math.max(rect.top, bounds.top)
  const right = Math.min(rect.right, bounds.left + source.width)
  const bottom = Math.min(rect.bottom, bounds.top + source.height)
  const width = right - left
  const height = bottom - top
  if (width <= 0 || height <= 0) throw new Error('dsh-screenshot: empty selection')
  const output = new Bitmap(width, height)
  const sourceX = left - bounds.left
  const sourceY = top - bounds.top
  const pixels = source.bytes()
  for (let row = 0; row < height; row += 1) {
    const from = (sourceY + row) * source.stride + sourceX * 4
    const to = row * output.stride
    pixels.copy(output.pixels, to, from, from + width * 4)
  }
  return { bitmap: output, rect: { left, top, right, bottom } }
}
