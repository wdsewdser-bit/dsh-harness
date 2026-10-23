import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { evaluateTimeline, resetShadowCaches } from '../home/profiles/web/plugins/team-v13-compaction-shadow.mjs'

function timeline(requestCount, compactions = []) {
  return {
    requests: Array.from({ length: requestCount }, (_, index) => ({
      seq: index + 1,
      promptTokens: 100 + index * 10,
      inputTokens: 50 + index * 10,
      outputTokens: 10,
      cacheReadTokens: 20,
      cacheWriteTokens: 10,
    })),
    boundaries: [{ seq: 2 }, { seq: 4 }],
    compactions,
  }
}

function readState(file) {
  return JSON.parse(readFileSync(file, 'utf8'))
}

function repeated(sessionId, value, config, count = 100) {
  let latest
  for (let index = 0; index < count; index += 1) latest = evaluateTimeline(sessionId, value, config, 100)
  return latest
}

test('identical debt timelines skip writes while appended requests and compactions persist once', () => {
  resetShadowCaches()
  const dir = mkdtempSync(join(tmpdir(), 'v13-shadow-debt-idempotence-'))
  const file = join(dir, 'debt.json')
  const config = {
    debtFile: file,
    telemetryDir: dir,
    windowTokens: 1000,
    writeTokens: 10,
    memoTokens: 20,
    cacheWriteReadRatio: 2,
    minContextGrowthTokens: 0,
    minRequestsSinceCompaction: 0,
  }
  const originalNow = Date.now
  let clock = 1_800_000_000_000
  Date.now = () => ++clock
  try {
    const initialTimeline = timeline(4)
    const first = evaluateTimeline('session-debt', initialTimeline, config, 100)
    const firstState = readState(file)
    const firstSession = firstState.sessions['session-debt']
    const firstBytes = readFileSync(file)
    const firstMtime = statSync(file).mtimeMs
    assert.equal(firstState.revision, 1)
    assert.equal(firstSession.requestsSinceCompaction, 4)
    assert.ok(firstSession.updatedAt <= clock)

    const duplicate = repeated('session-debt', initialTimeline, config)
    assert.equal(duplicate.inputs.debt.lastCompactionSeq, -1)
    assert.equal(readState(file).revision, 1, '100 duplicate evaluations must not increment revision')
    assert.equal(readState(file).sessions['session-debt'].updatedAt, firstSession.updatedAt)
    assert.deepEqual(readFileSync(file), firstBytes, 'duplicate evaluations must not replace the durable file')
    assert.equal(statSync(file).mtimeMs, firstMtime)

    const appendedRequest = timeline(5)
    evaluateTimeline('session-debt', appendedRequest, config, 100)
    const requestState = readState(file)
    assert.equal(requestState.revision, 2)
    assert.equal(requestState.sessions['session-debt'].requestsSinceCompaction, 5)
    const requestUpdatedAt = requestState.sessions['session-debt'].updatedAt
    assert.ok(requestUpdatedAt > firstSession.updatedAt)
    repeated('session-debt', appendedRequest, config)
    assert.equal(readState(file).revision, 2)
    assert.equal(readState(file).sessions['session-debt'].updatedAt, requestUpdatedAt)

    const withCompaction = timeline(5, [{ seq: 6 }])
    evaluateTimeline('session-debt', withCompaction, config, 100)
    const compactionState = readState(file)
    assert.equal(compactionState.revision, 3)
    assert.equal(compactionState.sessions['session-debt'].lastCompactionSeq, 6)
    assert.equal(compactionState.sessions['session-debt'].carriedDebtTokens, 10)
    const compactionUpdatedAt = compactionState.sessions['session-debt'].updatedAt
    repeated('session-debt', withCompaction, config)
    assert.equal(readState(file).revision, 3)
    assert.equal(readState(file).sessions['session-debt'].updatedAt, compactionUpdatedAt)

    const afterCompactionRequest = timeline(7, [{ seq: 6 }])
    evaluateTimeline('session-debt', afterCompactionRequest, config, 100)
    const finalState = readState(file)
    assert.equal(finalState.revision, 4)
    assert.equal(finalState.sessions['session-debt'].requestsSinceCompaction, 1)
    assert.equal(finalState.sessions['session-debt'].lastProcessedRequestSeq, 7)
    assert.equal(finalState.sessions['session-debt'].carriedDebtTokens, 0)
    const finalUpdatedAt = finalState.sessions['session-debt'].updatedAt
    repeated('session-debt', afterCompactionRequest, config)
    assert.equal(readState(file).revision, 4)
    assert.equal(readState(file).sessions['session-debt'].updatedAt, finalUpdatedAt)

    console.log('[perf-local-debt] ' + JSON.stringify({
      duplicateEvaluations: 100,
      revisions: { first: 1, afterRequest: 2, afterCompaction: 3, afterCompactionRequest: 4 },
      requestCount: finalState.sessions['session-debt'].requestsSinceCompaction,
      carriedDebtTokens: finalState.sessions['session-debt'].carriedDebtTokens,
      fileSha256: createHash('sha256').update(readFileSync(file)).digest('hex'),
    }))
    assert.equal(first.recorded, true)
  } finally {
    Date.now = originalNow
    resetShadowCaches()
    rmSync(dir, { recursive: true, force: true })
  }
})
