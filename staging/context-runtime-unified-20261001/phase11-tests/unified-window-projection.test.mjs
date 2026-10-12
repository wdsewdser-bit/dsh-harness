import test from 'node:test'
import assert from 'node:assert/strict'
import { authorityKeys, createWindowCheckpointAuthority, windowHash } from '../home/profiles/web/plugins/team-v15-window-checkpoint.mjs'
import { createWindowProjection } from '../home/profiles/web/plugins/team-v15-window-projection.mjs'
function fixture() {
  const m = (id, role, content) => ({ id, role, source: { kind: 'fixture' }, content: typeof content === 'string' ? [{ type: 'text', text: content }] : content })
  const messages = [m('sys', 'system', 'PTC'), m('old-u', 'user', 'history '.repeat(4000)), m('old-a', 'assistant', 'result '.repeat(4000)), m('now', 'user', 'new pending')]
  const s = { sessionId: 'isolated', actorId: 'actor', rootTeamId: 'team', windowId: 1, surfaceRevision: 3,
    criticalRevisionVector: { task: 1, lease: 1 }, identityVersion: 1, identityHashes: { actor: 'known' }, configFingerprint: 'fixed-order',
    planRef: { path: 'plan', sha256: windowHash('plan') }, planRevision: 1, planHash: windowHash('plan'),
    authority: Object.fromEntries(authorityKeys.map(key => [key, []])), working: { progress: 'done' },
    recovery: { requiredRereads: [], memoryDebt: ['old-events'], activeJobs: [] },
    messages, recentTailIds: ['now'], pendingMessageIds: ['now'], events: [], completedSpans: [], protocolCertificateHash: 'cert' }
  function rebind() {
    s.events = messages.slice(1, -1).map((message, seq) => ({ seq, type: message.role === 'tool' ? 'tool/result' : message.role + '/message', data: message.role === 'user' ? message : { message } }))
    s.completedSpans = [{ status: 'completed', messageIds: messages.slice(1, -1).map(m => m.id),
      eventRefs: s.events.map(e => ({ seq: e.seq, sha256: windowHash(e) })), retentionReceipt: { currentAcl: true }, memoryDebtCovered: true }]
  }
  rebind()
  const authority = createWindowCheckpointAuthority({ readSource: () => s, verifyRecovery: (_, span) => span.retentionReceipt.currentAcl })
  const config = { authority, mode: 'W1', sessions: ['isolated'], routes: [{ provider: 'fixture', model: 'model', protocol: 'deepseek-dsh-v1', certificateHash: 'cert', configFingerprint: 'fixed-order', expiresAt: Date.now() + 60000 }] }
  const request = () => ({ sessionId: 'isolated', actorId: 'actor', provider: 'fixture', model: 'model', messages, signal: new AbortController().signal })
  const plan = () => createWindowProjection(config).plan(request())
  return { s, messages, m, rebind, authority, config, request, plan }
}
for (const [name, change, code] of [
  ['missing authority', f => { delete f.s.authority.ownerScopeLeaseRefs }, 'WINDOW_AUTHORITY_INCOMPLETE'],
  ['revoked recovery ACL', f => { f.s.completedSpans[0].retentionReceipt.currentAcl = false }, 'WINDOW_RECOVERY_UNAVAILABLE'],
  ['wrong event hash', f => { f.s.completedSpans[0].eventRefs[0].sha256 = 'wrong' }, 'WINDOW_EVENT_REF_MISMATCH'],
  ['pending span', f => { f.s.completedSpans[0].status = 'running' }, 'WINDOW_SPAN_UNPROVEN'],
  ['uncovered memory debt', f => { f.s.completedSpans[0].memoryDebtCovered = false }, 'WINDOW_SPAN_UNPROVEN'],
  ['protected recent tail', f => { f.s.recentTailIds.push('old-u') }, 'WINDOW_PROTECTED_MESSAGE'],
  ['reasoning history', f => { f.messages[2].content.push({ type: 'reasoning', text: 'needed DeepSeek reasoning' }); f.rebind() }, 'WINDOW_REASONING_RETENTION_REQUIRED'],
  ['unknown block', f => { f.messages[1].content.push({ type: 'future', text: 'x' }); f.rebind() }, 'WINDOW_UNKNOWN_BLOCK'],
  ['unknown protocol', f => { f.config.routes[0].protocol = 'unknown' }, 'WINDOW_PROTOCOL_UNCERTIFIED'],
  ['expired certificate', f => { f.config.routes[0].expiresAt = 0 }, 'WINDOW_PROTOCOL_UNCERTIFIED'],
  ['changed transform order', f => { f.config.routes[0].configFingerprint = 'different' }, 'WINDOW_PROTOCOL_UNCERTIFIED'],
  ['payload cap', f => { f.config.maxPayloadBytes = 20 }, 'WINDOW_NO_BOUNDED_REDUCTION'],
]) test(name + ' blocks without rewriting the original messages', () => {
  const f = fixture(); change(f)
  const before = windowHash(f.messages), result = f.plan()
  assert.equal(result.messages, f.messages)
  assert.equal(result.blockedReason, code)
  assert.equal(windowHash(f.messages), before)
})
test('completed tool pairs stay atomic; pending and split calls block', () => {
  const f = fixture()
  f.messages.splice(2, 0, f.m('call-msg', 'assistant', [{ type: 'tool-call', id: 'call', name: 'ptc', arguments: '{}' }]),
    { ...f.m('result-msg', 'tool', 'tool output'), toolCallId: 'call' })
  f.rebind()
  assert.equal(f.plan().status, 'projected')
  f.messages.splice(3, 1); f.rebind()
  assert.equal(f.plan().blockedReason, 'WINDOW_PENDING_CHAIN')
})
test('checkpoint source and authority CAS reject stale and caller-mutated checkpoint', () => {
  const f = fixture(), cp = f.authority.capture('isolated').checkpoint
  assert.ok(Object.isFrozen(cp.authority))
  f.s.criticalRevisionVector.task++
  assert.throws(() => f.authority.validate(cp), { code: 'WINDOW_SOURCE_CAS_CONFLICT' })
  const edited = structuredClone(cp); edited.authority.activeTaskIds.push('fake')
  assert.throws(() => f.authority.validate(edited), { code: 'WINDOW_CHECKPOINT_INTEGRITY' })
})
test('pure preview never writes source or records estimated bytes as provider tokens', () => {
  const f = fixture(), before = windowHash(f.s), result = f.plan()
  assert.equal(result.status, 'projected')
  assert.equal(windowHash(f.s), before)
  assert.equal(Object.isFrozen(f.messages[0]), false)
  assert.equal(result.estimated.providerTokens, 'unknown')
  assert.equal(result.excluded.length, 2)
  assert.ok(result.retained.some(row => row.id === 'sys'))
  assert.ok(result.retained.some(row => row.id === 'now'))
})
test('W0 preview preserves caller mutability and immutable candidate independence', () => {
  const f = fixture(); f.config.mode = 'W0'
  const result = f.plan()
  assert.equal(result.messages, f.messages)
  assert.equal(Object.isFrozen(f.messages[0]), false)
  const candidate = windowHash(result.candidateMessages)
  f.messages[0].content[0].text = 'caller changes system after preview'
  assert.equal(windowHash(result.candidateMessages), candidate)
})
test('async server readers and clock cannot certify an unknown snapshot', () => {
  const f = fixture()
  const authority = createWindowCheckpointAuthority({ readSource: async () => f.s, verifyRecovery: () => true })
  assert.throws(() => authority.capture('isolated'), { code: 'WINDOW_SERVER_READER_REQUIRED' })
  f.config.now = async () => Date.now()
  assert.equal(f.plan().blockedReason, 'WINDOW_SERVER_READER_REQUIRED')
})
