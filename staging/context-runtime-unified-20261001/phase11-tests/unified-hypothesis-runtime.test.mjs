import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { apply } from '../home/profiles/web/plugins/team-v15-hypothesis-runtime.mjs'

const context = {
  sourceIdentity: { manifestHash: 'a'.repeat(64), revision: 3 },
  environmentFingerprint: 'b'.repeat(64),
  recipeFingerprint: 'c'.repeat(64),
  sourceManifest: {
    root: 'D:\\work',
    files: [{ path: 'src/index.mjs', sha256: 'd'.repeat(64), bytes: 23, physicalPath: 'D:\\work\\src\\index.mjs' }],
  },
}

function makeContext() {
  const registrations = new Map()
  return {
    sessionId: 'session-1',
    on(event, listener) {
      const listeners = registrations.get(event) ?? []
      listeners.push(listener)
      registrations.set(event, listeners)
      return () => registrations.set(event, (registrations.get(event) ?? []).filter(row => row !== listener))
    },
    registrations,
  }
}

function makeFixture(t, { maxNoProgressAttempts = 3 } = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'hypothesis-runtime-'))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  let now = 1000
  const state = {
    rootId: 'root-team-1',
    revision: 4,
    leases: {
      'lease-1': { member: 'worker', taskId: 'task-1', contractRevision: 2, status: 'active', expiresAt: 5000 },
    },
    boards: {
      'board-1': { tasks: { 'task-1': { revision: 9, ownerName: 'worker', contract: { contractRevision: 2, owner: 'worker' } } } },
    },
    v15PlanDelivery: {
      taskPlanBindings: { 'board-1': { 'task-1': { planId: 'plan-1', planRevision: 3, planHash: 'plan-hash-1' } } },
      plans: {
        'plan-1': {
          planId: 'plan-1', planRevision: 3, planHash: 'plan-hash-1', scope: { root: 'D:\\work' },
          items: [{ requirementId: 'req-1', implementationRefs: ['proof-1'], testEvidenceRefs: [],
            acceptanceEvidenceRefs: [], taskRefs: [{ boardId: 'board-1', taskId: 'task-1' }] }],
        },
      },
    },
    v12Evidence: { version: 1, revision: 0, records: {} },
    deliveryAuthorityReceipts: {},
  }
  const ctx = makeContext()
  const attempts = new WeakMap()
  const runtime = apply(ctx, {
    memoryFile: join(directory, 'hypotheses.json'),
    readDurable: () => structuredClone(state),
    collectContext: () => structuredClone(context),
    verifyPlan: plan => plan.planHash === 'plan-hash-1',
    readAttempt: call => attempts.get(call),
    resolveActor: agent => ({ name: agent.name, sessionId: 'session-1', rootTeamId: state.rootId }),
    now: () => now,
    maxNoProgressAttempts,
    maxAttempts: 10,
  })
  function addValidProof() {
    const plan = state.v15PlanDelivery.plans['plan-1']
    const task = state.boards['board-1'].tasks['task-1']
    const binding = {
      status: 'passed', planId: plan.planId, planRevision: plan.planRevision, planHash: plan.planHash,
      requirementId: 'req-1', scope: structuredClone(plan.scope), sourceIdentity: structuredClone(context.sourceIdentity),
      environmentFingerprint: context.environmentFingerprint, recipeFingerprint: context.recipeFingerprint,
      boardId: 'board-1', taskId: 'task-1', taskRevision: task.revision, contractRevision: task.contract.contractRevision,
    }
    const proof = {
      ...binding, id: 'proof-1', kind: 'implementation', locator: 'src/index.mjs', artifactHash: 'd'.repeat(64),
      provenance: { kind: 'server-physical-source-scan', bytes: 23, physicalPath: 'D:\\work\\src\\index.mjs' },
      verificationScope: 'physical-source-presence-not-test-or-business-acceptance',
    }
    const authority = {
      ...binding, id: 'authority-1', kind: 'delivery-authority', owner: 'worker', leaseRef: 'lease-1', expiresAt: 5000,
    }
    state.v12Evidence.records[proof.id] = proof
    state.deliveryAuthorityReceipts[authority.id] = authority
    state.v12Evidence.revision += 1
    return proof
  }
  function exec(callId, { agentName = 'worker', tool = 'bash', command = 'node script.mjs', attempt = {} } = {}) {
    const call = {
      callId,
      name: tool,
      sessionId: 'session-1',
      agent: { name: agentName },
      arguments: { command },
    }
    attempts.set(call, {
          requirementId: 'req-1', hypothesisId: 'parser-boundary', failureCause: 'same parser failure',
          hypothesis: 'The parser boundary rejects the documented field.',
          probe: { kind: 'standard', method: 'baseline-check' },
          ...attempt,
    })
    return call
  }
  async function run(call, result) {
    const pre = ctx.registrations.get('tools/pre-execute')?.[0]
    const post = ctx.registrations.get('tools/result')?.[0]
    assert.equal(typeof pre, 'function')
    assert.equal(typeof post, 'function')
    await pre(call, async () => ({ kind: 'allow' }))
    await post(call, result)
    await runtime.flush()
  }
  return { ctx, state, runtime, exec, run, addValidProof, attempts, setTime(value) { now = value } }
}

test('before/final hooks derive owner and scope, record final success/error once by callId', async t => {
  const f = makeFixture(t)
  const success = f.exec('call-success')
  await f.run(success, { isError: false, structuredContent: { ok: true } })
  const failed = f.exec('call-error')
  await f.run(failed, { isError: true, code: 'E_PARSE' })

  let snapshot = f.runtime.observe(success)
  assert.equal(snapshot.entries.length, 1)
  assert.deepEqual(snapshot.entries[0].identity, {
    sessionId: 'session-1', rootTeamId: 'root-team-1', taskId: 'task-1', contractRevision: 2,
  })
  assert.deepEqual(snapshot.entries[0].attempts.map(row => row.serverObservation.status), ['passed', 'failed'])
  assert.equal(snapshot.entries[0].attempts[0].attemptId, 'call-success')
  assert.equal(snapshot.entries[0].attempts[1].serverObservation.errorCode, 'E_PARSE')

  await f.ctx.registrations.get('tools/result')[0](failed, { isError: true, code: 'E_PARSE' })
  snapshot = f.runtime.observe(success)
  assert.equal(snapshot.entries[0].attempts.length, 2)
})

test('changing wrapper or path does not reset a repeated hypothesis without a new proof', async t => {
  const f = makeFixture(t, { maxNoProgressAttempts: 1 })
  await f.run(f.exec('call-1', { tool: 'bash', command: 'node scripts/first.mjs' }), { isError: true, code: 'E_SCHEMA' })
  await f.run(f.exec('call-2', { tool: 'node', command: 'node scripts/second.mjs' }), { isError: true, code: 'E_SCHEMA' })
  const wrapped = f.exec('call-3', { tool: 'powershell', command: 'scripts/third.ps1' })
  let executed = false
  await assert.rejects(f.ctx.registrations.get('tools/pre-execute')[0](wrapped, async () => { executed = true }),
    { code: 'HYPOTHESIS_RUNTIME_REPLAN_REQUIRED' })
  assert.equal(executed, false)
  assert.equal(f.runtime.observe(wrapped).entries[0].attempts.length, 2)
})

test('only a durable, current proof bound to source, environment, recipe, task and contract counts as new evidence', async t => {
  const f = makeFixture(t)
  const proof = f.addValidProof()
  const call = f.exec('call-proof')
  await f.run(call, { isError: false, structuredContent: { durable: true, proof: { id: proof.id } } })
  let entry = f.runtime.observe(call).entries[0]
  assert.equal(entry.attempts[0].newInformation.evidence, true, JSON.stringify(entry.attempts[0].evidence))
  assert.equal(entry.attempts[0].evidence.status, 'passed')

  const corruptions = [
    proof => { proof.sourceIdentity.manifestHash = 'e'.repeat(64) },
    proof => { proof.environmentFingerprint = 'e'.repeat(64) },
    proof => { proof.recipeFingerprint = 'e'.repeat(64) },
    proof => { proof.taskId = 'task-other' },
    proof => { proof.contractRevision += 1 },
    proof => { proof.taskRevision += 1 },
    proof => { proof.status = 'stale' },
    proof => { proof.requirementId = 'foreign' },
    (_proof, state) => { state.v15PlanDelivery.taskPlanBindings['board-1']['task-1'].planHash = 'old' },
    (_proof, state) => { state.deliveryAuthorityReceipts = {} },
  ]
  for (let index = 0; index < corruptions.length; index += 1) {
    const other = makeFixture(t)
    other.addValidProof()
    corruptions[index](other.state.v12Evidence.records['proof-1'], other.state)
    const fabricated = other.exec('call-fake-proof-' + index)
    if (index === corruptions.length - 2) {
      await assert.rejects(other.run(fabricated, { isError: false }), { code: 'HYPOTHESIS_RUNTIME_REQUIREMENT_UNVERIFIED' })
      continue
    }
    await other.run(fabricated, { isError: false, structuredContent: { durable: true, proof: { id: 'proof-1' } } })
    entry = other.runtime.observe(fabricated).entries[0]
    assert.equal(entry.attempts[0].newInformation.evidence, false, 'corruption ' + index)
    assert.equal(entry.attempts[0].evidence.status, 'unavailable', 'corruption ' + index)
  }
})

test('foreign owner, absent lease and ambiguous lease fail closed before the tool runs', async t => {
  const f = makeFixture(t)
  let ran = false
  await assert.rejects(f.ctx.registrations.get('tools/pre-execute')[0](f.exec('wrong-owner', { agentName: 'intruder' }),
    async () => { ran = true }), { code: 'HYPOTHESIS_RUNTIME_AUTHORITY_UNVERIFIED' })
  assert.equal(ran, false)
  await assert.rejects(f.ctx.registrations.get('tools/pre-execute')[0](f.exec('x'.repeat(161)), async () => { ran = true }),
    { code: 'HYPOTHESIS_RUNTIME_CALL_CONTEXT_UNAVAILABLE' })
  assert.equal(ran, false)

  f.state.leases['lease-2'] = { member: 'worker', taskId: 'task-1', contractRevision: 2, status: 'active', expiresAt: 5000 }
  await assert.rejects(f.ctx.registrations.get('tools/pre-execute')[0](f.exec('duplicate-lease'), async () => { ran = true }),
    { code: 'HYPOTHESIS_RUNTIME_AUTHORITY_UNVERIFIED' })
  assert.equal(ran, false)
  delete f.state.leases['lease-2']
  f.setTime(5001)
  await assert.rejects(f.ctx.registrations.get('tools/pre-execute')[0](f.exec('expired-lease'), async () => { ran = true }),
    { code: 'HYPOTHESIS_RUNTIME_AUTHORITY_UNVERIFIED' })
  assert.equal(ran, false)
})

test('missing server callbacks fail closed without registering observation hooks', () => {
  const ctx = makeContext()
  assert.throws(() => apply(ctx, { memoryFile: 'unused.json', collectContext: () => ({}), verifyPlan: () => true }),
    { code: 'HYPOTHESIS_RUNTIME_AUTHORITY_UNAVAILABLE' })
  assert.equal(ctx.registrations.size, 0)
})

test('caller cannot supply identity, status, progress or evidence claims; observation API stays fixed-scope', async t => {
  const f = makeFixture(t)
  const forged = f.exec('call-forged', { attempt: { identity: { taskId: 'other' }, status: 'passed', progress: true,
    newEvidenceRef: 'invented-proof' } })
  await assert.rejects(f.ctx.registrations.get('tools/pre-execute')[0](forged, async () => ({ kind: 'allow' })),
    { code: 'HYPOTHESIS_RUNTIME_ATTEMPT_INPUT_INVALID' })
  assert.throws(() => f.runtime.check(f.exec('read-only'), {
    requirementId: 'req-1', hypothesisId: 'parser-boundary', failureCause: 'cause', probe: { kind: 'standard', method: 'baseline' }, identity: { taskId: 'other' },
  }), { code: 'HYPOTHESIS_RUNTIME_OBSERVATION_INPUT_INVALID' })
  assert.throws(() => f.runtime.observe(f.exec('scope')) .entries.push({}), TypeError)

  const untracked = f.exec('call-untracked')
  f.attempts.delete(untracked)
  untracked.arguments.hypothesisAttempt = { status: 'passed', progress: true }
  await f.ctx.registrations.get('tools/pre-execute')[0](untracked, async () => ({ kind: 'allow' }))
  await f.ctx.registrations.get('tools/result')[0](untracked, { isError: false })
  assert.equal(f.runtime.observe(untracked).entries.length, 0)
})

test('dispose removes both hooks and clears pending observations', async t => {
  const f = makeFixture(t)
  const call = f.exec('call-pending')
  await f.ctx.registrations.get('tools/pre-execute')[0](call, async () => ({ kind: 'allow' }))
  assert.equal(f.runtime.dispose(), true)
  assert.equal(f.runtime.dispose(), false)
  assert.equal(f.ctx.registrations.get('tools/pre-execute').length, 0)
  assert.equal(f.ctx.registrations.get('tools/result').length, 0)
  assert.throws(() => f.runtime.observe(call), { code: 'HYPOTHESIS_RUNTIME_DISPOSED' })
})

test('attempt metadata requires a server callback and a declared current task requirement', async t => {
  const ctx = makeContext()
  assert.throws(() => apply(ctx, { memoryFile: 'unused.json', readDurable: () => ({}),
    collectContext: () => ({}), verifyPlan: () => true }), { code: 'HYPOTHESIS_RUNTIME_AUTHORITY_UNAVAILABLE' })
  assert.equal(ctx.registrations.size, 0)
  const f = makeFixture(t)
  let ran = false
  await assert.rejects(f.ctx.registrations.get('tools/pre-execute')[0](
    f.exec('wrong-requirement', { attempt: { requirementId: 'foreign' } }), async () => { ran = true }),
    { code: 'HYPOTHESIS_RUNTIME_REQUIREMENT_UNVERIFIED' })
  assert.equal(ran, false)
  f.state.v15PlanDelivery.plans['plan-1'].items[0].taskRefs = [{ boardId: 'board-1', taskId: 'foreign' }]
  await assert.rejects(f.run(f.exec('foreign-task'), { isError: false }),
    { code: 'HYPOTHESIS_RUNTIME_REQUIREMENT_UNVERIFIED' })
})
