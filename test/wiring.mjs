/**
 * Offline exercise of the plugin's wiring.
 *
 * Boots a fake cordis context (no host, no network, no real credential store),
 * runs `apply()`, and asserts what the host would see: three adapters on three
 * distinct routes, each answering with a model catalog, each offering a sign-in
 * flow, and a route collision that costs only itself.
 *
 * `node test/wiring.mjs`
 *
 * @module dsh-subproxy/test/wiring
 */
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { apply, inject, name } from '../lib/index.js'
import { ROUTES, ROUTE_CLAUDE, ROUTE_GEMINI, ROUTE_OPENAI, ROUTE_NAMES, RECORD_SCOPE } from '../lib/constants.js'
import { preferAccount } from '../lib/antigravity/account.js'
import { watchStore } from '../lib/store-watch.js'

// `apply()` starts a watcher on the harness credential store. Point that at a
// scratch directory so this suite never touches the real one — and so a login
// happening on this machine cannot perturb the run.
const scratch = mkdtempSync(join(tmpdir(), 'subproxy-wiring-'))
process.env.DSH_CREDENTIALS_FILE = join(scratch, '.credentials.yaml')
writeFileSync(process.env.DSH_CREDENTIALS_FILE, 'records: []\nrefs:\n')

const checks = []
const check = async (label, body) => {
  await body()
  checks.push(label)
}

/**
 * Wait a bounded moment for a filesystem event to land.
 *
 * Deliberately ref'd: everything the watcher schedules is `unref`'d so a host can
 * shut down cleanly, which means only this timer keeps the loop alive long enough
 * for the event to arrive.
 *
 * @param {number} ms - the budget.
 * @returns {Promise<void>} resolves after the budget.
 */
const settle = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * A cordis-shaped context that records everything the plugin does.
 *
 * @param {{ grants?: Map<string, object> }} [options] - pre-seeded credentials.
 * @returns {object} the context plus its recording.
 */
function fakeContext(options = {}) {
  const record = { providers: [], adapters: new Map(), flows: [], commands: [], disposed: [], logs: [] }
  const grants = options.grants ?? new Map()

  const credentials = {
    async readRecord(key) {
      const grant = grants.get(key)
      return grant === undefined ? undefined : { kind: 'grant', payload: grant }
    },
    async listRecords() {
      return [...grants.keys()].map((key) => ({ key, kind: 'grant' }))
    },
    async modifyRecord(key, mutate) {
      const current = grants.get(key)
      const next = await mutate(current === undefined ? undefined : { kind: 'grant', payload: current })
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
      info: (message) => record.logs.push(['info', message]),
      warn: (message, error) => record.logs.push(['warn', message, error]),
      error: (message, error) => record.logs.push(['error', message, error]),
    },
    get: (service) => services[service],
    set: (key, value) => {
      record[key] = value
    },
    on: (event, handler) => {
      if (event === 'dispose') record.disposed.push(handler)
    },
    inject: (deps, callback) => {
      if (deps.includes('authorization')) {
        callback({ authorization: { registerFlow: (flow) => record.flows.push(flow) } })
      }
      if (deps.includes('commands')) {
        callback({ commands: { register: (definition) => record.commands.push(definition) } })
      }
    },
    llm: {
      registerAdapter: (providers, adapter) => {
        for (const provider of providers) {
          assert.equal(record.adapters.has(provider), false, `route ${provider} registered twice`)
          record.adapters.set(provider, adapter)
          record.providers.push(provider)
        }
        return () => {
          for (const provider of providers) record.adapters.delete(provider)
        }
      },
      registerConfigurableProviders: () => () => {},
      registerModelDiscovery: () => () => {},
    },
  }

  return { ctx, record, grants }
}

await check('the plugin declares its name and injected services', async () => {
  assert.equal(name, 'subproxy')
  assert.deepEqual(inject, ['llm'])
})

{
  const { ctx, record, grants } = fakeContext()
  apply(ctx)

  await check('all three routes are registered', async () => {
    assert.deepEqual(record.providers, [...ROUTES])
  })

  await check('provider info carries the route id and its human name', async () => {
    for (const route of ROUTES) {
      const info = record.adapters.get(route).providerInfo(route)
      assert.equal(info.id, route)
      assert.equal(info.name, ROUTE_NAMES[route])
    }
  })

  await check('the routes are namespaced so they cannot collide with the host', async () => {
    assert.equal(new Set(ROUTES).size, 3)
    for (const route of ROUTES) assert.match(route, /^sub-/)
  })

  await check('the OpenAI lane advertises the Codex catalog', async () => {
    const models = await record.adapters.get(ROUTE_OPENAI).listModels(ROUTE_OPENAI)
    assert.ok(models.length >= 5, `expected several models, got ${models.length}`)
    for (const model of models) assert.equal(model.provider, ROUTE_OPENAI)
  })

  await check('the Claude lane advertises the Anthropic catalog', async () => {
    const models = await record.adapters.get(ROUTE_CLAUDE).listModels(ROUTE_CLAUDE)
    assert.ok(models.length >= 5, `expected several models, got ${models.length}`)
    for (const model of models) assert.equal(model.provider, ROUTE_CLAUDE)
  })

  await check('the Antigravity lane advertises a model before any catalog fetch', async () => {
    const models = await record.adapters.get(ROUTE_GEMINI).listModels(ROUTE_GEMINI)
    assert.ok(models.length >= 1)
    const flash = models.find((model) => model.id === 'gemini-3.8-flash')
    assert.notEqual(flash, undefined)
    assert.deepEqual(flash.inputModalities, ['text', 'image'])
  })

  await check('the Antigravity model declares the reasoning tiers its upstream serves', async () => {
    const info = await record.adapters.get(ROUTE_GEMINI).resolveModel(ROUTE_GEMINI, 'gemini-3.8-flash')
    assert.equal(info.context.contextWindow, 1_048_576)
    const efforts = (info.reasoning?.efforts ?? []).map((effort) => effort.id)
    // `gemini-3.8-flash` serves low/medium/high/tiered; `xhigh` is a real tier but
    // only Gemini 4 Hydrogen serves it, so it must be hidden rather than offered
    // and then silently downgraded.
    assert.deepEqual(efforts, ['off', 'minimal', 'low', 'medium', 'high', 'max'])
  })

  await check('a tier the model does not serve is hidden, not silently downgraded', async () => {
    const entries = [
      { id: 'gemini-4-hydrogen', effortOptions: ['low', 'medium', 'high', 'xhigh'], defaultEffort: 'medium' },
      { id: 'gemini-2.5-pro', contextWindow: 1_000_000, maxTokens: 64_000, supportsImage: true },
    ]
    const { thinkingLevelMap } = await import('../lib/antigravity/stream.js')
    assert.deepEqual(Object.keys(thinkingLevelMap(entries[0].effortOptions)), [
      'off',
      'minimal',
      'low',
      'medium',
      'high',
      'xhigh',
      'max',
    ])
    assert.equal(thinkingLevelMap(entries[0].effortOptions).xhigh, 'xhigh')
    // A model with no tier ladder at all still answers `off`; every other level
    // has to be explicitly nulled because pi-ai reads a missing key as supported.
    const flat = thinkingLevelMap(undefined)
    assert.equal(flat.off, 'off')
    assert.equal(flat.high, null)
  })

  await check('the Claude model keeps its real context window', async () => {
    const models = await record.adapters.get(ROUTE_CLAUDE).listModels(ROUTE_CLAUDE)
    const info = await record.adapters.get(ROUTE_CLAUDE).resolveModel(ROUTE_CLAUDE, models[0].id)
    assert.ok(info.context.contextWindow > 0)
  })

  await check('an unlisted model is rejected without crashing the adapter', async () => {
    await assert.rejects(
      () => record.adapters.get(ROUTE_CLAUDE).resolveModel(ROUTE_CLAUDE, 'definitely-not-a-model'),
      (error) => error.code === 'UNKNOWN_MODEL' || /no configured model/.test(error.message),
    )
  })

  await check('a route the adapter does not own is rejected', async () => {
    await assert.rejects(
      () => record.adapters.get(ROUTE_OPENAI).resolveModel(ROUTE_CLAUDE, 'x'),
      (error) => error.code === 'NO_ADAPTER' || /does not own provider/.test(error.message),
    )
  })

  await check('three sign-in flows are offered, one per route', async () => {
    assert.deepEqual(
      record.flows.map((flow) => flow.key),
      ROUTES.map((route) => `${RECORD_SCOPE}/${route}`),
    )
    for (const flow of record.flows) {
      assert.equal(flow.methods.length, 1)
      assert.equal(flow.methods[0].id, 'oauth')
      assert.equal(typeof flow.run, 'function')
    }
  })

  await check('the sign-in command is offered on every surface', async () => {
    assert.equal(record.commands.length, 1)
    const [command] = record.commands
    assert.equal(command.name, 'subproxy')
    assert.equal(typeof command.handler, 'function')
    assert.ok(typeof command.description === 'string' && command.description !== '')
    for (const route of ROUTES) assert.ok(command.input.hint.includes(route), `${route} missing from the hint`)
  })

  await check('the command reports each route as signed out without a grant', async () => {
    const result = await record.commands[0].handler({ agent: {}, rawInput: 'status', attachments: [] })
    assert.equal(result.kind, 'success')
    for (const route of ROUTES) assert.ok(result.text.includes(route), `${route} missing from the report`)
    assert.ok(result.text.includes('未登录'))
  })

  await check('the command rejects an unknown verb and a missing route', async () => {
    const handler = record.commands[0].handler
    const bad = await handler({ agent: {}, rawInput: 'nope', attachments: [] })
    assert.equal(bad.kind, 'error')
    const noRoute = await handler({ agent: {}, rawInput: 'login', attachments: [] })
    assert.equal(noRoute.kind, 'error')
    assert.ok(noRoute.text.includes('sub-gpt'))
  })

  await check('the command clears a stored grant on logout', async () => {
    const handler = record.commands[0].handler
    grants.set(`${RECORD_SCOPE}/${ROUTE_CLAUDE}`, { type: 'oauth', access: 'a', refresh: 'r', expires: Date.now() + 3_600_000 })
    const before = await handler({ agent: {}, rawInput: 'status', attachments: [] })
    assert.ok(before.text.includes('已登录'), 'the seeded grant was not visible to status')
    const out = await handler({ agent: {}, rawInput: `logout ${ROUTE_CLAUDE}`, attachments: [] })
    assert.equal(out.kind, 'success')
    assert.equal(grants.has(`${RECORD_SCOPE}/${ROUTE_CLAUDE}`), false)
    const after = await handler({ agent: {}, rawInput: 'status', attachments: [] })
    assert.ok(after.text.includes('未登录'))
  })

  await check('a pasted code with no login in flight is refused, not swallowed', async () => {
    const out = await record.commands[0].handler({
      agent: {},
      rawInput: 'code http://localhost/?code=abc&state=def',
      attachments: [],
    })
    assert.equal(out.kind, 'error')
    assert.ok(out.text.includes('subproxy login'), 'the error must point at the command that starts a login')
  })

  await check('a device-code login is refused for a route that has no such method', async () => {
    const handler = record.commands[0].handler
    for (const route of [ROUTE_GEMINI, ROUTE_CLAUDE]) {
      const out = await handler({ agent: {}, rawInput: `login ${route} device`, attachments: [] })
      assert.equal(out.kind, 'error', `${route} must not silently fall back to browser login`)
      assert.ok(out.text.includes(`login ${route}`), `the error must name the command that does work for ${route}`)
    }
  })

  await check('startup reports the routes and logs no error without a grant', async () => {
    assert.deepEqual(
      record.logs.filter(([level]) => level === 'error'),
      [],
    )
    assert.ok(record.logs.some(([, message]) => message.includes('已注册 3 条订阅反代路由')))
  })

  await check('disposing releases every route', async () => {
    for (const handler of record.disposed) handler()
    assert.equal(record.adapters.size, 0)
  })
}

{
  // A host that already claims one route: the other two must still register.
  const { ctx, record } = fakeContext()
  const original = ctx.llm.registerAdapter
  ctx.llm.registerAdapter = (providers, adapter) => {
    if (providers.includes(ROUTE_OPENAI)) {
      const error = new Error('route already registered')
      error.code = 'DUPLICATE_ADAPTER'
      throw error
    }
    return original(providers, adapter)
  }
  apply(ctx)
  await check('a route collision costs that route alone', async () => {
    assert.deepEqual(record.providers, [ROUTE_CLAUDE, ROUTE_GEMINI])
    assert.ok(record.logs.some(([level, message]) => level === 'error' && message.includes(ROUTE_OPENAI)))
  })
}

await check('adoption takes the strongest account when nothing is signed in', async () => {
  const candidates = [
    { name: 'ULTRA', rank: 3, tier: 'free-tier', grant: { refresh_token: 'r-ultra' } },
    { name: 'PRO', rank: 2, tier: 'free-tier', grant: { refresh_token: 'r-pro' } },
  ]
  assert.equal(preferAccount(undefined, candidates), candidates[0])
  assert.equal(preferAccount(undefined, []), undefined)
})

await check('an account signed in by hand is never taken away', async () => {
  const candidates = [{ name: 'ULTRA', rank: 3, tier: 'free-tier', grant: { refresh_token: 'r-ultra' } }]
  assert.equal(preferAccount({ rank: 1, explicit: true, refresh: 'r-mine' }, candidates), undefined)
})

await check('the account already in use is not re-adopted on every store write', async () => {
  // Without this the watcher would rewrite the record on every token refresh,
  // and each rewrite wakes the watcher again.
  const candidates = [{ name: 'ULTRA', rank: 3, tier: 'free-tier', grant: { refresh_token: 'r-same' } }]
  assert.equal(preferAccount({ rank: 3, refresh: 'r-same' }, candidates), undefined)
})

await check('only a strictly better plan displaces the account in use', async () => {
  const ranked = (rank) => [{ name: `A${rank}`, rank, tier: 'free-tier', grant: { refresh_token: `r-${rank}` } }]
  assert.equal(preferAccount({ rank: 2, refresh: 'r-mine' }, ranked(2)), undefined)
  assert.equal(preferAccount({ rank: 2, refresh: 'r-mine' }, ranked(1)), undefined)
  assert.equal(preferAccount({ rank: 2, refresh: 'r-mine' }, ranked(3)).rank, 3)
  // A current account whose rank could not be read ranks as zero, so any live
  // candidate beats it — being stuck on an unprobeable grant is worse.
  assert.equal(preferAccount({ refresh: 'r-mine' }, ranked(1)).rank, 1)
})

await check('a write to the credential store wakes the watcher, and disposing stops it', async () => {
  const store = join(scratch, 'watched', '.credentials.yaml')
  mkdirSync(join(scratch, 'watched'), { recursive: true })
  writeFileSync(store, 'refs:\n')
  const hits = []
  const stop = watchStore(() => hits.push(Date.now()), { path: store, debounceMs: 20 })
  await settle(120)
  writeFileSync(store, 'refs:\n  NEW_ACCOUNT: x\n')
  await settle(400)
  const woke = hits.length
  assert.ok(woke >= 1, 'a rewritten store did not wake the watcher')
  stop()
  stop() // idempotent
  writeFileSync(store, 'refs:\n  NEWER_ACCOUNT: y\n')
  await settle(400)
  assert.equal(hits.length, woke, 'the watcher fired after it was disposed')
})

await check('a store file whose directory does not exist yet is not fatal', async () => {
  // A fresh install has no `~/.dsh` — mounting must still succeed, with the
  // watch simply not armed yet.
  const missing = join(scratch, 'not-there-yet', '.credentials.yaml')
  const stop = watchStore(() => {}, { path: missing, debounceMs: 20 })
  assert.equal(typeof stop, 'function')
  stop()
})

console.log(`\n${checks.length} checks passed`)
for (const label of checks) console.log(`  ok  ${label}`)
