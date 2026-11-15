/**
 * The three provider objects this plugin exposes.
 *
 * Two of them are re-homed: pi-ai already ships a working OpenAI Codex and
 * Anthropic adapter, so those are taken as-is and only their *route id* is
 * rewritten. Re-implementing them would buy nothing and would drift.
 *
 * The third has no pi-ai equivalent at all — Cloud Code Assist is not one of the
 * ten `KnownApi` protocols — so its `stream`/`streamSimple` are this plugin's own
 * (see `./antigravity/stream.js`).
 *
 * Rewriting the route id is not cosmetic. The host's own `llm-pi-ai` plugin
 * already registers `openai-codex` and `anthropic`, and two adapters claiming one
 * route is a `DUPLICATE_ADAPTER` throw that takes the whole batch down with it.
 *
 * @module dsh-subproxy/providers
 */
import { createProvider } from '@earendil-works/pi-ai'
import { openaiCodexProvider } from '@earendil-works/pi-ai/providers/openai-codex'
import { anthropicProvider } from '@earendil-works/pi-ai/providers/anthropic'

import {
  ROUTE_CLAUDE,
  ROUTE_GEMINI,
  ROUTE_NAMES,
  ROUTE_OPENAI,
} from './constants.js'
import { FALLBACK_MODELS } from './antigravity/catalog.js'
import {
  CONTEXT_WINDOW,
  DEFAULT_EFFORT,
  EFFORT_IDS,
  MAX_OUTPUT_TOKENS,
} from './antigravity/protocol.js'
import { refreshCredential } from './antigravity/oauth.js'
import { streamAntigravity, streamSimpleAntigravity, thinkingLevelMap } from './antigravity/stream.js'

/** The `api` tag the Antigravity models carry. */
const ANTIGRAVITY_API = 'antigravity-code-assist'

/**
 * Cost table for a subscription route.
 *
 * A subscription has no per-token price, but pi-ai's `Usage.cost` is required and
 * a zero rate is the honest answer: nothing is billed per token, the quota is
 * spent instead. Leaving it zeroed also keeps the harness's spend meter from
 * inventing a number for traffic the user already paid for.
 */
const FREE_RATE = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }

/**
 * Re-home a pi-ai provider under this plugin's route id.
 *
 * @param {object} base - the shipped provider.
 * @param {string} route - the route id to claim.
 * @returns {object} the provider, serving the same models under `route`.
 */
function rehome(base, route) {
  const models = base.getModels().map((model) => ({ ...model, provider: route }))
  return createProvider({
    id: route,
    name: ROUTE_NAMES[route],
    baseUrl: base.baseUrl,
    auth: base.auth,
    models,
    api: { stream: base.stream, streamSimple: base.streamSimple },
  })
}

/**
 * Build the Antigravity provider.
 *
 * `getModels` is rebuilt on every call rather than snapshotted: the catalog is
 * fetched lazily after the first successful sign-in, and a snapshot taken at
 * construction time would serve the single fallback model forever.
 *
 * @param {object} deps - provider dependencies.
 * @returns {object} the provider.
 */
function antigravityProvider(deps) {
  const models = () => {
    const entries = deps.catalog() ?? FALLBACK_MODELS
    // A `disabled` row is real in the catalog and unusable in a request: the
    // upstream answers `404 Requested entity was not found` for every tier of it
    // (that is how a free-tier grant sees Gemini 4 and Claude 5.5). Offering it
    // in the picker only produces a failed turn, so it is left out and the reason
    // is logged once per catalog instead.
    const usable = entries.filter((entry) => entry.disabled !== true)
    const blocked = entries.length - usable.length
    if (blocked > 0) {
      deps.logger?.info?.(
        `[dsh-subproxy] ${blocked} 个 Antigravity 模型当前账号档位不可用，已隐藏（升级 Google AI 套餐后自动出现）`,
      )
    }
    return usable.map((entry) => ({
      id: entry.id,
      name: entry.name,
      api: ANTIGRAVITY_API,
      provider: ROUTE_GEMINI,
      baseUrl: '',
      reasoning: true,
      thinkingLevelMap: thinkingLevelMap(entry.effortOptions),
      input: entry.supportsImage === true ? ['text', 'image'] : ['text'],
      cost: FREE_RATE,
      contextWindow: entry.contextWindow ?? CONTEXT_WINDOW,
      maxTokens: entry.maxTokens ?? MAX_OUTPUT_TOKENS,
    }))
  }

  const base = createProvider({
    id: ROUTE_GEMINI,
    name: ROUTE_NAMES[ROUTE_GEMINI],
    baseUrl: '',
    auth: {
      oauth: {
        name: 'Google Antigravity (Gemini)',
        isSubscription: true,
        loginLabel: '使用 Google 账号登录',
        login: deps.login,
        refresh: refreshCredential,
        toAuth: async (credential) => ({ apiKey: credential.access }),
      },
    },
    models: models(),
    api: {
      stream: (model, context, options) =>
        streamAntigravity(model, context, options, {
          readCredential: deps.readCredential,
          refreshCredential: deps.refreshCredential,
          projectCache: deps.projectCache,
          quotaCache: deps.quotaCache,
          logger: deps.logger,
          catalog: deps.catalog,
        }),
      streamSimple: (model, context, options) =>
        streamSimpleAntigravity(model, context, options, {
          readCredential: deps.readCredential,
          refreshCredential: deps.refreshCredential,
          projectCache: deps.projectCache,
          quotaCache: deps.quotaCache,
          logger: deps.logger,
          catalog: deps.catalog,
        }),
    },
  })

  // `createProvider` freezes `input.models`; this keeps the picker live.
  return { ...base, getModels: models }
}

/**
 * Build all three providers.
 *
 * @param {object} deps - dependencies for the Antigravity lane.
 * @returns {{ [route: string]: object }} provider per route id.
 */
export function buildProviders(deps) {
  return {
    [ROUTE_OPENAI]: rehome(openaiCodexProvider(), ROUTE_OPENAI),
    [ROUTE_CLAUDE]: rehome(anthropicProvider(), ROUTE_CLAUDE),
    [ROUTE_GEMINI]: antigravityProvider(deps),
  }
}

/**
 * The tiers an Antigravity model serves.
 *
 * Kept for the request builder's use; the provider resolves this itself from the
 * catalog it was handed.
 *
 * @param {object[] | undefined} entries - the catalog.
 * @param {string} modelId - the model id.
 * @returns {string[]} the tiers.
 */
export function effortOptionsFor(entries, modelId) {
  const entry = entries?.find((candidate) => candidate.id === modelId)
  return entry?.effortOptions ?? EFFORT_IDS
}

export { DEFAULT_EFFORT }
