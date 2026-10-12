import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test, { afterEach } from 'node:test'

import { Context } from '../app/node_modules/@deepseek-ai/cordis/lib/index.js'
import { LocalJobRegistry } from '../app/node_modules/@deepseek-ai/dsh-jobs-local/lib/index.js'

const tempDirs = []

afterEach(() => {
  for (const directory of tempDirs.splice(0)) rmSync(directory, { recursive: true, force: true })
})

function createRegistry({ withSessions = true } = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'dsh-cross-turn-jobs-'))
  tempDirs.push(directory)
  const ctx = new Context()
  const state = {
    live: true,
    owner: undefined,
  }
  ctx.provide('agents', {
    get: (id) => String(id) === String(state.owner?.id ?? '') ? state.owner : undefined,
  })
  if (withSessions) {
    ctx.provide('sessions', {
      get: (id) => String(id) === String(state.owner?.id ?? '') && state.live ? state.owner.session : undefined,
    })
  }
  const registry = new LocalJobRegistry(ctx, {
    maxConcurrentJobsPerOwner: 10,
    retainBytes: 1024,
    settledRetainBytes: 1024,
    pumpPollMs: 10,
    journalDirectory: directory,
  })
  registry.attachController('cross-turn-test')
  return { ctx, registry, state }
}

function startRunningJob(registry, owner) {
  let cancelled = 0
  let settle
  const done = new Promise((resolve) => {
    settle = () => resolve({ status: 'killed', detail: 'owner disposed' })
  })
  const id = registry.start({
    kind: 'sentinel',
    label: 'cross-turn sentinel',
    owner: owner.id,
    run: () => ({
      done,
      cancel: () => {
        cancelled += 1
        settle()
      },
    }),
  })
  return { id, done, cancelled: () => cancelled }
}

async function waitFor(predicate, timeoutMs = 1000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  assert.fail('condition was not reached before timeout')
}

test('cross-turn jobs survive Agent disposal while their Session remains live', async () => {
  const { ctx, registry, state } = createRegistry()
  const owner = { id: 'session-cross-turn', session: { id: 'session-cross-turn' }, ctx }
  state.owner = owner
  const sentinel = startRunningJob(registry, owner)

  assert.equal(registry.list(owner.id)[0]?.status, 'running')
  await registry.ownerCleanups.get(owner)()
  assert.equal(registry.list(owner.id)[0]?.status, 'running')
  assert.equal(sentinel.cancelled(), 0)

  const replacement = { id: owner.id, session: owner.session, ctx: ctx.extend() }
  state.owner = replacement
  assert.equal(registry.read(sentinel.id, replacement.id).job.status, 'running')

  state.live = false
  ctx.emit('session/disposed', replacement.session)
  await waitFor(() => registry.list(owner.id).length === 0)
  assert.equal(sentinel.cancelled(), 1)
  await registry.disposeAll()
})

test('owner disposal still reclaims jobs when no live Session registry exists', async () => {
  const { registry, state } = createRegistry({ withSessions: false })
  const owner = { id: 'session-owner-only', session: { id: 'session-owner-only' } }
  owner.ctx = new Context()
  state.owner = owner
  const sentinel = startRunningJob(registry, owner)

  await registry.ownerCleanups.get(owner)()
  assert.equal(registry.list(owner.id).length, 0)
  assert.equal(sentinel.cancelled(), 1)
  await registry.disposeAll()
})
