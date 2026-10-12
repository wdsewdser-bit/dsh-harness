import { basename } from 'node:path'
import { fileURLToPath } from 'node:url'
import { readFile, writeFile } from 'node:fs/promises'
export const name = 'clm-hmr-repair-v7'
export const inject = ['hmr', 'loader']
export async function apply(ctx, config) {
  const hmr = ctx.hmr, requested = ['observation-pack-v2.mjs', 'request-message-projection.mjs']
  const result = { version: 7, pid: process.pid, startedAt: new Date().toISOString(), source: 'native-hmr-staged-consumer-repair', steps: [] }
  const byName = name => [...ctx.loader.entries()].find(entry => String(entry.options?.name ?? '').endsWith('/' + name) || basename(String(entry.options?.name ?? '')) === name || entry.options?.id === name)
  const reloadOne = async (name, id) => {
    const entry = byName(id) ?? byName(name)
    if (!entry?.fiber) throw new Error('ENTRY_MISSING_' + id)
    const resolved = entry.parent?.tree ? await hmr._resolve(entry.options.name, entry.parent.tree.ctx.baseUrl, {}) : null
    const url = typeof resolved === 'string' ? resolved : resolved?.url
    if (!url) throw new Error('URL_MISSING_' + id)
    const savedDisabled = entry.options.disabled ?? null
    await entry.update({ disabled: true })
    await entry.fiber?.await()
    hmr.stashed.add(url)
    try { await hmr.partialReload() } finally { hmr.stashed.clear() }
    if (savedDisabled === null) await entry.update({ disabled: null })
    else await entry.update({ disabled: savedDisabled })
    await entry.fiber?.await()
    result.steps.push({ id, url, disabled: savedDisabled })
  }
  const execute = async () => {
    try {
      await hmr.runExclusive(async () => {
        if (hmr.stashed.size) throw new Error('HMR_PENDING_CHANGES')
        // The pre-repair bridge may outlive the OP fiber because its old
        // consumer lacked a lifecycle disposer. Clear that registry first;
        // the bridge itself restores the native method during reload.
        ctx.get('requestMessageProjection')?.dispose?.()
        await reloadOne('request-message-projection.mjs', 'request-message-projection')
        await reloadOne('observation-pack-v2.mjs', 'observation-pack')
        result.bridge = ctx.get('requestMessageProjection').stats()
        if (result.bridge.version !== 2 || !result.bridge.installed) throw new Error('BRIDGE_V2_NOT_ACTIVE')
      })
      result.status = 'completed'
    } catch (error) { result.status = 'failed'; result.error = error.message }
    result.endedAt = new Date().toISOString()
    await writeFile(config.output, JSON.stringify(result, null, 2) + '\n', { flag: 'wx' })
  }
  let timer
  hmr.executing.exit(() => { timer = setTimeout(execute, 100); timer.unref() })
  ctx.effect(() => () => clearTimeout(timer))
}
