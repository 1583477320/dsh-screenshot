import z from '@deepseek-ai/schemastery'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { win32, parseHotkey } from './win32.js'
import { listDisplays, captureDesktop, cropBitmap } from './screen.js'
import { Overlay, buttonAt } from './overlay.js'
import { writeClipboard, writeClipboardText, savePng } from './clipboard.js'
import { recognizeText } from './ocr.js'
import { recognizeWithModel, describeRoutes, describeCatalogue } from './vision.js'
import { llmOf } from './services.js'
import { record } from './diag.js'
import { ResultCard } from './panel.js'

/** Identifies this plugin's settings entry and its log channel. */
export const NS = 'screenshot'

/** The one global hotkey this service owns. */
const HOTKEY_ID = 0x4453

/**
 * Extra chords registered alongside the configured one. Windows refuses a chord
 * another program already owns, so these keep the tool usable even when the
 * default `Ctrl+Alt+A` is taken by WeChat or QQ.
 */
const FALLBACK_HOTKEYS = ['Ctrl+Shift+A', 'Alt+Shift+A', 'Ctrl+Alt+S']

/** Message ids the shared window procedure dispatches. */
const WM_HOTKEY = 0x0312
const WM_PAINT = 0x000f
const WM_ERASEBKGND = 0x0014
const WM_SETCURSOR = 0x0020
const WM_NCHITTEST = 0x0084
const WM_MOUSEMOVE = 0x0200
const WM_LBUTTONDOWN = 0x0201
const WM_LBUTTONUP = 0x0202
const WM_RBUTTONDOWN = 0x0204
const WM_RBUTTONUP = 0x0205
const WM_KEYDOWN = 0x0100
const WM_QUIT = 0x0012
const WM_MOUSEWHEEL = 0x020a

/** Virtual-key codes handled by the overlay. */
const VK_ESCAPE = 0x1b
const VK_RETURN = 0x0d

const HTCLIENT = 1
const IDC_CROSS = 32515
const IDC_ARROW = 32512
const MK_CONTROL = 0x0008

/**
 * Settings for the headless screenshot tool.
 *
 * The whole object is volatile: it is what makes the Host keep this plugin's
 * settings editable at runtime, and the service re-reads it on every shot.
 */
export const Config = z.object({
  enabled: z.boolean().default(true).description('启用全局截图快捷键。'),
  hotkey: z.string().default('Ctrl+Alt+A').description('全局快捷键，例如 Ctrl+Alt+A。'),
  saveDirectory: z.string().default('').description('保存截图的目录，留空则使用「图片/DSH Screenshots」。'),
  action: z.union([
    z.const('copy').description('确认时复制到剪贴板。'),
    z.const('save').description('确认时保存到目录。'),
  ]).default('copy').description('按下 Enter 或点击确认按钮时的默认动作。'),
  ocrModel: z.string().default('').description(
    '提取文字使用的大模型：填模型名（如 deepseek-v4.1-flash），或「提供方/模型」指定路由。留空则自动选择支持图像输入的模型，都不可用时回退到本地 OCR。',
  ),
}).volatile()

/**
 * @typedef {{
 *   start?: { x: number, y: number },
 *   current?: { x: number, y: number },
 *   selection?: { x: number, y: number, w: number, h: number },
 *   pointerSurface?: bigint,
 *   pointerX: number,
 *   pointerY: number,
 *   hover?: string,
 *   pressed?: string,
 *   toolbarSurface?: bigint,
 * }} Interaction
 */

/** @returns the configured directory, with `~` expanded. */
export function resolveDirectory(configured) {
  const trimmed = (configured ?? '').trim()
  if (trimmed.length === 0) return join(homedir(), 'Pictures', 'DSH Screenshots')
  if (trimmed === '~') return homedir()
  if (trimmed.startsWith('~/') || trimmed.startsWith('~\\')) return join(homedir(), trimmed.slice(2))
  return trimmed
}

/**
 * The headless screenshot service.
 *
 * Everything happens on this process' thread through a Win32 message pump the
 * service drives itself: no window of the DSH shell is involved, so a shot works
 * exactly the same whether the DSH window is focused, backgrounded or minimised.
 */
export class ScreenshotService {
  /**
   * @param ctx - the Cordis context.
   * @param config - the validated {@link Config}.
   */
  constructor(ctx, config) {
    this.ctx = ctx
    this.config = config
    this.logger = ctx.logger?.(NS) ?? console
    this.className = `DSH_SCREENSHOT_${process.pid}`
    this.hotkeyWindow = undefined
    this.wndproc = undefined
    this.classRegistered = false
    this.overlay = new Overlay({ className: this.className })
    this.panel = new ResultCard({ className: this.className })
    this.surfaces = new Map()
    this.interaction = undefined
    this.capture = undefined
    this.previousWindow = undefined
    this.shotStartedAt = 0
    this.escapeLatched = false
    this.held = undefined
    this.ids = undefined
    this.threadHotkey = false
    this.pumpHandle = undefined
    this.pumping = false
    this.stopped = false
  }

  /**
   * Read the live config values.
   *
   * A volatile schema arrives as a wrapper exposing only `get()`, so the root
   * has to be unwrapped before any field is readable — `config.enabled` is
   * `undefined` on the wrapper itself.
   */
  settings() {
    const unwrap = (value) => (
      value !== null && typeof value === 'object' && typeof value.get === 'function'
        ? value.get()
        : typeof value === 'function' ? value() : value
    )
    const read = (value, fallback) => {
      const plain = unwrap(value)
      return plain === undefined || plain === null ? fallback : plain
    }
    const config = unwrap(this.config) ?? {}
    return {
      enabled: read(config.enabled, true) !== false,
      hotkey: String(read(config.hotkey, 'Ctrl+Alt+A')),
      saveDirectory: String(read(config.saveDirectory, '')),
      action: read(config.action, 'copy') === 'save' ? 'save' : 'copy',
      ocrModel: String(read(config.ocrModel, '')),
    }
  }

  /** Register the window class, the hotkey window and the global hotkey. */
  start() {
    const { koffi, api, types } = win32()
    record(`start pid=${process.pid} platform=${process.platform}`)
    // Physical-pixel geometry is what both the capture and the overlays assume.
    api.setProcessDpiAwarenessContext(-4)
    // Never let a JS exception escape a native callback: crossing that boundary
    // is what turns a plugin bug into a `napi_fatal_error` and kills the host.
    this.wndproc = koffi.register(
      (hwnd, message, wParam, lParam) => {
        try {
          return this.dispatch(hwnd, message, wParam, lParam)
        } catch (error) {
          this.logger.warn?.(`dsh-screenshot: 消息处理失败 (${message}): ${error?.message ?? error}`)
          return 0
        }
      },
      koffi.pointer(types.WNDPROC),
    )
    const info = {
      cbSize: koffi.sizeof(types.WNDCLASSEXW),
      style: 0,
      lpfnWndProc: this.wndproc,
      cbClsExtra: 0,
      cbWndExtra: 0,
      hInstance: api.kernelGetModuleHandleW(null),
      hIcon: null,
      hCursor: api.loadCursorW(null, IDC_CROSS),
      hbrBackground: null,
      lpszMenuName: null,
      lpszClassName: this.className,
      hIconSm: null,
    }
    if (api.registerClassExW(info) === 0) {
      throw new Error(`dsh-screenshot: RegisterClassExW failed (${api.kernelGetLastError()})`)
    }
    this.classRegistered = true
    this.hotkeyWindow = api.createWindowExW(
      0, this.className, 'dsh-screenshot', 0,
      0, 0, 0, 0, null, null, api.kernelGetModuleHandleW(null), null,
    )
    if (!this.hotkeyWindow) throw new Error(`dsh-screenshot: could not create the hotkey window (${api.kernelGetLastError()})`)
    this.syncHotkey()
    this.startPump()
    record(`started: held=${this.held ?? 'NONE'} thread=${this.threadHotkey === true} enabled=${this.settings().enabled} wanted=${this.settings().hotkey}`)
    // "The model cannot see images" is the likeliest reason extraction fails,
    // and it is invisible from the UI, so put the routes in the log.
    void describeRoutes(llmOf(this.ctx)).then(
      (summary) => this.logger.info?.(`dsh-screenshot: 可用模型 ${summary}`),
      (error) => this.logger.warn?.(`dsh-screenshot: 读取模型列表失败: ${error?.message ?? error}`),
    )
  }

  /**
   * Bind the hotkey to match the current settings.
   *
   * Exactly one chord is held: the configured one, or — when another program
   * already owns it, as WeChat does with `Ctrl+Alt+A` — the first fallback that
   * Windows grants.
   * @returns `true` when this process now owns a chord.
   */
  syncHotkey() {
    const { api } = win32()
    if (this.ids !== undefined) {
      for (const id of this.ids) api.unregisterHotKey(this.hotkeyWindow ?? null, id)
      this.ids = undefined
    }
    this.held = undefined
    this.threadHotkey = false
    const settings = this.settings()
    if (!settings.enabled) {
      record('syncHotkey: disabled in settings')
      return false
    }
    const candidates = [settings.hotkey, ...FALLBACK_HOTKEYS].filter(
      (value, index, all) => all.indexOf(value) === index,
    )
    // Two ways to own a chord. The window form is the normal one; the thread
    // form needs no window at all, so it still works when the window could not
    // be created — which is otherwise a silent, total loss of the hotkey.
    const targets = this.hotkeyWindow
      ? [{ label: 'window', handle: this.hotkeyWindow }, { label: 'thread', handle: null }]
      : [{ label: 'thread', handle: null }]
    for (const target of targets) {
      for (const [offset, candidate] of candidates.entries()) {
        const parsed = parseHotkey(candidate)
        if (parsed === undefined) {
          record(`syncHotkey: ${candidate} unparsable`)
          if (offset === 0) this.logger.warn?.(`dsh-screenshot: "${candidate}" 不是可用的快捷键`)
          continue
        }
        const id = HOTKEY_ID + offset
        let granted = false
        let thrown
        try {
          granted = api.registerHotKey(target.handle, id, parsed.modifiers, parsed.vk)
        } catch (error) {
          thrown = error?.message ?? String(error)
        }
        const code = granted ? 0 : (thrown === undefined ? api.kernelGetLastError() : 0)
        record(`syncHotkey: ${target.label} ${candidate} -> ${granted ? 'ok' : `fail ${code}${thrown === undefined ? '' : ` (${thrown})`}`}`)
        if (granted) {
          this.ids = new Set([id])
          this.held = candidate
          this.threadHotkey = target.handle === null
          if (offset > 0) {
            this.logger.warn?.(`dsh-screenshot: 首选快捷键 "${settings.hotkey}" 不可用，已改用 "${candidate}"`)
          }
          return true
        }
        if (offset === 0 && target === targets[0]) {
          this.logger.warn?.(`dsh-screenshot: "${candidate}" 已被其它程序占用 (${code})，尝试备用快捷键`)
        }
      }
    }
    record('syncHotkey: every candidate failed')
    this.logger.warn?.('dsh-screenshot: 没有可用的全局快捷键，截图无法通过键盘触发，请在设置里换一个组合')
    return false
  }

  /**
   * Drive the Win32 message loop. A `setImmediate` chain keeps the loop on this
   * thread (which owns the queue) without adding a timer or a worker thread.
   */
  startPump() {
    if (this.pumping) return
    this.pumping = true
    const { koffi, api, types } = win32()
    const size = koffi.sizeof(types.MSG)
    const tick = () => {
      if (this.stopped) {
        this.pumping = false
        return
      }
      // Drain everything that is queued, then yield so the host stays responsive.
      let handled = 0
      for (; handled < 64; handled += 1) {
        const buffer = Buffer.alloc(size)
        // `PM_REMOVE`; a non-blocking peek keeps the loop cooperative.
        if (!api.peekMessageW(buffer, null, 0, 0, 1)) break
        if (this.stopped) break
        const message = koffi.decode(buffer, types.MSG)
        // `WM_HOTKEY` is taken here rather than in the window procedure so both
        // registration forms work: a window hotkey arrives addressed to that
        // window, a thread hotkey arrives with no window at all, and
        // `DispatchMessageW` would drop the latter on the floor.
        if (message.message === WM_HOTKEY && this.ids?.has(Number(message.wParam)) === true) {
          try {
            this.beginShot()
          } catch (error) {
            record(`WM_HOTKEY beginShot failed: ${error?.message ?? error}`)
            this.logger.warn?.(`dsh-screenshot: 截图启动失败: ${error?.message ?? error}`)
          }
          continue
        }
        try {
          api.translateMessage(buffer)
          api.dispatchMessageW(buffer)
        } catch (error) {
          this.logger.warn?.(`dsh-screenshot: 消息分发失败: ${error?.message ?? error}`)
        }
        if (message.message === WM_QUIT) {
          this.stopped = true
          break
        }
      }
      if (this.stopped) {
        this.pumping = false
        return
      }
      // While a shot is open, `Esc` is also watched directly: Windows often
      // refuses to hand the foreground to a background process, and without
      // focus no `WM_KEYDOWN` would ever arrive. The edge latch keeps one press
      // from doing two things — closing the card *and* the shot.
      const escape = this.escapeHeld()
      if (escape !== true) {
        this.escapeLatched = false
      } else if (this.escapeLatched !== true && Date.now() - this.shotStartedAt > 250) {
        this.escapeLatched = true
        this.onEscape()
      }
      // Sleep briefly when idle instead of spinning the event loop red hot, and
      // stay immediate while messages are flowing so drags feel live.
      this.pumpHandle = handled > 0 ? setImmediate(tick) : setTimeout(tick, 8)
    }
    this.pumpHandle = setImmediate(tick)
  }

  /**
   * `Esc` means "step back one level": the result card first, then the shot.
   *
   * Keeping the screenshot alive behind the card is the whole point — the text
   * has to stay obviously attached to where it came from — so a single `Esc`
   * dismisses the result without tearing the shot down.
   */
  onEscape() {
    if (this.panel.handle !== 0) {
      this.closePanel()
      return
    }
    if (this.interaction !== undefined) this.cancel()
  }

  /** @returns whether `Esc` is physically down right now. */
  escapeHeld() {
    const { api } = win32()
    try {
      return (Number(api.getAsyncKeyState(VK_ESCAPE)) & 0x8000) !== 0
    } catch {
      return false
    }
  }

  /**
   * Turn a wheel notch into a card scroll.
   * @param keyState - the `wParam` of a `WM_MOUSEWHEEL`, delta in the high word.
   */
  rollCard(keyState) {
    const raw = (Number(keyState) >>> 16) & 0xffff
    const delta = raw >= 0x8000 ? raw - 0x10000 : raw
    if (delta === 0) return
    // A notch is 120; three text lines is what feels right at any DPI.
    const step = Math.round((-delta / 120) * 48 * (this.panel.scale ?? 1))
    this.panel.scroll(step)
  }

  /**
   * The shared window procedure.
   * @returns 0 when handled, otherwise the default-procedure result.
   */
  dispatch(hwnd, message, wParam, lParam) {
    const { api } = win32()
    if (message === WM_HOTKEY && (hwnd === this.hotkeyWindow || hwnd === null)) {
      if (this.ids?.has(Number(wParam)) === true) this.beginShot()
      return 0
    }
    if (this.interaction !== undefined && this.surfaces.has(String(hwnd))) {
      if (this.handleOverlay(hwnd, message, wParam, lParam)) return 0
    }
    if (this.panel.owns(hwnd)) {
      // The card is read-only: a click on it must not dismiss it, or a stray
      // click destroys the text the user was about to read.
      if (message === WM_LBUTTONDOWN || message === WM_RBUTTONDOWN || message === WM_LBUTTONUP) {
        return 0
      }
      if (message === WM_KEYDOWN && Number(wParam) === VK_ESCAPE) {
        this.escapeLatched = true
        this.closePanel()
        return 0
      }
      if (message === WM_MOUSEWHEEL) {
        this.rollCard(wParam)
        return 0
      }
      if (message === WM_SETCURSOR) {
        api.setCursor(api.loadCursorW(null, IDC_ARROW))
        return 1
      }
      if (message === WM_NCHITTEST) return HTCLIENT
    }
    switch (message) {
      case WM_PAINT: {
        const { koffi, types } = win32()
        const paint = Buffer.alloc(koffi.sizeof(types.PAINTSTRUCT))
        api.beginPaint(hwnd, paint)
        api.endPaint(hwnd, paint)
        return 0
      }
      case WM_ERASEBKGND:
        return 1
      case WM_SETCURSOR: {
        const surface = this.overlay.surfaceOf(hwnd)
        const arrow = surface !== undefined
          && this.interaction !== undefined
          && (this.interaction.hover !== undefined || this.interaction.selection !== undefined)
        api.setCursor(api.loadCursorW(null, arrow ? IDC_ARROW : IDC_CROSS))
        return 1
      }
      case WM_NCHITTEST:
        return HTCLIENT
      default:
        return api.defWindowProcW(hwnd, message, wParam, lParam)
    }
  }

  /** Split the packed `WM_*MOUSE` lParam into signed surface coordinates. */
  coordinates(lParam) {
    const value = Number(lParam)
    const x = value & 0xffff
    const y = (value >>> 16) & 0xffff
    return {
      x: x >= 0x8000 ? x - 0x10000 : x,
      y: y >= 0x8000 ? y - 0x10000 : y,
    }
  }

  /**
   * Handle a message aimed at an overlay surface.
   * @returns `true` when the message was consumed.
   */
  handleOverlay(hwnd, message, wParam, lParam) {
    const surface = this.overlay.surfaceOf(hwnd)
    const interaction = this.interaction
    if (surface === undefined || interaction === undefined) return false
    const local = this.coordinates(lParam)
    const screen = { x: local.x + surface.display.left, y: local.y + surface.display.top }
    switch (message) {
      case WM_MOUSEMOVE: {
        interaction.pointerSurface = hwnd
        interaction.pointerX = local.x
        interaction.pointerY = local.y
        if (interaction.start !== undefined) {
          interaction.current = screen
          this.updateSelection(interaction)
          this.paintAll()
          return true
        }
        if (interaction.selection !== undefined) {
          const next = buttonAt(surface, local.x, local.y)?.id
          if (next !== interaction.hover) {
            interaction.hover = next
            this.paintAll()
          }
        }
        return true
      }
      case WM_LBUTTONDOWN: {
        // Clicking the shot while the card is open steps back to the selection
        // instead of starting a new drag: the card is one level, the shot is the
        // next, and a click should never destroy both at once.
        if (this.panel.handle !== 0) {
          this.closePanel()
          this.paintAll()
          return true
        }
        if (interaction.pressed !== undefined) return true
        const over = buttonAt(surface, local.x, local.y)
        if (over !== undefined) {
          interaction.pressed = over.id
          this.paintAll()
          return true
        }
        // Starting a new drag discards the finished selection and its toolbar.
        interaction.selection = undefined
        interaction.hover = undefined
        interaction.toolbarSurface = undefined
        interaction.textDone = false
        interaction.start = screen
        interaction.current = screen
        this.updateSelection(interaction)
        this.paintAll()
        return true
      }
      case WM_LBUTTONUP: {
        if (interaction.pressed !== undefined) {
          const pressed = interaction.pressed
          const over = buttonAt(surface, local.x, local.y)
          interaction.pressed = undefined
          this.paintAll()
          if (over !== undefined && over.id === pressed) this.activate(over.id, wParam)
          return true
        }
        if (interaction.start === undefined) return true
        interaction.current = screen
        this.updateSelection(interaction)
        interaction.start = undefined
        interaction.current = undefined
        // A stray click is not a selection: drop it and keep waiting.
        if (interaction.selection !== undefined
          && (interaction.selection.w < 4 || interaction.selection.h < 4)) {
          interaction.selection = undefined
        } else {
          interaction.toolbarSurface = hwnd
        }
        this.paintAll()
        return true
      }
      case WM_RBUTTONDOWN:
      case WM_RBUTTONUP:
        this.cancel()
        return true
      case WM_MOUSEWHEEL: {
        // Wheel messages go to the focused window — the overlay — so a scroll
        // over the card has to be forwarded to it by hand.
        const packed = Number(lParam)
        const x = packed & 0xffff
        const y = (packed >>> 16) & 0xffff
        if (this.panel.contains(x >= 0x8000 ? x - 0x10000 : x, y >= 0x8000 ? y - 0x10000 : y)) {
          this.rollCard(wParam)
        }
        return true
      }
      case WM_KEYDOWN: {
        const key = Number(wParam)
        if (key === VK_ESCAPE) {
          this.escapeLatched = true
          this.onEscape()
          return true
        }
        if (key === VK_RETURN) {
          this.confirm(this.settings().action)
          return true
        }
        return true
      }
      default:
        return false
    }
  }

  /** Recompute the normalised selection rectangle from the drag anchors. */
  updateSelection(interaction) {
    if (interaction.start === undefined || interaction.current === undefined) {
      interaction.selection = undefined
      return
    }
    const left = Math.min(interaction.start.x, interaction.current.x)
    const top = Math.min(interaction.start.y, interaction.current.y)
    const right = Math.max(interaction.start.x, interaction.current.x)
    const bottom = Math.max(interaction.start.y, interaction.current.y)
    interaction.selection = { x: left, y: top, w: right - left, h: bottom - top }
  }

  /** @returns the selection as one surface sees it, in that surface's pixels. */
  clippedSelection(surface) {
    const selection = this.interaction?.selection
    if (selection === undefined) return undefined
    const left = Math.max(0, selection.x - surface.display.left)
    const top = Math.max(0, selection.y - surface.display.top)
    const right = Math.min(surface.width, selection.x + selection.w - surface.display.left)
    const bottom = Math.min(surface.height, selection.y + selection.h - surface.display.top)
    if (right <= left || bottom <= top) return undefined
    return { x: left, y: top, w: right - left, h: bottom - top }
  }

  /** Render and present every overlay surface. */
  paintAll() {
    const interaction = this.interaction
    if (interaction === undefined) return
    for (const surface of this.overlay.surfaces) {
      // One bad surface must not stop the others from painting, and must never
      // escape into the window procedure.
      try {
        const selection = this.clippedSelection(surface)
        // A drag only changes the monitor it happens on, so identical frames are
        // skipped entirely: no re-render, no upload, no layered-window update.
        const signature = [
          selection ? `${selection.x},${selection.y},${selection.w},${selection.h}` : '-',
          String(interaction.pointerSurface),
          interaction.pointerX,
          interaction.pointerY,
          interaction.hover ?? '-',
          interaction.pressed ?? '-',
          String(interaction.toolbarSurface),
          interaction.busy === true ? 'busy' : '-',
          interaction.notice ?? '-',
          interaction.textDone === true ? 'text' : '-',
        ].join('|')
        if (surface.lastPaint === signature) continue
        surface.lastPaint = signature
        // The in-progress rectangle lives in `interaction.selection` too, so a
        // drag gives live feedback instead of only showing chrome on release.
        this.overlay.paint(surface, {
          selection,
          pointerSurface: interaction.pointerSurface,
          pointerX: interaction.pointerX,
          pointerY: interaction.pointerY,
          hover: interaction.hover,
          pressed: interaction.pressed,
          toolbarSurface: interaction.toolbarSurface,
          busy: interaction.busy,
          notice: interaction.notice,
          textDone: interaction.textDone,
        })
      } catch (error) {
        this.logger.warn?.(`dsh-screenshot: 绘制失败: ${error?.message ?? error}`)
      }
    }
  }

  /** @returns the overlay surface under the mouse pointer, if any. */
  surfaceNearPointer() {
    const { api } = win32()
    try {
      const buffer = Buffer.alloc(8)
      if (!api.readCursorPosition(buffer)) return undefined
      return this.overlay.surfaceAt(buffer.readInt32LE(0), buffer.readInt32LE(4))
    } catch {
      return undefined
    }
  }

  /** Freeze the desktop and reveal an overlay on every monitor. */
  beginShot() {
    if (this.stopped) return
    const { api } = win32()
    if (!this.settings().enabled) return
    // A new shot replaces whatever the previous one left on screen.
    this.closePanel()
    // A second hotkey press while a shot is open simply restarts it.
    if (this.interaction !== undefined || this.capture !== undefined) this.close()
    let capture
    try {
      capture = captureDesktop(listDisplays())
    } catch (error) {
      this.logger.warn?.(`dsh-screenshot: 抓屏失败: ${error?.message ?? error}`)
      return
    }
    this.capture = capture
    this.shotStartedAt = Date.now()
    // Remember who had focus so the user's app gets it back after the shot.
    this.previousWindow = api.getForegroundWindow()
    this.interaction = {
      pointerX: 0,
      pointerY: 0,
      pointerSurface: undefined,
    }
    try {
      this.surfaces.clear()
      const surfaces = this.overlay.open(capture, capture.displays, (handle, surface) => {
        this.surfaces.set(String(handle), surface)
      })
      for (const surface of surfaces) {
        try {
          this.overlay.paint(surface, {
            selection: undefined,
            pointerSurface: undefined,
            pointerX: 0,
            pointerY: 0,
            hover: undefined,
            pressed: undefined,
            toolbarSurface: undefined,
          })
        } catch (error) {
          record(`paint failed on ${surface.width}x${surface.height}: ${error?.message ?? error}`)
          throw error
        }
      }
      record(`shot open: ${surfaces.length} surface(s), held=${this.held ?? '-'}`)
      // The overlay has to be the foreground window for `Esc` and `Enter` to
      // arrive as key messages, and it must be the monitor the pointer is on:
      // taking the foreground on another monitor hides the toolbar there. Mouse
      // capture is deliberately not used — full-screen windows already tile the
      // desktop, so each one receives the moves made over it, and a drag that
      // crosses monitors keeps working.
      const focused = this.surfaceNearPointer() ?? this.overlay.surfaces[0]
      api.setForegroundWindow(focused.handle)
      api.setFocus(focused.handle)
    } catch (error) {
      record(`overlay failed: ${error?.message ?? error}`)
      this.logger.warn?.(`dsh-screenshot: 覆盖层创建失败: ${error?.message ?? error}`)
      this.close()
    }
  }

  /**
   * Run a toolbar action: each button does exactly what it says, and Ctrl swaps
   * it for the other one.
   */
  activate(id, keyState) {
    if (id === 'cancel') {
      this.cancel()
      return
    }
    if (id === 'text') {
      // Recognising again replaces the card rather than stacking a second one.
      this.closePanel()
      // Recognition is asynchronous, so it must not block the message pump.
      void this.extractText()
      return
    }
    const ctrl = (Number(keyState) & MK_CONTROL) !== 0
    const wanted = ctrl ? (id === 'copy' ? 'save' : 'copy') : id
    this.confirm(wanted)
  }

  /**
   * Crop the selection, transcribe it, and show the result on the right.
   *
   * The vision model is tried first because it reads mixed Chinese/English,
   * code and handwriting far better than the local engine; the local Windows
   * OCR stays as a fallback for offline or unconfigured deployments. The
   * overlay stays up meanwhile so the click never looks ignored.
   */
  async extractText() {
    const interaction = this.interaction
    const capture = this.capture
    const selection = interaction?.selection
    if (interaction === undefined || capture === undefined || selection === undefined) return
    if (interaction.busy === true) return
    interaction.busy = true
    interaction.notice = undefined
    this.paintAll()
    let cropped
    try {
      cropped = cropBitmap(capture.bitmap, capture.bounds, {
        left: selection.x,
        top: selection.y,
        right: selection.x + selection.w,
        bottom: selection.y + selection.h,
      })
    } catch (error) {
      this.logger.warn?.(`dsh-screenshot: 裁剪失败: ${error?.message ?? error}`)
      this.close()
      return
    }
    const settings = this.settings()
    let result
    let engine = 'model'
    let modelError
    try {
      result = await recognizeWithModel(this.ctx, cropped.bitmap, { model: settings.ocrModel })
      if (result.ok !== true) {
        modelError = result.error
        this.logger.warn?.(`dsh-screenshot: 大模型识别失败 (${result.error})，改用本地 OCR`)
        engine = 'local'
        const local = await recognizeText(cropped.bitmap)
        // A local engine that finds nothing is worth reporting as such, but a
        // model failure with a local success must still show the text.
        result = local
      }
    } catch (error) {
      modelError = error?.message ?? String(error)
      result = { ok: false, error: modelError, text: '' }
    } finally {
      cropped.bitmap.dispose()
    }

    // The user may have cancelled while recognition is running.
    if (this.interaction !== interaction) return

    // When both engines come up empty, the only useful thing left to say is
    // which models this machine actually offers, so the fix is visible in the
    // panel instead of buried in a log the user has to know how to open.
    if (result?.ok !== true) {
      result = {
        ...result,
        failure: modelError ?? result?.error ?? 'unknown',
      }
      try {
        result.catalogue = await describeCatalogue(llmOf(this.ctx))
      } catch { /* a catalogue is a nicety, not a requirement */ }
    }

    const anchor = { x: selection.x, y: selection.y, w: selection.w, h: selection.h }
    const display = this.displayFor(anchor)
    // The shot deliberately stays on screen. Tearing the overlay down here is
    // what made the result feel detached: the text appeared with no visible
    // source, and the selection the user had just drawn vanished. The card is a
    // second window laid beside the selection instead.
    interaction.busy = false
    interaction.textDone = result?.ok === true && typeof result.text === 'string'
    this.paintAll()
    this.showResult(result, {
      engine,
      anchor,
      display,
      elapsed: Date.now() - this.shotStartedAt,
    })
  }

  /**
   * The monitor holding a selection.
   * @param anchor - the selection, already in screen coordinates.
   */
  displayFor(anchor) {
    try {
      const centerX = anchor.x + anchor.w / 2
      const centerY = anchor.y + anchor.h / 2
      const displays = listDisplays()
      const found = displays.find(
        (display) => centerX >= display.left && centerX < display.right
          && centerY >= display.top && centerY < display.bottom,
      )
      return found ?? displays.find((display) => display.primary) ?? displays[0]
    } catch {
      return undefined
    }
  }

  /**
   * Put the recognised text on the clipboard and lay a card beside the selection.
   * @param result - what the recogniser returned.
   * @param context - where the selection was, so the card lands next to it.
   */
  showResult(result, context) {
    const text = typeof result.text === 'string' ? result.text : ''
    const characters = [...text].length
    let title
    let body
    let hint
    let count = ''
    let failed = false
    if (result.ok !== true) {
      failed = true
      title = '未能提取文字'
      const lines = [`大模型：${result.failure ?? '未知错误'}`]
      if (result.catalogue !== undefined) {
        lines.push('', '这台机器上可选的模型：', result.catalogue, '',
          '在「设置 → 截图 → 识别模型」里填其中一个即可（只填模型名也行）。')
      }
      body = lines.join('\n')
      hint = 'Esc 关闭'
    } else if (characters === 0) {
      title = '没有找到文字'
      body = '这个选区里没有可识别的文字。'
      hint = 'Esc 关闭'
    } else {
      const copied = writeClipboardText(text)
      title = '已提取文字'
      body = text
      count = `${characters} 字`
      hint = copied ? '已复制 · Esc 关闭' : '剪贴板正忙 · Esc 关闭'
    }
    const engineLabel = context.engine === 'local' ? '本地 OCR' : (result.route ?? '大模型')
    this.logger.info?.(`dsh-screenshot: [${engineLabel}] ${characters} 字\n${text}`)

    const display = context.display
    if (display === undefined) return
    // The card blurs the *frozen frame* rather than the live desktop, so the
    // glass is stable and matches the veiled shot around it.
    const seconds = Math.max(0.1, (context.elapsed ?? 0) / 1000)
    const meta = `${engineLabel} · ${seconds < 10 ? seconds.toFixed(1) : Math.round(seconds)}s`
    try {
      this.panel.open({
        text: body,
        title,
        meta,
        count,
        hint,
        failed,
        display,
        capture: this.capture,
        bounds: this.capture?.bounds,
        // Screen coordinates: the card is placed against the selection itself.
        selection: context.anchor,
        // The bar hangs under the selection now, so the card has to step around
        // it rather than covering the buttons.
        avoid: this.toolbarRect(),
        scale: Math.max(1, Math.round((display.dpi / 96) * 2) / 2),
      })
    } catch (error) {
      this.logger.warn?.(`dsh-screenshot: 结果卡片创建失败: ${error?.message ?? error}`)
      record(`card failed: ${error?.message ?? error}`)
      return
    }
  }

  /** Dismiss the result card, leaving the shot itself alone. */
  closePanel() {
    if (this.panel.handle === 0) return
    try {
      this.panel.close()
    } catch (error) {
      this.logger.warn?.(`dsh-screenshot: 结果卡片关闭失败: ${error?.message ?? error}`)
    }
  }

  /**
   * The on-screen rectangle of the toolbar, when one is showing.
   * @returns a screen-space rectangle, or `undefined`.
   */
  toolbarRect() {
    const interaction = this.interaction
    if (interaction === undefined) return undefined
    const surface = this.overlay.surfaces.find(
      (candidate) => candidate.toolbar !== undefined
        && String(candidate.handle) === String(interaction.toolbarSurface),
    )
    if (surface === undefined) return undefined
    return {
      left: surface.display.left + surface.toolbar.left,
      top: surface.display.top + surface.toolbar.top,
      right: surface.display.left + surface.toolbar.right,
      bottom: surface.display.top + surface.toolbar.bottom,
    }
  }

  /** Crop the selection and publish it. */
  confirm(action) {
    const interaction = this.interaction
    const capture = this.capture
    const selection = interaction?.selection
    if (interaction === undefined || capture === undefined || selection === undefined) return
    const settings = this.settings()
    let cropped
    try {
      cropped = cropBitmap(capture.bitmap, capture.bounds, {
        left: selection.x,
        top: selection.y,
        right: selection.x + selection.w,
        bottom: selection.y + selection.h,
      })
    } catch (error) {
      this.logger.warn?.(`dsh-screenshot: 裁剪失败: ${error?.message ?? error}`)
      this.close()
      return
    }
    try {
      if (action === 'save') {
        const target = savePng(cropped.bitmap, resolveDirectory(settings.saveDirectory))
        this.logger.info?.(`dsh-screenshot: 已保存到 ${target}`)
      } else if (!writeClipboard(cropped.bitmap)) {
        this.logger.warn?.('dsh-screenshot: 剪贴板拒绝了这张图片')
      }
    } catch (error) {
      this.logger.warn?.(`dsh-screenshot: 输出失败: ${error?.message ?? error}`)
    } finally {
      cropped.bitmap.dispose()
      this.close()
    }
  }

  /** Abandon the shot without publishing anything. */
  cancel() {
    this.close()
  }

  /** Hide the overlays, drop the session and release the frozen desktop. */
  close() {
    const { api } = win32()
    this.interaction = undefined
    // The card outlives nothing: it belongs to this shot.
    try {
      this.closePanel()
    } catch { /* the card may already be gone */ }
    if (this.noticeTimer !== undefined) {
      clearTimeout(this.noticeTimer)
      this.noticeTimer = undefined
    }
    try {
      this.overlay.close()
    } catch (error) {
      this.logger.warn?.(`dsh-screenshot: 覆盖层清理失败: ${error?.message ?? error}`)
    }
    this.surfaces.clear()
    if (this.capture?.bitmap) {
      this.capture.bitmap.dispose()
      this.capture = undefined
    }
    if (this.hotkeyWindow) api.setCapture(null)
    // Hand focus back to whatever the user was doing before the hotkey fired.
    if (this.previousWindow) {
      const previous = this.previousWindow
      this.previousWindow = undefined
      try {
        if (api.isWindow(previous)) api.setForegroundWindow(previous)
      } catch { /* the window may be gone */ }
    }
  }

  /** Release every native resource. */
  dispose() {
    if (this.stopped) return
    const { api, koffi } = win32()
    try {
      this.close()
    } catch { /* the windows may already be gone */ }
    try {
      this.closePanel()
    } catch { /* the panel may already be gone */ }
    if (this.pumpHandle !== undefined) {
      // The pump alternates between `setImmediate` and `setTimeout`; both
      // cancels are harmless when applied to the other kind of handle.
      clearImmediate(this.pumpHandle)
      clearTimeout(this.pumpHandle)
      this.pumpHandle = undefined
    }
    if (this.ids !== undefined && this.hotkeyWindow) {
      for (const id of this.ids) api.unregisterHotKey(this.hotkeyWindow, id)
    }
    this.ids = undefined
    this.held = undefined
    if (this.hotkeyWindow) {
      api.postMessageW(this.hotkeyWindow, WM_QUIT, 0, 0)
      api.destroyWindow(this.hotkeyWindow)
      this.hotkeyWindow = undefined
    }
    if (this.wndproc !== undefined) {
      koffi.unregister(this.wndproc)
      this.wndproc = undefined
    }
    if (this.classRegistered) {
      api.unregisterClassW(this.className, api.kernelGetModuleHandleW(null))
      this.classRegistered = false
    }
    this.stopped = true
    this.pumping = false
  }
}

/**
 * The instance that owns this process' windows.
 *
 * The same plugin can legitimately appear twice in the composition — the desktop
 * bundle inserts it, and the settings layer writes its own entry once a value is
 * edited there. There is only ever one set of overlay windows and one hotkey per
 * process, so the duplicate is folded into the running instance: the newer config
 * is adopted in place. Registering a second window class under the same name
 * would otherwise fail and leave the user's edited config attached to a corpse.
 */
let active

/**
 * Register the screenshot service on the host process.
 * @param ctx - the Cordis context.
 * @param config - the validated {@link Config}.
 */
export function apply(ctx, config) {
  if (process.platform !== 'win32') {
    ctx.logger?.(NS).warn?.('dsh-screenshot 只支持 Windows，服务保持休眠')
    return
  }
  // A disposed instance is a corpse: its window class is gone and its hotkey is
  // released, so merging a reloaded entry into it would leave the plugin alive
  // in the composition but dead on the desktop. Start over instead.
  if (active !== undefined && active.stopped === true) {
    record('apply: previous instance was disposed, starting a fresh one')
    active = undefined
  }
  if (active !== undefined) {
    active.config = config
    const settings = active.settings()
    record(`apply: duplicate merged (enabled=${settings.enabled} hotkey=${settings.hotkey})`)
    try {
      active.syncHotkey()
    } catch (error) {
      record(`apply: merge syncHotkey failed: ${error?.message ?? error}`)
      ctx.logger?.(NS).warn?.(`dsh-screenshot 重复加载时更新配置失败: ${error?.message ?? error}`)
    }
    ctx.logger?.(NS).info?.('dsh-screenshot 已在运行，重复的加载项已合并为一次配置更新')
    return
  }
  const service = new ScreenshotService(ctx, config)
  active = service
  const settings = service.settings()
  record(`apply pid=${process.pid} enabled=${settings.enabled} hotkey=${settings.hotkey}`)
  ctx.effect(() => {
    try {
      service.start()
      ctx.logger?.(NS).info?.(`dsh-screenshot 已就绪，快捷键 ${service.held ?? '(未绑定)'}`)
    } catch (error) {
      record(`start failed: ${error?.message ?? error}`)
      ctx.logger?.(NS).warn?.(`dsh-screenshot 启动失败: ${error?.message ?? error}`)
    }
    return () => {
      record(`dispose pid=${process.pid}`)
      service.dispose()
      if (active === service) active = undefined
    }
  })
}

