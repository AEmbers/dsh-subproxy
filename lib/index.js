/**
 * `dsh-subproxy` — three subscription upstreams behind one plugin.
 *
 * Each lane is a pi-ai provider served through its own `PiAiAdapter`, registered
 * on its own route id:
 *
 * | route        | upstream                        | models | auth   |
 * | ------------ | ------------------------------- | ------ | ------ |
 * | `sub-gpt`    | ChatGPT Plus/Pro (Codex)        | 8      | OAuth  |
 * | `sub-claude` | Claude Pro/Max                  | 14     | OAuth + API key |
 * | `sub-gemini` | Antigravity (Cloud Code Assist) | catalog | OAuth |
 *
 * The route ids are deliberately *not* `openai-codex` / `anthropic`: the host's
 * own `llm-pi-ai` plugin already claims those, and a second adapter on the same
 * route throws `DUPLICATE_ADAPTER`, which unwinds the whole registration batch.
 *
 * Everything here is written for the two hosts this has to run on — the desktop
 * app and DSH GO on a phone. That means: no native modules, no ports to reserve,
 * no assumption that a browser can reach this process, and no reliance on a
 * settings UI that may not exist on the mobile surface.
 *
 * @module dsh-subproxy
 */
import { PiAiAdapter } from '@deepseek-ai/dsh-llm-pi-ai'
import { resolveImageAttachmentAccess, resolveRetryPolicy } from '@deepseek-ai/dsh-llm'
import { createModels } from '@earendil-works/pi-ai'

import {
  RECORD_SCOPE,
  REQUEST_IMAGE_BUDGETS,
  ROUTES,
  ROUTE_GEMINI,
  ROUTE_NAMES,
  ROUTE_OPENAI,
  STREAM_IDLE_TIMEOUT_MS,
} from './constants.js'
import { authContextFrom, credentialStoreFrom, recordKeyFor } from './credentials.js'
import { buildProviders } from './providers.js'
import { CATALOG_TTL_MS, FALLBACK_MODELS, fetchAvailableModels } from './antigravity/catalog.js'
import { credentialIdentity, resolveProject } from './antigravity/project.js'
import { isExpired, isRefreshable, parseCredential, planLabel } from './antigravity/protocol.js'
import { discoverAccounts, preferAccount, probeAccount } from './antigravity/account.js'
import { watchStore } from './store-watch.js'
import {
  clientId as googleClientId,
  clientSecret as googleClientSecret,
  login as googleLogin,
  refreshCredential as googleRefresh,
} from './antigravity/oauth.js'

export const name = 'subproxy'

/**
 * `llm` for the adapter registry and `authorization` for the sign-in flows.
 * Both are injected lazily so a host without the authorization service still
 * gets its provider routes.
 */
export const inject = ['llm']

/** Longest a tool-less wait between provider catalog refreshes may be. */
const CATALOG_RETRY_MS = 30_000

/**
 * Wrap a logger so nothing in this plugin can throw out of a log call.
 *
 * @param {object | undefined} logger - the host logger.
 * @returns {{ info: Function, warn: Function, error: Function }} the wrapper.
 */
function quietLogger(logger) {
  const emit = (level, message, error) => {
    try {
      if (logger?.[level] === undefined) return
      if (error === undefined) logger[level](`dsh-subproxy: ${message}`)
      else logger[level](`dsh-subproxy: ${message}`, error)
    } catch {
      // A logger that throws must not take a request down with it.
    }
  }
  return {
    info: (message) => emit('info', message),
    warn: (message, error) => emit('warn', message, error),
    error: (message, error) => emit('error', message, error),
  }
}

/**
 * Install the plugin.
 *
 * @param {object} ctx - the cordis context.
 * @returns {void}
 */
export function apply(ctx) {
  const logger = quietLogger(ctx.logger)
  const credentials = credentialStoreFrom(ctx)
  const auth = { credentials, authContext: authContextFrom(ctx) }

  /** Cached Antigravity catalog; `undefined` means "not fetched yet". */
  let catalog
  let catalogFetchedAt = 0
  let catalogInFlight
  /** Project numbers, keyed by account identity. */
  const projectCache = new Map()
  /** Quota readings, keyed by account identity — see `antigravity/quota.js`. */
  const quotaCache = new Map()
  /** Which plan the grant behind the Antigravity route pays for, once known. */
  let accountTier
  /** The paid plan behind that grant, when it differs from the effective tier. */
  let accountPaid
  /**
   * Set once the user signs in through `/subproxy login`.
   *
   * An inherited account is a convenience; a chosen one is a decision. This flag
   * is what keeps the watcher from quietly replacing the account the user asked
   * for with a better-ranked one that happens to appear in the store later.
   */
  let explicitLogin = false

  /**
   * Read this plugin's stored grant for a route.
   *
   * @param {string} route - the route id.
   * @returns {Promise<object | undefined>} the grant.
   */
  const readGrant = async (route) => {
    const credential = await credentials.read(route).catch(() => undefined)
    if (credential === undefined) return undefined
    if (credential.type === 'api_key') {
      const key = typeof credential.key === 'string' ? credential.key : ''
      return key === '' ? undefined : { access_token: key }
    }
    return parseCredential(credential)
  }

  /**
   * Force a refresh of the Antigravity grant.
   *
   * Goes through `modify` so two concurrent requests cannot both spend the same
   * refresh token — Google invalidates the previous one on use.
   *
   * @returns {Promise<void>} resolves once the store holds a fresh grant.
   */
  const refreshGrant = async () => {
    await credentials
      .modify(ROUTE_GEMINI, async (current) => {
        if (current === undefined || current.type !== 'oauth') return undefined
        if (!isExpired(current) || !isRefreshable(current)) return undefined
        const next = await googleRefresh(current)
        return { ...current, ...next }
      })
      .catch((error) => logger.warn('Antigravity 令牌刷新失败', error))
  }

  /**
   * Refresh the catalog if it is stale, then hand back whatever is known.
   *
   * Never throws: a catalog failure costs the model list, not the ability to use
   * the models already selected.
   *
   * @param {{ force?: boolean }} [options] - force a fetch.
   * @returns {Promise<object[] | undefined>} the entries.
   */
  const loadCatalog = async (options = {}) => {
    const fresh = catalog !== undefined && Date.now() - catalogFetchedAt < CATALOG_TTL_MS
    if (fresh && options.force !== true) return catalog
    if (catalogInFlight !== undefined) return catalogInFlight
    const grant = await readGrant(ROUTE_GEMINI)
    if (grant === undefined || grant.access_token === undefined) return catalog
    catalogInFlight = (async () => {
      const result = await fetchAvailableModels(grant, fetch, logger)
      if (result.models.length > 0) {
        catalog = result.models
        catalogFetchedAt = Date.now()
      } else if (result.error !== undefined) {
        logger.warn(`Antigravity 模型目录获取失败：${result.error}`)
      }
      return catalog
    })().finally(() => {
      catalogInFlight = undefined
    })
    return catalogInFlight
  }

  /**
   * Bring the Antigravity route onto the best Google account this machine holds.
   *
   * The catalog is account-scoped: a `free-tier` grant is served 22 rows with the
   * whole Gemini 4 family `disabled`, an Ultra grant 33 including Gemini 4 and
   * Claude Opus/Sonnet 5.5. So which grant this plugin holds decides almost the
   * entire model list, and the machine usually holds several — `agy`, the
   * Antigravity IDE and sibling plugins all leave their grants behind.
   *
   * This runs at mount and again on every write to the credential store, which is
   * what makes adoption invisible: sign in to the IDE and the picker grows on the
   * next open, with nothing to paste.
   *
   * Telling an inherited account from a chosen one needs no extra bookkeeping,
   * because the two land in different halves of the store: adoption copies a grant
   * out of `refs:`, while `/subproxy login` writes a record of its own and leaves
   * `refs:` alone. So a stored refresh token that appears nowhere in `refs:` was
   * signed in here, by hand, and outranks anything the machine happens to carry —
   * including across restarts, which an in-memory flag could not survive.
   *
   * @returns {Promise<boolean>} whether the route moved to another account.
   */
  const adoptAccount = async () => {
    const existing = await readGrant(ROUTE_GEMINI)
    const owned =
      existing !== undefined && typeof existing.access_token === 'string' && existing.access_token !== ''
    const readPlan = async (grant) => {
      const probe = await probeAccount(grant, {
        clientId: googleClientId(),
        clientSecret: googleClientSecret(),
      }).catch(() => undefined)
      if (probe !== undefined) {
        accountTier = probe.tier
        accountPaid = probe.paid
      }
      return probe
    }
    // Signed in during this process: nothing below may take the account away.
    if (owned && explicitLogin) {
      await readPlan(existing)
      return false
    }
    const candidates = await discoverAccounts({
      clientId: googleClientId(),
      clientSecret: googleClientSecret(),
    }).catch(() => [])
    let current
    if (owned) {
      const probe = await readPlan(existing)
      const chosen =
        candidates.length === 0 ||
        candidates.every((candidate) => candidate.grant?.refresh_token !== existing.refresh_token)
      current = { rank: probe?.rank, explicit: chosen, refresh: existing.refresh_token }
    }
    const best = preferAccount(current, candidates)
    if (best === undefined) return false
    const { grant } = best
    const expires = grant.expires ?? Date.now() + 3600_000
    await credentials
      .modify(ROUTE_GEMINI, (stored) => {
        // An explicit `/subproxy login` may land while the probe is in flight;
        // it always wins. A hand-configured API key outranks both.
        if (explicitLogin) return undefined
        if (stored !== undefined && stored.type === 'api_key') return undefined
        return {
          type: 'oauth',
          access: grant.access_token,
          refresh: grant.refresh_token,
          expires,
          access_token: grant.access_token,
          refresh_token: grant.refresh_token,
          expiry: grant.expiry ?? new Date(expires).toISOString(),
          token_type: grant.token_type ?? 'Bearer',
          ...(grant.scope === undefined ? {} : { scope: grant.scope }),
          ...(grant.email === undefined ? {} : { email: grant.email }),
          ...(grant.sub === undefined ? {} : { sub: grant.sub }),
          ...(best.project === undefined ? {} : { cloudaicompanionProject: best.project }),
        }
      })
      .catch((error) => logger.warn('采纳本机已有 Google 账号失败', error))
    accountTier = best.tier
    accountPaid = best.paid
    logger.info(
      `[dsh-subproxy] 已${current === undefined ? '采纳' : '切换到'}本机 Google 账号（${best.name}，套餐 ${
        planLabel({ tier: best.tier, paid: best.paid }) || best.tier
      }）`,
    )
    return true
  }

  const providers = buildProviders({
    catalog: () => catalog ?? FALLBACK_MODELS,
    login: googleLogin,
    readCredential: () => readGrant(ROUTE_GEMINI),
    refreshCredential: refreshGrant,
    projectCache,
    quotaCache,
    logger,
  })

  /**
   * Build the pi-ai profile for a route.
   *
   * @param {string} route - the route id.
   * @returns {object} the resolved profile.
   */
  const makeProfile = (route) => ({
    provider: route,
    displayName: ROUTE_NAMES[route],
    streamIdleTimeoutMs: STREAM_IDLE_TIMEOUT_MS,
    retryPolicy: resolveRetryPolicy(undefined, `dsh-subproxy ${route} retryPolicy`),
    configuredMaxTokens: new Map(),
    modelErrors: new Map(),
    ...REQUEST_IMAGE_BUDGETS,
    piProvider: providers[route],
  })

  /**
   * Build an adapter whose profile map is a *fresh* Map every time.
   *
   * `PiAiAdapter.current()` memoises on the identity of the map, so a mutated
   * map would leave the model list frozen; a new map is how a rebuild is
   * announced.
   *
   * @param {string} route - the route id.
   * @returns {{ adapter: object, invalidate: () => void }} the adapter.
   */
  const makeAdapter = (route) => {
    let profiles = new Map([[route, makeProfile(route)]])
    const adapter = new PiAiAdapter({
      profiles: () => profiles,
      auth,
      // OAuth resolution stays inside pi-ai: it reads the store, refreshes when
      // the grant is inside the lead window, and derives the request auth.
      resolveApiKey: async () => undefined,
      resolveAttachments: () => ctx.get('attachments'),
      resolveImageAccess: (attachments, ref) =>
        resolveImageAttachmentAccess(attachments, (hostPath) => ctx.get('fs')?.processPathFromHostPath(hostPath), ref),
    })
    return {
      adapter,
      invalidate: () => {
        profiles = new Map([[route, makeProfile(route)]])
      },
    }
  }

  const adapters = {}
  for (const route of ROUTES) adapters[route] = makeAdapter(route)

  // One try per route, deliberately: `registerAdapter` validates the candidate
  // set as a unit and throws `DUPLICATE_ADAPTER` on a clash, so a host that
  // already claims one of these ids should cost that route alone.
  const releases = []
  for (const route of ROUTES) {
    try {
      releases.push(ctx.llm.registerAdapter([route], adapters[route].adapter))
    } catch (error) {
      logger.error(`路由 ${route} 注册失败`, error)
    }
  }
  if (releases.length === 0) {
    logger.error('三条路由全部注册失败，插件不提供服务')
    return
  }
  ctx.on('dispose', () => {
    for (const release of releases) {
      try {
        release()
      } catch {
        // Already disposed by the fiber.
      }
    }
  })

  /**
   * Run pi-ai's own OAuth for a re-homed route.
   *
   * @param {string} route - the route id.
   * @param {object} session - the authorization session.
   * @returns {Promise<void>} resolves once the credential is stored.
   */
  const runOAuth = async (route, session) => {
    const models = createModels(auth)
    models.setProvider(providers[route])
    await models.login(route, 'oauth', {
      signal: session.signal,
      notify: (event) => {
        if (event.type === 'auth_url') {
          session.notify({
            kind: 'auth_url',
            message: '在浏览器里打开下面的链接完成授权。',
            url: event.url,
          })
          return
        }
        if (event.type === 'device_code') {
          session.notify({
            kind: 'device_code',
            message: `在任意设备上打开下面的网址输入代码（${Math.round(
              (event.expiresInSeconds ?? 900) / 60,
            )} 分钟内有效）：`,
            url: event.verificationUri,
            code: event.userCode,
          })
          return
        }
        if (event.type === 'info' || event.type === 'progress') {
          session.notify({ kind: 'info', message: event.message })
        }
      },
      prompt: (prompt) => {
        if (prompt.type === 'select') {
          return session.prompt({ kind: 'select', message: prompt.message, options: prompt.options })
        }
        if (prompt.type === 'secret') {
          return session.prompt({ kind: 'secret', message: prompt.message, placeholder: prompt.placeholder })
        }
        // `manual_code` lands here, which is what makes signing in possible on a
        // phone: the browser cannot call back, so the user pastes instead.
        return session.prompt({ kind: 'text', message: prompt.message, placeholder: prompt.placeholder })
      },
    })
    adapters[route]?.invalidate()
    if (route === ROUTE_GEMINI) {
      // A deliberate sign-in pins this account: the watcher below may still
      // adopt a better plan for an inherited route, but never over a choice the
      // user just made by hand.
      explicitLogin = true
      const grant = await readGrant(ROUTE_GEMINI)
      if (grant !== undefined) {
        const probe = await probeAccount(grant, {
          clientId: googleClientId(),
          clientSecret: googleClientSecret(),
        }).catch(() => undefined)
        if (probe !== undefined) {
          accountTier = probe.tier
          accountPaid = probe.paid
        }
      }
      await loadCatalog({ force: true })
    }
  }

  // The flows are what the sign-in surface lists. Registering them under the
  // plugin's own scope keeps them apart from the host's `llm-pi-ai` flows, which
  // would otherwise write the credential into a record this plugin never reads.
  ctx.inject(['authorization'], (scope) => {
    for (const route of ROUTES) {
      scope.authorization.registerFlow({
        key: recordKeyFor(route),
        label: ROUTE_NAMES[route],
        methods: [{ id: 'oauth', label: OAuthMethodLabel(route) }],
        async run(session) {
          await runOAuth(route, session)
        },
      })
    }
  })

  // ── Sign-in over a slash command ──────────────────────────────────────────
  //
  // The web and phone surfaces expose no authorization RPC: `authorization/*`
  // has exactly one endpoint in the whole host, an `authorization/settled`
  // event, so a registered flow has no button anywhere on them. A slash command
  // is the one interactive seam every surface renders, and its handler returns
  // exactly one result, so the sign-in is split across two invocations:
  // `/subproxy login <route>` starts the flow and prints the URL, then
  // `/subproxy code <pasted redirect>` answers the pending prompt that pi-ai's
  // `manual_code` is waiting on. That is the same paste-the-callback path the
  // phone needs anyway, because a browser on another device cannot reach this
  // process's loopback listener.
  const pending = new Map()

  /** How long a started flow may take to emit its URL before the command returns. */
  const SETTLE_MS = 1_200

  /**
   * Wait a bounded moment so a just-started flow can emit its first notice.
   *
   * @param {number} ms - the budget.
   * @returns {Promise<void>} resolves after the budget at the latest.
   */
  const settle = (ms) =>
    new Promise((resolve) => {
      const timer = setTimeout(resolve, ms)
      timer.unref?.()
    })
  /**
   * Collect the notices a background sign-in produced.
   *
   * `waitFor` is what makes a two-step command honest: the interesting notice
   * (the URL, or the device code) arrives after a network round-trip to the
   * identity provider, so a fixed sleep either returns too early and prints
   * nothing, or pads every login by seconds. A push that carries a notice
   * wakes the waiter instead.
   *
   * @returns {{ lines: string[], saw: Set<string>, notices: object[], push: Function, take: Function, waitFor: Function }} the collector.
   */
  /**
   * The few notices pi-ai words for a terminal, rewritten for a phone.
   *
   * Matched on a prefix so a trailing status suffix does not defeat the lookup;
   * anything unrecognised passes through untouched rather than being swallowed.
   */
  const NOTICE_TEXT = [
    ['Exchanging authorization code for tokens', '正在用授权码换取令牌…'],
    ['Exchanging', '正在换取令牌…'],
    ['Complete login in your browser', '在浏览器里完成登录。'],
    ['Waiting for authorization', '正在等待授权…'],
    ['Opening browser', '正在打开浏览器…'],
    ['Login cancelled', '登录已取消。'],
    ['Verifying', '正在验证…'],
  ]

  /**
   * Translate one upstream notice for a phone screen.
   *
   * @param {string} message - pi-ai's own wording.
   * @returns {string} the wording a human here can act on.
   */
  const translateNotice = (message) => {
    if (typeof message !== 'string') return ''
    const hit = NOTICE_TEXT.find(([prefix]) => message.startsWith(prefix))
    return hit === undefined ? message : hit[1]
  }

  const makeCollector = () => {
    const lines = []
    const saw = new Set()
    /**
     * The structured half of what came through: a browser surface has to put the
     * URL behind a link and the code in its own box, so the rendered line alone
     * is not enough to drive it.
     */
    const notices = []
    let wake = undefined
    const notify = () => {
      const resolve = wake
      wake = undefined
      resolve?.()
    }
    return {
      lines,
      saw,
      notices,
      push(line, kind, notice) {
        if (typeof kind === 'string') saw.add(kind)
        if (notice !== undefined && (notice.url !== undefined || notice.code !== undefined)) {
          notices.push({
            kind,
            message: translateNotice(notice.message ?? ''),
            url: notice.url,
            code: notice.code,
          })
          if (notices.length > 6) notices.shift()
        }
        if (typeof line === 'string' && line.trim() !== '') {
          lines.push(line.trim())
          if (lines.length > 12) lines.shift()
        }
        if (kind !== 'prompt') notify()
      },
      take() {
        const text = lines.join('\n')
        lines.length = 0
        return text
      },
      waitFor(ms) {
        return new Promise((resolve) => {
          const timer = setTimeout(() => {
            wake = undefined
            resolve()
          }, ms)
          timer.unref?.()
          wake = () => {
            clearTimeout(timer)
            resolve()
          }
        })
      },
    }
  }

  /**
   * pi-ai's own login-method labels, in the words a phone user needs.
   *
   * The upstream label is display copy written for a terminal; showing it
   * verbatim makes the choice look like a leftover debug line. Matched on the
   * option id rather than the label, because the label is what varies.
   */
  const methodLabel = (id, fallback) => {
    if (id.includes('device')) return '设备码（在任意设备输入一串代码，全程不用粘贴）'
    if (id.includes('browser')) return '浏览器授权（用手机自带浏览器最省事）'
    return fallback
  }

  /**
   * Render one notify event as a line a human can act on.
   *
   * @param {{ message?: string, url?: string, code?: string }} event - the notice.
   * @returns {string} the line.
   */
  const renderNotice = (event) => {
    const parts = []
    if (event.message !== undefined) parts.push(translateNotice(event.message))
    if (event.url !== undefined) parts.push(event.url)
    if (event.code !== undefined) parts.push(`代码：${event.code}`)
    return parts.join('\n')
  }

  /**
   * Turn a thrown error into one line a phone screen can read.
   *
   * pi-ai's OAuth errors carry a whole pretty-printed stack in `message`, which
   * arrives as twenty screens of the same sentence. The first line plus the
   * upstream status is everything a human can act on.
   *
   * @param {unknown} error - whatever was thrown.
   * @returns {string} one line.
   */
  const brief = (error) => {
    const raw = error?.message ?? String(error)
    const first = raw.split('\n')[0].trim()
    return first.length > 240 ? `${first.slice(0, 240)}…` : first
  }

  /**
   * Pick the login method when no human can answer a `select` prompt.
   *
   * OpenAI's flow opens with a `select` between browser login and device code,
   * and the two are not equally good on a phone. Browser login ends on
   * `http://localhost:1455/auth/callback`, which only resolves if the browser
   * runs on the same machine as this process; device code ends on
   * `auth.openai.com/codex/device`, which resolves from any device. So the
   * caller may name a preference, and only the first option is the fallback.
   *
   * @param {{ options?: { id: string }[] }} question - the select prompt.
   * @param {string | undefined} preference - `device` or `browser`.
   * @returns {string | undefined} the chosen option id.
   */
  const chooseOption = (question, preference) => {
    const options = question.options ?? []
    if (preference === 'device') {
      const device = options.find((option) => option.id.includes('device'))
      if (device !== undefined) return device.id
    }
    if (preference === 'browser') {
      const browser = options.find((option) => option.id.includes('browser'))
      if (browser !== undefined) return browser.id
    }
    return options[0]?.id
  }

  /**
   * Run a route's sign-in with no interactive surface attached.
   *
   * `outcome` is the authority on how the attempt ended: a command result must
   * never be inferred from whether the pending entry is still present, because
   * an attempt that failed a moment ago has also removed itself.
   *
   * @param {string} route - the route id.
   * @param {{ preference?: string }} [options] - how to answer method prompts.
   * @returns {{ collector: object, outcome: Promise<{ ok: boolean, text: string }> }} the attempt.
   */
  const startBackgroundLogin = (route, options = {}) => {
    const collector = makeCollector()
    const controller = new AbortController()
    const entry = { collector, controller, answer: undefined, question: undefined, outcome: undefined }
    pending.set(route, entry)
    const session = {
      signal: controller.signal,
      notify: (event) => collector.push(renderNotice(event), event.kind, event),
      prompt: (question) => {
        // A choice with a sane default is answered here: the command surface
        // cannot render a picker, and stopping to ask would strand the flow.
        // pi-ai words its own prompts in English for a terminal, so the line
        // that reaches a phone is written here instead of forwarded.
        if (question.kind === 'select') {
          const choice = chooseOption(question, options.preference)
          const raw = question.options?.find((option) => option.id === choice)?.label ?? choice
          collector.push(`登录方式：${methodLabel(choice ?? '', raw)}`, 'prompt')
          return Promise.resolve(choice)
        }
        entry.question = question
        if (question.kind === 'text' || question.kind === 'secret') {
          // The pasted-code prompt: its own message is redundant next to the
          // instructions the command appends, and printing it twice reads as a
          // bug on a small screen.
          collector.push('等待粘贴授权码：', 'prompt')
        } else {
          collector.push(question.message, 'prompt')
        }
        return new Promise((resolve, reject) => {
          entry.answer = (value) => {
            entry.answer = undefined
            entry.question = undefined
            resolve(value)
          }
          controller.signal.addEventListener('abort', () => reject(new Error('登录已取消')), { once: true })
        })
      },
    }
    const outcome = runOAuth(route, session).then(
      () => ({ ok: true, text: `已登录 ${ROUTE_NAMES[route]}。` }),
      (error) => ({ ok: false, text: `登录失败：${brief(error)}` }),
    )
    entry.outcome = outcome
    void outcome.then((settled) => {
      if (pending.get(route) === entry) pending.delete(route)
      logger.info(`[subproxy] ${route} ${settled.text}`)
    })
    return { collector, outcome }
  }

  /**
   * Answer `/subproxy` and its sub-forms.
   *
   * @param {string} rawInput - everything after the command name.
   * @returns {Promise<{ kind: 'success' | 'error', text: string }>} the result.
   */
  const runCommand = async (rawInput) => {
    const words = rawInput.trim().split(/\s+/u).filter((word) => word !== '')
    const verb = (words[0] ?? '').toLowerCase()

    if (verb === '' || verb === 'status') {
      const report = []
      for (const route of ROUTES) {
        const grant = await readGrant(route)
        const state =
          grant === undefined
            ? '未登录'
            : isExpired(grant) && isRefreshable(grant)
              ? '已登录（访问令牌已过期，下次使用会自动刷新）'
              : '已登录'
        let extra = ''
        if (route === ROUTE_GEMINI && grant !== undefined) {
          const entries = catalog ?? FALLBACK_MODELS
          const usable = entries.filter((entry) => entry.disabled !== true).length
          const plan = planLabel({ tier: accountTier, paid: accountPaid })
          const tier = plan === '' ? '' : `，套餐 ${plan}`
          const hidden = entries.length > usable ? `（另有 ${entries.length - usable} 个需升级套餐）` : ''
          extra = `，${usable} 个可用模型${hidden}${tier}`
        }
        report.push(`${route} — ${ROUTE_NAMES[route]}：${state}${extra}`)
      }
      return {
        kind: 'success',
        text: `${report.join('\n')}\n\n用法：/subproxy login <${ROUTES.join('|')}> · /subproxy code <粘贴跳转地址> · /subproxy logout <route>`,
      }
    }

    if (verb === 'login' || verb === 'code') {
      if (verb === 'code') {
        const raw = rawInput.trim().slice(words[0].length).trim()
        const target = [...pending.entries()].find(([, entry]) => entry.answer !== undefined)
        if (target === undefined) {
          return {
            kind: 'error',
            text: `没有等待输入中的登录。先运行 /subproxy login <${ROUTES.join('|')}> 拿到授权链接。`,
          }
        }
        const [route, entry] = target
        if (raw === '') return { kind: 'error', text: '要粘贴的是浏览器跳转后的完整地址，或其中的 code。' }
        entry.answer(raw)
        // The attempt resolves on its own schedule: `exchangeCode` has to reach
        // Google. Race it against a bounded wait so the command answers now and
        // still reports the attempt's real ending when that is already known.
        const settled = await Promise.race([
          entry.outcome.then((result) => ({ known: true, result })),
          settle(SETTLE_MS * 8).then(() => ({ known: false, result: undefined })),
        ])
        const noticed = entry.collector.take()
        if (settled.known) {
          const lines = [noticed, settled.result.text].filter((line) => line !== '')
          return { kind: settled.result.ok ? 'success' : 'error', text: lines.join('\n') }
        }
        return {
          kind: 'success',
          text: [noticed, `${ROUTE_NAMES[route]} 正在用这份授权完成登录，稍后用 /subproxy status 确认。`]
            .filter((line) => line !== '')
            .join('\n'),
        }
      }

      const route = (words[1] ?? '').toLowerCase()
      if (!ROUTES.includes(route)) {
        return { kind: 'error', text: `要指定路由：/subproxy login <${ROUTES.join('|')}> [device|browser]` }
      }
      const asked = (words[2] ?? '').toLowerCase()
      const preference = asked === 'device' || asked === 'browser' ? asked : undefined
      // Device code is a choice only OpenAI offers, and it is the only path that
      // finishes without the browser ever reaching this process. Asking for it
      // on a route that has no such prompt would silently fall back to browser
      // login, so refuse instead of pretending.
      if (preference === 'device' && route !== ROUTE_OPENAI) {
        return {
          kind: 'error',
          text: `${ROUTE_NAMES[route]} 只有浏览器授权一种方式。直接运行 /subproxy login ${route}，授权后把跳转地址粘回来。`,
        }
      }
      if (pending.has(route)) {
        return { kind: 'error', text: `${ROUTE_NAMES[route]} 已经有一个登录在等待输入，先把它完成或重启宿主。` }
      }
      const { collector, outcome } = startBackgroundLogin(route, { preference })
      // Wait for the actionable notice rather than a fixed sleep: the URL only
      // exists after the identity provider answers, and a short sleep printed an
      // empty command result on a slow link. The outcome also ends the wait, so
      // a flow that dies before printing a URL still answers now — but it must
      // not be pushed into the collector, or the later `/subproxy code` would
      // print the same failure twice.
      await Promise.race([collector.waitFor(SETTLE_MS * 8), outcome.then(() => {})])
      const seen = collector.take()
      if (seen === '') {
        // Nothing to act on: the flow died before it printed a URL. Reporting
        // the real reason beats "waiting for the authorization address".
        const settled = await Promise.race([outcome, settle(0).then(() => undefined)])
        if (settled !== undefined && !settled.ok) return { kind: 'error', text: settled.text }
      }
      const device = collector.saw.has('device_code')
      const header = seen === '' ? `已开始 ${ROUTE_NAMES[route]} 登录，正在等待授权地址。` : seen
      const tail = device
        ? '在手机浏览器里打开上面的网址、输入代码即可，完成后这条登录会自动结束，无需再粘贴任何东西。'
        : [
            '在浏览器里完成授权后有两种收尾：',
            '  · 浏览器就在这台机器上（手机自带的浏览器）→ 通常会自动跳回并完成，无需操作；',
            '  · 浏览器在另一台设备（比如在 PC 上打开）→ 跳转到的 localhost 地址打不开，把地址栏那一整串粘回来：',
            '/subproxy code <粘贴内容>',
            '想完全不用粘贴：OpenAI 那条线支持 /subproxy login sub-gpt device（在另一台设备输入代码即可）。',
          ].join('\n')
      return { kind: 'success', text: [header, tail].join('\n\n') }
    }

    if (verb === 'logout') {
      const route = (words[1] ?? '').toLowerCase()
      if (!ROUTES.includes(route)) {
        return { kind: 'error', text: `要指定路由：/subproxy logout <${ROUTES.join('|')}>` }
      }
      pending.get(route)?.controller.abort()
      pending.delete(route)
      await credentials.delete(route)
      adapters[route]?.invalidate()
      if (route === ROUTE_GEMINI) {
        catalog = undefined
        catalogFetchedAt = 0
        accountTier = undefined
        accountPaid = undefined
        // The choice is gone, so the watcher is free to adopt an inherited
        // account again — otherwise signing out would leave the route empty
        // until the next mount.
        explicitLogin = false
      }
      return { kind: 'success', text: `已删除 ${ROUTE_NAMES[route]} 的凭据。` }
    }

    return {
      kind: 'error',
      text: `未知子命令 "${verb}"。用法：/subproxy [status|login <route> [device]|code <粘贴>|logout <route>]`,
    }
  }

  ctx.inject(['commands'], (scope) => {
    scope.commands.register({
      name: 'subproxy',
      description: '登录或查看订阅反代路由（OpenAI / Claude / Antigravity）',
      input: { hint: `[status|login <${ROUTES.join('|')}> [device]|code <粘贴>|logout <route>]` },
      handler: (invocation) => runCommand(invocation.rawInput ?? ''),
    })
  })

  // ── The settings page's endpoint ──────────────────────────────────────────
  //
  // A slash command is the one seam every surface renders, but it is still
  // typing — and on a phone, typing a route id to sign in is the reason this
  // page exists at all. The host has no RPC for any of this (`authorization/*`
  // is a single settled event), so the browser half (`./client.js`) talks to
  // this endpoint over plain `fetch`, the one transport that behaves the same
  // in the desktop app and in DSH GO.
  //
  // Every action is delegated to `runCommand`, deliberately: two code paths that
  // both start an OAuth flow would drift, and the command is the one that has to
  // keep working when the page is not mounted.
  const UI_ENDPOINT = '/plugins/dsh-subproxy'

  /**
   * The row the settings page draws for one route.
   *
   * @param {string} route - the route id.
   * @returns {Promise<object>} the row.
   */
  const describeRoute = async (route) => {
    const grant = await readGrant(route)
    const row = {
      route,
      name: ROUTE_NAMES[route],
      signedIn: grant !== undefined,
      expired: grant === undefined ? false : isExpired(grant),
      refreshable: grant === undefined ? false : isRefreshable(grant),
      identity: grant === undefined ? '' : credentialIdentity(grant),
      plan: '',
      models: 0,
      hidden: 0,
      // Only OpenAI's flow offers a method that finishes on another device.
      supportsDeviceCode: route === ROUTE_OPENAI,
    }
    if (route !== ROUTE_GEMINI) {
      row.models = providers[route]?.getModels?.().length ?? 0
      return row
    }
    const entries = catalog ?? FALLBACK_MODELS
    const usable = entries.filter((entry) => entry.disabled !== true).length
    row.models = usable
    row.hidden = entries.length - usable
    row.plan = planLabel({ tier: accountTier, paid: accountPaid })
    // The picker is showing the hard-coded row rather than this account's real
    // catalog, which is the difference the page has to be able to explain.
    row.fallback = catalog === undefined
    return row
  }

  /**
   * What every sign-in in flight has printed so far.
   *
   * `notices` is kept apart from `text`: a page renders the URL as a link and the
   * device code in its own copyable box, and reassembling either from a
   * pre-joined line is guesswork.
   *
   * @returns {object[]} one entry per pending route.
   */
  const pendingSnapshot = () => {
    const out = []
    for (const [route, entry] of pending.entries()) {
      out.push({
        route,
        awaitingCode: entry.answer !== undefined,
        notices: (entry.collector.notices ?? []).slice(),
        text: entry.collector.lines.join('\n'),
      })
    }
    return out
  }

  /**
   * Read a JSON request body with a hard size cap.
   *
   * @param {import('node:http').IncomingMessage} request - the request.
   * @returns {Promise<{ ok: boolean, value?: any }>} the body.
   */
  const readBody = (request) =>
    new Promise((resolve) => {
      const chunks = []
      let size = 0
      let settled = false
      const finish = (result) => {
        if (settled) return
        settled = true
        resolve(result)
      }
      const timer = setTimeout(() => finish({ ok: false }), 10_000)
      timer.unref?.()
      request.on('data', (chunk) => {
        size += chunk.length
        if (size > 64 * 1024) {
          clearTimeout(timer)
          finish({ ok: false })
          try {
            request.destroy()
          } catch {
            // Already gone.
          }
          return
        }
        chunks.push(chunk)
      })
      request.on('end', () => {
        clearTimeout(timer)
        if (chunks.length === 0) return finish({ ok: true, value: undefined })
        try {
          finish({ ok: true, value: JSON.parse(Buffer.concat(chunks).toString('utf8')) })
        } catch {
          finish({ ok: false })
        }
      })
      request.on('error', () => {
        clearTimeout(timer)
        finish({ ok: false })
      })
    })

  ctx.inject(['webServer'], (scope) => {
    scope.effect(() => {
      const dispose = scope.webServer.register({
        kind: 'exact',
        path: UI_ENDPOINT,
        handler: async (request, response) => {
          const headers = {
            'Content-Type': 'application/json; charset=utf-8',
            'Cache-Control': 'no-store',
            'X-Content-Type-Options': 'nosniff',
          }
          const send = (status, payload) => {
            if (response.headersSent) return
            response.writeHead(status, headers)
            response.end(JSON.stringify(payload))
          }
          try {
            const url = new URL(request.url ?? '/', 'http://x')
            if (request.method === 'GET') {
              const rows = []
              for (const route of ROUTES) rows.push(await describeRoute(route))
              send(200, { routes: rows, pending: pendingSnapshot() })
              return
            }
            if (request.method !== 'POST') {
              response.writeHead(405, { ...headers, Allow: 'GET, POST' })
              response.end()
              return
            }
            const body = await readBody(request)
            if (!body.ok) {
              send(400, { ok: false, error: '请求体不是合法 JSON。' })
              return
            }
            const action = body.value?.action
            const route = body.value?.route
            const known = ['login', 'code', 'logout', 'status']
            if (!known.includes(action)) {
              send(400, { ok: false, error: `未知动作 ${String(action)}。` })
              return
            }
            let line = action
            if (action !== 'status') {
              if (!ROUTES.includes(route)) {
                send(400, { ok: false, error: `要指定路由：${ROUTES.join(' / ')}` })
                return
              }
              line = `${action} ${route}`
            }
            if (action === 'login' && body.value?.method === 'device') line += ' device'
            if (action === 'code') {
              const raw = typeof body.value?.value === 'string' ? body.value.value.trim() : ''
              if (raw === '') {
                send(400, { ok: false, error: '要粘贴的是浏览器跳转后的完整地址，或其中的 code。' })
                return
              }
              line = `code ${raw}`
            }
            const result = await runCommand(line)
            const rows = []
            for (const candidate of ROUTES) rows.push(await describeRoute(candidate))
            // The card below already carries the address and the code; echoing
            // the whole notice again would just push the buttons off a phone
            // screen. Failures keep their own words, which is where the reason is.
            const text =
              action === 'login' && result.kind === 'success'
                ? `已发起 ${ROUTE_NAMES[route]} 登录，按下面卡片里给的地址和代码操作。`
                : result.text
            send(200, { ok: result.kind === 'success', text, routes: rows, pending: pendingSnapshot() })
          } catch (error) {
            logger.warn('设置页端点异常', error)
            send(500, { ok: false, error: '服务内部错误，详见宿主日志。' })
          }
        },
      })
      return () => dispose()
    }, 'subproxy: settings endpoint')
  })

  // ── Absorbing accounts that appear while this plugin is running ────────────
  //
  // Adoption at mount covers the ordinary case, but not the one that actually
  // bites: the user signs in to the Antigravity IDE — or another tool writes a
  // grant — while a session is already open. Without this the new account sits
  // in the credential store unseen until the host restarts, which is exactly the
  // "why is there still only one model" complaint adoption at mount was meant to
  // answer.
  //
  // So the store's directory is watched, not the file: the host writes by
  // renaming a temp file over it, which leaves a watch on the old inode dead.
  // Every write re-runs adoption; nothing here decides policy, it only reacts.
  //
  // A scan is not free — it costs one `loadCodeAssist` per Google grant in the
  // store — and this plugin's own token refresh writes the store too, so bursts
  // are normal. Coalesce them rather than dropping any: a change that arrives
  // during a scan, or inside the cool-down, schedules one scan for later. A
  // genuine new sign-in must never be the event that gets thrown away.
  const ABSORB_MIN_INTERVAL_MS = 15_000
  let absorbAt = 0
  let absorbInFlight
  let absorbTrailing
  let stopWatching
  const absorbNow = () => {
    if (absorbInFlight !== undefined) return absorbInFlight
    absorbAt = Date.now()
    absorbInFlight = (async () => {
      let moved = false
      try {
        moved = await adoptAccount()
      } catch (error) {
        logger.warn('重新扫描本机 Google 账号失败', error)
        return
      }
      if (!moved) {
        // The same account, just re-stamped: the grants and the catalog are
        // unchanged, so the picker has nothing new to show.
        return
      }
      catalog = undefined
      catalogFetchedAt = 0
      await loadCatalog({ force: true })
      adapters[ROUTE_GEMINI]?.invalidate()
      logger.info(`[dsh-subproxy] Antigravity 目录已按新账号重建（${catalog?.length ?? 0} 条）`)
    })().finally(() => {
      absorbInFlight = undefined
    })
    return absorbInFlight
  }
  const scheduleAbsorb = () => {
    if (absorbTrailing !== undefined) return
    const wait = Math.max(0, ABSORB_MIN_INTERVAL_MS - (Date.now() - absorbAt))
    const timer = setTimeout(() => {
      absorbTrailing = undefined
      void absorbNow()
    }, wait)
    timer.unref?.()
    absorbTrailing = timer
  }
  try {
    stopWatching = watchStore(scheduleAbsorb)
  } catch (error) {
    logger.warn('监听凭据库失败，新登录的账号要重启宿主才会出现', error)
  }
  if (stopWatching !== undefined) {
    ctx.on('dispose', () => {
      if (absorbTrailing !== undefined) clearTimeout(absorbTrailing)
      absorbTrailing = undefined
      try {
        stopWatching?.()
      } catch {
        // Already closed.
      }
    })
  }

  // Warm the catalog when a grant already exists, so the picker is populated on
  // the first open rather than after the first message. Adoption comes first:
  // without it there is no grant to warm from, and the picker falls back to the
  // hard-coded entries — which is exactly what made a three-route plugin look
  // like it only had one Gemini model.
  void (async () => {
    await adoptAccount()
    const grant = await readGrant(ROUTE_GEMINI)
    if (grant === undefined) return
    if (isExpired(grant) && isRefreshable(grant)) await refreshGrant()
    const project = await resolveProject({ credential: grant, cache: projectCache }).catch(() => undefined)
    if (project?.project === '') logger.warn(`Antigravity 项目号探测失败：${project.error ?? '未知错误'}`)
    await loadCatalog({ force: true })
    adapters[ROUTE_GEMINI]?.invalidate()
    const usable = catalog?.filter((entry) => entry.disabled !== true).length
    const plan = planLabel({ tier: accountTier, paid: accountPaid })
    logger.info(
      `Antigravity 目录就绪：${usable ?? 0} 个可用模型${
        catalog === undefined ? '' : `（共 ${catalog.length}，其余档位不足）`
      }${plan === '' ? '' : `，套餐 ${plan}`}（账号 ${credentialIdentity(grant)}）`,
    )
  })().catch((error) => logger.warn('Antigravity 预热失败', error))

  logger.info(`已注册 ${releases.length} 条订阅反代路由：${ROUTES.join(', ')}（scope ${RECORD_SCOPE}）`)
}

/**
 * The label a route's sign-in method carries.
 *
 * @param {string} route - the route id.
 * @returns {string} the label.
 */
function OAuthMethodLabel(route) {
  if (route === ROUTE_GEMINI) return '使用 Google 账号登录'
  return '使用订阅账号登录'
}
