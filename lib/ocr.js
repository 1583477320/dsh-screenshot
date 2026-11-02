import { spawn } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { encodePng } from './clipboard.js'

/** Where the WinRT bridge lives, next to this module. */
const SCRIPT = fileURLToPath(new URL('./scripts/ocr.ps1', import.meta.url))

/**
 * Screen text is small, and the engine starts confusing `l`/`I` and dropping
 * CJK strokes below roughly 20 px, so selections are upscaled first. The
 * decision keys off the region being desktop-sized rather than tiny: a big
 * region is just as likely to be full of 12 px UI text as a small one.
 * @returns an integer scale factor.
 */
export function pickScale(width, height) {
  const limit = 9000
  let scale = 1
  if (width <= 1800 && height <= 1000) scale = 2
  if (width <= 700 || height <= 260) scale = 3
  while (scale > 1 && (width * scale > limit || height * scale > limit)) scale -= 1
  return scale
}

/**
 * Windows OCR inserts a space between every CJK glyph, which is not how the text
 * reads. Collapse those, then tidy the line structure without touching spaces
 * between Latin words.
 * @param value - the raw transcription.
 * @returns the text as the user would copy it.
 */
export function normalizeText(value) {
  let text = String(value ?? '').replace(/\r\n?/g, '\n')
  const cjk = '\\u2e80-\\u9fff\\uf900-\\ufaff\\uff00-\\uffef'
  const adjacent = new RegExp(`([${cjk}])[ \\t]+(?=[${cjk}])`, 'g')
  // One pass joins neighbouring pairs; repeating settles a run of glyphs.
  for (let pass = 0; pass < 4; pass += 1) text = text.replace(adjacent, '$1')
  const lines = text
    .split('\n')
    .map((line) => line.replace(/[ \t]+/g, ' ').trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
  return lines
}

/**
 * Run the PowerShell bridge to completion.
 * @returns the parsed JSON payload the script wrote.
 */
function runBridge(args, timeoutMs) {
  return new Promise((resolve, reject) => {
    // `windowsHide` keeps a console window from flashing up over the desktop.
    const child = spawn('powershell.exe', args, { windowsHide: true, stdio: 'ignore' })
    let settled = false
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      child.kill()
      reject(new Error('ocr-timeout'))
    }, timeoutMs)
    child.once('error', (error) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      reject(error)
    })
    child.once('exit', (code) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (code === 0) resolve(undefined)
      else reject(new Error(`ocr-exit-${code}`))
    })
  })
}

/**
 * Extract the text in a bitmap using the OCR engine that ships with Windows.
 *
 * @param bitmap - the cropped selection.
 * @param options - `timeoutMs` bounds the child process.
 * @returns `{ ok, text, lines, language, scale }`, where `ok` is false when the
 *   engine is unavailable rather than when it simply found nothing.
 */
export async function recognizeText(bitmap, options = {}) {
  const timeoutMs = options.timeoutMs ?? 25000
  const scale = options.scale ?? pickScale(bitmap.width, bitmap.height)
  const directory = await mkdtemp(join(tmpdir(), 'dsh-ocr-'))
  const imagePath = join(directory, 'selection.png')
  const outputPath = join(directory, 'result.json')
  try {
    await writeFile(imagePath, encodePng(bitmap))
    await runBridge(
      [
        '-NoProfile',
        '-NonInteractive',
        '-ExecutionPolicy', 'Bypass',
        '-File', SCRIPT,
        '-ImagePath', imagePath,
        '-OutputPath', outputPath,
        '-Scale', String(scale),
      ],
      timeoutMs,
    )
    // Windows tooling often writes UTF-8 with a BOM, which `JSON.parse` rejects.
    const payload = JSON.parse((await readFile(outputPath, 'utf8')).replace(/^\uFEFF/, ''))
    if (payload.ok !== true) {
      return { ok: false, error: payload.error ?? 'ocr-failed', text: '', lines: [], language: undefined, scale }
    }
    const lines = Array.isArray(payload.lines) ? payload.lines.map((line) => normalizeText(line)) : []
    return {
      ok: true,
      text: normalizeText(payload.text ?? lines.join('\n')),
      lines: lines.filter((line) => line.length > 0),
      language: payload.language,
      scale,
    }
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}
