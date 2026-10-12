import { basename } from 'node:path'
import { writeFile } from 'node:fs/promises'
export const name = 'clm-hmr-team-v9'
export const inject = ['hmr', 'loader']
export async function apply(ctx, config) {
  const hmr = ctx.hmr, result = { version: 9, pid: process.pid, startedAt: new Date().toISOString(), steps: [] }
  const run = async () => {
    try {
      await hmr.runExclusive(async () => {
        const entry = [...ctx.loader.entries()].find(row => row.options?.id === 'tool-agent-team-v2')
        if (!entry?.fiber) throw new Error('TEAM_TOOL_ENTRY_MISSING')
        const resolved = await hmr._resolve(entry.options.name, entry.parent.tree.ctx.baseUrl, {}), url = resolved?.url ?? resolved
        const urlPath = new URL(url).pathname
        const modules = ['team-tools-v2-r10.mjs', 'team-control-plane.mjs', 'team-activity-digest.mjs',
          'team-v12-evidence-scheduler.mjs', 'team-v12-runtime.mjs', 'team-query-efficiency.mjs', 'team-message-operation.mjs']
        const loaded = [...hmr.internal.loadCache.keys()].filter(value => typeof value === 'string' && value.startsWith('file:///D:/dsh-test/home/profiles/web/plugins/'))
        result.target = { id: entry.options.id, url, disabled: entry.options.disabled ?? null }
        result.modules = modules.map(name => {
          const match = loaded.find(value => new URL(value).pathname.endsWith('/' + name))
          return { name, url: match ?? null }
        }).filter(row => row.url)
        result.before = { loadedModules: result.modules.length, runningSessions: 'checked-by-runner-before-invocation' }
        if (!result.modules.some(row => row.name === 'team-tools-v2-r10.mjs' && row.url === url)) throw new Error('TEAM_MODULE_URL_MISMATCH')
        await entry.update({ disabled: true }); await entry.fiber?.await()
        hmr.stashed.add(url)
        try { await hmr.partialReload() } finally { hmr.stashed.clear() }
        await entry.update({ disabled: null }); await entry.fiber?.await()
        result.after = { id: entry.options.id, url, disabled: entry.options.disabled ?? null, fiberActive: !!entry.fiber?.uid }
        result.status = 'completed'
      })
    } catch (error) { result.status = 'failed'; result.error = error.message }
    result.endedAt = new Date().toISOString()
    await writeFile(config.output, JSON.stringify(result, null, 2) + '\n', { flag: 'wx' })
  }
  let timer; hmr.executing.exit(() => { timer = setTimeout(run, 100); timer.unref() })
  ctx.effect(() => () => clearTimeout(timer))
}
