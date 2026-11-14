/**
 * Send one real prompt through the Antigravity lane's own provider stack.
 *
 * Proves the picker ids resolve to a live upstream id and that the SSE frames
 * turn into pi-ai events — the part a catalog listing does not cover.
 */
import { discoverAccounts } from './lib/antigravity/account.js'
import { clientId, clientSecret } from './lib/antigravity/oauth.js'
import { fetchAvailableModels } from './lib/antigravity/catalog.js'
import { buildProviders } from './lib/providers.js'

const candidates = await discoverAccounts({ clientId: clientId(), clientSecret: clientSecret() })
const best = candidates[0]
if (best === undefined) throw new Error('没有可用账号')
const grant = best.grant
const catalog = await fetchAvailableModels(grant, fetch, console)
console.log(`账号 ${best.name}  套餐 ${best.paid ?? best.tier}  目录 ${catalog.models.length} 条\n`)

const providers = buildProviders({
  catalog: () => catalog.models,
  login: async () => {
    throw new Error('not used')
  },
  readCredential: async () => grant,
  refreshCredential: async () => grant,
  projectCache: new Map(),
  logger: console,
})

const provider = providers['sub-gemini']
for (const modelId of process.argv.slice(2)) {
  const model = provider.getModels().find((entry) => entry.id === modelId)
  if (model === undefined) {
    console.log(`${modelId}: 不在目录里`)
    continue
  }
  const lines = []
  let stop
  try {
    const stream = provider.stream(
      model,
      { messages: [{ role: 'user', content: '用一句话说明你在哪个模型上回答。' }] },
      { reasoning: 'medium', signal: AbortSignal.timeout(60_000) },
    )
    for await (const event of stream) {
      if (event.type === 'text_delta') lines.push(event.delta)
      if (event.type === 'error') stop = `ERROR ${event.error?.errorMessage ?? JSON.stringify(event.error)}`
      if (event.type === 'done') stop = `done/${event.message?.stopReason ?? '?'}`
    }
  } catch (error) {
    stop = `THROW ${error?.message}`
  }
  console.log(`${modelId.padEnd(22)} ${stop}`)
  console.log(`   ${lines.join('').slice(0, 160)}`)
}
