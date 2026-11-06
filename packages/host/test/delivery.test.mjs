import test from 'node:test';
import { profile, until } from '../test-support/profile.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ControlStore } from '../../store/index.mjs';
import { TeamCore, canonical, digest } from '../../core/index.mjs';
import { execFileSync } from 'node:child_process';
import { generateKeyPairSync, sign } from 'node:crypto';
import { createDeliveryPort } from '../../delivery/index.mjs';
import { createHostDelivery } from '../src/delivery.mjs';

/**
 * The E package's delivery suite: design §3.7 - readback and close-out are two halves, a Git timeout is `unknown`,
 * and the Git scope is a validated configuration rather than a hard-coded path.
 *
 * The port half is exercised both with a fake (controlled evidence, no subprocess) and with real Git inside a
 * throw-away gitRoots directory, so "the readback decides nothing" is asserted on evidence and "the transition is the
 * only writer" is asserted against the durable row.
 */
function rig() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-e-del-'));
  const store = new ControlStore(root);
  const core = new TeamCore(store, {}, { enabled: true, attach: true, teamId: 'team:d' });
  core.member('member:w', 'worker');
  core.task('task:a', 'member:w');
  return { root, store, core,
    seed(values) {
      core.mutate('delivery:task:a', 'root', {}, tx => tx.put('delivery:task:a',
        { taskId: 'task:a', owner: 'member:w', directory: '/work', base: 'base-1', ...values }));
    },
    close() { store.close(); fs.rmSync(root, { recursive: true, force: true }); } };
}

/** A port that answers with fixed evidence and records what it was asked for. It knows nothing about the store. */
function fakePort({ dirty = { ok: true, value: '' }, head = { ok: true, value: 'cand-1' },
  tree = { ok: true, value: 'tree-1' }, target = { ok: true, value: 'base-1' }, verify = null } = {}) {
  const calls = [];
  return {
    calls,
    repository: '/repo',
    roots: Object.freeze([]),
    timeoutMs: 60000,
    worktreePath: taskId => '/work-' + taskId,
    dirty: root => { calls.push(['dirty', root]); return Promise.resolve(dirty); },
    revParse: (root, ref) => { calls.push(['revParse', root, ref]); return Promise.resolve(root === '/repo' ? target : head); },
    tree: (root, ref) => { calls.push(['tree', root, ref]); return Promise.resolve(tree); },
    ancestor: (...args) => { calls.push(['ancestor', ...args]); return Promise.resolve({ ok: true, value: '' }); },
    updateRef: (...args) => { calls.push(['updateRef', ...args]); return Promise.resolve({ ok: true, value: '' }); },
    worktreeAdd: (directory, base) => { calls.push(['worktreeAdd', directory, base]); return Promise.resolve({ ok: true, value: base }); },
    verify: request => { calls.push(['verify', request]); return Promise.resolve(verify ?? { ok: false, unknown: true, code: 'VERIFIER_TIMEOUT', reason:
      'the verifier did not finish' }); },
  };
}

test('the port holds no core: evidence comes back, only the host writes the row', async () => {
  const w = rig(); try {
    w.seed({ status: 'ready' });
    const port = fakePort();
    const delivery = createHostDelivery({ core: w.core, port });
    assert.equal(port.core, undefined);
    assert.equal(port.store, undefined);
    assert.equal(port.worktree, undefined);
    assert.equal(port.produce, undefined);
    assert.equal(typeof port.revParse, 'function');
    const row = await delivery.produce('task:a');
    assert.equal(row.status, 'produced');
    assert.equal(row.candidate, 'cand-1');
    assert.equal(row.tree, 'tree-1');
    assert.deepEqual(port.calls.map(call => call[0]), ['dirty', 'revParse', 'tree']);
  } finally { w.close(); }
});

test('delivery.transition is a closed table: stale source, unknown field, illegal target', async () => {
  const w = rig(); try {
    w.seed({ status: 'ready' });
    const dispatch = payload => w.core.dispatch('delivery:task:a', 'root', payload,
      { type: 'delivery.transition', payload });
    const before = JSON.stringify({ rows: w.store.list(), effects: w.store.effects() });
    assert.throws(() => dispatch({ deliveryId: 'delivery:task:a', from: 'creating', status: 'ready' }), { code: 'STALE_DELIVERY:ready' });
    assert.throws(() => dispatch({ deliveryId: 'delivery:task:a', from: 'ready', status: 'produced', owner: 'member:x' }), { code:
      'INVALID_DELIVERY_FIELD:owner' });
    assert.throws(() => dispatch({ deliveryId: 'delivery:task:a', from: 'ready', status: 'accepted' }), { code: 'INVALID_TRANSITION:ready>accepted' });
    assert.equal(JSON.stringify({ rows: w.store.list(), effects: w.store.effects() }), before, 'a refusal writes nothing');
  } finally { w.close(); }
});

test('acceptance writes the delivery row and its task in one transaction, and never without a certificate', async () => {
  const w = rig(); try {
    w.seed({ status: 'applying', target: 'refs/heads/main', candidate: 'cand-1', tree: 'tree-1' });
    const dispatch = payload => w.core.dispatch('delivery:task:a', 'root', payload,
      { type: 'delivery.transition', payload });
    assert.throws(() => dispatch({ deliveryId: 'delivery:task:a', from: 'applying', status: 'accepted',
      integrationCommit: 'cand-1', integrationTree: 'tree-1' }), { code: 'UNCERTIFIED_INTEGRATION' });
    assert.equal(w.store.read('task:a').status, 'ready');
    w.core.mutate('delivery:task:a', 'root', {}, tx => tx.put('delivery:task:a', { ...tx.read('delivery:task:a'),
      certificate: { candidate: 'cand-1', tree: 'tree-1', contractRevision: 1 }, certificateHash: 'hash-1' }));
    let seenAtCommit = null;
    w.store.hooks.beforeCommit = () => {
      seenAtCommit = { delivery: w.store.read('delivery:task:a').status, task: w.store.read('task:a').status,
        deliveryRef: w.store.read('task:a').deliveryRef };
    };
    dispatch({ deliveryId: 'delivery:task:a', from: 'applying', status: 'accepted',
      integrationCommit: 'cand-1', integrationTree: 'tree-1' });
    assert.deepEqual(seenAtCommit, { delivery: 'accepted', task: 'accepted', deliveryRef: 'delivery:task:a' },
      'both rows are already written when the single transaction is about to commit');
  } finally { w.close(); }
});

test('a Git timeout closes the delivery as unknown instead of guessing', async () => {
  const w = rig(); try {
    w.seed({ status: 'ready' });
    const port = fakePort({ dirty: { ok: false, unknown: true, code: 'GIT_TIMEOUT', reason: 'git did not finish within 5ms' } });
    const delivery = createHostDelivery({ core: w.core, port });
    const row = await delivery.produce('task:a');
    assert.equal(row.status, 'unknown');
    assert.equal(row.reason, 'git did not finish within 5ms');
    assert.equal(row.lastEvidence.code, 'GIT_TIMEOUT');
    assert.equal(row.responsible, 'operator');
    assert.ok(row.nextReviewAt > Date.now() - 1000);
  } finally { w.close(); }
});

test('an unverifiable candidate closes as unknown instead of storing a certificate', async () => {
  const w = rig(); try {
    w.seed({ status: 'produced', candidate: 'cand-1', tree: 'tree-1' });
    w.store.hooks.beforeCommit = () => {};
    w.core.mutate('member:v', 'root', {}, tx => tx.put('member:v', { role: 'verifier', status: 'running', generation: 1 }));
    w.core.mutate('task:a', 'root', {}, tx => tx.put('task:a', { ...tx.read('task:a'), approved: true, scopeSet: [] }));
    const port = fakePort({ head: { ok: true, value: 'cand-1' } });
    const delivery = createHostDelivery({ core: w.core, port });
    const row = await delivery.verify('task:a', 'member:v', 'evidence:readback');
    assert.equal(row.status, 'unknown');
    assert.equal(row.lastEvidence.code, 'VERIFIER_TIMEOUT');
    assert.equal(w.store.read('delivery:task:a').certificate, undefined);
  } finally { w.close(); }
});

test('the Git scope is configuration: validated roots, containment per call, and the default stays runs/', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-e-roots-'));
  const other = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-e-other-'));
  try {
    const repo = path.join(root, 'repo');
    fs.mkdirSync(repo);
    // R5-4: this fixture used to rely on TMP itself sitting inside a Git repository, so "inside.ok" only passed under
    // a TMP that happened to have a work tree above it. The scratch repository is initialised here instead, and every
    // containment assertion below still measures the rule rather than the machine's TMP.
    execFileSync('git', ['init', '-b', 'main'], { cwd: repo, stdio: 'ignore' });
    const port = createDeliveryPort({ repository: repo, gitRoots: [root] });
    assert.equal(port.roots.length, 1);
    const inside = await port.dirty(repo);
    assert.equal(inside.ok, true);
    await assert.rejects(() => port.dirty(other), { code: 'GIT_SCOPE' });
    assert.throws(() => createDeliveryPort({ gitRoots: [path.join(root, 'missing')] }), { code: 'INVALID_GIT_ROOT' });
    assert.throws(() => createDeliveryPort({ gitRoots: [] }), { code: 'INVALID_CONFIG' });
    assert.throws(() => createDeliveryPort({ gitRoots: [''] }), { code: 'INVALID_CONFIG' });
    const shipped = createDeliveryPort({ repository: repo });
    assert.ok(shipped.roots[0].endsWith('/runs'), 'the default scope is still the repository runs/ tree');
    // The repository root itself is outside runs/, so the shipped default refuses it exactly as the old hard-coded
    // prefix did. (A fixture under TMP is not usable for this: the suites run with TMP inside runs/.)
    await assert.rejects(() => shipped.dirty(process.cwd()), { code: 'GIT_SCOPE' });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(other, { recursive: true, force: true });
  }
});

test('the applying readback is re-read on the cold start and closes to unknown when the target did not move', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-e-git-'));
  const w = rig(); try {
    const repo = path.join(root, 'repo');
    fs.mkdirSync(repo);
    const port = createDeliveryPort({ repository: repo, gitRoots: [root] });
    await port.git(repo, 'init', '-b', 'main');
    await port.git(repo, 'config', 'user.email', 'offline@example.invalid');
    await port.git(repo, 'config', 'user.name', 'Offline Verification');
    fs.writeFileSync(path.join(repo, 'a.txt'), 'baseline');
    await port.git(repo, 'add', '.');
    await port.git(repo, 'commit', '-m', 'baseline');
    const base = (await port.revParse(repo, 'HEAD')).value;
    const delivery = createHostDelivery({ core: w.core, port });
    const created = await delivery.worktree('task:a', 'member:w');
    assert.equal(created.status, 'ready');
    assert.equal(created.base, base);
    fs.writeFileSync(path.join(created.directory, 'a.txt'), 'candidate');
    await port.git(created.directory, 'add', '.');
    await port.git(created.directory, 'commit', '-m', 'candidate');
    const produced = await delivery.produce('task:a');
    assert.equal(produced.status, 'produced');
    assert.notEqual(produced.candidate, base);
    // Leave the row applying exactly as a crash between the row write and the ref move does.
    w.core.mutate('delivery:task:a', 'root', {}, tx => tx.put('delivery:task:a', { ...tx.read('delivery:task:a'),
      status: 'applying', target: 'refs/heads/main' }));
    const report = await delivery.reconcileApplying();
    assert.equal(report.inspected, 1);
    assert.equal(report.accepted, 0);
    assert.equal(report.unknown, 1);
    assert.equal(w.store.read('delivery:task:a').status, 'unknown');
  } finally { w.close(); fs.rmSync(root, { recursive: true, force: true }); }
});
test('review 8: two transitions from the same source: one commits, the other is STALE_DELIVERY, the task row is written once', async () => {
  const w = rig(); try {
    w.seed({ status: 'applying', target: 'refs/heads/main', candidate: 'cand-1', tree: 'tree-1' });
    const certificate = { candidate: 'cand-1', tree: 'tree-1', contractRevision: 1 };
    w.core.mutate('delivery:task:a', 'root', {}, tx => tx.put('delivery:task:a', { ...tx.read('delivery:task:a'),
      certificate, certificateHash: digest(certificate) }));
    const revision = w.store.read('task:a').revision;
    const payload = { deliveryId: 'delivery:task:a', from: 'applying', status: 'accepted', integrationCommit: 'cand-1', integrationTree: 'tree-1' };
    const transition = () => w.core.dispatch('delivery:task:a', 'root', payload, { type: 'delivery.transition', payload });
    // Both callers read "applying" and then race for the write; whichever runs first, the CAS closes the door behind it.
    const results = await Promise.allSettled([
      (async () => { await new Promise(resolve => setImmediate(resolve)); return transition(); })(),
      (async () => { await new Promise(resolve => setImmediate(resolve)); return transition(); })(),
    ]);
    const won = results.filter(result => result.status === 'fulfilled');
    const lost = results.filter(result => result.status === 'rejected');
    assert.equal(won.length, 1, 'exactly one transition commits');
    assert.equal(lost.length, 1);
    assert.equal(lost[0].reason.code, 'STALE_DELIVERY:accepted');
    assert.equal(w.store.read('delivery:task:a').status, 'accepted');
    assert.equal(w.store.read('task:a').status, 'accepted');
    assert.equal(w.store.read('task:a').deliveryRef, 'delivery:task:a');
    assert.equal(w.store.read('task:a').revision, revision + 1, 'the task row was written exactly once');
  } finally { w.close(); }
});
// A delivery effect consumer and the preparation state it closes are the F package's wiring; what E can prove is that
// the readback/transition split is correct on its own.
test('profile delivery effect binds revision and drains a real readback during stop', async () => {
 let release; const pending=new Promise(resolve=>{release=resolve;}); let entered=false;
 const w=await profile({ deliveryPort:{ repository:'/repo',revParse:async()=>{entered=true;return pending;},tree:async()=>({ok:true,value:'tree'}) } },({
   root})=>{
  const store=new ControlStore(root),core=new TeamCore(store,{}, {enabled:true});
  core.mutate('task:d','root',{},tx=>tx.put('task:d',{status:'produced',scopeSet:[],contractRevision:1,approved:true}));
  core.mutate('delivery:task:d','root',{},tx=>{
   const row=tx.put('delivery:task:d',{taskId:'task:d',status:'applying',target:'main',candidate:'commit',tree:'tree',certificateHash:'signed',certificate:{
     candidate:'commit',tree:'tree',contractHash:digest({scopeSet:[],contractRevision:1,approved:true})}});
   tx.outbox('delivery:fixture',{kind:'delivery',deliveryId:'delivery:task:d',taskId:'task:d',target:'main',deliveryRevision:row.revision}); return row;
  }); store.close();
 });
 try {
  await until(()=>entered);
  const stop=w.runtime.host.stop({timeoutMs:1000});
  release({ok:true,value:'commit'}); const result=await stop;
  assert.equal(result.timedOut,false);
  assert.equal(w.runtime.store.read('delivery:task:d').status,'accepted');
  assert.equal(w.runtime.store.read('task:d').status,'accepted');
  assert.equal(w.runtime.store.effects().find(e=>e.id==='delivery:fixture').status,'confirmed');
 } finally {release({ok:true,value:'commit'});await w.close();}
});
for (const drift of ['same-state', 'ABA']) test('fix2 revision CAS rejects delayed ' + drift + ' evidence', async () => {
  const w = rig(); try {
    const task = w.store.read('task:a');
    const certificate = { candidate: 'cand-1', tree: 'tree-1', contractHash: digest({ scopeSet: task.scopeSet, contractRevision: task.contractRevision,
      approved: task.approved }) };
    w.seed({ status: 'applying', target: 'main', candidate: 'cand-1', tree: 'tree-1', certificate, certificateHash: digest(certificate) });
    let release; let entered;
    const ready = new Promise(r => { entered = r; });
    const port = fakePort();
    port.revParse = async () => { entered(); return new Promise(r => { release = r; }); };
    const delivery = createHostDelivery({ core: w.core, port });
    const pending = delivery.reconcile('task:a');
    await ready;
    const statuses = drift === 'ABA' ? ['unknown', 'verified', 'applying'] : ['applying'];
    for (const status of statuses) w.core.mutate('delivery:task:a', 'root', {}, tx => tx.put('delivery:task:a', { ...tx.read('delivery:task:a'), status,
      target: 'other' }));
    release({ ok: true, value: 'cand-1' });
    await assert.rejects(pending, { code: 'STALE_DELIVERY_REVISION' });
    assert.notEqual(w.store.read('task:a').status, 'accepted');
  } finally { w.close(); }
});

for (const answerKind of ['unknown', 'signed']) test('fix2 verifier await binds task revision: ' + answerKind, async () => {
  const w = rig(); try {
    w.core.member('member:v', 'verifier');
    w.core.mutate('task:a', 'root', {}, tx => tx.put('task:a', { ...tx.read('task:a'), approved: true, scopeSet: ['/work'] }));
    w.seed({ status: 'produced', candidate: 'cand-1', tree: 'tree-1' });
    let release; let enter;
    const ready = new Promise(r => { enter = r; });
    const port = fakePort();
    let request;
    port.verify = async input => { request = input.request; enter(); return new Promise(r => { release = r; }); };
    const pending = createHostDelivery({ core: w.core, port }).verify('task:a', 'member:v', 'proof');
    await ready;
    w.core.mutate('task:a', 'root', {}, tx => tx.put('task:a', { ...tx.read('task:a'), contractRevision: 2 }));
    const keys = generateKeyPairSync('ed25519');
    const certificate = { ...request };
    release(answerKind === 'unknown' ? { unknown: true, code: 'VERIFIER_TIMEOUT' } : { ok: true, certificate,
      signature: sign(null, Buffer.from(canonical(certificate)), keys.privateKey).toString('base64'),
      publicKey: keys.publicKey.export({ type: 'spki', format: 'pem' }) });
    await assert.rejects(pending, { code: 'STALE_TASK_REVISION' });
    assert.equal(w.store.read('delivery:task:a').status, 'produced');
  } finally { w.close(); }
});
