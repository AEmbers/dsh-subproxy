/**
 * The Antigravity stream: one pi-ai provider implementation over `cloudcode-pa`.
 *
 * pi-ai's own adapters all wrap an SDK; this one speaks the wire protocol
 * directly (`streamGenerateContent?alt=sse`) because Cloud Code Assist has no
 * SDK. The shape below follows pi-ai's conventions rather than the pack's:
 *
 * - the event stream is `AssistantMessageEventStream`, and every event carries
 *   the live `partial` message, exactly like `anthropic-messages` does;
 * - tool calls arrive whole on the wire, so they are emitted as
 *   `toolcall_start` → one `toolcall_delta` with the full argument JSON →
 *   `toolcall_end` (pi-ai does not require deltas to be small);
 * - `thoughtSignature` rides on the `ToolCall`, which is how it survives into
 *   the next request's `functionCall` part.
 *
 * The retry ladder is the pack's, minus account rotation: signature rejection →
 * drop signatures; session overflow → bump the session generation; 403/404 →
 * switch endpoint; 429 → other endpoint, then fail; 401 → refresh once.
 *
 * @module dsh-subproxy/antigravity/stream
 */
import { createAssistantMessageEventStream, calculateCost } from '@earendil-works/pi-ai'

import {
  DEFAULT_EFFORT,
  ENDPOINTS,
  SESSION_LANE_INFER,
  STREAM_PATH,
  canonicalArgs,
  filterHoldLength,
  filterNoticeIn,
  headersFor,
  isContextOverflow,
  isQuotaText,
  isRefreshable,
  isSessionOverflow,
  isSignatureError,
  isSwitchableText,
  mapFinish,
  newRequestId,
  readUsage,
  restoreToolName,
} from './protocol.js'
import { resolveUpstreamId } from './catalog.js'
import { describeQuota, probeQuota, quotaRemains } from './quota.js'
import { translateRequest } from './request.js'
import { noteRewrites } from './sanitize.js'
import { credentialIdentity, resolveProject } from './project.js'

/** How many session-id bumps are tolerated before giving up. */
const MAX_SESSION_BUMPS = 2

/**
 * How many times an empty turn is resent before it is reported as a failure.
 *
 * The upstream sometimes finishes with `stopReason: STOP` and nothing but
 * thought parts, and the same request then answers normally on a second try —
 * measured at roughly one silence in five. One resend is enough to turn most of
 * those into answers, and keeping it at one means a genuinely empty model still
 * fails in bounded time.
 */
const MAX_EMPTY_RETRIES = 1

/**
 * The message for a turn that produced no usable output.
 *
 * @param {string} finishReason - the upstream's finish reason, if any.
 * @returns {string} the message.
 */
function thoughtOnlyMessage(finishReason) {
  const tail =
    typeof finishReason === 'string' && finishReason.toUpperCase() === 'MAX_TOKENS'
      ? '，且思考已把输出预算用尽（finishReason=MAX_TOKENS）'
      : '（上游 finishReason=STOP，parts 里只有一个空的 text）'
  return `Antigravity：模型只返回了思考，没有正文${tail}。这次请求没有产生任何可显示的内容，重试或换个档位再问。`
}

/**
 * The message for a request the upstream's own filter ate.
 *
 * @param {string} notice - the upstream's verbatim wording.
 * @returns {string} the message.
 */
function filteredMessage(notice) {
  const said = notice.length > 400 ? `${notice.slice(0, 400)}…` : notice
  return `Antigravity：上游内容审核吃掉了这次请求，回的不是答案 —— ${said}`
}

/**
 * The message for a 429 the account's own budget does not explain.
 *
 * The upstream answers a refused *prompt* with the same 429 and the same
 * `RESOURCE_EXHAUSTED` body it uses for a spent account, so the body proves
 * nothing. What settles it is the quota endpoint: an account with most of its
 * budget left did not run out — its request was refused, and saying "wait for
 * the bucket" would send someone to wait for a bucket that was never empty.
 *
 * @param {number} status - the HTTP status.
 * @param {string} text - the body.
 * @param {object[]} buckets - what the quota endpoint reported, if anything.
 * @param {string} [probeError] - why the quota probe failed.
 * @returns {string} the message.
 */
function rejectionMessage(status, text, buckets, probeError) {
  const spent = describeQuota(buckets)
  const budget =
    spent === ''
      ? `额度读数失败${probeError === undefined ? '' : `（${probeError}）`}`
      : `账号还有额度（${spent}）`
  const said = text.length > 200 ? `${text.slice(0, 200)}…` : text
  return `Antigravity：上游拒绝了这次请求的内容，不是额度问题（HTTP ${status}）— ${budget}，但上游回的是额度不足的样子${said === '' ? '' : ` —— ${said}`}。改写提示词后再试。`
}

/**
 * The pi-ai thinking level → Antigravity tier mapping.
 *
 * `max` lands on `tiered` — the upstream's "let the model decide" budget —
 * because it is the level that asks for the most thinking of all. `xhigh` is a
 * real upstream tier (`gemini-4-hydrogen-xhigh`), so it maps to itself and
 * degrades to `tiered` on the models that do not serve it.
 */
const LEVEL_TO_TIER = {
  off: 'off',
  minimal: 'low',
  low: 'low',
  medium: 'medium',
  high: 'high',
  xhigh: 'xhigh',
  max: 'tiered',
}

/**
 * The thinking budget for a tier.
 *
 * @param {string} tier - the tier.
 * @returns {number | undefined} the budget, or undefined to omit the field.
 */
export function budgetForTier(tier) {
  if (tier === 'low') return 1_000
  if (tier === 'high') return 10_000
  if (tier === 'xhigh') return 24_000
  if (tier === 'tiered') return undefined
  return 4_000
}

/**
 * Build the `thinkingLevelMap` for a catalog entry.
 *
 * Every level that the upstream does not serve must be mapped to `null`
 * explicitly: pi-ai treats a *missing* key as "supported", so omission is not how
 * a level is hidden.
 *
 * @param {string[] | undefined} effortOptions - the tiers the entry serves.
 * @returns {Record<string, string | null>} the map.
 */
export function thinkingLevelMap(effortOptions) {
  const declared = new Set(effortOptions ?? [])
  const map = {}
  for (const [level, tier] of Object.entries(LEVEL_TO_TIER)) {
    if (tier === 'off') {
      map[level] = 'off'
      continue
    }
    map[level] = declared.has(tier) ? tier : null
  }
  return map
}

/**
 * Resolve the tier a request should use.
 *
 * @param {string | undefined} reasoning - pi-ai's requested level.
 * @param {string[] | undefined} effortOptions - what the entry serves.
 * @returns {{ tier: string, includeThoughts: boolean }} the plan.
 */
function planThinking(reasoning, effortOptions) {
  const declared = effortOptions ?? []
  const requested = typeof reasoning === 'string' ? LEVEL_TO_TIER[reasoning] : undefined
  if (requested === 'off') return { tier: DEFAULT_EFFORT, includeThoughts: false }
  if (requested !== undefined && declared.includes(requested)) return { tier: requested, includeThoughts: true }
  const fallback = declared.includes(DEFAULT_EFFORT) ? DEFAULT_EFFORT : (declared[0] ?? DEFAULT_EFFORT)
  return { tier: fallback, includeThoughts: true }
}

/**
 * Read one SSE frame's `data:` payload.
 *
 * @param {string} line - one raw line.
 * @returns {string | undefined} the payload, or undefined when the line is not data.
 */
function dataPayload(line) {
  const trimmed = line.endsWith('\r') ? line.slice(0, -1) : line
  if (trimmed === '' || trimmed.startsWith(':') || trimmed.startsWith('event:')) return undefined
  if (!trimmed.startsWith('data:')) return undefined
  const payload = trimmed.slice(5).trim()
  return payload === '' ? undefined : payload
}

/**
 * An empty assistant message to grow.
 *
 * @param {object} model - the pi-ai model.
 * @param {string} [responseId] - the upstream request id.
 * @returns {object} the message.
 */
function emptyMessage(model, responseId) {
  const usage = {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  }
  const message = {
    role: 'assistant',
    content: [],
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage,
    stopReason: 'pending',
    timestamp: Date.now(),
  }
  if (responseId !== undefined) message.responseId = responseId
  return message
}

/**
 * Replace a message's usage with a freshly costed one.
 *
 * @param {object} model - the pi-ai model.
 * @param {object} message - the live message.
 * @param {object} counts - `readUsage` output.
 * @returns {void}
 */
function applyUsage(model, message, counts) {
  const input = counts.inputTokens ?? 0
  const output = counts.outputTokens ?? 0
  const cacheRead = counts.cacheReadTokens ?? 0
  const usage = {
    input,
    output,
    cacheRead,
    cacheWrite: 0,
    totalTokens: counts.totalTokens ?? input + output + cacheRead,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  }
  if (counts.reasoningTokens !== undefined) usage.reasoning = counts.reasoningTokens
  let cost
  try {
    cost = calculateCost(model, usage)
  } catch {
    cost = usage.cost
  }
  message.usage = { ...usage, cost }
}

/**
 * The stream.
 *
 * @param {object} model - the pi-ai model.
 * @param {{ systemPrompt?: string, messages: object[], tools?: object[] }} context - the pi-ai context.
 * @param {object} options - pi-ai stream options.
 * @param {object} deps - provider dependencies.
 * @param {() => Promise<object | undefined>} deps.readCredential - read the stored grant.
 * @param {() => Promise<void>} deps.refreshCredential - force a refresh.
 * @param {Map<string, { project: string, at: number }>} deps.projectCache - probed projects.
 * @param {{ warn: (message: string) => void }} [deps.logger] - diagnostics.
 * @param {() => object[] | undefined} [deps.catalog] - the catalog entries.
 * @returns {object} the AssistantMessageEventStream.
 */
export function streamAntigravity(model, context, options, deps) {
  const outer = createAssistantMessageEventStream()

  const run = async () => {
    const fetchImpl = options?.fetch ?? fetch
    const signal = options?.signal ?? AbortSignal.timeout(10 * 60_000)
    const requestId = newRequestId()

    let credential = await deps.readCredential()
    if (credential === undefined || typeof credential.access_token !== 'string' || credential.access_token === '') {
      if (typeof options?.apiKey === 'string' && options.apiKey !== '') credential = { access_token: options.apiKey }
    }
    if (credential === undefined) throw new Error('Antigravity：没有可用凭据，请先登录')

    const entries = deps.catalog?.()
    const entry = entries?.find((candidate) => candidate.id === model.id)
    const plan = planThinking(options?.reasoning, entry?.effortOptions)
    const spec = {
      upstream: resolveUpstreamId(model.id, plan.tier, entries),
      includeThoughts: plan.includeThoughts,
      thinkingBudget: budgetForTier(plan.tier),
    }

    let endpointIndex = 0
    let endpointSwitched = false
    let droppedSignatures = false
    let refreshed = false
    let sessionBumps = 0
    let sessionGeneration = 0
    let emptyRetries = 0
    let lastFailure

    // The message outlives individual attempts: an empty turn is resent into the
    // same message, so a retry appends rather than rewrites and every
    // contentIndex the caller has already seen keeps pointing at its block.
    const message = emptyMessage(model, requestId)
    const state = { started: false }

    for (;;) {
      const project = await resolveProject({
        credential,
        cache: deps.projectCache,
        fetchImpl,
        signal,
      })
      if (project.project === '') {
        throw new Error(`Antigravity：项目号探测失败，未发推理 — ${project.error ?? '未知错误'}`)
      }

      const envelope = translateRequest({
        spec,
        messages: context.messages ?? [],
        systemPrompt: context.systemPrompt,
        tools: context.tools,
        toolChoice: options?.toolChoice,
        temperature: options?.temperature,
        maxTokens: options?.maxTokens,
        project: project.project,
        requestId,
        sessionLane: SESSION_LANE_INFER,
        sessionGeneration,
        dropSignatures: droppedSignatures,
      })

      // Say once, out loud, that a host prompt sentence was rewritten: the
      // request the upstream sees is not byte-for-byte the one the host built,
      // and that difference has to be findable later.
      noteRewrites(envelope.systemRewrites, deps.logger)

      let response
      try {
        response = await fetchImpl(`${ENDPOINTS[endpointIndex] ?? ENDPOINTS[0]}${STREAM_PATH}`, {
          method: 'POST',
          headers: headersFor(credential),
          body: envelope.wire,
          signal,
        })
      } catch (error) {
        if (signal.aborted) throw error
        throw new Error(`Antigravity：请求发送失败 — ${error instanceof Error ? error.message : String(error)}`)
      }

      if (response.ok && response.body !== null) {
        const outcome = await consume(outer, response.body, model, message, state, signal)

        // A filter notice is a 200 with prose, so it can only be caught by
        // reading it. Reporting it as an answer is how a blocked prompt becomes
        // a mystery; say what happened instead.
        if (outcome.notice !== undefined) {
          throw new Error(filteredMessage(outcome.noticeText === '' ? outcome.notice : outcome.noticeText))
        }

        // A turn that reasoned but produced nothing is the upstream dropping the
        // request, not an answer: the same call answers on a second try. Resend
        // once, then report it rather than ending a turn with an empty message.
        if (!outcome.sawUsable && emptyRetries < MAX_EMPTY_RETRIES) {
          emptyRetries += 1
          continue
        }
        if (!outcome.sawContent) throw new Error('Antigravity：模型未返回任何内容块')
        if (!outcome.sawUsable) throw new Error(thoughtOnlyMessage(outcome.finishReason))

        const finish = mapFinish(outcome.finishReason, outcome.toolCount)
        applyUsage(model, message, outcome.usage)
        message.stopReason = finish.kind === 'tool-calls' ? 'toolUse' : finish.kind === 'max-tokens' ? 'length' : 'stop'
        message.timestamp = message.timestamp ?? Date.now()

        outer.push({ type: 'usage', usage: message.usage, partial: message })
        outer.push({ type: 'done', reason: message.stopReason, message })
        outer.end(message)
        return
      }
      if (response.ok) throw new Error('Antigravity：响应缺少 body')

      const text = await response.text().catch(() => '')
      lastFailure = { status: response.status, text }
      const status = response.status

      // 1. A rejected thought signature: retry once with every signature dropped.
      if (isSignatureError(text) && !droppedSignatures) {
        droppedSignatures = true
        continue
      }
      // 2. The upstream says the session itself overflowed: bump its generation.
      if (status === 400 && isSessionOverflow(text) && sessionBumps < MAX_SESSION_BUMPS) {
        sessionBumps += 1
        sessionGeneration = sessionBumps
        continue
      }

      const endpointFirst = status === 403 || status === 404 || (status === 400 && isSwitchableText(text))
      const quotaLike = status === 429 || (status === 400 && isQuotaText(text))

      // 3. A genuine context overflow is terminal — retrying cannot shrink it.
      if (status === 400 && isContextOverflow(text)) throw classify(status, text)

      // 4. The other endpoint is worth one try for anything that smells regional.
      if ((endpointFirst || status === 429) && !endpointSwitched) {
        endpointSwitched = true
        endpointIndex = endpointIndex === 0 ? 1 : 0
        continue
      }

      // 5. An expired access token: pi-ai refreshes before the call, but a token
      //    can die inside the window.
      if (status === 401 && !refreshed && isRefreshable(credential)) {
        refreshed = true
        await deps.refreshCredential().catch(() => undefined)
        const next = await deps.readCredential()
        if (next !== undefined && typeof next.access_token === 'string' && next.access_token !== '') {
          credential = next
          continue
        }
      }

      // 6. A 429 is used for a rejected prompt as well as an exhausted account,
      //    and the body is identical for both. Ask the quota endpoint what is
      //    actually left: an account with budget remaining did not run out.
      if (quotaLike) {
        const reading = await probeQuota(credential, {
          fetchImpl,
          cache: deps.quotaCache,
          identity: credentialIdentity(credential),
          signal,
        })
        if (quotaRemains(reading.buckets)) throw new Error(rejectionMessage(status, text, reading.buckets))
        if (reading.error !== undefined) throw new Error(rejectionMessage(status, text, [], reading.error))
        throw new Error(
          `Antigravity：账号额度或限流（HTTP ${status}），请稍后再试${describeQuota(reading.buckets) === '' ? '' : `（剩余 ${describeQuota(reading.buckets)}）`}`,
        )
      }

      throw classify(status, text)
    }
  }

  run().catch((error) => {
    const model0 = model
    const message = emptyMessage(model0)
    message.stopReason = 'error'
    message.errorMessage = error instanceof Error ? error.message : String(error)
    outer.push({ type: 'error', reason: 'error', error: message })
    outer.end(message)
  })

  return outer
}

/**
 * Turn a failure response into an error.
 *
 * @param {number} status - the HTTP status.
 * @param {string} text - the body.
 * @returns {Error} the error.
 */
function classify(status, text) {
  const detail = text === '' ? '' : ` — ${text.slice(0, 500)}`
  return new Error(`Antigravity：HTTP ${status}${detail}`)
}

/**
 * Consume the SSE body, emitting pi-ai events into `outer`.
 *
 * The message and the "already started" flag live in the caller, so an empty
 * turn can be resent into the same message: a retry appends rather than rewrites,
 * and every `contentIndex` the caller has seen keeps pointing at its block.
 *
 * @param {object} outer - the event stream.
 * @param {ReadableStream<Uint8Array>} body - the response body.
 * @param {object} model - the pi-ai model.
 * @param {object} message - the assistant message to grow.
 * @param {{ started: boolean }} state - whether `start` has been emitted.
 * @param {AbortSignal} signal - cancellation.
 * @returns {Promise<{ sawContent: boolean, sawUsable: boolean, finishReason?: string, toolCount: number, usage: object, notice?: string }>} the outcome.
 */
async function consume(outer, body, model, message, state, signal) {
  const decoder = new TextDecoder()
  const reader = body.getReader()

  let buffer = ''
  let openKind // 'text' | 'thinking' | 'tool'
  let openIndex = -1
  let sawContent = false
  let sawUsable = false
  let finishReason
  let toolCount = 0
  let usage = {}

  // The opening of the answer is withheld until it can no longer be a filter
  // notice — the notice arrives as ordinary text, so its only tell is that the
  // first sentence says so.
  let peek = ''
  let notice
  let noticeText = ''

  const push = (event) => outer.push({ ...event, partial: message })

  const ensureStarted = () => {
    if (state.started) return
    state.started = true
    push({ type: 'start' })
  }

  const closeOpen = () => {
    if (openKind === undefined) return
    const block = message.content[openIndex]
    if (openKind === 'text') push({ type: 'text_end', contentIndex: openIndex, content: block.text ?? '' })
    else if (openKind === 'thinking') push({ type: 'thinking_end', contentIndex: openIndex, content: block.thinking ?? '' })
    else if (openKind === 'tool') push({ type: 'toolcall_end', contentIndex: openIndex, toolCall: block })
    openKind = undefined
    openIndex = -1
  }

  const openText = () => {
    if (openKind === 'text') return
    closeOpen()
    ensureStarted()
    openIndex = message.content.push({ type: 'text', text: '' }) - 1
    openKind = 'text'
    push({ type: 'text_start', contentIndex: openIndex })
  }

  const openThinking = () => {
    if (openKind === 'thinking') return
    closeOpen()
    ensureStarted()
    openIndex = message.content.push({ type: 'thinking', thinking: '' }) - 1
    openKind = 'thinking'
    push({ type: 'thinking_start', contentIndex: openIndex })
  }

  /** Append text that has already passed the filter peek. */
  const emitText = (delta) => {
    if (delta === '') return
    openText()
    const block = message.content[openIndex]
    block.text = `${block.text ?? ''}${delta}`
    sawContent = true
    sawUsable = true
    push({ type: 'text_delta', contentIndex: openIndex, delta })
  }

  const appendText = (delta) => {
    if (delta === '') return
    if (notice !== undefined) {
      if (noticeText.length < 400) noticeText += delta
      return
    }
    peek += delta
    const hit = filterNoticeIn(peek)
    if (hit !== undefined) {
      notice = hit
      noticeText = peek
      peek = ''
      return
    }
    // Hold everything while the tail could still become a notice, then release
    // it in one go. The wait is a character count, not a frame count, so it only
    // happens when the text literally ends inside a marker's opening words.
    if (filterHoldLength(peek) > 0) return
    const ready = peek
    peek = ''
    emitText(ready)
  }

  const appendThinking = (delta) => {
    if (delta === '') return
    openThinking()
    const block = message.content[openIndex]
    block.thinking = `${block.thinking ?? ''}${delta}`
    sawContent = true
    push({ type: 'thinking_delta', contentIndex: openIndex, delta })
  }

  const appendTool = (name, args, signature) => {
    closeOpen()
    ensureStarted()
    toolCount += 1
    const id = `gemini_tool_${Date.now().toString(36)}_${toolCount}`
    const toolCall = { type: 'toolCall', id, name: restoreToolName(name), arguments: args }
    if (typeof signature === 'string' && signature !== '') toolCall.thoughtSignature = signature
    openIndex = message.content.push(toolCall) - 1
    openKind = 'tool'
    sawContent = true
    sawUsable = true
    push({ type: 'toolcall_start', contentIndex: openIndex })
    push({ type: 'toolcall_delta', contentIndex: openIndex, delta: canonicalArgs(args) })
    push({ type: 'toolcall_end', contentIndex: openIndex, toolCall })
    openKind = undefined
    openIndex = -1
  }

  const noteUsage = (raw) => {
    const counts = readUsage(raw)
    if (counts.totalTokens !== undefined && (usage.totalTokens ?? -1) >= counts.totalTokens) return
    usage = counts
    applyUsage(model, message, usage)
  }

  const processFrame = (payload) => {
    let frame
    try {
      frame = JSON.parse(payload)
    } catch {
      return
    }
    const inner = frame?.response ?? frame
    const candidate = inner?.candidates?.[0]
    if (candidate === undefined) {
      if (inner?.usageMetadata !== undefined) noteUsage(inner.usageMetadata)
      return
    }
    if (typeof candidate.finishReason === 'string') finishReason = candidate.finishReason
    for (const part of candidate.content?.parts ?? []) {
      if (part === null || typeof part !== 'object') continue
      if (part.functionCall !== undefined) {
        const args = part.functionCall.args ?? {}
        appendTool(part.functionCall.name, typeof args === 'object' && args !== null ? args : {}, part.thoughtSignature)
        continue
      }
      const text = typeof part.text === 'string' ? part.text : ''
      if (text === '') continue
      if (part.thought === true) appendThinking(text)
      else appendText(text)
    }
    if (inner.usageMetadata !== undefined) noteUsage(inner.usageMetadata)
  }

  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      let newline = buffer.indexOf('\n')
      while (newline >= 0) {
        const line = buffer.slice(0, newline)
        buffer = buffer.slice(newline + 1)
        const payload = dataPayload(line)
        if (payload !== undefined) processFrame(payload)
        newline = buffer.indexOf('\n')
      }
      if (signal.aborted) break
    }
    if (buffer !== '') {
      const payload = dataPayload(buffer)
      if (payload !== undefined) processFrame(payload)
    }
  } finally {
    reader.releaseLock()
  }

  // A short answer that never grew past a marker prefix is released here, and
  // only after a last look for a notice that was cut off mid-sentence.
  if (peek !== '') {
    const hit = filterNoticeIn(peek)
    if (hit !== undefined) {
      notice = hit
      noticeText = peek
    } else {
      emitText(peek)
    }
    peek = ''
  }

  closeOpen()
  ensureStarted()

  return { sawContent, sawUsable, finishReason, toolCount, usage, notice, noticeText }
}

/**
 * A `streamSimple`-shaped entry point.
 *
 * @param {object} model - the pi-ai model.
 * @param {object} context - the pi-ai context.
 * @param {object} options - simple stream options.
 * @param {object} deps - provider dependencies.
 * @returns {object} the event stream.
 */
export function streamSimpleAntigravity(model, context, options, deps) {
  return streamAntigravity(model, context, options, deps)
}
