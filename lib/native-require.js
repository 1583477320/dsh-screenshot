import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

/**
 * Locate a module that ships inside the DSH installation. The desktop app keeps
 * native dependencies outside `app.asar` (`app.asar.unpacked`), so both roots are
 * searched before giving up.
 * @returns the Node require bound to the packaged node_modules.
 */
function* candidateRequires() {
  const self = fileURLToPath(import.meta.url)
  const marker = self.indexOf('.asar')
  if (marker >= 0) {
    const head = self.slice(0, marker + '.asar'.length)
    yield createRequire(`${head}.unpacked/dsh/node_modules/`)
    yield createRequire(`${head}/dsh/node_modules/`)
  }
  const resources = process.env.DSH_DESKTOP_RESOURCES
  if (resources) {
    yield createRequire(`${resources}/app.asar.unpacked/dsh/node_modules/`)
    yield createRequire(`${resources}/app.asar/dsh/node_modules/`)
  }
  yield createRequire(import.meta.url)
}

/**
 * Load koffi, the Win32 FFI binding bundled with the desktop app.
 * @returns the koffi namespace, or undefined when this process cannot reach it.
 */
export function loadKoffi() {
  for (const require of candidateRequires()) {
    try {
      return require('koffi')
    } catch {
      // Try the next root.
    }
  }
  return undefined
}
