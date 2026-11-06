// Offline protocol tests for M2b: the intent window (silence is consent) and the visibility facts it freezes.
//
// Every case runs against a real control store with no provider and no host: only the shared reducer, the clock and the
// published tool surface. The normative sentences are docs/host-protocol.md §4.2–§4.5 and invariant 8; the decision
// record is docs/decisions/M2b-collab-protocol.md.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ControlStore } from '../../store/index.mjs';
import { TeamCore } from '../index.mjs';
import { handleTool } from '../tools.mjs';
import { snapshot } from '../snapshot.mjs';
import { recordInjection, requestBoundary } from '../provenance.mjs';
import { hash } from '../../contracts/index.mjs';
import { intentRowAudit } from '../commands/intents.mjs';
import { cancelMessage, rebindMessage } from '../mailbox.mjs';
import { collabSettings, intentState } from '../collab.mjs';


import { root, future, INTENT_WINDOW_MS, team, pick, openIntent, carry, observe, reply, ledger } from '../test-support/collab-protocol-fixtures.mjs';

test('the generic mailbox refuses an intent on both admissions', () => {
  const t = team('mailbox-intent');
  try {
    const sent = openIntent(t, ['member:be']).result;
    const id = sent.entityId;
    const helperCancel = (() => { try { cancelMessage(t.core, id, 'member:fe', 'withdraw'); } catch (error) { return error; } })();
    assert.equal(helperCancel?.code, 'INTENT_NOT_CANCELLABLE');
    const uiCancel = (() => { try { t.core.dispatch(id, 'operator', {}, { type: 'message.cancel', payload: {
      messageId: id, reason: 'withdraw', policy: { admission: 'audited-ui' } } }); } catch (error) { return error; } })();
    assert.equal(uiCancel?.code, 'INTENT_NOT_CANCELLABLE');
    const helperRebind = (() => { try { rebindMessage(t.core, id, 'member:qa', 'artifact:1:label'); }
      catch (error) { return error; } })();
    assert.equal(helperRebind?.code, 'INTENT_NOT_REBINDABLE');
    const uiRebind = (() => { try { t.core.dispatch(id, 'operator', {}, { type: 'message.rebind', payload: {
      messageId: id, recipient: 'member:qa', evidenceRef: 'artifact:1:label', policy: { admission: 'audited-ui' } } });
    } catch (error) { return error; } })();
    assert.equal(uiRebind?.code, 'INTENT_NOT_REBINDABLE');
    // Nothing moved: the window is still the open row it was, with its recipient set and its close ahead of it.
    const row = t.store.read(id);
    assert.equal(row.status, 'open');
    assert.deepEqual(row.recipients, ['member:be']);
    assert(row.closesAt > Date.now());
    assert.equal(row.decision, null);
    // The same two admissions still apply to an addressed responsibility, so this is a rule about intents, not a
    // blanket refusal.
    const action = t.core.send('member:fe', 'member:be', 'action', 'do it',
      { expectedOutcome: 'x', deadline: future(60000) }).result.entityId;
    cancelMessage(t.core, action, 'member:fe', 'withdraw');
    assert.equal(t.store.read(action).status, 'cancelled');
  } finally { t.close(); }
});
test('finish cannot publish through a status the entry and the reducer read differently', () => {
  const t = team('finish-status');
  try {
    const attempt = t.attempt.fe;
    const finish = status => { try { t.core.finish(attempt.attemptId, attempt.fence, status); return null; }
      catch (error) { return error; } };
    const taskStatus = t.store.read('task:fe').status;
    const untouched = () => {
      assert.equal(t.store.read(attempt.attemptId).lease, 'active', 'the attempt is still the member\'s');
      assert.equal(t.store.read('task:fe').status, taskStatus, 'the task did not move');
    };
    // none: no intent at all. An explicit null used to read as "not a publish" here and as "the default publish" in the
    // reducer; it is a status nobody normalised, so it is refused before anything is written.
    const before = ledger(t);
    assert.equal(finish(null)?.code, 'INVALID_FINISH_STATUS');
    assert.equal(ledger(t), before, 'a refused finish writes nothing');
    untouched();
    assert.equal(finish('unknown')?.code, 'INVALID_FINISH_STATUS', 'the status set is closed');
    assert.equal(ledger(t), before);
    // open: the same argument is still not a publish, and the honest publish is still refused by the window.
    const sent = openIntent(t, ['member:be']).result;
    assert.equal(finish(null)?.code, 'INVALID_FINISH_STATUS');
    untouched();
    assert.equal(finish('produced')?.code, 'INTENT_WINDOW_OPEN');
    untouched();
    // objected: a withdrawn revision is blocked for the publish and still refuses the null status.
    reply(t, 'be', sent.entityId, 'object', 'the shape breaks the consumer');
    const beforeObjected = ledger(t);
    assert.equal(finish(null)?.code, 'INVALID_FINISH_STATUS');
    assert.equal(ledger(t), beforeObjected);
    assert.equal(finish('produced')?.code, 'INTENT_OBJECTED');
    assert.equal(ledger(t), beforeObjected);
    untouched();
    // Withdrawal is not a publish: cancel stays allowed with an objected revision, which is what teardown needs.
    assert.equal(finish('cancelled'), null, 'withdrawal needs no passing window');
    assert.deepEqual(t.store.read('task:fe').status, 'cancelled');
    assert.notEqual(t.store.read(attempt.attemptId).lease, 'active', 'the authorization is closed');
  } finally { t.close(); }
});

test('a snapshot cannot be relabelled as another genuine recipient', () => {
  const t = team('relabel');
  try {
    // One intent addressed to both members: B is a real recipient with a real binding of its own.
    const sent = openIntent(t, ['member:be', 'member:qa']).result;
    const row = t.store.read(sent.entityId);
    const forBe = snapshot(t.core, 'member:be');
    assert(forBe.manifest.messageIds.includes(sent.entityId));
    // Control: A's own manifest is accepted.
    assert(recordInjection(t.core, forBe, 'native:be', ['seq']).hash);
    // The forgery keeps A's text, payload, both hashes and messageIds, and only relabels the owner and its binding with
    // B's genuine generation: every binding is still "a legal binding", which is why checking them one by one is not
    // enough.
    const relabelled = { ...forBe, manifest: { ...forBe.manifest, memberId: 'member:qa',
      messageBindings: forBe.manifest.messageBindings.map(binding => ({ ...binding, recipient: 'member:qa',
        generation: row.generations['member:qa'], bindingGeneration: row.bindingGenerations['member:qa'] ?? 0 })) } };
    const refused = (() => { try { recordInjection(t.core, relabelled, 'native:qa', ['seq']); } catch (error) { return error; } })();
    assert.equal(refused?.code, 'INVALID_MANIFEST', 'a snapshot built for one member is not evidence for another member');
    assert.match(String(refused.detail ?? ''), /built for member:be/, 'the refusal names the owner the payload was built for');
    // Text and payload are the same document: a text that is not what the payload renders to is refused even when the
    // manifest hash was recomputed to match the substituted text.
    const forQa = snapshot(t.core, 'member:qa');
    const swapped = { ...forBe, text: forQa.text,
      manifest: { ...forBe.manifest, hash: hash(forQa.text) } };
    const mismatch = (() => { try { recordInjection(t.core, swapped, 'native:swap', ['seq']); } catch (error) { return error; } })();
    assert.match(String(mismatch?.code), /^INVALID_MANIFEST/, 'text not rendered from the payload is refused');
  } finally { t.close(); }
});
test('the frozen facts of a closed window are audited, not trusted', () => {
  const t = team('audit');
  try {
    const sent = openIntent(t, ['member:be', 'member:qa']).result;
    observe(t, 'member:be', sent.entityId);
    t.core.tick(sent.closesAt + 1);
    const row = t.store.read(sent.entityId);
    assert.equal(row.seenSummary, 'seenPartial');
    assert.deepEqual(intentRowAudit(row), { summaryMatches: true, everyRecipientFrozen: true,
      evidenceMatches: true, passedUnseenMatches: true }, 'a row the close wrote audits clean');
    // A flag flipped without the summary would make the printed counts lie.
    const flipped = { ...row, seenAtClose: { ...row.seenAtClose, 'member:qa': true } };
    assert.equal(intentRowAudit(flipped).summaryMatches, false);
    // "Saw it" without the evidence of a request that started inside the window is not a fact.
    const noEvidence = { ...row, seenAtClose: { ...row.seenAtClose, 'member:qa': true }, seenSummary: 'seenAll' };
    assert.equal(intentRowAudit(noEvidence).evidenceMatches, false);
    // ...and a summary that disagrees with the flags is the same defect in the other direction.
    assert.equal(intentRowAudit({ ...row, seenSummary: 'seenNone' }).summaryMatches, false);
    // passedUnseen is decided by the flags: nobody saw this window's other recipient, so a "seenAll" claim is rejected.
    assert.equal(intentRowAudit({ ...row, seenSummary: 'seenAll' }).passedUnseenMatches, false);
  } finally { t.close(); }
});

