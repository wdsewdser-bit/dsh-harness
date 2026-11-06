import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { applyTeamProfile as apply } from '../../profiles/index.mjs';
function fixture() {
 const root = fs.mkdtempSync(path.join(os.tmpdir(), 'profile-routing-'));
 const sessions = new Map(), listeners = new Map();
 const ctx = { listeners, goals: { registerCompletionGuard: () => () => {} }, tools: { register() {} },
   sessions: { get: id => sessions.get(id), async create(id) { const session={id,seq:0,snapshotEvents:()=>[]};sessions.set(id,session);return session; } },
     llm: { isAgentLoopRequest: () => true },
   get(name) { return this[name]; }, provide(name, value) { this[name] = value; }, on(name,fn) {const set=listeners.get(name)??new Set();set.add(fn);
     listeners.set(name,set);return ()=>set.delete(fn);}, async emit(name,...args) {for(const fn of [...(listeners.get(name)??[])])await fn(...args);},
   agents: { async create() { const session = { id: 'session:worker', snapshotEvents: () => [], seq: 0 }; sessions.set(session.id, session);
     return { agent: { session, ctx: { tools: { register() {}, restrict() {}, guard() {} } }, wakeDriver() {} }, dispose: async () => {} }; } } };
 apply(ctx, { root, lifecycleIntervalMs: 10 });
 return { ctx, root, async close() { await ctx.teamRuntime.ready; await ctx.teamRuntime.stop(); fs.rmSync(root, { recursive: true, force: true }); } };
}
test('profile-only public member request dispatches once and isolates identical session ids across profiles', async () => {
 const a = fixture(), b = fixture();
 try {
  await Promise.all([a.ctx.teamRuntime.ready, b.ctx.teamRuntime.ready]);
  const A = a.ctx.teamRuntime, B = b.ctx.teamRuntime;
  for (const runtime of [A, B]) runtime.host.command({ teamId: runtime.host.teamId, actor: 'root', requestId: 'request:member',
   operationId: 'v1:operation:profile-member-0001', payload: { command: 'team.member.request', entityId: 'member-intent:worker', role: 'worker' } });
  for (let i = 0; i < 100 && [A, B].some(r => r.store.read('member-intent:worker')?.status !== 'confirmed'); i++) await new Promise(resolve => setTimeout(
    resolve, 10));
  for (const runtime of [A, B]) {
   assert.equal(runtime.store.read('member-intent:worker').status, 'confirmed');
   assert.equal(runtime.store.read('member:worker').generation, 2);
   assert.equal(runtime.router.routeExecution('session:worker').teamId, runtime.host.teamId);
   assert.equal(runtime.store.effects().filter(e => e.id === 'lifecycle:member-intent:worker').length, 1);
   assert.equal(runtime.router.routeExecution('not-team').routed, false);
  }
  assert.notEqual(A.host.teamId, B.host.teamId);
  await a.ctx.emit('session/disposed',a.ctx.sessions.get('session:worker'));
  assert.equal(A.host.state, 'running'); assert.equal(B.router.routeExecution('session:worker').routed, true);
 } finally { await a.close(); await b.close(); }
});
