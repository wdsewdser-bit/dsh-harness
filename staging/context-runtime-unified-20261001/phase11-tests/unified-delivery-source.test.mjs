import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { collectDeliveryContext, collectDeliverySource } from '../home/profiles/web/plugins/team-v15-delivery-source.mjs'

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'unified-delivery-source-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  mkdirSync(join(root, 'src'))
  writeFileSync(join(root, 'src', 'a.mjs'), 'export const original = true\n')
  function ref(name, body) {
    const path = join(root, name)
    writeFileSync(path, body)
    return { path, sha256: createHash('sha256').update(body).digest('hex') }
  }
  const policy = { workspaceRoot: root, allowedRoots: [root],
    recipeRef: ref('recipe.json', '{"command":"node --test"}'), environmentRefs: [ref('dependencies.json', '{"fixture":1}')],
    collectAuthorityDebt: () => ({ unresolvedDebt: [], blockers: [] }) }
  return { root, policy, plan: { planId: 'p', planRevision: 1, scope: ['src'] } }
}

test('server physical manifest changes for dirty file and new untracked file, not a supplied evidence source id', t => {
  const f = fixture(t)
  const original = collectDeliverySource(f.plan, f.policy)
  assert.equal(original.manifest.files.length, 1)
  const a = collectDeliveryContext({ v15DeliveryContext: { sourceIdentity: { manifestHash: 'spoofed' } } }, f.plan, f.policy)
  assert.deepEqual(a.sourceIdentity, original.sourceIdentity)
  writeFileSync(join(f.root, 'src', 'a.mjs'), 'dirty contents\n')
  const dirty = collectDeliverySource(f.plan, f.policy)
  assert.notDeepEqual(dirty.sourceIdentity, original.sourceIdentity)
  writeFileSync(join(f.root, 'src', 'untracked.mjs'), 'new mandatory source\n')
  assert.notDeepEqual(collectDeliverySource(f.plan, f.policy).sourceIdentity, dirty.sourceIdentity)
})

test('scope traversal, physical junction escape and bounded tree overflow cannot produce a manifest', t => {
  const f = fixture(t)
  assert.throws(() => collectDeliverySource({ scope: ['../'] }, f.policy), { code: 'DELIVERY_SOURCE_PATH_DENIED' })
  assert.throws(() => collectDeliverySource(f.plan, { ...f.policy, maxBytes: 1 }), { code: 'DELIVERY_SOURCE_BUDGET_EXCEEDED' })
  writeFileSync(join(f.root, 'src', 'second'), 'second')
  assert.throws(() => collectDeliverySource(f.plan, { ...f.policy, maxFiles: 1 }), { code: 'DELIVERY_SOURCE_BUDGET_EXCEEDED' })
  const outside = mkdtempSync(join(tmpdir(), 'delivery-source-outside-'))
  t.after(() => rmSync(outside, { recursive: true, force: true }))
  symlinkSync(outside, join(f.root, 'src', 'escape'), 'junction')
  assert.throws(() => collectDeliverySource(f.plan, f.policy), { code: 'DELIVERY_SOURCE_PATH_DENIED' })
})

test('exact environment/recipe refs and explicit server debt collector are required, never client booleans', t => {
  const f = fixture(t)
  assert.throws(() => collectDeliveryContext({}, f.plan, { ...f.policy, collectAuthorityDebt: undefined }), { code: 'DELIVERY_DEBT_COLLECTOR_UNAVAILABLE' })
  assert.throws(() => collectDeliveryContext({}, f.plan, { ...f.policy, environmentRefs: [] }), { code: 'DELIVERY_ENVIRONMENT_UNAVAILABLE' })
  const before = collectDeliveryContext({}, f.plan, f.policy)
  assert.equal(before.unresolvedDebt.length, 0)
  assert.equal(before.environmentFingerprint.length, 64)
  writeFileSync(f.policy.recipeRef.path, 'changed command')
  assert.throws(() => collectDeliveryContext({}, f.plan, f.policy), { code: 'RECOVERY_SOURCE_HASH_MISMATCH' })
})

test('pending full-plan fetch and pending native input prevent a clean completion debt snapshot', t => {
  const f = fixture(t)
  const state = { v15PlanReadReceipts: { r: { id: 'r', planId: 'p', planRevision: 1, requiredFetch: true } } }
  const result = collectDeliveryContext(state, f.plan, f.policy, { agent: { inbox: { nextStep: ['new user correction'] } } })
  assert.deepEqual(result.unresolvedDebt, ['plan-read:r', 'pending-input'])
  assert.throws(() => collectDeliveryContext(state, f.plan, { ...f.policy, collectAuthorityDebt: async () => ({ unresolvedDebt: [], blockers: [] }) }),
    { code: 'DELIVERY_DEBT_UNVERIFIED' })
})
