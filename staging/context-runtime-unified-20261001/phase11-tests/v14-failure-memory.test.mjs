import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawn } from 'node:child_process'
import {
  actionFingerprint,
  actionFailureSummary,
  classifyFailure,
  recordFailure,
  shouldBlockAction,
  clearAction,
  clearActionByFingerprint,
  readFailureMemory,
  apply,
} from '../home/profiles/web/plugins/team-v13-failure-memory.mjs'
import { createTelemetry } from '../home/profiles/web/plugins/team-v13-mechanism-telemetry.mjs'
import { evaluateTimeline } from '../home/profiles/web/plugins/team-v13-compaction-shadow.mjs'
import { readReducerSettings, writeReducerSettings } from '../home/profiles/web/plugins/evidence-reducer.mjs'

function fixture(overrides = {}) {
  return { name: 'fs.write', arguments: { path: 'reports/out.json', value: 'x' }, sessionId: 's1', teamId: 't1', workspaceId: 'w1', profile: 'web', commit: 'c1', ...overrides }
}
function error(text, code = 'EINVAL') { return { isError: true, code, content: [{ type: 'text', text }] } }

test('same action in separate sessions never cross-blocks', () => {
  const dir = mkdtempSync(join(tmpdir(), 'v14-failure-'))
  try {
    const file = join(dir, 'memory.json')
    const a = fixture({ sessionId: 'a' })
    const b = fixture({ sessionId: 'b' })
    for (let i = 0; i < 3; i += 1) recordFailure(a, error('invalid argument'), { file, now: i * 1000 })
    assert.equal(shouldBlockAction(a, { file, now: 2000 }), true)
    assert.equal(shouldBlockAction(b, { file, now: 2000 }), false)
    assert.notEqual(actionFingerprint(a), actionFingerprint(b))
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('transient and provider failures are recorded but never hard-block', () => {
  const dir = mkdtempSync(join(tmpdir(), 'v14-failure-'))
  try {
    const file = join(dir, 'memory.json')
    const exec = fixture()
    for (let i = 0; i < 3; i += 1) recordFailure(exec, error('connection timeout', 'ETIMEDOUT'), { file, now: i * 1000 })
    assert.equal(classifyFailure(error('connection timeout', 'ETIMEDOUT')), 'transient')
    for (let i = 3; i < 8; i += 1) recordFailure(exec, error('provider overloaded', '503'), { file, now: i * 1000 })
    assert.equal(classifyFailure(error('provider overloaded', '503')), 'provider')
    assert.equal(shouldBlockAction(exec, { file, now: 4000 }), false)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('corrupt memory fails closed and is never silently reset', () => {
  const dir = mkdtempSync(join(tmpdir(), 'v14-failure-'))
  try {
    const file = join(dir, 'memory.json')
    writeFileSync(file, '{broken', 'utf8')
    assert.throws(() => readFailureMemory(file), /unavailable|corrupt/)
    assert.throws(() => shouldBlockAction(fixture(), { file }), /unavailable|corrupt/)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('audited clear removes deterministic block and permits retry', () => {
  const dir = mkdtempSync(join(tmpdir(), 'v14-failure-'))
  try {
    const file = join(dir, 'memory.json')
    const exec = fixture()
    for (let i = 0; i < 3; i += 1) recordFailure(exec, error('bad schema'), { file, now: i * 1000 })
    assert.equal(shouldBlockAction(exec, { file, now: 3000 }), true)
    assert.equal(clearAction(exec, { file, reason: 'schema fixed', evidence: 'validated new payload', operator: 'test' }), true)
    assert.equal(shouldBlockAction(exec, { file, now: 3001 }), false)
    assert.equal(readFailureMemory(file).audit.at(-1).reason, 'schema fixed')
    assert.equal(JSON.parse(readFileSync(file, 'utf8')).audit.at(-1).evidence, 'validated new payload')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('fingerprint clear is explicit, audited, and exposes count against threshold', () => {
  const dir = mkdtempSync(join(tmpdir(), 'v14-failure-'))
  try {
    const file = join(dir, 'memory.json')
    const exec = fixture()
    for (let i = 0; i < 3; i += 1) recordFailure(exec, error('bad schema'), { file, now: i * 1000 })
    const fingerprint = actionFingerprint(exec)
    const before = actionFailureSummary(fingerprint, { file, now: 3000 })
    assert.equal(before.blocked, true)
    assert.equal(before.count, 3)
    assert.equal(before.threshold, 3)
    assert.equal(clearActionByFingerprint(fingerprint, {
      file,
      reason: 'schema fixed',
      evidence: 'validated new payload',
      operator: 'test',
      identity: { sessionId: 's1' },
    }), true)
    assert.equal(actionFailureSummary(fingerprint, { file, now: 3001 }).blocked, false)
    assert.equal(readFailureMemory(file).audit.at(-1).action, fingerprint)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('denial includes count, threshold, fingerprint and executable clear path', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'v14-hook-'))
  try {
    const file = join(dir, 'memory.json')
    const hooks = new Map()
    apply({ on: (name, callback) => hooks.set(name, callback) }, { memoryFile: file, telemetryDir: dir })
    const exec = fixture()
    const now = Date.now()
    for (let i = 0; i < 3; i += 1) recordFailure(exec, error('bad schema'), { file, now: now + i })
    const fingerprint = actionFingerprint(exec)
    await assert.rejects(
      hooks.get('tools/pre-execute')(exec, async () => ({ kind: 'allow' })),
      new RegExp('count=3/3; actionFingerprint=' + fingerprint + '; clear with team_v12\\(action:"failure_memory_clear"'),
    )
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('different deterministic errors with one exit code do not combine into a block', () => {
  const dir = mkdtempSync(join(tmpdir(), 'v14-failure-'))
  try {
    const file = join(dir, 'memory.json')
    const exec = fixture()
    recordFailure(exec, error('schema field a missing', 1), { file, now: 1 })
    recordFailure(exec, error('schema field b missing', 1), { file, now: 2 })
    recordFailure(exec, error('schema field c missing', 1), { file, now: 3 })
    assert.equal(shouldBlockAction(exec, { file, now: 3 }), false)
    recordFailure(exec, error('schema field a missing', 1), { file, now: 4 })
    recordFailure(exec, error('schema field a missing', 1), { file, now: 5 })
    assert.equal(shouldBlockAction(exec, { file, now: 5 }), true)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('post-execute uses canonical result and preserves a failure if next throws', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'v14-hook-'))
  try {
    const file = join(dir, 'memory.json')
    const hooks = new Map()
    apply({ on: (name, callback) => hooks.set(name, callback) }, { memoryFile: file, telemetryDir: dir })
    const exec = fixture()
    await assert.rejects(
      hooks.get('tools/post-execute')(exec, error('invalid schema'), async () => { throw new Error('downstream failed') }),
      /downstream failed/,
    )
    assert.equal(readFailureMemory(file).actions[actionFingerprint(exec)].failures.length, 1)
    const accepted = await hooks.get('tools/post-execute')(exec, error('invalid schema'), async () => ({ kind: 'accept' }))
    assert.deepEqual(accepted, { kind: 'accept' })
    assert.equal(readFailureMemory(file).actions[actionFingerprint(exec)].failures.length, 2)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('settings corruption is visible and cannot be overwritten by a patch', () => {
  const dir = mkdtempSync(join(tmpdir(), 'v14-settings-'))
  try {
    const file = join(dir, 'settings.json')
    writeFileSync(file, '{broken', 'utf8')
    assert.throws(() => readReducerSettings(file), /corrupt/)
    assert.throws(() => writeReducerSettings({ enabled: true }, file), /corrupt/)
    assert.equal(readFileSync(file, 'utf8'), '{broken')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('telemetry, debt and settings merge across concurrent processes', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'v14-concurrent-'))
  const moduleRoot = new URL('../home/profiles/web/plugins/', import.meta.url).href
  const worker = `
    import { createTelemetry } from '${moduleRoot}team-v13-mechanism-telemetry.mjs';
    import { evaluateTimeline } from '${moduleRoot}team-v13-compaction-shadow.mjs';
    import { writeReducerSettings } from '${moduleRoot}evidence-reducer.mjs';
    const [dir, id] = process.argv.slice(1);
    const t = createTelemetry('parallel', { dir });
    for (let i = 0; i < 20; i++) t.event('fired', { sessionId: 'shared-session' }, { toolCalls: 1 });
    const timeline = { requests: [{ seq: 1, promptTokens: 100, inputTokens: 100 }], boundaries: [{ seq: 2 }], compactions: [] };
    evaluateTimeline(id, timeline, { debtFile: dir + '/debt.json', telemetryDir: dir }, 1000);
    for (let i = 0; i < 20; i++) writeReducerSettings({ [id + '-' + i]: true }, dir + '/settings.json');
  `
  const run = (id) => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', worker, dir, id], { stdio: ['ignore', 'ignore', 'pipe'] })
    let stderr = ''
    child.stderr.on('data', (data) => { stderr += data.toString() })
    child.on('error', reject)
    child.on('exit', (code) => code === 0 ? resolve() : reject(new Error(stderr)))
  })
  try {
    await Promise.all([run('s1'), run('s2')])
    const telemetry = JSON.parse(readFileSync(join(dir, 'mechanism-telemetry-parallel.json'), 'utf8'))
    assert.equal(telemetry.events, 40)
    assert.equal(telemetry.metrics.toolCalls, 40)
    assert.equal(telemetry.sessions['shared-session'].events, 40)
    const debt = JSON.parse(readFileSync(join(dir, 'debt.json'), 'utf8'))
    assert.ok(debt.sessions.s1 && debt.sessions.s2)
    const settings = readReducerSettings(join(dir, 'settings.json'))
    assert.equal(Object.keys(settings).filter((key) => /^s[12]-/.test(key)).length, 40)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('deterministic failures expire outside the bounded window', () => {
  const dir = mkdtempSync(join(tmpdir(), 'v14-failure-'))
  try {
    const file = join(dir, 'memory.json')
    const exec = fixture()
    for (let i = 0; i < 3; i += 1) recordFailure(exec, error('bad schema'), { file, now: i * 1000, windowMs: 5000, ttlMs: 5000 })
    assert.equal(shouldBlockAction(exec, { file, now: 9000, windowMs: 5000, ttlMs: 5000 }), false)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})
