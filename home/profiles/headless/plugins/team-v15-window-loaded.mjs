// What code is actually running. Each window-critical module records the hash of its own source when it is loaded,
// so a certificate can describe the loaded modules instead of whatever is on disk at the moment. The two differ
// exactly when a saved file has not been (or could not be) hot-reloaded: a syntax error that HMR rolled back, or the
// instant between the save and the reload. In those cases the running code is unchanged and must keep working.
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { basename } from 'node:path'
import { fileURLToPath } from 'node:url'

const table = globalThis[Symbol.for('dsh.window.loaded-modules.v1')] ??= new Map()
const sha = value => createHash('sha256').update(value).digest('hex')

/** Called by a module on itself (`registerLoadedModule(import.meta.url)`). Never throws: it must not break a load. */
export function registerLoadedModule(url) {
  try {
    const file = fileURLToPath(String(url).split('?')[0].split('#')[0]), name = basename(file)
    table.set(name, Object.freeze({ sha256: sha(readFileSync(file)), file, generation: (table.get(name)?.generation ?? 0) + 1, loadedAt: Date.now() }))
  } catch { /* an unreadable source simply stays unregistered; the certificate falls back to the disk hash */ }
}

export function loadedModuleHash(name) { return table.get(name)?.sha256 }

/** Modules whose file on disk no longer matches what was loaded: saved but not reloaded. Diagnostic only. */
export function loadedModuleDrift() {
  const drift = []
  for (const [name, row] of table) {
    try { if (sha(readFileSync(row.file)) !== row.sha256) drift.push(name) } catch { drift.push(name) }
  }
  return drift
}
