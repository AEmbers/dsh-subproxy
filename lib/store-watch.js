/**
 * Notice when another tool signs a subscription account in.
 *
 * The whole point of adopting an account is that the user should never have to
 * tell this plugin about it: they sign in to the Antigravity IDE, or to a sibling
 * plugin, or to `agy` on another day, and the model picker should simply grow the
 * next time it is opened. That means watching the credential store rather than
 * reading it once at mount.
 *
 * Two details make this less obvious than it looks:
 *
 * - **The directory is watched, not the file.** The harness writes the store by
 *   replacing it (write a temp file, rename over the target), so a watch on the
 *   file itself is bound to an inode that stops existing on the first write. The
 *   directory keeps its identity, so the watch survives every rewrite.
 * - **Events are debounced and then filtered by the caller, not here.** One write
 *   can produce several notifications, and a burst of events is not a reason to
 *   probe the upstream once per event.
 *
 * A missing directory is not an error: a fresh install has no `~/.dsh` yet, so the
 * watch is retried slowly until the tree appears.
 *
 * @module dsh-subproxy/store-watch
 */
import { realpathSync, watch } from 'node:fs'
import { basename, dirname } from 'node:path'

import { credentialStorePath } from './antigravity/account.js'

/** How long a burst of events is collapsed into one callback. */
const DEBOUNCE_MS = 400

/** How long to wait before re-arming a watch whose directory vanished. */
const REARM_MS = 5_000

/**
 * Resolve a directory to the exact spelling the OS reports events under.
 *
 * Windows hands back 8.3 short names (`ADMINI~1`) for some paths — the harness
 * home and `TMP` are both prone to it — while the directory events it later
 * reports carry the long name. libuv compares the two byte-for-byte and trips an
 * assertion (`fs-event.c`, `!_wcsnicmp(filename, dir, dirlen)`) that aborts the
 * whole process, so watching an unresolved directory can take the host down.
 * `realpathSync.native` is the one call that returns the long form.
 *
 * @param {string} directory - the directory to watch.
 * @returns {string} its canonical spelling when it exists, else the input.
 */
function canonicalDirectory(directory) {
  try {
    return realpathSync.native(directory)
  } catch {
    // Missing (a fresh install has no `~/.dsh` yet) or unreadable: keep the path
    // as given and let the watch retry decide.
    return directory
  }
}

/**
 * Watch the credential store for changes made by anything other than this plugin.
 *
 * @param {() => void} onChange - called (debounced) after the store is written.
 * @param {object} [options] - injection.
 * @param {string} [options.path] - the store file; defaults to the harness store.
 * @param {number} [options.debounceMs] - collapse window.
 * @returns {() => void} a disposer; safe to call more than once.
 */
export function watchStore(onChange, options = {}) {
  const target = options.path ?? credentialStorePath()
  const file = basename(target)
  const debounceMs = options.debounceMs ?? DEBOUNCE_MS

  let watcher
  let timer
  let rearm
  let disposed = false

  const fire = () => {
    timer = undefined
    if (disposed) return
    try {
      onChange()
    } catch {
      // A throwing callback must not take the watch down with it: the next write
      // is still worth hearing about.
    }
  }

  const schedule = () => {
    if (disposed) return
    if (timer !== undefined) clearTimeout(timer)
    timer = setTimeout(fire, debounceMs)
    timer.unref?.()
  }

  const arm = () => {
    if (disposed) return
    try {
      watcher = watch(canonicalDirectory(dirname(target)), { persistent: false }, (_event, changed) => {
        // Some platforms report no filename at all, which is a reason to look
        // rather than a reason to skip.
        if (typeof changed === 'string' && changed !== '' && changed !== file) {
          if (!changed.includes('credential')) return
        }
        schedule()
      })
    } catch {
      // The directory does not exist yet (or the platform has no watch): retry
      // slowly, unref'd so a headless run can still exit.
      rearm = setTimeout(() => {
        rearm = undefined
        arm()
      }, REARM_MS)
      rearm.unref?.()
      return
    }
    watcher.on?.('error', () => {
      watcher?.close?.()
      watcher = undefined
      if (!disposed) arm()
    })
  }

  arm()

  return () => {
    if (disposed) return
    disposed = true
    if (timer !== undefined) clearTimeout(timer)
    if (rearm !== undefined) clearTimeout(rearm)
    timer = undefined
    rearm = undefined
    watcher?.close?.()
    watcher = undefined
  }
}
