import { writeFile } from 'node:fs/promises'
export const name = 'clm-hmr-team-v10'
export const inject = ['hmr', 'loader']
export async function apply(ctx, config) {
  const hmr = ctx.hmr, result = { version: 10, pid: process.pid, startedAt: new Date().toISOString(), modules: [] }
  const names = ['request-usage-ledger.mjs', 'step-compaction-v4.mjs', 'team-v13-cache-monitor.mjs', 'team-tools-v2-r10.mjs', 'team-control-plane.mjs', 'team-activity-digest.mjs', 'team-v12-evidence-scheduler.mjs', 'team-v12-runtime.mjs', 'team-query-efficiency.mjs', 'team-message-operation.mjs']
  const run = async () => {
    try {
      await hmr.runExclusive(async () => {
        const loaded = [...hmr.internal.loadCache.keys()].filter(url => typeof url === 'string' && url.startsWith('file:///D:/dsh-test/home/profiles/web/plugins/'))
        for (const name of names) { const url = loaded.find(value => new URL(value).pathname.endsWith('/' + name)); if (!url) throw new Error('TEAM_MODULE_MISSING_' + name); hmr.stashed.add(url); result.modules.push({ name, url }) }
        try { await hmr.partialReload() } finally { hmr.stashed.clear() }
        result.status = 'completed'
      })
    } catch (error) { result.status = 'failed'; result.error = error.message }
    result.endedAt = new Date().toISOString(); await writeFile(config.output, JSON.stringify(result, null, 2) + '\n', { flag: 'wx' })
  }
  let timer; hmr.executing.exit(() => { timer = setTimeout(run, 100); timer.unref() }); ctx.effect(() => () => clearTimeout(timer))
}
