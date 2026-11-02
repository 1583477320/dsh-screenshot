/**
 * Diagnostic log for a plugin that has no user interface.
 *
 * Everything interesting that happens here — which chord was granted, which
 * failed and with what Win32 error, whether a paint threw — is invisible from
 * the UI. Without a file to look at, "the hotkey stopped working" is
 * unanswerable from the outside, which is exactly the position this plugin was
 * in. The log is deliberately trivial: append, rotate, never throw.
 *
 * @module dsh-screenshot/diag
 */

import { appendFileSync, statSync, truncateSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/** Where the log lives; `%TEMP%\dsh-screenshot.log` on Windows. */
const LOG_PATH = join(tmpdir(), 'dsh-screenshot.log')

/** Rotate rather than grow forever in a long-lived host process. */
const LIMIT = 256 * 1024

/** @returns the absolute log path, for the README and for support. */
export function diagPath() {
  return LOG_PATH
}

/**
 * Append one line to the diagnostic log.
 * @param line - free-form message; a timestamp is prepended.
 */
export function record(line) {
  try {
    try {
      if (statSync(LOG_PATH).size > LIMIT) truncateSync(LOG_PATH, 0)
    } catch { /* first write, or the file vanished */ }
    appendFileSync(LOG_PATH, `${new Date().toISOString()} ${line}\n`, 'utf8')
  } catch {
    // A diagnostic that breaks the product would be worse than no diagnostic.
  }
}
