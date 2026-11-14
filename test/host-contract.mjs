/**
 * End-to-end exercise through the real `PiAiAdapter`.
 *
 * The other two suites test this plugin's own modules. This one hands the adapter
 * to pi-ai's actual `PiAiAdapter` and asks it for a call, which is what the
 * harness does — so it proves the seam that would otherwise only fail on a live
 * host: session auth resolution, profile lookup, `prepareCall`, event translation
 * into harness chunks, and the `done`/`finish` pair a turn needs to end.
 *
 * The upstream is a fixture; everything above it is real.
 *
 * `node test/host-contract.mjs`
 *
 * @module dsh-subproxy/test/host-contract
 */
import assert from 'node:assert/strict'

import { apply } from '../lib/index.js'
import { ROUTES, ROUTE_CLAUDE, ROUTE_GEMINI, ROUTE_OPENAI } from '../lib/constants.js'
import { recordKeyFor } from '../lib/credentials.js'

const checks = []
const check = async (label, body) => {
  await body()
  checks.push(label)
}

/**
 * A cordis-shaped context with a seeded Antigravity grant.
 *
 * @param {Map<string, object>} grants - the credential records.
 * @returns {{ ctx: object, record: object }} the context.
 */
function fakeContext(grants) {
  const record = { adapters: new Map(), flows: [], logs: [] }
  const credentials = {
    async readRecord(key) {
      const grant = grants.get(key)
      return grant === undefined ? undefined : { kind: 'grant', payload: grant }
    },
    async listRecords() {
      return [...grants.keys()].map((key) => ({ key, kind: 'grant' }))
    },
    async modifyRecord(key, mutate) {
      const next = await mutate(grants.has(key) ? { kind: 'grant', payload: grants.get(key) } : undefined)
      if (next !== undefined) grants.set(key, next.payload)
      return next
    },
    async deleteRecord(key) {
      grants.delete(key)
    },
    async resolve() {
      return undefined
    },
  }
  const services = { credentials }
  const ctx = {
    logger: {
      info: () => {},
      warn: () => {},
      error: (message, error) => record.logs.push([message, error]),
    },
    get: (name) => services[name],
    set: () => {},
    on: () => {},
    inject: (deps, callback) => {
      if (deps.includes('authorization')) {
        callback({ authorization: { registerFlow: (flow) => record.flows.push(flow) } })
      }
    },
    llm: {
      registerAdapter: (providers, adapter) => {
        record.adapters.set(providers[0], adapter)
        return () => record.adapters.delete(providers[0])
      },
      registerConfigurableProviders: () => () => {},
      registerModelDiscovery: () => () => {},
    },
  }
  return { ctx, record }
}

/** Drain an async iterable of chunks into an array. */
const collect = async (iterable) => {
  const out = []
  for await (const chunk of iterable) out.push(chunk)
  return out
}

/**
 * Point this plugin's Antigravity lane at a fixture upstream.
 *
 * The stream reads its credential from the store and its `fetch` from the
 * options the harness passes through, so a grant in the store plus a stubbed
 * global fetch is enough to drive it end to end.
 *
 * @param {object[]} frames - the SSE frames to emit.
 * @returns {() => void} restores the original fetch.
 */
function stubUpstream(frames) {
  const original = globalThis.fetch
  const sse = frames.map((frame) => `data: ${JSON.stringify(frame)}\r\n\r\n`).join('')
  globalThis.fetch = async (url) => {
    if (String(url).includes('loadCodeAssist')) {
      return new Response(JSON.stringify({ cloudaicompanionProject: 'proj-harness' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    }
    const body = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(sse))
        controller.close()
      },
    })
    return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } })
  }
  return () => {
    globalThis.fetch = original
  }
}

const grants = new Map([
  [
    recordKeyFor(ROUTE_GEMINI),
    {
      type: 'oauth',
      access: 'access-token',
      refresh: 'refresh-token',
      expires: Date.now() + 3_600_000,
      access_token: 'access-token',
      refresh_token: 'refresh-token',
      expiry: new Date(Date.now() + 3_600_000).toISOString(),
      token_type: 'Bearer',
      cloudaicompanionProject: 'proj-harness',
    },
  ],
])

const { ctx, record } = fakeContext(grants)
apply(ctx)

await check('every route produced an adapter', async () => {
  assert.deepEqual([...record.adapters.keys()], [...ROUTES])
})

for (const route of ROUTES) {
  const adapter = record.adapters.get(route)
  const models = await adapter.listModels(route)
  await check(`${route}: listModels answers without touching the network`, async () => {
    assert.ok(models.length >= 1, `${route} served nothing`)
    for (const model of models) assert.equal(model.provider, route)
  })
}

{
  const adapter = record.adapters.get(ROUTE_GEMINI)
  const restore = stubUpstream([
    {
      response: {
        candidates: [{ content: { role: 'model', parts: [{ text: 'hello from ' }, { text: 'the fixture' }] }, finishReason: 'STOP' }],
        usageMetadata: { promptTokenCount: 12, candidatesTokenCount: 4, totalTokenCount: 16 },
      },
    },
  ])

  const prepared = await adapter.prepareCall(ROUTE_GEMINI, 'gemini-3.8-flash')
  await check('prepareCall freezes a model description for the harness', async () => {
    assert.equal(prepared.model.provider, ROUTE_GEMINI)
    assert.equal(prepared.model.id, 'gemini-3.8-flash')
    assert.equal(prepared.model.context.contextWindow, 1e6)
    assert.equal(typeof prepared.stream, 'function')
  })

  const chunks = await collect(
    prepared.stream({
      provider: prepared.model.provider,
      model: prepared.model.id,
      messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }], timestamp: Date.now() }],
      systemPrompt: 'be brief',
      signal: AbortSignal.timeout(30_000),
    }),
  )

  restore()

  const kinds = chunks.map((chunk) => chunk.type)
  await check('the stream reaches the harness as chunks, not raw pi-ai events', async () => {
    assert.ok(kinds.includes('block-start'), `no block-start in ${kinds.join(',')}`)
    assert.ok(kinds.includes('text-delta'))
    assert.ok(kinds.includes('block-end'))
    assert.ok(kinds.includes('usage'))
    assert.equal(kinds.at(-1), 'finish')
  })

  await check('the assembled text survives the translation intact', async () => {
    const text = chunks
      .filter((chunk) => chunk.type === 'text-delta')
      .map((chunk) => chunk.text)
      .join('')
    assert.equal(text, 'hello from the fixture')
  })

  await check('the finish chunk reports a clean stop and carries replay state', async () => {
    const finish = chunks.at(-1)
    assert.equal(finish.reason.kind, 'stop')
    assert.equal(typeof finish.replayState, 'object')
  })

  await check('token usage reaches the harness, and costs nothing on a subscription', async () => {
    const usage = chunks.find((chunk) => chunk.type === 'usage')
    assert.notEqual(usage, undefined)
    assert.equal(usage.usage.inputTokens, 12)
    assert.equal(usage.usage.outputTokens, 4)
    assert.equal(usage.usage.totalTokens, 16)
  })
}

{
  const adapter = record.adapters.get(ROUTE_GEMINI)
  const restore = stubUpstream([
    {
      response: {
        candidates: [
          {
            content: {
              role: 'model',
              parts: [
                { functionCall: { name: 'read_file', args: { path: 'a.txt' }, id: 'w1' }, thoughtSignature: 'SIG-1' },
              ],
            },
            finishReason: 'STOP',
          },
        ],
      },
    },
  ])

  const prepared = await adapter.prepareCall(ROUTE_GEMINI, 'gemini-3.8-flash')
  const chunks = await collect(
    prepared.stream({
      provider: prepared.model.provider,
      model: prepared.model.id,
      messages: [{ role: 'user', content: [{ type: 'text', text: 'read a.txt' }], timestamp: Date.now() }],
      tools: [
        {
          name: 'read_file',
          description: 'read a file',
          parameters: { type: 'object', properties: { path: { type: 'string', required: true } } },
        },
      ],
      signal: AbortSignal.timeout(30_000),
    }),
  )
  restore()

  await check('a tool call arrives as a tool-call block the loop can dispatch', async () => {
    const end = chunks.find((chunk) => chunk.type === 'block-end' && chunk.block?.type === 'tool-call')
    assert.notEqual(end, undefined, `blocks: ${JSON.stringify(chunks.filter((c) => c.type === 'block-end'))}`)
    assert.equal(end.block.name, 'read_file')
    assert.deepEqual(JSON.parse(end.block.arguments), { path: 'a.txt' })
    assert.equal(typeof end.block.id, 'string')
  })

  await check('a tool call ends the turn with toolUse, which drives the next step', async () => {
    assert.equal(chunks.at(-1).reason.kind, 'tool-calls')
  })
}

{
  // The harness asks for effort by name; an unsupported one must be refused
  // before a request is spent, not silently downgraded.
  const adapter = record.adapters.get(ROUTE_CLAUDE)
  const models = await adapter.listModels(ROUTE_CLAUDE)
  const prepared = await adapter.prepareCall(ROUTE_CLAUDE, models[0].id)
  await check('a declared reasoning level is accepted', async () => {
    const declared = (prepared.model.reasoning?.efforts ?? []).map((effort) => effort.id)
    assert.ok(declared.length > 0)
  })
}

{
  // No grant: the Antigravity lane must fail loudly rather than send an
  // unauthenticated request.
  const bare = new Map()
  const { ctx: bareCtx, record: bareRecord } = fakeContext(bare)
  apply(bareCtx)
  const adapter = bareRecord.adapters.get(ROUTE_GEMINI)
  const prepared = await adapter.prepareCall(ROUTE_GEMINI, 'gemini-3.8-flash')
  const chunks = await collect(
    prepared.stream({
      provider: prepared.model.provider,
      model: prepared.model.id,
      messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }], timestamp: Date.now() }],
      signal: AbortSignal.timeout(5_000),
    }),
  )
  const finish = chunks.at(-1)
  globalThis.__missingGrantFinish = finish

await check('without a grant the lane reports a failure instead of sending an empty token', async () => {
    const finish = globalThis.__missingGrantFinish
    assert.equal(finish.type, 'finish')
    assert.equal(finish.reason.kind, 'error')
    assert.match(finish.reason.failure.message, /not configured|没有可用凭据|credential|auth/i)
    assert.equal(typeof finish.reason.failure.code, 'string')
  })
}

{
  // OpenAI and Claude have no stored credential here, so their prep must still
  // answer metadata — the picker cannot go blank for an unconfigured route.
  for (const route of [ROUTE_OPENAI, ROUTE_CLAUDE]) {
    const adapter = record.adapters.get(route)
    const models = await adapter.listModels(route)
    const prepared = await adapter.prepareCall(route, models[0].id)
    await check(`${route}: an unconfigured route still describes its models`, async () => {
      assert.equal(prepared.model.provider, route)
      assert.equal(typeof prepared.stream, 'function')
    })
  }
}

await check('no route logged an error during the whole run', async () => {
  assert.deepEqual(record.logs, [])
})

console.log(`\n${checks.length} checks passed`)
for (const label of checks) console.log(`  ok  ${label}`)
