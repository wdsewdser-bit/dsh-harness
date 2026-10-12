import { createHash } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import { basename } from 'node:path'
import { fileURLToPath } from 'node:url'
export const name = 'clm-hmr-apply-v6'
export const inject = ['hmr', 'loader']
const hash = value => createHash('sha256').update(value).digest('hex')
export function apply(ctx, config) {
  const hmr = ctx.hmr
  let disposed = false
  const execute = async () => {
    if (disposed) return
    const report = { version: 6, pid: process.pid, startedAt: new Date().toISOString(), status: 'running',
      source: 'native-hmr-runExclusive-partialReload', noLoaderExit: true, requestedModules: config.modules, accepted: [] }
    try {
      await hmr.runExclusive(async () => {
        if (hmr.stashed.size) throw new Error('HMR_PENDING_CHANGES')
        const urls = [...hmr.internal.loadCache.keys()].filter(url => typeof url === 'string' && url.startsWith('file:///D:/dsh-test/home/profiles/web/plugins/'))
        for (const name of config.modules) {
          if (!/^[a-z0-9-]+\.mjs$/.test(name)) throw new Error('MODULE_BOUNDARY')
          const matches = urls.filter(url => basename(fileURLToPath(url)) === name)
          if (matches.length > 1) throw new Error('AMBIGUOUS_MODULE_URL')
          if (!matches.length) continue
          if (hmr.externals.has(matches[0])) throw new Error('EXTERNAL_MODULE_REFUSED')
          report.accepted.push({ url: matches[0], sha256: hash(await readFile(fileURLToPath(matches[0]))) })
        }
        if (!report.accepted.some(row => row.url.endsWith('/request-message-projection.mjs'))) throw new Error('BRIDGE_MODULE_MISSING')
        for (const row of report.accepted) hmr.stashed.add(row.url)
        try { await hmr.partialReload() } finally { hmr.stashed.clear() }
        report.bridge = ctx.get('requestMessageProjection').stats()
        if (report.bridge.version !== 2 || !report.bridge.installed) throw new Error('NEW_BRIDGE_NOT_ACTIVE')
      })
      report.status = 'completed'
    } catch (error) { report.status = 'failed'; report.error = error.message }
    report.endedAt = new Date().toISOString()
    await writeFile(config.output, JSON.stringify(report, null, 2) + '\n', { flag: 'wx' })
  }
  let timer
  hmr.executing.exit(() => { timer = setTimeout(execute, 100); timer.unref() })
  ctx.effect(() => () => { disposed = true; clearTimeout(timer) })
}
