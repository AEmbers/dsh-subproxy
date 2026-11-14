/**
 * Translate a pi-ai conversation into the Antigravity request envelope.
 *
 * Four things here are not obvious and each of them cost a debugging session
 * upstream, so they are spelled out:
 *
 * 1. **Tool ids are renumbered.** The upstream (and, through it, Anthropic's
 *    `input_schema`) demands `^[a-zA-Z0-9_-]{1,64}$` on both `functionCall.id`
 *    and `functionResponse.id`, and the two must agree. Harness ids can carry
 *    `|`, `:` and dots, so every id goes through a renumberer that hands the same
 *    original the same wire id within one request. A tool result without a call
 *    it can pair with is dropped rather than sent (the upstream 400s on an
 *    orphan `functionResponse`).
 * 2. **Tool names are flattened.** `ns.tool` / `tool/name` fail with
 *    "String should match pattern"; see `publicToolName` in the protocol module.
 * 3. **Tool schemas are sanitised.** Cloud Code Assist validates against both
 *    the proto (for Gemini models) and Anthropic `input_schema` (for Claude
 *    models); `anyOf`, tuple `items` and `required: true` all have to go.
 * 4. **Reasoning blocks are dropped.** The upstream will not accept a
 *    `thinking` part back, only the `thoughtSignature` that rode alongside it,
 *    which is why the signature is carried on the tool call instead.
 *
 * @module dsh-subproxy/antigravity/request
 */
import {
  DEFAULT_PROJECT,
  MAX_OUTPUT_TOKENS,
  MAX_REQUEST_BODY_BYTES,
  SESSION_LANE_INFER,
  deriveSessionId,
  marshalAlphabetical,
  publicToolName,
  restoreToolName,
  sanitizeParameters,
  toolResultText,
} from './protocol.js'

/** A wire-legal tool id. */
const WIRE_ID_RE = /^[a-zA-Z0-9_-]{1,64}$/

/**
 * Strip `undefined` members so the body survives the proto encoder.
 *
 * @param {unknown} value - anything JSON-shaped.
 * @returns {unknown} the same shape without `undefined`.
 */
function stripUndefined(value) {
  if (Array.isArray(value)) return value.map(stripUndefined)
  if (value === null || typeof value !== 'object') return value
  const out = {}
  for (const [key, child] of Object.entries(value)) {
    if (child !== undefined) out[key] = stripUndefined(child)
  }
  return out
}

/**
 * The upstream's tool-choice vocabulary.
 *
 * @param {unknown} choice - the harness tool choice.
 * @returns {'NONE' | 'ANY' | 'AUTO'} the wire mode.
 */
function toolChoiceMode(choice) {
  if (typeof choice === 'string') {
    if (choice === 'none') return 'NONE'
    if (choice === 'any' || choice === 'required') return 'ANY'
    return 'AUTO'
  }
  if (typeof choice === 'object' && choice !== null) {
    if (choice.type === 'none') return 'NONE'
    if (choice.type === 'tool' || choice.type === 'any' || choice.type === 'required') return 'ANY'
  }
  return 'AUTO'
}

/**
 * The single tool the harness pinned, if any.
 *
 * @param {unknown} choice - the harness tool choice.
 * @returns {string | undefined} the tool name.
 */
function toolChoiceName(choice) {
  if (typeof choice !== 'object' || choice === null) return undefined
  const name = choice.name ?? choice.toolName
  return typeof name === 'string' && name !== '' ? publicToolName(name) : undefined
}

/**
 * Build `toolConfig` when the harness asked for something other than auto.
 *
 * @param {unknown} choice - the harness tool choice.
 * @param {unknown[] | undefined} tools - the declared tools.
 * @returns {object | undefined} the config.
 */
function buildToolConfig(choice, tools) {
  if (choice === undefined || choice === null) return undefined
  if (tools === undefined || tools.length === 0) return undefined
  const mode = toolChoiceMode(choice)
  if (mode === 'AUTO' && toolChoiceName(choice) === undefined) return undefined
  const config = { functionCallingConfig: { mode } }
  const name = toolChoiceName(choice)
  if (name !== undefined) config.functionCallingConfig.allowedFunctionNames = [name]
  return config
}

/**
 * Build `generationConfig`.
 *
 * `thinkingBudget: -1` is the "let the model decide" sentinel and means the field
 * must be omitted rather than sent negative.
 *
 * @param {object} spec - the resolved model spec.
 * @param {number | undefined} maxTokens - the caller's cap.
 * @param {number | undefined} temperature - the caller's temperature.
 * @returns {object} the config.
 */
function buildGenerationConfig(spec, maxTokens, temperature) {
  const config = { maxOutputTokens: maxTokens ?? MAX_OUTPUT_TOKENS }
  const thinking = { includeThoughts: spec.includeThoughts === true }
  if (typeof spec.thinkingBudget === 'number' && spec.thinkingBudget >= 0) thinking.thinkingBudget = spec.thinkingBudget
  config.thinkingConfig = thinking
  if (typeof temperature === 'number' && Number.isFinite(temperature)) config.temperature = temperature
  return config
}

/**
 * Assign wire ids to tool calls and pair their results.
 *
 * @returns {{ take: (raw: unknown) => string, adopt: (raw: unknown) => string }} the renumberer.
 */
function wireIdFactory() {
  let sequence = 0
  const queue = []
  const seen = new Set()
  const adopt = (raw) => {
    const text = typeof raw === 'string' ? raw : ''
    if (WIRE_ID_RE.test(text) && !seen.has(text)) {
      seen.add(text)
      queue.push(text)
      return text
    }
    let candidate = `call_gemini_${sequence++}`
    while (seen.has(candidate)) candidate = `call_gemini_${sequence++}`
    seen.add(candidate)
    queue.push(candidate)
    return candidate
  }
  const take = (raw) => {
    const text = typeof raw === 'string' ? raw : ''
    if (WIRE_ID_RE.test(text) && !seen.has(text) && queue.length === 0) {
      seen.add(text)
      return text
    }
    const queued = queue.shift()
    if (queued !== undefined) {
      seen.add(queued)
      return queued
    }
    const candidate = adopt(text)
    queue.pop()
    return candidate
  }
  return { take, adopt }
}

/**
 * Normalise one pi-ai message into `{ role, parts }`.
 *
 * @param {object} message - a pi-ai message.
 * @param {object} state - the translation state.
 * @returns {{ role: string, parts: object[] } | undefined} the content entry.
 */
function convertMessage(message, state) {
  if (typeof message !== 'object' || message === null) return undefined
  const role = message.role
  if (role === 'user') {
    const parts = []
    const content = message.content
    const blocks = typeof content === 'string' ? [{ type: 'text', text: content }] : Array.isArray(content) ? content : []
    for (const block of blocks) {
      if (block === null || typeof block !== 'object') continue
      if (block.type === 'text') {
        const text = typeof block.text === 'string' ? block.text : ''
        if (text !== '') parts.push({ text })
        continue
      }
      if (block.type === 'image') {
        const data = typeof block.data === 'string' ? block.data : ''
        const mimeType = typeof block.mimeType === 'string' ? block.mimeType : ''
        if (data === '' || mimeType === '') {
          state.missingImage = true
          continue
        }
        parts.push({ inlineData: { mimeType, data } })
      }
    }
    return parts.length === 0 ? undefined : { role: 'user', parts }
  }

  if (role === 'assistant') {
    const parts = []
    const blocks = Array.isArray(message.content) ? message.content : []
    for (const block of blocks) {
      if (block === null || typeof block !== 'object') continue
      // `thinking` is never accepted back; its signature rides on the tool call.
      if (block.type === 'thinking') continue
      if (block.type === 'text') {
        const text = typeof block.text === 'string' ? block.text : ''
        if (text !== '') parts.push({ text })
        continue
      }
      if (block.type === 'toolCall') {
        const name = publicToolName(block.name)
        const rawArgs = block.arguments
        const args =
          typeof rawArgs === 'object' && rawArgs !== null && !Array.isArray(rawArgs) ? stripUndefined(rawArgs) : {}
        const id = state.wireIds.adopt(block.id)
        const part = { functionCall: { name, args, id } }
        if (!state.dropSignatures && typeof block.thoughtSignature === 'string' && block.thoughtSignature !== '') {
          part.thoughtSignature = block.thoughtSignature
        }
        parts.push(part)
      }
    }
    return parts.length === 0 ? undefined : { role: 'model', parts }
  }

  if (role === 'toolResult') {
    const name = publicToolName(restoreToolName(message.toolName))
    const text = toolResultText(Array.isArray(message.content) ? message.content : [])
    const id = state.wireIds.take(message.toolCallId)
    const response = { content: text }
    if (message.isError === true) response.error = text
    state.toolCallNames.set(id, name)
    return { role: 'user', parts: [{ functionResponse: { name, response, id } }] }
  }

  return undefined
}

/**
 * Translate the conversation.
 *
 * @param {object} options - inputs.
 * @param {object} options.spec - the resolved model spec (`upstream`, thinking).
 * @param {object[]} options.messages - pi-ai messages.
 * @param {string} [options.systemPrompt] - the system prompt.
 * @param {object[]} [options.tools] - pi-ai tools.
 * @param {unknown} [options.toolChoice] - the harness tool choice.
 * @param {number} [options.temperature] - sampling temperature.
 * @param {number} [options.maxTokens] - output cap.
 * @param {string} [options.sessionId] - a session id to reuse.
 * @param {string} [options.project] - the project number.
 * @param {string} options.requestId - the request id.
 * @param {string} [options.sessionLane] - the session lane.
 * @param {number} [options.sessionGeneration] - the session generation.
 * @param {boolean} [options.dropSignatures] - omit every `thoughtSignature`.
 * @returns {{ model: string, project: string, request: object, requestId: string, userAgent: string }} the envelope.
 */
export function translateRequest(options) {
  const state = {
    wireIds: wireIdFactory(),
    toolCallNames: new Map(),
    missingImage: false,
    dropSignatures: options.dropSignatures === true,
  }
  const contents = []
  for (const message of options.messages ?? []) {
    const converted = convertMessage(message, state)
    if (converted !== undefined) contents.push(converted)
  }
  if (state.missingImage) {
    throw new Error('Antigravity：图片未能内联（附件读取失败），拒绝发出缺少图片的请求')
  }
  if (contents.length === 0) throw new Error('Antigravity：messages 里没有可用内容')

  const firstUserText = contents.find((entry) => entry.role === 'user')?.parts?.find((part) => part.text)?.text ?? ''
  const project = options.project ?? DEFAULT_PROJECT
  const sessionId =
    options.sessionId ??
    deriveSessionId(
      project,
      firstUserText,
      options.sessionLane ?? SESSION_LANE_INFER,
      options.sessionGeneration ?? 0,
    )

  const request = {
    contents,
    generationConfig: buildGenerationConfig(options.spec, options.maxTokens, options.temperature),
    sessionId,
  }
  const systemPrompt = typeof options.systemPrompt === 'string' ? options.systemPrompt : ''
  if (systemPrompt !== '') request.systemInstruction = { role: 'system', parts: [{ text: systemPrompt }] }
  if (Array.isArray(options.tools) && options.tools.length > 0) {
    request.tools = [
      {
        functionDeclarations: options.tools.map((tool) => ({
          name: publicToolName(tool.name),
          description: typeof tool.description === 'string' ? tool.description : '',
          parameters: sanitizeParameters(tool.parameters),
        })),
      },
    ]
  }
  const toolConfig = buildToolConfig(options.toolChoice, options.tools)
  if (toolConfig !== undefined) request.toolConfig = toolConfig

  const wire = marshalAlphabetical({
    model: options.spec.upstream,
    project,
    request,
    requestId: options.requestId,
    userAgent: 'antigravity',
  })
  const bytes = Buffer.byteLength(wire, 'utf8')
  if (bytes > MAX_REQUEST_BODY_BYTES) {
    throw new Error(`Antigravity：请求体 ${bytes} 字节超过上限 ${MAX_REQUEST_BODY_BYTES} 字节`)
  }

  return {
    model: options.spec.upstream,
    project,
    request,
    requestId: options.requestId,
    userAgent: 'antigravity',
    wire,
    toolCallNames: state.toolCallNames,
  }
}
