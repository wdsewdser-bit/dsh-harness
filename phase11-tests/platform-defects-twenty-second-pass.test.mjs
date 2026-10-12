import test from 'node:test'
import assert from 'node:assert/strict'

import { compactRuntimeFacts } from '../home/profiles/web/plugins/team-v12-runtime.mjs'
import {
  crossBoardBlockerVerdict,
  taskContractRevisionProjection,
  taskEditWriteScopeVerdict,
} from '../home/profiles/web/plugins/team-tools-v2-r10.mjs'
import {
  isVerifierScratchPath,
  verifierScratchRoot,
} from '../home/profiles/web/plugins/write-scope-guard.mjs'

test('D-新-2 compact runtime facts omit noise-only plugins regardless of runtime entry shape', () => {
  const report = {
    schemaVersion: 1,
    kind: 'dsh.runtime-facts',
    collectedAt: '2026-09-29T00:00:00.000Z',
    instance: null,
    dsh: { version: 'test', profile: 'web' },
    collection: { complete: false, degraded: true, reasons: ['runtime evidence incomplete'] },
    plugins: {
      noise: {
        runtime: {
          id: 'noise',
          entry: { path: 'D:/plugins/noise.mjs', sha256: 'a'.repeat(64), error: null },
          stateOwner: null,
          schemaVersion: null,
          patch: null,
        },
      },
      signal: {
        runtime: {
          id: 'signal',
          entry: { path: 'D:/plugins/signal.mjs', sha256: 'b'.repeat(64), error: null },
          stateOwner: 'signal-owner',
          schemaVersion: 1,
          patch: 'signal-patch',
        },
      },
    },
    differences: [
      { pluginId: 'noise', code: 'patch-source-unknown', severity: 'error' },
      { pluginId: 'noise', code: 'schema-unknown', severity: 'warning' },
      { pluginId: 'noise', code: 'evidence-missing', severity: 'warning' },
      { pluginId: 'signal', code: 'configured-but-not-loaded', severity: 'error' },
    ],
    diffSummary: {
      total: 4,
      errors: 2,
      warnings: 2,
      codes: ['configured-but-not-loaded', 'evidence-missing', 'patch-source-unknown', 'schema-unknown'],
    },
  }

  const compact = compactRuntimeFacts(report)
  assert.equal(compact.totalPlugins, 2)
  assert.equal(compact.includedPlugins, 1)
  assert.equal(compact.omittedPlugins, 1)
  assert.equal(compact.omittedNoisePlugins, 1)
  assert.deepEqual(Object.keys(compact.plugins), ['signal'])

  const selected = compactRuntimeFacts(report, ['noise'])
  assert.deepEqual(Object.keys(selected.plugins), ['noise'])
  assert.equal(selected.includedPlugins, 1)
})

test('D-新-3 verifier scratch is platform-managed and verifier-only', () => {
  const env = { DSH_HOME: 'D:\\dsh-test\\home' }
  const scratch = 'D:\\dsh-test\\home\\verifier-scratch\\t55'
  assert.equal(verifierScratchRoot(env), 'D:\\dsh-test\\home\\verifier-scratch')
  assert.equal(isVerifierScratchPath(scratch, { group: 'verifier', tier: 2 }, env), true)
  assert.equal(isVerifierScratchPath('D:\\dsh-test\\home\\verifier-scratch-evil\\t55', { group: 'verifier' }, env), false)
  assert.equal(isVerifierScratchPath(scratch, { group: 'rig', tier: 2 }, env), false)
  assert.equal(isVerifierScratchPath('D:\\dsh-test\\workspaces\\RustMc\\src\\main.rs', { group: 'verifier' }, env), false)
})

test('D-新-4 cross-board blockers are rejected with the board that owns the task', () => {
  const boards = {
    global: { tasks: { 'global-t1': { id: 'global-t1' } } },
    'group-rig': { tasks: { 'group-rig-t63': { id: 'group-rig-t63' } } },
  }
  const verdict = crossBoardBlockerVerdict(['group-rig-t63'], 'global', boards)
  assert.equal(verdict.ok, false)
  assert.deepEqual(verdict.crossBoard, [{ id: 'group-rig-t63', boards: ['group-rig'] }])
  assert.match(verdict.detail, /group-rig-t63 exists on group-rig/)
  assert.equal(crossBoardBlockerVerdict(['global-t1'], 'global', boards).ok, true)
})

test('D-新-5 mixed controlled edits explicitly state the whole call was atomic', () => {
  const verdict = taskEditWriteScopeVerdict({
    action: 'edit',
    description: 'must not be silently lost',
    write_scopes: ['src/'],
  })
  assert.equal(verdict.ok, false)
  assert.equal(verdict.atomic, true)
  assert.deepEqual(verdict.unappliedFields, ['description'])
  assert.match(verdict.reason, /no fields were applied/)
  assert.match(verdict.reason, /description/)
})

test('D-新-7 contract projection exposes stale revision state', () => {
  const stale = taskContractRevisionProjection(
    { contractRevision: 2 },
    { revision: 3 },
  )
  assert.deepEqual(stale, {
    contractRevision: 2,
    requirementRevision: 3,
    contractStale: true,
  })
  const current = taskContractRevisionProjection(
    { contractRevision: 3 },
    { revision: 3 },
  )
  assert.equal(current.contractStale, false)
})
