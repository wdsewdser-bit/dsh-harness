// P1 of the team-autonomy design (docs/decisions/team-autonomy-design.md §2, §9.4): the decision row.
//
// One row per thing that needs adjudication: a subject at a revision, the evidence, a closed option set, a TTL and one
// terminal state. Every verdict writes the domain change, its audit row and the operator notice in one transaction, or
// none of them. These tests pin the parts a later package must not be able to loosen: the option set, the self-judge
// rule (U1), the TTL (U8), the subject CAS, the completion-fence exemption, and the operator channel kept beside the
// owner one (U7).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ControlStore } from '../../store/index.mjs';
import { TeamCore } from '../index.mjs';
import { handleTool } from '../tools.mjs';
import { openDecision } from '../commands/decisions.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../runs');

function team(label, configuration = {}) {
  fs.mkdirSync(root, { recursive: true });
  const dir = fs.mkdtempSync(path.join(root, 'autonomy-decision-' + label + '-'));
  const store = new ControlStore(dir);
  const core = new TeamCore(store, {}, { enabled: true, autonomy: 'on', collab: 'on', intentWindowMs: 60000,
    ...configuration });
  core.member('member:root', 'root');
  core.member('member:a', 'worker');
  core.member('member:qa', 'verifier');
  return { dir, store, core, close() { core.store.close?.(); fs.rmSync(dir, { recursive: true, force: true }); } };
}

/**
 * The proposer opens an intent for its task and the verifier objects: the window closes as objected and, with the
 * switch on, one decision row is opened beside it.
 */
function objected(t, { proposer = 'member:a' } = {}) {
  const taskRef = proposer === 'member:root' ? 'task:root' : 'task:a';
  // A task is provisioned once: repairing it here would reset a row a scheduled attempt is already bound to.
  if (!t.core.store.read(taskRef)) t.core.task(taskRef, proposer, []);
  const sent = t.core.send(proposer, 'member:qa', 'intent', 'GET /todos returns {id,done}',
    { taskRef, contractRevision: 1, expectedOutcome: 'confirm the shape or object' }).result;
  t.core.replyIntent(sent.entityId, 'member:qa', 'object', 'the field is done, not completed');
  const decision = t.store.list('decision:').find(row => row.subject?.id === sent.entityId) ?? null;
  return { taskRef, sent, intent: t.store.read(sent.entityId), decision };
}

test('an objection opens one decision row in the same transaction, and the conclusion stays terminal', () => {
  const t = team('objection');
  try {
    const { sent, intent, decision } = objected(t);
    assert.equal(intent.decision, 'objected', 'the conclusion is still the immutable one (§2.2.3)');
    assert.ok(decision, 'the objection opened a decision row');
    assert.equal(decision.kind, 'objection');
    assert.equal(decision.state, 'open');
    assert.deepEqual(decision.options, ['waive', 'uphold', 'withdraw'], 'the closed set is fixed when the row opens');
    assert.deepEqual(decision.subject, { type: 'intent', id: sent.entityId, revision: intent.revision });
    assert.equal(decision.openedFor, 'member:a', 'the proposer is recorded, which is what makes U1 checkable');
    assert.equal(decision.opensBy, 'system');
    assert.ok(decision.evidence.length >= 1, 'a decision carries the evidence it was opened with');
    assert.ok(decision.expiresAt > decision.openedAt, 'the row has a TTL');
    assert.equal(intent.escalation.decisionRef, decision.entityId, 'the intent names the row that answers it');
    assert.equal(t.store.list('decision:').length, 1, 'one thing, one row');
  } finally { t.close(); }
});

test('the owner waives an objection against somebody else proposal: the revision publishes, the audit and the notice are written', () => {
  const t = team('waive');
  try {
    t.core.task('task:a', 'member:a', []);
    const attempt = t.core.schedule('admit-a', 'task:a').result;
    const { sent, decision } = objected(t);
    // The objection blocks the publish before the verdict...
    assert.throws(() => t.core.finish(attempt.attemptId, attempt.fence), { code: 'INTENT_OBJECTED' });
    const receipt = t.core.decideDecision(decision.entityId, 'member:root',
      { decision: 'waive', reason: 'the objection is about a field the next revision owns', evidenceRef: sent.entityId });
    assert.equal(receipt.result.state, 'decided');
    const decided = t.store.read(decision.entityId);
    assert.equal(decided.state, 'decided');
    assert.equal(decided.verdict.option, 'waive');
    assert.equal(decided.verdict.by, 'member:root');
    assert.equal(decided.verdict.byKind, 'owner');
    assert.equal(decided.verdict.evidenceRef, sent.entityId);
    assert.ok(decided.verdict.auditRef, 'the verdict points at its own audit row');
    // §9.4: who decided, on what evidence, with what option, on which subject revision.
    const audit = t.store.list('audit:').find(row => row.decisionId === decision.entityId);
    assert.ok(audit, 'the verdict left an audit row');
    assert.equal(audit.kind, 'decision');
    assert.equal(audit.by, 'member:root');
    assert.equal(audit.option, 'waive');
    assert.equal(audit.evidenceRef, sent.entityId);
    assert.equal(audit.priorRevision, decision.subject.revision);
    assert.equal(audit.operationId, receipt.operationId);
    // §2.2.7 item 2: one info notice to the operator, in the same transaction, that nobody has to accept.
    const notice = t.store.list('message:').find(row => row.decisionRef === decision.entityId);
    assert.ok(notice, 'the operator was told');
    assert.equal(notice.recipient, 'member:operator');
    assert.equal(notice.kind, 'info');
    assert.equal(notice.accepted, false);
    const read = handleTool(t.core, { actor: 'member:root' }, 'team_read', { view: 'message', limit: 50 });
    assert.ok(read.refs.some(row => row.entityId === notice.entityId), 'the notice is on the published read surface');
    // §2.2.3: the conclusion did not move; the waiver travels beside it and the gate reads the decision row.
    const waived = t.store.read(sent.entityId);
    assert.equal(waived.decision, 'objected');
    assert.equal(waived.waivers[0].decisionRef, decision.entityId);
    assert.equal(waived.waivers[0].contractRevision, 1);
    t.core.finish(attempt.attemptId, attempt.fence);
    assert.equal(t.store.read('task:a').status, 'produced', 'the waived revision publishes');
  } finally { t.close(); }
});

test('the owner cannot waive an objection against its own proposal (U1), and may still uphold it', () => {
  const t = team('self-judge');
  try {
    const { decision } = objected(t, { proposer: 'member:root' });
    assert.equal(decision.openedFor, 'member:root');
    assert.throws(() => t.core.decideDecision(decision.entityId, 'member:root',
      { decision: 'waive', reason: 'my own proposal' }), { code: 'SELF_JUDGE_DENIED' });
    const still = t.store.read(decision.entityId);
    assert.equal(still.state, 'open', 'a refused verdict leaves the row open');
    assert.equal(t.store.list('audit:').length, 0, 'and writes no audit row');
    t.core.decideDecision(decision.entityId, 'member:root', { decision: 'uphold', reason: 'the objection stands' });
    assert.equal(t.store.read(decision.entityId).state, 'decided');
    assert.equal(t.store.read(decision.entityId).verdict.option, 'uphold');
  } finally { t.close(); }
});

test('a decision is decided once: the second verdict is DECISION_STALE', () => {
  const t = team('duplicate');
  try {
    const { decision } = objected(t);
    t.core.decideDecision(decision.entityId, 'member:root', { decision: 'uphold' });
    assert.throws(() => t.core.decideDecision(decision.entityId, 'member:root', { decision: 'waive' }),
      { code: 'DECISION_STALE' });
    assert.equal(t.store.read(decision.entityId).verdict.option, 'uphold', 'the first verdict is the one that stands');
    assert.equal(t.store.list('audit:').length, 1, 'no second audit row');
  } finally { t.close(); }
});

test('the TTL expires the row without touching the domain, and a late verdict is DECISION_STALE (U8)', () => {
  const t = team('expiry');
  try {
    const { sent, decision } = objected(t);
    const before = JSON.stringify({ intent: t.store.read(sent.entityId), task: t.store.read('task:a') });
    // Move the deadline into the past: this is the clock having run out, which is the only thing TTL means.
    t.core.mutate(decision.entityId, 'root', { expiresAt: 1 },
      tx => tx.put(decision.entityId, { ...tx.read(decision.entityId), expiresAt: Date.now() - 1 }));
    t.core.tick(Date.now());
    const expired = t.store.read(decision.entityId);
    assert.equal(expired.state, 'expired');
    assert.ok(t.store.list('audit:').some(row => row.kind === 'decision-expiry' && row.decisionId === decision.entityId));
    const after = JSON.stringify({ intent: t.store.read(sent.entityId), task: t.store.read('task:a') });
    assert.equal(after, before, 'expiry changes no domain row, byte for byte');
    assert.throws(() => t.core.decideDecision(decision.entityId, 'member:root', { decision: 'waive' }),
      { code: 'DECISION_STALE' });
    // An expired row is never "approved": the intent is still objected and still blocks its revision.
    assert.equal(t.store.read(sent.entityId).decision, 'objected');
  } finally { t.close(); }
});

test('a subject that moved after the row opened is DECISION_STALE, never a verdict on a stale read', () => {
  const t = team('stale-subject');
  try {
    const { sent, decision } = objected(t);
    // A later reply to the closed window is audit only, but it does write the row: the subject has moved.
    t.core.replyIntent(sent.entityId, 'member:qa', 'ok', 'late acknowledgement');
    assert.notEqual(t.store.read(sent.entityId).revision, decision.subject.revision);
    assert.throws(() => t.core.decideDecision(decision.entityId, 'member:root', { decision: 'waive' }),
      { code: 'DECISION_STALE' });
    assert.equal(t.store.read(decision.entityId).state, 'open');
  } finally { t.close(); }
});

test('the decision entry survives the completion fence while every other write stays frozen (A9)', () => {
  const t = team('frozen');
  try {
    const { decision } = objected(t);
    const messageId = t.core.send('member:a', 'member:root', 'action', 'a responsibility for the owner',
      { expectedOutcome: 'a report', deadline: new Date(Date.now() + 600000).toISOString() }).result.entityId;
    // A prepared completion token freezes the team's business writes.
    t.core.mutate('completion:c1', 'root', {}, tx => tx.put('completion:c1', { status: 'prepared' }));
    assert.throws(() => t.core.acceptAsOwner(messageId, 'member:root'), { code: 'COMPLETION_FROZEN' });
    assert.throws(() => t.core.send('member:a', 'member:root', 'info', 'still frozen'), { code: 'COMPLETION_FROZEN' });
    // ...but the verdict on an open decision is the one entry that must work, because it is what unfreezes the team.
    t.core.decideDecision(decision.entityId, 'member:root', { decision: 'uphold', reason: 'decided while frozen' });
    assert.equal(t.store.read(decision.entityId).state, 'decided');
  } finally { t.close(); }
});

test('with the autonomy switch off no decision row is opened and the command does not run', () => {
  const t = team('off', { autonomy: 'off' });
  try {
    const { intent, decision } = objected(t);
    assert.equal(decision, null, 'an objection still closes the window and opens nothing');
    assert.equal(intent.escalation, undefined);
    assert.equal(t.store.list('decision:').length, 0);
    assert.throws(() => t.core.decideDecision('decision:none', 'member:root', { decision: 'waive' }),
      { code: 'DENIED' });
  } finally { t.close(); }
});

test('the operator channel beside the owner decides, and the audit says which channel it was (U7)', () => {
  const t = team('operator');
  try {
    const { decision } = objected(t);
    t.core.decideDecision(decision.entityId, 'operator', { decision: 'uphold', reason: 'operator verdict' }, 'operator');
    const decided = t.store.read(decision.entityId);
    assert.equal(decided.verdict.by, 'operator');
    assert.equal(decided.verdict.byKind, 'operator');
    const audit = t.store.list('audit:').find(row => row.decisionId === decision.entityId);
    assert.equal(audit.by, 'operator');
    assert.equal(audit.byKind, 'operator');
    // A member row cannot borrow the operator channel: it is refused before the reducer, by the reference rule that
    // already keeps a worker out of a row that is not addressed to it (DENIED would be the reducer's answer).
    assert.throws(() => t.core.decideDecision(decision.entityId, 'member:a', { decision: 'waive' }, 'operator'),
      error => ['DENIED', 'REFERENCE_ACL'].some(code => String(error.code).startsWith(code)));
  } finally { t.close(); }
});

test('an unknown effect is adjudicated through its own reducer, and a verdict without evidence leaves the row open (A2)', () => {
  const t = team('unknown-effect');
  try {
    const unknown = id => {
      t.core.mutate(id, 'root', {}, tx => tx.put(id, { sender: 'member:a', recipient: 'member:a', kind: 'action',
        status: 'unknown', stored: true, visible: true, accepted: false, generation: 1 }));
      const decisionId = 'decision:test-' + id.slice(8);
      t.core.mutate(decisionId, 'root', {}, tx => openDecision(tx,
        { autonomy: 'on', now: Date.now(), decisionTtlMs: 900000 },
        { kind: 'unknown-effect', decisionId,
          subject: { type: 'message', id, revision: tx.read(id).revision },
          evidence: [{ at: Date.now(), kind: 'row', ref: id, text: 'settle returned unknown' }],
          openedFor: 'member:a' }));
      return decisionId;
    };
    const first = unknown('message:unknown-1');
    assert.deepEqual(t.store.read(first).options, ['effective', 'not-effective', 'abandoned']);
    t.core.decideDecision(first, 'member:root', { decision: 'effective' });
    assert.equal(t.store.read('message:unknown-1').adjudication.decision, 'effective');
    assert.equal(t.store.read(first).state, 'decided');
    // A verdict the evidence contradicts keeps the row open and answers with the reducer's own refusal.
    const second = unknown('message:unknown-2');
    assert.throws(() => t.core.decideDecision(second, 'member:root',
      { decision: 'effective', evidenceRef: 'delivery:missing' }), { code: 'MISSING_EVIDENCE' });
    assert.equal(t.store.read(second).state, 'open');
    assert.equal(t.store.read('message:unknown-2').adjudication, undefined);
  } finally { t.close(); }
});
