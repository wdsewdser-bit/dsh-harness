import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  planApprovalVerdict,
  reassignActiveOwnerVerdict,
} from '../home/profiles/web/plugins/team-tools-v2-r10.mjs'
import {
  boardCreate,
  boardUpdate,
  createBoards,
} from '../home/profiles/web/plugins/team-policy.mjs'
import {
  controlPlaneFor,
  resetControlPlaneCache,
} from '../home/profiles/web/plugins/team-control-plane.mjs'
import {
  detectScopeConflicts,
} from '../home/profiles/web/plugins/team-v12-contract.mjs'
import {
  apply as applyWriteScopeGuard,
  isEvidenceCheckoutPath,
} from '../home/profiles/web/plugins/write-scope-guard.mjs'

test('B-85 live: a group lead cannot approve a repository-root governance scope', () => {
  const lead = { name: 'lead-rig', tier: 1, group: 'rig' }
  const plan = {
    taskId: 'group-rig-t33',
    members: [{ name: 'rig-trace', tier: 2, group: 'rig' }],
    writeScopes: ['.gitattributes'],
  }
  const verdict = planApprovalVerdict(lead, plan, 'group-rig')
  assert.equal(verdict.ok, false)
  assert.match(verdict.reason, /repository-root governance/)

  assert.equal(planApprovalVerdict(lead, {
    ...plan,
    writeScopes: ['tools/chunk-hash/src/lib.rs'],
  }, 'group-rig').ok, true)
})

test('B-95: a dependency-blocked task may be reassigned while its owner is active', () => {
  assert.deepEqual(reassignActiveOwnerVerdict({ ready: false }, { status: 'running' }), {
    ok: true,
    reason: 'dependency-blocked',
  })
  assert.equal(reassignActiveOwnerVerdict({ ready: true }, { status: 'running' }).ok, false)
  assert.equal(reassignActiveOwnerVerdict({ ready: true }, { status: 'idle' }).ok, true)

  const boards = createBoards()
  let task = boardCreate(boards, 'group-rig', {
    subject: 'blocked edit',
    blockedBy: ['missing-dependency'],
    writeScopes: ['tools/chunk-hash'],
  })
  task = boardUpdate(boards, 'group-rig', {
    taskId: task.id,
    expectedRevision: task.revision,
    action: 'reassign',
    owner: 'rig-trace',
  }, 'lead-rig')
  assert.equal(task.ownerName, 'rig-trace')
  assert.equal(task.ready, false)
  assert.equal(task.status, 'pending')
})

test('B-96: tier-0 and group leads may create bounded external evidence checkouts', () => {
  const env = { DSH_HOME: 'D:\\dsh-test\\home' }
  assert.equal(isEvidenceCheckoutPath('D:\\dsh-test\\tmp\\t93-check', { tier: 1 }, env), true)
  assert.equal(isEvidenceCheckoutPath('D:\\dsh-test\\tmp\\t93-check', { tier: 0 }, env), true)
  assert.equal(isEvidenceCheckoutPath('D:\\dsh-test\\tmp\\t93-check', { tier: 2 }, env), false)
  assert.equal(isEvidenceCheckoutPath('D:\\dsh-test\\workspaces\\RustMc\\src', { tier: 1 }, env), false)

  const root = mkdtempSync(join(tmpdir(), 'dsh-b96-'))
  const scopesFile = join(root, 'scopes.json')
  // The guard's listener reads process.env, so the home is pinned for this test only.
  const previousHome = process.env.DSH_HOME
  process.env.DSH_HOME = env.DSH_HOME
  try {
    writeFileSync(scopesFile, JSON.stringify({
      rootDir: 'D:\\dsh-test\\workspaces\\RustMc',
      defaultDeny: true,
      byName: {},
      bySession: {},
    }))
    const registered = []
    const ctx = {
      logger: { warn: () => {} },
      on: (event, listener, options) => registered.push([event, listener, options]),
      agentTeams: {
        tryMembership: () => ({ name: 'lead-rig', tier: 1, group: 'rig' }),
      },
    }
    applyWriteScopeGuard(ctx, { scopesFile, enforce: true })
    const listener = registered.find((row) => row[0] === 'fs/write-intent')?.[1]
    assert.equal(typeof listener, 'function')
    assert.doesNotThrow(() => listener({
      displayPath: 'D:\\dsh-test\\tmp\\t93-check\\README.md',
      targetKey: 'D:\\dsh-test\\tmp\\t93-check\\README.md',
    }, {
      agent: { name: 'lead-rig', session: { id: 'sess-rig' } },
    }))
  } finally {
    if (previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousHome
    rmSync(root, { recursive: true, force: true })
  }
})

test('B-97: a deleted losing card no longer occupies its write scope', () => {
  const tasks = [{
    id: 'group-rig-t32',
    status: 'deleted',
    lifecycle: 'blocked',
    owner: 'rig-trace',
    writeScopes: ['tools/chunk-hash'],
    contract: { lifecycle: 'blocked', writeScopes: ['tools/chunk-hash'] },
  }]
  const candidate = {
    id: 'group-world-t32',
    lifecycle: 'running',
    owner: 'world-trace',
    writeScopes: ['tools/chunk-hash'],
  }
  assert.deepEqual(detectScopeConflicts(tasks, candidate), [])
})

test('B-98: release refuses a deleted tombstone instead of resurrecting it', async () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-b98-'))
  try {
    const cp = controlPlaneFor('tenth-pass-b98', { directory: root })
    let task = await cp.boardCreate({
      boardId: 'group-rig',
      taskId: 'group-rig-t32',
      subject: 'deleted loser',
      ownerName: 'rig-trace',
      writeScopes: ['tools/chunk-hash'],
    })
    task = await cp.boardUpdate({
      boardId: 'group-rig',
      taskId: task.id,
      expectedRevision: task.revision,
      action: 'delete',
      actorName: 'lead-rig',
    })
    await assert.rejects(
      cp.boardUpdate({
        boardId: 'group-rig',
        taskId: task.id,
        expectedRevision: task.revision,
        action: 'release',
        actorName: 'rig-trace',
      }),
      /cannot release deleted task/,
    )
    const after = await cp.boardGet('group-rig', task.id)
    assert.equal(after.status, 'deleted')
    assert.equal(after.revision, task.revision)
  } finally {
    resetControlPlaneCache()
    rmSync(root, { recursive: true, force: true })
  }
})
