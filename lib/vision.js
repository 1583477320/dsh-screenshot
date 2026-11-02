import { encodePng } from './clipboard.js'
import { attachmentsOf, llmOf } from './services.js'

/**
 * Text extraction through a vision model instead of the local OCR engine.
 *
 * The model route is resolved from the host's own LLM service, so credentials
 * never leave DSH: the image is admitted as a durable attachment and referenced
 * from the request just like an image the user pasted into a chat.
 */

/** Asked of every model; kept narrow so the answer stays copy-pasteable. */
const PROMPT = [
  '请提取这张截图里的全部文字。',
  '要求：',
  '1. 按原有阅读顺序和换行输出，保留段落结构。',
  '2. 只输出文字本身，不要任何解释、标题、引号或 Markdown 代码块。',
  '3. 无法辨认的字用 □ 代替，不要猜测。',
  '4. 如果图片里没有文字，只输出 NO_TEXT。',
].join('\n')

/** Strips the wrappers models add even when told not to. */
export function cleanModelText(value) {
  let text = String(value ?? '').replace(/\r\n?/g, '\n').trim()
  const fenced = text.match(/^```[a-zA-Z]*\n([\s\S]*?)\n```$/)
  if (fenced) text = fenced[1].trim()
  text = text.replace(/^```[a-zA-Z]*\n?/, '').replace(/\n?```$/, '').trim()
  if (/^NO_TEXT[.。]?$/i.test(text)) return ''
  return text
}

/**
 * A text-only model answers with an apology instead of a transcription. Real
 * transcriptions of such wording do happen, but they are long, so only a short
 * answer is treated as a refusal.
 */
const REFUSAL = /(无法|不能|看不到|没有看到|抱歉|无法查看)|cannot (?:see|read|view)|unable to (?:see|read|view)|as an ai/i

/** @returns whether a model answer is really a "I cannot see the image" reply. */
export function looksLikeRefusal(value) {
  const text = String(value ?? '')
  return text.length < 80 && REFUSAL.test(text)
}

/**
 * Split a model preference.
 *
 * Both spellings are accepted: `provider/model` when the user knows the exact
 * route, or a bare `model` that is looked up across providers — remembering the
 * route key is not something a settings page should demand.
 * @returns `{ provider?, model }` or `undefined` when empty.
 */
function parsePreference(value) {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  if (trimmed.length === 0) return undefined
  const slash = trimmed.indexOf('/')
  if (slash < 0) return { model: trimmed }
  if (slash === 0 || slash === trimmed.length - 1) return undefined
  return { provider: trimmed.slice(0, slash), model: trimmed.slice(slash + 1) }
}

/**
 * Every route this deployment offers.
 * @returns `[{ route, provider, model, image }]`.
 */
export async function routeCatalogue(llm) {
  const routes = []
  if (!llm || typeof llm.listProviders !== 'function') return routes
  for (const provider of llm.listProviders()) {
    let models = []
    try {
      models = await llm.listModels(provider.id)
    } catch {
      continue
    }
    for (const model of models) {
      routes.push({
        route: `${provider.id}/${model.id}`,
        provider: provider.id,
        model: model.id,
        image: Array.isArray(model.inputModalities) && model.inputModalities.includes('image'),
      })
    }
  }
  return routes
}

/**
 * The catalogue as human-readable lines.
 *
 * Shown in the panel when recognition fails on both engines: at that point the
 * only useful information is which routes exist and which of them can see.
 * @returns `['flashcoding/deepseek-v4.1-flash (text)', …]`.
 */
export async function describeCatalogue(llm) {
  const routes = await routeCatalogue(llm)
  if (routes.length === 0) return llm ? '没有可用的模型' : 'LLM 服务不可用'
  return routes.map((entry) => `${entry.route}（${entry.image ? '可读图' : '未知/纯文本'}）`).join('\n')
}

/**
 * List every route this deployment offers, with the modalities it advertises.
 * Used for the startup log, because "the model cannot see images" is the single
 * most likely reason extraction fails.
 * @returns a printable summary.
 */
export async function describeRoutes(llm) {
  if (!llm || typeof llm.listProviders !== 'function') return 'llm service unavailable'
  const routes = await routeCatalogue(llm)
  const lines = []
  for (const provider of llm.listProviders()) {
    const owned = routes.filter((entry) => entry.provider === provider.id)
    const described = owned.map((entry) => `${entry.model} [${entry.image ? 'image' : 'unknown'}]`)
    lines.push(`${provider.id}: ${described.join(', ') || '<no models>'}`)
  }
  return lines.join(' | ')
}

/**
 * Pick the route to send the screenshot to.
 *
 * A configured route always wins, whether given in full or as a bare model id.
 * Otherwise the first route that advertises image input is used, since a
 * text-only model would receive a placeholder instead of the picture.
 * @returns `{ provider, model }` or an error string.
 */
export async function resolveRoute(llm, preference) {
  if (!llm || typeof llm.stream !== 'function') return { error: 'no-llm-service' }
  const wanted = parsePreference(preference)
  if (wanted?.provider !== undefined) return { provider: wanted.provider, model: wanted.model }
  if (wanted !== undefined) {
    // A bare model id: find the provider that serves it, preferring one that
    // also advertises vision.
    const routes = await routeCatalogue(llm)
    const matches = routes.filter((entry) => entry.model === wanted.model)
    const best = matches.find((entry) => entry.image) ?? matches[0]
    if (best === undefined) return { error: `unknown-model: ${wanted.model}` }
    return { provider: best.provider, model: best.model }
  }
  const routes = await routeCatalogue(llm)
  const vision = routes.find((entry) => entry.image)
  if (vision !== undefined) return { provider: vision.provider, model: vision.model }
  // Nothing advertises vision. Sending anyway is still worth one attempt: the
  // catalogue often omits modalities, so the first route may well be multimodal.
  if (routes.length > 0) return { provider: routes[0].provider, model: routes[0].model, guessed: true }
  return { error: 'no-model' }
}

/**
 * Extract text from a bitmap with a vision model.
 *
 * @param ctx - the plugin context, providing `attachments` and `llm`.
 * @param bitmap - the cropped selection.
 * @param options - `model` as `provider/model`, and a `signal` for cancellation.
 * @returns `{ ok, text, route, error }`.
 */
export async function recognizeWithModel(ctx, bitmap, options = {}) {
  const llm = llmOf(ctx)
  const attachments = attachmentsOf(ctx)
  if (!llm || typeof llm.stream !== 'function') return { ok: false, error: 'no-llm-service' }
  if (!attachments || typeof attachments.saveImages !== 'function') return { ok: false, error: 'no-attachment-service' }

  const route = await resolveRoute(llm, options.model)
  if (route.error !== undefined) return { ok: false, error: route.error }

  let text = ''
  let failure
  try {
    const png = encodePng(bitmap)
    const [reference] = await attachments.saveImages([{
      data: new Uint8Array(png),
      mediaType: 'image/png',
      name: 'selection.png',
    }])
    if (reference === undefined) return { ok: false, error: 'attachment-refused' }
    // Content parts mirror what the chat UI produces for a pasted image, so the
    // adapter projects it into a provider-specific image part by itself.
    const messages = [{
      role: 'user',
      content: [
        { type: 'image', attachment: reference },
        { type: 'text', text: PROMPT },
      ],
    }]
    for await (const chunk of llm.stream({
      provider: route.provider,
      model: route.model,
      messages,
      ...options.signal === undefined ? {} : { signal: options.signal },
    })) {
      if (chunk.type === 'text-delta') text += chunk.text
      else if (chunk.type === 'finish' && chunk.kind === 'error') failure = chunk.failure
    }
  } catch (error) {
    return { ok: false, error: error?.message ?? String(error), route }
  }
  if (failure !== undefined) {
    return { ok: false, error: failure?.message ?? failure?.code ?? 'llm-failed', route }
  }
  const cleaned = cleanModelText(text)
  // A route that cannot take images silently receives a placeholder and answers
  // with an apology; treat that as a failed recognition so the caller can fall
  // back instead of showing the apology as if it were the screenshot's text.
  if (looksLikeRefusal(cleaned)) {
    return { ok: false, error: 'model-could-not-read', route: `${route.provider}/${route.model}` }
  }
  return {
    ok: true,
    text: cleaned,
    route: `${route.provider}/${route.model}`,
  }
}
