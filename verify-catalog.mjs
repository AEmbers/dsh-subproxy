/**
 * Print what the Antigravity route will actually advertise, straight from the
 * upstream — the answer to "why do I only see one model?".
 *
 * Usage: node verify-catalog.mjs
 *
 * Reads the Google accounts already signed in on this machine (the `refs:` block
 * of `~/.dsh/.credentials.yaml`, where the Antigravity IDE and agy leave them),
 * picks the best plan, fetches the live model catalog, and prints every model
 * with its tier ladder and whether the current plan can reach it.
 */
import { discoverAccounts } from './lib/antigravity/account.js'
import { clientId, clientSecret } from './lib/antigravity/oauth.js'
import { fetchAvailableModels } from './lib/antigravity/catalog.js'
import { planLabel } from './lib/antigravity/protocol.js'

const candidates = await discoverAccounts({ clientId: clientId(), clientSecret: clientSecret() })
if (candidates.length === 0) {
  console.log('本机 refs 里没有可用的 Google 账号（用 /subproxy login sub-gemini 登录一次即可）')
  process.exit(0)
}

for (const account of candidates) {
  console.log(`账号 ${account.name}  套餐 ${planLabel({ tier: account.tier, paid: account.paid })}  rank=${account.rank}`)
}
const best = candidates[0]
console.log(`\n采纳 ${best.name}`)

const result = await fetchAvailableModels(best.grant, fetch, console)
console.log(`endpoint=${result.endpoint ?? '-'}  error=${result.error ?? 'none'}  entries=${result.models.length}\n`)
for (const model of result.models) {
  const tiers = model.effortOptions === undefined ? '-' : model.effortOptions.join('/')
  const flag = model.disabled === true ? '  [需升级套餐]' : ''
  console.log(`  ${model.id.padEnd(26)} ${model.name.padEnd(24)} ${tiers.padEnd(26)}${flag}`)
}
const usable = result.models.filter((model) => model.disabled !== true)
console.log(`\n可用 ${usable.length}/${result.models.length}`)
