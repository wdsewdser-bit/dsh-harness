import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { controlPlaneFor, resetControlPlaneCache } from '../home/profiles/web/plugins/team-control-plane.mjs'
import {
  armedRoots,
  clearBackgroundWakes,
  markBackgroundWake,
} from '../home/profiles/web/plugins/team-armed-roots.mjs'
import { apply as applyIdleWatch } from '../home/profiles/web/plugins/team-idle-watch-v6.mjs'
import { apply as applyContinuation } from '../home/profiles/web/plugins/team-v14-event-continuation.mjs'
import { apply as applyActivityDigest } from '../home/profiles/web/plugins/team-activity-digest.mjs'

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

async function waitFor(predicate, timeoutMs = 1000) {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('timed out waiting for condition')
    await sleep(10)
  }
}

function fixture(rootId, options = {}) {
  const hooks = new Map()
  const delivered = []
  const sent = []
  const root = {
    id: rootId,
    status: options.rootStatus ?? 'idle',
    followup(message) { delivered.push(message) },
  }
  const worker = { id: rootId + '-worker', status: options.workerStatus ?? 'idle' }
  const teams = {
    tryMembership(agent) {
      if (agent === root) return { id: rootId, root, name: 'lead', role: 'lead' }
      if (agent === worker) return { id: rootId, root, name: 'worker', role: 'member' }
      return undefined
    },
    listMembers() {
      return [
        { id: rootId + '-lead', name: 'lead', role: 'lead', status: root.status, groupId: 'core' },
        { id: rootId + '-worker', name: 'worker', role: 'member', status: worker.status, groupId: 'core' },
      ]
    },
    async sendMessage(_caller, request) {
      sent.push(request)
      return { messageId: 'mail-' + String(sent.length), status: 'accepted' }
    },
  }
  const ctx = {
    agents: { list: () => [root, worker] },
    agentTeams: teams,
    on(event, handler) {
      hooks.set(event, handler)
      return () => hooks.delete(event)
    },
    logger: { info() {}, warn() {} },
  }
  return { root, worker, teams, ctx, hooks, delivered, sent }
}

function twoRootFixture() {
  const hooks = new Map()
  const delivered = new Map()
  const roots = new Map()
  const makeRoot = (id) => {
    const root = {
      id,
      status: 'idle',
      followup(message) {
        const list = delivered.get(id) ?? []
        list.push(message)
        delivered.set(id, list)
      },
    }
    roots.set(id, root)
    return root
  }
  const oldRoot = makeRoot('old-root')
  const newRoot = makeRoot('new-root')
  const teams = {
    tryMembership(agent) {
      if (agent === oldRoot) return { id: 'old-team', root: oldRoot, name: 'lead', role: 'lead' }
      if (agent === newRoot) return { id: 'new-team', root: newRoot, name: 'lead', role: 'lead' }
      return undefined
    },
    listMembers(root) {
      return [
        { id: root.id, name: 'lead', role: 'lead', status: root.status, groupId: 'core' },
        { id: root.id + '-worker', name: 'worker', role: 'member', status: 'idle', groupId: 'core' },
      ]
    },
  }
  const ctx = {
    agents: { list: () => [oldRoot, newRoot] },
    agentTeams: teams,
    on(event, handler) {
      hooks.set(event, handler)
      return () => hooks.delete(event)
    },
    logger: { info() {}, warn() {} },
  }
  return { oldRoot, newRoot, roots, teams, ctx, hooks, delivered }
}

test('idle watch ignores restored stopped Teams until the current process sees that Team running', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'v14-idle-startup-'))
  const rootId = 'startup-idle-root'
  const f = fixture(rootId)
  const cp = controlPlaneFor(rootId, { directory: dir })
  try {
    await cp.mutate('fixture/task', {}, f.root, (state) => {
      state.boards.main = { tasks: {
        open: {
          id: 'open', status: 'pending', lifecycle: 'approved', ownerName: 'worker',
          revision: 1, contract: { owner: 'worker', acceptanceCriteria: ['done'] },
        },
      } }
    })
    const host = {
      get(name) {
        if (name === 'agents') return f.ctx.agents
        if (name === 'agentTeams') return f.teams
        return undefined
      },
      on(event, handler) {
        f.hooks.set(event, handler)
        return () => f.hooks.delete(event)
      },
      effect() { return () => {} },
    }
    const dispose = applyIdleWatch({
      logger: f.ctx.logger,
      inject(_deps, callback) { callback(host) },
    }, {
      controlDir: dir,
      settleMs: 5,
      intervalMs: 5,
      bootstrapScanMs: 10,
    })
    try {
      await sleep(50)
      assert.equal(f.delivered.length, 0)
      f.hooks.get('agent/status')({ agent: f.root, status: 'running' })
      f.hooks.get('agent/status')({ agent: f.root, status: 'idle' })
      await waitFor(() => f.delivered.length === 1)
    } finally {
      if (typeof dispose === 'function') dispose()
    }
  } finally {
    resetControlPlaneCache()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('idle watch periodic scan recovers a missed idle transition after the root is armed', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'v14-idle-recovery-'))
  const rootId = 'periodic-idle-root'
  const f = fixture(rootId)
  const cp = controlPlaneFor(rootId, { directory: dir })
  try {
    await cp.mutate('fixture/task', {}, f.root, (state) => {
      state.boards.main = { tasks: {
        open: {
          id: 'open', status: 'pending', lifecycle: 'approved', ownerName: 'worker',
          revision: 1, contract: { owner: 'worker', acceptanceCriteria: ['done'] },
        },
      } }
    })
    const host = {
      get(name) {
        if (name === 'agents') return f.ctx.agents
        if (name === 'agentTeams') return f.teams
        return undefined
      },
      on(event, handler) {
        f.hooks.set(event, handler)
        return () => f.hooks.delete(event)
      },
      effect() { return () => {} },
    }
    const dispose = applyIdleWatch({
      logger: f.ctx.logger,
      inject(_deps, callback) { callback(host) },
    }, {
      controlDir: dir,
      settleMs: 5,
      intervalMs: 5,
      bootstrapScanMs: 10,
    })
    try {
      f.hooks.get('agent/status')({ agent: f.root, status: 'running' })
      await waitFor(() => f.delivered.length === 1)
      await sleep(30)
      assert.equal(f.delivered.length, 1)
    } finally {
      if (typeof dispose === 'function') dispose()
    }
  } finally {
    resetControlPlaneCache()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('idle watch does not duplicate a durable reminder after plugin reload', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'v14-idle-durable-'))
  const rootId = 'durable-idle-root'
  const f = fixture(rootId)
  const cp = controlPlaneFor(rootId, { directory: dir })
  try {
    await cp.mutate('fixture/task', {}, f.root, (state) => {
      state.boards.main = { tasks: {
        open: {
          id: 'open', status: 'pending', lifecycle: 'approved', ownerName: 'worker',
          revision: 1, contract: { owner: 'worker', acceptanceCriteria: ['done'] },
        },
      } }
    })
    const host = {
      get(name) {
        if (name === 'agents') return f.ctx.agents
        if (name === 'agentTeams') return f.teams
        return undefined
      },
      on(event, handler) {
        f.hooks.set(event, handler)
        return () => f.hooks.delete(event)
      },
      effect() { return () => {} },
    }
    const options = {
      controlDir: dir,
      settleMs: 5,
      intervalMs: 5,
      bootstrapScanMs: 10,
    }
    const first = applyIdleWatch({
      logger: f.ctx.logger,
      inject(_deps, callback) { callback(host) },
    }, options)
    try {
      f.hooks.get('agent/status')({ agent: f.root, status: 'running' })
      await waitFor(() => f.delivered.length === 1)
    } finally {
      if (typeof first === 'function') first()
    }
    const second = applyIdleWatch({
      logger: f.ctx.logger,
      inject(_deps, callback) { callback(host) },
    }, options)
    try {
      await sleep(40)
      assert.equal(f.delivered.length, 1)
    } finally {
      if (typeof second === 'function') second()
    }
  } finally {
    resetControlPlaneCache()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('idle watch retries the same stalled progress after the bounded retry window', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'v14-idle-retry-'))
  const rootId = 'retry-idle-root'
  const f = fixture(rootId)
  const cp = controlPlaneFor(rootId, { directory: dir })
  try {
    await cp.mutate('fixture/task', {}, f.root, (state) => {
      state.boards.main = { tasks: {
        open: {
          id: 'open', status: 'pending', lifecycle: 'approved', ownerName: 'worker',
          revision: 1, contract: { owner: 'worker', acceptanceCriteria: ['done'] },
        },
      } }
    })
    const host = {
      get(name) {
        if (name === 'agents') return f.ctx.agents
        if (name === 'agentTeams') return f.teams
        return undefined
      },
      on(event, handler) {
        f.hooks.set(event, handler)
        return () => f.hooks.delete(event)
      },
      effect() { return () => {} },
    }
    const dispose = applyIdleWatch({
      logger: f.ctx.logger,
      inject(_deps, callback) { callback(host) },
    }, {
      controlDir: dir,
      settleMs: 5,
      intervalMs: 5,
      bootstrapScanMs: 10,
      retryAfterMs: 20,
    })
    try {
      f.hooks.get('agent/status')({ agent: f.root, status: 'running' })
      await waitFor(() => f.delivered.length === 1)
      await waitFor(() => f.delivered.length === 2)
    } finally {
      if (typeof dispose === 'function') dispose()
    }
  } finally {
    resetControlPlaneCache()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('idle watch still wakes the root when every open task is explicitly operator-owned', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'v14-idle-operator-'))
  const rootId = 'operator-idle-root'
  const f = fixture(rootId)
  const cp = controlPlaneFor(rootId, { directory: dir })
  try {
    await cp.mutate('fixture/operator-owned', {}, f.root, (state) => {
      state.boards.main = { tasks: {
        open: {
          id: 'open', status: 'pending', lifecycle: 'approved', ownerName: 'worker',
          revision: 1, contract: { owner: 'worker', acceptanceCriteria: ['done'] },
        },
      } }
      state.v14Waiting = { tickets: {
        ticket: {
          ticketId: 'ticket', taskId: 'open', status: 'open', responsible: 'operator',
        },
      } }
    })
    const host = {
      get(name) {
        if (name === 'agents') return f.ctx.agents
        if (name === 'agentTeams') return f.teams
        return undefined
      },
      on(event, handler) {
        f.hooks.set(event, handler)
        return () => f.hooks.delete(event)
      },
      effect() { return () => {} },
    }
    const dispose = applyIdleWatch({
      logger: f.ctx.logger,
      inject(_deps, callback) { callback(host) },
    }, {
      controlDir: dir,
      settleMs: 5,
      intervalMs: 5,
      bootstrapScanMs: 10,
    })
    try {
      f.hooks.get('agent/status')({ agent: f.root, status: 'running' })
      f.hooks.get('agent/status')({ agent: f.root, status: 'idle' })
      await waitFor(() => f.delivered.length === 1)
    } finally {
      if (typeof dispose === 'function') dispose()
    }
  } finally {
    resetControlPlaneCache()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('continuation scan does not resume restored tasks before current-process activity', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'v14-continuation-startup-'))
  const rootId = 'startup-continuation-root'
  const f = fixture(rootId)
  const cp = controlPlaneFor(rootId, { directory: dir })
  try {
    await cp.mutate('fixture/task', {}, f.root, (state) => {
      state.boards.main = { tasks: {
        task: {
          id: 'task', status: 'pending', lifecycle: 'approved', phase: 'execution',
          ownerName: 'worker', revision: 1, contract: { owner: 'worker', acceptanceCriteria: ['done'] },
        },
      } }
    })
    const dispose = applyContinuation(f.ctx, { controlDir: dir, scanMs: 10 })
    try {
      await sleep(50)
      assert.equal(f.sent.length, 0)
      f.hooks.get('agent/status')({ agent: f.root, status: 'running' })
      f.hooks.get('agent/status')({ agent: f.root, status: 'idle' })
      await waitFor(() => f.sent.length === 1)
    } finally {
      dispose()
    }
  } finally {
    resetControlPlaneCache()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('activity digest does not wake restored active-looking Teams before current-process activity', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'v14-digest-startup-'))
  const rootId = 'startup-digest-root'
  const f = fixture(rootId)
  const cp = controlPlaneFor(rootId, { directory: dir })
  try {
    await cp.mutate('fixture/lease', {}, f.root, (state) => {
      state.leases = { lease: { status: 'active', member: 'worker', taskId: 'restored-task' } }
    })
    const dispose = applyActivityDigest(f.ctx, { controlDir: dir, intervalMs: 10 })
    try {
      await sleep(50)
      assert.equal(f.delivered.length, 0)
      f.hooks.get('agent/status')({ agent: f.root, status: 'running' })
      await waitFor(() => f.delivered.length === 1)
    } finally {
      await dispose()
    }
  } finally {
    await cp.flush()
    resetControlPlaneCache()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('activity digest disposal waits for its already-started durable record', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'v14-digest-disposal-'))
  const f = fixture('digest-disposal-root')
  const cp = controlPlaneFor(f.root.id, { directory: dir })
  let release
  const barrier = new Promise(resolve => { release = resolve })
  let recordEntered
  const entered = new Promise(resolve => { recordEntered = resolve })
  const originalRecord = cp.activityDigestRecord
  cp.activityDigestRecord = async input => { recordEntered(); await barrier; return originalRecord(input) }
  let dispose
  try {
    await cp.mutate('fixture/lease', {}, f.root, state => {
      state.leases = { lease: { status: 'active', member: 'worker', taskId: 'test-task' } }
    })
    dispose = applyActivityDigest(f.ctx, { controlDir: dir, intervalMs: 10 })
    f.hooks.get('agent/status')({ agent: f.root, status: 'running' })
    await entered
    let settled = false
    const draining = Promise.resolve(dispose()).then(() => { settled = true })
    await new Promise(resolve => setImmediate(resolve))
    assert.equal(settled, false, 'disposal must retain the in-flight durable writer')
    release()
    await draining
    await cp.flush()
    assert.equal(cp.snapshot().activityDigest.sequence, 1)
    assert.equal(f.hooks.has('agent/status'), false)
    const delivered = f.delivered.length
    await sleep(30)
    assert.equal(f.delivered.length, delivered)
    await dispose()
  } finally {
    release()
    await dispose?.()
    await cp.flush()
    resetControlPlaneCache()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('switching roots disarms the old root and a queued background wake cannot steal focus back', async () => {
  const f = twoRootFixture()
  armedRoots().clear()
  clearBackgroundWakes()
  const host = {
    get(name) {
      if (name === 'agents') return f.ctx.agents
      if (name === 'agentTeams') return f.teams
      return undefined
    },
    on(event, handler) {
      f.hooks.set(event, handler)
      return () => f.hooks.delete(event)
    },
    effect() { return () => {} },
  }
  const dispose = applyIdleWatch({
    logger: f.ctx.logger,
    inject(_deps, callback) { callback(host) },
  }, {
    settleMs: 5,
    intervalMs: 5,
    bootstrapScanMs: 10,
  })
  try {
    await sleep(30)
    f.hooks.get('agent/status')({ agent: f.oldRoot, status: 'running' })
    f.hooks.get('agent/status')({ agent: f.oldRoot, status: 'idle' })
    f.hooks.get('agent/status')({ agent: f.newRoot, status: 'running' })

    markBackgroundWake('old-team')
    f.hooks.get('agent/status')({ agent: f.oldRoot, status: 'running' })
    await sleep(30)
    assert.equal((f.delivered.get('old-root') ?? []).length, 0)

    f.hooks.get('agent/status')({ agent: f.newRoot, status: 'idle' })
    await waitFor(() => (f.delivered.get('new-root') ?? []).length === 1)
    assert.equal((f.delivered.get('old-root') ?? []).length, 0)
  } finally {
    if (typeof dispose === 'function') dispose()
    armedRoots().clear()
    clearBackgroundWakes()
  }
})
