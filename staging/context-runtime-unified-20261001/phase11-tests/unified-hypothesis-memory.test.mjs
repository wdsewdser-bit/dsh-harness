import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { spawn } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { createHypothesisMemory } from '../home/profiles/web/plugins/team-v15-hypothesis-memory.mjs'

const identity = Object.freeze({ sessionId: 'session-root-1', rootTeamId: 'team-root-1', taskId: 'task-41', contractRevision: 7 })

test('transport success without verified progress does not reset the no-progress budget', async t => {
  const f = fixture(t, 'hypothesis-success-', { maxNoProgressAttempts: 2 })
  for (let index = 0; index < 2; index++) {
    const row = await f.memory.recordAttempt(makeAttempt({ attemptId: 'successful-' + index,
      serverObservation: { status: 'passed' } }))
    assert.equal(row.newInformation.progress, false)
    assert.equal(row.noProgressStreak, index + 1)
  }
  assert.equal(f.memory.checkAttempt({ identity, hypothesisId: 'hypothesis-parser-boundary',
    failureCause: 'schema validation failure' }).reason, 'no-progress-limit')
})

function makeAttempt({
  identity: scope = identity,
  hypothesisId = 'hypothesis-parser-boundary',
  failureCause = 'schema validation failure',
  attemptId = 'attempt-default',
  hypothesis = 'The parser boundary may reject a supported field.',
  probe = { kind: 'standard', method: 'baseline-check' },
  serverObservation = {},
  ...extra
} = {}) {
  return {
    identity: scope,
    hypothesisId,
    failureCause,
    attemptId,
    hypothesis,
    probe,
    serverObservation: { identity: scope, status: 'failed', errorCode: 'E_SCHEMA', ...serverObservation },
    ...extra,
  }
}

function fixture(t, prefix = 'hypothesis-memory-', options = {}) {
  const directory = mkdtempSync(join(tmpdir(), prefix))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  const file = join(directory, 'hypotheses.json')
  const evidence = new Map()
  let evidenceReads = 0
  const memory = createHypothesisMemory({
    file,
    readEvidence: async ref => { evidenceReads += 1; return evidence.get(ref) },
    ...options,
  })
  return { directory, file, evidence, memory, evidenceReads: () => evidenceReads }
}

function evidenceRow(ref, sourceIdentity = identity, content = ref) {
  return { ref, hash: createHash('sha256').update(content).digest('hex'), status: 'passed', sourceIdentity }
}

function runChild(script, cwd) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', script], { cwd, windowsHide: true })
    let stdout = ''
    let stderr = ''
    child.stdout.setEncoding('utf8').on('data', chunk => { stdout += chunk })
    child.stderr.setEncoding('utf8').on('data', chunk => { stderr += chunk })
    child.once('error', reject)
    child.once('close', code => {
      if (code !== 0) reject(new Error('hypothesis worker failed: ' + stderr))
      else {
        try { resolve(JSON.parse(stdout.trim())) } catch (error) { reject(new Error('invalid worker output: ' + String(error) + '; ' + stdout)) }
      }
    })
  })
}

test('identity is task-level, wrapper changes do not reset same-cause failures, and one bounded smaller probe is allowed', async t => {
  let time = 1000
  const f = fixture(t, 'hypothesis-memory-identity-', {
    now: () => time,
    maxAttempts: 8,
    maxNoProgressAttempts: 3,
  })
  const rows = []
  for (let index = 0; index < 4; index += 1) {
    rows.push(await f.memory.recordAttempt(makeAttempt({
      attemptId: 'same-cause-' + index,
      probe: { kind: 'standard', method: 'wrapper-' + String.fromCharCode(65 + index) },
    })))
  }
  assert.equal(new Set(rows.map(row => row.key)).size, 1)
  assert.deepEqual(rows.map(row => row.decision), ['continue', 'continue', 'continue', 'replan/upgrade-required'])
  assert.equal(f.memory.snapshot(identity).entries[0].noProgressStreak, 3)
  assert.equal(f.memory.snapshot(identity).entries[0].attempts[0].hypothesis.epistemicStatus, 'working-hypothesis')

  const smallerProbe = { kind: 'smallerProbe', method: 'single-field-repro', maxSteps: 2, maxDurationMs: 5000 }
  assert.equal(f.memory.checkAttempt(makeAttempt({ probe: smallerProbe })).reason, 'bounded-smaller-probe-available')
  const smaller = await f.memory.recordAttempt(makeAttempt({ attemptId: 'bounded-smaller', probe: smallerProbe }))
  assert.equal(smaller.newInformation.boundedSmallerProbe, true)
  assert.equal(smaller.decision, 'replan/upgrade-required')
  assert.equal(f.memory.checkAttempt(makeAttempt({ probe: { ...smallerProbe, method: 'different-wrapper' } })).decision, 'replan/upgrade-required')
  assert.equal(f.memory.snapshot(identity).entries[0].smallerProbeUsed, true)
  assert.equal(f.memory.snapshot(identity).entries[0].attempts.length, 5)
  time += 1
})

test('only server-read new evidence with exact ref, hash, passed status and matching source identity counts', async t => {
  const f = fixture(t, 'hypothesis-memory-evidence-', { maxAttempts: 12, maxNoProgressAttempts: 5 })
  const source = evidenceRow('evidence:first')
  const alias = evidenceRow('evidence:alias', identity, 'evidence:first')
  const second = evidenceRow('evidence:second', identity, 'different verified source bytes')
  f.evidence.set(source.ref, source)
  f.evidence.set(alias.ref, alias)
  f.evidence.set(second.ref, second)

  const first = await f.memory.recordAttempt(makeAttempt({ attemptId: 'evidence-1', newEvidenceRef: source.ref }))
  assert.equal(first.newInformation.evidence, true)
  assert.equal(first.evidence.status, 'passed')
  assert.deepEqual(first.evidence.sourceIdentity, identity)

  const duplicate = await f.memory.recordAttempt(makeAttempt({ attemptId: 'evidence-1', newEvidenceRef: source.ref }))
  assert.equal(duplicate.idempotent, true)
  assert.equal(f.evidenceReads(), 1, 'duplicate attempt IDs return the recorded attempt without rereading evidence')

  const repeat = await f.memory.recordAttempt(makeAttempt({ attemptId: 'evidence-repeat', newEvidenceRef: source.ref }))
  assert.equal(repeat.newInformation.evidence, false)
  assert.equal(repeat.evidence.status, 'verified-repeat')
  const aliasRepeat = await f.memory.recordAttempt(makeAttempt({ attemptId: 'evidence-alias', newEvidenceRef: alias.ref }))
  assert.equal(aliasRepeat.newInformation.evidence, false)
  assert.equal(aliasRepeat.evidence.status, 'verified-unchanged')
  const nextEvidence = await f.memory.recordAttempt(makeAttempt({ attemptId: 'evidence-2', newEvidenceRef: second.ref }))
  assert.equal(nextEvidence.newInformation.evidence, true)

  const callerOnly = await f.memory.recordAttempt(makeAttempt({ attemptId: 'caller-only', newEvidenceRef: 'caller-controlled-ref',
    evidence: { ref: 'caller-controlled-ref', hash: 'a'.repeat(64), status: 'passed', sourceIdentity: identity } }))
  assert.equal(callerOnly.newInformation.evidence, false)
  assert.equal(callerOnly.evidence.status, 'unavailable')
  const emptyRef = await f.memory.recordAttempt(makeAttempt({ attemptId: 'empty-ref', newEvidenceRef: '   ',
    passed: true, hash: 'b'.repeat(64), sourceIdentity: identity }))
  assert.equal(emptyRef.newInformation.evidence, false)
  assert.equal(emptyRef.evidence.status, 'none')
  assert.equal(f.evidenceReads(), 5)
})

test('a new server error code or explicit observed progress resets the no-progress streak', async t => {
  const f = fixture(t, 'hypothesis-memory-progress-')
  const first = await f.memory.recordAttempt(makeAttempt({ attemptId: 'progress-1', serverObservation: { errorCode: 'E_SCHEMA' } }))
  const repeat = await f.memory.recordAttempt(makeAttempt({ attemptId: 'progress-2', serverObservation: { errorCode: 'E_SCHEMA' } }))
  const newError = await f.memory.recordAttempt(makeAttempt({ attemptId: 'progress-3', serverObservation: { errorCode: 'E_VALIDATION' } }))
  const progress = await f.memory.recordAttempt(makeAttempt({ attemptId: 'progress-4', serverObservation: { errorCode: 'E_VALIDATION', progress: true } }))
  assert.equal(first.newInformation.error, true)
  assert.equal(repeat.newInformation.error, false)
  assert.equal(repeat.noProgressStreak, 1)
  assert.equal(newError.newInformation.error, true)
  assert.equal(newError.decision, 'continue')
  assert.equal(newError.noProgressStreak, 0)
  assert.equal(progress.newInformation.progress, true)
  assert.equal(progress.decision, 'continue')
  assert.equal(f.memory.snapshot(identity).entries[0].noProgressStreak, 0)
})

test('foreign server observations and foreign or malformed evidence never authorize another task', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'hypothesis-foreign-'))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  const modulePath = new URL('../home/profiles/web/plugins/team-v15-hypothesis-memory.mjs', import.meta.url).href
  let index = 0
  for (const field of ['sessionId', 'rootTeamId', 'taskId', 'contractRevision']) {
    const file = join(directory, field + '.json')
    const memory = createHypothesisMemory({ file, readEvidence: async () => undefined })
    const foreign = { ...identity, [field]: field === 'contractRevision' ? identity.contractRevision + 1 : 'foreign-' + field }
    await assert.rejects(memory.recordAttempt(makeAttempt({ attemptId: 'foreign-observation-' + index++,
      serverObservation: { identity: foreign, status: 'failed', errorCode: 'E_SCHEMA' } })), { code: 'HYPOTHESIS_MEMORY_OBSERVATION_SCOPE_MISMATCH' })
    assert.equal(memory.snapshot(identity).entries.length, 0)
  }

  const variants = [
    { name: 'foreign-session', row: evidenceRow('ev', { ...identity, sessionId: 'other-session' }) },
    { name: 'foreign-task', row: evidenceRow('ev', { ...identity, taskId: 'other-task' }) },
    { name: 'foreign-contract', row: evidenceRow('ev', { ...identity, contractRevision: identity.contractRevision + 1 }) },
    { name: 'stale-status', row: { ...evidenceRow('ev'), status: 'stale' } },
    { name: 'bad-hash', row: { ...evidenceRow('ev'), hash: 'not-a-hash' } },
    { name: 'wrong-ref', row: { ...evidenceRow('another-ref') } },
  ]
  for (const variant of variants) {
    const file = join(directory, variant.name + '.json')
    const memory = createHypothesisMemory({ file, readEvidence: async () => variant.row })
    const result = await memory.recordAttempt(makeAttempt({ attemptId: variant.name, newEvidenceRef: 'ev' }))
    assert.equal(result.newInformation.evidence, false, variant.name)
    assert.match(result.evidence.status, /^(rejected:|unavailable$)/, variant.name)
    assert.equal(memory.snapshot(identity).entries[0].evidenceRefs.length, 0, variant.name)
  }
  assert.match(modulePath, /team-v15-hypothesis-memory\.mjs$/)
})

test('bad and old durable files are rejected without replacing their bytes', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'hypothesis-invalid-store-'))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  for (const [name, contents, code] of [
    ['corrupt.json', '{broken', 'HYPOTHESIS_MEMORY_UNAVAILABLE'],
    ['old-version.json', JSON.stringify({ version: 0, entries: {}, audit: [] }), 'HYPOTHESIS_MEMORY_UNSUPPORTED_VERSION'],
  ]) {
    const file = join(directory, name)
    writeFileSync(file, contents)
    const before = readFileSync(file, 'utf8')
    const memory = createHypothesisMemory({ file, readEvidence: async () => undefined })
    assert.throws(() => memory.snapshot(), { code })
    await assert.rejects(memory.recordAttempt(makeAttempt({ attemptId: 'must-not-clear-' + name })), { code })
    assert.equal(readFileSync(file, 'utf8'), before)
  }
})

test('attempt, key, audit and time budgets are explicit and bounded', async t => {
  let time = 1000
  const f = fixture(t, 'hypothesis-memory-bounds-', { now: () => time, maxKeys: 1, maxAttempts: 5,
    maxNoProgressAttempts: 3, maxDurationMs: 100, auditLimit: 2 })
  for (let index = 0; index < 4; index += 1) {
    await f.memory.recordAttempt(makeAttempt({ attemptId: 'bounded-' + index }))
  }
  assert.equal(f.memory.snapshot().audit.length, 2)
  const otherTask = { ...identity, taskId: 'task-42' }
  const otherAttempt = makeAttempt({ identity: otherTask, attemptId: 'key-overflow' })
  assert.equal(f.memory.checkAttempt(otherAttempt).reason, 'key-budget')
  await assert.rejects(f.memory.recordAttempt(otherAttempt), { code: 'HYPOTHESIS_MEMORY_KEY_LIMIT' })
  assert.equal(f.memory.snapshot().entries.length, 1)
  time += 101
  assert.equal(f.memory.checkAttempt(makeAttempt()).reason, 'time-budget')

  const attemptLimitedFile = join(f.directory, 'attempt-limited.json')
  const attemptLimited = createHypothesisMemory({ file: attemptLimitedFile, now: () => time, readEvidence: async () => undefined,
    maxKeys: 2, maxAttempts: 3, maxNoProgressAttempts: 3 })
  for (let index = 0; index < 3; index += 1) {
    await attemptLimited.recordAttempt(makeAttempt({ attemptId: 'attempt-cap-' + index }))
  }
  assert.equal(attemptLimited.checkAttempt(makeAttempt()).reason, 'attempt-budget')
  await assert.rejects(attemptLimited.recordAttempt(makeAttempt({ attemptId: 'attempt-cap-overflow' })), { code: 'HYPOTHESIS_MEMORY_ATTEMPT_BUDGET' })
})

test('parallel processes preserve durable attempts and duplicate attemptId is idempotent', async t => {
  const f = fixture(t, 'hypothesis-memory-processes-')
  const moduleUrl = new URL('../home/profiles/web/plugins/team-v15-hypothesis-memory.mjs', import.meta.url).href
  const root = fileURLToPath(new URL('..', import.meta.url))
  const identityLiteral = JSON.stringify(identity)
  const fileLiteral = JSON.stringify(f.file)
  const specs = [
    { id: 'same-attempt', method: 'wrapper-a' },
    { id: 'same-attempt', method: 'wrapper-a' },
    { id: 'parallel-a', method: 'wrapper-b' },
    { id: 'parallel-b', method: 'wrapper-c' },
  ]
  const results = await Promise.all(specs.map(({ id, method }) => {
    const script = `
      import { createHypothesisMemory } from ${JSON.stringify(moduleUrl)}
      const memory = createHypothesisMemory({ file: ${fileLiteral}, now: () => 1000, readEvidence: async () => undefined })
      const identity = ${identityLiteral}
      const row = await memory.recordAttempt({ identity, hypothesisId: 'h-process', failureCause: 'same durable failure', attemptId: ${JSON.stringify(id)},
        hypothesis: 'A bounded server-side hypothesis.', probe: { kind: 'standard', method: ${JSON.stringify(method)} },
        serverObservation: { identity, status: 'failed', errorCode: 'E_PROCESS' } })
      console.log(JSON.stringify({ attemptId: row.attemptId, idempotent: row.idempotent === true }))
    `
    return runChild(script, root)
  }))
  const snapshot = (await import(moduleUrl)).createHypothesisMemory({ file: f.file, readEvidence: async () => undefined }).snapshot()
  assert.equal(snapshot.entries.length, 1)
  assert.equal(snapshot.entries[0].attempts.length, 3)
  assert.equal(new Set(snapshot.entries[0].attempts.map(row => row.attemptId)).size, 3)
  assert.equal(results.filter(result => result.attemptId === 'same-attempt' && result.idempotent).length, 1)
})
