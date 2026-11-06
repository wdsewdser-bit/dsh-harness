// P5 of the team-autonomy design (docs/decisions/team-autonomy-design.md §7.2.1-§7.2.3, §7.4 F1-F3): the stop proof.
//
// Every case drives the production prover through an injected process-tree port, so the two budgets, the three-poll
// readback and the pid-reuse rule are exercised without spawning anything. The real Windows tree is
// stop-proof-windows.test.mjs; this file is the deterministic half.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createStopProver } from '../src/stop-proof.mjs';
import { nativeProcessIdentity } from '../../adapter-dsh/index.mjs';

const ROOT = { pid: 100, ppid: 4, createdAt: 'filetime:1', name: 'node.exe' };
const CHILD = { pid: 200, ppid: 100, createdAt: 'filetime:2', name: 'node.exe' };
const SUBJECT = { kind: 'member-session', id: 'member:w', fence: 3 };

/** A process table the test scripts: `rows` is a snapshot function, `kill` decides what a kill does to it. */
function fakeTree({ rows, kill = async () => ({ ok: true }), available = true, platform = 'win32' } = {}) {
  let source = typeof rows === 'function' ? rows : () => rows;
  const killed = [];
  const tree = {
    platform,
    method: platform === 'win32' ? 'taskkill-tree' : 'process-tree-kill',
    available: () => available,
    list: async () => source(),
    identity: async pid => source().find(row => row.pid === pid) ?? null,
    killTree: async pid => { killed.push(pid); return kill(pid); },
    lastTool: () => (killed.length ? 'taskkill /PID ' + killed.at(-1) + ' /T /F' : null),
  };
  return { tree, killed };
}

/** A clock the prover advances by sleeping, so a five second budget costs no wall time. */
function clock(start = 1000) {
  return { at: start, now() { return this.at; }, async sleep(ms) { this.at += Math.max(1, ms); } };
}

function proverFor(tree, time, options = {}) {
  return createStopProver({ tree, now: () => time.now(), sleep: ms => time.sleep(ms), pollMs: 100,
    stablePolls: 3, ...options });
}

const run = (tree, time, extra = {}) => proverFor(tree, time).prove({ subject: SUBJECT,
  roots: [{ pid: ROOT.pid, createdAt: ROOT.createdAt }], graceMs: 500, proofTimeoutMs: 500, ...extra });

test('a tree that exits inside the grace period is proven stopped without a single kill (F1)', async () => {
  let snapshots = 0;
  const f = fakeTree({ rows: () => (++snapshots <= 1 ? [ROOT, CHILD] : []) });
  const row = await run(f.tree, clock());
  assert.equal(row.verified, false);
  assert.equal(row.confidence, 'low');
  assert.equal(row.method, 'taskkill-tree');
  assert.equal(row.descendantsAfter, 0);
  assert.equal(row.error.code, 'STOP_SCOPE_UNPROVEN');
  assert.deepEqual(f.killed, [], 'the grace period did its job');
  assert.ok(row.polls >= 2, 'the proof is a readback, not a single look');
});

test('a tree that outlives the grace period is killed and then proven empty', async () => {
  let alive = true;
  const f = fakeTree({ rows: () => (alive ? [ROOT, CHILD] : []),
    kill: async () => { alive = false; return { ok: true }; } });
  const time = clock();
  const row = await run(f.tree, time);
  assert.equal(row.verified, false);
  assert.deepEqual(f.killed, [100, 200], 'the root and its recorded child, each by pid');
  assert.deepEqual(row.reaped.map(entry => entry.pid), [100, 200]);
  assert.match(row.tool, /^taskkill \/PID 200 \/T \/F$/);
  assert.equal(row.descendantsAfter, 0);
  assert.ok(time.now() >= 1000 + 500, 'the kill only happens after the grace budget');
});

test('a process that survives the kill is never reported as stopped (7.2.3 rule 2)', async () => {
  const f = fakeTree({ rows: [ROOT], kill: async () => ({ ok: true }) });
  const row = await run(f.tree, clock());
  assert.equal(row.verified, false);
  assert.equal(row.confidence, 'low');
  assert.equal(row.error.code, 'STOP_PROOF_TIMEOUT');
  assert.equal(row.descendantsAfter, 1);
});

test('a pid whose creation time moved is never killed (F3, PID_REUSED)', async () => {
  const time = clock();
  const f = fakeTree({
    // Our root exited and the pid was reused by another process; our child was orphaned by that exit and survives
    // every kill this fixture performs (the "kill did not take" case, which is exactly what a missing proof is).
    rows: () => (time.now() < 1500 ? [ROOT, CHILD] : [{ ...ROOT, createdAt: 'filetime:99' }, { ...CHILD, ppid: 1 }]),
    kill: async () => ({ ok: true }),
  });
  const row = await run(f.tree, time);
  assert.equal(f.killed.includes(100), false, 'the reused pid is never handed to taskkill');
  assert.deepEqual(f.killed, [200], 'only the process whose identity still matches is killed');
  assert.equal(row.verified, false, 'the tree cannot be proven empty: the child survived');
  assert.equal(row.error.code, 'PID_REUSED');
  assert.deepEqual(row.pidReused, [100]);
});

test('a reused pid alone does not block the proof: the process we tracked is gone', async () => {
  const time = clock();
  const f = fakeTree({ rows: () => (time.now() < 1500 ? [ROOT] : [{ ...ROOT, createdAt: 'filetime:99' }]) });
  const row = await run(f.tree, time);
  assert.deepEqual(f.killed, [], 'nothing of ours was there to kill');
  assert.equal(row.verified, false);
  assert.equal(row.descendantsAfter, 0);
});

test('no process port on this platform means no proof, never a pass', async () => {
  const f = fakeTree({ rows: [], available: false, platform: 'darwin' });
  const row = await run(f.tree, clock());
  assert.equal(row.verified, false);
  assert.equal(row.method, 'none');
  assert.equal(row.error.code, 'STOP_CAPABILITY_MISSING');
});

test('a graceful stop that works is the whole proof when requestStop is supplied', async () => {
  let alive = true;
  const f = fakeTree({ rows: () => (alive ? [ROOT] : []) });
  const row = await run(f.tree, clock(), { requestStop: async () => { alive = false; } });
  assert.equal(row.verified, false);
  assert.deepEqual(f.killed, []);
});

test('access denied is reported as its own code and blocks the proof', async () => {
  const f = fakeTree({ rows: [ROOT], kill: async () => ({ ok: false, code: 'STOP_ACCESS_DENIED', message: 'Access is denied.' }) });
  const row = await run(f.tree, clock());
  assert.equal(row.verified, false);
  assert.equal(row.error.code, 'STOP_ACCESS_DENIED');
});

test('this adapter reports no OS identity for a session, because its agents run in this process', () => {
  // §11 item 5, answered by the code that composes the host: host() builds a cordis Context here and create/resume are
  // context.agents.create()/resume(), so there is no pid to prove. A future out-of-process adapter reports one here.
  assert.equal(nativeProcessIdentity({ id: 'session-1', snapshotEvents() { return []; } }), null);
  assert.equal(nativeProcessIdentity(null), null);
  assert.deepEqual(nativeProcessIdentity({ pid: 5, createdAt: 7 }), { pid: 5, createdAt: '7', image: null });
  assert.equal(nativeProcessIdentity({ pid: 0, createdAt: 7 }), null);
});

test('a malformed subject or an empty root list is refused before a process is touched', async () => {
  const f = fakeTree({ rows: [ROOT] });
  const prover = proverFor(f.tree, clock());
  await assert.rejects(prover.prove({ subject: { kind: 'member-session', id: '', fence: 1 }, roots: [ROOT] }),
    { code: 'INVALID_CONFIG' });
  await assert.rejects(prover.prove({ subject: SUBJECT, roots: [] }), { code: 'INVALID_CONFIG' });
  await assert.rejects(prover.prove({ subject: SUBJECT, roots: [{ pid: 1 }] }), { code: 'INVALID_CONFIG' });
  assert.deepEqual(f.killed, []);
});

test('requestStop kills parent first but surviving orphan prevents verification', async () => {
  let rows = [ROOT, CHILD];
  const f = fakeTree({ rows: () => rows });
  const row = await run(f.tree, clock(), { requestStop: async () => { rows = [{ ...CHILD, ppid: 1 }]; } });
  assert.equal(row.verified, false);
  assert.equal(row.descendantsAfter, 1);
  assert.deepEqual(f.killed, [CHILD.pid]);
});

test('root absent at initial capture cannot certify an unknown descendant range', async () => {
  const f = fakeTree({ rows: [{ ...CHILD, ppid: 1 }] });
  let requested = false;
  const row = await run(f.tree, clock(), { requestStop: () => { requested = true; } });
  assert.equal(row.verified, false);
  assert.equal(row.error.code, 'STOP_SCOPE_UNPROVEN');
  assert.equal(requested, false);
  assert.deepEqual(f.killed, []);
});

test('tracked orphan can contribute new descendants after root disappears', async () => {
  let rows = [ROOT, CHILD];
  const grandchild = { pid: 300, ppid: CHILD.pid, createdAt: 'filetime:3', name: 'node.exe' };
  const f = fakeTree({ rows: () => rows });
  const row = await run(f.tree, clock(), { requestStop: () => { rows = [{ ...CHILD, ppid: 1 }, grandchild]; } });
  assert.equal(row.verified, false);
  assert.equal(row.descendantsAfter, 2);
  assert.deepEqual(f.killed, [CHILD.pid, grandchild.pid]);
});
