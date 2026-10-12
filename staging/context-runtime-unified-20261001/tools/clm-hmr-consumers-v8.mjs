import { basename } from 'node:path'
import { writeFile } from 'node:fs/promises'
export const name = 'clm-hmr-consumers-v8'
export const inject = ['hmr', 'loader', 'requestMessageProjection']
export async function apply(ctx, config) {
  const hmr = ctx.hmr, result = { version: 8, pid: process.pid, startedAt: new Date().toISOString(), steps: [] }
  const find = id => [...ctx.loader.entries()].find(entry => entry.options?.id === id)
  const one = async id => {
    const entry = find(id); if (!entry?.fiber) throw new Error('ENTRY_MISSING_' + id)
    const resolved = await hmr._resolve(entry.options.name, entry.parent.tree.ctx.baseUrl, {}), url = resolved?.url ?? resolved
    await entry.update({ disabled: true }); await entry.fiber?.await(); hmr.stashed.add(url)
    try { await hmr.partialReload() } finally { hmr.stashed.clear() }
    await entry.update({ disabled: null }); await entry.fiber?.await(); result.steps.push({ id, url })
  }
  let timer; const run = async () => {
    try { await hmr.runExclusive(async () => { await one('ptc-sdk-retention'); await one('context-workspace'); result.bridge = ctx.get('requestMessageProjection').stats() }); result.status = 'completed' }
    catch (e) { result.status = 'failed'; result.error = e.message }
    result.endedAt = new Date().toISOString(); await writeFile(config.output, JSON.stringify(result, null, 2) + '\n', { flag: 'wx' })
  }
  hmr.executing.exit(() => { timer = setTimeout(run, 100); timer.unref() }); ctx.effect(() => () => clearTimeout(timer))
}
