/**
 * Route identities and shared strings.
 *
 * The three routes are deliberately NOT named after pi-ai's built-in provider
 * ids (`openai-codex`, `anthropic`): the host's own `llm-pi-ai` plugin can
 * register those ids from its settings, and `registerAdapter` is all-or-nothing
 * — a colliding route answers `DUPLICATE_ADAPTER` and the whole batch is
 * refused. Namespacing under `sub-` keeps the two plugins independent.
 *
 * @module dsh-subproxy/constants
 */

/** Credential-record scope. Distinct from `llm-pi-ai` so the two stores never
 * hand each other a record they cannot parse. */
export const RECORD_SCOPE = 'dsh-subproxy'

/** Subscription route for OpenAI (ChatGPT Plus/Pro, Codex wire). */
export const ROUTE_OPENAI = 'sub-gpt'
/** Subscription route for Anthropic (Claude Pro/Max). */
export const ROUTE_CLAUDE = 'sub-claude'
/** Subscription route for Google Antigravity (Gemini Code Assist). */
export const ROUTE_GEMINI = 'sub-gemini'

/** Display names shown in the model picker. */
export const ROUTE_NAMES = {
  [ROUTE_OPENAI]: '订阅 · OpenAI (ChatGPT Plus/Pro)',
  [ROUTE_CLAUDE]: '订阅 · Claude (Pro/Max)',
  [ROUTE_GEMINI]: '订阅 · Antigravity (Gemini)',
}

/** Every route this plugin owns, in picker order. */
export const ROUTES = [ROUTE_OPENAI, ROUTE_CLAUDE, ROUTE_GEMINI]

/** Idle ceiling while one upstream stream read is outstanding. */
export const STREAM_IDLE_TIMEOUT_MS = 300_000

/** pi-ai's declared image-request budgets (its own defaults). */
export const REQUEST_IMAGE_BUDGETS = {
  maxRequestImageBytes: 20_971_520,
  requestImagePixelBudget: 4_194_304,
  requestImageMaxBytes: 1_048_576,
}
