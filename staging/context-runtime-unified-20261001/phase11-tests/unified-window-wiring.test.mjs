/**
 * The wiring between the W2 executor and a host: scope, the pre-step guard for sessions that already hold a window,
 * recovery at idle, and the fold handle the compaction plugin asks. The executor itself is replaced by a scripted
 * double here; its real behaviour is covered by native-tests/window-executor-runtime.test.mjs.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, existsSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { apply, windowScope } from '../home/profiles/web/plugins/team-v15-window-wiring.mjs'

const FOLD = Symbol.for('dsh.window.fold.v1')
const settle = () => new Promise(resolve => setImmediate(resolve))

function harness(t, { config = {}, script = {}, bindServices = true, events } = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'window-wiring-'))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  const logFile = join(directory, 'wiring.jsonl')
  const handlers = new Map()
  const sent = []
  const inbox = { nextStep: [], nextTurn: [], splice(target, start, remove, items) { (target === 'next-step' ? this.nextStep : this.nextTurn).splice(Math.min(start, 1e9), remove, ...items) } }
  const agent = { id: 'root-session', session: { id: 'root-session', ...(events ? { snapshotEvents: () => events } : {}) }, options: { provider: 'fixture', model: 'fixture' }, status: 'idle', inbox,
    send(message, target, wakeup) { sent.push({ message, target, wakeup }) } }
  const membership = { id: 'team', name: 'lead', tier: 0, root: agent }
  // The scripted executor: `guard` is the current refusal reason (null = clear), the rest are counters and outcomes.
  const state = { guard: null, healthy: true, needsRecover: false, reason: 'window-state-absent', installs: 0, recovers: 0, folds: [], installOk: true,
    foldResult: { outcome: 'folded', receipt: { toWindowId: 1 } }, ...script }
  const executor = {
    state: () => ({ sessionId: agent.session.id, installed: state.healthy, healthy: state.healthy, needsRecover: state.needsRecover, reason: state.reason }),
    guardStep: () => { if (state.guardThrows) throw new Error('projection service is being rebuilt'); return state.guard },
    async ensureInstalled() { state.installs++; if (!state.installOk) return { ok: false, reason: 'WINDOW_PARTICIPATION_UNVERIFIED', retryAt: Date.now() + (state.retryInMs ?? 600000) }; state.healthy = true; return { ok: true, handle: {} } },
    async recoverIfNeeded() { state.recovers++; state.needsRecover = false; state.guard = null; state.reason = 'window-install-healthy'; return { state: 'recovered', states: ['committed', 'clean'] } },
    async tryFold(_agent, facts, options) { state.folds.push(facts); state.foldOptions = options; return state.foldResult },
    forget() {},
    missingBaseline: () => state.baseline ?? null,
  }
  const commands = []
  const services = { agents: { list: () => [agent] }, agentTeams: { tryMembership: row => (row === agent ? membership : undefined) },
    commands: { register(command) { commands.push(command); return () => { commands.splice(commands.indexOf(command), 1) } } } }
  const scoped = { get: name => services[name], on(event, handler) { handlers.set(event, [...(handlers.get(event) ?? []), handler]); return () => {} } }
  // The guard binds on `agents` alone; everything else waits for the full service list, which a host may not provide.
  const ctx = { logger: { warn() {}, info() {} }, inject(names, callback) { if (bindServices || names.length === 1) callback(scoped); return () => {} } }
  const stop = apply(ctx, { logFile, createExecutor: () => executor, ...config })
  t.after(stop)
  const preStep = async (messages = []) => {
    const chain = [...(handlers.get('agent/pre-step') ?? []), () => ({ kind: 'enter', messages })]
    const run = index => chain[index]({ agent, messages }, () => run(index + 1))
    return run(0)
  }
  const emit = (event, payload) => { for (const handler of handlers.get(event) ?? []) handler({ agent, ...payload }) }
  const log = () => existsSync(logFile) ? readFileSync(logFile, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line)) : []
  const command = rawInput => commands.find(row => row.name === 'window').handler({ agent, rawInput })
  return { agent, command, commands, emit, inbox, log, preStep, sent, state, stop }
}

test('scope: off unless enabled; list names sessions; team-roots takes only a tier-0 root that is its own session', () => {
  const agent = { id: 's1', session: { id: 's1' } }
  const teams = { tryMembership: row => (row === agent ? { tier: 0, root: agent } : { tier: 2, root: agent }) }
  assert.equal(windowScope({ scope: 'list', sessions: ['s1'] }, teams)(agent), false, 'not enabled')
  assert.equal(windowScope({ enabled: true, scope: 'list', sessions: ['s1'] }, teams)(agent), true)
  assert.equal(windowScope({ enabled: true, scope: 'list', sessions: ['other'] }, teams)(agent), false)
  assert.equal(windowScope({ enabled: true, scope: 'team-roots' }, teams)(agent), true)
  assert.equal(windowScope({ enabled: true, scope: 'team-roots' }, teams)({ id: 'm1', session: { id: 'm1' } }), false, 'a member is not a root')
  assert.equal(windowScope({ enabled: true, scope: 'bogus' }, teams)(agent), false)
})

test('a session with no window state passes the guard untouched', async t => {
  const h = harness(t)
  const messages = [{ id: 'm1' }]
  assert.deepEqual(await h.preStep(messages), { kind: 'enter', messages })
  assert.equal(h.state.installs, 0)
})

test('a session whose window is not restored is refused, its claimed input goes straight back, and it is woken after recovery', async t => {
  const h = harness(t, { script: { guard: 'window-guard:window-state-uninstalled', healthy: false, needsRecover: true, reason: 'window-state-uninstalled' } })
  await settle()
  // The start-up pass already attended to the idle agent; put the guard back to observe the refusal path itself.
  h.state.guard = 'window-guard:recovery-required'; h.state.needsRecover = true; h.state.healthy = true
  h.inbox.nextStep.push({ id: 'later' })
  const decision = await h.preStep([{ id: 'm1' }, { id: 'm2' }])
  assert.equal(decision.kind, 'reject')
  assert.match(decision.reason, /^window-guard:recovery-required: /)
  assert.deepEqual(h.inbox.nextStep.map(row => row.id), ['m1', 'm2', 'later'], 'back in the inbox, in order: nothing is kept only in memory')
  const installsBefore = h.state.installs
  h.emit('agent/status', { status: 'idle' })
  await settle()
  assert.equal(h.state.installs, installsBefore + 1)
  assert.equal(h.sent.length, 1, 'woken once the window is back')
  assert.deepEqual([h.sent.at(-1).target, h.sent.at(-1).wakeup], ['next-turn', true])
  assert.deepEqual((await h.preStep()).kind, 'enter')
  assert.ok(h.log().some(row => row.kind === 'guard' && row.returnedMessages === 2))
})

test('the guard does not depend on the services folding needs, and refuses when it cannot answer', async t => {
  const committed = [{ type: 'user/message', data: { source: { windowCommit: { transitionId: 't1' } } } }]
  const unbound = harness(t, { bindServices: false, events: committed })
  const refused = await unbound.preStep([{ id: 'm1' }])
  assert.equal(refused.kind, 'reject', 'a session that holds a window is not let through just because the wiring could not start')
  assert.match(refused.reason, /^window-guard:wiring-not-started/)
  assert.deepEqual(unbound.inbox.nextStep.map(row => row.id), ['m1'])
  const plain = harness(t, { bindServices: false, events: [] })
  assert.equal((await plain.preStep()).kind, 'enter', 'a session without window state is untouched')

  const broken = harness(t, { events: committed, script: { guardThrows: true } })
  assert.match((await broken.preStep()).reason, /^window-guard:guard-failed/)
  const brokenPlain = harness(t, { events: [], script: { guardThrows: true } })
  assert.equal((await brokenPlain.preStep()).kind, 'enter')
})

test('a failed install of a refused session is retried on a timer, not only at the next idle event', async t => {
  const h = harness(t, { script: { guard: 'window-guard:window-state-uninstalled', healthy: false, needsRecover: true, reason: 'window-state-uninstalled', installOk: false, retryInMs: 0 } })
  await settle()
  assert.equal(h.state.installs, 1)
  h.state.installOk = true
  await new Promise(resolve => setTimeout(resolve, 1300))
  assert.equal(h.state.installs, 2, 'retried without anybody waking the session')
  assert.equal(h.state.recovers, 1)
  assert.equal((await h.preStep()).kind, 'enter')
})

test('a wake that fails asynchronously is recorded, not left as an unhandled rejection', async t => {
  const h = harness(t, { script: { guard: 'window-guard:recovery-required', healthy: true, needsRecover: true, reason: 'window-install-healthy' } })
  await settle()
  h.state.guard = 'window-guard:recovery-required'; h.state.needsRecover = true
  h.agent.send = () => Promise.reject(Object.assign(new Error('hard aborted'), { code: 'NATIVE_HARD_ABORTED' }))
  await h.preStep([{ id: 'm1' }])
  h.emit('agent/status', { status: 'idle' })
  await settle(); await settle()
  assert.ok(h.log().some(row => row.kind === 'send-failed' && row.reason === 'NATIVE_HARD_ABORTED'))
})

test('recovery waits for an idle boundary and a failed install keeps the session refused', async t => {
  const h = harness(t, { script: { guard: 'window-guard:window-state-uninstalled', healthy: false, needsRecover: true, reason: 'window-state-uninstalled', installOk: false } })
  await settle()
  assert.equal(h.state.installs, 1)
  assert.equal(h.state.recovers, 0, 'nothing to recover without an install')
  assert.equal((await h.preStep([{ id: 'm1' }])).kind, 'reject')
  h.agent.status = 'running'
  h.emit('agent/status', { status: 'running' })
  await settle()
  assert.equal(h.state.installs, 1, 'not attended while running')
  assert.ok(h.log().some(row => row.kind === 'attend' && row.outcome === 'install-failed'))
})

test('the fold handle answers only for sessions in scope, and passes the facts through', async t => {
  const out = harness(t)
  assert.deepEqual(await globalThis[FOLD].tryFold(out.agent, { contextTokens: 300000 }), { outcome: 'fallback', reason: 'window-scope' })
  out.stop()
  assert.equal(globalThis[FOLD], undefined, 'the handle goes away with the plugin')
  const h = harness(t, { config: { enabled: true, scope: 'list', sessions: ['root-session'] } })
  const facts = { contextTokens: 300000, milestoneDone: true, safeBoundary: true }
  assert.equal((await globalThis[FOLD].tryFold(h.agent, facts)).outcome, 'folded')
  assert.deepEqual(h.state.folds, [facts])
})

test('turning the feature off does not strip protection from a session that already holds a window', async t => {
  const h = harness(t, { config: { enabled: false }, script: { guard: 'window-guard:window-state-uninstalled', healthy: false, needsRecover: true, reason: 'window-state-uninstalled' } })
  await settle()
  assert.equal(h.state.installs, 1, 'installed for protection')
  assert.equal(h.state.recovers, 1)
  assert.equal((await globalThis[FOLD].tryFold(h.agent, {})).reason, 'window-scope', 'but no new folds')
})

test('the operator command reports state and folds on request, inside the scope only', async t => {
  const out = harness(t)
  assert.equal((await out.command('fold')).kind, 'error', 'outside the scope nothing is folded by hand either')
  assert.deepEqual(out.state.folds, [])
  assert.match((await out.command('')).text, /^window {"inScope":false/)
  out.stop()
  assert.deepEqual(out.commands, [], 'the command goes away with the plugin')

  const h = harness(t, { config: { enabled: true, scope: 'list', sessions: ['root-session'] } })
  const done = await h.command('fold')
  assert.deepEqual([done.kind, done.text], ['success', 'window folded: {"state":null,"toWindowId":1}'])
  assert.deepEqual(h.state.foldOptions, { manual: true }, 'the size and phase rule is skipped for an explicit request')
  h.state.foldResult = { outcome: 'fallback', reason: 'WINDOW_HOST_BUSY_AT_BOUNDARY' }
  assert.deepEqual(await h.command('fold'), { kind: 'error', text: 'window fold refused: WINDOW_HOST_BUSY_AT_BOUNDARY' })
  assert.equal((await h.command('bogus')).kind, 'error')
  assert.ok(h.log().some(row => row.kind === 'manual-fold' && row.outcome === 'folded'))
})

test('a windowed session whose conversation lost its checkpoint gets one baseline message, queued without a wake', async t => {
  const h = harness(t, { script: { healthy: true, reason: 'window-install-healthy', baseline: { checkpointId: 'cp-1', authority: { activeTaskIds: ['t1'] } } } })
  await settle()
  const baselines = () => h.sent.filter(row => row.message.source?.nativeWindowBaseline)
  assert.equal(baselines().length, 1)
  assert.deepEqual([baselines()[0].target, baselines()[0].wakeup], ['next-step', false])
  assert.deepEqual(baselines()[0].message.source.nativeWindowBaseline, { checkpointId: 'cp-1', authority: { activeTaskIds: ['t1'] } })
  h.emit('agent/status', { status: 'idle' })
  await settle()
  assert.equal(baselines().length, 1, 'the same baseline is not sent twice')
  h.state.baseline = null
  h.emit('agent/status', { status: 'idle' })
  await settle()
  assert.equal(baselines().length, 1)
})

test('a list may name workspace folders: Team roots working there are in scope, members and other folders are not', () => {
  const root = { id: 'r1', session: { id: 'r1', header: { cwd: 'D:\\work\\big-test\\sub' } } }
  const member = { id: 'm1', session: { id: 'm1', header: { cwd: 'D:\\work\\big-test' } } }
  const elsewhere = { id: 'r2', session: { id: 'r2', header: { cwd: 'D:\\work\\big-test-other' } } }
  const teams = { tryMembership: row => row === member ? { tier: 2, root } : { tier: 0, root: row } }
  const scope = windowScope({ enabled: true, scope: 'list', sessions: ['x'], workspaces: ['D:/work/big-test/'] }, teams)
  assert.deepEqual([scope(root), scope(member), scope(elsewhere)], [true, false, false])
})
