import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { spawn } from 'node:child_process'
import { createContextWorkspaceService } from '../home/profiles/web/plugins/context-workspace.mjs'
import { policyFor, resetPolicyServices } from '../home/profiles/web/plugins/team-policy.mjs'
import { controlPlaneForMember, resetControlPlaneCache } from '../home/profiles/web/plugins/team-control-plane.mjs'
import { updateDurableJsonSync } from '../home/profiles/web/plugins/team-v14-durable-store.mjs'

function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'memo-recovery-pin-'))
  let clock = 100000
  const teamId = 'pin-team', sessionId = 'pin-session'
  const agent = { id: sessionId, session: { id: sessionId } }
  const peer = { id: 'peer-session', session: { id: 'peer-session' } }
  const ctx = { agents: { list: () => [agent, peer] }, agentTeams: {
    tryMembership: candidate => ({ id: teamId, name: candidate === agent ? 'root' : 'peer', tier: 0 }),
  } }
  policyFor(teamId).put({ name: 'root', tier: 0 })
  policyFor(teamId).put({ name: 'peer', tier: 0 })
  const config = { directory: join(directory, 'memo'), controlDir: join(directory, 'control'), now: () => clock }
  const service = createContextWorkspaceService(ctx, config)
  const control = controlPlaneForMember(ctx, agent, { directory: config.controlDir })
  const file = join(config.directory, createHash('sha256').update(teamId).digest('hex') + '.json')
  const manage = (action, input = {}) => service.manage(agent, { action, input })
  const put = (sourceId, extra = {}) => {
    const row = manage('memo_put', { sourceId, expectedRevision: 0, text: sourceId + ' exact body', ttlMs: 10, ...extra })
    assert.equal(row.ok, true, JSON.stringify(row))
    return row
  }
  t.after(() => { resetControlPlaneCache(); resetPolicyServices(); rmSync(directory, { recursive: true, force: true }) })
  return { directory, config, service, agent, peer, ctx, control, file, manage, put,
    advance: delta => { clock += delta }, clock: () => clock }
}

test('checkpoint pins preserve exact revisions and transitive evidence beyond ordinary TTL', t => {
  const f = fixture(t)
  const evidence = f.put('evidence')
  const note = f.put('working', { evidenceRefs: [{ sourceId: evidence.sourceId, revision: evidence.revision, sha256: evidence.sha256 }] })
  const receipt = f.service.retainRecovery(f.agent, { ownerId: 'checkpoint:one', locators: [note.locator] })
  assert.equal(receipt.kind, 'context-recovery-retention-v1')
  assert.equal(receipt.refs.length, 2)
  assert.equal(receipt.retention, 'checkpoint-owned-until-release')
  assert.deepEqual(f.service.retainRecovery(f.agent, { ownerId: 'checkpoint:one', locators: [note.locator] }), receipt)
  assert.deepEqual(f.manage('state').pins, [])
  const second = f.manage('memo_put', { sourceId: 'working', expectedRevision: 1, text: 'newer body', ttlMs: 10 })
  assert.equal(second.ok, true)
  f.advance(11)
  assert.equal(f.manage('memo_get', { locator: second.locator }).code, 'SOURCE_EXPIRED')
  assert.equal(f.manage('memo_get', { locator: note.locator }).text, note.sourceId + ' exact body')
  const recovered = f.service.readRecovery(f.agent, receipt)
  assert.equal(recovered.sources.find(row => row.sourceId === 'working').text, 'working exact body')
  assert.deepEqual(f.service.renewRecovery(f.agent, receipt), receipt)
  const cold = createContextWorkspaceService(f.ctx, f.config)
  assert.deepEqual(cold.readRecovery(f.agent, receipt).sources, recovered.sources)
})

test('a selected view remains projectable after its exact source TTL only while recovery retention is live', t => {
  const f = fixture(t), row = f.put('projected')
  const receipt = f.service.retainRecovery(f.agent, { ownerId: 'checkpoint:projection', locators: [row.locator] })
  const proposal = f.manage('propose', { expectedRevision: 0,
    operations: [{ op: 'pin', sourceId: row.sourceId, revision: row.revision, sha256: row.sha256 }] })
  assert.equal(proposal.ok, true, JSON.stringify(proposal))
  assert.equal(f.manage('commit', { expectedRevision: 0, proposalId: proposal.proposalId }).ok, true)
  f.ctx.requestMessageProjection = { isAgentLoopRequest: () => true }
  const applied = createContextWorkspaceService(f.ctx, { ...f.config, mode: 'apply', appliedSessionIds: [f.agent.session.id] })
  const request = { sessionId: f.agent.session.id, purpose: 'conversation', messages: [
    { id: 'current', role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'current task' }] },
  ] }
  assert.equal(applied.project(request).contextWorkspace.status, 'applied-allowlisted')
  f.advance(11)
  const retainedPreview = applied.project(request)
  assert.equal(retainedPreview.contextWorkspace.status, 'applied-allowlisted', JSON.stringify(retainedPreview.contextWorkspace))
  assert.ok(JSON.stringify(retainedPreview.messages).includes('projected exact body'))
  f.service.releaseRecovery(f.agent, receipt)
  assert.equal(applied.project(request).contextWorkspace.code, 'SOURCE_EXPIRED')
})

test('recovery pins never bypass the 64-content limit or the final revocation tombstone', t => {
  const f = fixture(t)
  const first = f.put('bounded')
  const receipt = f.service.retainRecovery(f.agent, { ownerId: 'checkpoint:bounded', locators: [first.locator] })
  for (let revision = 1; revision < 64; revision++) {
    assert.equal(f.manage('memo_put', { sourceId: 'bounded', expectedRevision: revision, text: 'revision ' + (revision + 1) }).ok, true)
  }
  assert.equal(f.manage('memo_put', { sourceId: 'bounded', expectedRevision: 64, text: 'overflow' }).code, 'HISTORY_OR_OBJECT_LIMIT')
  assert.equal(f.manage('memo_put', { sourceId: 'bounded', expectedRevision: 64, deleted: true }).revision, 65)
  assert.throws(() => f.service.readRecovery(f.agent, receipt), /SOURCE_DELETED/)
  assert.throws(() => f.service.renewRecovery(f.agent, receipt), /SOURCE_DELETED/)
  assert.equal(f.manage('memo_get', { locator: first.locator }).code, 'SOURCE_DELETED')
  assert.equal(f.service.releaseRecovery(f.agent, receipt).released, true)
})

test('admission is all-or-nothing and rejects unavailable, expired and foreign references', t => {
  const f = fixture(t), first = f.put('valid'), before = readFileSync(f.file, 'utf8')
  const missing = first.locator.replace('/valid@1/', '/missing@1/')
  assert.throws(() => f.service.retainRecovery(f.agent, { ownerId: 'checkpoint:bad', locators: [first.locator, missing] }), /SOURCE_UNAVAILABLE/)
  assert.equal(readFileSync(f.file, 'utf8'), before)
  assert.throws(() => f.service.retainRecovery(f.peer, { ownerId: 'checkpoint:foreign', locators: [first.locator] }), /MEMBER_SCOPE_DENIED/)
  assert.equal(readFileSync(f.file, 'utf8'), before)
  f.advance(11)
  assert.throws(() => f.service.retainRecovery(f.agent, { ownerId: 'checkpoint:late', locators: [first.locator] }), /SOURCE_EXPIRED/)
  assert.equal(readFileSync(f.file, 'utf8'), before)
})

test('independent checkpoint owners retain shared content until the final release, without stale resurrection', t => {
  const f = fixture(t), row = f.put('shared')
  const a = f.service.retainRecovery(f.agent, { ownerId: 'checkpoint:a', locators: [row.locator] })
  const b = f.service.retainRecovery(f.agent, { ownerId: 'checkpoint:b', locators: [row.locator] })
  f.advance(11)
  assert.throws(() => f.service.releaseRecovery(f.peer, a), /RECOVERY_PIN_SCOPE_DENIED/)
  f.service.releaseRecovery(f.agent, a)
  assert.equal(f.manage('memo_get', { locator: row.locator }).ok, true)
  assert.throws(() => f.service.readRecovery(f.agent, a), /RECOVERY_PIN_UNAVAILABLE/)
  f.service.releaseRecovery(f.agent, b)
  assert.equal(f.manage('memo_get', { locator: row.locator }).code, 'SOURCE_EXPIRED')
  assert.throws(() => f.service.renewRecovery(f.agent, b), /RECOVERY_PIN_UNAVAILABLE/)
  assert.equal(JSON.parse(readFileSync(f.file)).objects.shared.history.length, 1)
})

test('pin receipt and stored row tampering fail closed and retention bounds do not evict existing pins', t => {
  const f = fixture(t), row = f.put('capacity')
  const receipt = f.service.retainRecovery(f.agent, { ownerId: 'checkpoint:0', locators: [row.locator] })
  assert.throws(() => f.service.readRecovery(f.agent, { ...receipt, ownerId: 'checkpoint:forged' }), /RECOVERY_PIN/)
  for (let i = 1; i < 64; i++) f.service.retainRecovery(f.agent, { ownerId: 'checkpoint:' + i, locators: [row.locator] })
  assert.throws(() => f.service.retainRecovery(f.agent, { ownerId: 'checkpoint:overflow', locators: [row.locator] }), /RECOVERY_PIN_LIMIT/)
  assert.equal(f.service.readRecovery(f.agent, receipt).sources.length, 1)
  updateDurableJsonSync(f.file, doc => { doc.objects.capacity.history[0].text = 'tampered' })
  assert.throws(() => f.service.readRecovery(f.agent, receipt), /STORED_HASH_MISMATCH/)
})

test('current task authority is rechecked after retention and revoked access never survives in a cold service', async t => {
  const f = fixture(t)
  await f.control.mutateHot('fixture/task', {}, f.agent, state => {
    state.boards.global = { tasks: { retained: { id: 'retained', board: 'global', ownerName: 'root', status: 'in_progress', revision: 1 } } }
  }, { deferMs: 0 })
  const row = f.put('task-scoped', { scope: 'task', taskId: 'retained' })
  const receipt = f.service.retainRecovery(f.agent, { ownerId: 'checkpoint:task', locators: [row.locator] })
  f.advance(11)
  assert.equal(f.service.readRecovery(f.agent, receipt).sources.length, 1)
  await f.control.mutateHot('fixture/revoke-task', {}, f.agent, state => {
    delete state.boards.global.tasks.retained
  }, { deferMs: 0 })
  const cold = createContextWorkspaceService(f.ctx, f.config)
  assert.throws(() => cold.readRecovery(f.agent, receipt), /TASK_UNAVAILABLE/)
  assert.equal(cold.manage(f.agent, { action: 'memo_get', input: { locator: row.locator } }).code, 'TASK_UNAVAILABLE')
  assert.throws(() => cold.renewRecovery(f.agent, receipt), /TASK_UNAVAILABLE/)
  assert.equal(cold.releaseRecovery(f.agent, receipt).released, true)
})

test('a released receipt cannot revive when the same checkpoint owner acquires a new pin', t => {
  const f = fixture(t), row = f.put('new-generation')
  const input = { ownerId: 'checkpoint:same', locators: [row.locator] }
  const old = f.service.retainRecovery(f.agent, input)
  f.service.releaseRecovery(f.agent, old)
  const current = f.service.retainRecovery(f.agent, input)
  assert.notEqual(current.id, old.id)
  assert.throws(() => f.service.readRecovery(f.agent, old), /RECOVERY_PIN_UNAVAILABLE/)
  assert.equal(f.service.readRecovery(f.agent, current).sources[0].text, row.sourceId + ' exact body')
})

test('the full transitive reference bound refuses atomically rather than silently truncating recovery', t => {
  const f = fixture(t)
  let row
  for (let i = 0; i < 33; i++) row = f.put('chain-' + i, {
    evidenceRefs: row ? [{ sourceId: row.sourceId, revision: row.revision, sha256: row.sha256 }] : [],
  })
  const before = readFileSync(f.file, 'utf8')
  assert.throws(() => f.service.retainRecovery(f.agent, { ownerId: 'checkpoint:too-many', locators: [row.locator] }), /RECOVERY_REFS_LIMIT/)
  assert.equal(readFileSync(f.file, 'utf8'), before)
})

test('concurrent fresh-process pin admissions preserve every durable owner without lost updates', { timeout: 20000 }, async t => {
  const f = fixture(t), row = f.put('concurrent')
  f.service.retainRecovery(f.agent, { ownerId: 'checkpoint:seed', locators: [row.locator] })
  const moduleUrl = new URL('../home/profiles/web/plugins/context-workspace.mjs', import.meta.url).href
  const policyUrl = new URL('../home/profiles/web/plugins/team-policy.mjs', import.meta.url).href
  const script = `
    import {createContextWorkspaceService} from ${JSON.stringify(moduleUrl)};
    import {policyFor} from ${JSON.stringify(policyUrl)};
    const agent={id:'pin-session',session:{id:'pin-session'}};
    const ctx={agents:{list:()=>[agent]},agentTeams:{tryMembership:()=>({id:'pin-team',name:'root',tier:0})}};
    policyFor('pin-team').put({name:'root',tier:0});
    const service=createContextWorkspaceService(ctx,${JSON.stringify({ directory: f.config.directory, controlDir: f.config.controlDir })});
    for(let i=0;i<8;i++) service.retainRecovery(agent,{ownerId:'checkpoint:'+process.argv[1]+i,locators:[${JSON.stringify(row.locator)}]});
  `
  const children = ['left', 'right'].map(prefix => spawn(process.execPath, ['--input-type=module', '-e', script, prefix], {
    env: { ...process.env, DSH_HOME: f.directory }, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
  }))
  t.after(() => { for (const child of children) if (child.exitCode === null) child.kill() })
  await Promise.all(children.map(child => new Promise((resolve, reject) => {
    let stderr = ''
    child.stdout.resume()
    child.stderr.on('data', value => { stderr += value })
    child.on('error', reject)
    child.on('close', code => code === 0 ? resolve() : reject(new Error(stderr)))
  })))
  const pins = f.service.listRecovery(f.agent)
  assert.equal(pins.length, 17)
  assert.equal(new Set(pins.map(pin => pin.ownerId)).size, 17)
  for (const pin of pins) assert.equal(f.service.readRecovery(f.agent, pin).sources[0].text, 'concurrent exact body')
})

test('a genuinely fresh process reloads the retained exact body after TTL with no service cache', async t => {
  const f = fixture(t), row = f.put('cold')
  const receipt = f.service.retainRecovery(f.agent, { ownerId: 'checkpoint:cold', locators: [row.locator] })
  const moduleUrl = new URL('../home/profiles/web/plugins/context-workspace.mjs', import.meta.url).href
  const policyUrl = new URL('../home/profiles/web/plugins/team-policy.mjs', import.meta.url).href
  const script = `
    import {createContextWorkspaceService} from ${JSON.stringify(moduleUrl)};
    import {policyFor} from ${JSON.stringify(policyUrl)};
    const agent={id:'pin-session',session:{id:'pin-session'}};
    const ctx={agents:{list:()=>[agent]},agentTeams:{tryMembership:()=>({id:'pin-team',name:'root',tier:0})}};
    policyFor('pin-team').put({name:'root',tier:0});
    const service=createContextWorkspaceService(ctx,${JSON.stringify({ directory: f.config.directory, controlDir: f.config.controlDir })});
    console.log('RETENTION_RESULT '+JSON.stringify(service.readRecovery(agent,${JSON.stringify(receipt)})));
  `
  const child = spawn(process.execPath, ['--input-type=module', '-e', script], {
    env: { ...process.env, DSH_HOME: f.directory }, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
  })
  let stdout = '', stderr = ''
  child.stdout.on('data', value => { stdout += value })
  child.stderr.on('data', value => { stderr += value })
  const exit = await new Promise((resolve, reject) => { child.on('error', reject); child.on('close', resolve) })
  assert.equal(exit, 0, stderr)
  const results = stdout.split(/\r?\n/).filter(line => line.startsWith('RETENTION_RESULT '))
  assert.equal(results.length, 1, stdout)
  const recovered = JSON.parse(results[0].slice('RETENTION_RESULT '.length))
  assert.equal(recovered.sources[0].text, 'cold exact body')
  assert.deepEqual(recovered.receipt, receipt)
})
