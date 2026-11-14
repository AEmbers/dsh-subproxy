/**
 * pi-ai's credential-store and auth-context seams over the harness credential
 * plane.
 *
 * Shape is copied from `dsh-llm-pi-ai`'s own implementation
 * (`credentialStoreFrom` / `authContextFrom`) because pi-ai only ever talks to
 * these two interfaces — but every record this module writes lives under
 * {@link RECORD_SCOPE}, not `llm-pi-ai`, so the two plugins can never hand each
 * other a record whose payload they disagree about.
 *
 * `modify` is pi-ai's ONLY write path, and it is where OAuth refresh happens:
 * pi-ai re-checks expiry inside the mutator precisely so two concurrent
 * requests cannot both rotate the same refresh token. That property comes from
 * the harness `modifyRecord`, which is cross-process exclusive; the wrapper must
 * therefore never pre-read outside it.
 *
 * @module dsh-subproxy/credentials
 */
import { homedir } from 'node:os'
import { access } from 'node:fs/promises'
import { resolve } from 'node:path'
import {
  credentialKey,
  credentialKeyId,
  credentialKeyScope,
  credentialRef,
  isCredentialKeySegment,
  isCredentialRefName,
} from '@deepseek-ai/dsh-credentials'
import { RECORD_SCOPE } from './constants.js'

/**
 * The credential-record key a route's login writes.
 *
 * @param {string} route - provider id this plugin registered.
 * @returns {string} the record key.
 */
export function recordKeyFor(route) {
  return credentialKey(RECORD_SCOPE, route)
}

/**
 * Strip `undefined` members the way the credential store expects.
 *
 * pi-ai's OAuth grants are built with explicit `undefined` members (a spread of
 * an optional field), and the store's strict schema rejects them; an array
 * member that is `undefined` becomes `null` so positions are preserved.
 *
 * @param {unknown} value - anything JSON-shaped.
 * @returns {unknown} the same shape without `undefined`.
 */
function jsonImage(value) {
  if (Array.isArray(value)) return value.map((entry) => (entry === undefined ? null : jsonImage(entry)))
  if (value === null || typeof value !== 'object') return value
  const out = {}
  for (const [key, entry] of Object.entries(value)) {
    if (entry === undefined) continue
    out[key] = jsonImage(entry)
  }
  return out
}

/**
 * Read a stored record back as a pi-ai credential.
 *
 * @param {{ kind: string, key?: string, env?: unknown, payload?: unknown } | undefined} record - stored record or undefined.
 * @returns {object | undefined} pi-ai credential.
 */
function toPiCredential(record) {
  if (record === undefined) return undefined
  if (record.kind === 'api-key') {
    return {
      type: 'api_key',
      ...(record.key === undefined ? {} : { key: record.key }),
      ...(record.env === undefined ? {} : { env: record.env }),
    }
  }
  return record.payload
}

/**
 * Turn a pi-ai credential into a storable record.
 *
 * @param {object} credential - pi-ai credential.
 * @returns {{ kind: string }} the record.
 */
function toRecord(credential) {
  if (credential.type === 'api_key') {
    return {
      kind: 'api-key',
      ...(credential.key === undefined ? {} : { key: credential.key }),
      ...(credential.env === undefined ? {} : { env: credential.env }),
    }
  }
  return { kind: 'grant', payload: jsonImage(credential) }
}

/**
 * The credential service, refusing with an actionable error when the
 * composition mounts none.
 *
 * @param {import('@deepseek-ai/cordis').Context} ctx - plugin context.
 * @returns {object} the credential provider.
 */
function writableStore(ctx) {
  const credentials = ctx.get('credentials')
  if (credentials === undefined) {
    const error = new Error(
      'dsh-subproxy: this composition mounts no credentials service, so there is nowhere to store the credential a sign-in produces; mount one (dsh-credentials-local) to sign in',
    )
    error.code = 'NO_CREDENTIAL_STORE'
    throw error
  }
  return credentials
}

/**
 * Build pi-ai's `CredentialStore` over the harness credential plane.
 *
 * @param {import('@deepseek-ai/cordis').Context} ctx - plugin context.
 * @returns {object} the store to hand pi-ai.
 */
export function credentialStoreFrom(ctx) {
  return {
    async read(providerId) {
      const credentials = ctx.get('credentials')
      if (credentials === undefined) return undefined
      if (!isCredentialKeySegment(providerId)) return undefined
      return toPiCredential(await credentials.readRecord(recordKeyFor(providerId)))
    },
    async list() {
      const stored = (await ctx.get('credentials')?.listRecords()) ?? []
      const mine = []
      for (const entry of stored) {
        if (credentialKeyScope(entry.key) !== RECORD_SCOPE) continue
        mine.push({
          providerId: credentialKeyId(entry.key),
          type: entry.kind === 'api-key' ? 'api_key' : 'oauth',
        })
      }
      return mine
    },
    async modify(providerId, mutate) {
      if (!isCredentialKeySegment(providerId)) {
        const error = new Error(
          `dsh-subproxy: provider id "${providerId}" cannot address a stored credential record (a record id is a lowercase hyphenated identifier)`,
        )
        error.code = 'UNSTORABLE_PROVIDER_ID'
        throw error
      }
      return toPiCredential(
        await writableStore(ctx).modifyRecord(recordKeyFor(providerId), async (current) => {
          const next = await mutate(toPiCredential(current))
          return next === undefined ? undefined : toRecord(next)
        }),
      )
    },
    async delete(providerId) {
      if (!isCredentialKeySegment(providerId)) return
      await writableStore(ctx).deleteRecord(recordKeyFor(providerId))
    },
  }
}

/**
 * Build pi-ai's `AuthContext` over the harness credential plane and the host
 * filesystem.
 *
 * `env()` answers from the credential seam first, so a value stored through the
 * harness is visible to a provider's own ambient discovery. `fileExists()`
 * answers about the process's filesystem rather than the workspace `fs` seam,
 * because the paths asked about belong to where this process runs.
 *
 * @param {import('@deepseek-ai/cordis').Context} ctx - plugin context.
 * @returns {object} the auth context to hand pi-ai.
 */
export function authContextFrom(ctx) {
  return {
    async env(name) {
      if (isCredentialRefName(name)) {
        const hit = await ctx.get('credentials')?.resolve(credentialRef(name))
        if (hit !== undefined) return hit.value
      }
      return process.env[name]
    },
    async fileExists(path) {
      const expanded =
        path.startsWith('~/') || path === '~' ? resolve(homedir(), path.slice(1).replace(/^\//, '')) : path
      try {
        await access(expanded)
        return true
      } catch {
        return false
      }
    },
  }
}
