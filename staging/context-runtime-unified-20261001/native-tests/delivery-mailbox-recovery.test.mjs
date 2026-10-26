import test from 'node:test'
import assert from 'node:assert/strict'
import { Context, Service } from '@deepseek-ai/cordis'
import { Session } from '../app/node_modules/@deepseek-ai/dsh-session/lib/index.js'
import { SessionProjectionRegistry } from '@deepseek-ai/dsh-session-projection'
import { TeamService } from '../app/node_modules/@deepseek-ai/dsh-experimental-agent-team/lib/index.js'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { initializeNativeHost } from './native-host-fixture.mjs'

// Real native journal, projection, mailbox and recovery; only persistence and
// subagent transport are local fixtures. No provider or model is started.
async function fixture(t) {
  const ctx = new Context(), agents = new Map(), disk = new Map(), injected = []
  let available = false
  t.after(() => ctx.fiber.dispose())
  return initializeNativeHost(ctx, async () => {
    class Agents extends Service { constructor(ctx) { super(ctx, 'agents') } list() { return [...agents.values()] } get(id) { return agents.get(id) } }
    class Sessions extends Service { constructor(ctx) { super(ctx, 'sessions') } async flush(session) { disk.set(session.id, session.snapshotEvents()) } }
    class Subagents extends Service {
      constructor(ctx) { super(ctx, 'subagents') }
      async [Symbol.for('dsh.subagent.deliverPrompt')](parent, id, content, source) {
        if (!available) throw new Error('fixture target unavailable')
        injected.push({ id, messageId: source.messageId })
        agents.get(id).session.append('agent/inbox/spliced', { target: 'next-step', start: 0, removedCount: 0,
          inserted: [createUserMessage({ content, source })] })
      }
      async drainContinuableChildren() {}
    }
    new Agents(ctx); new Sessions(ctx); new Subagents(ctx); new SessionProjectionRegistry(ctx)
    const service = new TeamService(ctx)
    const root = { id: 'native-recovery-root', session: Session.create('native-recovery-root'), options: {} }
    const child = { id: 'original-target', session: Session.create('original-target'), options: {} }
    const member = { id: child.id, name: 'worker', description: 'fixture', provider: 'fixture', context: 'fresh' }
    root.session.append('team/member', { version: 2, teamId: root.id, member: { ...member, phase: 'provisioning' } })
    root.session.append('team/member', { version: 2, teamId: root.id, member: { ...member, phase: 'active' } })
    agents.set(root.id, root); agents.set(child.id, child)
    return { ctx, service, root, child, disk, injected, member, available: () => { available = true } }
  })
}

test('native queued mail reloads and recovers with original identity once, without a new mailbox item', async t => {
  const f = await fixture(t)
  const receipt = await f.service.sendMessage(f.root, { target: 'worker', content: [{ type: 'text', text: 'private payload' }], signal: new AbortController().signal })
  assert.equal(receipt.status, 'queued')
  const persisted = f.disk.get(f.root.id)
  f.root.session = Session.create(f.root.id, persisted)
  f.available()
  await f.service.recoverFor(f.root)
  await f.service.recoverFor(f.root)
  assert.deepEqual(f.injected, [{ id: f.child.id, messageId: receipt.messageId }])
  assert.equal(f.root.session.snapshotEvents().filter(event => event.type === 'team/message/queued').length, 1)
  assert.equal(f.root.session.snapshotEvents().filter(event => event.type === 'team/message/delivered').length, 1)
})

test('native immutable roster refuses same-name replacement rather than redirecting pending mail', async t => {
  const f = await fixture(t)
  f.root.session.append('team/member', { version: 2, teamId: f.root.id, member: { ...f.member, id: 'replacement-session', phase: 'provisioning' } })
  assert.throws(() => f.service.listMembers(f.root), /reused by another member/)
  assert.equal(f.injected.length, 0)
})
