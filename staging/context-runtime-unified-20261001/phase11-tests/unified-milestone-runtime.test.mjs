import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { apply as applyStepCompaction, compactOnIdle } from '../home/profiles/web/plugins/step-compaction-v4.mjs'
import { createMilestoneDoc } from '../home/profiles/web/plugins/team-milestone-v2.mjs'

function eventBus(services = {}) {
  const handlers = new Map()
  return {
    handlers,
    get(name) { return services[name] },
    on(event, handler) {
      const rows = handlers.get(event) ?? []
      rows.push(handler)
      handlers.set(event, rows)
      return () => {
        const index = rows.indexOf(handler)
        if (index >= 0) rows.splice(index, 1)
      }
    },
  }
}

function context({ provide = true, inject = false, services = {} } = {}) {
  const bus = eventBus()
  const effects = []
  const ctx = {
    bus,
    effects,
    logger: { debug() {}, info() {}, warn() {} },
    on: bus.on,
    effect: callback => effects.push(callback),
  }
  if (provide) {
    ctx.provide = (name, service) => {
      ctx[name] = service
      return () => { if (ctx[name] === service) delete ctx[name] }
    }
  }
  if (inject) {
    ctx.injectionNames = []
    ctx.inject = (names, callback) => {
      ctx.injectionNames.push(names)
      const scoped = eventBus(services)
      callback(scoped)
      return () => {}
    }
  }
  return ctx
}

function tempDir(t, prefix) {
  const directory = mkdtempSync(join(tmpdir(), prefix))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  return directory
}

test('apply publishes immutable default-path facts from the actual instance and HMR cleanup invalidates them', t => {
  const ctx = context({ inject: true })
  const dispose = applyStepCompaction(ctx)
  t.after(dispose)
  const service = ctx.stepCompactionRuntime
  assert.strictEqual(service, dispose.runtimeService)
  assert.equal(service.loaded, true)
  assert.deepEqual(ctx.injectionNames, [['agentTeams', 'tokenMeter', 'commands']])

  const facts = service.runtimeFacts()
  const sourcePath = fileURLToPath(new URL('../home/profiles/web/plugins/step-compaction-v4.mjs', import.meta.url))
  assert.equal(facts.pid, process.pid)
  assert.ok(facts.instanceId)
  assert.equal(facts.moduleHash, createHash('sha256').update(readFileSync(sourcePath)).digest('hex'))
  assert.equal(facts.configuredPath, join(process.env.DSH_HOME ?? process.cwd(), 'team-milestones.json'))
  assert.equal(facts.profile, 'web')
  assert.equal(facts.configHashStatus, 'known')
  assert.match(facts.configHash, /^[a-f0-9]{64}$/)
  assert.equal(facts.loaded, true)
  assert.ok(Object.isFrozen(facts))
  assert.throws(() => { facts.loaded = false }, TypeError)

  const hmrCleanup = ctx.effects[0]()
  hmrCleanup()
  assert.equal(service.loaded, false)
  assert.equal(service.runtimeFacts().loaded, false)
  assert.equal(service.runtimeFacts().registrationStatus, 'disposed')
  assert.equal(ctx.stepCompactionRuntime, undefined)
})

test('override instances expose their own paths and distinct config identities', t => {
  const directory = tempDir(t, 'milestone-runtime-config-')
  const firstPath = join(directory, 'first.json')
  const secondPath = join(directory, 'second.json')
  writeFileSync(firstPath, '{}\n')
  writeFileSync(secondPath, '{}\n')
  const firstContext = context()
  const secondContext = context()
  const stopFirst = applyStepCompaction(firstContext, { milestonePath: firstPath })
  const stopSecond = applyStepCompaction(secondContext, { milestonePath: secondPath, enablePreStep: true })
  t.after(stopFirst)
  t.after(stopSecond)

  const first = firstContext.stepCompactionRuntime.runtimeFacts()
  const second = secondContext.stepCompactionRuntime.runtimeFacts()
  assert.equal(first.configuredPath, firstPath)
  assert.equal(first.physicalPath, realpathSync(firstPath))
  assert.equal(first.physicalPathStatus, 'resolved')
  assert.equal(second.configuredPath, secondPath)
  assert.equal(second.physicalPath, realpathSync(secondPath))
  assert.notEqual(first.instanceId, second.instanceId)
  assert.notEqual(first.configHash, second.configHash)
})

test('missing configured files stay unknown and junction paths resolve to the actual file', t => {
  const directory = tempDir(t, 'milestone-runtime-physical-')
  const missingPath = join(directory, 'missing.json')
  const missingContext = context()
  const stopMissing = applyStepCompaction(missingContext, { milestonePath: missingPath })
  t.after(stopMissing)
  const missing = missingContext.stepCompactionRuntime.runtimeFacts()
  assert.equal(missing.loaded, true)
  assert.equal(missing.configuredPath, missingPath)
  assert.equal(missing.physicalPath, null)
  assert.equal(missing.physicalPathStatus, 'unknown:not-found')

  const target = join(directory, 'target')
  const alias = join(directory, 'alias')
  mkdirSync(target)
  const targetPath = join(target, 'milestones.json')
  writeFileSync(targetPath, '{}\n')
  symlinkSync(target, alias, 'junction')
  const junctionPath = join(alias, 'milestones.json')
  const junctionContext = context()
  const stopJunction = applyStepCompaction(junctionContext, { milestonePath: junctionPath })
  t.after(stopJunction)
  const junction = junctionContext.stepCompactionRuntime.runtimeFacts()
  assert.equal(junction.configuredPath, junctionPath)
  assert.equal(junction.physicalPath, realpathSync(targetPath))
  assert.equal(junction.physicalPathStatus, 'resolved')
})

test('legacy minimal hosts without provide remain usable and never claim a loaded runtime source', t => {
  const ctx = context({ provide: false })
  const dispose = applyStepCompaction(ctx)
  const service = dispose.runtimeService
  assert.equal(service.loaded, false)
  assert.equal(service.runtimeFacts().loaded, false)
  assert.equal(service.runtimeFacts().registrationStatus, 'unavailable:provide-missing')
  assert.equal(ctx.bus.handlers.get('llm/stream').length, 2)
  assert.equal(ctx.bus.handlers.get('agent/status').length, 1)
  dispose()
  assert.equal(ctx.bus.handlers.get('llm/stream').length, 0)
  assert.equal(ctx.bus.handlers.get('agent/status').length, 0)
})

test('compactOnIdle still folds the pending milestone from its configured path', async t => {
  const directory = tempDir(t, 'milestone-runtime-idle-')
  const milestonePath = join(directory, 'milestones.json')
  const doc = createMilestoneDoc()
  doc.members.a1 = { owner: 'a1', stage: 'S', doneWhen: 'W', setAt: 1, done: true }
  doc.compactions.a1 = { kind: 'milestone', status: 'pending-idle', reason: 'milestone', milestoneSetAt: 1, requestedAt: 1 }
  writeFileSync(milestonePath, JSON.stringify(doc))
  const agent = { session: { id: 'milestone-runtime-idle', seq: 1 }, membership: { name: 'a1' }, inject() {} }
  const ctx = {
    agentTeams: { tryMembership: row => row.membership },
    tokenMeter: { measure: () => ({ totalTokens: 500000 }) },
    compaction: { compactNow: async () => ({ compactionId: 'idle-fold', summary: [{ type: 'text', text: 'a1 S W next action' }] }) },
  }
  const outcome = await compactOnIdle(ctx, { milestonePath, controlDir: directory, windowTokens: 1000000 }, agent, new AbortController().signal)
  const saved = JSON.parse(readFileSync(milestonePath, 'utf8'))
  assert.match(outcome, /^folded:milestone:/)
  assert.equal(saved.compactions.a1.summaryAvailable, true)
})

// A milestone closes a LARGE phase. With a floor configured, a tick while the context is still small is recorded
// but not folded: rewriting a small, still-cached context costs more than it saves.
test('a milestone ticked below the configured floor is recorded, not folded; pressure and the default are unchanged', async t => {
  function scenario({ tokens, done = true }) {
    const directory = tempDir(t, 'milestone-floor-')
    const milestonePath = join(directory, 'milestones.json')
    const doc = createMilestoneDoc()
    doc.members.a1 = { owner: 'a1', stage: 'S', doneWhen: 'W', setAt: 1, done }
    if (done) doc.compactions.a1 = { kind: 'milestone', status: 'pending-idle', reason: 'milestone', milestoneSetAt: 1, requestedAt: 1 }
    writeFileSync(milestonePath, JSON.stringify(doc))
    const folds = []
    const ctx = {
      agentTeams: { tryMembership: row => row.membership },
      tokenMeter: { measure: () => ({ totalTokens: tokens }) },
      compaction: { compactNow: async () => { folds.push(1); return { compactionId: 'fold-' + folds.length, summary: [{ type: 'text', text: 'a1 S W next action' }] } } },
    }
    const agent = { session: { id: 'milestone-floor-' + tokens, seq: 1 }, membership: { name: 'a1' }, inject() {} }
    const run = (extra = {}) => compactOnIdle(ctx, { milestonePath, controlDir: directory, windowTokens: 1000000, ...extra }, agent, new AbortController().signal)
    return { run, folds, saved: () => JSON.parse(readFileSync(milestonePath, 'utf8')), milestonePath }
  }
  const floor = { minMilestoneFoldTokens: 200000 }

  const small = scenario({ tokens: 120000 })
  assert.equal(await small.run(floor), 'milestone-deferred:below-floor')
  assert.equal(small.folds.length, 0)
  let saved = small.saved()
  assert.equal(saved.compactions.a1.status, 'skipped-below-floor')
  assert.equal(saved.compactions.a1.tokens, 120000)
  assert.equal(saved.compactions.a1.minMilestoneFoldTokens, 200000)
  assert.ok(saved.members.a1.foldSkippedAt > 0)
  assert.equal(saved.members.a1.compactedAt, undefined, 'a skipped fold is not recorded as a fold')
  // The same tick is not reconsidered on every idle.
  assert.notEqual(await small.run(floor), 'milestone-deferred:below-floor')
  assert.equal(small.folds.length, 0)
  // The next phase gets a fresh record: ticking it at a large context folds.
  saved = small.saved()
  saved.members.a1 = { owner: 'a1', stage: 'next phase', doneWhen: 'W2', setAt: 2, done: true }
  saved.compactions.a1 = { kind: 'milestone', status: 'pending-idle', reason: 'milestone', milestoneSetAt: 2, requestedAt: 2 }
  writeFileSync(small.milestonePath, JSON.stringify(saved))

  const large = scenario({ tokens: 250000 })
  assert.match(await large.run(floor), /^folded:milestone:/)
  assert.equal(large.folds.length, 1)

  const pressure = scenario({ tokens: 760000, done: false })
  assert.match(await pressure.run(floor), /^folded:pressure:/)

  const unset = scenario({ tokens: 120000 })
  assert.match(await unset.run(), /^folded:milestone:/, 'without a configured floor every tick folds as before')
})
