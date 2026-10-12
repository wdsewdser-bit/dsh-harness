import { registerHooks } from 'node:module'

const live = 'file:///D:/dsh-test/home/profiles/web/plugins/'
const staging = 'file:///D:/dsh-test/staging/architecture-clm-20261001/home/profiles/web/plugins/'
// Redirect plugin code only; preserve both real LLM module copies and their WeakSets.
registerHooks({
  resolve(specifier, context, next) {
    const resolved = specifier.startsWith('file:') ? specifier : specifier.startsWith('.') ? new URL(specifier, context.parentURL).href : null
    if (resolved?.startsWith(live)) return next(staging + resolved.slice(live.length), context)
    return next(specifier, context)
  },
})
