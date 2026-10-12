import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { createHash, randomUUID } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  controlPlaneFor,
  resetControlPlaneCache,
} from '../home/profiles/web/plugins/team-control-plane.mjs'
import {
  createActiveIdentityService,
} from '../home/profiles/web/plugins/team-v15-active-identity.mjs'
import { buildContextDelivery } from '../home/profiles/web/plugins/team-v14-context-delivery.mjs'

const digest = (value) => createHash('sha256').update(value).digest('hex')

function writeIdentityBundle(rolesDir, version, marker) {
  const bodies = {
    'AGENTS.md': '# Shared ' + marker + '\n',
    'root.md': '# Root ' + marker + '\n',
    'lead.md': '# Lead ' + marker + '\n',
    'member.md': '# Member ' + marker + '\n',
    'verifier.md': '# Verifier ' + marker + '\n',
  }
  for (const [name, body] of Object.entries(bodies)) fs.writeFileSync(join(rolesDir, name), body, 'utf8')
  fs.writeFileSync(join(rolesDir, 'identity-version.json'), JSON.stringify({
    schemaVersion: 1,
    identityVersion: version,
    files: Object.fromEntries(Object.entries(bodies).map(([name, body]) => [name, digest(body)])),
  }, null, 2), 'utf8')
}

function testActors() {
  return new Map([
    ['root', { name: 'root', id: 'agent-root', tier: 0 }],
    ['lead', { name: 'lead-a', id: 'agent-lead', tier: 1 }],
    ['member', { name: 'member-a', id: 'agent-member', tier: 2 }],
    ['verifier', { name: 'verifier-a', id: 'agent-verifier', role: 'verifier', tier: 2 }],
  ])
}

async function createWorld(t, initialVersion = 'identity-a', marker = 'A') {
  const tempRoot = fs.mkdtempSync(join(tmpdir(), 'active-identity-'))
  const rolesDir = join(tempRoot, 'roles')
  const cpDirectory = join(tempRoot, 'control-plane')
  fs.mkdirSync(rolesDir)
  fs.mkdirSync(cpDirectory)
  writeIdentityBundle(rolesDir, initialVersion, marker)

  const rootId = 'active-identity-' + randomUUID()
  const actors = testActors()
  const cp = controlPlaneFor(rootId, { directory: cpDirectory })
  await cp.mutateHot('test/seed', {}, null, state => { state.testSeed = true }, { deferMs: 0 })
  const createService = plane => createActiveIdentityService({
    controlPlane: plane,
    rolesDir,
    allowedRoots: [tempRoot],
    resolveActor: context => actors.get(context?.principal),
  })
  const service = createService(cp)
  t.after(() => { resetControlPlaneCache(); fs.rmSync(tempRoot, { recursive: true, force: true }) })
  return { tempRoot, rolesDir, cpDirectory, rootId, cp, service, createService }
}

function cas(cp, service, overrides = {}) {
  const state = cp.snapshot({ history: false, copy: true })
  return {
    expectedControlRevision: state.revision,
    expectedIdentityEpoch: state.identityEpoch ?? 0,
    expectedBundleHash: service.readonly.proposal().contentHash,
    ...overrides,
  }
}

const rootContext = Object.freeze({ principal: 'root' })

test('delivery revision changes on same-name activation and A to B to A', async t => {
  const { cp, service, rolesDir } = await createWorld(t)
  await service.internal.activate(cas(cp, service), rootContext)
  const first = service.readonly.identitySource(rootContext)
  writeIdentityBundle(rolesDir, 'identity-a', 'B')
  await service.internal.activate(cas(cp, service), rootContext)
  const second = service.readonly.identitySource(rootContext)
  assert.notEqual(second.revision, first.revision)
  writeIdentityBundle(rolesDir, 'identity-a', 'A')
  await service.internal.activate(cas(cp, service), rootContext)
  const third = service.readonly.identitySource(rootContext)
  assert.notEqual(third.revision, first.revision)
  assert.equal(third.metadata.contentHash, first.metadata.contentHash)
})

test('a proposal edit after durable publication cannot turn approved activation into an apparent failure', async t => {
  const { cp, rolesDir, createService } = await createWorld(t)
  const service = createService({
    snapshot: options => cp.snapshot(options),
    mutateHot(type, payload, actor, mutate, options) {
      return cp.mutateHot(type, payload, actor, mutate, { ...options,
        afterDurable(result, durable) {
          fs.writeFileSync(join(rolesDir, 'member.md'), 'new unapproved proposal')
          return options.afterDurable(result, durable)
        },
      })
    },
  })
  const activated = await service.internal.activate(cas(cp, service), rootContext)
  assert.equal(activated.epoch, 1)
  assert.match(service.readonly.identitySource({ principal: 'member' }).content, /# Member A/)
  assert.throws(() => service.readonly.proposal(), /identity hash mismatch/)
})

test('active bundle is durable, disk edits wait for explicit activation, and role mapping stays exact', async t => {
  const world = await createWorld(t)
  const { cp, service, rolesDir } = world

  assert.throws(() => service.readonly.snapshot(), { code: 'ACTIVE_IDENTITY_NOT_SET' })
  const first = await service.internal.activate(cas(cp, service), rootContext)
  assert.equal(first.epoch, 1)
  assert.equal(first.controlRevision, cp.snapshot({ history: false, copy: true }).revision)

  const roleCases = [
    [{ principal: 'root' }, 'root.md', '# Root A'],
    [{ principal: 'lead' }, 'lead.md', '# Lead A'],
    [{ principal: 'member' }, 'member.md', '# Member A'],
    [{ principal: 'verifier' }, 'verifier.md', '# Verifier A'],
  ]
  for (const [context, roleFile, expected] of roleCases) {
    const source = service.readonly.identitySource(context)
    assert.equal(source.metadata.roleFile, roleFile)
    assert.match(source.content, new RegExp(expected))
    assert.equal(source.metadata.identityEpoch, 1)
  }

  const approvedProposal = service.readonly.proposal()
  writeIdentityBundle(rolesDir, 'identity-b', 'B')
  assert.equal(service.readonly.snapshot().identityVersion, 'identity-a')
  assert.match(service.readonly.identitySource({ principal: 'member' }).content, /# Member A/)
  const beforeStaleProposal = cp.snapshot({ history: false, copy: true })
  await assert.rejects(service.internal.activate({
    expectedControlRevision: beforeStaleProposal.revision,
    expectedIdentityEpoch: beforeStaleProposal.identityEpoch,
    expectedBundleHash: approvedProposal.contentHash,
  }, rootContext), { code: 'IDENTITY_PROPOSAL_STALE' })
  assert.equal(cp.snapshot({ history: false, copy: true }).revision, beforeStaleProposal.revision)
  const second = await service.internal.activate(cas(cp, service), rootContext)
  assert.equal(second.epoch, 2)
  assert.equal(service.readonly.snapshot().identityVersion, 'identity-b')
  assert.match(service.readonly.identitySource({ principal: 'member' }).content, /# Member B/)

  resetControlPlaneCache()
  const restored = controlPlaneFor(world.rootId, { directory: world.cpDirectory })
  const restoredService = world.createService(restored)
  assert.equal(restoredService.readonly.snapshot().epoch, 2)
  assert.equal(restoredService.readonly.snapshot().contentHash, second.contentHash)
  assert.match(restoredService.readonly.identitySource({ principal: 'member' }).content, /# Member B/)
  assert.equal(restored.get().activeIdentity.bundle.contentHash, second.contentHash)
  assert.equal(world.service.readonly.proposal().contentHash, second.contentHash)
})

test('activation rejects full-manifest hash mismatch, stale CAS, non-root callers, and tool-supplied authority fields', async t => {
  const { cp, service, rolesDir } = await createWorld(t)
  const initial = await service.internal.activate(cas(cp, service), rootContext)
  const beforeBadActivation = cp.snapshot({ history: false, copy: true })
  const beforeBadProposal = service.readonly.proposal()

  fs.writeFileSync(join(rolesDir, 'verifier.md'), '# changed without manifest update\n', 'utf8')
  await assert.rejects(service.internal.activate({
    expectedControlRevision: beforeBadActivation.revision,
    expectedIdentityEpoch: beforeBadActivation.identityEpoch,
    expectedBundleHash: beforeBadProposal.contentHash,
  }, rootContext), { code: 'IDENTITY_HASH_MISMATCH' })
  assert.equal(service.readonly.snapshot().contentHash, initial.contentHash)
  assert.equal(cp.snapshot({ history: false, copy: true }).revision, beforeBadActivation.revision)

  const staleProposal = {
    expectedControlRevision: beforeBadActivation.revision - 1,
    expectedIdentityEpoch: beforeBadActivation.identityEpoch,
    expectedBundleHash: beforeBadProposal.contentHash,
  }
  await assert.rejects(service.internal.activate(staleProposal, rootContext), { code: 'IDENTITY_CONTROL_REVISION_STALE' })
  await assert.rejects(service.internal.activate({
    ...staleProposal,
    expectedControlRevision: beforeBadActivation.revision,
    expectedIdentityEpoch: 0,
  }, rootContext), { code: 'IDENTITY_EPOCH_STALE' })

  writeIdentityBundle(rolesDir, 'identity-a', 'A')
  const revision = cp.snapshot({ history: false, copy: true }).revision
  await assert.rejects(service.internal.activate(cas(cp, service, {
    actor: { name: 'root', tier: 0 },
    status: 'active',
    bundle: { content: 'caller text' },
  }), { principal: 'member', tier: 0, role: 'root' }), { code: 'IDENTITY_ACTIVATION_INPUT_INVALID' })
  await assert.rejects(service.internal.activate(cas(cp, service), { principal: 'member', tier: 0, role: 'root' }), {
    code: 'IDENTITY_ACTIVATION_ROOT_REQUIRED',
  })
  assert.equal(cp.snapshot({ history: false, copy: true }).revision, revision)
})

test('A to B to A advances the identity epoch every time', async t => {
  const { cp, service, rolesDir } = await createWorld(t)
  const first = await service.internal.activate(cas(cp, service), rootContext)
  writeIdentityBundle(rolesDir, 'identity-b', 'B')
  const second = await service.internal.activate(cas(cp, service), rootContext)
  writeIdentityBundle(rolesDir, 'identity-a', 'A')
  const third = await service.internal.activate(cas(cp, service), rootContext)

  assert.deepEqual([first.epoch, second.epoch, third.epoch], [1, 2, 3])
  assert.equal(first.contentHash, third.contentHash)
  assert.equal(service.readonly.snapshot().epoch, 3)
})

test('activation queues behind the real control-plane window fence', async t => {
  const { cp, service } = await createWorld(t)
  const expected = cas(cp, service)
  const fence = await cp.acquireWindowFence(cp.windowFenceFacts().binding, {
    isolated: true,
    sessionId: 'active-identity-test',
  })
  let settled = false
  const pending = service.internal.activate(expected, rootContext).finally(() => { settled = true })
  await new Promise(resolve => setTimeout(resolve, 50))
  assert.equal(settled, false)
  await fence.release()
  const activation = await pending
  assert.equal(activation.epoch, 1)
  assert.equal(service.readonly.snapshot().epoch, 1)
})

test('roles root must be within the configured physical allowlist', async t => {
  const { tempRoot, rolesDir, cp } = await createWorld(t)
  const before = cp.snapshot({ history: false, copy: true })
  const outside = join(tempRoot, 'outside')
  fs.mkdirSync(outside)
  assert.throws(() => createActiveIdentityService({
    controlPlane: cp,
    rolesDir,
    allowedRoots: [outside],
    resolveActor: context => testActors().get(context?.principal),
  }), { code: 'IDENTITY_ROOT_NOT_ALLOWED' })
  assert.equal(cp.snapshot({ history: false, copy: true }).revision, before.revision)
})

test('proposal byte budget is finite and enforced before activation', async t => {
  const { tempRoot, rolesDir, cp } = await createWorld(t)
  const limited = createActiveIdentityService({
    controlPlane: cp,
    rolesDir,
    allowedRoots: [tempRoot],
    resolveActor: context => testActors().get(context?.principal),
    maxBundleBytes: 128,
  })
  assert.throws(() => limited.readonly.proposal(), { code: 'IDENTITY_BUNDLE_TOO_LARGE' })
  assert.equal(cp.snapshot({ history: false, copy: true }).identityEpoch, undefined)
})

// ---- C-02 dynamic identity semantics: common-only / single-role / mid-step ----

const ROLE_CONTEXTS = Object.freeze({
  root: Object.freeze({ principal: 'root' }),
  lead: Object.freeze({ principal: 'lead' }),
  member: Object.freeze({ principal: 'member' }),
  verifier: Object.freeze({ principal: 'verifier' }),
})
const ROLE_FILES = Object.freeze({ root: 'root.md', lead: 'lead.md', member: 'member.md', verifier: 'verifier.md' })
const ROLE_HEADINGS = Object.freeze({ root: '# Root', lead: '# Lead', member: '# Member', verifier: '# Verifier' })

// Per-file markers; unspecified files default to 'A'. The manifest hashes are always
// regenerated from the actual five files, exactly like an operator-prepared proposal.
function writeIdentityParts(rolesDir, version, markers = {}) {
  const marker = name => markers[name] ?? 'A'
  const bodies = {
    'AGENTS.md': '# Shared ' + marker('AGENTS.md') + '\n',
    'root.md': '# Root ' + marker('root.md') + '\n',
    'lead.md': '# Lead ' + marker('lead.md') + '\n',
    'member.md': '# Member ' + marker('member.md') + '\n',
    'verifier.md': '# Verifier ' + marker('verifier.md') + '\n',
  }
  for (const [name, body] of Object.entries(bodies)) fs.writeFileSync(join(rolesDir, name), body, 'utf8')
  fs.writeFileSync(join(rolesDir, 'identity-version.json'), JSON.stringify({
    schemaVersion: 1,
    identityVersion: version,
    files: Object.fromEntries(Object.entries(bodies).map(([name, body]) => [name, digest(body)])),
  }, null, 2), 'utf8')
}

const allRoleSources = service => Object.fromEntries(
  Object.entries(ROLE_CONTEXTS).map(([role, context]) => [role, service.readonly.identitySource(context)]))

const SESSION_ID = 'identity-dynamic-session'
const deliver = (source, member, visible = []) => buildContextDelivery({
  sources: [source], visible, member, sessionId: SESSION_ID, maxTokens: 4000,
})
const asVisible = body => [{
  source: { kind: 'team-message', plugin: 'team-v12-runtime' },
  content: [{ type: 'text', text: body }],
}]

test('common-only identity change re-versions every role and delivers the new common without the old one', async t => {
  const { cp, service, rolesDir } = await createWorld(t)
  await service.internal.activate(cas(cp, service), rootContext)
  const before = allRoleSources(service)
  const firstDeliveries = Object.fromEntries(Object.entries(before)
    .map(([role, source]) => [role, deliver(source, role)]))

  // Only AGENTS.md (common) changes; same identityVersion label, role files byte-identical.
  writeIdentityParts(rolesDir, 'identity-a', { 'AGENTS.md': 'B' })
  // Disk edit alone is a proposal: no role may see it before activation.
  for (const [role, source] of Object.entries(allRoleSources(service))) {
    assert.equal(source.revision, before[role].revision, role + ' revision must not move before activation')
    assert.equal(source.content, before[role].content, role + ' content must not move before activation')
  }
  const approved = cas(cp, service)
  assert.notEqual(approved.expectedBundleHash, before.root.metadata.contentHash)
  await service.internal.activate(approved, rootContext)

  const after = allRoleSources(service)
  const newHash = service.readonly.snapshot().contentHash
  for (const role of Object.keys(ROLE_CONTEXTS)) {
    const source = after[role]
    assert.notEqual(source.revision, before[role].revision, role + ' revision must change when only common changes')
    assert.notEqual(source.metadata.contentHash, before[role].metadata.contentHash, role)
    assert.equal(source.metadata.contentHash, newHash, role)
    assert.equal(source.metadata.identityEpoch, 2, role)
    assert.equal(source.metadata.roleFile, ROLE_FILES[role], role)
    assert.match(source.content, /# Shared B/, role + ' must carry the new common')
    assert.doesNotMatch(source.content, /# Shared A/, role + ' must not carry the old common')
    assert.match(source.content, new RegExp(ROLE_HEADINGS[role] + ' A'), role + ' own role text is unchanged')

    // Delivery level: the old body is already visible; the new common must still be redelivered.
    const redelivered = deliver(source, role, asVisible(firstDeliveries[role].body))
    assert.notEqual(redelivered.body, '', role + ' must be redelivered after a common-only change')
    assert.match(redelivered.body, /# Shared B/, role)
    assert.doesNotMatch(redelivered.body, /# Shared A/, role)
    // Control: with the new body visible, nothing is redelivered.
    assert.equal(deliver(source, role, asVisible(redelivered.body)).body, '', role + ' delta must be idempotent')
  }
})

test('common-only edit without regenerating the manifest hash is rejected and leaves the active identity untouched', async t => {
  const { cp, service, rolesDir } = await createWorld(t)
  const initial = await service.internal.activate(cas(cp, service), rootContext)
  const before = allRoleSources(service)
  const state = cp.snapshot({ history: false, copy: true })

  fs.writeFileSync(join(rolesDir, 'AGENTS.md'), '# Shared B (manifest not regenerated)\n', 'utf8')
  assert.throws(() => service.readonly.proposal(), { code: 'IDENTITY_HASH_MISMATCH', message: /AGENTS\.md/ })
  await assert.rejects(service.internal.activate({
    expectedControlRevision: state.revision,
    expectedIdentityEpoch: state.identityEpoch,
    expectedBundleHash: initial.contentHash,
  }, rootContext), { code: 'IDENTITY_HASH_MISMATCH', message: /AGENTS\.md/ })
  assert.equal(cp.snapshot({ history: false, copy: true }).revision, state.revision)
  for (const [role, source] of Object.entries(allRoleSources(service))) {
    assert.equal(source.revision, before[role].revision, role)
    assert.equal(source.content, before[role].content, role)
  }
})

test('single role-file change updates that role only; other roles keep identical text under a new bundle revision', async t => {
  const { cp, service, rolesDir } = await createWorld(t)
  await service.internal.activate(cas(cp, service), rootContext)
  const before = allRoleSources(service)

  writeIdentityParts(rolesDir, 'identity-a', { 'member.md': 'B' })
  for (const [role, source] of Object.entries(allRoleSources(service))) {
    assert.equal(source.content, before[role].content, role + ' must not hot-swap before activation')
    assert.equal(source.revision, before[role].revision, role + ' revision must not move before activation')
  }
  await service.internal.activate(cas(cp, service), rootContext)
  const after = allRoleSources(service)

  assert.match(after.member.content, /# Member B/)
  assert.doesNotMatch(after.member.content, /# Member A/)
  assert.notEqual(after.member.revision, before.member.revision)
  for (const role of ['root', 'lead', 'verifier']) {
    // Revision/hash/epoch are bundle-wide by design (A to B to A must always re-version), so
    // an unaffected role is re-versioned but must receive byte-identical text, never another role's text.
    assert.equal(after[role].content, before[role].content, role + ' text must be unchanged')
    assert.equal(after[role].metadata.roleFile, before[role].metadata.roleFile, role)
    assert.notEqual(after[role].revision, before[role].revision, role + ' is re-versioned with the bundle')
  }
  for (const [role, source] of Object.entries(after)) {
    assert.match(source.content, /# Shared A/, role + ' common is unchanged')
    for (const [other, heading] of Object.entries(ROLE_HEADINGS)) {
      if (other === role) assert.ok(source.content.includes(heading), role)
      else assert.ok(!source.content.includes(heading), role + ' must not contain ' + other + ' role text')
    }
  }
  // Invariant: the same revision can never carry different content for one role.
  for (const role of Object.keys(ROLE_CONTEXTS)) {
    if (after[role].content !== before[role].content) assert.notEqual(after[role].revision, before[role].revision, role)
  }
})

test('activation in the middle of a step does not alter the captured identity; the next turn delivers the new one', async t => {
  const { cp, service, rolesDir } = await createWorld(t)
  await service.internal.activate(cas(cp, service), rootContext)

  // Step N starts: identity is captured and its request body is assembled from A.
  const captured = service.readonly.identitySource({ principal: 'member' })
  const capturedSnapshot = JSON.stringify(captured)
  const stepRequest = deliver(captured, 'member')
  const stepRequestSnapshot = JSON.stringify(stepRequest)
  assert.match(stepRequest.body, /# Shared A/)
  assert.match(stepRequest.body, /# Member A/)

  // Mid-step: the proposal is edited and a root activation commits while step N is in flight.
  writeIdentityParts(rolesDir, 'identity-a', { 'AGENTS.md': 'B', 'member.md': 'B' })
  const midStep = await service.internal.activate(cas(cp, service), rootContext)
  assert.equal(midStep.epoch, 2)

  // Captured identity and the already assembled request are immutable and still A.
  assert.equal(JSON.stringify(captured), capturedSnapshot)
  assert.equal(JSON.stringify(stepRequest), stepRequestSnapshot)
  assert.ok(Object.isFrozen(captured))
  assert.doesNotMatch(stepRequest.body, /# (Shared|Member) B/)
  // Re-diffing the captured source against the committed step request yields nothing: no in-step delta.
  assert.equal(deliver(captured, 'member', asVisible(stepRequest.body)).body, '')

  // Step N+1 (next safe turn) reads the durable active identity and delivers only the new one.
  const next = service.readonly.identitySource({ principal: 'member' })
  assert.notEqual(next.revision, captured.revision)
  const nextRequest = deliver(next, 'member', asVisible(stepRequest.body))
  assert.match(nextRequest.body, /# Shared B/)
  assert.match(nextRequest.body, /# Member B/)
  assert.doesNotMatch(nextRequest.body, /# (Shared|Member) A/)
  assert.equal(deliver(next, 'member', asVisible(nextRequest.body)).body, '')
})
