// Review 2 #2 (the turn) and review 1 #4 / review 2 #3 (the revision race) of the mailbox hand-over.
//
// Two orderings the product really creates:
//
//   1. A wake is prepared while the turn of the attempt it replaces is still ending. The old turn/end used to close the
//      NEW wake (the release was recorded and replayed on the new start's receipt), the new dispatch was cancelled, and
//      the message was already in the mailbox task's dedup set - a message nothing would wake for again.
//   2. The wake's start effect is registered against the attempt row, and the hand-over releases that attempt before the
//      close-out runs. The revision the registration froze necessarily moved, so the strict check answered
//      STALE_EFFECT_SUBJECT and left the start applying.
//
// Both are driven through the real path here: the profile's own turn listener, and core-access registerEffect() with the
// revisions it really stored.
import test from 'node:test';
import assert from 'node:assert/strict';
import { profile, until } from '../test-support/profile.mjs';
import { real } from '../test-support/real.mjs';
import { drain } from '../../core/index.mjs';
import { certificate } from '../test-support/execution.mjs';


export function world(options = {}) {
  const control = { wakes: [] };
  let counter = 0;
  return profile({ simulateRequests: true, ...options }, async ({ root, ctx, sessions }) => {
    ctx.agents.create = async opts => {
      const sessionId = opts?.sessionId ?? 'session:agent-' + (++counter);
      const agent = { session: { id: sessionId, seq: 0, snapshotEvents: () => [] }, phase: { kind: 'idle' },
        wakeDriver() { control.wakes.push(sessionId); agent.phase = { kind: 'running' }; }, preemptStep() { return false; },
        cancel() {}, async whenIdle() {}, ctx: { tools: { register() {}, restrict() {}, guard() {} } } };
      sessions.set(sessionId, agent.session);
      return { agent, dispose: async () => {} };
    };
  }).then(w => {
    // These agents have no external IO at all. Explicit test coverage, never a production capability fallback.
    const original=w.runtime.bindAgent;
    w.runtime.bindAgent=(...args)=>{
      const agent=original(...args),scope=w.runtime.executionScopes?.get(agent.session.id);
      if(scope){scope.coverage('transport',true);scope.coverage('subprocess',true);}
      return agent;
    };
    return Object.assign(w,{control});
  });
}
export const send = (w, to, summary) => w.runtime.host.executeAuthorized('business', () => w.runtime.core.send('member:root', to,
  'action', summary, { expectedOutcome: 'a report', deadline: new Date(Date.now() + 600000).toISOString() }).result.entityId);
export const requestMember = async (w, id, role = 'worker') => {
  w.runtime.host.command({ teamId: w.runtime.host.teamId, actor: 'root', requestId: 'member-intent:' + id,
    operationId: 'v1:operation:' + id.padEnd(20, 'x'), payload: { command: 'team.member.request', entityId: 'member-intent:' + id, role } });
  await until(() => w.runtime.store.read('member-intent:' + id)?.status === 'confirmed');
  await until(() => w.runtime.handles.has('member:' + id));
};
export const mailboxAttempts = w => w.runtime.store.list('attempt:').filter(row => String(row.taskId).startsWith('task:mail-'));
export const emit = (w, memberId, event) => w.ctx.emit('session/event', w.runtime.handles.get('member:' + memberId).agent.session, event);

