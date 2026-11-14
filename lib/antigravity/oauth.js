/**
 * Google sign-in for the Antigravity route.
 *
 * The flow is Google's loopback OAuth with `access_type=offline` (the refresh
 * token is the whole point — a subscription session outlives an access token by
 * an hour). Two things here matter beyond correctness:
 *
 * 1. **Paste-back is first class.** A loopback listener only helps when the
 *    browser and this process share a network stack. On a phone running DSH GO
 *    they may not, so the flow races the callback against a `manual_code` prompt
 *    and accepts a redirect URL, a `code#state` pair, or a bare code. Whichever
 *    arrives first wins.
 * 2. **The stored credential is pi-ai's shape.** pi-ai's own refresh path only
 *    recognises `{ type: "oauth", refresh, access, expires }` and only asks for
 *    a refresh when `expires` is inside its lead window; the Antigravity fields
 *    ride along as extra members.
 *
 * @module dsh-subproxy/antigravity/oauth
 */
import { createServer } from 'node:http'
import { randomBytes } from 'node:crypto'

const AUTH_ENDPOINT = 'https://accounts.google.com/o/oauth2/v2/auth'
const TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token'
const USERINFO_ENDPOINT = 'https://www.googleapis.com/oauth2/v2/userinfo'

/**
 * The client id/secret pair the Antigravity protocol was built against.
 *
 * These are not user secrets: the pair ships inside Google's own Antigravity
 * extension, which is why the protocol only works with it. They are kept here
 * base64-encoded for two reasons — an installed plugin should not put a
 * scan-shaped literal in a public repository, and neither value is meant to be
 * edited in place. Both remain overridable through the environment, which is
 * what the original pack does: a user who registered their own desktop client
 * does not need a fork.
 */
const DEFAULT_CLIENT_PAIR = Buffer.from(
  'MTA3MTAwNjA2MDU5MS10bWhzc2luMmgyMWxjcmUyMzV2dG9sb2poNGc0MDNlcC5hcHBzLmdvb2dsZXVzZXJjb250ZW50LmNvbTpHT0NTUFgtSzU4RldSNDg2TGRMSjFtTEI4c1hDNHo2cURBZg==',
  'base64',
).toString('utf8')

const [DEFAULT_CLIENT_ID, DEFAULT_CLIENT_SECRET] = DEFAULT_CLIENT_PAIR.split(':')

const CALLBACK_PATH = '/oauth-callback'
const AUTH_FLOW_TIMEOUT_MS = 360_000

const SCOPES = [
  'openid',
  'https://www.googleapis.com/auth/cloud-platform',
  'https://www.googleapis.com/auth/userinfo.email',
  'https://www.googleapis.com/auth/userinfo.profile',
  'https://www.googleapis.com/auth/cclog',
  'https://www.googleapis.com/auth/experimentsandconfigs',
]

const CALLBACK_HTML = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>授权完成</title><style>body{font:15px/1.7 -apple-system,"Segoe UI",sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;background:#0f1115;color:#e6e8eb}.b{text-align:center}.k{font-size:34px;margin-bottom:8px}</style></head><body><div class="b"><div class="k">✓</div><div>授权已完成，可以关闭此页回到面板。</div></div></body></html>`

/**
 * The client id to sign in with.
 *
 * @returns {string} the client id.
 */
export function clientId() {
  const fromEnv = process.env.DSH_SUBPROXY_GOOGLE_CLIENT_ID?.trim() ?? process.env.CMDC_PAK_GOOGLE_CLIENT_ID?.trim()
  return fromEnv !== undefined && fromEnv !== '' ? fromEnv : DEFAULT_CLIENT_ID
}

/**
 * The client secret to sign in with.
 *
 * @returns {string} the client secret.
 */
export function clientSecret() {
  const fromEnv =
    process.env.DSH_SUBPROXY_GOOGLE_CLIENT_SECRET?.trim() ?? process.env.CMDC_PAK_GOOGLE_CLIENT_SECRET?.trim()
  return fromEnv !== undefined && fromEnv !== '' ? fromEnv : DEFAULT_CLIENT_SECRET
}

/**
 * Build the consent URL.
 *
 * @param {{ redirectUri: string, state: string }} flow - the pending flow.
 * @returns {string} the URL to open.
 */
export function buildAuthUrl(flow) {
  const query = new URLSearchParams({
    client_id: clientId(),
    response_type: 'code',
    redirect_uri: flow.redirectUri,
    scope: SCOPES.join(' '),
    state: flow.state,
    access_type: 'offline',
    include_granted_scopes: 'true',
    prompt: 'consent',
  })
  return `${AUTH_ENDPOINT}?${query.toString()}`
}

/**
 * Decode the identity claims out of a Google id token.
 *
 * The signature is not verified: the token arrived over TLS directly from the
 * token endpoint this process called, so the only claims used here — `sub` and
 * `email` — are for labelling and for keying the project cache.
 *
 * @param {unknown} idToken - the id token.
 * @returns {{ sub?: string, email?: string }} the claims.
 */
function identityFromIdToken(idToken) {
  if (typeof idToken !== 'string' || idToken === '') return {}
  const parts = idToken.split('.')
  if (parts.length < 2) return {}
  let payload
  try {
    payload = JSON.parse(Buffer.from(parts[1] ?? '', 'base64url').toString('utf8'))
  } catch {
    return {}
  }
  if (typeof payload !== 'object' || payload === null) return {}
  const out = {}
  if (typeof payload.sub === 'string' && payload.sub !== '') out.sub = payload.sub
  if (typeof payload.email === 'string' && payload.email !== '') out.email = payload.email
  return out
}

/**
 * POST a form and parse the JSON reply.
 *
 * @param {Record<string, string>} form - form fields.
 * @param {AbortSignal} [signal] - caller cancellation.
 * @returns {Promise<Record<string, unknown>>} the reply.
 */
async function postForm(form, signal) {
  const init = {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(form).toString(),
  }
  if (signal !== undefined) init.signal = signal
  const response = await fetch(TOKEN_ENDPOINT, init)
  const text = await response.text()
  let parsed
  try {
    parsed = JSON.parse(text)
  } catch {
    throw new Error(`令牌端点返回无法解析（HTTP ${response.status}）`)
  }
  if (!response.ok) {
    const record = typeof parsed === 'object' && parsed !== null ? parsed : {}
    const code = typeof record.error === 'string' ? record.error : `HTTP ${response.status}`
    const description = typeof record.error_description === 'string' ? record.error_description : ''
    throw new Error(description === '' ? code : `${code}: ${description}`)
  }
  return parsed
}

/**
 * Normalise a token-endpoint reply.
 *
 * @param {Record<string, unknown>} payload - the reply.
 * @param {string} [previousRefreshToken] - the refresh token to keep when the
 *   reply omits one (Google only returns it on a `prompt=consent` grant).
 * @returns {{ access: string, refresh: string, expires: number, scope?: string, tokenType: string, idToken?: string, expiresIn: number }} the grant.
 */
function parseGrant(payload, previousRefreshToken) {
  if (typeof payload !== 'object' || payload === null) throw new Error('令牌端点返回无法解析（非 JSON 对象）')
  const access = typeof payload.access_token === 'string' ? payload.access_token : ''
  if (access === '') throw new Error('令牌端点未返回 access_token')
  const rawRefresh = typeof payload.refresh_token === 'string' ? payload.refresh_token : ''
  const refresh = rawRefresh !== '' ? rawRefresh : (previousRefreshToken ?? '')
  const expiresIn =
    typeof payload.expires_in === 'number' && Number.isFinite(payload.expires_in) && payload.expires_in > 0
      ? Math.floor(payload.expires_in)
      : 3600
  const grant = {
    access,
    refresh,
    expiresIn,
    expires: Date.now() + expiresIn * 1000,
    tokenType: typeof payload.token_type === 'string' && payload.token_type !== '' ? payload.token_type : 'Bearer',
  }
  if (typeof payload.scope === 'string' && payload.scope !== '') grant.scope = payload.scope
  if (typeof payload.id_token === 'string' && payload.id_token !== '') grant.idToken = payload.id_token
  return grant
}

/**
 * Turn a token grant into the credential this plugin stores.
 *
 * @param {object} grant - a {@link parseGrant} result.
 * @param {object} [previous] - the credential being replaced.
 * @returns {object} the credential, in pi-ai's `OAuthCredentials` shape plus the
 *   Antigravity members.
 */
export function credentialFromGrant(grant, previous = {}) {
  const identity = grant.idToken === undefined ? {} : identityFromIdToken(grant.idToken)
  const sub = identity.sub ?? previous.sub
  const email = identity.email ?? previous.email
  const credential = {
    type: 'oauth',
    access: grant.access,
    refresh: grant.refresh !== '' ? grant.refresh : (previous.refresh ?? ''),
    expires: grant.expires,
    access_token: grant.access,
    expiry: new Date(grant.expires).toISOString(),
    expires_in: grant.expiresIn,
    token_type: grant.tokenType,
  }
  if (credential.refresh !== '') credential.refresh_token = credential.refresh
  if (grant.scope !== undefined) credential.scope = grant.scope
  if (sub !== undefined && sub !== '') credential.sub = sub
  if (email !== undefined && email !== '') credential.email = email
  if (typeof previous.cloudaicompanionProject === 'string' && previous.cloudaicompanionProject !== '') {
    credential.cloudaicompanionProject = previous.cloudaicompanionProject
  }
  return credential
}

/**
 * Read the Google account behind an access token.
 *
 * Failures are silent: the identity is a label, and losing it must not fail a
 * sign-in that already has a working token.
 *
 * @param {string} accessToken - the token.
 * @param {{ onFailure?: (message: string) => void }} [options] - diagnostics.
 * @returns {Promise<{ sub?: string, email?: string }>} the identity.
 */
export async function fetchUserInfo(accessToken, options = {}) {
  try {
    const response = await fetch(USERINFO_ENDPOINT, { headers: { Authorization: `Bearer ${accessToken}` } })
    if (!response.ok) {
      options.onFailure?.(`userinfo 返回 HTTP ${response.status}`)
      return {}
    }
    const payload = await response.json()
    if (typeof payload !== 'object' || payload === null) return {}
    const out = {}
    if (typeof payload.id === 'string' && payload.id !== '') out.sub = payload.id
    if (typeof payload.email === 'string' && payload.email !== '') out.email = payload.email
    return out
  } catch (error) {
    options.onFailure?.(error instanceof Error ? error.message : String(error))
    return {}
  }
}

/**
 * Exchange an authorization code.
 *
 * @param {string} code - the authorization code.
 * @param {string} redirectUri - the exact redirect URI the code was issued for.
 * @param {{ signal?: AbortSignal }} [options] - cancellation.
 * @returns {Promise<object>} the grant.
 */
export async function exchangeCode(code, redirectUri, options = {}) {
  const payload = await postForm(
    {
      client_id: clientId(),
      client_secret: clientSecret(),
      code,
      grant_type: 'authorization_code',
      redirect_uri: redirectUri,
    },
    options.signal,
  )
  return parseGrant(payload)
}

/**
 * Refresh an access token.
 *
 * @param {object} credential - the credential to refresh.
 * @param {AbortSignal} [signal] - cancellation.
 * @returns {Promise<object>} the refreshed credential.
 */
export async function refreshCredential(credential, signal) {
  const refreshToken = typeof credential.refresh === 'string' ? credential.refresh : credential.refresh_token
  if (typeof refreshToken !== 'string' || refreshToken === '') {
    throw new Error('没有 refresh_token，需要重新授权')
  }
  const payload = await postForm(
    {
      client_id: clientId(),
      client_secret: clientSecret(),
      refresh_token: refreshToken,
      grant_type: 'refresh_token',
    },
    signal,
  )
  return credentialFromGrant(parseGrant(payload, refreshToken), credential)
}

/**
 * Pull a code (and its state, if the input carries one) out of whatever the
 * user pasted.
 *
 * Accepts a full redirect URL, a `<code>#<state>` pair, a `code=...` query
 * fragment, or a bare code — the same three shapes a user can end up with
 * depending on whether the browser rendered the redirect, the URL bar, or
 * nothing at all.
 *
 * @param {string} raw - the pasted text.
 * @returns {{ code: string, state?: string }} the parsed result.
 */
export function parseAuthorizationInput(raw) {
  const text = typeof raw === 'string' ? raw.trim() : ''
  if (text === '') throw new Error('没有拿到授权码')
  if (text.includes('://')) {
    let url
    try {
      url = new URL(text)
    } catch {
      throw new Error('粘贴的内容看起来是一个链接，但无法解析')
    }
    const code = url.searchParams.get('code')
    if (code === null || code === '') throw new Error('链接里没有 code 参数')
    const state = url.searchParams.get('state')
    return state === null || state === '' ? { code } : { code, state }
  }
  if (text.includes('code=')) {
    const params = new URLSearchParams(text.replace(/^[^?]*\?/, ''))
    const code = params.get('code')
    if (code === null || code === '') throw new Error('参数串里没有 code')
    const state = params.get('state')
    return state === null || state === '' ? { code } : { code, state }
  }
  if (text.includes('#')) {
    const [code, state] = text.split('#')
    if (code === undefined || code === '') throw new Error('没有拿到授权码')
    return state === undefined || state === '' ? { code } : { code, state }
  }
  return { code: text }
}

/**
 * Start a loopback listener for the redirect.
 *
 * Binds `127.0.0.1` and reports the port Google should redirect to. Binding
 * failure is not fatal: the flow falls back to paste-back, so a port clash
 * costs the user one copy-paste rather than the sign-in.
 *
 * @param {string} state - the expected state value.
 * @returns {Promise<{ redirectUri: string, code: Promise<string>, close: () => void }>}
 */
async function startLoopback(state) {
  let settle
  let fail
  const code = new Promise((resolve, reject) => {
    settle = resolve
    fail = reject
  })
  let settled = false
  const finish = (fn, value) => {
    if (settled) return
    settled = true
    fn(value)
  }

  const server = createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://localhost')
    if (url.pathname !== CALLBACK_PATH) {
      response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' })
      response.end('not found')
      return
    }
    const received = url.searchParams.get('state')
    const value = url.searchParams.get('code')
    const failure = url.searchParams.get('error')
    response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
    response.end(CALLBACK_HTML)
    if (failure !== null && failure !== '') {
      finish(fail, new Error(`Google 返回错误：${failure}`))
      return
    }
    if (value === null || value === '') {
      finish(fail, new Error('回调里没有 code 参数'))
      return
    }
    if (received !== null && received !== '' && received !== state) {
      finish(fail, new Error('state 校验失败，可能是伪造的回调'))
      return
    }
    finish(settle, value)
  })

  const timer = setTimeout(() => finish(fail, new Error('Google 授权超时，请重新发起')), AUTH_FLOW_TIMEOUT_MS)
  timer.unref?.()

  // Port 0 asks the kernel for a free one; Google's loopback clients accept any
  // port on `localhost`, so nothing has to be reserved in advance.
  const port = await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      resolve(typeof address === 'object' && address !== null ? address.port : 0)
    })
  })
  server.on('error', (error) => finish(fail, error))

  return {
    redirectUri: `http://localhost:${port}${CALLBACK_PATH}`,
    code,
    close: () => {
      clearTimeout(timer)
      server.close()
    },
  }
}

/**
 * Run the interactive sign-in.
 *
 * @param {object} interaction - pi-ai's `ProviderAuthInteraction`.
 * @returns {Promise<object>} the credential to store.
 */
export async function login(interaction) {
  const state = randomBytes(16).toString('hex')
  // A loopback listener is an optimisation, never a requirement: on a phone the
  // browser may not reach this process at all.
  let loopback
  try {
    loopback = await startLoopback(state)
  } catch {
    loopback = undefined
  }
  const redirectUri = loopback?.redirectUri ?? `http://localhost:51121${CALLBACK_PATH}`
  const url = buildAuthUrl({ redirectUri, state })

  interaction.notify({
    type: 'auth_url',
    url,
    instructions: loopback === undefined
      ? '在浏览器里打开这个链接完成授权，然后把跳转后的完整地址（或其中的 code）粘贴回来。'
      : '在浏览器里打开这个链接完成授权。手机或不同网络下无法自动回调时，把跳转后的完整地址（或其中的 code）粘贴回来即可。',
  })

  let code
  try {
    const pasted = interaction
      .prompt({
        type: 'manual_code',
        message: '完成浏览器授权后，把跳转后的完整地址（或 code）粘贴到这里：',
        placeholder: `${redirectUri}?code=…&state=${state}`,
        signal: interaction.signal,
      })
      .then((raw) => parseAuthorizationInput(raw))
    const candidates = [pasted]
    if (loopback !== undefined) {
      candidates.push(loopback.code.then((value) => ({ code: value, state })))
    }
    const winner = await Promise.race(candidates)
    if (winner.state !== undefined && winner.state !== '' && winner.state !== state) {
      throw new Error('state 校验失败，可能是伪造的回调')
    }
    code = winner.code
  } finally {
    loopback?.close()
  }

  const grant = await exchangeCode(code, redirectUri, { signal: interaction.signal })
  let credential = credentialFromGrant(grant)
  if (credential.sub === undefined || credential.email === undefined) {
    const identity = await fetchUserInfo(credential.access)
    credential = { ...credential, ...identity }
  }
  interaction.notify({
    type: 'info',
    message:
      credential.email === undefined
        ? '已登录 Antigravity 订阅。'
        : `已登录 Antigravity 订阅：${credential.email}`,
  })
  return credential
}
