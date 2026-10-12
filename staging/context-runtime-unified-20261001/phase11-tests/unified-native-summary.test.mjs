import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { compactOnIdle, compactionResultStatus, compactionSummaryText } from '../home/profiles/web/plugins/step-compaction-v4.mjs'
import { createMilestoneDoc } from '../home/profiles/web/plugins/team-milestone-v2.mjs'

test('native engine summary ContentBlock[] is actual summary text', () => {
  const native = { compactionId: 'native-1', startSeq: 2, summarySeq: 7, summary: [{ type: 'text', text: 'task-1 acceptance not completed' }, { type: 'text', text: 'next action: verify exact tree' }] }
  assert.equal(compactionSummaryText(native, undefined), 'task-1 acceptance not completed\nnext action: verify exact tree')
  assert.equal(compactionResultStatus(native).status, 'completed-with-summary')
  assert.equal(compactionSummaryText(undefined, { result: native }), compactionSummaryText(native))
})

test('legacy string and command text remain supported without recursion loops', () => {
  assert.equal(compactionSummaryText('folded summary', { text: 'command summary' }), 'folded summary\ncommand summary')
  const cyclic = { text: 'safe' }; cyclic.result = cyclic
  assert.equal(compactionSummaryText(cyclic), 'safe')
})

test('no range, failed, missing summary and unknown blocks have distinct outcomes', () => {
  assert.equal(compactionResultStatus(null).status, 'no-compactable-range')
  assert.equal(compactionResultStatus({ result: null }).status, 'no-compactable-range')
  assert.equal(compactionResultStatus({ result: { kind: 'error', text: 'failed' } }).status, 'failed')
  assert.equal(compactionResultStatus({ compactionId: 'missing' }).status, 'summary-missing')
  const unknown = compactionResultStatus({ summary: [{ type: 'text', text: 'summary' }, { type: 'image' }] })
  assert.equal(unknown.status, 'completed-with-debt')
  assert.equal(unknown.summaryAvailable, true)
  assert.deepEqual(unknown.unknownBlocks, ['image'])
})

async function foldHarness(value, command = false) {
  const directory = mkdtempSync(join(tmpdir(), 'dsh-unified-native-'))
  try {
    const milestonePath = join(directory, 'milestones.json')
    const doc = createMilestoneDoc()
    doc.members.a1 = { owner: 'a1', stage: 'S', doneWhen: 'W', setAt: 1, done: true }
    doc.compactions.a1 = { kind: 'milestone', status: 'pending-idle', reason: 'milestone', milestoneSetAt: 1, requestedAt: 1 }
    writeFileSync(milestonePath, JSON.stringify(doc))
    const notices = []
    const agent = { session: { id: 'isolated-native', seq: 1 }, membership: { name: 'a1' }, inject: notice => notices.push(notice) }
    const engine = { compactNow: async () => value }
    const ctx = {
      agentTeams: { tryMembership: a => a.membership },
      tokenMeter: { measure: () => ({ totalTokens: 500000 }) },
      ...(command ? { commands: { execute: async () => ({ result: value }) } } : { compaction: engine }),
    }
    const result = await compactOnIdle(ctx, { milestonePath, controlDir: directory, windowTokens: 1000000 }, agent, new AbortController().signal)
    return { result, doc: JSON.parse(readFileSync(milestonePath, 'utf8')), notices }
  } finally { rmSync(directory, { recursive: true, force: true }) }
}

test('null engine and /compact results cannot consume or mark a milestone compacted', async () => {
  for (const command of [false, true]) {
    const run = await foldHarness(null, command)
    assert.equal(run.result, 'skipped:no-compactable-range')
    assert.equal(run.doc.members.a1.compactedAt, undefined)
    assert.equal(run.doc.compactions.a1.status, 'no_compactable_range')
    assert.equal(run.doc.compactions.a1.completedAt, null)
    assert.equal(run.notices.length, 0)
  }
})

test('native summary object remains visible to the real idle compaction anchor path', async () => {
  const run = await foldHarness({ summary: [{ type: 'text', text: 'a1 S W next action' }], compactionId: 'native-fixture' })
  assert.match(run.result, /^folded:milestone:committed/)
  assert.equal(run.doc.compactions.a1.summaryAvailable, true)
  assert.ok(run.doc.compactions.a1.missingAnchors.includes('source:unavailable'), 'unavailable authority must remain debt, not a fabricated success')
  assert.equal(run.notices.length, 1)
})

test('failed native result retains pending work and failure classification', async () => {
  const run = await foldHarness({ kind: 'error', text: 'provider failure' })
  assert.equal(run.result, 'skipped:compact-failed')
  assert.equal(run.doc.members.a1.compactedAt, undefined)
  assert.equal(run.doc.compactions.a1.status, 'retryable')
  assert.equal(run.notices.length, 0)
})
