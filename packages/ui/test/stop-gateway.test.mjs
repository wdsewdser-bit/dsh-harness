// WP-2 of the M6 plan (22-M6-plan.md §6 #12): the browser gateway gains the operator's stop close-out and nothing else.
//
// The core keeps two channels (core/effects.mjs, locked by core/test/stop-authority.test.mjs): the operator closes on a
// non-empty evidence reference, the adapter on a verified stop-proof row. The gateway only ever carries the operator
// one. A browser authenticates as a member, so no logged-in viewer can reach it, and the panel answers with a note
// instead of a button. The note names exactly the entry asserted here (projection-review.test.mjs).
import test from 'node:test';
import assert from 'node:assert/strict';
import { submit } from '../../projections/index.mjs';
import { realTeam, ROOT, WORKER } from './review-fixture.mjs';

const STUCK = 'attempt:stuck';

function stuck(team, id = STUCK) {
  team.put(id, { owner: WORKER, taskId: 'task:a', lease: 'unknown', status: 'unknown', fence: 1, generation: 1 });
}
function command(team, { id = STUCK, args = { evidenceRef: 'artifact:stop' }, expectedRevision } = {}) {
  return { name: 'organization.confirmStopped', target: id, args,
    expectedRevision: expectedRevision ?? team.store.read(id).revision };
}

test('only the operator principal may confirm a stop; root, members and the adapter channel are refused before any read', () => {
  const team = realTeam();
  try {
    team.put('artifact:stop', { summary: 'stop evidence' });
    stuck(team);
    for (const actor of [ROOT, WORKER, 'member:coord', 'adapter', 'member:ghost']) {
      const receipt = submit(team.core, actor, command(team));
      assert.equal(receipt.status, 'rejected', actor + ' is refused');
      assert.equal(receipt.message, 'ROLE_DENIED', actor + ' has no stop authority');
      assert.equal(team.store.read(STUCK).lease, 'unknown', actor + ': nothing moved');
    }
    assert.equal(team.store.list('break-glass:').length, 0, 'no close-out was written');
  } finally { team.close(); }
});

test('the operator entry needs stop evidence, the revision that was read, and an ambiguous attempt', () => {
  const team = realTeam();
  try {
    team.put('artifact:stop', { summary: 'stop evidence' });
    team.put('task:a', { owner: WORKER, status: 'executing', attemptId: STUCK, contractRevision: 1 });
    stuck(team);
    for (const args of [{}, { evidenceRef: '' }, { evidenceRef: '   ' }]) {
      const refused = submit(team.core, 'operator', command(team, { args }));
      assert.equal(refused.status, 'rejected');
      assert.equal(refused.message, 'EVIDENCE_REQUIRED');
    }
    const stale = submit(team.core, 'operator', command(team, { expectedRevision: 0 }));
    assert.equal(stale.status, 'conflict', 'the note asks for the revision that was read');
    assert.equal(team.store.read(STUCK).lease, 'unknown');
    const accepted = submit(team.core, 'operator', command(team));
    assert.equal(accepted.status, 'accepted');
    assert.equal(accepted.entityId, STUCK);
    assert.equal(accepted.revision, team.store.read(STUCK).revision);
    const closed = team.store.read(STUCK);
    assert.equal(closed.lease, 'revoked');
    assert.equal(closed.status, 'cancelled');
    assert.equal(closed.evidenceRef, 'artifact:stop');
    assert.equal(team.store.read('task:a').status, 'failed');
    assert.equal(team.store.list('break-glass:').length, 1, 'the operator path writes its break-glass exemption');
    assert.equal(submit(team.core, 'operator', command(team)).status, 'rejected', 'a closed lease is not closed twice');
  } finally { team.close(); }
});

test('a completion token freezes the operator entry too, and the browser still never reaches it', () => {
  const team = realTeam();
  try {
    team.put('artifact:stop', { summary: 'stop evidence' });
    team.put('task:a', { owner: WORKER, status: 'executing', attemptId: STUCK, contractRevision: 1 });
    stuck(team);
    team.put('completion:x', { status: 'prepared' });
    assert.equal(submit(team.core, ROOT, command(team)).message, 'ROLE_DENIED', 'the browser is refused on authority, not on state');
    const frozen = submit(team.core, 'operator', command(team));
    assert.equal(frozen.status, 'rejected', 'the core freeze gate applies to confirmStopped mutate, as the capability says');
    assert.equal(frozen.message, 'COMPLETION_FROZEN');
    assert.equal(team.store.read(STUCK).lease, 'unknown');
    assert.equal(team.store.read('completion:x').status, 'prepared');
  } finally { team.close(); }
});
