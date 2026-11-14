/**
 * Discover (and remember) the `cloudaicompanionProject` a grant belongs to.
 *
 * Every推理 request the Antigravity endpoint accepts needs a project number, and
 * the number is only learnable by asking: `loadCodeAssist` answers with either
 * `cloudaicompanionProject` or `currentTier.cloudaicompanionProject`. It is
 * stable per Google account, so it is worth caching in the credential rather
 * than paying a round trip per turn.
 *
 * @module dsh-subproxy/antigravity/project
 */
import {
  ENDPOINT_SANDBOX,
  LOAD_CODE_ASSIST_BODY,
  LOAD_CODE_ASSIST_PATH,
  CREDITS_TIMEOUT_MS,
  headersFor,
} from './protocol.js'

/** How long a probed project number is trusted before probing again. */
export const PROJECT_CACHE_TTL_MS = 6 * 60 * 60 * 1000

/** A stable label for the account behind a grant. */
export function credentialIdentity(credential) {
  if (typeof credential.email === 'string' && credential.email !== '') return `email:${credential.email}`
  if (typeof credential.sub === 'string' && credential.sub !== '') return `sub:${credential.sub}`
  return `token:${typeof credential.access_token === 'string' ? credential.access_token.slice(-16) : ''}`
}

/**
 * Read the project number out of a `loadCodeAssist` reply.
 *
 * @param {unknown} payload - the reply.
 * @returns {string | undefined} the project number.
 */
export function parseProject(payload) {
  if (typeof payload !== 'object' || payload === null) return undefined
  const direct = payload.cloudaicompanionProject
  if (typeof direct === 'string' && direct !== '') return direct
  const tier = payload.currentTier
  if (typeof tier === 'object' && tier !== null) {
    const nested = tier.cloudaicompanionProject
    if (typeof nested === 'string' && nested !== '') return nested
  }
  return undefined
}

/**
 * Ask the endpoint which project a grant belongs to.
 *
 * Only the sandbox endpoint is asked — it is the one that answers
 * `loadCodeAssist` for the subscription tier; the daily endpoint 403s here.
 *
 * @param {object} credential - the grant.
 * @param {{ fetchImpl?: typeof fetch, signal?: AbortSignal }} [options] - injection.
 * @returns {Promise<{ project?: string, error?: string }>} the probe result.
 */
async function probeProject(credential, options = {}) {
  const fetchImpl = options.fetchImpl ?? fetch
  const url = `${ENDPOINT_SANDBOX}${LOAD_CODE_ASSIST_PATH}`
  const signal = options.signal ?? AbortSignal.timeout(CREDITS_TIMEOUT_MS)
  try {
    const response = await fetchImpl(url, {
      method: 'POST',
      headers: headersFor(credential, { includeAccept: true }),
      body: LOAD_CODE_ASSIST_BODY,
      signal,
    })
    if (!response.ok) {
      const detail = await response.text().catch(() => '')
      return { error: `loadCodeAssist HTTP ${response.status}${detail === '' ? '' : ` — ${detail.slice(0, 300)}`}` }
    }
    const payload = await response.json()
    const project = parseProject(payload)
    if (project === undefined) return { error: 'loadCodeAssist 没有返回 cloudaicompanionProject' }
    return { project }
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) }
  }
}

/**
 * Resolve the project number for a grant, consulting the cache first.
 *
 * @param {object} args - inputs.
 * @param {object} args.credential - the grant.
 * @param {{ get: (id: string) => { project: string, at: number } | undefined, set: (id: string, value: { project: string, at: number }) => void }} args.cache - the cache.
 * @param {typeof fetch} [args.fetchImpl] - fetch injection.
 * @param {AbortSignal} [args.signal] - cancellation.
 * @returns {Promise<{ project: string, probed: boolean, error?: string }>} the project.
 */
export async function resolveProject(args) {
  const { credential, cache } = args
  const declared = typeof credential.cloudaicompanionProject === 'string' ? credential.cloudaicompanionProject : ''
  if (declared !== '') return { project: declared, probed: false }
  const identity = credentialIdentity(credential)
  const hit = cache.get(identity)
  if (hit !== undefined && Date.now() - hit.at < PROJECT_CACHE_TTL_MS) return { project: hit.project, probed: false }
  const probed = await probeProject(credential, { fetchImpl: args.fetchImpl, signal: args.signal })
  if (probed.project === undefined) return { project: '', probed: false, error: probed.error ?? '未知错误' }
  cache.set(identity, { project: probed.project, at: Date.now() })
  return { project: probed.project, probed: true }
}
