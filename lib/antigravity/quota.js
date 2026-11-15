/**
 * Read the account's remaining budget, so a 429 can be explained instead of
 * guessed.
 *
 * The upstream answers two very different things with 429 and the same
 * `RESOURCE_EXHAUSTED` body: a genuinely spent account, and a request its content
 * filter refuses. The body cannot tell them apart — an account sitting at 84 %
 * still gets the quota-shaped 429 for a request it dislikes — so the only honest
 * move is to ask the quota endpoint what the account actually has left and say
 * so. Without this, "wait for the bucket to refill" sends people to wait for a
 * bucket that was never empty.
 *
 * @module dsh-subproxy/antigravity/quota
 */
import { ENDPOINT_DAILY, QUOTA_CACHE_TTL_MS, QUOTA_PATH, headersFor } from './protocol.js'

/** Below this fraction the account is treated as actually spent. */
export const QUOTA_EXHAUSTED_FRACTION = 0.02

/**
 * Read one quota bucket out of the upstream's summary.
 *
 * @param {unknown} raw - one bucket object.
 * @returns {{ id: string, label: string, window: string, remaining: number, resetTime?: string } | undefined} the bucket.
 */
function readBucket(raw) {
  if (typeof raw !== 'object' || raw === null) return undefined
  const id = typeof raw.bucketId === 'string' ? raw.bucketId : ''
  if (id === '') return undefined
  const remaining = typeof raw.remainingFraction === 'number' ? raw.remainingFraction : undefined
  if (remaining === undefined) return undefined
  const bucket = {
    id,
    label: typeof raw.displayName === 'string' ? raw.displayName : id,
    window: typeof raw.window === 'string' ? raw.window : '',
    remaining,
  }
  if (typeof raw.resetTime === 'string' && raw.resetTime !== '') bucket.resetTime = raw.resetTime
  return bucket
}

/**
 * Flatten the summary's groups into one bucket list.
 *
 * @param {unknown} payload - the endpoint's reply.
 * @returns {object[]} the buckets.
 */
export function parseQuota(payload) {
  const groups = typeof payload === 'object' && payload !== null ? (payload.groups ?? []) : []
  const buckets = []
  for (const group of Array.isArray(groups) ? groups : []) {
    for (const raw of Array.isArray(group?.buckets) ? group.buckets : []) {
      const bucket = readBucket(raw)
      if (bucket !== undefined) buckets.push(bucket)
    }
  }
  return buckets
}

/**
 * Whether any bucket still has room, i.e. the account is not actually spent.
 *
 * @param {object[]} buckets - the buckets.
 * @returns {boolean} true when at least one bucket is above the exhausted floor.
 */
export function quotaRemains(buckets) {
  if (!Array.isArray(buckets) || buckets.length === 0) return false
  return buckets.some((bucket) => bucket.remaining > QUOTA_EXHAUSTED_FRACTION)
}

/**
 * Render the buckets as one short line, e.g. `gemini-weekly 84%、gemini-5h 96%`.
 *
 * @param {object[]} buckets - the buckets.
 * @returns {string} the line, or an empty string.
 */
export function describeQuota(buckets) {
  if (!Array.isArray(buckets) || buckets.length === 0) return ''
  return buckets.map((bucket) => `${bucket.id} ${Math.round(bucket.remaining * 100)}%`).join('、')
}

/**
 * Ask the upstream what the grant has left, caching per account.
 *
 * @param {object} credential - the grant.
 * @param {object} [options] - injection.
 * @param {typeof fetch} [options.fetchImpl] - fetch.
 * @param {Map<string, { buckets: object[], at: number }>} [options.cache] - the cache.
 * @param {string} [options.identity] - the account key.
 * @param {AbortSignal} [options.signal] - cancellation.
 * @param {number} [options.timeoutMs] - the probe's own deadline.
 * @returns {Promise<{ buckets: object[], error?: string }>} the reading.
 */
export async function probeQuota(credential, options = {}) {
  const fetchImpl = options.fetchImpl ?? fetch
  const identity = options.identity ?? ''
  const cache = options.cache
  if (cache !== undefined && identity !== '') {
    const hit = cache.get(identity)
    if (hit !== undefined && Date.now() - hit.at < QUOTA_CACHE_TTL_MS) return { buckets: hit.buckets }
  }
  try {
    const response = await fetchImpl(`${ENDPOINT_DAILY}${QUOTA_PATH}`, {
      method: 'POST',
      headers: headersFor(credential),
      body: '{}',
      signal: options.signal ?? AbortSignal.timeout(options.timeoutMs ?? 20_000),
    })
    if (!response.ok) {
      const detail = await response.text().catch(() => '')
      return { buckets: [], error: `quota HTTP ${response.status}${detail === '' ? '' : ` — ${detail.slice(0, 200)}`}` }
    }
    const buckets = parseQuota(await response.json())
    if (cache !== undefined && identity !== '' && buckets.length > 0) cache.set(identity, { buckets, at: Date.now() })
    return { buckets }
  } catch (error) {
    return { buckets: [], error: error instanceof Error ? error.message : String(error) }
  }
}
