import fs from 'node:fs';
import { commandTests } from './p4-commands.mjs';
import {retentionTest} from './p4-retention-test.mjs';
import { testCertificateBinding } from './p4-certificate-binding.mjs';
testCertificateBinding();
import { GoalGate } from '../../packages/core/index.mjs';
import { refreshContext } from '../../packages/profiles/context-reader.mjs';
import { ArtifactStore } from '../../packages/context/index.mjs';
import { recordPolicy } from '../../packages/context/plugin.mjs';
import { id } from '../../packages/contracts/index.mjs';
import { webTest } from './p4-web.mjs';
import { bootProfile } from '../../packages/profiles/index.mjs';
import assert from 'node:assert/strict';
import { ControlStore } from '../../packages/store/index.mjs';
import { TeamCore } from '../../packages/core/index.mjs';
import { Projection } from '../../packages/projections/index.mjs';
import { serve } from '../../packages/projections/http.mjs';
import { submit } from '../../packages/projections/commands.mjs';
import { createRealSource } from '../../packages/ui/src/real-source.mjs';
import { applyEvent, ProjectionClient } from '../../packages/ui/src/projection.mjs';
const root = process.argv[2];
assert(root && !fs.existsSync(root)); fs.mkdirSync(root, { recursive: true });
await commandTests(root + '/commands');
const store = new ControlStore(root); const core = new TeamCore(store, {}, { enabled: true });
core.member('member:root', 'root'); core.member('member:a', 'worker'); core.member('member:b', 'worker');
core.task('task:a', 'member:a'); core.task('task:b', 'member:b');
const projection = new Projection({ events: seq => store.events(seq) });
const sessions = new Map([['root-test', 'member:root'], ['a-test', 'member:a']]);
const server = await serve(projection, (actor, command) => submit(core, actor, command), { sessions, heartbeatMs: 50 });
const real = createRealSource({ token: 'root-test' });
let stop; let client;
try {
  assert.equal(projection.snapshot('member:root').data.goal.status, 'unknown');
  assert.equal(projection.snapshot('member:root').data.goal.gate.status, 'unknown');
  core.mutate('task:a', 'root', {}, (tx, t) => tx.put('task:a', { ...t, approved: false, status: 'draft', scopeSet: ['test-scope'] }));
  assert.deepEqual(projection.snapshot('member:root').data.approvals[0].diff, ['test-scope']);
  assert.equal(projection.snapshot('member:root').data.approvals[0].status, 'unknown');
  core.mutate('task:a', 'root', {}, (tx, t) => tx.put('task:a', { ...t, scopeApproval: { status: 'requested', requestedAt: 123 } }));
  assert.equal(projection.snapshot('member:root').data.approvals[0].status, 'requested');
  assert.equal(projection.snapshot('member:a').data.approvals.length, 1);
  const gate = new GoalGate(core);
  gate.inspect({ id: 'native-test' }, { type: 'goal/change', seq: 1, data: { goal: { id: 'goal:test', revision: 1, objective: 'Committed goal',
          phase: 'active' } } });
  assert.equal(gate.check({ sessionId: 'native-test', goal: { id: 'goal:test', revision: 1 } }), false);
  const first = await real.source.snapshot('team');
  assert.equal(first.viewer, 'member:root'); assert.equal(first.data.goal.native.phase, 'active'); assert.equal(first.data.goal.gate.status, 'blocked');
  assert(first.data.members.every(m => m.context === null && m.contextStatus.status === 'unknown'));
  const abort = new AbortController();
  const quiet = await fetch('http://127.0.0.1:40292/team/projection/stream?afterSeq=' + first.asOfSeq, { headers: { authorization: 'Bearer root-test' },
      signal: abort.signal });
  const reader = quiet.body.getReader(); let frame = new TextDecoder().decode((await reader.read()).value);
  assert(frame.includes(': connected')); const quietSeq = projection.seq;
  while (!frame.includes(': heartbeat')) frame += new TextDecoder().decode((await reader.read()).value);
  assert.equal(projection.seq, quietSeq); assert(!frame.includes('id:')); abort.abort();
  core.mutate('member:a', 'root', {}, (tx, m) => tx.put('member:a', { ...m, nativeRef: 'context-session' }));
  const artifacts = new ArtifactStore(root + '/context');
  recordPolicy(artifacts, 'context-session', { logRevision: 1, wire: { I: 375, W: 1000 } }, { W: 1000, R: 100, M: 10 }, 375);
  refreshContext(core, root + '/context/context.sqlite');
  const contextSeq = store.events().at(-1).seq;
  refreshContext(core, root + '/context/context.sqlite');
  assert.equal(store.events().at(-1).seq, contextSeq, 'unchanged committed sample must not generate events');
  artifacts.close();
  assert.equal(projection.snapshot('member:root').data.members.find(m => m.id === 'member:a').context?.pct, 50);
  assert.equal(first.data.members.length, 3); assert.equal(first.data.tasks[0].revision, store.read('task:a').revision);
  const worker = await createRealSource({ token: 'a-test' }).source.snapshot('team');
  assert.deepEqual(worker.data.members.map(m => m.id), ['member:a']); assert.deepEqual(worker.data.tasks.map(m => m.id), ['task:a']);
  assert(!JSON.stringify(worker).includes('task:b'));
  const seen = []; let wake;
  stop = real.source.subscribe(first.asOfSeq, event => { seen.push(event); wake?.(); }, () => {});
  const command = { name: 'organization.requestFreeze', target: 'member:a', expectedRevision: store.read('member:a').revision, args: {} };
  assert.equal((await real.gateway.submit(command)).status, 'accepted');
  const freezing = await real.source.snapshot('team');
  assert.equal(freezing.data.members.find(m => m.id === 'member:a').desired, 'frozen');
  assert.notEqual(freezing.data.members.find(m => m.id === 'member:a').observed, 'frozen');
  core.mutate('member:a', 'root', {}, (tx, m) => tx.put('member:a', { ...m, name: 'changed' }));
  assert.equal((await real.gateway.submit(command)).status, 'conflict');
  assert.equal((await createRealSource({ token: 'a-test' }).gateway.submit({ ...command, target: 'member:b' })).status, 'rejected');
  for (let i = 0; i < 5; i++) core.send('member:root', 'member:a', 'info', 'real event ' + i);
  const expected = projection.snapshot('member:root');
  while (seen.at(-1)?.seq !== expected.asOfSeq) await new Promise((resolve, reject) => { const t = setTimeout(() => reject(Error('SSE_TIMEOUT')), 3000);
      wake = () => { clearTimeout(t); resolve(); }; });
  stop();
  let data = first.data; for (const event of seen) data = applyEvent(data, event);
  for (const key of ['members', 'tasks', 'threads', 'messages', 'unknownEffects', 'approvals']) assert.deepEqual(data[key], expected.data[key]);
  assert.deepEqual(seen.map(e => e.seq), Array.from({ length: expected.asOfSeq - first.asOfSeq }, (_, i) => first.asOfSeq + i + 1));
  const cursor = seen.at(-1).seq;
  core.send('member:root', 'member:a', 'info', 'offline gap');
  const replay = []; stop = real.source.subscribe(cursor, e => { replay.push(e); wake?.(); }, () => {});
  while (replay.length === 0) await new Promise(resolve => { wake = resolve; });
  stop(); assert.equal(replay[0].seq, cursor + 1);
  core.mutate('artifact:decision', 'root', {}, tx => tx.put('artifact:decision', { acl: ['member:root'] }));
  const thread = core.thread('member:root', [], 'approve decision', new Date(Date.now() + 60000).toISOString()).result;
  const decision = { name: 'threads.decide', target: thread.entityId, expectedRevision: thread.revision, args: { proposalRevision: 1,
      conclusionRef: 'artifact:decision' } };
  assert.equal((await real.gateway.submit(decision)).status, 'accepted');
  assert.equal((await real.gateway.submit(decision)).status, 'conflict');
  assert.equal((await real.gateway.submit({ name: 'mailbox.send', target: 'member:a', expectedRevision: store.read('member:a').revision, args: {
            recipient: 'member:a', kind: 'info', body: 'operator mailbox message' } })).status, 'accepted');
  core.mutate('task:b', 'root', {}, (tx, row) => tx.put('task:b', { ...row, acl: ['member:a'] }));
  const workerSource = createRealSource({ token: 'a-test' }).source;
  const granted = await workerSource.snapshot('team'); assert(granted.data.tasks.some(t => t.id === 'task:b'));
  const revokeEvents = []; stop = workerSource.subscribe(granted.asOfSeq, e => { revokeEvents.push(e); wake?.(); }, () => {});
  await new Promise(resolve => setTimeout(resolve, 60));
  core.mutate('task:b', 'root', {}, (tx, row) => tx.put('task:b', { ...row, acl: [] }));
  const until = Date.now() + 3000;
  while (!revokeEvents.some(e => e.removes.tasks.includes('task:b'))) {
    assert(Date.now() < until, 'ACL revoke must remove cached row');
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  stop();
  assert(!revokeEvents.some(e => e.upserts.tasks.some(t => t.id === 'task:b')));
  const op = id('operation');
  const send = { name: 'mailbox.send', operationId: op, target: 'member:a', expectedRevision: store.read('member:a').revision, args: { recipient: 'member:a',
      kind: 'info', summary: 'identity' } };
  const a = submit(core, 'member:root', send), b = submit(core, 'member:root', send);
  assert.equal(a.status, 'accepted'); assert.deepEqual(a, b);
  const message = store.list('message:').find(m => m.summary === 'identity'); assert(message && !message.entityId.includes('operation')); assert.notEqual(
  message
    .entityId, op);
  core.mutate('member:a', 'root', {}, (tx, m) => tx.put('member:a', { ...m, group: 'new-group' }));
  const last = projection.events('member:root', 0).at(-1), snap = projection.snapshot('member:root');
  assert.deepEqual(last.groups, snap.data.groups); assert.equal(last.restrictedMembers, snap.data.restrictedMembers); assert.deepEqual(last.sourceRevisions,
  snap
    .sourceRevisions); assert.equal(last.viewer, snap.viewer);
  assert.equal(projection.snapshot('member:a').viewer, 'member:a');
  const workerBefore = projection.snapshot('member:a'); core.member('member:c', 'worker', 'hidden-group');
  const workerDelta = projection.events('member:a', workerBefore.asOfSeq).at(-1);
  assert.equal(workerDelta.restrictedMembers, workerBefore.data.restrictedMembers + 1);
  assert(!JSON.stringify(workerDelta).includes('member:c')); assert(!JSON.stringify(workerDelta).includes('hidden-group'));
  retentionTest(core);
  const coldProjection = new Projection({ events: seq => store.events(seq) });
  assert.deepEqual(coldProjection.snapshot('member:root'), projection.snapshot('member:root'));
  const hidden = projection.events('member:a', store.events().at(-1).seq);
  assert(!JSON.stringify(hidden).includes('task:b'));
  client = new ProjectionClient(real.source); await client.start(); assert.equal(client.state.status, 'ready'); client.stop();
  await server.close();
  const web = await webTest(root + '/web');
  const manualRoot = root + '/keepalive-smoke';
  const stopper = setInterval(() => { if (fs.existsSync(manualRoot + '/keep-alive.json')) { fs.writeFileSync(manualRoot + '/STOP', 'test clean stop');
        clearInterval(stopper); } }, 100);
  try { await webTest(manualRoot, { keepAlive: true }); } finally { clearInterval(stopper); }
  const defaultWeb = await webTest(root + '/web-default', { team: false, port: 40293 });
  const plain = await bootProfile(root + '/default', { team: false });
  assert(!plain.ctx.teamProjections && !plain.ctx.teamRuntime);
  assert(!plain.actual.some(name => /projections-plugin|ui/.test(name)));
  await plain.ctx.fiber.dispose();
  const report = { web, defaultWeb, defaultInert: true, status: 'passed', metadataDelta: true, immediateSSE: true, heartbeat: true, authoritativeGoal: true,
    committedContext: true, scopeApprovals: true, viewer: true, independentMessageId: true, ownerSessionBound: true, officialClientEntry: true,
    keepAliveCleanStop: true, contiguous: true, replay: true, acl: true, authorizedCommands: true, latencyMs: projection.latency };
  fs.writeFileSync(root + '/report.json', JSON.stringify(report, null, 2)); console.log('p4-projections: PASS ' + JSON.stringify(report));
   if (process.argv.includes('--keep-alive')) await webTest(root + '/manual-web', { keepAlive: true });
} finally { stop?.(); client?.stop(); await server.close(); store.close(); }
