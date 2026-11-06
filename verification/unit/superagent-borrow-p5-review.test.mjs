// P5 (§3.2, §5, §6, §9, §10 P5): the v1 projection surface, SSE deltas, retention and command authorization.
//
// Every case runs offline against the real control store and the real shared reducers. The projection is built the way
// the composition root builds it (a read-only event reader plus the protocol/capacity facts), and commands go through
// the same UI gateway the browser uses. No provider, no host turn and no second turn driver are involved.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { ControlStore } from '../../packages/store/index.mjs';
import { TeamCore, batchCandidate, recordBatchInjection } from '../../packages/core/index.mjs';
import { Projection } from '../../packages/projections/index.mjs';
import { submit } from '../../packages/projections/commands.mjs';
import { retain } from '../../packages/projections/retention.mjs';
import { serve } from '../../packages/projections/http.mjs';
import { capacityStatusSchema, inputBatchSchema, resourceThreadSchema, roleGuardStatusSchema } from '../../packages/projections/schema.mjs';
import { REPOSITORIES, future, team, projection, openResource, subscribe, publish, legacyThread } from './superagent-borrow-p5-support.mjs';

test('T03 performance: one operationId allocates one sequence and one delivery per subscriber', () => {
  const t = team('retry');
  try {
    const ref = openResource(t, 'member:fe', { kind: 'branch', repositoryKey: 'repo:acme/app', key: 'refs/heads/main' });
    subscribe(t, 'member:fe', ref); subscribe(t, 'member:be', ref);
    const command = { name: 'threads.publish', target: ref, expectedRevision: t.store.read(ref).revision,
      operationId: t.op('retry-publish'), args: { eventType: 'change-reported', summary: 'one report', bodyRef: '' } };
    const first = submit(t.core, 'member:fe', command);
    const replay = submit(t.core, 'member:fe', command);
    assert.equal(first.status, 'accepted');
    assert.equal(replay.status, 'accepted', JSON.stringify(replay));
    assert.equal(t.store.list('thread-event:' + ref + ':').length, 1, 'a replay does not burn a second sequence');
    assert.equal(t.store.list('thread-delivery:' + ref + ':').length, 2, 'one delivery per subscriber');
    assert.equal(t.store.effects().filter(effect => effect.payload.kind === 'wake' && effect.payload.threadRef === ref).length, 2);
    assert.equal(t.store.list('attempt:').length, 0);
    assert.equal(t.store.list('message:').length, 0);
  } finally { t.close(); }
});

test('P5 schema: the additive read contracts are frozen and name their required fields', () => {
  for (const schema of [resourceThreadSchema, capacityStatusSchema, roleGuardStatusSchema, inputBatchSchema]) {
    assert.equal(Object.isFrozen(schema), true);
    assert(Array.isArray(schema.required) && schema.required.length > 0);
  }
  assert.equal(capacityStatusSchema.required.includes('admissionClosed'), true);
  // Gap 3: the read contract publishes the provider classification and the wait it explains, never a bare 'unknown'.
  assert.deepEqual(capacityStatusSchema.properties.providerCapacity.enum, ['unknown', 'available', 'throttled']);
  assert.deepEqual(capacityStatusSchema.properties.providerWait.enum, ['none', 'local-queued', 'provider-throttled']);
  assert.equal(capacityStatusSchema.required.includes('providerWait'), true);
  assert.equal(roleGuardStatusSchema.properties.coordinatorOnly.const, true);
});

test('P5 review: resource creation CAS, reference ACL, freeze and replay fail closed without half writes', () => {
  const t = team('review-entry');
  try {
    const target = 'thread:' + t.op('new');
    const create = { name: 'threads.openResource', target, expectedRevision: 2,
      operationId: t.op('create'), args: { resource: { kind: 'branch', repositoryKey: 'repo:acme/app', key: 'refs/heads/review' },
        descriptionRef: 'doc:external' } };
    const seq = t.store.latestEventSeq();
    assert.equal(submit(t.core, 'member:fe', create).status, 'conflict');
    assert.equal(t.store.latestEventSeq(), seq);
    create.expectedRevision = 0;
    const first = submit(t.core, 'member:fe', create);
    assert.equal(first.status, 'accepted');
    subscribe(t, 'member:fe', target);
    t.core.mutate('artifact:private', 'adapter', {}, tx => tx.put('artifact:private', { owner: 'member:qa', body: 'private-body-sentinel' }));
    const pub = { name: 'threads.publish', target, expectedRevision: t.store.read(target).revision,
      operationId: t.op('private'), args: { eventType: 'report', summary: 'reference attempt', bodyRef: 'artifact:private' } };
    const before = t.store.latestEventSeq();
    assert.match(submit(t.core, 'member:fe', pub).message, /^REFERENCE_ACL/);
    assert.equal(t.store.latestEventSeq(), before);
    assert.equal(t.store.list('thread-event:' + target + ':').length, 0);
    assert.equal(submit(t.core, 'operator', pub).message, 'ROLE_DENIED');
    for (const role of ['viewer', 'scheduler', 'unknown']) {
      t.core.mutate('member:readonly', 'adapter', { role }, tx => tx.put('member:readonly', { role, desired: 'active' }));
      assert.equal(submit(t.core, 'member:readonly', { ...create, target: 'thread:' + t.op('denied-' + role), operationId: t.op(role) }).message,
        'ROLE_DENIED');
    }
    pub.args.bodyRef = 'artifact:missing';
    assert.match(submit(t.core, 'member:fe', pub).message, /^MISSING_REFERENCE/);
    delete pub.args.bodyRef;
    const execute = t.core.execute.bind(t.core);
    t.core.execute = (...args) => {
      t.core.execute = execute;
      t.core.mutate('member:fe', 'adapter', {}, tx => tx.put('member:fe', { ...tx.read('member:fe'), desired: 'frozen' }));
      return execute(...args);
    };
    const closed = submit(t.core, 'member:fe', { name: 'threads.closeResource', target, expectedRevision: t.store.read(target).revision, operationId: t
        .op('revoked-close'), args: { reason: 'done' } });
    assert.equal(closed.message, 'ROLE_DENIED', 'the writer role is checked again inside the commit');
    assert.equal(t.store.read(target).status, 'open');
    t.core.mutate('member:fe', 'adapter', {}, tx => tx.put('member:fe', { ...tx.read('member:fe'), desired: 'active' }));
    t.core.mutate('completion:review', 'adapter', {}, tx => tx.put('completion:review', { status: 'prepared' }));
    assert.equal(submit(t.core, 'member:fe', pub).message, 'COMPLETION_FROZEN');
    // The durable creation replay precedes both its now-stale creation CAS and the completion fence.
    assert.equal(submit(t.core, 'member:fe', create).status, 'accepted');
    assert.equal(t.store.list('thread:' ).length, 1);
    assert.equal(t.store.list('thread-event:' + target + ':').length, 0);
    t.core.configuration.superagentBorrow = 'off';
    assert.match(submit(t.core, 'member:fe', { ...create, target: 'thread:' + t.op('off-target'), operationId: t.op('off') }).message, /^COMPLETION_FROZEN/);
  } finally { t.close(); }
});

test('P5 review: historical replay uses current resource ACL and never exports body or private guard declarations', () => {
  const t = team('review-acl');
  try {
    const ref = openResource(t, 'member:fe', { kind: 'branch', repositoryKey: 'repo:acme/app', key: 'refs/heads/private' });
    subscribe(t, 'member:fe', ref); subscribe(t, 'member:be', ref);
    t.core.mutate('artifact:body', 'adapter', {}, tx => tx.put('artifact:body', { owner: 'member:fe', body: 'private-body-sentinel' }));
    publish(t, 'member:fe', ref, 'private-summary-sentinel', { bodyRef: 'artifact:body' });
    const proj = projection(t, { roleGuard: () => ({ declared: ['private-tool-sentinel'] }) });
    const before = t.store.latestEventSeq();
    const visible = JSON.stringify(proj.snapshot('member:be'));
    assert(visible.includes('private-summary-sentinel'));
    assert(!visible.includes('artifact:body') && !visible.includes('private-body-sentinel') && !visible.includes('private-tool-sentinel'));
    assert.equal(t.store.latestEventSeq(), before, 'snapshot must not write authority');
    t.core.mutate(ref, 'adapter', {}, tx => tx.put(ref, { ...tx.read(ref), acl: ['member:fe'] }));
    assert.deepEqual(proj.snapshot('member:be').data.resourceThreads, []);
    const replay = JSON.stringify(proj.events('member:be', 0));
    assert(!replay.includes(ref) && !replay.includes('private-summary-sentinel'), 'old ACL is not a replay capability');
    assert.equal(t.store.latestEventSeq(), before + 1, 'SSE replay also has no durable write side effect');
  } finally { t.close(); }
});

test('P5 review: audit-cited manifests/deliveries survive pressure, uncited history has a plateau', () => {
  const rows = new Map();
  const put = (id, row) => rows.set(id, { entityId: id, updatedAt: 1, ...row });
  put('thread:review', { kind: 'resource', retainedFrom: 10000 });
  put('thread-event:thread:review:000001', { threadRef: 'thread:review', seq: 1 });
  put('thread-delivery:review', { eventRef: 'thread-event:thread:review:000001', state: 'visible' });
  put('manifest:cited', { inputBindings: [{ kind: 'thread-delivery', bodyRef: 'thread-event:thread:review:000001' }] });
  put('audit:review', { evidenceRef: 'manifest:cited', subject: { id: 'thread-delivery:review' } });
  for (let n = 2; n < 300; n++) {
    put('thread-event:thread:review:' + String(n).padStart(6, '0'), { threadRef: 'thread:review', seq: n, updatedAt: n });
    put('manifest:rolling-' + n, { updatedAt: n });
    put('thread-publish:review:' + n, { eventRef: 'thread-event:thread:review:' + String(n).padStart(6, '0'), updatedAt: n });
    retain(rows, 3, { protocol: 'v1' });
  }
  assert(rows.has('manifest:cited'));
  assert(rows.has('thread-delivery:review'));
  assert(rows.has('thread-event:thread:review:000001'));
  assert(rows.size <= 8, 'only the index, cited evidence and recent uncited candidates survive');
  rows.delete('audit:review'); retain(rows, 0, { protocol: 'v1' }); retain(rows, 0, { protocol: 'v1' });
  assert.equal(rows.has('manifest:cited'), false);
  assert.equal(rows.has('thread-event:thread:review:000001'), false);
  put('thread-event:thread:review:000002', { threadRef: 'thread:review', seq: 2 });
  put('thread-delivery:unknown', { eventRef: 'thread-event:thread:review:000002', state: 'unknown' });
  retain(rows, 0, { protocol: 'v1' });
  assert(rows.has('thread-event:thread:review:000002'), 'unknown delivery keeps its body as well as its receipt');
  put('thread-event:thread:review:000003', { threadRef: 'thread:review', seq: 3 });
  put('decision:terminal', { state: 'decided', evidence: [{ ref: 'thread-event:thread:review:000003' }] });
  retain(rows, 0, { protocol: 'v1' }); retain(rows, 0, { protocol: 'v1' });
  assert(rows.has('decision:terminal'), 'the original citation list must not disappear behind a shorter audit');
  assert(rows.has('thread-event:thread:review:000003'), 'terminal decision evidence survives repeated trims');
});


test('P5 review HTTP/SSE: current ACL removal, viewer POST and forged actor never write', { timeout: 15000 }, async () => {
  const t = team('review-http'); let server, reader, pump; const abort = new AbortController();
  const frames = [];
  const waitFor = async predicate => {
    const end = Date.now() + 5000;
    while (!predicate()) { if (Date.now() > end) throw Error('SSE observation timeout'); await new Promise(resolve => setTimeout(resolve, 20)); }
  };
  try {
    const ref = openResource(t, 'member:fe', { kind: 'branch', repositoryKey: 'repo:acme/app', key: 'refs/heads/http' });
    subscribe(t, 'member:fe', ref); subscribe(t, 'member:be', ref);
    publish(t, 'member:fe', ref, 'authorized-http-summary');
    const proj = projection(t), sessions = new Map([['member', 'member:be'], ['viewer', 'viewer']]);
    for (let port = 40290; port <= 40299; port++) {
      try { server = await serve(proj, (actor, command) => submit(t.core, actor, command), { port, sessions }); break; }
      catch (error) { if (error.code !== 'EADDRINUSE') throw error; }
    }
    assert(server);
    const base = 'http://127.0.0.1:' + server.server.address().port;
    const seq = t.store.latestEventSeq();
    const stream = await fetch(base + '/team/projection/stream?afterSeq=' + seq, { headers: { authorization: 'Bearer member' }, signal: abort.signal });
    assert.equal(stream.status, 200);
    reader = stream.body.getReader();
    pump = (async () => {
      const decoder = new TextDecoder(); let buffer = '';
      while (true) {
        const { done, value } = await reader.read(); if (done) return;
        buffer += decoder.decode(value, { stream: true });
        let end;
        while ((end = buffer.indexOf('\n\n')) >= 0) {
          const frame = buffer.slice(0, end); buffer = buffer.slice(end + 2);
          const data = frame.split('\n').find(line => line.startsWith('data: '));
          if (data) frames.push(JSON.parse(data.slice(6)));
        }
      }
    })().catch(error => { if (!abort.signal.aborted) throw error; });
    const forged = await (await fetch(base + '/team/commands', { method: 'POST', headers: { authorization: 'Bearer viewer', 'content-type':
      'application/json' },
      body: JSON.stringify({ name: 'threads.publish', actor: 'member:root', target: ref, expectedRevision: t.store.read(ref).revision,
        operationId: t.op('viewer-post'), args: { eventType: 'report', summary: 'forged' } }) })).json();
    assert.equal(forged.status, 'rejected'); assert.equal(forged.message, 'ROLE_DENIED');
    assert.equal(t.store.latestEventSeq(), seq, 'GET/SSE and rejected POST do not write');
    publish(t, 'member:fe', ref, 'authorized-stream-update');
    await waitFor(() => frames.some(frame => frame.upserts?.resourceThreads?.some(row => row.lastEvent?.summary === 'authorized-stream-update')));
    t.core.mutate(ref, 'adapter', {}, tx => tx.put(ref, { ...tx.read(ref), acl: ['member:fe'] }));
    await waitFor(() => frames.some(frame => frame.removes?.resourceThreads?.includes(ref)));
    const after = t.store.latestEventSeq();
    publish(t, 'member:fe', ref, 'revoked-secret-summary');
    await waitFor(() => frames.some(frame => frame.seq > after));
    assert(!JSON.stringify(frames).includes('revoked-secret-summary'));
    const replay = await fetch(base + '/team/projection/stream?afterSeq=0', { headers: { authorization: 'Bearer viewer' } });
    assert.equal(replay.status, 400, 'unknown viewer has no read identity and cannot receive hidden SSE');
  } finally {
    abort.abort(); if (reader) await reader.cancel().catch(() => {}); if (pump) await pump;
    await server?.close(); t.close();
  }
});

test('P5 review off retention: even legacy manifest/decision citations retain exactly HEAD semantics', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 's5-retain-head-'));
  try {
    const result = spawnSync('git', ['show', 'HEAD:packages/projections/retention.mjs'], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    fs.writeFileSync(path.join(dir, 'retention.mjs'), result.stdout);
    const baseline = await import(pathToFileURL(path.join(dir, 'retention.mjs')).href);
    const seed = new Map([
      ['manifest:legacy', { entityId: 'manifest:legacy', updatedAt: 1 }],
      ['decision:legacy', { entityId: 'decision:legacy', updatedAt: 2, state: 'decided', evidence: [{ ref: 'manifest:legacy' }] }],
      ['audit:legacy', { entityId: 'audit:legacy', updatedAt: 3, evidenceRef: 'manifest:legacy' }],
    ]);
    for (const limit of [0, 1, 2, 256]) {
      const before = structuredClone(seed), unnamed = structuredClone(seed), off = structuredClone(seed);
      baseline.retain(before, limit); retain(unnamed, limit); retain(off, limit, { protocol: 'off' });
      assert.deepEqual([...unnamed], [...before]); assert.deepEqual([...off], [...before]);
    }
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
