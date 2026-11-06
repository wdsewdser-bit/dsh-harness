import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ControlStore } from '../../store/index.mjs';
import { TeamCore } from '../../core/index.mjs';
import { createTeamHost, effectCapabilities } from '../index.mjs';
import { createEffectRunner } from '../src/effect-runner.mjs';
import { DECLARED_EFFECT_KINDS, EFFECT_CAPABILITIES, createEffectCapabilities, validateEffectKinds } from '../src/effect-capabilities.mjs';

// P4 of the team-autonomy design (docs/decisions/team-autonomy-design.md §6.2, appendix 5): every effect kind declares
// "readable / safe to retry / neither", and the runner — not the ledger rule — decides what an uncertain outcome means.
// These cases are the §6.4 acceptance list, written against the real ledger, the real decision reducer and a real
// runner; only the adapter ports are fakes, because the question is what the host does with their answers.

const seed = (w, id, payload) => w.core.mutate('seed:' + id, 'scheduler', {}, tx => { tx.outbox(id, payload); return null; });
const tick = () => new Promise(resolve => setImmediate(resolve));

async function team({ autonomy = 'on' } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-p4-effect-'));
  const store = new ControlStore(root);
  let at = Date.now();
  const core = new TeamCore(store, {}, { enabled: true, attach: true, teamId: 'team:p4', autonomy, now: () => at });
  const host = createTeamHost({ root, teamId: 'team:p4', core, now: () => at, cycleIntervalMs: 1000000,
    recoverer: async () => ({ status: 'ok', admission: true }), openStore: () => ({ close() {} }) });
  await host.start();
  return { root, store, core, host, get at() { return at; }, set at(value) { at = value; },
    runner: (extra = {}) => createEffectRunner({ access: host.coreAccess, clock: host.clock, ...extra }),
    async close() { await host.stop(); store.close(); fs.rmSync(root, { recursive: true, force: true }); } };
}

/** The capability layer exactly as the profile wires it, minus the ports this test replaces. */
const caps = (w, extra = {}) => ({ on: true, kinds: DECLARED_EFFECT_KINDS, store: w.store, access: w.host.coreAccess,
  teamId: 'team:p4', ttlMs: 900000, readbackTimeoutMs: 300, ...extra });

test('P4 §6.2.1: a readback that knows the answer settles the effect, and opens no decision', async () => {
  const w = await team(); let reads = 0;
  try {
    seed(w, 'lifecycle:a', { kind: 'member-lifecycle', memberId: 'member:w', generation: 1 });
    const runner = w.runner({ ports: { 'member-lifecycle': () => ({ unknown: true, reason: 'the adapter lost the receipt' }) },
      capabilities: caps(w, { readbacks: { session: () => { reads += 1; return { executed: true, receipt: { session: 'member:w' } }; } } }) });
    try {
      assert.equal(runner.pump().claimed, 1);
      await runner.whenIdle();
      assert.equal(reads, 1);
      assert.equal(w.store.effects()[0].status, 'confirmed');
      assert.equal(w.store.effects()[0].lastEvidence.readback, 'session');
      assert.equal(w.store.list('decision:').length, 0);
    } finally { runner.stop(); }
  } finally { await w.close(); }
});

test('P4 §6.3: a readback that cannot decide becomes a decision, and a second pump does not open a second one', async () => {
  const w = await team();
  try {
    w.core.member('member:root', 'root');
    seed(w, 'delivery:task:b', { kind: 'delivery', deliveryId: 'delivery:task:b', taskId: 'task:b', deliveryRevision: 1, target: 'refs/heads/main' });
    const runner = w.runner({ ports: { delivery: () => ({ unknown: true, reason: 'the port lost the answer' }) },
      capabilities: caps(w, { readbacks: { git: () => ({ unknown: true, reason: 'the git readback is unavailable' }) } }) });
    try {
      runner.pump(); await runner.whenIdle();
      assert.equal(w.store.effects()[0].status, 'unknown');
      assert.equal(w.store.effects()[0].lastEvidence.code, 'EFFECT_READBACK_UNCERTAIN');
      const decisions = w.store.list('decision:');
      assert.equal(decisions.length, 1);
      assert.equal(decisions[0].kind, 'unknown-effect');
      assert.deepEqual(decisions[0].options, ['effective', 'not-effective', 'abandoned']);
      assert.equal(decisions[0].subject.id, 'effect:delivery:task:b');
      assert.equal(w.store.read(decisions[0].evidence[0].ref).switch, 'on');
      // A second pump (the crash-repair sweep) sees the same unknown row and opens no second ticket.
      w.at = Date.now() + 10000;
      assert.equal(runner.pump().claimed, 0);
      await runner.whenIdle();
      assert.equal(w.store.list('decision:').length, 1);
    } finally { runner.stop(); }
  } finally { await w.close(); }
});

test('P4 §6.2.1: a safe retry stops at its own cap and hands the effect to root', async () => {
  const w = await team();
  try {
    w.core.member('member:root', 'root');
    seed(w, 'gc:uncertain', { kind: 'gc' });
    const runner = w.runner({ ports: { gc: () => ({ unknown: true, reason: 'the idempotent collector lost its response' }) },
      capabilities: caps(w) });
    try {
      const seen = [];
      for (let i = 1; i <= EFFECT_CAPABILITIES.gc.maxTries; i++) {
        w.at = Date.now() + 10000 * (i + 1);
        assert.equal(runner.pump().claimed, 1);
        await runner.whenIdle();
        seen.push(w.store.effects()[0].status);
      }
      assert.deepEqual(seen.slice(0, -1), ['retryable', 'retryable']);
      assert.equal(seen.at(-1), 'unknown');
      assert.equal(w.store.effects()[0].lastEvidence.code, 'EFFECT_RETRY_EXHAUSTED');
      assert.equal(w.store.list('decision:').length, 1);
      // The cap is the declaration's, not the ledger's five: a fourth attempt is never claimed.
      w.at = Date.now() + 100000;
      assert.equal(runner.pump().claimed, 0);
    } finally { runner.stop(); }
  } finally { await w.close(); }
});

test('P4 §6.2.1: an undeclared effect kind refuses the host at start-up while the switch is on', async () => {
  const w = await team();
  try {
    assert.throws(() => w.runner({ capabilities: { on: true, kinds: ['wake', 'made-up-kind'], store: w.store } }),
      error => error.code === 'EFFECT_KIND_UNDECLARED' && /made-up-kind/.test(error.message));
    // With the switch off there is no table and no check: the composition is exactly what it was before P4.
    const off = w.runner({ capabilities: { on: false, kinds: ['made-up-kind'], store: w.store } });
    assert.equal(off.status().stopped, false);
    off.stop();
  } finally { await w.close(); }
});

/**
 * Review (WP-C P2-1): the start-up refusal treats a declaration whose VALUE is null as undeclared, exactly as the
 * pre-M4 implementation did (missing = lookup(...) === null). Moving the table into contracts must not defer that
 * refusal to runtime: { wake: null } is a configuration defect the host refuses to start with.
 */
test('P4 §6.2.1: a declaration whose value is null is undeclared at start-up, as before the table moved to contracts', async () => {
  // The unit edge, straight against the refusal the composition calls.
  assert.throws(() => validateEffectKinds(['wake'], { wake: null }), { code: 'EFFECT_KIND_UNDECLARED' });
  // The rest of the old boundary is unchanged: an absent key and a non-string kind are undeclared; a PRESENT value
  // (even undefined) is what lookup() answered with, so it stayed declared.
  assert.throws(() => validateEffectKinds(['wake'], {}), { code: 'EFFECT_KIND_UNDECLARED' });
  assert.throws(() => validateEffectKinds([null], { wake: {} }), { code: 'EFFECT_KIND_UNDECLARED' });
  assert.equal(validateEffectKinds(['wake'], { wake: undefined }), true, 'undefined is a present value, as before');
  assert.equal(validateEffectKinds(['wake'], { wake: { readback: null, retry: 'safe', maxTries: 1 } }), true);
  // And through the real start-up path, not only the helper: the host refuses to build the capability layer.
  const w = await team();
  try {
    assert.throws(() => w.runner({ capabilities: { on: true, kinds: ['wake'], declarations: { wake: null }, store: w.store } }),
      error => error.code === 'EFFECT_KIND_UNDECLARED' && /wake/.test(error.message));
  } finally { await w.close(); }
});

test('P4 §6.2.4: a root decision settles the unknown effect and the verdict is audited', async () => {
  const w = await team();
  try {
    w.core.member('member:root', 'root');
    seed(w, 'lifecycle:c', { kind: 'member-lifecycle', memberId: 'member:w', generation: 1 });
    seed(w, 'lifecycle:d', { kind: 'member-lifecycle', memberId: 'member:x', generation: 1 });
    const runner = w.runner({ ports: { 'member-lifecycle': () => ({ unknown: true }), message: () => ({ executed: true, receipt: {} }) },
      capabilities: caps(w, { readbacks: { session: () => ({ unknown: true, reason: 'no session-state port' }) } }) });
    try {
      runner.pump(); await runner.whenIdle();
      const of = subjectId => w.store.list('decision:').find(row => row.subject?.id === subjectId);
      const first = of('effect:lifecycle:c'), second = of('effect:lifecycle:d');
      assert.ok(first && second);
      w.core.decideDecision(first.entityId, 'member:root', { decision: 'effective' });
      w.core.decideDecision(second.entityId, 'member:root', { decision: 'not-effective' });
      assert.equal(w.store.read(first.entityId).state, 'decided');
      assert.equal(w.store.read('effect:lifecycle:c').adjudication.decision, 'effective');
      // The verdict is recorded but the ledger is not settled until the runner applies it.
      assert.equal(w.store.effects().find(row => row.id === 'lifecycle:c').status, 'unknown');
      runner.pump(); await runner.whenIdle();
      assert.equal(w.store.effects().find(row => row.id === 'lifecycle:c').status, 'confirmed');
      assert.equal(w.store.effects().find(row => row.id === 'lifecycle:d').status, 'cancelled');
      assert.equal(w.store.effects().find(row => row.id === 'lifecycle:c').lastEvidence.decided, 'effective');
      const audit = w.store.list('audit:').filter(row => row.kind === 'decision');
      assert.equal(audit.length, 2);
      assert.deepEqual(audit.map(row => row.option).sort(), ['effective', 'not-effective']);
      // A settled effect is never re-opened. (The two effects the pump does claim here are the operator notices the
      // verdicts themselves wrote — a message effect, not a second ticket for the effects that are already settled.)
      w.at = Date.now() + 100000;
      runner.pump(); await runner.whenIdle();
      assert.equal(w.store.effects().find(row => row.id === 'lifecycle:c').status, 'confirmed');
      assert.equal(w.store.effects().find(row => row.id === 'lifecycle:d').status, 'cancelled');
      assert.equal(w.store.list('decision:').length, 2);
    } finally { runner.stop(); }
  } finally { await w.close(); }
});

test('P4 §6.2: with the switch off the ledger rule is untouched — five tries, then dead-letter, no decision', async () => {
  const w = await team({ autonomy: 'off' });
  try {
    seed(w, 'wake:a', { kind: 'wake', recipient: 'member:w' });
    const runner = w.runner({ ports: { wake: () => ({ notExecuted: true }) } });
    try {
      for (let i = 1; i <= 5; i++) {
        w.at = Date.now() + 10000 * (i + 1);
        assert.equal(runner.pump().claimed, 1);
        await runner.whenIdle();
        const effect = w.store.effects()[0];
        assert.equal(effect.tries, i);
        assert.equal(effect.status, i === 5 ? 'dead-letter' : 'retryable');
      }
      assert.equal(w.store.list('decision:').length, 0);
    } finally { runner.stop(); }
  } finally { await w.close(); }
});

test('P4 连锁后果②: the active-IO slot is held through the readback, never released by the timeout', async () => {
  const w = await team();
  try {
    seed(w, 'lifecycle:e', { kind: 'member-lifecycle', memberId: 'member:w', generation: 1 });
    let release; const gate = new Promise(resolve => { release = resolve; });
    const runner = w.runner({ timeoutMs: 5, ports: { 'member-lifecycle': () => ({ unknown: true }), message: () => ({ executed: true, receipt: {} }) },
      capabilities: caps(w, { readbackTimeoutMs: 5000, readbacks: { session: () => gate.then(() => ({ executed: true, receipt: {} })) } }) });
    try {
      runner.pump();
      await new Promise(resolve => setTimeout(resolve, 30)); // past the effect timeout, inside the readback
      assert.equal(runner.status().activeIO, 1, 'the readback still occupies the slot');
      // The row is not closed either: the receipt waits for the readback, so the timeout alone never settles an effect.
      assert.equal(w.store.effects()[0].status, 'applying');
      release();
      await runner.whenIdle();
      assert.equal(runner.status().activeIO, 0);
      assert.equal(w.store.effects()[0].status, 'confirmed', 'the readback decides the row it kept the slot for');
    } finally { runner.stop(); }
  } finally { await w.close(); }
});

// P9 (docs/decisions/team-autonomy-design.md §10 P9, appendix 9): the table a projection may read. The projection cannot
// import packages/host/src (the dependency check refuses it), so the public entry publishes this function; what matters
// is that a reader gets the declarations and nothing it can change.
test('appendix 9: the public entry publishes the declaration table as a read-only copy', () => {
  const table = effectCapabilities();
  assert.deepEqual(Object.keys(table).sort(), [...DECLARED_EFFECT_KINDS].sort(), 'every declared kind, no invented one');
  assert.deepEqual(table.delivery, { readback: 'git', retry: 'safe', maxTries: 3 });
  assert.deepEqual(table.start, { readback: null, retry: 'unsafe', maxTries: 1 });
  assert.equal(Object.isFrozen(table) && Object.isFrozen(table.start), true, 'frozen at both levels');
  assert.throws(() => { table.start.retry = 'safe'; }, TypeError, 'a reader cannot edit what it was given');
  assert.throws(() => { table.cancel = null; }, TypeError);
  assert.notEqual(effectCapabilities().start, table.start, 'each call answers its own copy');
  assert.equal(EFFECT_CAPABILITIES.start.retry, 'unsafe', 'and the table itself never moved');
});

/**
 * Review 1, item 8: an expired ticket must not leave the effect unknown forever.
 *
 * sweep() used to skip any effect that had EVER had a decision row, including one that expired -- a row nobody can decide
 * any more. The domain therefore stayed unknown with no path out. The repair re-opens against the CURRENT revision and
 * supersedes the stale row, in one transaction, idempotently.
 */
test('P4 §6.2.4: an expired ticket is re-opened against the current revision, and the sweep stays idempotent', async () => {
  const w = await team();
  try {
    w.core.member('member:root', 'root');
    seed(w, 'lifecycle:x', { kind: 'member-lifecycle', memberId: 'member:w', generation: 1 });
    const runner = w.runner({ ports: { 'member-lifecycle': () => ({ unknown: true }), message: () => ({ executed: true, receipt: {} }) },
      capabilities: caps(w, { readbacks: { session: () => ({ unknown: true, reason: 'no session-state port' }) } }) });
    try {
      runner.pump(); await runner.whenIdle();
      assert.equal(w.store.effects()[0].status, 'unknown');
      const first = w.store.list('decision:').filter(row => row.kind === 'unknown-effect');
      assert.equal(first.length, 1);
      // The clock sweep expires the row: it can never be decided again (DECISION_STALE), and the domain stays unknown.
      w.at += 900001;
      await w.host.cycle.run();
      assert.equal(w.store.read(first[0].entityId).state, 'expired');
      // The subject moves (the effect row is written again while it stays unknown), so the old row is not even about the
      // current revision any more.
      w.core.mutate('effect:lifecycle:x', 'adapter', {}, tx => tx.put('effect:lifecycle:x', {
        ...tx.read('effect:lifecycle:x'), note: 'moved' }));
      w.at = w.at + 900002;
      runner.pump(); await runner.whenIdle();
      const rows = w.store.list('decision:').filter(row => row.kind === 'unknown-effect');
      assert.equal(rows.length, 2, 'the expired row was replaced, not treated as an answer');
      const open = rows.filter(row => row.state === 'open');
      assert.equal(open.length, 1, 'exactly one open ticket exists again');
      assert.equal(open[0].subject.revision, w.store.read('effect:lifecycle:x').revision,
        'and it names the revision the effect is at now');
      assert.equal(w.store.read(first[0].entityId).state, 'superseded', 'the stale row is marked superseded');
      // The re-opened row is decidable, which is the whole point: the effect can leave unknown.
      w.core.decideDecision(open[0].entityId, 'member:root', { decision: 'effective' });
      assert.equal(w.store.read(open[0].entityId).state, 'decided');
      // ...and a further sweep opens nothing more.
      w.at = w.at + 100000;
      runner.pump(); await runner.whenIdle();
      assert.equal(w.store.list('decision:').filter(row => row.kind === 'unknown-effect').length, 2);
    } finally { runner.stop(); }
  } finally { await w.close(); }
});

for (const kind of ['wake', 'message', 'dispatch', 'intent-result']) test('' + kind + ' cannot convert unknown into notExecuted', async () => {
  const w = await team();
  try {
    const layer = createEffectCapabilities(caps(w));
    const result = await layer.closeOut({ effectId: 'uncertain:' + kind, kind, tries: 1,
      evidence: { unknown: true, reason: 'turn/start occurred before the port threw' }, request: {} });
    assert.equal(result.evidence.unknown, true);
    assert.notEqual(result.evidence.notExecuted, true);
    assert.ok(result.ticket);
    const refused = await layer.closeOut({ effectId: 'refused:' + kind, kind, tries: 1,
      evidence: { notExecuted: true, reason: 'refused before any wake' }, request: {} });
    assert.equal(refused.evidence.notExecuted, true, 'affirmative non-execution may still retry');
    assert.equal(refused.ticket, null);
  } finally { await w.close(); }
});

test('unsafe retry policy cannot erase affirmative non-execution proof', async () => {
  const w = await team();
  try {
    const layer = createEffectCapabilities(caps(w));
    for (const kind of ['start', 'cancel', 'dispose']) {
      const evidence = { notExecuted: true, reason: 'authorization refused before the port' };
      const result = await layer.closeOut({ effectId: 'refused:' + kind, kind, tries: 1, evidence, request: {} });
      assert.deepEqual(result.evidence, { ...evidence, executionOutcome:'notExecuted', retryPolicy:'exhausted', stopState:null });
      assert.equal(result.ticket, null);
      const uncertain = await layer.closeOut({ effectId: 'uncertain:' + kind, kind, tries: 1,
        evidence: { unknown: true, reason: 'entered port then threw' }, request: {} });
      assert.equal(uncertain.evidence.unknown, true, 'proof preservation must not turn unknown into notExecuted');
    }
  } finally { await w.close(); }
});

test('notExecuted survives every retry kind and an exhausted retry budget', async () => {
  const w = await team();
  try {
    const layer = createEffectCapabilities(caps(w));
    const readLayer=createEffectCapabilities(caps(w,{readbacks:{session:()=>({notExecuted:true,reason:'independent exact readback'})}}));
    const refused=await readLayer.closeOut({effectId:'readback:refused',kind:'cancel',tries:99,evidence:{unknown:true},request:{}});
    assert.equal(refused.evidence.notExecuted,true);assert.equal(refused.evidence.executionOutcome,'notExecuted');
    assert.equal(refused.evidence.retryPolicy,'exhausted');assert.equal(refused.ticket,null);
    const safe=await layer.closeOut({effectId:'safe:unknown',kind:'gc',tries:1,evidence:{unknown:true},request:{}});
    assert.equal(safe.evidence.unknown,true);assert.equal(safe.evidence.notExecuted,undefined);
    assert.equal(safe.evidence.executionOutcome,'unknown');assert.equal(safe.evidence.retryPolicy,'allowed');
    for (const kind of ['start', 'dispatch', 'wake', 'gc', 'delivery']) {
      const proof = { notExecuted: true, reason: 'authorization or port refused before IO' };
      const result = await layer.closeOut({ effectId: 'refusal:' + kind, kind, tries: 99, evidence: proof, request: {} });
      assert.deepEqual(result.evidence, { ...proof, executionOutcome:'notExecuted', retryPolicy:'exhausted', stopState:null }, kind);
      assert.equal(result.ticket, null);
    }
  } finally { await w.close(); }
});

test('every production settlement overwrites outcome/policy/stopState, including raw retry success and deferral',async()=>{
 const w=await team();try{
  w.core.mutate('seed:normalize','scheduler',{},tx=>{tx.outbox('normalize',{kind:'gc'});return null;});
  const layer=createEffectCapabilities(caps(w));
  const settle=async evidence=>{
   const claim=w.store.claim(w.core.command('claim:normalize','adapter',{}),'normalize','adapter',w.at).result;
   const decided=await layer.closeOut({effectId:'normalize',kind:'gc',tries:claim.tries,evidence,request:{}});
   return w.store.settle(w.core.command('settle:normalize','adapter',{}),'normalize',claim.fence,decided.evidence,null,w.at).result;
  };
  const refused=await settle({notExecuted:true,stopState:'unverified'});
  assert.equal(refused.executionOutcome,'notExecuted');assert.equal(refused.retryPolicy,'allowed');assert.equal(refused.stopState,'unverified');
  w.at+=10000;
  const claim=w.store.claim(w.core.command('claim:raw','adapter',{}),'normalize','adapter',w.at).result;
  const success=w.store.settle(w.core.command('settle:raw','adapter',{}),'normalize',claim.fence,{executed:true},null,w.at).result;
  assert.equal(success.status,'confirmed');assert.equal(success.executionOutcome,'executed');assert.equal(success.retryPolicy,'forbidden');assert.equal(
    success.stopState,null);
  const normalized=await layer.closeOut({effectId:'stale-fields',kind:'gc',tries:2,evidence:{executed:true,executionOutcome:'notExecuted',retryPolicy:
    'allowed'},request:{}});
  assert.equal(normalized.evidence.executionOutcome,'executed');assert.equal(normalized.evidence.retryPolicy,'forbidden');assert.equal(
    normalized.evidence.stopState,null);
 }finally{await w.close();}
});

