import test from 'node:test';
import { profile } from '../test-support/profile.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ControlStore } from '../../store/index.mjs';
import { GoalGate, RECOVERY_CONTRACT, TeamCore, canonical, createRecoveryScope, digest, recoverFacts } from '../../core/index.mjs';
import { execFileSync, spawnSync as realSpawnSync } from 'node:child_process';
import { generateKeyPairSync, sign } from 'node:crypto';
import { createTeamHost } from '../index.mjs';
import { createGoalRecovery } from '../src/goal.mjs';
import { createRecovery } from '../src/recover.mjs';
import { createHostDelivery } from '../src/delivery.mjs';
import { createEffectRunner } from '../src/effect-runner.mjs';
import { openSessionLog } from '../../adapter-dsh/index.mjs';
import { createGitGuardRunner } from '../../delivery/index.mjs';

/**
 * The E package's recovery suite: design §3.5.1, §3.8 and the fault rows F3, F8 (seven sub-cases), F23, F24.
 *
 * Every case drives the real composition - ControlStore, TeamCore, TeamHost, the host's controlled write ports - and
 * seeds durable rows, never only a token or an attempt: a task that is executing, a pending wait, an applying
 * member-intent, an active attempt and an unresolved completion token. The recovery pass is the host's own recoverer,
 * so "start succeeded", "status is readable" and "admission is what the conclusion says" are asserted where they are
 * decided, not on a hand-built object.
 */

import { GOAL, seed, rig, cancelled } from '../test-support/recovery-fixtures.mjs';

test('review 1/6: the guard reads back through its own roots, once per entry, and reports a missing capability', () => {
  const scratch = path.join(process.cwd(), 'verification', '.scratch');
  const fresh = !fs.existsSync(scratch);
  const repo = path.join(scratch, 'gate-' + process.pid + '-' + Date.now());
  const storeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-e-gate-'));
  const store = new ControlStore(storeDir);
  const core = new TeamCore(store, {}, { enabled: true, attach: true, teamId: 'team:gate' });
  const gitIn = args => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', windowsHide: true }).trim();
  try {
    fs.mkdirSync(repo, { recursive: true });
    execFileSync('git', ['init', '-b', 'main'], { cwd: repo, encoding: 'utf8', windowsHide: true });
    gitIn(['config', 'user.email', 'offline@example.invalid']);
    gitIn(['config', 'user.name', 'Offline Verification']);
    gitIn(['commit', '--allow-empty', '-m', 'initial base']);
    const initialBase = gitIn(['rev-parse', 'HEAD']);
    fs.writeFileSync(path.join(repo, 'a.txt'), 'candidate');
    gitIn(['add', '.']);
    gitIn(['commit', '-m', 'candidate']);
    const head = gitIn(['rev-parse', 'HEAD']);
    const treeHash = gitIn(['rev-parse', 'HEAD^{tree}']);
    core.member('member:w', 'worker');
    core.task('task:a', 'member:w');
    core.mutate('member:v', 'root', {}, tx => tx.put('member:v', { role: 'verifier', status: 'running', generation: 1 }));
    core.mutate('task:a', 'root', {}, tx => tx.put('task:a', { ...tx.read('task:a'), status: 'accepted', approved: true,
      contractRevision: 1, scopeSet: [] }));
    const { publicKey, privateKey } = generateKeyPairSync('ed25519');
    const certificate = { base: initialBase, candidate: head, tree: treeHash, contractRevision: 1, verifier: 'member:v',
      contractHash: digest({ scopeSet: [], contractRevision: 1, approved: true }) };
    const signature = sign(null, Buffer.from(canonical(certificate)), privateKey).toString('base64');
    core.mutate('delivery:task:a', 'root', {}, tx => tx.put('delivery:task:a', { taskId: 'task:a', owner: 'member:w',
      directory: repo, base: initialBase, candidate: head, tree: treeHash, status: 'accepted', target: 'refs/heads/main', certificate, certificateHash:
        digest(certificate),
      integrationCommit: head, integrationTree: treeHash, signature,
      publicKey: publicKey.export({ type: 'spki', format: 'pem' }) }));

    let calls = 0;
    const spawnSync = (...args) => { calls += 1; return realSpawnSync(...args); };
    const gate = new GoalGate(core, () => {}, { gitGuard: createGitGuardRunner({ roots: [path.resolve(scratch)], spawnSync }) });
    const input = { sessionId: 'session:g', goal: { id: 'goal:g', revision: 1, objective: 'ship', maxGoalRounds: 3 } };
    const tokenId = gate.prepare(input);
    assert.equal(calls, 2,
      'one evidence evaluation performs a combined root/head/tree read and one ancestry read, not a second evaluation inside the transaction');
    assert.equal(store.read(tokenId).status, 'prepared');
    assert.equal(gate.capability().last, null);

    // An unexpected defect is not a verdict: it escapes instead of reading as "not ready to complete".
    const brokenCore = Object.create(core);
    brokenCore.mutate = () => { throw new TypeError('transaction exploded'); };
    const brokenGate = new GoalGate(brokenCore, () => {}, { gitGuard: createGitGuardRunner({ roots: [path.resolve(scratch)], spawnSync }) });
    assert.throws(() => brokenGate.check(input), /transaction exploded/);
    assert.equal(store.read(tokenId).status, 'prepared', 'the failure wrote nothing');

    calls = 0;
    assert.equal(gate.check(input), true);
    assert.equal(calls, 2, 'and one combined target read plus one ancestry proof per check');
    assert.equal(store.read(tokenId).status, 'authorized');

    // The shipped default roots still do not cover this repository: the guard reports the gap, it does not fold it.
    const shipped = new GoalGate(core, () => {}, { gitGuard: createGitGuardRunner() });
    const other = { ...input, goal: { ...input.goal, id: 'goal:other' } };
    assert.throws(() => shipped.prepare(other), { code: 'EVIDENCE_UNAVAILABLE' });
    assert.equal(shipped.capability().last.code, 'GIT_SCOPE');
    assert.equal(shipped.check(other), false);
    assert.equal(shipped.capability().failures, 2, 'both entries recorded the missing capability');
    const slow = new GoalGate(core, () => {}, { gitGuard: createGitGuardRunner({ roots: [path.resolve(scratch)],
      spawnSync: () => ({ error: { code: 'ETIMEDOUT', message: 'git timed out' } }) }) });
    assert.throws(() => slow.prepare({ ...input, goal: { ...input.goal, id: 'goal:slow' } }), { code: 'EVIDENCE_UNAVAILABLE' });
    assert.equal(slow.capability().last.code, 'GIT_TIMEOUT');
  } finally {
    store.close();
    fs.rmSync(storeDir, { recursive: true, force: true });
    fs.rmSync(repo, { recursive: true, force: true });
    if (fresh) fs.rmSync(scratch, { recursive: true, force: true });
  }
});

// The complete cold-start acceptance needs the production consumers (F): the profile's own session-log port, the
// preparation state of a real agent, and the activity that wakes the cycle after admission opens. Until then the
// recovery module is exercised directly, as above, and this line stays a skip rather than an early wiring.
test('production profile reconciles a persisted prepared token through openSessionLog', async()=>{
 let reads=0;
 const w=await profile({},({root,sessions})=>{
  const store=new ControlStore(root),core=new TeamCore(store,{}, {enabled:true});
  core.mutate('completion:profile','root',{},tx=>tx.put('completion:profile',{status:'prepared',input:{sessionId:'session:goal',goal:{id:'goal:profile',
    revision:1,objective:'done',maxGoalRounds:3}}}));store.close();
  sessions.set('session:goal',{id:'session:goal',seq:0,snapshotEvents(){reads++;return [];}});
 });
 try{assert(reads>0);assert.equal(w.runtime.store.read('completion:profile').status,'cancelled');assert.equal(w.runtime.host.status().admission,true);assert(
   w.runtime.host.cycle.status().installed.includes('pump'));}
 finally{await w.close();}
});
test('fix2 prepared completed journal has stable positive operator exit', async () => {
  const events = [{ seq: 7, type: 'goal/change', data: { goal: { ...GOAL, revision: 2, phase: 'complete' } } }];
  const w = await rig({ token: { name: 'one', row: { status: 'prepared' } }, journal: () => ({ events, complete: true }) });
  try {
    await w.start();
    assert.equal(w.store.read('completion:one').status, 'unknown');
    const session = { id: 'session:e', snapshotEvents: () => events };
    const evidence = { seq: 7, reference: 'operator-independent-proof' };
    w.goal.gate.resolveCompletion(session, 'completion:one', 'consumed', evidence, 'operator');
    const revision = w.store.read('completion:one').revision;
    w.goal.gate.resolveCompletion(session, 'completion:one', 'consumed', evidence, 'operator');
    assert.equal(w.store.read('completion:one').revision, revision);
    const status = await w.restart();
    assert.equal(status.admission, true);
    assert.equal(w.store.read('completion:one').status, 'consumed');
    assert.equal(w.store.read('completion:one').seq, 7);
    assert.equal(w.store.read('completion:one').revision, revision);
    assert.deepEqual(w.goal.gate.unresolved(), []);
    const inconsistency = w.store.list('inconsistency:')[0];
    assert.equal(inconsistency.status, 'resolved');
    assert.equal(inconsistency.adjudication.decision, 'consumed');
    assert.equal(inconsistency.tokenId, 'completion:one');
  } finally { await w.close(); }
});

test('fix2 nonthrowing delivery failure array keeps admission closed', async () => {
  const w = await rig({ delivery: { reconcileApplying: async () => ({ failed: [{ code: 'READBACK_FAILED' }] }) } });
  try {
    const status = await w.start();
    assert.equal(status.admission, false);
    assert.equal(status.recovery.status, 'unknown');
    assert.equal(status.recovery.capability, 'READBACK_FAILED');
    assert.match(w.recovery.status().last.reason, /delivery/);
  } finally { await w.close(); }
});

test('fix2 sweep exception keeps admission closed', async () => {
  const w = await rig();
  const reconcile = w.store.reconcile;
  w.store.reconcile = () => { throw Object.assign(Error('sweep failed'), { code: 'SWEEP_FAILED' }); };
  try {
    const status = await w.start();
    assert.equal(status.admission, false);
    assert.equal(status.recovery.capability, 'SWEEP_FAILED');
  } finally { w.store.reconcile = reconcile; await w.close(); }
});
for (const frozen of [false, true]) test('fix2 real host Delivery cold start controlled route frozen=' + frozen, async () => {
  const w = await rig({ token: frozen ? { name: 'one', row: { status: 'authorized' } } : null, journal: () => ({ events: [], complete: true }) });
  try {
    // The completion fence intentionally forbids seeding business rows after a token; seed fixture before starting.
    if (frozen) w.core.mutate('completion:one', 'operator', {}, tx => tx.put('completion:one', { ...tx.read('completion:one'), status: 'cancelled' }));
    const task = w.store.read('task:a');
    const certificate = { candidate: 'candidate', tree: 'tree', contractHash: digest({ scopeSet: task.scopeSet, contractRevision: task.contractRevision,
      approved: task.approved }) };
    w.core.mutate('delivery:task:a', 'root', {}, tx => tx.put('delivery:task:a', { taskId: 'task:a', status: 'applying', target: 'main', candidate:
      'candidate', tree: 'tree', certificate, certificateHash: digest(certificate) }));
    if (frozen) w.core.mutate('completion:one', 'operator', {}, tx => tx.put('completion:one', { ...tx.read('completion:one'), status: 'authorized' }));
    const delivery = createHostDelivery({ core: w.core, access: w.host.coreAccess, port: { repository: '/repo', revParse: async () => ({ ok: true, value:
      'candidate' }), tree: async () => ({ ok: true, value: 'tree' }) } });
    const recovery = createRecovery({ core: w.core, access: w.host.coreAccess, goal: w.goal, delivery });
    w.state.recovery = recovery;
    const status = await w.start();
    if (frozen) {
      assert.equal(status.admission, false);
      assert.equal(status.recovery.status, 'unknown');
      assert.equal(recovery.status().last.steps.delivery.errors[0].code, 'COMPLETION_FROZEN');
      assert.equal(w.store.read('delivery:task:a').status, 'applying');
      assert.notEqual(w.store.read('task:a').status, 'accepted');
    } else {
      assert.equal(status.admission, true);
      assert.equal(recovery.status().last.steps.delivery.status, 'ok');
      assert.equal(w.store.read('task:a').status, 'accepted');
    }
  } finally { await w.close(); }
});

