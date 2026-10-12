import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { contextDigest } from '../home/profiles/web/plugins/team-v14-requirements.mjs'
import { captureMemberMemory, buildMemberRecoveryPack } from '../home/profiles/web/plugins/team-v14-memory-anchor.mjs'

function fixture(criteria = ['pass']) {
  return {
    revision: 12,
    boards: { board: { tasks: { keyedTask: {
      id: 'task', ownerName: 'member', status: 'in_progress', revision: 3,
      subject: 'build', contract: { acceptanceCriteria: criteria }, blockedBy: [],
    } } } }, rooms: {},
  }
}

const sha256 = (value) => createHash('sha256').update(value, 'utf8').digest('hex')
const resolve = (control, path) => [...path.matchAll(/\[("(?:[^"\\]|\\.)*")\]/g)]
  .reduce((value, match) => value[JSON.parse(match[1])], control)

test('middle and tail constraints survive as explicit fetch debt, exact locator/hash and declared units', () => {
  const original = 'x'.repeat(180) + 'MIDDLE: never deploy production;' + 'y'.repeat(180) + 'TAIL: require human signoff';
  const control = fixture([original])
  const before = JSON.stringify(control)
  const memory = captureMemberMemory(control, 'member')
  assert.equal(JSON.stringify(control), before)
  assert.equal(memory.ok, false)
  assert.equal(memory.sourceStatus, 'truncated')
  assert.equal(memory.omitted.fieldTruncations, 1)
  assert.equal(memory.omitted.tasks, undefined)
  assert.equal(memory.facts.tasks[0].acceptance[0].length, 160)
  const field = memory.fieldMetadata.find((row) => row.truncated)
  assert.equal(field.sourceId, 'task')
  assert.equal(field.revision, 3)
  assert.equal(field.fieldPath, 'control["boards"]["board"]["tasks"]["keyedTask"]["contract"]["acceptanceCriteria"]["0"]')
  assert.equal(resolve(control, field.locator.controlPath), original)
  assert.equal(field.sha256, sha256(original))
  assert.equal(field.hashEncoding, 'utf8')
  assert.equal(field.lengthUnit, 'utf16-code-units')
  assert.equal(field.originalLength, original.length)
  assert.equal(field.projectedLength, 160)
  assert.equal(field.requiredFetch, true)
  assert.ok(field.locator.requiredRead.includes('authoritative'))
  assert.equal(JSON.stringify(memory).includes('MIDDLE:'), false)
  const pack = buildMemberRecoveryPack(memory)
  assert.equal(pack.truncated, true)
  assert.equal(pack.ok, false)
  assert.ok(pack.text.includes('[Memory debt]'))
})

test('object acceptance uses structured text and carries original JSON hash instead of object coercion', () => {
  const object = { check: 'lint', constraint: 'do not restart', expected: true }
  const memory = captureMemberMemory(fixture([object]), 'member')
  assert.equal(memory.facts.tasks[0].acceptance[0], JSON.stringify(object))
  assert.equal(memory.sourceStatus, 'loaded')
  assert.ok(!JSON.stringify(memory).includes('[object Object]'))
  const field = memory.fieldMetadata.find((row) => row.fieldPath.includes('acceptanceCriteria'))
  assert.equal(field.sha256, sha256(JSON.stringify(object)))
  assert.equal(field.requiredFetch, false)
  assert.ok(buildMemberRecoveryPack(memory).text.includes('do not restart'))
})

test('requirements, decisions, modern and legacy room fields retain their actual control paths', () => {
  const long = 'z'.repeat(241) + 'critical'
  const control = fixture()
  control.v12Requirements = {
    requirements: { reqKey: { requirementId: 'req', status: 'active', revision: 4, quote: long, acceptance: [long] } },
    decisions: { decKey: { decisionId: 'dec', status: 'confirmed', revision: 5, choice: long } },
  }
  control.rooms.legacy = { members: ['member'], latestSummary: { text: long }, revision: 7,
    decisions: [{ id: 'legacy-dec', status: 'confirmed', title: long }], unresolved: [{ id: 'risk', summary: long }] }
  control.v12RoomWake = { roomAccess: { modern: { members: ['member'] } },
    roundSummaries: { modern: [{ summaryId: 'summary', summaryRevision: 8, summary: long }] },
    decisions: { modern: { roomDecKey: { decisionId: 'room-dec', revision: 9, status: 'confirmed', choice: long } } },
    unresolved: { modern: { riskKey: { itemId: 'modern-risk', revision: 10, status: 'open', text: long } } },
  }
  const memory = captureMemberMemory(control, 'member')
  const fields = memory.fieldMetadata.filter((row) => row.truncated)
  assert.equal(fields.length, 9)
  assert.equal(memory.omitted.fieldTruncations, 9)
  for (const field of fields) {
    assert.equal(resolve(control, field.locator.controlPath), long)
    assert.equal(field.sha256, sha256(long))
    assert.equal(field.requiredFetch, true)
  }
})

test('recovery 200-char projection registers a second-stage debt even for a complete capture', () => {
  const control = fixture()
  control.boards.board.tasks.keyedTask.subject = 'a'.repeat(210) + 'tail constraint'
  const memory = captureMemberMemory(control, 'member')
  assert.equal(memory.ok, true)
  const pack = buildMemberRecoveryPack(memory)
  assert.equal(pack.truncated, true)
  assert.equal(pack.ok, false)
  assert.equal(pack.memoryDebt.recoveryFieldCount, 1)
  const field = pack.memoryDebt.recoveryFields[0]
  assert.equal(field.stage, 'recovery-field')
  assert.equal(field.projectedLength, 200)
  assert.equal(resolve(control, field.locator.controlPath), control.boards.board.tasks.keyedTask.subject)
  assert.equal(field.sha256, sha256(control.boards.board.tasks.keyedTask.subject))
})

test('maxChars clips even oversized initial anchor but always reserves the entire debt marker', () => {
  const memory = captureMemberMemory(fixture(), 'member', { milestoneNext: 'x'.repeat(7000) })
  for (const maxChars of [512, 6000]) {
    const pack = buildMemberRecoveryPack(memory, { maxChars })
    assert.equal(pack.text.length, maxChars)
    assert.equal(pack.truncated, true)
    assert.equal(pack.ok, false)
    assert.ok(pack.text.endsWith('See memoryDebt and fieldMetadata.'))
    assert.ok(pack.text.includes('[Memory debt] requiredFetch=true'))
    assert.equal(pack.memoryDebt.output.truncated, true)
    assert.equal(pack.memoryDebt.output.requiredFetch, true)
    assert.equal(pack.memoryDebt.output.lengthUnit, 'utf16-code-units')
    assert.equal(pack.memoryDebt.output.locator.controlPath, 'control')
  }
  const hugeHeader = { ...memory, memberId: 'm'.repeat(7000) }
  const pack = buildMemberRecoveryPack(hugeHeader, { maxChars: 512 })
  assert.equal(pack.text.length, 512)
  assert.ok(pack.text.endsWith('See memoryDebt and fieldMetadata.'))
})

test('metadata and acceptance lists are bounded with explicit overflow/read debt', () => {
  const control = fixture(Array.from({ length: 50 }, () => 'a'.repeat(180)))
  for (let n = 0; n < 31; n += 1) control.boards.board.tasks[`task-${n}`] = {
    ...control.boards.board.tasks.keyedTask, id: `task-${n}`,
  }
  const memory = captureMemberMemory(control, 'member')
  assert.equal(memory.fieldMetadata.length, 128)
  assert.ok(memory.fieldMetadataOmitted > 0)
  assert.equal(memory.facts.tasks.every((row) => row.acceptance.length === 32), true)
  assert.equal(memory.omitted.acceptanceItems, 32 * 18)
  assert.equal(memory.memoryDebt.requiredFetch, true)
  assert.equal(memory.memoryDebt.locator.controlPath, 'control')
  assert.equal(memory.memoryDebt.locator.sha256, sha256(JSON.stringify(control)))
  assert.equal(memory.memoryDebt.locator.hashScope, 'authoritative-control-json')
  assert.equal(memory.sourceStatus, 'truncated')
  assert.ok(!JSON.stringify(memory).includes('a'.repeat(180)))
})

test('overflow recovery hashes explicitly identify captured projections rather than authoritative originals', () => {
  const control = fixture(Array.from({ length: 32 }, () => 'pass'))
  for (let n = 0; n < 10; n += 1) control.boards.board.tasks[`task-${n}`] = {
    ...control.boards.board.tasks.keyedTask, id: `task-${n}`, subject: 's'.repeat(260),
  }
  const memory = captureMemberMemory(control, 'member')
  const pack = buildMemberRecoveryPack(memory)
  const fallback = pack.memoryDebt.recoveryFields.find((field) => field.hashScope === 'captured-projection')
  assert.ok(fallback)
  assert.equal(fallback.sourceOriginalLengthKnown, false)
  assert.equal(fallback.locator.controlPath, 'control')
  assert.equal(pack.memoryDebt.locator.sha256, sha256(JSON.stringify(control)))
  assert.equal(pack.truncated, true)
})

test('row omission is distinguished from field clipping and source snapshot remains unchanged', () => {
  const control = fixture()
  for (let n = 0; n < 32; n += 1) control.boards.board.tasks[`task-${n}`] = {
    ...control.boards.board.tasks.keyedTask, id: `task-${n}`,
  }
  const before = JSON.stringify(control)
  const memory = captureMemberMemory(control, 'member')
  assert.equal(memory.omitted.tasks, 1)
  assert.equal(memory.omitted.fieldTruncations, undefined)
  assert.equal(memory.memoryDebt.truncatedFields, 0)
  assert.equal(memory.sourceStatus, 'truncated')
  assert.equal(JSON.stringify(control), before)
})

test('complete short fields retain facts shape and digest semantics without false debt', () => {
  const memory = captureMemberMemory(fixture(), 'member')
  assert.deepEqual(memory.facts.tasks, [{ id: 'task', revision: 3, subject: 'build', acceptance: ['pass'], blockedBy: [] }])
  assert.equal(memory.digest, contextDigest({ member: 'member', anchors: memory.anchors, facts: memory.facts }))
  assert.equal(memory.ok, true)
  assert.equal(memory.memoryDebt.requiredFetch, false)
  const pack = buildMemberRecoveryPack(memory)
  assert.equal(pack.ok, true)
  assert.equal(pack.truncated, false)
  assert.ok(pack.text.includes('acceptance[0]: pass'))
  assert.ok(!pack.text.includes('[Memory debt]'))
  assert.equal(pack.memoryDebt.requiredFetch, false)
})

test('oversized board/task paths authenticate the real control root and require a complete read', () => {
  for (const subject of ['short', 's'.repeat(300)]) {
    const control = fixture()
    const boardKey = 'b'.repeat(350)
    const taskKey = 't'.repeat(350)
    const task = { ...control.boards.board.tasks.keyedTask, subject }
    control.boards = { [boardKey]: { tasks: { [taskKey]: task } } }
    const original = JSON.stringify(control)
    const memory = captureMemberMemory(control, 'member')
    const field = memory.fieldMetadata[0]
    const exactPath = `control["boards"]["${boardKey}"]["tasks"]["${taskKey}"]["subject"]`
    assert.equal(field.locator.controlPath, 'control')
    assert.equal(field.fieldPath, 'control')
    assert.equal(field.sha256, sha256(original))
    assert.notEqual(field.sha256, sha256(subject))
    assert.equal(field.hashScope, 'authoritative-control-snapshot')
    assert.equal(field.revision, control.revision)
    assert.equal(field.locator.revision, control.revision)
    assert.equal(field.originalLength, original.length)
    assert.equal(field.fieldPathHash, sha256(exactPath))
    assert.equal(field.sourceId, 'task')
    assert.equal(field.requiredFetch, true)
    assert.equal(field.truncated, true)
    assert.equal(memory.ok, false)
    assert.equal(memory.sourceStatus, 'truncated')
    assert.equal(memory.memoryDebt.requiredFetch, true)
    assert.ok(field.locator.requiredRead.includes('only field lookup clues'))
    assert.ok(!JSON.stringify(memory.fieldMetadata).includes(boardKey))
    assert.equal(JSON.stringify(control), original)
  }
})
