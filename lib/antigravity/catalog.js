/**
 * The Antigravity model catalog.
 *
 * The upstream publishes one id per *tier* (`gemini-4-carbon-low`, `-medium`,
 * `-high`) and the picker shows one row per base model with the tiers folded into
 * `reasoning`, so this module merges them and keeps the lookup the request
 * builder uses to decide which id to actually send.
 *
 * Two things here are load-bearing for "the picker looks like the official
 * client":
 *
 * 1. **The catalog is account-scoped, not client-scoped.** A `free-tier` grant is
 *    served 22 rows (three `disabled`), an Ultra grant 33 with the whole Gemini 4
 *    family and Claude Opus/Sonnet 5.5. Which grant this plugin holds decides
 *    almost the entire list, so `./account.js` exists to adopt the strongest
 *    Google account already on the machine.
 * 2. **`agentModelSorts` is the order the official client renders.** Sorting
 *    alphabetically instead is what made a 20-model catalog look like a random
 *    subset.
 *
 * @module dsh-subproxy/antigravity/catalog
 */
import {
  CREDITS_TIMEOUT_MS,
  CONTEXT_WINDOW,
  DEFAULT_EFFORT,
  EFFORT_IDS,
  ENDPOINTS,
  FETCH_MODELS_PATH,
  MAX_OUTPUT_TOKENS,
  headersFor,
} from './protocol.js'

/** How long a fetched catalog is reused before another fetch. */
export const CATALOG_TTL_MS = 600_000

/** Entries offered before any catalog has ever been fetched. */
export const FALLBACK_MODELS = Object.freeze([
  {
    id: 'gemini-4-carbon',
    name: 'Gemini 4 Carbon',
    contextWindow: 1_048_576,
    maxTokens: 262_144,
    supportsImage: true,
    effortOptions: ['low', 'medium', 'high'],
    defaultEffort: 'medium',
  },
  {
    id: 'gemini-4-argon',
    name: 'Gemini 4 Argon',
    contextWindow: 1_048_576,
    maxTokens: 262_144,
    supportsImage: true,
    effortOptions: ['low', 'medium', 'high'],
    defaultEffort: 'medium',
  },
  {
    id: 'gemini-4-hydrogen',
    name: 'Gemini 4 Hydrogen',
    contextWindow: 1_048_576,
    maxTokens: 262_144,
    supportsImage: true,
    effortOptions: ['low', 'medium', 'high', 'xhigh'],
    defaultEffort: 'medium',
  },
  {
    id: 'gemini-3.8-flash',
    name: 'Gemini 3.8 Flash',
    contextWindow: 1_048_576,
    maxTokens: 65_536,
    supportsImage: true,
    effortOptions: ['low', 'medium', 'high', 'tiered'],
    defaultEffort: 'high',
  },
  {
    id: 'claude-opus-5-5',
    name: 'Claude Opus 5.5',
    contextWindow: 250_000,
    maxTokens: 64_000,
    supportsImage: true,
    effortOptions: ['low', 'medium', 'high'],
    defaultEffort: 'medium',
  },
  {
    id: 'claude-sonnet-5-5',
    name: 'Claude Sonnet 5.5',
    contextWindow: 250_000,
    maxTokens: 64_000,
    supportsImage: true,
    effortOptions: ['low', 'medium', 'high'],
    defaultEffort: 'medium',
  },
  {
    id: 'gpt-oss-120b',
    name: 'GPT-OSS 120B',
    contextWindow: 131_072,
    maxTokens: 32_768,
    supportsImage: false,
  },
  {
    id: 'gemini-2.5-pro',
    name: 'Gemini 2.5 Pro',
    contextWindow: CONTEXT_WINDOW,
    maxTokens: MAX_OUTPUT_TOKENS,
    supportsImage: true,
  },
  {
    id: 'gemini-3.5-flash-lite',
    name: 'Gemini 3.5 Flash Lite',
    contextWindow: CONTEXT_WINDOW,
    maxTokens: MAX_OUTPUT_TOKENS,
    supportsImage: true,
  },
])

/**
 * The tier suffix a catalog id carries, if any.
 *
 * Checked longest-first so `xhigh` is never read as the tail of another tier.
 *
 * @param {string} id - the catalog id.
 * @returns {string | undefined} the tier.
 */
function tierOfId(id) {
  for (const tier of [...EFFORT_IDS].sort((left, right) => right.length - left.length)) {
    if (id.endsWith(`-${tier}`)) return tier
  }
  return undefined
}

/**
 * Strip the tier suffix off a catalog id.
 *
 * The free tier also suffixes whole families with `-disabled`
 * (`gemini-4-carbon-disabled`), which is a flag rather than a tier — dropping it
 * keeps one base id stable across plans, so a model hidden on a free account
 * reappears under the same name once the account upgrades.
 *
 * @param {string} id - the catalog id.
 * @returns {string} the base id.
 */
function baseOfId(id) {
  const bare = id.endsWith('-disabled') ? id.slice(0, -'-disabled'.length) : id
  const tier = tierOfId(bare)
  return tier === undefined ? bare : bare.slice(0, bare.length - tier.length - 1)
}

/**
 * Strip the tier parenthetical the upstream puts in display names
 * (`Claude Opus 5.5 (High)`).
 *
 * @param {string} name - the display name.
 * @returns {string} the cleaned name.
 */
function cleanName(name) {
  return String(name)
    .replace(/\s*\((?:low|medium|high|xhigh|tiered|adaptive)\)\s*$/iu, '')
    .trim()
}

/**
 * Turn a base id into a human title.
 *
 * @param {string} base - the base id.
 * @returns {string} the title.
 */
function titleOf(base) {
  return base
    .split(/[-_]/u)
    .filter((part) => part !== '')
    .map((part) => {
      // Keep version segments (`3.8`, `5.5`, `120b`) lower-cased; capitalise words.
      if (/^[0-9]/u.test(part)) return part
      return part[0].toUpperCase() + part.slice(1)
    })
    .join(' ')
}

/**
 * Whether a catalog row must stay out of the picker (internal tab/chat models).
 *
 * @param {unknown} id - the catalog id.
 * @param {unknown} meta - its metadata.
 * @returns {boolean} true when the row is internal.
 */
function ignored(id, meta) {
  if (typeof id !== 'string' || id === '') return true
  if (id.startsWith('tab_') || id.startsWith('chat_')) return true
  if (meta !== undefined && meta !== null && meta.apiProvider === 'API_PROVIDER_INTERNAL') return true
  return false
}

/**
 * The order the upstream's own model picker renders, as base id → rank.
 *
 * `agentModelSorts[].groups[].modelIds` is the literal order the official client
 * lists; anything the groups do not mention sorts after them.
 *
 * @param {unknown} sorts - `payload.agentModelSorts`.
 * @returns {Map<string, number>} base id → rank.
 */
function sortOrder(sorts) {
  const order = new Map()
  if (!Array.isArray(sorts)) return order
  let rank = 0
  for (const sort of sorts) {
    if (sort === null || typeof sort !== 'object' || !Array.isArray(sort.groups)) continue
    for (const group of sort.groups) {
      if (group === null || typeof group !== 'object' || !Array.isArray(group.modelIds)) continue
      for (const id of group.modelIds) {
        if (typeof id !== 'string' || id === '') continue
        const base = baseOfId(id)
        if (order.has(base) === false) order.set(base, rank)
        rank += 1
      }
    }
  }
  return order
}

/**
 * Ids the upstream itself points at (default agent model, tiered lanes, …).
 *
 * @param {object} payload - the reply.
 * @returns {Set<string>} the preferred ids.
 */
function preferredIds(payload) {
  const preferred = new Set()
  const remember = (value) => {
    if (typeof value === 'string' && value !== '') preferred.add(value)
  }
  remember(payload.defaultAgentModelId)
  for (const list of [
    payload.commandModelIds,
    payload.mqueryModelIds,
    payload.webSearchModelIds,
    payload.imageGenerationModelIds,
    payload.audioTranscriptionModelIds,
    payload.commitMessageModelIds,
  ]) {
    if (Array.isArray(list)) list.forEach(remember)
  }
  const tiered = payload.tieredModelIds
  if (tiered !== undefined && tiered !== null && typeof tiered === 'object') {
    for (const list of Object.values(tiered)) if (Array.isArray(list)) list.forEach(remember)
  }
  return preferred
}

/**
 * Parse a `fetchAvailableModels` reply into one entry per base model.
 *
 * Rows that differ only by tier become one entry whose `effortOptions` lists the
 * tiers the upstream actually serves — that list is what the request builder
 * validates a requested reasoning effort against, and what the picker renders as
 * the reasoning control.
 *
 * @param {unknown} payload - the reply.
 * @returns {object[]} the catalog entries, in the upstream's own order.
 */
export function parseAvailableModels(payload) {
  if (typeof payload !== 'object' || payload === null) return []
  const raw = payload.models
  if (typeof raw !== 'object' || raw === null) return []

  const preferred = preferredIds(payload)
  const order = sortOrder(payload.agentModelSorts)

  const byBase = new Map()
  for (const [id, meta] of Object.entries(raw)) {
    if (ignored(id, meta)) continue
    const tier = tierOfId(id)
    const base = baseOfId(id)
    let entry = byBase.get(base)
    if (entry === undefined) {
      entry = {
        id: base,
        title: '',
        contextWindow:
          typeof meta?.maxTokens === 'number' && meta.maxTokens > 0 ? meta.maxTokens : CONTEXT_WINDOW,
        maxTokens:
          typeof meta?.maxOutputTokens === 'number' && meta.maxOutputTokens > 0
            ? meta.maxOutputTokens
            : MAX_OUTPUT_TOKENS,
        supportsImage: meta?.supportsImages === true,
        tiers: new Set(),
        preferred: false,
        disabled: true,
        notice: undefined,
        order: order.get(base),
      }
      byBase.set(base, entry)
    }
    if (tier !== undefined) entry.tiers.add(tier)
    if (preferred.has(id)) entry.preferred = true
    // A model is offered as long as *one* of its tiers is; the free tier marks
    // every Gemini 4 tier `disabled`, the Ultra tier marks none.
    if (meta?.disabled !== true) entry.disabled = false
    if (entry.notice === undefined && typeof meta?.tagDescription === 'string' && meta.tagDescription !== '') {
      entry.notice = cleanName(meta.tagDescription.split(/[.。]/u)[0])
    }
    if (
      entry.title === '' &&
      typeof meta?.displayName === 'string' &&
      meta.displayName.trim() !== ''
    ) {
      entry.title = cleanName(meta.displayName)
    }
  }

  const entries = []
  for (const entry of byBase.values()) {
    const ordered = EFFORT_IDS.filter((tier) => entry.tiers.has(tier))
    // `medium` when the model serves it; otherwise the same *position* in its own
    // ladder, so a low/high/xhigh model defaults to high rather than to whichever
    // tier happens to sort last.
    const middle = Math.min(EFFORT_IDS.indexOf(DEFAULT_EFFORT), ordered.length - 1)
    const defaultEffort = ordered.includes(DEFAULT_EFFORT) ? DEFAULT_EFFORT : ordered[middle]
    entries.push({
      id: entry.id,
      name: entry.title !== '' ? entry.title : titleOf(entry.id),
      contextWindow: entry.contextWindow,
      maxTokens: entry.maxTokens,
      supportsImage: entry.supportsImage,
      ...(ordered.length === 0 ? {} : { effortOptions: ordered, defaultEffort }),
      ...(entry.disabled ? { disabled: true, ...(entry.notice === undefined ? {} : { notice: entry.notice }) } : {}),
      preferred: entry.preferred,
      order: entry.order,
    })
  }

  // The upstream points several historical ids at one display name (three or
  // four of them all called "Gemini 3.5 Flash Lite"); the picker keeps one,
  // preferring whichever id the upstream's own sort/tiered lists reference.
  const byName = new Map()
  for (const entry of entries) {
    const existing = byName.get(entry.name)
    if (existing === undefined) {
      byName.set(entry.name, entry)
      continue
    }
    // A live row beats a `disabled` alias of the same name.
    if (existing.disabled === true && entry.disabled !== true) {
      byName.set(entry.name, entry)
      continue
    }
    if (entry.preferred && !existing.preferred) byName.set(entry.name, entry)
  }

  const deduped = [...byName.values()]
  deduped.sort((left, right) => {
    const leftRank = left.order ?? Number.MAX_SAFE_INTEGER
    const rightRank = right.order ?? Number.MAX_SAFE_INTEGER
    if (leftRank !== rightRank) return leftRank - rightRank
    return left.name.localeCompare(right.name)
  })
  return deduped.map(({ preferred: _preferred, order: _order, ...rest }) => rest)
}

/**
 * Build the base-id → entry lookup the request builder validates against.
 *
 * @param {object[]} entries - catalog entries.
 * @returns {Map<string, object>} the lookup.
 */
export function indexCatalog(entries) {
  return new Map(entries.map((entry) => [entry.id, entry]))
}

/**
 * The upstream id to name in the request body.
 *
 * The catalog lists one entry per base model and records which tier suffixes the
 * upstream actually serves (`gemini-4-carbon-low`, `-medium`, …). A model with no
 * tier rows is served under its bare id, so appending a tier would 404. A model
 * whose tiers are all `disabled` is served under none of them.
 *
 * @param {string} modelId - the base model id.
 * @param {string} tier - the resolved tier.
 * @param {object[] | undefined} entries - the catalog.
 * @returns {string} the upstream id.
 */
export function resolveUpstreamId(modelId, tier, entries) {
  const entry = entries?.find((candidate) => candidate.id === modelId)
  if (entry === undefined) return modelId
  const options = entry.effortOptions
  if (options === undefined || options.length === 0) return modelId
  if (options.includes(tier)) return `${modelId}-${tier}`
  const fallback = entry.defaultEffort ?? options[0]
  return fallback === undefined ? modelId : `${modelId}-${fallback}`
}

/**
 * Fetch the catalog, trying both endpoints.
 *
 * Never throws: a caller keeps its previous catalog when this reports an error,
 * because an expired token or a flaky network says nothing about which models
 * exist.
 *
 * @param {object} credential - the grant.
 * @param {typeof fetch} [fetchImpl] - fetch to use.
 * @param {{ warn?: (message: string) => void }} [logger] - optional logger.
 * @returns {Promise<{ models: object[], endpoint?: string, error: string }>}
 */
export async function fetchAvailableModels(credential, fetchImpl = fetch, logger) {
  if (typeof credential?.access_token !== 'string' || credential.access_token === '') {
    return { models: [], error: 'no access token' }
  }
  const headers = headersFor(credential, { includeAccept: true })
  const project = credential.cloudaicompanionProject ?? 'aicode-consumers'
  // An empty body 403s with SUBSCRIPTION_REQUIRED — the project member is
  // mandatory, not decorative.
  const body = JSON.stringify({ project })
  let lastError = 'no endpoint tried'
  for (const endpoint of ENDPOINTS) {
    try {
      const response = await fetchImpl(`${endpoint}${FETCH_MODELS_PATH}`, {
        method: 'POST',
        headers,
        body,
        signal: AbortSignal.timeout(CREDITS_TIMEOUT_MS),
      })
      if (!response.ok) {
        lastError = `fetchAvailableModels HTTP ${response.status}`
        continue
      }
      const models = parseAvailableModels(await response.json())
      if (models.length === 0) {
        lastError = '目录为空'
        continue
      }
      return { models, endpoint, error: '' }
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error)
    }
  }
  logger?.warn?.(`[dsh-subproxy] antigravity 模型目录拉取失败：${lastError}`)
  return { models: [], error: lastError }
}
