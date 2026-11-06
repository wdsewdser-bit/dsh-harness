import test from 'node:test';
import { registerHostVisibility } from '../../profiles/index.mjs';
import { visibilityDirty } from '../src/visibility/dirty.mjs';
import assert from 'node:assert/strict';
import { real } from '../test-support/real.mjs';
import { createVisibility } from '../index.mjs';
import { summariseDispatchMessages } from '../../contracts/index.mjs';

/**
 * §22.8: a visibility instance holds two per-dispatch bindings - the attempt (prepared/send-started watermarks) and the
 * confirmed receipt (the few journal events flush needs) - until something releases them. The offline soak's 30-minute
 * heap plateau is what exposed them: the map that never shrank was small per entry but unbounded per dispatch, and every
 * commit additionally cloned the whole session journal into the binding. These tests pin the release rules, not the
 * implementation: they read status().retained and the evidence the flush still produces.
 */

export async function world(options = {}) {
 const w = await real({ teamId: 'team:b' }); w.core.configuration.teamId = 'team:b';
 w.core.member('member:a', 'worker'); w.core.member('member:b', 'worker');
 const session = { seq: 10, events: [], snapshotEvents() { return this.events; } };
 const v = createVisibility({ host: w.host, core: w.core, sessions: new Map([['session:b', session]]),
  routeExecution: id => ({ routed: id === 'session:b', teamId: 'team:b', memberId: 'member:b', generation: 1 }),
  isMain: o => o.main && o.purpose === undefined, leaseMs: 100000, ...(options.queue ? { queue: options.queue } : {}) });
 // One unread message at a time, so the snapshot each round binds is this round's message and not a leftover.
 let pending = null;
 // One round is what the driver does per main request: prepare, bind the candidate, dispatch the three phases, release.
 const round = async n => {
  if (pending) w.core.mutate(pending, 'operator', {}, (tx, row) => tx.put(pending, { ...row, status: 'resolved' }));
  // The message the request will carry: visibility writes its observation onto the real entity.
  pending = w.core.send('member:a', 'member:b', 'info', 'round ' + n).result.entityId;
  const message = await v.preStep('session:b', pending);
  const base = { contract: 'team-dispatch/2', attempt: 'dispatch:' + n, sessionId: 'session:b', kind: 'main', purpose: null,
   messages: summariseDispatchMessages([message]) };
  const emit = (phase, extra = {}) => v.dispatch({ ...base, phase, at: w.at,
   ...(['send-started', 'committed'].includes(phase) ? { transmission: 1, sendStartedAt: w.at } : {}), ...extra }, 'real-cpa-transport');
  const release = v.candidate({ sessionId: 'session:b', main: true, messages: [message] });
  const carried = { type: 'user/message', seq: 100 + n, data: { id: message.id, content: message.content } };
  return { id: message.id, message, base, emit, release, carried };
 };
 return { ...w, session, v, round, seen(id) { return Boolean(w.store.read(id)?.visible); } };
}

