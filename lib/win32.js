import { loadKoffi } from './native-require.js'

/** Win32 `MOD_*` hotkey modifiers. */
export const MOD = { ALT: 1, CONTROL: 2, SHIFT: 4, WIN: 8 }

/** `HC_ACTION`, the only `WM_GETMINMAXINFO`-free code the hook accepts. */
export const WM_HOTKEY = 0x0312

/** `UpdateLayeredWindow` blend constants. */
export const AC_SRC_ALPHA = 0x01
export const ULW_ALPHA = 0x02

/** `BitBlt` / `DIB` constants. */
export const SRCCOPY = 0x00cc0020
export const CAPTUREBLT = 0x40000000
export const BI_RGB = 0
export const DIB_RGB_COLORS = 0

/** `UpdateLayeredWindow` window styles. */
export const WS_POPUP = 0x80000000
export const WS_EX_LAYERED = 0x00080000
export const WS_EX_TOPMOST = 0x00000008
export const WS_EX_TOOLWINDOW = 0x00000080
export const WS_EX_NOACTIVATE = 0x08000000

/** `SetWindowPos` flags. */
export const SWP_NOSIZE = 0x0001
export const SWP_NOMOVE = 0x0002
export const SWP_NOACTIVATE = 0x0010
export const SWP_SHOWWINDOW = 0x0040

/** `ShowWindow` commands. */
export const SW_SHOWNOACTIVATE = 4
export const SW_HIDE = 0

/** `HT*` hit-test results. */
export const HTCLIENT = 1

/** A few `WM_*` messages the overlay window procedure answers itself. */
export const WM_PAINT = 0x000f
export const WM_ERASEBKGND = 0x0014
export const WM_SETCURSOR = 0x0020
export const WM_LBUTTONDOWN = 0x0201
export const WM_LBUTTONUP = 0x0202
export const WM_MOUSEMOVE = 0x0200
export const WM_RBUTTONDOWN = 0x0204
export const WM_KEYDOWN = 0x0100
export const WM_CHAR = 0x0102
export const WM_DESTROY = 0x0002
export const WM_CLOSE = 0x0010
export const VK_ESCAPE = 0x1b
export const VK_RETURN = 0x0d
export const IDC_CROSS = 32515
export const IDC_ARROW = 32512
export const IDC_HAND = 32649

/** Friendly modifier names accepted when parsing a hotkey string. */
const MODIFIER_ALIASES = new Map([
  ['ctrl', MOD.CONTROL],
  ['control', MOD.CONTROL],
  ['alt', MOD.ALT],
  ['shift', MOD.SHIFT],
  ['win', MOD.WIN],
  ['meta', MOD.WIN],
  ['super', MOD.WIN],
  ['cmd', MOD.WIN],
])

/** Virtual-key codes for the named keys a hotkey may end with. */
const KEY_ALIASES = new Map([
  ['backspace', 0x08],
  ['tab', 0x09],
  ['enter', 0x0d],
  ['return', 0x0d],
  ['esc', 0x1b],
  ['escape', 0x1b],
  ['space', 0x20],
  ['pageup', 0x21],
  ['pagedown', 0x22],
  ['end', 0x23],
  ['home', 0x24],
  ['left', 0x25],
  ['up', 0x26],
  ['right', 0x27],
  ['down', 0x28],
  ['insert', 0x2d],
  ['delete', 0x2e],
  ['del', 0x2e],
  ['printscreen', 0x2c],
  ['pause', 0x13],
  ['`', 0xc0],
  ['-', 0xbd],
  ['=', 0xbb],
  ['[', 0xdb],
  [']', 0xdd],
  ['\\', 0xdc],
  [';', 0xba],
  ["'", 0xde],
  [',', 0xbc],
  ['.', 0xbe],
  ['/', 0xbf],
])

/**
 * Parse `Ctrl+Alt+A` style text into a Win32 hotkey pair.
 * @param text - user supplied accelerator.
 * @returns `{ modifiers, vk }`, or undefined when the text names no usable key.
 */
export function parseHotkey(text) {
  const parts = String(text ?? '')
    .split('+')
    .map((part) => part.trim().toLowerCase())
    .filter((part) => part.length > 0)
  if (parts.length === 0) return undefined
  let modifiers = 0
  let vk
  for (const part of parts) {
    const modifier = MODIFIER_ALIASES.get(part)
    if (modifier !== undefined) {
      modifiers |= modifier
      continue
    }
    const named = KEY_ALIASES.get(part)
    if (named !== undefined) {
      vk = named
      continue
    }
    if (/^f([1-9]|1[0-9]|2[0-4])$/.test(part)) {
      vk = 0x70 + Number(part.slice(1)) - 1
      continue
    }
    if (/^[a-z]$/.test(part)) {
      vk = part.toUpperCase().charCodeAt(0)
      continue
    }
    if (/^[0-9]$/.test(part)) {
      vk = 0x30 + Number(part)
      continue
    }
    return undefined
  }
  if (vk === undefined) return undefined
  return { modifiers, vk }
}

/**
 * Load the Win32 entry points this plugin uses and keep the argument type table
 * in one place. The desktop build is x64, so `__stdcall` folds into the default
 * calling convention and macros like `HMONITOR` are just `intptr_t`.
 * @param koffi - the FFI binding.
 * @returns the bound entry points and the structure types they exchange.
 */
function bindWin32(koffi) {
  const user32 = koffi.load('user32.dll')
  const gdi32 = koffi.load('gdi32.dll')
  const kernel32 = koffi.load('kernel32.dll')

  // Handles are plain `void *`. Koffi hands them to JavaScript as BigInt and
  // takes either BigInt or `null` back, so every handle also accepts the NULL
  // sentinel without a separate `intptr_t` spelling.
  const HANDLE = 'void *'

  const POINT = koffi.struct('DSH_POINT', { x: 'int32', y: 'int32' })
  const SIZE = koffi.struct('DSH_SIZE', { cx: 'int32', cy: 'int32' })
  const RECT = koffi.struct('DSH_RECT', { left: 'int32', top: 'int32', right: 'int32', bottom: 'int32' })
  const MSG = koffi.struct('DSH_MSG', {
    hwnd: HANDLE,
    message: 'uint32',
    wParam: 'uintptr_t',
    lParam: 'intptr_t',
    time: 'uint32',
    pt: POINT,
    lPrivate: 'uint32',
  })
  const BLENDFUNCTION = koffi.struct('DSH_BLENDFUNCTION', {
    BlendOp: 'uint8',
    BlendFlags: 'uint8',
    SourceConstantAlpha: 'uint8',
    AlphaFormat: 'uint8',
  })
  const BITMAPINFOHEADER = koffi.struct('DSH_BITMAPINFOHEADER', {
    biSize: 'uint32',
    biWidth: 'int32',
    biHeight: 'int32',
    biPlanes: 'uint16',
    biBitCount: 'uint16',
    biCompression: 'uint32',
    biSizeImage: 'uint32',
    biXPelsPerMeter: 'int32',
    biYPelsPerMeter: 'int32',
    biClrUsed: 'uint32',
    biClrImportant: 'uint32',
  })
  const MONITORINFO = koffi.struct('DSH_MONITORINFO', {
    cbSize: 'uint32',
    rcMonitor: RECT,
    rcWork: RECT,
    dwFlags: 'uint32',
  })
  const WNDCLASSEXW = koffi.struct('DSH_WNDCLASSEXW', {
    cbSize: 'uint32',
    style: 'uint32',
    lpfnWndProc: 'void *',
    cbClsExtra: 'int32',
    cbWndExtra: 'int32',
    hInstance: HANDLE,
    hIcon: HANDLE,
    hCursor: HANDLE,
    hbrBackground: HANDLE,
    lpszMenuName: 'str16',
    lpszClassName: 'str16',
    hIconSm: HANDLE,
  })
  const PAINTSTRUCT = koffi.struct('DSH_PAINTSTRUCT', {
    hdc: HANDLE,
    fErase: 'bool',
    rcPaint: RECT,
    fRestore: 'bool',
    fIncUpdate: 'bool',
    rgbReserved: 'uint8[32]',
  })

  // Every callback the plugin installs needs a prototype before the signature
  // that consumes it, and `koffi.register` wants the name form (`"X *"`), not
  // the `koffi.pointer()` object.
  const MONITORENUMPROC = koffi.proto('bool __stdcall DshMonitorEnumProc(void *hMon, void *hDC, void *rect, intptr_t data)')
  const WNDPROC = koffi.proto('intptr_t __stdcall DshWndProc(void *hwnd, uint32 msg, uintptr_t wParam, intptr_t lParam)')

  // `lib.func(name, ret, args)` declares and binds in one step; the two-argument
  // form afterwards would try to look the function name up as a type.
  const f = (lib, name, ret, args) => lib.func(name, ret, args)

  return {
    koffi,
    user32,
    gdi32,
    kernel32,
    types: {
      HANDLE,
      POINT,
      SIZE,
      RECT,
      MSG,
      BLENDFUNCTION,
      BITMAPINFOHEADER,
      MONITORINFO,
      WNDCLASSEXW,
      PAINTSTRUCT,
      MONITORENUMPROC,
      WNDPROC,
    },
    api: {
      // --- hotkey + message loop ------------------------------------------
      registerHotKey: f(user32, 'RegisterHotKey', 'bool', [HANDLE, 'int32', 'uint32', 'uint32']),
      unregisterHotKey: f(user32, 'UnregisterHotKey', 'bool', [HANDLE, 'int32']),
      getMessageW: f(user32, 'GetMessageW', 'int32', [koffi.out(koffi.pointer(MSG)), HANDLE, 'uint32', 'uint32']),
      peekMessageW: f(user32, 'PeekMessageW', 'bool', [koffi.out(koffi.pointer(MSG)), HANDLE, 'uint32', 'uint32', 'uint32']),
      translateMessage: f(user32, 'TranslateMessage', 'bool', [koffi.inout(koffi.pointer(MSG))]),
      dispatchMessageW: f(user32, 'DispatchMessageW', 'intptr_t', [koffi.inout(koffi.pointer(MSG))]),
      postQuitMessage: f(user32, 'PostQuitMessage', 'void', ['int32']),
      postMessageW: f(user32, 'PostMessageW', 'bool', [HANDLE, 'uint32', 'uintptr_t', 'intptr_t']),
      getKeyState: f(user32, 'GetKeyState', 'int16', ['int32']),
      getAsyncKeyState: f(user32, 'GetAsyncKeyState', 'int16', ['int32']),
      keybdEvent: f(user32, 'keybd_event', 'void', ['uint8', 'uint8', 'uint32', 'uintptr_t']),
      // --- window class ----------------------------------------------------
      defWindowProcW: f(user32, 'DefWindowProcW', 'intptr_t', [HANDLE, 'uint32', 'uintptr_t', 'intptr_t']),
      registerClassExW: f(user32, 'RegisterClassExW', 'uint16', [koffi.inout(koffi.pointer(WNDCLASSEXW))]),
      unregisterClassW: f(user32, 'UnregisterClassW', 'bool', ['str16', HANDLE]),
      createWindowExW: f(user32, 'CreateWindowExW', HANDLE, [
        'uint32', 'str16', 'str16', 'uint32', 'int32', 'int32', 'int32', 'int32',
        HANDLE, HANDLE, HANDLE, 'void *',
      ]),
      destroyWindow: f(user32, 'DestroyWindow', 'bool', [HANDLE]),
      setWindowPos: f(user32, 'SetWindowPos', 'bool', [HANDLE, HANDLE, 'int32', 'int32', 'int32', 'int32', 'uint32']),
      getWindowRect: f(user32, 'GetWindowRect', 'bool', [HANDLE, koffi.out(koffi.pointer(RECT))]),
      showWindow: f(user32, 'ShowWindow', 'bool', [HANDLE, 'int32']),
      updateWindow: f(user32, 'UpdateWindow', 'bool', [HANDLE]),
      invalidateRect: f(user32, 'InvalidateRect', 'bool', [HANDLE, 'void *', 'bool']),
      beginPaint: f(user32, 'BeginPaint', HANDLE, [HANDLE, koffi.out(koffi.pointer(PAINTSTRUCT))]),
      endPaint: f(user32, 'EndPaint', 'bool', [HANDLE, koffi.inout(koffi.pointer(PAINTSTRUCT))]),
      setCapture: f(user32, 'SetCapture', HANDLE, [HANDLE]),
      releaseCapture: f(user32, 'ReleaseCapture', 'bool', []),
      setFocus: f(user32, 'SetFocus', HANDLE, [HANDLE]),
      getFocus: f(user32, 'GetFocus', HANDLE, []),
      bringWindowToTop: f(user32, 'BringWindowToTop', 'bool', [HANDLE]),
      setForegroundWindow: f(user32, 'SetForegroundWindow', 'bool', [HANDLE]),
      getForegroundWindow: f(user32, 'GetForegroundWindow', HANDLE, []),
      setWindowLongPtrW: f(user32, 'SetWindowLongPtrW', 'intptr_t', [HANDLE, 'int32', 'intptr_t']),
      getWindowLongPtrW: f(user32, 'GetWindowLongPtrW', 'intptr_t', [HANDLE, 'int32']),
      isWindow: f(user32, 'IsWindow', 'bool', [HANDLE]),
      setCursor: f(user32, 'SetCursor', HANDLE, [HANDLE]),
      loadCursorW: f(user32, 'LoadCursorW', HANDLE, [HANDLE, 'intptr_t']),
      getCursorPos: f(user32, 'GetCursorPos', 'bool', [koffi.out(koffi.pointer(POINT))]),
      // Buffer-based variant: the caller passes eight writable bytes, which
      // keeps call sites free of koffi's out-parameter plumbing.
      readCursorPosition: f(user32, 'GetCursorPos', 'bool', ['void *']),
      getSystemMetrics: f(user32, 'GetSystemMetrics', 'int32', ['int32']),
      setProcessDpiAwarenessContext: f(user32, 'SetProcessDpiAwarenessContext', 'bool', ['intptr_t']),
      setThreadDpiAwarenessContext: f(user32, 'SetThreadDpiAwarenessContext', 'intptr_t', ['intptr_t']),
      // --- monitors + device contexts --------------------------------------
      getDC: f(user32, 'GetDC', HANDLE, [HANDLE]),
      releaseDC: f(user32, 'ReleaseDC', 'int32', [HANDLE, HANDLE]),
      getMonitorInfoW: f(user32, 'GetMonitorInfoW', 'bool', [HANDLE, 'void *']),
      enumDisplayMonitors: f(user32, 'EnumDisplayMonitors', 'bool', [HANDLE, HANDLE, 'void *', 'intptr_t']),
      registerClipboardFormatW: f(user32, 'RegisterClipboardFormatW', 'uint32', ['str16']),
      // --- clipboard -------------------------------------------------------
      openClipboard: f(user32, 'OpenClipboard', 'bool', [HANDLE]),
      closeClipboard: f(user32, 'CloseClipboard', 'bool', []),
      emptyClipboard: f(user32, 'EmptyClipboard', 'bool', []),
      setClipboardData: f(user32, 'SetClipboardData', HANDLE, ['uint32', HANDLE]),
      getClipboardData: f(user32, 'GetClipboardData', HANDLE, ['uint32']),
      isClipboardFormatAvailable: f(user32, 'IsClipboardFormatAvailable', 'bool', ['uint32']),
      enumClipboardFormats: f(user32, 'EnumClipboardFormats', 'uint32', ['uint32']),
      getClipboardFormatNameW: f(user32, 'GetClipboardFormatNameW', 'int32', ['uint32', 'void *', 'int32']),
      // --- gdi -------------------------------------------------------------
      gdiCreateCompatibleDC: f(gdi32, 'CreateCompatibleDC', HANDLE, [HANDLE]),
      gdiCreateCompatibleBitmap: f(gdi32, 'CreateCompatibleBitmap', HANDLE, [HANDLE, 'int32', 'int32']),
      gdiDeleteDC: f(gdi32, 'DeleteDC', 'bool', [HANDLE]),
      gdiSelectObject: f(gdi32, 'SelectObject', HANDLE, [HANDLE, HANDLE]),
      gdiDeleteObject: f(gdi32, 'DeleteObject', 'bool', [HANDLE]),
      gdiBitBlt: f(gdi32, 'BitBlt', 'bool', [HANDLE, 'int32', 'int32', 'int32', 'int32', HANDLE, 'int32', 'int32', 'uint32']),
      gdiStretchBlt: f(gdi32, 'StretchBlt', 'bool', [
        HANDLE, 'int32', 'int32', 'int32', 'int32', HANDLE, 'int32', 'int32', 'int32', 'int32', 'uint32',
      ]),
      gdiSetStretchBltMode: f(gdi32, 'SetStretchBltMode', 'int32', [HANDLE, 'int32']),
      gdiCreateDIBSection: f(gdi32, 'CreateDIBSection', HANDLE, [
        HANDLE,
        koffi.inout(koffi.pointer(BITMAPINFOHEADER)),
        'uint32',
        koffi.out(koffi.pointer('void *')),
        HANDLE,
        'uint32',
      ]),
      gdiUpdateLayeredWindow: f(user32, 'UpdateLayeredWindow', 'bool', [
        HANDLE, HANDLE, koffi.inout(koffi.pointer(POINT)), koffi.inout(koffi.pointer(SIZE)),
        HANDLE, koffi.inout(koffi.pointer(POINT)), 'uint32', koffi.inout(koffi.pointer(BLENDFUNCTION)), 'uint32',
      ]),
      gdiCreateSolidBrush: f(gdi32, 'CreateSolidBrush', HANDLE, ['uint32']),
      gdiDeleteBrush: f(gdi32, 'DeleteObject', 'bool', [HANDLE]),
      gdiFrameRect: f(user32, 'FrameRect', 'int32', [HANDLE, koffi.inout(koffi.pointer(RECT)), HANDLE]),
      gdiFillRect: f(user32, 'FillRect', 'int32', [HANDLE, koffi.inout(koffi.pointer(RECT)), HANDLE]),
      gdiPatBlt: f(gdi32, 'PatBlt', 'bool', [HANDLE, 'int32', 'int32', 'int32', 'int32', 'uint32']),
      gdiGetDeviceCaps: f(gdi32, 'GetDeviceCaps', 'int32', [HANDLE, 'int32']),
      // --- gdi text --------------------------------------------------------
      gdiCreateFontW: f(gdi32, 'CreateFontW', HANDLE, [
        'int32', 'int32', 'int32', 'int32', 'int32', 'uint32', 'uint32', 'uint32',
        'uint32', 'uint32', 'uint32', 'uint32', 'uint32', 'str16',
      ]),
      gdiSetBkMode: f(gdi32, 'SetBkMode', 'int32', [HANDLE, 'int32']),
      gdiSetTextColor: f(gdi32, 'SetTextColor', 'uint32', [HANDLE, 'uint32']),
      gdiGetTextExtentPoint32W: f(gdi32, 'GetTextExtentPoint32W', 'bool', [
        HANDLE, 'str16', 'int32', koffi.inout(koffi.pointer(SIZE)),
      ]),
      gdiDrawTextW: f(user32, 'DrawTextW', 'int32', [
        HANDLE, 'str16', 'int32', koffi.inout(koffi.pointer(RECT)), 'uint32',
      ]),
      gdiGetDIBits: f(gdi32, 'GetDIBits', 'int32', [
        HANDLE, HANDLE, 'uint32', 'uint32', 'void *', koffi.inout(koffi.pointer(BITMAPINFOHEADER)), 'uint32',
      ]),
      // --- kernel ----------------------------------------------------------
      kernelGetModuleHandleW: f(kernel32, 'GetModuleHandleW', HANDLE, ['str16']),
      kernelGlobalAlloc: f(kernel32, 'GlobalAlloc', HANDLE, ['uint32', 'uintptr_t']),
      kernelGlobalLock: f(kernel32, 'GlobalLock', 'void *', [HANDLE]),
      kernelGlobalUnlock: f(kernel32, 'GlobalUnlock', 'bool', [HANDLE]),
      kernelGlobalFree: f(kernel32, 'GlobalFree', HANDLE, [HANDLE]),
      kernelGetLastError: f(kernel32, 'GetLastError', 'uint32', []),
      kernelGetTickCount64: f(kernel32, 'GetTickCount64', 'int64', []),
      kernelGetCurrentThreadId: f(kernel32, 'GetCurrentThreadId', 'uint32', []),
      kernelCloseHandle: f(kernel32, 'CloseHandle', 'bool', [HANDLE]),
    },
  }
}

/** Reusable native bindings; loading a library twice would leak handles. */
let cached

/**
 * @returns the bound Win32 surface, loading it on first use.
 */
export function win32() {
  if (cached !== undefined) return cached
  const koffi = loadKoffi()
  if (koffi === undefined) throw new Error('dsh-screenshot: koffi (Win32 FFI) is not reachable from this process')
  cached = bindWin32(koffi)
  return cached
}

