import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createSessionListCache } from '../home/profiles/web/plugins/team-runtime-guard.mjs'

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

test('session list cache coalesces reads, revalidates in the background, and disposes cleanly', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'dsh-session-list-cache-'))
  let calls = 0
  const service = {
    async listSessions() {
      calls += 1
      await delay(20)
      return [{ id: calls }]
    },
  }
  const original = service.listSessions
  const cache = createSessionListCache(service, {
    cachePath: join(directory, 'cache.json'),
    refreshAfterMs: 1000,
    debounceMs: 10,
    hardStaleMs: 10_000,
  })
  try {
    const [first, second] = await Promise.all([service.listSessions(), service.listSessions()])
    assert.equal(calls, 1)
    assert.strictEqual(first, second)

    cache.invalidate()
    const stale = await service.listSessions()
    assert.equal(calls, 1)
    assert.strictEqual(stale, first)

    for (let attempt = 0; attempt < 50 && (calls < 2 || cache.status().stale); attempt += 1) {
      await delay(10)
    }
    assert.equal(cache.status().stale, false)
    const fresh = await service.listSessions()
    assert.equal(calls, 2)
    assert.notStrictEqual(fresh, first)
  } finally {
    cache.dispose()
    assert.strictEqual(service.listSessions, original)
    rmSync(directory, { recursive: true, force: true })
  }
})

test('session list cache loads a disk snapshot before the first network-equivalent read', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'dsh-session-list-cache-'))
  const cachePath = join(directory, 'cache.json')
  try {
    let firstCalls = 0
    const firstService = {
      async listSessions() {
        firstCalls += 1
        return [{ id: 'disk' }]
      },
    }
    const first = createSessionListCache(firstService, { cachePath, debounceMs: 10 })
    assert.deepEqual(await firstService.listSessions(), [{ id: 'disk' }])
    assert.equal(firstCalls, 1)
    first.dispose()

    let secondCalls = 0
    const secondService = {
      async listSessions() {
        secondCalls += 1
        return [{ id: 'network' }]
      },
    }
    const second = createSessionListCache(secondService, { cachePath, debounceMs: 10 })
    try {
      assert.deepEqual(await secondService.listSessions(), [{ id: 'disk' }])
      assert.equal(secondCalls, 0)
      await delay(40)
      assert.equal(secondCalls, 1)
    } finally {
      second.dispose()
    }
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})
