/**
 * Offline exercise of the Antigravity lane.
 *
 * Nothing here leaves the machine: `fetch` is replaced with a router that answers
 * the two Cloud Code paths with fixtures, so the whole request path — schema
 * sanitising, tool-id renumbering, alphabetical marshalling, SSE frame decoding,
 * the pi-ai event sequence — runs for real against synthetic bytes.
 *
 * `node test/antigravity-lane.mjs`
 *
 * @module dsh-subproxy/test/antigravity-lane
 */
import assert from 'node:assert/strict'

import {
  ENDPOINTS,
  LOAD_CODE_ASSIST_PATH,
  QUOTA_PATH,
  STREAM_PATH,
  marshalAlphabetical,
  planLabel,
  sanitizeSchema,
} from '../lib/antigravity/protocol.js'
import { translateRequest } from '../lib/antigravity/request.js'
import { parseAvailableModels, resolveUpstreamId } from '../lib/antigravity/catalog.js'
import { grantOf, parseRefsBlock, rankOf } from '../lib/antigravity/account.js'
import { streamAntigravity } from '../lib/antigravity/stream.js'

const checks = []
const check = (label, body) => {
  body()
  checks.push(label)
}

check('schema: required:true is promoted to the parent', () => {
  const out = sanitizeSchema({
    type: 'object',
    properties: {
      name: { type: 'string', required: true },
      age: { type: 'integer' },
    },
  })
  assert.deepEqual(out.required, ['name'])
  assert.equal(out.properties.name.required, undefined)
})

check('schema: tuple items collapse to one element', () => {
  const out = sanitizeSchema({ type: 'array', items: [{ type: 'string' }, { type: 'number' }] })
  assert.deepEqual(out.items, { type: 'string' })
})

check('schema: anyOf branches flatten into one object', () => {
  const out = sanitizeSchema({
    anyOf: [
      { type: 'object', properties: { a: { type: 'string' } }, required: ['a'] },
      { type: 'object', properties: { b: { type: 'number' } } },
    ],
  })
  assert.equal(out.type, 'object')
  assert.deepEqual(Object.keys(out.properties).sort(), ['a', 'b'])
  assert.deepEqual(out.required, ['a'])
})

check('schema: array without items gets a string item', () => {
  assert.deepEqual(sanitizeSchema({ type: 'array' }).items, { type: 'string' })
})

check('schema: a missing type is inferred from properties', () => {
  assert.equal(sanitizeSchema({ properties: { a: { type: 'string' } } }).type, 'object')
})

check('schema: unknown keys are dropped', () => {
  const out = sanitizeSchema({ type: 'string', $schema: 'x', additionalProperties: false })
  assert.equal(out.$schema, undefined)
  assert.equal(out.additionalProperties, undefined)
})

check('marshalling sorts every object key', () => {
  assert.equal(marshalAlphabetical({ b: 1, a: { d: 2, c: 3 } }), '{"a":{"c":3,"d":2},"b":1}')
})

check('upstream id: a tier the catalog does not serve falls back to its default', () => {
  const entries = [{ id: 'gemini-3.8-flash', effortOptions: ['low', 'medium'], defaultEffort: 'medium' }]
  assert.equal(resolveUpstreamId('gemini-3.8-flash', 'low', entries), 'gemini-3.8-flash-low')
  assert.equal(resolveUpstreamId('gemini-3.8-flash', 'high', entries), 'gemini-3.8-flash-medium')
  assert.equal(resolveUpstreamId('gemini-3.8-pro', 'high', entries), 'gemini-3.8-pro')
})

check('catalog: tier rows fold into one entry, xhigh kept apart from high', () => {
  const entries = parseAvailableModels({
    models: {
      'gemini-4-hydrogen-low': { displayName: 'Gemini 4 Hydrogen (Low)', maxTokens: 1_048_576, maxOutputTokens: 262_144 },
      'gemini-4-hydrogen-high': { displayName: 'Gemini 4 Hydrogen (High)' },
      'gemini-4-hydrogen-xhigh': { displayName: 'Gemini 4 Hydrogen (XHigh)' },
    },
  })
  assert.equal(entries.length, 1)
  assert.equal(entries[0].id, 'gemini-4-hydrogen')
  assert.equal(entries[0].name, 'Gemini 4 Hydrogen')
  assert.deepEqual(entries[0].effortOptions, ['low', 'high', 'xhigh'])
  assert.equal(entries[0].defaultEffort, 'high')
})

check('catalog: a model with no tier rows is served under its bare id', () => {
  const entries = parseAvailableModels({ models: { 'gemini-2.5-pro': { displayName: 'Gemini 2.5 Pro' } } })
  assert.equal(entries[0].id, 'gemini-2.5-pro')
  assert.equal(entries[0].effortOptions, undefined)
  assert.equal(resolveUpstreamId('gemini-2.5-pro', 'high', entries), 'gemini-2.5-pro')
})

check('catalog: internal tab and chat rows never reach the picker', () => {
  const entries = parseAvailableModels({
    models: {
      tab_flash_lite_preview: { displayName: '' },
      chat_20706: {},
      'gemini-2.5-flash': { displayName: 'Gemini 3.5 Flash Lite' },
    },
  })
  assert.deepEqual(
    entries.map((entry) => entry.id),
    ['gemini-2.5-flash'],
  )
})

check('catalog: the upstream sort order is the picker order, not the alphabet', () => {
  const entries = parseAvailableModels({
    models: {
      'gpt-oss-120b-medium': { displayName: 'GPT-OSS 120B' },
      'gemini-4-carbon-medium': { displayName: 'Gemini 4 Carbon' },
      'claude-opus-5-5-medium': { displayName: 'Claude Opus 5.5' },
    },
    agentModelSorts: [
      {
        displayName: 'Recommended',
        groups: [
          { modelIds: ['gemini-4-carbon-medium', 'claude-opus-5-5-medium', 'gpt-oss-120b-medium'] },
        ],
      },
    ],
  })
  assert.deepEqual(
    entries.map((entry) => entry.id),
    ['gemini-4-carbon', 'claude-opus-5-5', 'gpt-oss-120b'],
  )
})

check('catalog: a plan-disabled family is flagged, and one live tier clears it', () => {
  const blocked = parseAvailableModels({
    models: {
      'gemini-4-carbon-disabled': {
        displayName: 'Gemini 4 Carbon',
        disabled: true,
        tagDescription: 'Gemini 4 Carbon is currently available to Ultra plan subscribers. More text.',
      },
    },
  })
  assert.equal(blocked[0].id, 'gemini-4-carbon')
  assert.equal(blocked[0].disabled, true)
  assert.equal(blocked[0].notice, 'Gemini 4 Carbon is currently available to Ultra plan subscribers')

  const live = parseAvailableModels({
    models: {
      'gemini-4-carbon-disabled': { displayName: 'Gemini 4 Carbon', disabled: true },
      'gemini-4-carbon-medium': { displayName: 'Gemini 4 Carbon' },
    },
  })
  assert.equal(live.length, 1)
  assert.equal(live[0].disabled, undefined)
  assert.deepEqual(live[0].effortOptions, ['medium'])
})

check('catalog: one display name reached by several ids keeps the live row', () => {
  const entries = parseAvailableModels({
    models: {
      'gemini-2.5-flash-lite': { displayName: 'Gemini 3.5 Flash Lite' },
      'gemini-2.5-flash': { displayName: 'Gemini 3.5 Flash Lite' },
      'gemini-3.5-flash-lite': { displayName: 'Gemini 3.5 Flash Lite' },
    },
    tieredModelIds: { flashLite: ['gemini-3.5-flash-lite'] },
  })
  assert.equal(entries.length, 1)
  assert.equal(entries[0].id, 'gemini-3.5-flash-lite')
})

check('account: the paid plan outranks the effective tier', () => {
  assert.deepEqual(rankOf({ currentTier: { id: 'free-tier' }, paidTier: { id: 'g1-ultra-lite-tier' } }), {
    rank: 3,
    tier: 'free-tier',
    paid: 'g1-ultra-lite-tier',
  })
  assert.equal(rankOf({ currentTier: { id: 'free-tier' }, paidTier: { id: 'g1-pro-tier' } }).rank, 2)
  assert.equal(rankOf({ currentTier: { id: 'g1-ultra-lite-tier' } }).rank, 3)
  assert.equal(rankOf({}).rank, 0)
})

check('account: the status line names the plan, not the internal tier id', () => {
  // `free-tier` is the *effective* tier even on a paying account, so showing it
  // verbatim reads as "you are on something worse than you paid for".
  assert.equal(planLabel({ tier: 'free-tier', paid: 'g1-ultra-lite-tier' }), 'Google AI Ultra')
  assert.equal(planLabel({ tier: 'free-tier', paid: 'g1-pro-tier' }), 'Google AI Pro')
  assert.equal(planLabel({ tier: 'g1-ultra-tier' }), 'Google AI Ultra')
  assert.equal(planLabel({ tier: 'standard-tier' }), 'Standard')
  assert.equal(planLabel({ tier: 'brand-new-tier' }), 'brand-new-tier')
  assert.equal(planLabel(undefined), '')
})

check('account: only Google-shaped references are adopted', async () => {
  const value = (payload) => JSON.stringify(payload)
  assert.equal(grantOf(value({ access: 'ya29.x', refresh: '1//x' }))?.access_token, 'ya29.x')
  assert.equal(grantOf(value({ access_token: 'sk-ant-1', refresh_token: 'r' })), undefined)
  assert.equal(grantOf(value({ access_token: 'x', refresh_token: 'r', scope: 'https://www.googleapis.com/x' }))?.access_token, 'x')
  assert.equal(grantOf('-----BEGIN PRIVATE KEY-----'), undefined)
  assert.equal(grantOf('not json'), undefined)
  assert.equal(grantOf(value({ access_token: 'ya29.x' })), undefined)
})

check('account: a multi-line quoted reference parses without JSON escaping', () => {
  const refs = parseRefsBlock(
    [
      'version: 1',
      'refs:',
      '  GEMINI_ACCOUNT_CD003778: \'{"accessToken":"ya29.a",',
      '    "refreshToken":"1//b","email":"x@y.z"}\'',
      '  CODEX_OAUTH_1: \'{"access":"sk-x","refresh":"r"}\'',
    ].join('\n'),
  )
  assert.equal(refs.GEMINI_ACCOUNT_CD003778, '{"accessToken":"ya29.a", "refreshToken":"1//b","email":"x@y.z"}')
  assert.equal(refs.CODEX_OAUTH_1, '{"access":"sk-x","refresh":"r"}')
})

check('translation: tool ids are renumbered and paired', () => {
  const result = translateRequest({
    spec: { upstream: 'gemini-3.8-flash-medium', includeThoughts: true, thinkingBudget: 4000 },
    messages: [
      { role: 'user', content: 'read the file', timestamp: 1 },
      {
        role: 'assistant',
        content: [{ type: 'toolCall', id: 'call|weird:id.1', name: 'read', arguments: { path: 'a.txt' } }],
        api: 'x',
        provider: 'y',
        model: 'z',
        usage: {},
        stopReason: 'toolUse',
        timestamp: 2,
      },
      {
        role: 'toolResult',
        toolCallId: 'call|weird:id.1',
        toolName: 'read',
        content: [{ type: 'text', text: 'hello' }],
        isError: false,
        timestamp: 3,
      },
    ],
    project: 'proj-1',
    requestId: 'agent/1/abcd',
    sessionLane: 'infer',
  })
  const call = result.request.contents[1].parts[0].functionCall
  const response = result.request.contents[2].parts[0].functionResponse
  assert.match(call.id, /^[a-zA-Z0-9_-]{1,64}$/)
  assert.equal(call.id, response.id)
})

check('translation: reasoning blocks are dropped, their signature rides the call', () => {
  const result = translateRequest({
    spec: { upstream: 'm', includeThoughts: true, thinkingBudget: 1000 },
    messages: [
      { role: 'user', content: 'hi', timestamp: 1 },
      {
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: 'secret reasoning' },
          { type: 'toolCall', id: 'c1', name: 'f', arguments: {}, thoughtSignature: 'SIG' },
        ],
        api: 'x',
        provider: 'y',
        model: 'z',
        usage: {},
        stopReason: 'toolUse',
        timestamp: 2,
      },
    ],
    project: 'p',
    requestId: 'r',
  })
  const parts = result.request.contents[1].parts
  assert.equal(parts.length, 1)
  assert.equal(parts[0].thoughtSignature, 'SIG')
  assert.equal(JSON.stringify(result.request).includes('secret reasoning'), false)
})

check('translation: tool names are flattened and schemas sanitised', () => {
  const result = translateRequest({
    spec: { upstream: 'm', includeThoughts: false, thinkingBudget: undefined },
    messages: [{ role: 'user', content: 'hi', timestamp: 1 }],
    project: 'p',
    requestId: 'r',
    tools: [
      {
        name: 'ns.dotted/tool',
        description: 'does things',
        parameters: { type: 'object', properties: { a: { type: 'string', required: true } } },
      },
    ],
  })
  const declaration = result.request.tools[0].functionDeclarations[0]
  assert.match(declaration.name, /^[a-zA-Z0-9_-]{1,64}$/)
  assert.deepEqual(declaration.parameters.required, ['a'])
})

check('translation: the wire body is byte-stable under key reordering', () => {
  const base = {
    spec: { upstream: 'm', includeThoughts: false, thinkingBudget: undefined },
    messages: [{ role: 'user', content: 'hi', timestamp: 1 }],
    project: 'p',
    requestId: 'fixed',
    sessionId: 'fixed-session',
  }
  assert.equal(translateRequest({ ...base }).wire, translateRequest({ ...base }).wire)
})

check('translation: an empty conversation is refused', () => {
  assert.throws(
    () =>
      translateRequest({
        spec: { upstream: 'm', includeThoughts: false },
        messages: [],
        project: 'p',
        requestId: 'r',
      }),
    /没有可用内容/,
  )
})

/** Extract the events a stream produced. */
const drain = async (stream) => {
  const events = []
  for await (const event of stream) events.push(event)
  return events
}

const sseBody = (frames) => frames.map((frame) => `data: ${JSON.stringify(frame)}\r\n\r\n`).join('')

const frame = (parts, extra = {}) => ({
  response: {
    candidates: [{ content: { role: 'model', parts }, ...extra }],
  },
})

/** A fetch that answers the two Cloud Code paths with fixtures. */
const fixtureFetch = (frames) => async (url) => {
  if (String(url).includes(LOAD_CODE_ASSIST_PATH)) {
    return new Response(JSON.stringify({ cloudaicompanionProject: 'proj-fixture' }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })
  }
  if (String(url).includes(STREAM_PATH) || String(url).includes('streamGenerateContent')) {
    const body = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(sseBody(frames)))
        controller.close()
      },
    })
    return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } })
  }
  return new Response('not found', { status: 404 })
}

const model = { id: 'gemini-3.8-flash', api: 'antigravity-code-assist', provider: 'sub-gemini', cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 1e6, maxTokens: 64000 }

const depsFor = (fetchImpl, catalog) => ({
  readCredential: async () => ({ access_token: 'tok', expiry: new Date(Date.now() + 3600_000).toISOString() }),
  refreshCredential: async () => undefined,
  projectCache: new Map(),
  logger: { warn: (message) => console.log(`   [warn] ${message}`) },
  catalog: () => catalog ?? [{ id: 'gemini-3.8-flash', effortOptions: ['low', 'medium', 'high'], defaultEffort: 'medium' }],
})

{
  const stream = streamAntigravity(
    model,
    { messages: [{ role: 'user', content: 'hello', timestamp: 1 }] },
    { fetch: fixtureFetch([frame([{ text: 'Hel' }]), frame([{ text: 'lo' }], { finishReason: 'STOP' })]) },
    depsFor(),
  )
  const events = await drain(stream)
  check('stream: text arrives as start → text_start → deltas → text_end → usage → done', () => {
    assert.deepEqual(
      events.map((event) => event.type),
      ['start', 'text_start', 'text_delta', 'text_delta', 'text_end', 'usage', 'done'],
    )
    const deltas = events.filter((event) => event.type === 'text_delta').map((event) => event.delta)
    assert.deepEqual(deltas, ['Hel', 'lo'])
    const done = events.at(-1)
    assert.equal(done.reason, 'stop')
    assert.equal(done.message.content[0].text, 'Hello')
    assert.equal(done.message.stopReason, 'stop')
    assert.equal(done.message.responseId?.startsWith('agent/'), true)
  })
}

{
  const stream = streamAntigravity(
    model,
    { messages: [{ role: 'user', content: 'hello', timestamp: 1 }] },
    {
      fetch: fixtureFetch([
        frame([{ text: 'thinking…', thought: true }]),
        frame([{ text: 'answer' }], { finishReason: 'STOP' }),
      ]),
    },
    depsFor(),
  )
  const events = await drain(stream)
  check('stream: a thought part becomes a thinking block, not text', () => {
    assert.deepEqual(
      events.map((event) => event.type),
      [
        'start',
        'thinking_start',
        'thinking_delta',
        'thinking_end',
        'text_start',
        'text_delta',
        'text_end',
        'usage',
        'done',
      ],
    )
    const message = events.at(-1).message
    assert.equal(message.content[0].type, 'thinking')
    assert.equal(message.content[0].thinking, 'thinking…')
    assert.equal(message.content[1].type, 'text')
  })
}

{
  const stream = streamAntigravity(
    model,
    { messages: [{ role: 'user', content: 'hello', timestamp: 1 }] },
    {
      fetch: fixtureFetch([
        frame(
          [{ functionCall: { name: 'read', args: { path: 'a.txt' }, id: 'wire1' }, thoughtSignature: 'SIG' }],
          { finishReason: 'STOP' },
        ),
      ]),
    },
    depsFor(),
  )
  const events = await drain(stream)
  check('stream: a function call becomes a toolCall block with its signature', () => {
    const types = events.map((event) => event.type)
    assert.deepEqual(types.slice(-5), ['toolcall_start', 'toolcall_delta', 'toolcall_end', 'usage', 'done'])
    const call = events.find((event) => event.type === 'toolcall_end').toolCall
    assert.equal(call.name, 'read')
    assert.deepEqual(call.arguments, { path: 'a.txt' })
    assert.equal(call.thoughtSignature, 'SIG')
    assert.equal(events.at(-1).reason, 'toolUse')
  })
}

{
  const stream = streamAntigravity(
    model,
    { messages: [{ role: 'user', content: 'hello', timestamp: 1 }] },
    { fetch: fixtureFetch([frame([{ text: 'partial' }], { finishReason: 'MAX_TOKENS' })]) },
    depsFor(),
  )
  const events = await drain(stream)
  check('stream: MAX_TOKENS maps to the length stop reason', () => {
    assert.equal(events.at(-1).reason, 'length')
    assert.equal(events.at(-1).message.stopReason, 'length')
  })
}

{
  const stream = streamAntigravity(
    model,
    { messages: [{ role: 'user', content: 'hello', timestamp: 1 }] },
    { fetch: fixtureFetch([frame([])], ) },
    depsFor(),
  )
  const events = await drain(stream)
  check('stream: an empty answer surfaces as an error event, not a silent stop', () => {
    const last = events.at(-1)
    assert.equal(last.type, 'error')
    assert.match(last.error.errorMessage, /未返回任何内容块/)
  })
}

{
  // The upstream sometimes finishes with nothing but thought parts and
  // `STOP`. That is a dropped request, not an answer: the same call answers on
  // a second try, so the lane resends once and keeps the answer.
  let calls = 0
  const fetchImpl = async (url) => {
    if (String(url).includes(LOAD_CODE_ASSIST_PATH)) {
      return new Response(JSON.stringify({ cloudaicompanionProject: 'p' }), { status: 200 })
    }
    calls += 1
    const frames =
      calls === 1
        ? [frame([{ text: 'Let me think about it.', thought: true }], { finishReason: 'STOP' })]
        : [frame([{ text: 'Here it is.' }], { finishReason: 'STOP' })]
    return new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(sseBody(frames)))
          controller.close()
        },
      }),
      { status: 200 },
    )
  }
  const events = await drain(
    streamAntigravity(model, { messages: [{ role: 'user', content: 'hello', timestamp: 1 }] }, { fetch: fetchImpl }, depsFor()),
  )
  check('stream: a thought-only STOP is resent once and the answer is kept', () => {
    assert.equal(calls, 2)
    assert.equal(events.filter((event) => event.type === 'start').length, 1)
    const message = events.at(-1).message
    assert.equal(events.at(-1).type, 'done')
    assert.equal(message.content.at(-1).text, 'Here it is.')
    assert.equal(message.content[0].type, 'thinking')
  })
}

{
  // When the resend is empty too, the turn must fail loudly. Reporting success
  // with no content is what makes an empty answer look like a model decision.
  const thought = [frame([{ text: 'Thinking only.', thought: true }], { finishReason: 'STOP' })]
  const events = await drain(
    streamAntigravity(
      model,
      { messages: [{ role: 'user', content: 'hello', timestamp: 1 }] },
      { fetch: fixtureFetch(thought) },
      depsFor(),
    ),
  )
  check('stream: a thought-only turn that stays empty surfaces an error naming the cause', () => {
    const last = events.at(-1)
    assert.equal(last.type, 'error')
    assert.match(last.error.errorMessage, /只返回了思考/)
    assert.match(last.error.errorMessage, /finishReason=STOP/)
  })
}

{
  // A blocked prompt comes back as HTTP 200 and a plain-text apology. It must
  // never be shown as an answer — the wording is the only thing that marks it.
  const notice =
    "This request was blocked by Gemini's filters. They can occasionally trigger by mistake on safe coding, security, or biology-related queries."
  const events = await drain(
    streamAntigravity(
      model,
      { messages: [{ role: 'user', content: 'hello', timestamp: 1 }] },
      { fetch: fixtureFetch([frame([{ text: notice }], { finishReason: 'STOP' })]) },
      depsFor(),
    ),
  )
  check('stream: a filter notice is reported as a rejection, not streamed as an answer', () => {
    const last = events.at(-1)
    assert.equal(last.type, 'error')
    assert.match(last.error.errorMessage, /内容审核/)
    assert.match(last.error.errorMessage, /blocked by Gemini's filters/)
    assert.equal(
      events.some((event) => event.type === 'text_delta'),
      false,
    )
  })
}

{
  // A notice split across frames is still caught. The part already shown cannot
  // be taken back, but the turn must fail rather than finish with the notice as
  // its answer, and the notice itself must never reach the message.
  const events = await drain(
    streamAntigravity(
      model,
      { messages: [{ role: 'user', content: 'hello', timestamp: 1 }] },
      {
        fetch: fixtureFetch([
          frame([{ text: 'This request was ' }]),
          frame([{ text: "blocked by Gemini's filters." }], { finishReason: 'STOP' }),
        ]),
      },
      depsFor(),
    ),
  )
  check('stream: a filter notice split over two frames is still caught', () => {
    const last = events.at(-1)
    assert.equal(last.type, 'error')
    assert.match(last.error.errorMessage, /内容审核/)
    assert.equal(
      events.some((event) => event.type === 'done'),
      false,
    )
  })
}

{
  // An answer that merely starts with a marker's first letter must still
  // stream normally — the peek may not delay or merge real text.
  const events = await drain(
    streamAntigravity(
      model,
      { messages: [{ role: 'user', content: 'hello', timestamp: 1 }] },
      { fetch: fixtureFetch([frame([{ text: 'Because ' }]), frame([{ text: 'it is true.' }], { finishReason: 'STOP' })]) },
      depsFor(),
    ),
  )
  check('stream: an answer whose opening only resembles a marker still streams', () => {
    const message = events.at(-1).message
    assert.equal(events.at(-1).type, 'done')
    assert.equal(message.content[0].text, 'Because it is true.')
  })
}

{
  // A 429 is also how the upstream answers a rejected prompt, with the same
  // `RESOURCE_EXHAUSTED` body a spent account gets. The quota endpoint is the
  // only honest tie-breaker: budget left means the request was refused.
  const events = await drain(
    streamAntigravity(
      model,
      { messages: [{ role: 'user', content: 'hello', timestamp: 1 }] },
      {
        fetch: async (url) => {
          const href = String(url)
          if (href.includes(LOAD_CODE_ASSIST_PATH)) {
            return new Response(JSON.stringify({ cloudaicompanionProject: 'p' }), { status: 200 })
          }
          if (href.includes(QUOTA_PATH)) {
            return new Response(
              JSON.stringify({
                groups: [{ buckets: [{ bucketId: 'gemini-weekly', remainingFraction: 0.84, window: 'weekly' }] }],
              }),
              { status: 200 },
            )
          }
          return new Response(
            JSON.stringify({ error: { code: 429, message: 'Resource has been exhausted (e.g. check quota).', status: 'RESOURCE_EXHAUSTED' } }),
            { status: 429 },
          )
        },
      },
      depsFor(),
    ),
  )
  check('stream: a 429 with budget left is reported as a content rejection, with the reading', () => {
    const last = events.at(-1)
    assert.equal(last.type, 'error')
    assert.match(last.error.errorMessage, /HTTP 429/)
    assert.match(last.error.errorMessage, /不是额度问题/)
    assert.match(last.error.errorMessage, /gemini-weekly 84%/)
  })
}

{
  // The other half of the same rule: a genuinely spent account must keep its
  // "wait and retry" advice rather than being blamed on the prompt.
  const events = await drain(
    streamAntigravity(
      model,
      { messages: [{ role: 'user', content: 'hello', timestamp: 1 }] },
      {
        fetch: async (url) => {
          const href = String(url)
          if (href.includes(LOAD_CODE_ASSIST_PATH)) {
            return new Response(JSON.stringify({ cloudaicompanionProject: 'p' }), { status: 200 })
          }
          if (href.includes(QUOTA_PATH)) {
            return new Response(
              JSON.stringify({ groups: [{ buckets: [{ bucketId: 'gemini-weekly', remainingFraction: 0 }] }] }),
              { status: 200 },
            )
          }
          return new Response(
            JSON.stringify({ error: { code: 429, message: 'Resource has been exhausted (e.g. check quota).', status: 'RESOURCE_EXHAUSTED' } }),
            { status: 429 },
          )
        },
      },
      depsFor(),
    ),
  )
  check('stream: a 429 with an empty bucket keeps the quota advice', () => {
    const last = events.at(-1)
    assert.equal(last.type, 'error')
    assert.match(last.error.errorMessage, /账号额度或限流/)
  })
}

{
  // A 400 whose body names a bad signature must be retried with signatures
  // dropped — the ladder's first rung.
  let calls = 0
  const fetchImpl = async (url, init) => {
    if (String(url).includes(LOAD_CODE_ASSIST_PATH)) {
      return new Response(JSON.stringify({ cloudaicompanionProject: 'p' }), { status: 200 })
    }
    calls += 1
    if (calls === 1) {
      return new Response('Invalid thought_signature for function call', { status: 400 })
    }
    const body = String(init.body)
    assert.equal(body.includes('thoughtSignature'), false)
    return new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(sseBody([frame([{ text: 'ok' }], { finishReason: 'STOP' })])))
          controller.close()
        },
      }),
      { status: 200 },
    )
  }
  const stream = streamAntigravity(
    model,
    {
      messages: [
        { role: 'user', content: 'hello', timestamp: 1 },
        {
          role: 'assistant',
          content: [{ type: 'toolCall', id: 'c1', name: 'f', arguments: {}, thoughtSignature: 'SIG' }],
          api: 'x',
          provider: 'y',
          model: 'z',
          usage: {},
          stopReason: 'toolUse',
          timestamp: 2,
        },
      ],
    },
    { fetch: fetchImpl },
    depsFor(),
  )
  const events = await drain(stream)
  check('stream: a rejected signature is retried once without signatures', () => {
    assert.equal(calls, 2)
    assert.equal(events.at(-1).type, 'done')
    assert.equal(events.at(-1).message.content[0].text, 'ok')
  })
}

{
  // A 429 on the first endpoint switches endpoints before failing.
  const seen = []
  const fetchImpl = async (url) => {
    if (String(url).includes(LOAD_CODE_ASSIST_PATH)) {
      return new Response(JSON.stringify({ cloudaicompanionProject: 'p' }), { status: 200 })
    }
    seen.push(String(url).startsWith(ENDPOINTS[0]) ? 'daily' : 'sandbox')
    if (String(url).startsWith(ENDPOINTS[0])) return new Response('rate limited', { status: 429 })
    return new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(sseBody([frame([{ text: 'ok' }], { finishReason: 'STOP' })])))
          controller.close()
        },
      }),
      { status: 200 },
    )
  }
  const stream = streamAntigravity(
    model,
    { messages: [{ role: 'user', content: 'hello', timestamp: 1 }] },
    { fetch: fetchImpl },
    depsFor(),
  )
  const events = await drain(stream)
  check('stream: a 429 fails over to the second endpoint', () => {
    assert.deepEqual(seen, ['daily', 'sandbox'])
    assert.equal(events.at(-1).type, 'done')
  })
}

console.log(`\n${checks.length} checks passed`)
for (const label of checks) console.log(`  ok  ${label}`)
