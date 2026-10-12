import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  apply,
  policyFor,
  policyServiceCount,
  resetPolicyServices,
} from '../home/profiles/web/plugins/team-policy.mjs'

test('team policy service cache is bounded and keeps recently used Teams', () => {
  const root = mkdtempSync(join(tmpdir(), 'v14-policy-cache-'))
  try {
    resetPolicyServices()
    apply({}, { controlDir: join(root, 'control') })
    resetPolicyServices()

    const first = []
    for (let index = 0; index < 16; index += 1) {
      first[index] = policyFor('team-' + String(index))
    }
    assert.equal(policyServiceCount(), 16)

    const touched = policyFor('team-0')
    assert.equal(touched, first[0])
    policyFor('team-16')

    assert.equal(policyServiceCount(), 16)
    assert.notEqual(policyFor('team-1'), first[1])
    assert.equal(policyFor('team-0'), first[0])
  } finally {
    resetPolicyServices()
    rmSync(root, { recursive: true, force: true })
  }
})

test('refreshBoards can reuse a caller-owned hot snapshot without reloading', () => {
  const root = mkdtempSync(join(tmpdir(), 'v14-policy-snapshot-'))
  try {
    resetPolicyServices()
    apply({}, { controlDir: join(root, 'control') })
    const service = policyFor('snapshot-reuse')
    const snapshot = {
      revision: 999,
      boards: {
        global: {
          seq: 1,
          tasks: {
            'global-t1': { id: 'global-t1', status: 'pending', revision: 1 },
          },
        },
      },
    }
    let reloads = 0
    service.control.reload = () => {
      reloads += 1
      return snapshot
    }

    service.refreshBoards(snapshot)
    assert.equal(reloads, 0)
    assert.deepEqual(service.boardList('global').map((task) => task.id), ['global-t1'])

    service.refreshBoards()
    assert.equal(reloads, 1)
  } finally {
    resetPolicyServices()
    rmSync(root, { recursive: true, force: true })
  }
})

test('refreshBoards clones only board tasks whose revision changed', () => {
  const root = mkdtempSync(join(tmpdir(), 'v14-policy-incremental-'))
  const originalClone = globalThis.structuredClone
  try {
    resetPolicyServices()
    apply({}, { controlDir: join(root, 'control') })
    const service = policyFor('snapshot-incremental')
    const task = { id: 'global-t1', status: 'pending', revision: 1 }
    const first = {
      revision: 10,
      boards: { global: { seq: 1, tasks: { 'global-t1': task } } },
    }

    let clones = 0
    globalThis.structuredClone = (value) => {
      clones += 1
      return originalClone(value)
    }

    service.refreshBoards(first)
    assert.equal(clones, 1)

    service.refreshBoards({ ...first, revision: 11 })
    assert.equal(clones, 1)

    const changed = { ...task, revision: 2, status: 'in_progress' }
    service.refreshBoards({
      revision: 12,
      boards: { global: { seq: 1, tasks: { 'global-t1': changed } } },
    })
    assert.equal(clones, 2)
    assert.equal(service.boardList('global')[0].status, 'in_progress')
  } finally {
    globalThis.structuredClone = originalClone
    resetPolicyServices()
    rmSync(root, { recursive: true, force: true })
  }
})
