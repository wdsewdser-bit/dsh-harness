import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

test('team usage cache bounds persisted session history', async () => {
  const root = mkdtempSync(join(tmpdir(), 'v14-usage-cache-'))
  const previousHome = process.env.DSH_HOME
  try {
    const home = join(root, 'home')
    const cacheDir = join(home, 'cache')
    const sessionsRoot = join(root, 'sessions')
    mkdirSync(cacheDir, { recursive: true })
    mkdirSync(sessionsRoot, { recursive: true })
    const sessions = {}
    for (let index = 0; index < 300; index += 1) {
      const id = 'session-' + String(index)
      sessions[id] = {
        file: join(sessionsRoot, id, 'session.v3.jsonl.zstd'),
        size: index + 1,
        mtimeMs: index + 1,
        row: { id, parent: '', total: index },
      }
    }
    writeFileSync(join(cacheDir, 'team-usage-cache.json'), JSON.stringify({
      version: 1,
      sessions,
    }))
    process.env.DSH_HOME = home

    const moduleUrl = pathToFileURL('D:/dsh-test/home/profiles/web/plugins/team-usage.mjs').href
      + '?usage-cache-test=' + String(Date.now())
    const usage = await import(moduleUrl)
    assert.deepEqual(usage.usageCacheStats(), { usage: 0, workspaces: 0 })
    assert.deepEqual(usage.collectTeamUsage(sessionsRoot, 'root'), [])
    assert.equal(usage.usageCacheStats().usage, 256)
    usage.resetUsageCaches()
    assert.deepEqual(usage.usageCacheStats(), { usage: 0, workspaces: 0 })
  } finally {
    if (previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousHome
    rmSync(root, { recursive: true, force: true })
  }
})
