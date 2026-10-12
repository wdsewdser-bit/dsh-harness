import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, writeFileSync, existsSync, rmSync, readdirSync, unlinkSync, utimesSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'
import { execFileSync } from 'node:child_process'
import { readDurableJson, updateDurableJsonSync } from '../home/profiles/web/plugins/team-v14-durable-store.mjs'
import { resolveIdentity } from '../home/profiles/web/plugins/team-v14-identity.mjs'
import { actionFingerprint } from '../home/profiles/web/plugins/team-v13-failure-memory.mjs'
import { controlPlaneFor, controlPlaneForMember, teamRootIdCandidates, resetControlPlaneCache, persistControlPlaneSnapshot, readControlPlaneSnapshot } from '../home/profiles/web/plugins/team-control-plane.mjs'

const waitForStorageCacheRefresh = () => new Promise(resolve => setTimeout(resolve, 550))

test('durable JSON missing fallback, revision and corrupt fail closed', () => {
  const dir = mkdtempSync(join(tmpdir(), 'v14-store-'))
  try {
    const file = join(dir, 'state.json')
    assert.deepEqual(readDurableJson(file, { fallback: { n: 0 } }), { n: 0 })
    assert.equal(updateDurableJsonSync(file, doc => { doc.n += 1 }, { fallback: { n: 0 } }).n, 1)
    assert.equal(readDurableJson(file).revision, 1)
    writeFileSync(file, '{bad', 'utf8')
    assert.throws(() => readDurableJson(file), /corrupt/)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('live stale-age lock is never stolen and changed owner is never released', () => {
  const dir = mkdtempSync(join(tmpdir(), 'v14-lock-'))
  try {
    const file = join(dir, 'state.json')
    const lock = file + '.lock'
    writeFileSync(file, JSON.stringify({ revision: 0, n: 0 }))
    writeFileSync(lock, JSON.stringify({ pid: process.pid, token: 'other', acquiredAt: 1 }))
    const old = new Date(Date.now() - 120_000)
    utimesSync(lock, old, old)
    assert.throws(() => updateDurableJsonSync(file, doc => { doc.n += 1 }, { lockTimeoutMs: 100 }), /lock timeout/)
    assert.equal(JSON.parse(readFileSync(lock, 'utf8')).token, 'other')
    unlinkSync(lock)
    assert.throws(() => updateDurableJsonSync(file, doc => {
      writeFileSync(lock, JSON.stringify({ pid: process.pid, token: 'new-owner' }))
      doc.n += 1
    }), /ownership changed/)
    assert.equal(JSON.parse(readFileSync(lock, 'utf8')).token, 'new-owner')
    assert.equal(readDurableJson(file).n, 0)
    writeFileSync(lock, JSON.stringify({ pid: 999999, token: 'dead-owner', acquiredAt: 1 }))
    utimesSync(lock, old, old)
    assert.equal(updateDurableJsonSync(file, doc => { doc.n += 1 }).n, 1)
    assert.equal(existsSync(lock), false)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('separate processes preserve 100 locked updates without corruption', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'v14-concurrency-'))
  try {
    const file = join(dir, 'state.json')
    writeFileSync(file, JSON.stringify({ count: 0, revision: 0 }), 'utf8')
    const modulePath = new URL('../home/profiles/web/plugins/team-v14-durable-store.mjs', import.meta.url).href
    const workers = Array.from({ length: 4 }, () => new Promise((resolve, reject) => {
      const child = spawn(process.execPath, ['--input-type=module', '-e', `import { updateDurableJsonSync } from ${JSON.stringify(modulePath)}; const file = ${JSON.stringify(file)}; for (let i=0;i<25;i++) updateDurableJsonSync(file, d => { d.count += 1 });`], { stdio: ['ignore', 'pipe', 'pipe'] })
      let stderr = ''
      child.stderr.setEncoding('utf8').on('data', chunk => { stderr += chunk })
      child.once('error', reject)
      child.once('exit', code => code === 0 ? resolve() : reject(new Error(stderr || 'worker exit ' + code)))
    }))
    await Promise.all(workers)
    const final = readDurableJson(file)
    assert.equal(final.count, 100)
    assert.equal(final.revision, 100)
    assert.doesNotThrow(() => JSON.parse(readFileSync(file, 'utf8')))
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('identity resolves known fields and uses shared fallback for unknown values', () => {
  const identity = resolveIdentity({ session: { id: 's1' }, name: 'member', teamId: 't1' }, {}, {})
  assert.deepEqual(identity, { sessionId: 's1', teamId: 't1', workspaceId: 'shared', profile: 'shared', agentName: 'member', runId: 'shared' })
})

test('identity uses nested agent membership and isolates unresolved sessions', () => {
  const agent = { name: 'member', session: { id: 'session-a' }, cwd: 'D:/workspace-a' }
  const ctx = { agentTeams: { tryMembership: candidate => {
    assert.equal(candidate, agent)
    return { id: 'team-a', root: { session: { id: 'root-session' } } }
  } } }
  assert.deepEqual(resolveIdentity({ agent }, ctx), {
    sessionId: 'session-a', teamId: 'team-a', workspaceId: 'D:/workspace-a',
    profile: 'shared', agentName: 'member', runId: 'shared',
  })
  const one = {}, two = {}
  assert.equal(resolveIdentity(one).sessionId, resolveIdentity(one).sessionId)
  assert.notEqual(resolveIdentity(one).sessionId, resolveIdentity(two).sessionId)
  const makeExec = sessionId => ({ name: 'bash', arguments: { command: 'build' }, agent: { session: { id: sessionId }, cwd: 'D:/workspace-a' } })
  assert.notEqual(actionFingerprint(makeExec('session-a')), actionFingerprint(makeExec('session-b')))
  assert.equal(actionFingerprint(makeExec('session-a')), actionFingerprint(makeExec('session-a')))
})

test('cold history is content-addressed, fail-closed, and not recopied by hot updates', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'v14-cold-'))
  try {
    const cp = controlPlaneFor('heavy', { directory: dir })
    await cp.roomOpen({ roomId: 'r1', members: ['a'] })
    const body = 'large body '.repeat(100_000)
    await cp.mutate('fixture/history', {}, null, state => {
      state.rooms.r1.messages.push({ messageId: 'm1', content: body })
      state.v12RoomWake.events = [{ id: 'e1', content: body }]
      state.v12RoomWake.transcripts = { r1: [{ messageId: 'tm1', content: body }] }
      state.v12RoomWake.inbox = { i1: { messageId: 'i1', content: body } }
    })
    const file = join(dir, 'heavy.json')
    const coldFiles = () => readdirSync(dir).filter(name => name.includes('.cold-'))
    const count = coldFiles().length
    const coldBytes = coldFiles().reduce((sum, name) => sum + readFileSync(join(dir, name)).length, 0)
    const start = performance.now()
    for (let n = 1; n <= 20; n += 1) await cp.mutate('fixture/hot', { n }, null, state => { state.counters.activeSlots = n })
    const elapsedMs = Math.round(performance.now() - start)
    assert.equal(coldFiles().length, count)
    assert.equal(coldFiles().reduce((sum, name) => sum + readFileSync(join(dir, name)).length, 0), coldBytes)
    assert.equal(cp.snapshot({ history: true }).rooms.r1.messages[0].content, body)
    assert.equal(cp.snapshot({ history: true }).v12RoomWake.transcripts.r1[0].content, body)
    assert.equal(cp.snapshot({ history: true }).v12RoomWake.inbox.i1.content, body)
    assert.equal(cp.snapshot({ history: false }).v12RoomWake.inbox.i1.content, body)
    assert.equal(cp.snapshot({ history: false }).rooms.r1.messages.length, 0)
    await cp.flush()
    const before = readFileSync(file, 'utf8')
    const publication = cp.snapshot({ history: true })
    const expectedRevision = publication.revision
    publication.revision++
    assert.throws(() => persistControlPlaneSnapshot(file, publication, { expectedRevision, beforePublish: () => { throw new Error('injected crash') } }), /injected crash/)
    assert.equal(readFileSync(file, 'utf8'), before)
    assert.equal(readControlPlaneSnapshot(file).rooms.r1.messages[0].content, body)
    const ref = JSON.parse(before).coldHistory.rooms.r1
    const baseRef = typeof ref === 'string' ? ref : ref.base
    const coldPath = join(dir, 'heavy.json.cold-' + baseRef + '.json')
    writeFileSync(coldPath, '{"tampered":true}', 'utf8')
    assert.throws(() => readControlPlaneSnapshot(file), /hash mismatch/)
    assert.throws(() => cp.snapshot({ history: true }), /hash mismatch/)
    unlinkSync(coldPath)
    assert.throws(() => readControlPlaneSnapshot(file), /missing or corrupt/)
    console.log(JSON.stringify({ benchmark: 'v14-cold-hot-20', bodyBytes: Buffer.byteLength(body), elapsedMs, coldFiles: count, coldBytes }))
  } finally { resetControlPlaneCache(); rmSync(dir, { recursive: true, force: true }) }
})

test('60 MB synthetic history benchmark keeps cold blob count fixed over 20 hot mutations', {
  skip: process.env.DSH_V14_HEAVY_BENCH !== '1',
}, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'v14-heavy-'))
  try {
    const cp = controlPlaneFor('scale', { directory: dir })
    const body = 'x'.repeat(60 * 1024 * 1024)
    await cp.mutate('fixture/large-history', {}, null, state => {
      state.v12RoomWake.transcripts = { room: [{ messageId: 'large', content: body }] }
    })
    const file = join(dir, 'scale.json')
    const coldCount = () => readdirSync(dir).filter(name => name.includes('.cold-')).length
    const before = coldCount()
    const started = performance.now()
    for (let n = 0; n < 20; n += 1) await cp.mutateHot('fixture/hot', { n }, null, state => { state.counters.activeSlots = n })
    const elapsedMs = Math.round(performance.now() - started)
    assert.equal(coldCount(), before)
    assert.equal(readControlPlaneSnapshot(file).v12RoomWake.transcripts.room[0].content.length, body.length)
    console.log(JSON.stringify({ benchmark: 'v14-synthetic-60mb', bytes: Buffer.byteLength(body), hotUpdates: 20, elapsedMs, coldFiles: before }))
  } finally { resetControlPlaneCache(); rmSync(dir, { recursive: true, force: true }) }
})

test('control plane avoids duplicate joins and hydrates old schema history', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'v14-control-'))
  try {
    const cp = controlPlaneFor('fixture', { directory: dir })
    await cp.roomOpen({ roomId: 'r1', members: ['a'] }, { name: 'a' })
    await cp.flush()
    const before = cp.snapshot().revision
    await cp.roomJoin('r1', 'a', { name: 'a' })
    assert.equal(cp.snapshot().revision, before)
    const file = join(dir, 'fixture.json')
    const old = JSON.parse(readFileSync(file, 'utf8'))
    old.version = 1; old.schemaVersion = 1; old.rooms.r1.messages = [{ messageId: 'm1', content: 'legacy' }]
    delete old.coldHistory
    writeFileSync(file, JSON.stringify(old), 'utf8')
    for (const name of readdirSync(dir).filter(name => name.startsWith('fixture.json.history-') || name === 'fixture.json.history.json')) unlinkSync(join(dir, name))
    resetControlPlaneCache()
    const reopened = controlPlaneFor('fixture', { directory: dir })
    assert.equal(reopened.snapshot().rooms.r1.messages[0].messageId, 'm1')
  } finally { resetControlPlaneCache(); rmSync(dir, { recursive: true, force: true }) }
})

test('member control lookup isolates Teams and ignores non-unique member names', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'v14-team-roots-'))
  try {
    const agent = { name: 'lead', id: 'agent-lead' }
    const membership = { id: 'team-a', name: 'lead', root: { session: { id: 'root-a' }, id: 'root-agent-a' } }
    const ctx = { agentTeams: { tryMembership: candidate => candidate === agent ? membership : undefined } }
    assert.deepEqual(teamRootIdCandidates(ctx, agent), ['team-a', 'root-a', 'root-agent-a'])
    await controlPlaneFor('lead', { directory: dir }).mutate('fixture/name-collision', {}, agent, state => {
      state.leases.foreign = { member: 'lead', status: 'active' }
    })
    const selected = controlPlaneForMember(ctx, agent, { directory: dir })
    assert.equal(selected.rootId, 'team-a')
    assert.equal(existsSync(join(dir, 'team-a.json')), false)
    assert.equal(existsSync(join(dir, 'root-a.json')), false)
    await controlPlaneFor('team-a', { directory: dir }).mutate('fixture/team-a', {}, agent, state => {
      state.leases.mine = { member: 'lead', status: 'active' }
    })
    await controlPlaneFor('team-b', { directory: dir }).mutate('fixture/team-b', {}, agent, state => {
      state.leases.other = { member: 'lead', status: 'active' }
    })
    assert.equal(controlPlaneForMember(ctx, agent, { directory: dir }).rootId, 'team-a')
    membership.id = 'team-b'
    membership.root = { session: { id: 'root-b' }, id: 'root-agent-b' }
    assert.equal(controlPlaneForMember(ctx, agent, { directory: dir }).rootId, 'team-b')
  } finally { resetControlPlaneCache(); rmSync(dir, { recursive: true, force: true }) }
})

test('member control lookup keeps old root key and fails on corrupt stable candidate', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'v14-legacy-root-'))
  try {
    const agent = { name: 'member', id: 'agent-member' }
    const ctx = { agentTeams: { tryMembership: () => ({ id: 'team-new', root: { session: { id: 'root-legacy' }, id: 'root-agent' } }) } }
    await controlPlaneFor('team-new', { directory: dir }).mutate('fixture/new', {}, agent, state => { state.counters.activeSlots = 1 })
    await controlPlaneFor('root-legacy', { directory: dir }).mutate('fixture/legacy', {}, agent, state => {
      state.leases.old = { member: 'member', status: 'active' }
    })
    assert.equal(controlPlaneForMember(ctx, agent, { directory: dir }).rootId, 'root-legacy')
    assert.equal(existsSync(join(dir, 'root-agent.json')), false)
    writeFileSync(join(dir, 'team-new.json'), '{bad', 'utf8')
    assert.throws(() => controlPlaneForMember(ctx, agent, { directory: dir }), /corrupt/)
  } finally { resetControlPlaneCache(); rmSync(dir, { recursive: true, force: true }) }
})

test('migration dry-run/apply/rollback preserves the original fixture', () => {
  const dir = mkdtempSync(join(tmpdir(), 'v14-migration-'))
  try {
    const file = join(dir, 'state.json')
    const original = { version: 1, revision: 3, rooms: { r: { roomId: 'r', messages: [{ messageId: 'm1', content: 'legacy' }] } },
      v12RoomWake: { transcripts: { r: [{ content: 'transcript' }] }, inbox: { i1: { content: 'inbox' } }, events: [{ content: 'event' }] } }
    writeFileSync(file, JSON.stringify(original), 'utf8')
    const tool = fileURLToPath(new URL('../tools/v14-control-migration.mjs', import.meta.url))
    const dry = execFileSync(process.execPath, [tool, '--file', file, '--mode', 'dry-run'], { encoding: 'utf8' })
    assert.match(dry, /"mode": "dry-run"/)
    execFileSync(process.execPath, [tool, '--file', file, '--mode', 'apply'], { encoding: 'utf8' })
    assert.ok(existsSync(file + '.v14-backup.json'))
    assert.throws(() => execFileSync(process.execPath, [tool, '--file', file, '--mode', 'apply'], { stdio: 'pipe' }), /Command failed/)
    assert.deepEqual(JSON.parse(readFileSync(file + '.v14-backup.json', 'utf8')), original)
    const migrated = JSON.parse(readFileSync(file, 'utf8'))
    assert.deepEqual(migrated.rooms.r.messages, [])
    assert.equal(readControlPlaneSnapshot(file).v12RoomWake.inbox.i1.content, 'inbox')
    assert.equal(readControlPlaneSnapshot(file).v12RoomWake.transcripts.r[0].content, 'transcript')
    execFileSync(process.execPath, [tool, '--file', file, '--mode', 'rollback'], { encoding: 'utf8' })
    const restored = readControlPlaneSnapshot(file)
    assert.deepEqual(restored.rooms, original.rooms)
    assert.deepEqual(restored.v12RoomWake, { roomInjections: {}, wakes: {}, ...original.v12RoomWake })
    assert.ok(restored.revision > migrated.revision, 'rollback cannot restore an old authority epoch')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('cold storage GC preserves reachable blobs and removes only aged orphans', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'v14-gc-'))
  try {
    resetControlPlaneCache()
    const cp = controlPlaneFor('gc', { directory: dir, coldGcGraceMs: 0 })
    await cp.mutate('fixture/history', {}, null, state => {
      state.rooms.r1 = { roomId: 'r1', messages: [{ messageId: 'm1', content: 'keep me' }] }
    })
    await cp.checkpoint()
    const file = join(dir, 'gc.json')
    const reachable = readdirSync(dir).filter(name => name.includes('.cold-'))
    assert.ok(reachable.length > 0)
    const old = new Date(Date.now() - 60 * 60 * 1000)
    for (const name of reachable) utimesSync(join(dir, name), old, old)
    const orphan = file + '.cold-' + 'f'.repeat(64) + '.json'
    writeFileSync(orphan, '{"orphan":true}', 'utf8')
    utimesSync(orphan, old, old)
    // Audit references are diagnostic history, not reachability roots.
    writeFileSync(file + '.audit.jsonl', JSON.stringify({ type: 'fixture', digest: 'f'.repeat(64) }) + '\n', 'utf8')
    const before = cp.health()
    assert.equal(before.orphanFiles, 1)
    assert.ok(before.orphanBytes > 0)
    const dryRun = await cp.gc({ allowDelete: false })
    assert.equal(dryRun.deletedColdFiles, 0)
    assert.equal(dryRun.reclaimableColdFiles, 1)
    assert.equal(dryRun.deletionSuppressed, true)
    assert.equal(existsSync(orphan), true)
    const result = await cp.gc()
    assert.equal(result.deletedColdFiles, 1)
    assert.equal(result.deletionSuppressed, false)
    assert.equal(existsSync(orphan), false)
    for (const name of reachable) assert.equal(existsSync(join(dir, name)), true)
    assert.equal(cp.health().orphanFiles, 0)
  } finally { resetControlPlaneCache(); rmSync(dir, { recursive: true, force: true }) }
})

test('storage inventory cache follows directory membership and audit size changes', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'v14-inventory-'))
  try {
    resetControlPlaneCache()
    const cp = controlPlaneFor('inventory', { directory: dir })
    const file = join(dir, 'inventory.json')
    const cold = file + '.cold-' + 'a'.repeat(64) + '.json'
    writeFileSync(cold, '{"cold":true}', 'utf8')
    await waitForStorageCacheRefresh()
    const first = cp.health()
    assert.equal(first.coldFiles, 1)

    const secondCold = file + '.cold-' + 'b'.repeat(64) + '.json'
    writeFileSync(secondCold, '{"cold":true}', 'utf8')
    await waitForStorageCacheRefresh()
    assert.equal(cp.health().coldFiles, 2)

    unlinkSync(secondCold)
    await waitForStorageCacheRefresh()
    assert.equal(cp.health().coldFiles, 1)

    const audit = file + '.audit.jsonl'
    writeFileSync(audit, '{"n":1}\n', 'utf8')
    const beforeAuditBytes = cp.health().auditBytes
    await cp.mutate('fixture/audit-growth', {}, null, state => {
      state.counters.activeSlots = Number(state.counters.activeSlots || 0) + 1
    })
    assert.ok(cp.health().auditBytes > beforeAuditBytes)
  } finally { resetControlPlaneCache(); rmSync(dir, { recursive: true, force: true }) }
})

test('reachability cache invalidates when a live recovery snapshot changes', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'v14-reachability-'))
  try {
    resetControlPlaneCache()
    const cp = controlPlaneFor('reachability', { directory: dir, coldGcGraceMs: 0 })
    await cp.mutate('fixture/history', {}, null, state => {
      state.rooms.r1 = { roomId: 'r1', messages: [{ messageId: 'm1', content: 'keep me' }] }
    })
    await cp.checkpoint()
    const file = join(dir, 'reachability.json')
    const digest = 'f'.repeat(64)
    const orphan = file + '.cold-' + digest + '.json'
    writeFileSync(orphan, '{"orphan":true}', 'utf8')
    assert.equal(cp.health().orphanFiles, 1)

    const recovery = file + '.recovery.json'
    writeFileSync(recovery, JSON.stringify({ digest }), 'utf8')
    assert.equal(cp.health().orphanFiles, 0)

    writeFileSync(recovery, JSON.stringify({ digest: null }), 'utf8')
    assert.equal(cp.health().orphanFiles, 1)
  } finally { resetControlPlaneCache(); rmSync(dir, { recursive: true, force: true }) }
})

test('hydrated history cache invalidates after a room mutation', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'v14-history-cache-'))
  try {
    resetControlPlaneCache()
    const cp = controlPlaneFor('history-cache', { directory: dir })
    await cp.roomOpen({ roomId: 'r1', members: ['a'] })
    await cp.mutate('fixture/history-one', {}, null, state => {
      state.rooms.r1.messages.push({ messageId: 'm1', content: 'one' })
    })
    assert.equal(cp.snapshot({ history: true }).rooms.r1.messages[0].messageId, 'm1')
    await cp.mutate('fixture/history-two', {}, null, state => {
      state.rooms.r1.messages.push({ messageId: 'm2', content: 'two' })
    })
    await cp.flush()
    const messages = cp.snapshot({ history: true }).rooms.r1.messages
    assert.deepEqual(messages.map(row => row.messageId), ['m1', 'm2'])
  } finally { resetControlPlaneCache(); rmSync(dir, { recursive: true, force: true }) }
})

test('hydrated history cache never exposes mutable internal state', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'v14-history-cache-copy-'))
  try {
    resetControlPlaneCache()
    const cp = controlPlaneFor('history-cache-copy', { directory: dir })
    await cp.roomOpen({ roomId: 'r1', members: ['a'] })
    await cp.mutate('fixture/history-copy', {}, null, state => {
      state.rooms.r1.messages.push({ messageId: 'm1', content: 'one' })
    })
    await cp.flush()
    const cached = cp.snapshot({ history: true })
    assert.equal(cached.rooms.r1.messages[0].messageId, 'm1')

    const internal = cp.snapshot({ history: true, copy: false })
    internal.rooms.r1.messages[0].content = 'mutated'

    assert.equal(cp.snapshot({ history: true }).rooms.r1.messages[0].content, 'one')
  } finally { resetControlPlaneCache(); rmSync(dir, { recursive: true, force: true }) }
})

test('large requirement ledgers persist by cold reference and reload transparently', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'v14-requirements-ref-'))
  try {
    resetControlPlaneCache()
    const cp = controlPlaneFor('requirements-ref', { directory: dir })
    const text = 'x'.repeat(128 * 1024)
    await cp.mutate('fixture/requirements-ref', {}, null, state => {
      state.v12Requirements = {
        version: 1,
        revision: 1,
        requirements: {
          r1: {
            requirementId: 'r1',
            text,
            quote: text,
            status: 'active',
            revision: 1,
          },
        },
        decisions: {},
        events: [],
      }
    })
    await cp.flush()

    const raw = JSON.parse(readFileSync(cp.file, 'utf8'))
    assert.equal(raw.v12Requirements, undefined)
    assert.equal(raw.v12RequirementsRef.version, 1)
    assert.match(raw.v12RequirementsRef.digest, /^[a-f0-9]{64}$/)
    assert.equal(existsSync(cp.file + '.cold-' + raw.v12RequirementsRef.digest + '.json'), true)
    const coldCount = readdirSync(dir).filter(name => name.includes('.cold-')).length

    await cp.mutate('fixture/requirements-ref-hot', {}, null, state => {
      state.counters.activeSlots = Number(state.counters.activeSlots || 0) + 1
    })
    await cp.flush()
    const hotRaw = JSON.parse(readFileSync(cp.file, 'utf8'))
    assert.equal(hotRaw.v12RequirementsRef.digest, raw.v12RequirementsRef.digest)
    assert.equal(readdirSync(dir).filter(name => name.includes('.cold-')).length, coldCount)

    resetControlPlaneCache()
    const reloaded = controlPlaneFor('requirements-ref', { directory: dir })
    assert.equal(reloaded.snapshot({ history: false }).v12Requirements.requirements.r1.text.length, text.length)
  } finally { resetControlPlaneCache(); rmSync(dir, { recursive: true, force: true }) }
})

test('large v12 evidence and compaction snapshots persist by cold reference', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'v14-v12-cold-refs-'))
  try {
    resetControlPlaneCache()
    const cp = controlPlaneFor('v12-cold-refs', { directory: dir })
    const body = 'evidence-'.repeat(32 * 1024)
    await cp.mutate('fixture/v12-cold-refs', {}, null, state => {
      state.v12Evidence = {
        version: 1,
        records: {
          e1: { id: 'e1', fingerprint: 'fp-1', status: 'passed', body },
        },
      }
      state.v12Compaction = {
        version: 1,
        revision: 7,
        milestones: { m1: { milestoneId: 'm1', goal: body, status: 'done' } },
        jobs: {},
        sequence: {},
      }
    })
    await cp.flush()

    const raw = JSON.parse(readFileSync(cp.file, 'utf8'))
    assert.equal(raw.v12Evidence, undefined)
    assert.equal(raw.v12Compaction, undefined)
    assert.match(raw.v12ColdRefs.v12Evidence.digest, /^[a-f0-9]{64}$/)
    assert.match(raw.v12ColdRefs.v12Compaction.digest, /^[a-f0-9]{64}$/)
    assert.equal(existsSync(cp.file + '.cold-' + raw.v12ColdRefs.v12Evidence.digest + '.json'), true)
    assert.equal(existsSync(cp.file + '.cold-' + raw.v12ColdRefs.v12Compaction.digest + '.json'), true)
    const coldCount = readdirSync(dir).filter(name => name.includes('.cold-')).length

    await cp.mutate('fixture/v12-cold-refs-hot', {}, null, state => {
      state.counters.activeSlots = Number(state.counters.activeSlots || 0) + 1
    })
    await cp.flush()
    const hotRaw = JSON.parse(readFileSync(cp.file, 'utf8'))
    assert.equal(hotRaw.v12ColdRefs.v12Evidence.digest, raw.v12ColdRefs.v12Evidence.digest)
    assert.equal(hotRaw.v12ColdRefs.v12Compaction.digest, raw.v12ColdRefs.v12Compaction.digest)
    assert.equal(readdirSync(dir).filter(name => name.includes('.cold-')).length, coldCount)

    resetControlPlaneCache()
    const reloaded = controlPlaneFor('v12-cold-refs', { directory: dir }).snapshot({ history: false })
    assert.equal(reloaded.v12Evidence.records.e1.body.length, body.length)
    assert.equal(reloaded.v12Compaction.milestones.m1.goal.length, body.length)
  } finally { resetControlPlaneCache(); rmSync(dir, { recursive: true, force: true }) }
})

test('startup and successful checkpoints remove stale temp files', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'v14-temp-'))
  try {
    const file = join(dir, 'temp.json')
    const temps = [
      file + '.tmp-999999-dead',
      file + '.panel-cache.json.tmp-999999-dead',
      file + '.cold-' + 'b'.repeat(64) + '.json.tmp-999999-dead',
    ]
    for (const temp of temps) writeFileSync(temp, 'stale', 'utf8')
    resetControlPlaneCache()
    const cp = controlPlaneFor('temp', { directory: dir })
    for (const temp of temps) assert.equal(existsSync(temp), false)
    await cp.mutate('fixture/write', {}, null, state => { state.counters.activeSlots = 1 })
    await cp.checkpoint()
    assert.deepEqual(readdirSync(dir).filter(name => name.includes('.tmp-')), [])
  } finally { resetControlPlaneCache(); rmSync(dir, { recursive: true, force: true }) }
})

test('audit rotation bounds files and closes cached handles on reset', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'v14-audit-'))
  try {
    resetControlPlaneCache()
    const cp = controlPlaneFor('audit', {
      directory: dir,
      auditMaxBytes: 220,
      auditMaxFiles: 1,
      auditMaxAgeMs: 24 * 60 * 60 * 1000,
    })
    for (let index = 0; index < 20; index += 1) {
      await cp.mutate('fixture/audit', { index }, null, state => { state.counters.activeSlots = index })
    }
    await cp.checkpoint()
    const active = join(dir, 'audit.json.audit.jsonl')
    assert.equal(existsSync(active), true)
    const auditFiles = readdirSync(dir).filter(name => name.includes('.audit'))
    assert.ok(auditFiles.length >= 2)
    assert.ok(auditFiles.length <= 2)
    resetControlPlaneCache()
    assert.doesNotThrow(() => unlinkSync(active))
  } finally { resetControlPlaneCache(); rmSync(dir, { recursive: true, force: true }) }
})

test('ordinary mutations use delayed checkpoints and expose write timings', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'v14-write-timing-'))
  try {
    resetControlPlaneCache()
    const cp = controlPlaneFor('timing', { directory: dir })
    await cp.mutate('fixture/baseline', {}, null, state => { state.counters.activeSlots = 1 }, { deferMs: 0 })
    await cp.checkpoint()
    const file = join(dir, 'timing.json')
    const before = JSON.parse(readFileSync(file, 'utf8')).revision
    await cp.mutate('fixture/deferred', {}, null, state => { state.counters.activeSlots = 2 })
    assert.equal(JSON.parse(readFileSync(file, 'utf8')).revision, before)
    await cp.checkpoint()
    assert.equal(JSON.parse(readFileSync(file, 'utf8')).revision, before + 1)
    const timing = cp.health().write
    assert.ok(timing.samples >= 1)
    for (const field of ['prepareMs', 'serializeMs', 'writeMs', 'renameMs', 'panelCacheMs', 'totalMs', 'bytes', 'queueWaitMs']) {
      assert.equal(typeof timing.last[field], 'number')
      assert.ok(timing.last[field] >= 0)
    }
  } finally { resetControlPlaneCache(); rmSync(dir, { recursive: true, force: true }) }
})
