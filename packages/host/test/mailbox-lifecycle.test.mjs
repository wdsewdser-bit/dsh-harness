import test from 'node:test';
import assert from 'node:assert/strict';
import { profile, until } from '../test-support/profile.mjs';

/**
 * F2 ruling A: a mailbox task is a wake, not work.
 *
 * The product creates `task:mail-member:<id>` when an idle member has an invisible non-info message, and the attempt
 * that task opens used to live until the lease expired or the team was torn down: the member could not take any work
 * task for the next three minutes, and a second round of work was impossible. The ruling is that the attempt is
 * released when the turn it woke ends, and that it never occupies a work slot. These cases pin both halves, plus the
 * two edges the ruling names: a message that stays unread asks for a new wake by the ordinary drain rule, and a
 * release during a completion freeze is not refused by the fence.
 */
function world() {
  const control = { wakes: [] };
  let counter = 0;
  return profile({}, async ({ root, ctx, sessions }) => {
    ctx.agents.create = async opts => {
      const sessionId = opts?.sessionId ?? 'session:agent-' + (++counter);
      const agent = {
        session: { id: sessionId, seq: 0, snapshotEvents: () => [] },
        phase: { kind: 'idle' },
        wakeDriver() { control.wakes.push(sessionId); agent.phase = { kind: 'running' }; },
        preemptStep() { return false; },
        cancel() {}, async whenIdle() {},
        ctx: { tools: { register() {}, restrict() {}, guard() {} } },
      };
      sessions.set(sessionId, agent.session);
      return { agent, dispose: async () => {} };
    };
  }).then(w => Object.assign(w, { control }));
}
const send = (w, to, summary) => w.runtime.host.executeAuthorized('business', () => w.runtime.core.send('member:root', to,
  'action', summary, { expectedOutcome: 'a report', deadline: new Date(Date.now() + 600000).toISOString() }).result.entityId);
const requestMember = async (w, id, role = 'worker') => {
  w.runtime.host.command({ teamId: w.runtime.host.teamId, actor: 'root', requestId: 'member-intent:' + id,
    operationId: 'v1:operation:' + id.padEnd(20, 'x'), payload: { command: 'team.member.request', entityId: 'member-intent:' + id, role } });
  await until(() => w.runtime.store.read('member-intent:' + id)?.status === 'confirmed');
  await until(() => w.runtime.handles.has('member:' + id));
};
const mailboxAttempts = w => w.runtime.store.list('attempt:').filter(row => String(row.taskId).startsWith('task:mail-'));
const endTurn = async (w, memberId) => {
  const agent = w.runtime.handles.get('member:' + memberId).agent;
  agent.phase = { kind: 'idle' };
  // Review 3 #2: the release is bound to a turn this host saw the wake open, so the fixture emits what the journal
  // really produces - the turn's start, then that turn's end - instead of a lone end that names nothing.
  await w.ctx.emit('session/event', agent.session, { type: 'turn/start' });
  await w.ctx.emit('session/event', agent.session, { type: 'turn/end' });
};

test('a mailbox attempt is released when the turn it woke ends, and its lease is never renewed', async () => {
  const w = await world();
  try {
    await requestMember(w, 'w');
    send(w, 'member:w', 'a message that arrives before any execution');
    await until(() => mailboxAttempts(w).some(row => row.status === 'running'));
    const attempt = mailboxAttempts(w).find(row => row.status === 'running');
    assert.equal(w.runtime.store.read(attempt.taskId).status, 'executing');
    await endTurn(w, 'w');
    await until(() => w.runtime.store.read(attempt.entityId).lease === 'released');
    const released = w.runtime.store.read(attempt.entityId);
    assert.equal(released.status, 'cancelled');
    assert.equal(released.reason, 'mailbox wake ended with its turn');
    assert.equal(w.runtime.store.read(attempt.taskId).status, 'cancelled', 'the wake task is closed with it');
    // No renewal: several cycles and the same lease, the same expiry, the same status.
    for (let i = 0; i < 5; i += 1) await w.runtime.host.cycle.run();
    assert.deepEqual(w.runtime.store.read(attempt.entityId), released, 'a released wake lease is not renewed');
    assert.deepEqual(w.runtime.mailboxReleases, [], 'the release went through the product path, not a refusal');
  } finally { await w.close(); }
});

test('a message that is still unread asks for a new mailbox task after the release', async () => {
  const w = await world();
  try {
    await requestMember(w, 'w');
    send(w, 'member:w', 'first wake');
    await until(() => mailboxAttempts(w).some(row => row.status === 'running'));
    const first = mailboxAttempts(w).find(row => row.status === 'running');
    await endTurn(w, 'w');
    await until(() => w.runtime.store.read(first.entityId).lease === 'released');
    send(w, 'member:w', 'second wake');
    await until(() => mailboxAttempts(w).some(row => row.status === 'running' && row.entityId !== first.entityId));
    const second = mailboxAttempts(w).find(row => row.status === 'running' && row.entityId !== first.entityId);
    assert.equal(w.runtime.store.read(first.entityId).lease, 'released', 'the old wake stays closed');
    const bindings = w.runtime.store.read('task:mail-member:w').mailboxMessages.map(JSON.parse);
    assert.equal(bindings.length >= 2, true, 'the new wake carries the message it exists for');
    assert.equal(second.taskId, 'task:mail-member:w');
  } finally { await w.close(); }
});

test('a member woken by mail can take its work task: the wake is released and never answers CAPACITY', async () => {
  const w = await world();
  try {
    await requestMember(w, 'w');
    send(w, 'member:w', 'wake before the work exists');
    await until(() => mailboxAttempts(w).some(row => row.status === 'running'));
    const wake = mailboxAttempts(w).find(row => row.status === 'running');
    w.runtime.host.command({ teamId: w.runtime.host.teamId, actor: 'root', requestId: 'task:work',
      operationId: 'v1:operation:task-work'.padEnd(20, 'x'),
      payload: { command: 'team.task.request', entityId: 'task:work', owner: 'member:w' } });
    await until(() => w.runtime.store.list('attempt:').some(row => row.taskId === 'task:work' && row.lease === 'active'));
    const work = w.runtime.store.list('attempt:').find(row => row.taskId === 'task:work');
    assert.equal(work.owner, 'member:w');
    assert.equal(w.runtime.store.read(wake.entityId).lease, 'released',
      'the wake gave up its lease to the work task instead of blocking it');
    assert.equal(w.runtime.store.read('task:work').status, 'executing');
  } finally { await w.close(); }
});

test('releasing a mailbox attempt during a completion freeze is not refused by the fence', async () => {
  const w = await world();
  try {
    await requestMember(w, 'w');
    send(w, 'member:w', 'wake into a frozen team');
    await until(() => mailboxAttempts(w).some(row => row.status === 'running'));
    const attempt = mailboxAttempts(w).find(row => row.status === 'running');
    w.runtime.host.executeAuthorized('business', () => w.runtime.core.mutate('completion:test', 'root', {},
      tx => tx.put('completion:test', { status: 'prepared' })));
    // The freeze is real for ordinary writes ...
    assert.throws(() => w.runtime.host.coreAccess.lifecycle().mutate('task:any', 'root', {}, (tx, current) => current),
      error => error.code === 'COMPLETION_FROZEN');
    await endTurn(w, 'w');
    await until(() => w.runtime.store.read(attempt.entityId).lease === 'released');
    assert.equal(w.runtime.store.read(attempt.entityId).status, 'cancelled');
    assert.deepEqual(w.runtime.mailboxReleases, [], 'the frozen-period release is a safe command, not a refusal');
  } finally { await w.close(); }
});

test('review 2 #3: the work takeover leaves no unknown or applying effect behind', async () => {
  const w = await world();
  try {
    await requestMember(w, 'w');
    send(w, 'member:w', 'wake before the work exists');
    await until(() => mailboxAttempts(w).some(row => row.status === 'running'));
    const wake = mailboxAttempts(w).find(row => row.status === 'running');
    w.runtime.host.command({ teamId: w.runtime.host.teamId, actor: 'root', requestId: 'task:work',
      operationId: 'v1:operation:' + 'task-work'.padEnd(20, 'x'),
      payload: { command: 'team.task.request', entityId: 'task:work', owner: 'member:w' } });
    await until(() => w.runtime.store.list('attempt:').some(row => row.taskId === 'task:work' && row.lease === 'active'));
    const effects = w.runtime.store.effects();
    assert.deepEqual(effects.filter(row => row.status === 'unknown'), [],
      'the hand-over did not leave an unproven effect: a released attempt cannot run its start or dispatch');
    assert.deepEqual(effects.filter(row => row.status === 'applying'), []);
    const start = effects.find(row => row.id === wake.entityId);
    assert.ok(start, 'the wake had a start effect of its own');
    assert.notEqual(start.status, 'unknown');
    assert.deepEqual(w.runtime.mailboxReleases, [], 'the release went through the product path, not a refusal');
  } finally { await w.close(); }
});

