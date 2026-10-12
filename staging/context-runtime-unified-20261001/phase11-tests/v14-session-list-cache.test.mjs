import assert from 'node:assert/strict'
import test from 'node:test'

import JsonlSessionPersistence from '../app/node_modules/@deepseek-ai/dsh-session-persistence-jsonl/lib/index.js'

function backendWithProbe() {
  const backend = Object.create(JsonlSessionPersistence.prototype)
  Object.assign(backend, {
    artifactListCache: undefined,
    artifactListExpiresAt: 0,
    artifactListInFlight: undefined,
    artifactListGeneration: 0,
  })
  let scans = 0
  backend.ensureRootEncoding = async () => {}
  backend.listGenerations = async () => {
    scans += 1
    await new Promise((resolve) => setTimeout(resolve, 20))
    return [{ sourcePath: 'D:/fixture/session.v4.jsonl.zstd', sourceVersion: 4 }]
  }
  backend.readGenerationHeader = async () => ({
    id: 'session-fixture',
    cwd: 'D:/fixture',
    createdAt: 1,
    isSeeded: false,
    delegationDepth: 0,
  })
  return { backend, scans: () => scans }
}

test('session artifact listing coalesces concurrent reads and caches the result', async () => {
  const { backend, scans } = backendWithProbe()
  const [first, second] = await Promise.all([backend.listArtifacts(), backend.listArtifacts()])
  const third = await backend.listArtifacts()

  assert.equal(first.length, 1)
  assert.equal(second.length, 1)
  assert.equal(third.length, 1)
  assert.equal(scans(), 1)
})

test('session artifact listing invalidates on local persistence changes', async () => {
  const { backend, scans } = backendWithProbe()
  await backend.listArtifacts()
  backend.invalidateArtifactListCache()
  await backend.listArtifacts()

  assert.equal(scans(), 2)
})
