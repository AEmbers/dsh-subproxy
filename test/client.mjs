/**
 * Offline harness for `lib/client.js`: runs the bundle the way the browser's
 * module loader does, with a stand-in React, and asserts what the page does.
 *
 * This exists because the browser half has no unit-test seam of its own — it is
 * a side-effecting IIFE whose only entry point is `window.__ModuleLoader__`.
 * Running it here catches the failures that would otherwise show up as a
 * settings section that silently never appears.
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const source = readFileSync(join(here, '..', 'lib', 'client.js'), 'utf8')

let passed = 0
const check = (name, condition) => {
  if (!condition) throw new Error(`FAILED: ${name}`)
  passed += 1
  console.log(`  ok  ${name}`)
}

/* ── a React small enough to render into a tree ─────────────────────────── */

const renderNode = (node) => {
  if (node === null || node === undefined || node === false) return null
  if (typeof node === 'string' || typeof node === 'number') return { text: String(node) }
  if (Array.isArray(node)) return { children: node.map(renderNode).filter((child) => child !== null) }
  const { type, props } = node
  if (typeof type === 'function') return renderNode(type(props ?? {}))
  const children = []
  const { children: raw, ...rest } = props ?? {}
  if (raw !== undefined) {
    for (const child of Array.isArray(raw) ? raw : [raw]) {
      const rendered = renderNode(child)
      if (rendered !== null) children.push(rendered)
    }
  }
  return { tag: typeof type === 'string' ? type : String(type?.displayName ?? 'component'), props: rest, children }
}

const FLUSH = []
let hooks = []
let hookIndex = 0
let pendingEffects = []

const React = {
  createElement: (type, props, ...children) => ({ type, props: { ...(props ?? {}), children } }),
  useState(initial) {
    const index = hookIndex
    hookIndex += 1
    if (hooks[index] === undefined) hooks[index] = { value: typeof initial === 'function' ? initial() : initial }
    const cell = hooks[index]
    return [
      cell.value,
      (next) => {
        cell.value = typeof next === 'function' ? next(cell.value) : next
      },
    ]
  },
  useCallback(fn) {
    hookIndex += 1
    return fn
  },
  useEffect(fn) {
    hookIndex += 1
    pendingEffects.push(fn)
  },
}

/* ── the host the bundle is loaded into ─────────────────────────────────── */

// Captured before the global patch below, or the wrappers call themselves.
const nativeSetTimeout = globalThis.setTimeout
const nativeSetInterval = globalThis.setInterval
const nativeClearTimeout = globalThis.clearTimeout
const nativeClearInterval = globalThis.clearInterval

const registrations = []
const styles = []
const openHandles = []
let confirmAnswer = true
let fetchImpl = async () => ({ ok: true, status: 200, json: async () => ({}) })

const host = {
  setTimeout: (fn, ms) => {
    const handle = nativeSetTimeout(fn, ms)
    openHandles.push(handle)
    return handle
  },
  setInterval: (fn, ms) => {
    const handle = nativeSetInterval(fn, ms)
    openHandles.push(handle)
    return handle
  },
  clearTimeout: (handle) => nativeClearTimeout(handle),
  clearInterval: (handle) => nativeClearInterval(handle),
}

const windowObject = {
  __ModuleLoader__: { load: (registration) => registrations.push(registration) },
  confirm: () => confirmAnswer,
}

const documentObject = {
  createElement: (tag) => ({ tag, dataset: {}, remove() {}, textContent: '' }),
  head: { append() {} },
  querySelector: () => null,
  body: {},
}

globalThis.window = windowObject
globalThis.document = documentObject
globalThis.fetch = (...args) => fetchImpl(...args)

// The React a bundle resolves through the platform seed.
const requireSeed = (specifier) => {
  if (specifier === 'react') return { default: React, ...React }
  throw new Error(`unexpected seed module "${specifier}"`)
}

// Evaluate the bundle the way the loader does: one factory call, exports back.
// The bundle closes over these names, so they are passed in rather than read
// from globals — that is the same shadowing the browser wrapper provides.
new Function(
  'window',
  'document',
  'fetch',
  'console',
  'setTimeout',
  'setInterval',
  'clearTimeout',
  'clearInterval',
  'require',
  'module',
  'exports',
  source,
)(
  windowObject,
  documentObject,
  globalThis.fetch,
  console,
  host.setTimeout,
  host.setInterval,
  host.clearTimeout,
  host.clearInterval,
  requireSeed,
  undefined,
  undefined,
)

check('the bundle registers itself with the module loader', registrations.length === 1)
check('the registration carries the plugin id', registrations[0].id === 'dsh-subproxy')

const exported = registrations[0].factory(requireSeed)
check('the factory returns the module face', typeof exported === 'object' && exported !== null)
check('the face exports apply', typeof exported.apply === 'function')
check('the face declares the slots service it needs', Array.isArray(exported.inject) && exported.inject.includes('slots'))

/* ── mounting ───────────────────────────────────────────────────────────── */

const slotCalls = []
const effects = []
const ctx = {
  get: (name) => (name === 'styles' ? { insert: (css) => {
    styles.push(css)
    return () => {}
  } } : undefined),
  effect: (fn, label) => {
    effects.push([label, fn])
    const dispose = fn()
    return () => dispose?.()
  },
  slots: {
    inject: (name, register) => {
      slotCalls.push({ kind: 'inject', name })
      return register()
    },
    register: (options, component) => {
      slotCalls.push({ kind: 'register', options, component })
      return () => {}
    },
  },
}

exported.apply(ctx)

check('styles are inserted once', styles.length === 1 && styles[0].includes('.spx-card'))
const injected = slotCalls.filter((call) => call.kind === 'inject')
check('the section is declared through slots.inject', injected.length === 1 && injected[0].name === 'settings.section')
const registered = slotCalls.filter((call) => call.kind === 'register')
check('exactly one section is registered', registered.length === 1)
check('the section carries a name, an id and an order', registered[0].options.name === 'settings.section' && registered[0].options.id === 'subproxy' && typeof registered[0].options.order === 'number')
check('the section label is a function, so it can re-register on locale change', typeof registered[0].options.label === 'function')
check('the registered component is a function', typeof registered[0].component === 'function')

/* ── rendering ──────────────────────────────────────────────────────────── */

const Card = registered[0].component
hooks = []
hookIndex = 0
pendingEffects = []

const payload = {
  routes: [
    { route: 'sub-gpt', name: 'OpenAI', signedIn: false, expired: false, refreshable: false, identity: '', plan: '', models: 9, hidden: 0, supportsDeviceCode: true },
    { route: 'sub-claude', name: 'Claude', signedIn: true, expired: false, refreshable: true, identity: 'email:a@b.c', plan: '', models: 17, hidden: 0, supportsDeviceCode: false },
    {
      route: 'sub-gemini',
      name: 'Antigravity',
      signedIn: true,
      expired: false,
      refreshable: true,
      identity: 'email:lilin0697@gmail.com',
      plan: 'Google AI Ultra',
      models: 12,
      hidden: 11,
      supportsDeviceCode: false,
      fallback: false,
    },
  ],
  pending: [
    {
      route: 'sub-claude',
      awaitingCode: true,
      notices: [
        { kind: 'auth_url', message: '在浏览器里完成登录', url: 'https://example.invalid/authorize?x=1' },
        { kind: 'device_code', message: '设备码', code: 'ABCD-EFGH' },
      ],
      text: '',
    },
  ],
}

fetchImpl = async (url, init) => {
  const body = init?.body === undefined ? undefined : JSON.parse(init.body)
  return {
    ok: true,
    status: 200,
    json: async () => {
      if (init?.method === 'POST' && body?.action === 'login') {
        return { ok: true, text: '已开始登录', routes: payload.routes, pending: payload.pending }
      }
      return payload
    },
  }
}

const collect = (node, predicate, out = []) => {
  if (node === null || node === undefined) return out
  if (predicate(node)) out.push(node)
  for (const child of node.children ?? []) collect(child, predicate, out)
  return out
}

const flatten = (node, out = []) => {
  if (node === null || node === undefined) return out
  if (node.text !== undefined) out.push(node.text)
  for (const child of node.children ?? []) flatten(child, out)
  return out
}

const tree = Card({ close() {} })
check('the page renders a card wrapper', tree.type === 'div' && tree.props.className === 'spx-wrap')

// Effects run after the first paint, so the initial tree is the loading state.
check(
  'the first paint is the loading state',
  flatten(renderNode(tree)).some((line) => line === '正在读取路由…'),
)

// Flush the fetch the mount effect started.
await Promise.all(pendingEffects.map((effect) => effect()))
await new Promise((resolve) => setTimeout(resolve, 0))
await new Promise((resolve) => setTimeout(resolve, 0))

// The mount effect has to settle before the page has anything to draw: state
// lives in the hook cells above, so only the cursor resets, never the cells.
process.on('unhandledRejection', (error) => {
  console.error('unhandled rejection', error)
  process.exitCode = 1
})

await new Promise((resolve) => nativeSetTimeout(resolve, 20))
hookIndex = 0
pendingEffects = []
const painted = renderNode(Card({ close() {} }))
const cards = collect(painted, (node) => node.props?.className === 'spx-card')
check('one card per route', cards.length === 3)
check('a signed-out route is marked off', cards[0].props['data-state'] === 'off')
check('a route with a sign-in in flight is marked pending', cards[1].props['data-state'] === 'pending')
check('a signed-in route is marked on', cards[2].props['data-state'] === 'on')

const joined = flatten(painted).join(' ')
const lines = flatten(painted)
check('the plan name reaches the page', joined.includes('Google AI Ultra'))
check('the identity reaches the page', joined.includes('lilin0697@gmail.com'))
check('hidden models are explained, not just counted', joined.includes('11'))
check('the authorization URL is rendered as a link', lines.includes('https://example.invalid/authorize?x=1'))
check('the device code is rendered on its own', lines.includes('ABCD-EFGH'))
check('a device-code sign-in does not tell the user to paste', joined.includes('这边不用粘贴'))

// The same card without a device code must warn about the localhost callback
// instead, because that path really does end in a pasted URL.
payload.pending[0].notices = [
  { kind: 'auth_url', message: '在浏览器里完成登录', url: 'https://example.invalid/authorize?x=1' },
]
await new Promise((resolve) => nativeSetTimeout(resolve, 20))
hookIndex = 0
pendingEffects = []
const browserOnly = flatten(renderNode(Card({ close() {} }))).join(' ')
check('a browser-only sign-in explains the paste step', browserOnly.includes('粘到下面'))
check('a browser-only sign-in claims nothing about device codes', browserOnly.includes('这边不用粘贴') === false)

/* ── backing out ────────────────────────────────────────────────────────── */

check('the styles disposer is registered as an effect', effects.some(([label]) => String(label).includes('styles')))
for (const handle of openHandles) clearInterval(handle)

console.log(`\n${passed} checks passed`)
