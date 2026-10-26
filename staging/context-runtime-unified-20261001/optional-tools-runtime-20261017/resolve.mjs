import { registerHooks } from 'node:module'
import { createRequire } from 'node:module'
import { fileURLToPath, pathToFileURL } from 'node:url'

// Reuse the staged native implementations, not duplicate framework instances
// installed under the optional SDKs. Leave third-party resolution to Node.
const previous = process.env.DSH_LAB_CANONICAL_MODULES
process.env.DSH_LAB_CANONICAL_MODULES = '0'
const { canonicalNativeTarget } = await import('../tools/prepare-unified-lab-host.mjs')
if (previous === undefined) delete process.env.DSH_LAB_CANONICAL_MODULES
else process.env.DSH_LAB_CANONICAL_MODULES = previous
const host = createRequire(new URL('../app/package.json', import.meta.url))
const optional = createRequire(new URL('./package.json', import.meta.url))
const resolutions = new Map()
const optionalPackages = new Set(['dsh-browser-use', 'dsh-computer-use', 'dsh-experimental-browser-use-runtime',
  'dsh-experimental-browser-use-stagehand-native', 'dsh-experimental-computer-use-cua-driver-native'])
let resolving = false
registerHooks({ resolve(specifier, context, nextResolve) {
  if (resolving || !specifier.startsWith('@deepseek-ai/')) return nextResolve(specifier, context)
  let target = canonicalNativeTarget(specifier)
  if (target === undefined) {
    resolving = true
    try {
      try { target = pathToFileURL(host.resolve(specifier)).href }
      catch (error) {
        if (error.code !== 'MODULE_NOT_FOUND') throw error
        if (!optionalPackages.has(specifier.split('/')[1])) throw error
        target = pathToFileURL(optional.resolve(specifier)).href
      }
    } finally { resolving = false }
  }
  resolutions.set(specifier, target)
  return nextResolve(context.conditions.includes('require') ? fileURLToPath(target) : target, context)
} })
export const optionalToolResolutions = () => [...resolutions].map(([specifier, url]) => ({ specifier, url }))
