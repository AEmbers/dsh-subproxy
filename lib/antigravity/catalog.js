/**
 * The Antigravity model catalog.
 *
 * The upstream publishes `<base>-low/-medium/-high/-tiered` as separate ids; the
 * picker must show one row per base with the tiers folded into `reasoning`, so
 * this module merges them and keeps a lookup table the request builder uses to
 * decide which id to actually send.
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
  UPSTREAM_FLASH,
  headersFor,
} from './protocol.js'

/** How long a fetched catalog is reused before another fetch. */
export const CATALOG_TTL_MS = 600_000

/** Entries offered before any catalog has ever been fetched. */
export const FALLBACK_MODELS = [
  {
    id: UPSTREAM_FLASH,
    name: 'Gemini 3.8 Flash',
    contextWindow: CONTEXT_WINDOW,
    maxTokens: MAX_OUTPUT_TOKENS,
    supportsImage: true,
    effortOptions: EFFORT_IDS,
    defaultEffort: DEFAULT_EFFORT,
  },
]

/**
 * The tier suffix a catalog id carries, if any.
 *
 * @param {string} id - the catalog id.
 * @returns {string | undefined} the tier.
 */
function tierOfId(id) {
  for (const tier of EFFORT_IDS) {
    if (id.endsWith(`-${tier}`)) return tier
  }
  return undefined
}

/**
 * Strip the tier suffix off a catalog id.
 *
 * @param {string} id - the catalog id.
 * @returns {string} the base id.
 */
function baseOfId(id) {
  const tier = tierOfId(id)
  return tier === undefined ? id : id.slice(0, id.length - tier.length - 1)
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
    .replace(/\s*\((?:low|medium|high|tiered|adaptive)\)\s*$/i, '')
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
    .split(/[-_]/)
    .filter((part) => part !== '')
    .map((part) => part[0].toUpperCase() + part.slice(1))
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
 * Parse a `fetchAvailableModels` reply into one entry per model.
 *
 * Rows that differ only by tier become one entry whose `effortOptions` lists the
 * tiers the upstream actually serves — that list is what the request builder
 * validates a requested reasoning effort against.
 *
 * @param {unknown} payload - the reply.
 * @returns {object[]} the catalog entries.
 */
export function parseAvailableModels(payload) {
  if (typeof payload !== 'object' || payload === null) return []
  const raw = payload.models
  if (typeof raw !== 'object' || raw === null) return []

  // Ids the upstream itself prefers (default agent model, command models, …).
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
  ]) {
    if (Array.isArray(list)) list.forEach(remember)
  }
  const tiered = payload.tieredModelIds
  if (tiered !== undefined && tiered !== null && typeof tiered === 'object') {
    for (const list of Object.values(tiered)) if (Array.isArray(list)) list.forEach(remember)
  }
  if (Array.isArray(payload.agentModelSorts)) {
    for (const sort of payload.agentModelSorts) {
      if (sort === null || typeof sort !== 'object' || !Array.isArray(sort.groups)) continue
      for (const group of sort.groups) {
        if (group === null || typeof group !== 'object') continue
        if (Array.isArray(group.modelIds)) group.modelIds.forEach(remember)
      }
    }
  }

  const byBase = new Map()
  for (const [id, meta] of Object.entries(raw)) {
    if (ignored(id, meta)) continue
    const tier = tierOfId(id)
    const base = tier === undefined ? id : baseOfId(id)
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
      }
      byBase.set(base, entry)
    }
    if (tier !== undefined) entry.tiers.add(tier)
    if (preferred.has(id)) entry.preferred = true
    if (entry.title === '' && typeof meta?.displayName === 'string' && meta.displayName.trim() !== '') {
      entry.title = cleanName(meta.displayName)
    }
  }

  const entries = []
  for (const entry of byBase.values()) {
    const ordered = EFFORT_IDS.filter((tier) => entry.tiers.has(tier))
    const defaultEffort = ordered.includes(DEFAULT_EFFORT) ? DEFAULT_EFFORT : ordered[0]
    entries.push({
      id: entry.id,
      name: entry.title !== '' ? entry.title : titleOf(entry.id),
      contextWindow: entry.contextWindow,
      maxTokens: entry.maxTokens,
      supportsImage: entry.supportsImage,
      ...(ordered.length === 0 ? {} : { effortOptions: ordered, defaultEffort }),
      preferred: entry.preferred,
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
    if (entry.preferred && !existing.preferred) byName.set(entry.name, entry)
  }
  const deduped = [...byName.values()].map(({ preferred: _preferred, ...rest }) => rest)
  deduped.sort((a, b) =>
    a.id === UPSTREAM_FLASH ? -1 : b.id === UPSTREAM_FLASH ? 1 : a.name.localeCompare(b.name),
  )
  return deduped
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
 * upstream actually serves (`gemini-3.8-flash-low`, `-medium`, …). A model with
 * no tier rows is served under its bare id, so appending a tier would 404.
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
