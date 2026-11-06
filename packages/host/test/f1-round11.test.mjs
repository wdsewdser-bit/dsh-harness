import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ControlStore } from '../../store/index.mjs';
import { TeamCore } from '../../core/index.mjs';
import { createCoreAccess } from '../src/core-access.mjs';
import { InflightRegistry } from '../src/inflight.mjs';

/**
 * F1 round 11: two completion-fence gaps of the controlled write ports (design §3.5.1, §3.5.2).
 *
 *   R11-a  the ordinary registration is a write of its own: while a completion is pending it must not commit
 *          effect-ledger:<id> and must not open a managed token, because assertDispatch runs only after both.
 *   R11-b  the safety route still registers its frozen-period cancel: the fence belongs to the ordinary wrapper, never
 *          to the shared registration function.
 *   R11-c  the ordinary route carries no unbound settle, so a claim taken before the freeze cannot be closed with its
 *          fence afterwards; a receipt closes only an operation it was opened for.
 *   R11-d  a registered managed receipt still closes its operation while the team is frozen.
 *   R11-e  a registration taken before the freeze is still refused at assertDispatch: the fence is crossed before any
 *          IO, and the receipt that follows still closes its own operation without lifting the freeze.
 */
const rule = Object.freeze({ attemptId: 'attempt:a1', effectId: 'effect:cancel-a1' });

const cleanups = [];
afterEach(() => { for (const close of cleanups.splice(0)) close(); });

/** A real store and core behind a host-shaped port: the epoch, the host state and the lock are the only fakes. */
function world() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-r11-'));
  const store = new ControlStore(root);
  cleanups.push(() => { store.close(); fs.rmSync(root, { recursive: true, force: true }); });
  const core = new TeamCore(store, {}, { enabled: true, attach: true, teamId: 'team:r11' });
  core.mutate('seed', 'scheduler', {}, tx => {
    tx.put('attempt:a1', { owner: 'member:1', taskId: 'task:t1', lease: 'unknown', status: 'unknown', fence: 1, generation: 1 });
    tx.outbox('effect:e1', { kind: 'cancel', attemptId: 'attempt:a1' });
    tx.outbox('effect:cancel-a1', { kind: 'cancel', attemptId: 'attempt:a1' });
    return null;
  });
  const w = { core, store, state: 'running', epoch: 7, at: 1000, token: { epoch: 7, revoked: false }, inflight: new InflightRegistry() };
  w.ports = createCoreAccess({ teamId: 'team:r11', core, epoch: () => w.epoch, state: () => w.state, token: () => w.token,
    ownership: () => true, failure: () => null, inflight: w.inflight, now: () => w.at });
  return w;
}
const snapshot = w => JSON.stringify({ rows: w.store.list(), effects: w.store.effects(), events: w.store.events() });
const effectOf = (w, id) => w.store.effects().find(row => row.id === id);
const ledgerOf = (w, id) => w.store.read('effect-ledger:' + id);
const frozen = w => w.store.list('completion:').some(row => ['prepared', 'authorized', 'unknown'].includes(row.status));
/** One prepared completion: the team enters the completion freeze and stays there. */
const freeze = w => { w.core.mutate('completion:r11', 'root', {}, tx => tx.put('completion:r11', { status: 'prepared' })); };
const capability = w => w.ports.safety({ cause: 'recovery', subject: rule, commands: ['claim', 'register', 'settle'] });

test('R11-a a pending completion stops the ordinary registration before it writes the ledger', () => {
  const w = world();
  const lifecycle = w.ports.lifecycle();
  const claim = lifecycle.claim('effect:e1', 'adapter').result;
  assert.equal(effectOf(w, 'effect:e1').status, 'applying');
  assert.equal(ledgerOf(w, 'effect:e1'), null, 'a claim writes no ledger');
  freeze(w);
  assert.ok(frozen(w));
  const before = snapshot(w), open = w.inflight.size;
  assert.throws(() => lifecycle.registerEffect('effect:e1', claim.fence), { code: 'COMPLETION_FROZEN' });
  assert.equal(ledgerOf(w, 'effect:e1'), null, 'no effect-ledger row was written');
  assert.equal(w.inflight.size, open, 'no managed token was opened');
  assert.equal(snapshot(w), before, 'the refused registration wrote nothing at all');
  assert.equal(effectOf(w, 'effect:e1').status, 'applying', 'the effect is still exactly where the claim left it');
  assert.equal(effectOf(w, 'effect:e1').fence, claim.fence);
});

test('R11-b the safety route still registers its frozen-period cancel', () => {
  const w = world();
  freeze(w);
  const cap = capability(w);
  const claim = cap.claim(rule.effectId, 'adapter').result;
  assert.equal(ledgerOf(w, rule.effectId), null, 'nothing is registered yet');
  const managed = cap.registerEffect(rule.effectId, claim.fence);
  assert.ok(ledgerOf(w, rule.effectId), 'the safety registration landed while frozen');
  assert.equal(w.inflight.size, 1, 'and opened its managed token');
  assert.ok(frozen(w), 'the team is still frozen: registration is not an unfreeze');
  assert.equal(typeof managed.close, 'function');
});

test('R11-c a claim taken before the freeze cannot be closed by an unbound ordinary settle', () => {
  const w = world();
  const lifecycle = w.ports.lifecycle();
  // No unbound settle on the ordinary route at all: a receipt closes only what managed or safety opened.
  assert.equal(lifecycle.settle, undefined);
  const claim = lifecycle.claim('effect:e1', 'adapter').result;
  freeze(w);
  const before = snapshot(w);
  assert.equal(lifecycle.settle, undefined, 'and it does not come back under a freeze');
  // A fence and a made-up receipt are not an operation: the closes-out path needs a token this host actually opened.
  const forged = w.ports.managed({ token: { epoch: w.epoch, entityId: 'effect:e1', actor: 'adapter', command: 'effect.settle' } });
  assert.throws(() => forged.settle('effect:e1', claim.fence, { executed: true }), { code: 'INFLIGHT_UNKNOWN' });
  assert.equal(snapshot(w), before, 'the refused close-out wrote nothing');
  assert.equal(effectOf(w, 'effect:e1').status, 'applying', 'the effect claimed before the freeze is untouched');
  assert.equal(ledgerOf(w, 'effect:e1'), null, 'and was never registered');
});

test('R11-d a registered managed receipt still closes its operation while frozen', () => {
  const w = world();
  freeze(w);
  const cap = capability(w);
  const claim = cap.claim(rule.effectId, 'adapter').result;
  const managed = cap.registerEffect(rule.effectId, claim.fence);
  const receipt = managed.complete({ executed: true, receipt: { stopped: true, evidenceRef: 'evidence:stop' } });
  managed.close();
  assert.ok(receipt);
  assert.equal(effectOf(w, rule.effectId).status, 'confirmed', 'the receipt closed the effect');
  assert.equal(w.store.read('attempt:a1').lease, 'revoked', 'and its bound attempt');
  assert.equal(w.inflight.size, 0, 'the managed operation is closed');
  assert.ok(frozen(w), 'the receipt closed work; it did not lift the freeze');
});

test('R11-e an ordinary registration taken before the freeze still refuses its IO afterwards', () => {
  const w = world();
  const lifecycle = w.ports.lifecycle();
  const claim = lifecycle.claim(rule.effectId, 'adapter').result;
  // Registered while the team was open: the ledger row and the managed token both exist before the freeze.
  const managed = lifecycle.registerEffect(rule.effectId, claim.fence);
  assert.ok(ledgerOf(w, rule.effectId), 'the ordinary registration landed while unfrozen');
  assert.equal(w.inflight.size, 1);
  freeze(w);
  const before = snapshot(w);
  let io = 0;
  assert.throws(() => { managed.assertDispatch(); io++; }, { code: 'COMPLETION_FROZEN' });
  assert.equal(io, 0, 'the fence is crossed before any IO, never after it');
  assert.equal(snapshot(w), before, 'the refusal wrote nothing');
  // The receipt of the operation it opened is still a close-out, not new work.
  const receipt = managed.complete({ executed: true, receipt: { stopped: true, evidenceRef: 'evidence:stop' } });
  managed.close();
  assert.ok(receipt);
  assert.equal(effectOf(w, rule.effectId).status, 'confirmed', 'the receipt still closes its own operation');
  assert.equal(w.inflight.size, 0, 'the managed operation is closed');
  assert.ok(frozen(w), 'closing the receipt did not lift the freeze');
});
