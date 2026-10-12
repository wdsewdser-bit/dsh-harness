import { pathToFileURL } from 'node:url'
const live = '/d:/dsh-test/home/profiles/web/plugins/'
const staging = 'D:/dsh-test/staging/architecture-clm-20261001/home/profiles/web/plugins/'
export async function resolve(specifier, context, nextResolve) {
  const candidate = new URL(specifier, context.parentURL ?? pathToFileURL(process.cwd() + '/').href)
  if (candidate.protocol === 'file:' && candidate.pathname.toLowerCase().startsWith(live)) {
    return nextResolve(pathToFileURL(staging + candidate.pathname.slice(live.length)).href, context)
  }
  return nextResolve(specifier, context)
}
