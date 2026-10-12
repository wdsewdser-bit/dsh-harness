import { writeFile } from 'node:fs/promises'
export const name = 'clm-hmr-diagnostic-v5'
export const inject = ['hmr', 'loader', 'requestMessageProjection']
export async function apply(ctx, config) {
  const hmr = ctx.hmr, urls = [...hmr.internal.loadCache.keys()].filter(url => typeof url === 'string' && /\/plugins\/[^/]+\.mjs$/i.test(url))
  await writeFile(config.output, JSON.stringify({ version: 5, pid: process.pid, at: new Date().toISOString(),
    config: hmr.config, baseDir: hmr.baseDir, watched: hmr.watcher?.getWatched?.(),
    cachedProfileUrls: urls, externalProfileUrls: urls.filter(url => hmr.externals?.has(url)),
    bridge: ctx.requestMessageProjection.stats(), stashed: [...hmr.stashed] }, null, 2) + '\n', { flag: 'wx' })
}
