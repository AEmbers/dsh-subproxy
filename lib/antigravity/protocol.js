/**
 * The Antigravity (Gemini Code Assist / `cloudcode-pa`) wire protocol.
 *
 * This is a port of the `gemini` channel out of XD Pool's vendored channel pack
 * (`vendor/channel-pack/pack.js`, § gemini). It is re-stated here rather than
 * imported because that pack exports none of it — and because the whole point of
 * this plugin is to talk this protocol from a pi-ai provider, which the pack does
 * not do.
 *
 * Everything in this module is pure: no I/O, no globals except the tool-name
 * reverse table, which exists because the upstream constrains tool names to
 * `^[a-zA-Z0-9_-]{1,64}$` while harness tool names are dotted.
 *
 * @module dsh-subproxy/antigravity/protocol
 */
import { createHash, randomBytes } from 'node:crypto'

/* ── endpoints ─────────────────────────────────────────────────────────── */

export const ENDPOINT_DAILY = 'https://daily-cloudcode-pa.googleapis.com'
export const ENDPOINT_SANDBOX = 'https://daily-cloudcode-pa.sandbox.googleapis.com'
export const ENDPOINTS = [ENDPOINT_DAILY, ENDPOINT_SANDBOX]

export const STREAM_PATH = '/v1internal:streamGenerateContent?alt=sse'
export const FETCH_MODELS_PATH = '/v1internal:fetchAvailableModels'
export const QUOTA_PATH = '/v1internal:retrieveUserQuotaSummary'
export const LOAD_CODE_ASSIST_PATH = '/v1internal:loadCodeAssist'
export const LOAD_CODE_ASSIST_BODY = '{"metadata":{"ideType":"ANTIGRAVITY"}}'

/* ── identity ──────────────────────────────────────────────────────────── */

/**
 * The User-Agent the upstream gates on. Below hub 2.40.0 the catalog comes back
 * with 23 entries and no Gemini 4 family; at 2.40.0 it answers 26 entries
 * (10 distinct models) and everything above that answers identically.
 */
export const HUB_UA = 'antigravity/hub/2.40.0 win32/x64'
export const HUB_CLIENT_VERSION = '2.40.0'

export const IDENTITY_HEADERS = Object.freeze({
  'User-Agent': HUB_UA,
  'x-client-name': 'antigravity',
  'x-client-version': HUB_CLIENT_VERSION,
  'x-machine-id': 'cmdc-pak',
  'x-vscode-sessionid': 'proxy',
})

/* ── defaults ──────────────────────────────────────────────────────────── */

export const DEFAULT_PROJECT = 'aicode-consumers'
export const SESSION_LANE_INFER = 'infer'
export const SESSION_LANE_SMOKE = 'smoke'

export const IDLE_TIMEOUT_MS = 120_000
export const CREDITS_TIMEOUT_MS = 30_000
export const QUOTA_CACHE_TTL_MS = 60_000
export const EXPIRY_LEAD_MS = 60_000

export const UPSTREAM_FLASH = 'gemini-3.8-flash'
export const BUDGET_LOW = 1_000
export const BUDGET_MEDIUM = 4_000
export const BUDGET_HIGH = 10_000
export const BUDGET_TIERED = -1
export const CONTEXT_WINDOW = 1_000_000
export const MAX_OUTPUT_TOKENS = 64_000
export const EFFORT_IDS = ['low', 'medium', 'high', 'xhigh', 'tiered']
export const DEFAULT_EFFORT = 'medium'

/**
 * Tier ids ordered weakest → strongest, used to rank accounts and to pick a
 * sane fallback when a requested tier is not served.
 */
export const TIER_RANK = Object.freeze(
  Object.fromEntries(EFFORT_IDS.map((tier, index) => [tier, index])),
)

/**
 * Subscription tiers an account can hold, weakest → strongest.
 *
 * The upstream reports `currentTier.id` as one of these; `g1-pro-tier` /
 * `g1-ultra-lite-tier` / … live in `paidTier.id`.
 */
export const ACCOUNT_TIER_RANK = Object.freeze({
  'free-tier': 0,
  'standard-tier': 1,
  'g1-pro-tier': 2,
  'g1-ultra-lite-tier': 3,
  'g1-ultra-tier': 4,
})

/**
 * Human names for the plan ids above, for the status line.
 *
 * The upstream reports the *effective* tier in `currentTier.id`, so a paying
 * account can still read `free-tier` there; `paidTier.id` is what the user
 * recognises from the Google One page.
 */
export const ACCOUNT_PLAN_LABEL = Object.freeze({
  'free-tier': '免费',
  'standard-tier': 'Standard',
  'g1-pro-tier': 'Google AI Pro',
  'g1-ultra-lite-tier': 'Google AI Ultra',
  'g1-ultra-tier': 'Google AI Ultra',
})

/**
 * Name a `loadCodeAssist` ranking the way the user knows it.
 *
 * @param {{ tier?: string, paid?: string } | undefined} rank - the ranking.
 * @returns {string} the label, or `''` when nothing is known.
 */
export function planLabel(rank) {
  const id = rank?.paid ?? rank?.tier ?? ''
  if (id === '') return ''
  return ACCOUNT_PLAN_LABEL[id] ?? id
}

export const MAX_IMAGE_BYTES_INLINE = 10 * 1024 * 1024
export const MAX_REQUEST_BODY_BYTES = 64 * 1024 * 1024

/** Models the catalog never offers even when the upstream lists them. */
const IGNORED_PREFIXES = ['tab_', 'chat_']

/* ── alphabetic marshalling ────────────────────────────────────────────── */

/**
 * Recursively sort object keys.
 *
 * The upstream fingerprints the request body, so member order is part of the
 * wire format: the same conversation marshalled in insertion order and in
 * alphabetical order are two different requests.
 *
 * @param {unknown} value - anything JSON-shaped.
 * @returns {unknown} the same shape with sorted keys.
 */
function sortValue(value) {
  if (Array.isArray(value)) return value.map(sortValue)
  if (value === null || typeof value !== 'object') return value
  const out = {}
  for (const key of Object.keys(value).sort()) out[key] = sortValue(value[key])
  return out
}

/**
 * `JSON.stringify` with every object's keys in alphabetical order.
 *
 * @param {unknown} value - anything JSON-shaped.
 * @returns {string} the wire string.
 */
export function marshalAlphabetical(value) {
  return JSON.stringify(sortValue(value))
}

/**
 * A request id in the shape the upstream expects (`agent/<ms>/<hex>`).
 *
 * @returns {string} the request id.
 */
export function newRequestId() {
  return `agent/${Date.now()}/${randomBytes(4).toString('hex')}`
}

/**
 * Hash a conversation into the session id that groups its turns.
 *
 * FNV-1a 64 over `project \0 lane \0 first user text`; a bumped generation
 * yields a different session, which is the escape hatch for a session the
 * upstream says has overflowed.
 *
 * @param {string} project - cloudaicompanion project (or the default).
 * @param {string} firstUserText - first user text in the conversation.
 * @param {string} lane - session lane (`infer` / `smoke`).
 * @param {number} [generation] - non-zero to rotate the session id.
 * @returns {string} the session id.
 */
export function deriveSessionId(project, firstUserText, lane, generation = 0) {
  const mask = 0xffffffffffffffffn
  const prime = 0x100000001b3n
  let hash = 0xcbf29ce484222325n
  const input =
    generation > 0 ? `${project}\0${lane}\0${firstUserText}\0${generation}` : `${project}\0${lane}\0${firstUserText}`
  for (const byte of Buffer.from(input, 'utf8')) {
    hash ^= BigInt(byte)
    hash = (hash * prime) & mask
  }
  return BigInt.asIntN(64, hash).toString()
}

/* ── credential ────────────────────────────────────────────────────────── */

/**
 * Read the stored grant.
 *
 * @param {unknown} value - anything that might be a grant.
 * @returns {object} the grant (possibly empty when unusable).
 */
export function parseCredential(value) {
  if (value === null || typeof value !== 'object') return {}
  const raw = value
  if (typeof raw.access_token !== 'string' || raw.access_token === '') return {}
  const out = { access_token: raw.access_token }
  if (typeof raw.refresh_token === 'string' && raw.refresh_token !== '') out.refresh_token = raw.refresh_token
  if (typeof raw.token_type === 'string' && raw.token_type !== '') out.token_type = raw.token_type
  if (typeof raw.expires_in === 'number' && Number.isFinite(raw.expires_in)) out.expires_in = raw.expires_in
  if (typeof raw.scope === 'string' && raw.scope !== '') out.scope = raw.scope
  if (typeof raw.expiry === 'string' && raw.expiry !== '') out.expiry = raw.expiry
  if (typeof raw.sub === 'string' && raw.sub !== '') out.sub = raw.sub
  if (typeof raw.email === 'string' && raw.email !== '') out.email = raw.email
  if (typeof raw.cloudaicompanionProject === 'string' && raw.cloudaicompanionProject !== '') {
    out.cloudaicompanionProject = raw.cloudaicompanionProject
  }
  return out
}

/**
 * Millisecond expiry of a grant, or undefined when it declares none.
 *
 * @param {object} credential - the grant.
 * @returns {number | undefined} milliseconds since epoch.
 */
export function credentialExpiresAtMs(credential) {
  if (typeof credential.expiry !== 'string' || credential.expiry === '') return undefined
  const parsed = Date.parse(credential.expiry)
  return Number.isFinite(parsed) ? parsed : undefined
}

/**
 * Whether the access token is inside the refresh lead window.
 *
 * @param {object} credential - the grant.
 * @param {number} [nowMs] - now.
 * @returns {boolean} true when a refresh should happen first.
 */
export function isExpired(credential, nowMs = Date.now()) {
  const expiresAt = credentialExpiresAtMs(credential)
  if (expiresAt === undefined) return false
  return expiresAt - nowMs <= EXPIRY_LEAD_MS
}

/**
 * Whether the grant can be refreshed at all.
 *
 * @param {object} credential - the grant.
 * @returns {boolean} true when a refresh token is present.
 */
export function isRefreshable(credential) {
  return typeof credential.refresh_token === 'string' && credential.refresh_token !== ''
}

/**
 * Build the request headers for a grant.
 *
 * `Accept` is opt-in: the streaming endpoint deliberately omits it, and only a
 * catalog fetch asks for JSON.
 *
 * `extra` carries the caller's headers — in a DSH host that means the
 * attribution headers, which the harness requires on every provider request.
 * They are applied first so that the identity headers below, which the upstream
 * gates on, cannot be displaced by them.
 *
 * @param {object} credential - the grant.
 * @param {{ includeAccept?: boolean, extra?: Record<string, string | null | undefined> }} [options] - header options.
 * @returns {Headers} headers.
 */
export function headersFor(credential, options = {}) {
  const headers = new Headers()
  for (const [key, value] of Object.entries(options.extra ?? {})) {
    if (typeof value === 'string' && value !== '') headers.set(key, value)
  }
  headers.set('Authorization', `Bearer ${credential.access_token}`)
  headers.set('Content-Type', 'application/json')
  for (const [key, value] of Object.entries(IDENTITY_HEADERS)) headers.set(key, value)
  if (options.includeAccept === true) headers.set('Accept', 'application/json')
  return headers
}

/* ── schema sanitisation ───────────────────────────────────────────────── */

const SCHEMA_KEYS = new Set([
  'type',
  'format',
  'description',
  'nullable',
  'enum',
  'items',
  'minItems',
  'maxItems',
  'properties',
  'required',
  'minProperties',
  'maxProperties',
  'minLength',
  'maxLength',
  'pattern',
  'anyOf',
  'propertyOrdering',
  'minimum',
  'maximum',
])

const SCHEMA_TYPES = new Set(['string', 'number', 'integer', 'boolean', 'array', 'object', 'null'])

/**
 * Collapse a union into one concrete schema.
 *
 * Cloud Code Assist rejects `anyOf` outright — through the Anthropic
 * `input_schema` validator for Claude models, and through the proto for the
 * Gemini ones — so a union has to become a single object.
 *
 * @param {object[]} branches - already-sanitised branches.
 * @returns {object | undefined} the flattened schema.
 */
function flattenUnion(branches) {
  const list = branches.filter((branch) => branch.type !== 'null')
  const pool = list.length > 0 ? list : branches
  if (pool.length === 0) return undefined
  if (pool.length === 1) return pool[0]
  const types = [...new Set(pool.map((branch) => branch.type).filter((type) => type !== undefined))]
  if (types.length === 1 && types[0] === 'object') {
    const properties = {}
    const required = []
    let description
    for (const branch of pool) {
      if (description === undefined && branch.description !== undefined) description = branch.description
      for (const [name, child] of Object.entries(branch.properties ?? {})) {
        if (!(name in properties)) properties[name] = child
      }
      for (const name of branch.required ?? []) {
        if (!required.includes(name)) required.push(name)
      }
    }
    const merged = { type: 'object', properties }
    if (required.length > 0) merged.required = required
    if (description !== undefined) merged.description = description
    return merged
  }
  const first = pool[0]
  if (first.type === undefined) return undefined
  return first
}

/**
 * Rewrite a JSON Schema into what the upstream proto accepts.
 *
 * Two shapes are load-bearing and neither is obvious:
 * - `items` must be ONE message. A draft-07 tuple (`items: [...]`) 400s with
 *   "Proto field is not repeating, cannot start list".
 * - an array without `items` 400s, and `items: {}` does not help — proto3
 *   treats an empty message as unset — so it becomes `{ type: "string" }`.
 *
 * The harness tool DSL also uses `required: true` on a child property to mean
 * "required by the parent", which is not JSON Schema's array semantics; those
 * get promoted into the parent's `required`.
 *
 * @param {object} schema - a JSON Schema fragment.
 * @returns {object} the sanitised fragment.
 */
export function sanitizeSchema(schema) {
  const out = {}
  for (const [key, value] of Object.entries(schema)) {
    if (!SCHEMA_KEYS.has(key)) continue
    if (key === 'properties') {
      if (typeof value !== 'object' || value === null || Array.isArray(value)) continue
      const properties = {}
      const promoted = []
      for (const [name, child] of Object.entries(value)) {
        if (typeof child !== 'object' || child === null || Array.isArray(child)) continue
        if (child.required === true) promoted.push(name)
        properties[name] = sanitizeSchema(child)
      }
      out.properties = properties
      if (promoted.length > 0) {
        const required = Array.isArray(out.required) ? [...out.required] : []
        for (const name of promoted) if (!required.includes(name)) required.push(name)
        out.required = required
      }
      continue
    }
    if (key === 'items') {
      if (Array.isArray(value)) {
        const first = value.find((item) => typeof item === 'object' && item !== null && !Array.isArray(item))
        if (first !== undefined) out.items = sanitizeSchema(first)
        continue
      }
      if (typeof value === 'object' && value !== null) out.items = sanitizeSchema(value)
      continue
    }
    if (key === 'anyOf') {
      if (!Array.isArray(value)) continue
      const branches = value
        .filter((item) => typeof item === 'object' && item !== null && !Array.isArray(item))
        .map((item) => sanitizeSchema(item))
      const flat = flattenUnion(branches)
      if (flat === undefined) continue
      if (out.type === undefined && flat.type !== undefined) out.type = flat.type
      if (out.properties === undefined && flat.properties !== undefined) out.properties = flat.properties
      if (out.required === undefined && flat.required !== undefined) out.required = flat.required
      if (out.description === undefined && flat.description !== undefined) out.description = flat.description
      continue
    }
    if (key === 'type') {
      if (typeof value === 'string') {
        if (SCHEMA_TYPES.has(value)) out.type = value
        continue
      }
      if (Array.isArray(value)) {
        const types = value.filter((item) => typeof item === 'string')
        const nonNull = types.filter((item) => item !== 'null' && SCHEMA_TYPES.has(item))
        if (nonNull.length > 0) out.type = nonNull[0]
        if (nonNull.length !== types.length) out.nullable = true
      }
      continue
    }
    if (key === 'required') {
      // Merge, never assign: a schema may place `required` after `properties`,
      // and a plain assignment would wipe the promoted entries above.
      if (Array.isArray(value)) {
        const existing = Array.isArray(out.required) ? out.required : []
        const merged = [...existing]
        for (const name of value.filter((item) => typeof item === 'string')) {
          if (!merged.includes(name)) merged.push(name)
        }
        if (merged.length > 0) out.required = merged
        else delete out.required
      }
      continue
    }
    if (key === 'enum') {
      if (Array.isArray(value) && value.length > 0 && value.every((item) => typeof item === 'string')) {
        out.enum = [...value]
      }
      continue
    }
    out[key] = value
  }
  // A `properties` block with no declared type is "type: Field required" on the
  // Anthropic side of this API.
  if (out.type === undefined && out.properties !== undefined) out.type = 'object'
  if (out.type === 'array' && out.items === undefined) out.items = { type: 'string' }
  if (out.properties !== undefined && Array.isArray(out.required)) {
    const required = out.required.filter((name) => typeof name === 'string' && name in out.properties)
    if (required.length > 0) out.required = required
    else delete out.required
  }
  return out
}

/**
 * Sanitise a tool's `parameters` and give it an object shape.
 *
 * @param {object | undefined} parameters - the tool schema.
 * @returns {object} the sanitised schema.
 */
export function sanitizeParameters(parameters) {
  const schema = sanitizeSchema(parameters ?? {})
  if (schema.type === undefined) schema.type = 'object'
  if (schema.type === 'object' && schema.properties === undefined) schema.properties = {}
  return schema
}

/* ── tool names ────────────────────────────────────────────────────────── */

/**
 * The upstream (and Anthropic) reject any tool name outside
 * `^[a-zA-Z0-9_-]{1,64}$` — `ns.tool`, `tool/name` and `tool:name` all 400 with
 * "tools.0.custom.name: String should match pattern".
 */
const TOOL_NAME_RE = /^[a-zA-Z0-9_-]{1,64}$/

/** Reverse table, so a name coming back from the upstream finds its tool. */
const TOOL_NAME_BACK = new Map()

/**
 * Map a harness tool name onto a wire-legal one.
 *
 * A renamed tool gets a sha256-derived suffix so the same original always maps
 * to the same public name.
 *
 * @param {unknown} raw - the harness tool name.
 * @returns {string} the wire name.
 */
export function publicToolName(raw) {
  const name = typeof raw === 'string' ? raw : String(raw ?? '')
  if (TOOL_NAME_RE.test(name)) return name
  const normalized = name.replace(/[^a-zA-Z0-9_-]/g, '_')
  const digest = createHash('sha256').update(name).digest('hex').slice(0, 12)
  const publicName = `${normalized.slice(0, 51)}_${digest}`
  if (TOOL_NAME_BACK.size > 4_000) TOOL_NAME_BACK.clear()
  TOOL_NAME_BACK.set(publicName, name)
  return publicName
}

/**
 * Recover the harness name behind a wire name.
 *
 * @param {unknown} name - the wire name.
 * @returns {unknown} the harness name.
 */
export function restoreToolName(name) {
  if (typeof name !== 'string') return name
  return TOOL_NAME_BACK.get(name) ?? name
}

/* ── shared small helpers ──────────────────────────────────────────────── */

/**
 * Canonical JSON for a tool-call argument object.
 *
 * @param {unknown} args - the arguments.
 * @returns {string} canonical JSON.
 */
export function canonicalArgs(args) {
  if (args === undefined || args === null) return '{}'
  return marshalAlphabetical(args)
}

/**
 * Parse a tool-call argument string, tolerating garbage.
 *
 * @param {string} raw - the argument JSON.
 * @returns {Record<string, unknown>} the arguments (empty on failure).
 */
export function parseToolArguments(raw) {
  if (typeof raw !== 'string' || raw.trim() === '') return {}
  try {
    const parsed = JSON.parse(raw)
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed) ? parsed : {}
  } catch {
    return {}
  }
}

/**
 * Flatten a tool result's content blocks into one string.
 *
 * @param {Array<{ type: string, text?: string }>} blocks - content blocks.
 * @returns {string} the text.
 */
export function toolResultText(blocks) {
  const out = []
  for (const block of blocks ?? []) {
    if (block.type === 'text' || block.type === 'reasoning') out.push(block.text ?? '')
  }
  return out.join('\n')
}

/**
 * Coerce a value into a non-negative integer.
 *
 * @param {unknown} value - anything.
 * @returns {number | undefined} the integer, or undefined.
 */
function nonNegativeInt(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.trunc(value) : undefined
}

/**
 * Read the upstream's token accounting.
 *
 * @param {object | undefined} raw - `usageMetadata`.
 * @returns {object} partial usage.
 */
export function readUsage(raw) {
  if (raw === undefined || raw === null) return {}
  const out = {}
  const prompt = nonNegativeInt(raw.promptTokenCount)
  const cached = nonNegativeInt(raw.cachedContentTokenCount) ?? 0
  if (prompt !== undefined) out.inputTokens = Math.max(0, prompt - cached)
  const candidates = nonNegativeInt(raw.candidatesTokenCount)
  if (candidates !== undefined) out.outputTokens = candidates
  if (cached > 0) out.cacheReadTokens = cached
  const total = nonNegativeInt(raw.totalTokenCount)
  if (total !== undefined) out.totalTokens = total
  const thoughts = nonNegativeInt(raw.thoughtsTokenCount)
  if (thoughts !== undefined) out.reasoningTokens = thoughts
  return out
}

/**
 * Map an upstream finish reason onto this module's vocabulary.
 *
 * @param {string | undefined} reason - `candidate.finishReason`.
 * @param {number} toolCalls - how many tool calls the turn produced.
 * @returns {{ kind: 'tool-calls' | 'max-tokens' | 'stop' }} the outcome.
 */
export function mapFinish(reason, toolCalls) {
  if (toolCalls > 0) return { kind: 'tool-calls' }
  const text = typeof reason === 'string' ? reason.toUpperCase() : ''
  if (text === 'MAX_TOKENS') return { kind: 'max-tokens' }
  return { kind: 'stop' }
}

/* ── failure classification ────────────────────────────────────────────── */

/**
 * Whether the upstream is complaining about a thought signature.
 *
 * @param {string} text - the error body.
 * @returns {boolean} true when retrying without signatures can help.
 */
export function isSignatureError(text) {
  const lower = text.toLowerCase()
  if (lower.includes('signature')) return true
  return lower.includes('thought') && lower.includes('invalid')
}

/**
 * Whether an error body hints that the other endpoint might serve it.
 *
 * @param {string} text - the error body.
 * @returns {boolean} true when a endpoint switch is worth trying.
 */
export function isSwitchableText(text) {
  const lower = text.toLowerCase()
  return ['quota', 'permission', 'unsupported', 'project'].some((word) => lower.includes(word))
}

/**
 * Whether an error body is a quota rejection.
 *
 * @param {string} text - the error body.
 * @returns {boolean} true when the account is out of quota.
 */
export function isQuotaText(text) {
  const lower = text.toLowerCase()
  return ['quota', 'resource_exhausted', 'resource exhausted', 'rate limit', 'exceeded'].some((word) =>
    lower.includes(word),
  )
}

/**
 * Whether the upstream rejected the session for length.
 *
 * @param {string} text - the error body.
 * @returns {boolean} true when bumping the session generation can help.
 */
export function isSessionOverflow(text) {
  return text.toLowerCase().includes('exceeds the maximum number of tokens')
}

/**
 * What the upstream says when its own safety filter ate the request.
 *
 * It arrives as **HTTP 200 and one ordinary text part**, so the only way to tell
 * it from an answer is the wording. Every marker below is verbatim from a live
 * response; matching is case-insensitive and substring-based because the notice
 * is followed by a "learn more" link.
 */
export const FILTER_MARKERS = [
  "blocked by gemini's filters",
  'blocked by gemini',
  'request was blocked by',
  'prohibited by the usage policy',
  'violates the usage policy',
]

/**
 * Whether a text body is the upstream's filter notice rather than an answer.
 *
 * @param {string} text - the accumulated assistant text.
 * @returns {string | undefined} the marker that matched, if any.
 */
export function filterNoticeIn(text) {
  if (typeof text !== 'string' || text === '') return undefined
  const lower = text.toLowerCase()
  return FILTER_MARKERS.find((marker) => lower.includes(marker))
}

/**
 * How many trailing characters of `text` must be withheld from a live stream.
 *
 * The notice arrives as ordinary text, so keeping it off the screen means never
 * emitting a prefix that could still turn out to be one. A marker may begin
 * anywhere but only at a word boundary — "the request was blocked" counts,
 * "answer" does not end in one — so the search looks for a word start whose
 * remainder is a marker prefix and holds back only from there. Real answers
 * therefore stream on the frame they arrive; the hold is measured in characters,
 * not in frames.
 *
 * @param {string} text - the text received but not yet emitted.
 * @returns {number} how many trailing characters to keep back.
 */
export function filterHoldLength(text) {
  if (typeof text !== 'string' || text === '') return 0
  const lower = text.toLowerCase()
  const longest = Math.max(...FILTER_MARKERS.map((marker) => marker.length))
  for (let start = Math.max(0, lower.length - longest + 1); start < lower.length; start += 1) {
    const previous = start === 0 ? '' : lower[start - 1]
    if (previous !== '' && /[a-z0-9]/.test(previous)) continue
    const candidate = lower.slice(start)
    if (FILTER_MARKERS.some((marker) => marker.startsWith(candidate))) return lower.length - start
  }
  return 0
}

/**
 * Whether a 429 body is really about quota.
 *
 * It cannot be answered from here, and this function is kept only as a record of
 * that: the upstream sends a *content* rejection with the identical
 * `RESOURCE_EXHAUSTED` body a spent account gets, down to the byte. Only the
 * quota endpoint separates them — see `./quota.js` and `rejectionMessage` in
 * `./stream.js`.
 *
 * @deprecated Always true for the real bodies; use `probeQuota` instead.
 * @param {string} text - the error body.
 * @returns {boolean} true.
 */
export function isQuotaBody(text) {
  return typeof text !== 'string' || text.trim() === '' || isQuotaText(text) || text.toLowerCase().includes('resource_exhausted')
}

const TOKEN_COUNT_OVERFLOW = /\btoken\s+count\b[\s\S]{0,60}?\bexceeds?\s+the\s+maximum\b/i

/**
 * Whether the upstream rejected the request for context length.
 *
 * @param {string} text - the error body.
 * @returns {boolean} true when the conversation is too long.
 */
export function isContextOverflow(text) {
  return TOKEN_COUNT_OVERFLOW.test(text) || text.toLowerCase().includes('exceeds the maximum number of tokens')
}
