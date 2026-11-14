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
  STREAM_IDLE_TIMEOUT_MS,
} from './constants.js'
import { authContextFrom, credentialStoreFrom, recordKeyFor } from './credentials.js'
import { buildProviders } from './providers.js'
import { CATALOG_TTL_MS, FALLBACK_MODELS, fetchAvailableModels } from './antigravity/catalog.js'
import { credentialIdentity, resolveProject } from './antigravity/project.js'
import { isExpired, isRefreshable, parseCredential } from './antigravity/protocol.js'
import { login as googleLogin, refreshCredential as googleRefresh } from './antigravity/oauth.js'

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

  const providers = buildProviders({
    catalog: () => catalog ?? FALLBACK_MODELS,
    login: googleLogin,
    readCredential: () => readGrant(ROUTE_GEMINI),
    refreshCredential: refreshGrant,
    projectCache,
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
            message: event.instructions ?? '在浏览器里打开这个链接完成登录。',
            url: event.url,
          })
          return
        }
        if (event.type === 'device_code') {
          session.notify({
            message: '在验证页面输入下面的代码完成登录。',
            url: event.verificationUri,
            code: event.userCode,
          })
          return
        }
        if (event.type === 'info' || event.type === 'progress') {
          session.notify({ message: event.message })
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
    if (route === ROUTE_GEMINI) await loadCatalog({ force: true })
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
   * @returns {{ lines: string[], push: (line: string) => void, take: () => string }} the collector.
   */
  const makeCollector = () => {
    const lines = []
    return {
      lines,
      push(line) {
        if (typeof line !== 'string' || line.trim() === '') return
        lines.push(line.trim())
        if (lines.length > 12) lines.shift()
      },
      take() {
        const text = lines.join('\n')
        lines.length = 0
        return text
      },
    }
  }

  /**
   * Render one notify event as a line a human can act on.
   *
   * @param {{ message?: string, url?: string, code?: string }} event - the notice.
   * @returns {string} the line.
   */
  const renderNotice = (event) => {
    const parts = []
    if (event.message !== undefined) parts.push(event.message)
    if (event.url !== undefined) parts.push(event.url)
    if (event.code !== undefined) parts.push(`代码：${event.code}`)
    return parts.join('\n')
  }

  /**
   * Pick the method a route defaults to when no human can be asked.
   *
   * OpenAI's flow opens with a `select` between browser login and device code;
   * on a phone the browser path is the one that works, because the paste channel
   * covers the callback that cannot reach this process.
   *
   * @param {{ options?: { id: string }[] }} question - the select prompt.
   * @returns {string | undefined} the chosen option id.
   */
  const defaultChoice = (question) => question.options?.[0]?.id

  /**
   * Run a route's sign-in with no interactive surface attached.
   *
   * `outcome` is the authority on how the attempt ended: a command result must
   * never be inferred from whether the pending entry is still present, because
   * an attempt that failed a moment ago has also removed itself.
   *
   * @param {string} route - the route id.
   * @returns {{ collector: object, outcome: Promise<{ ok: boolean, text: string }> }} the attempt.
   */
  const startBackgroundLogin = (route) => {
    const collector = makeCollector()
    const controller = new AbortController()
    const entry = { collector, controller, answer: undefined, question: undefined, outcome: undefined }
    pending.set(route, entry)
    const session = {
      signal: controller.signal,
      notify: (event) => collector.push(renderNotice(event)),
      prompt: (question) => {
        // A choice with a sane default is answered here: the command surface
        // cannot render a picker, and stopping to ask would strand the flow.
        if (question.kind === 'select') {
          const choice = defaultChoice(question)
          const label = question.options?.find((option) => option.id === choice)?.label ?? choice
          collector.push(`${question.message} ${label}`)
          return Promise.resolve(choice)
        }
        entry.question = question
        collector.push(question.message)
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
      (error) => ({ ok: false, text: `登录失败：${error?.message ?? String(error)}` }),
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
        report.push(`${route} — ${ROUTE_NAMES[route]}：${state}`)
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
        return { kind: 'error', text: `要指定路由：/subproxy login <${ROUTES.join('|')}>` }
      }
      if (pending.has(route)) {
        return { kind: 'error', text: `${ROUTE_NAMES[route]} 已经有一个登录在等待输入，先把它完成或重启宿主。` }
      }
      const { collector, outcome } = startBackgroundLogin(route)
      await settle(SETTLE_MS)
      const seen = collector.take()
      void outcome
      return {
        kind: 'success',
        text: [
          seen === '' ? `已开始 ${ROUTE_NAMES[route]} 登录，正在等待授权地址。` : seen,
          `在浏览器里完成授权后，把跳转后的完整地址（或其中的 code）粘贴回来：\n/subproxy code <粘贴内容>`,
        ].join('\n\n'),
      }
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
      }
      return { kind: 'success', text: `已删除 ${ROUTE_NAMES[route]} 的凭据。` }
    }

    return {
      kind: 'error',
      text: `未知子命令 "${verb}"。用法：/subproxy [status|login <route>|code <粘贴>|logout <route>]`,
    }
  }

  ctx.inject(['commands'], (scope) => {
    scope.commands.register({
      name: 'subproxy',
      description: '登录或查看订阅反代路由（OpenAI / Claude / Antigravity）',
      input: { hint: `[status|login <${ROUTES.join('|')}>|code <粘贴>|logout <route>]` },
      handler: (invocation) => runCommand(invocation.rawInput ?? ''),
    })
  })

  // Warm the catalog when a grant already exists, so the picker is populated on
  // the first open rather than after the first message.
  void (async () => {
    const grant = await readGrant(ROUTE_GEMINI)
    if (grant === undefined) return
    if (isExpired(grant) && isRefreshable(grant)) await refreshGrant()
    const project = await resolveProject({ credential: grant, cache: projectCache }).catch(() => undefined)
    if (project?.project === '') logger.warn(`Antigravity 项目号探测失败：${project.error ?? '未知错误'}`)
    await loadCatalog({ force: true })
    adapters[ROUTE_GEMINI]?.invalidate()
    logger.info(`Antigravity 目录就绪：${catalog?.length ?? 0} 个模型（账号 ${credentialIdentity(grant)}）`)
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
