/**
 * Adopt a Google account that is already signed in elsewhere.
 *
 * Cloud Code Assist gates its catalog on the account's subscription tier, not on
 * the client: a `free-tier` grant is served 22 rows (three of them `disabled`),
 * while a `g1-ultra-lite-tier` grant is served 33 rows including the whole
 * Gemini 4 family and Claude Opus/Sonnet 5.5. So which grant this plugin holds
 * decides almost the entire model list, and picking the wrong one makes a
 * perfectly healthy plugin look like it lost 30 models.
 *
 * Other tools on this machine (`agy`, the Antigravity IDE, sibling plugins) keep
 * their Google grants in the harness credential store's flat `refs:` half, which
 * is *not* enumerable through the credential seam — `CredentialProvider` answers
 * about references it is given and offers `listRecords()` for the record half
 * only. Adoption therefore reads the store file directly. That is a deliberate
 * exception: without enumeration the only alternative is asking the user to retype
 * a refresh token, and this file is the same file the seam itself reads.
 *
 * @module dsh-subproxy/antigravity/account
 */
import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

import {
  ACCOUNT_TIER_RANK,
  CREDITS_TIMEOUT_MS,
  ENDPOINT_DAILY,
  ENDPOINT_SANDBOX,
  LOAD_CODE_ASSIST_BODY,
  LOAD_CODE_ASSIST_PATH,
  headersFor,
} from './protocol.js'

/**
 * Where the local credential store lives.
 *
 * `DSH_HOME` moves the whole `.dsh` tree, so honour it before falling back to
 * `~/.dsh`; `DSH_CREDENTIALS_FILE` names the file outright for compositions that
 * mount the store somewhere else.
 *
 * @returns {string} the absolute path of `.credentials.yaml`.
 */
export function credentialStorePath() {
  if (typeof process.env.DSH_CREDENTIALS_FILE === 'string' && process.env.DSH_CREDENTIALS_FILE !== '') {
    return resolve(process.env.DSH_CREDENTIALS_FILE)
  }
  const home =
    typeof process.env.DSH_HOME === 'string' && process.env.DSH_HOME !== ''
      ? resolve(process.env.DSH_HOME)
      : join(homedir(), '.dsh')
  return join(home, '.credentials.yaml')
}

/**
 * Split a YAML scalar body into its logical value.
 *
 * Only what this store actually contains is handled: a quoted scalar (whose
 * continuation lines fold to single spaces, which is what YAML does), and a
 * block scalar (kept verbatim). Everything else is returned as written.
 *
 * @param {string[]} lines - the value lines, first one included.
 * @returns {string} the value.
 */
function scalarValue(lines) {
  const first = lines[0] ?? ''
  const body = first.trim()
  if (body.startsWith('|') || body.startsWith('>')) return lines.slice(1).join('\n')
  const quote = body.startsWith("'") ? "'" : body.startsWith('"') ? '"' : ''
  if (quote === '') return body
  const joined = [body.slice(1), ...lines.slice(1).map((line) => line.trim())].join(' ').trim()
  return joined.endsWith(quote) ? joined.slice(0, -1) : joined
}

/**
 * Read the flat `refs:` map out of credential-store text.
 *
 * @param {string} text - the file's contents.
 * @returns {Record<string, string>} reference name → value.
 */
export function parseRefsBlock(text) {
  const lines = String(text).split(/\r?\n/u)
  const start = lines.findIndex((line) => /^refs:\s*$/u.test(line))
  if (start < 0) return {}
  const out = {}
  let name
  let buffer = []
  const flush = () => {
    if (name !== undefined) out[name] = scalarValue(buffer)
    buffer = []
  }
  for (const line of lines.slice(start + 1)) {
    const head = /^ {2}([A-Za-z_][A-Za-z0-9_]*):\s?(.*)$/u.exec(line)
    if (head !== null) {
      flush()
      name = head[1]
      buffer = [head[2]]
      continue
    }
    if (/^\S/u.test(line)) break
    if (name !== undefined) buffer.push(line)
  }
  flush()
  return out
}

/**
 * Read the flat `refs:` map out of a credential store file.
 *
 * @param {string} [path] - the file; defaults to {@link credentialStorePath}.
 * @returns {Promise<Record<string, string>>} reference name → value.
 */
export async function readStoreRefs(path = credentialStorePath()) {
  let text
  try {
    text = await readFile(path, 'utf8')
  } catch {
    return {}
  }
  return parseRefsBlock(text)
}

/**
 * Turn a stored reference value into a Grant, when it is one.
 *
 * @param {string} value - the raw reference value.
 * @returns {object | undefined} the grant.
 */
export function grantOf(value) {
  if (typeof value !== 'string' || value.trim().startsWith('-----') === true) return undefined
  let payload
  try {
    payload = JSON.parse(value)
  } catch {
    return undefined
  }
  if (payload === null || typeof payload !== 'object') return undefined
  // Three spellings reach a store: the reference format uses camelCase, the
  // plugin's own record uses snake_case, and pi-ai's `OAuthCredentials` uses the
  // bare `access`/`refresh`. All three are the same grant.
  const access = payload.access_token ?? payload.accessToken ?? payload.access
  const refresh = payload.refresh_token ?? payload.refreshToken ?? payload.refresh
  if (typeof access !== 'string' || access === '') return undefined
  if (typeof refresh !== 'string' || refresh === '') return undefined
  // Anthropic- and OpenAI-shaped grants also carry `access_token`; the scope is
  // what tells a Google one apart, and a bare `ya29.` access token is Google's.
  const scopes = typeof payload.scope === 'string' ? payload.scope : ''
  const googleShaped = scopes.includes('googleapis.com') || access.startsWith('ya29.')
  if (!googleShaped) return undefined
  const grant = {
    type: 'oauth',
    access,
    refresh,
    // The reference format carries `expiresAt` in milliseconds; the plugin's own
    // record format carries `expires` in milliseconds too. Adopt either.
    expires: typeof payload.expiresAt === 'number' ? payload.expiresAt : undefined,
    access_token: access,
    refresh_token: refresh,
    token_type: typeof payload.token_type === 'string' ? payload.token_type : 'Bearer',
  }
  if (typeof payload.expiry === 'string' && payload.expiry !== '') grant.expiry = payload.expiry
  if (typeof payload.expiresAt === 'number') grant.expiry = new Date(payload.expiresAt).toISOString()
  if (typeof payload.expires_in === 'number') grant.expires_in = payload.expires_in
  if (typeof payload.scope === 'string' && payload.scope !== '') grant.scope = payload.scope
  if (typeof payload.email === 'string' && payload.email !== '') grant.email = payload.email
  if (typeof payload.sub === 'string' && payload.sub !== '') grant.sub = payload.sub
  if (typeof payload.accountId === 'string' && payload.accountId !== '') grant.sub = payload.accountId
  return grant
}

/**
 * Refresh a grant in place, returning the token to probe with.
 *
 * @param {object} grant - the grant.
 * @param {{ fetchImpl?: typeof fetch, clientId: string, clientSecret: string }} options - inputs.
 * @returns {Promise<{ access?: string, fresh?: object, error?: string }>} the outcome.
 */
async function refreshForProbe(grant, options) {
  const fetchImpl = options.fetchImpl ?? fetch
  try {
    const body = new URLSearchParams({
      client_id: options.clientId,
      client_secret: options.clientSecret,
      grant_type: 'refresh_token',
      refresh_token: grant.refresh_token,
    })
    const response = await fetchImpl('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
      signal: AbortSignal.timeout(CREDITS_TIMEOUT_MS),
    })
    const payload = await response.json().catch(() => undefined)
    if (!response.ok || typeof payload?.access_token !== 'string') {
      return { error: `refresh HTTP ${response.status}` }
    }
    const fresh = {
      ...grant,
      access: payload.access_token,
      access_token: payload.access_token,
      expiry: new Date(Date.now() + (payload.expires_in ?? 3600) * 1000).toISOString(),
      expires: Date.now() + (payload.expires_in ?? 3600) * 1000,
      expires_in: payload.expires_in ?? 3600,
    }
    if (typeof payload.refresh_token === 'string' && payload.refresh_token !== '') {
      fresh.refresh = payload.refresh_token
      fresh.refresh_token = payload.refresh_token
    }
    return { access: payload.access_token, fresh }
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) }
  }
}

/**
 * Ask one endpoint which tier an access token belongs to.
 *
 * @param {string} access - the access token.
 * @param {string} endpoint - the endpoint base.
 * @param {typeof fetch} fetchImpl - fetch.
 * @returns {Promise<object | undefined>} the `loadCodeAssist` reply.
 */
async function loadCodeAssist(access, endpoint, fetchImpl) {
  try {
    const response = await fetchImpl(`${endpoint}${LOAD_CODE_ASSIST_PATH}`, {
      method: 'POST',
      headers: headersFor({ access_token: access }, { includeAccept: true }),
      body: LOAD_CODE_ASSIST_BODY,
      signal: AbortSignal.timeout(CREDITS_TIMEOUT_MS),
    })
    if (!response.ok) return undefined
    const payload = await response.json()
    return typeof payload === 'object' && payload !== null ? payload : undefined
  } catch {
    return undefined
  }
}

/**
 * The rank of a `loadCodeAssist` reply, highest tier winning.
 *
 * The upstream reports the *effective* tier in `currentTier.id` and the plan the
 * account pays for in `paidTier.id`; a grant whose `currentTier` is `free-tier`
 * can still be entitled to a paid plan that has not been activated, so both are
 * ranked and the better one is used.
 *
 * @param {object} payload - the reply.
 * @returns {{ rank: number, tier: string, paid?: string }} the ranking.
 */
export function rankOf(payload) {
  const current = typeof payload?.currentTier?.id === 'string' ? payload.currentTier.id : ''
  const paid = typeof payload?.paidTier?.id === 'string' ? payload.paidTier.id : ''
  const currentRank = ACCOUNT_TIER_RANK[current] ?? 0
  const paidRank = ACCOUNT_TIER_RANK[paid] ?? 0
  return { rank: Math.max(currentRank, paidRank), tier: current, ...(paid === '' ? {} : { paid }) }
}

/**
 * Work out which tier a grant belongs to, refreshing it when it has gone stale.
 *
 * The access token in a `refs:` entry is usually hours or weeks old — `agy` and
 * the IDE keep their own copy fresh, not this one — so a 401 is the expected
 * first answer and a refresh is part of probing rather than an error path.
 *
 * @param {object} grant - the grant.
 * @param {object} [options] - injection.
 * @param {typeof fetch} [options.fetchImpl] - fetch.
 * @param {string} [options.clientId] - OAuth client id.
 * @param {string} [options.clientSecret] - OAuth client secret.
 * @returns {Promise<{ tier: string, paid?: string, rank: number, project?: string, grant: object } | undefined>} the probe, or undefined when the grant cannot talk to the endpoint at all.
 */
export async function probeAccount(grant, options = {}) {
  const fetchImpl = options.fetchImpl ?? fetch
  let live = grant
  let payload = await loadCodeAssist(live.access_token, ENDPOINT_DAILY, fetchImpl)
  if (payload === undefined && typeof options.clientId === 'string' && options.clientId !== '') {
    const refreshed = await refreshForProbe(live, {
      fetchImpl,
      clientId: options.clientId,
      clientSecret: options.clientSecret ?? '',
    })
    if (refreshed.access !== undefined) {
      live = refreshed.fresh ?? live
      payload = await loadCodeAssist(refreshed.access, ENDPOINT_DAILY, fetchImpl)
      if (payload === undefined) payload = await loadCodeAssist(refreshed.access, ENDPOINT_SANDBOX, fetchImpl)
    }
  }
  if (payload === undefined) return undefined
  const ranked = rankOf(payload)
  const project =
    typeof payload.cloudaicompanionProject === 'string' && payload.cloudaicompanionProject !== ''
      ? payload.cloudaicompanionProject
      : typeof payload.currentTier?.cloudaicompanionProject === 'string'
        ? payload.currentTier.cloudaicompanionProject
        : undefined
  return {
    tier: ranked.tier,
    ...(ranked.paid === undefined ? {} : { paid: ranked.paid }),
    rank: ranked.rank,
    ...(project === undefined ? {} : { project }),
    grant: live,
  }
}

/**
 * Candidate Google accounts already present in the credential store.
 *
 * Every candidate is probed against the tier endpoint so the caller can keep the
 * strongest one; probing is a single small POST and only happens during adoption.
 *
 * @param {object} [options] - injection.
 * @param {typeof fetch} [options.fetchImpl] - fetch.
 * @param {string} [options.clientId] - OAuth client id, for refreshing.
 * @param {string} [options.clientSecret] - OAuth client secret.
 * @param {string} [options.path] - credential store path.
 * @returns {Promise<{ name: string, grant: object, tier: string, rank: number, project?: string }[]>} ranked candidates, strongest first.
 */
export async function discoverAccounts(options = {}) {
  const refs = await readStoreRefs(options.path)
  const found = []
  for (const [name, value] of Object.entries(refs)) {
    const grant = grantOf(value)
    if (grant === undefined) continue
    const probe = await probeAccount(grant, options)
    if (probe === undefined) continue
    found.push({ name, ...probe })
  }
  found.sort((left, right) => right.rank - left.rank)
  return found
}

/**
 * Decide whether a discovered account should replace the one in use.
 *
 * This is the whole adoption policy, kept as one pure decision so it can be
 * reasoned about and tested without a credential store or a network:
 *
 * - nothing in use yet → take the strongest;
 * - the grant in use is one the user signed in for → never take it away (the
 *   best account on the machine is not automatically the one they wanted);
 * - the strongest candidate is the account already in use → nothing to do;
 * - otherwise only a *strictly* stronger plan wins, so a store full of equally
 *   ranked accounts cannot make the route flip between them on every write.
 *
 * @param {{ rank?: number, explicit?: boolean, refresh?: string } | undefined} [current] - the account in use.
 * @param {{ name: string, rank: number, tier: string, grant: object }[]} [candidates] - ranked, strongest first.
 * @returns {object | undefined} the account to move to, or undefined to stay.
 */
export function preferAccount(current, candidates) {
  const best = (candidates ?? [])[0]
  if (best === undefined) return undefined
  if (current === undefined) return best
  if (current.explicit === true) return undefined
  if (typeof current.refresh === 'string' && best.grant?.refresh_token === current.refresh) return undefined
  const rank = typeof current.rank === 'number' ? current.rank : 0
  return best.rank > rank ? best : undefined
}
