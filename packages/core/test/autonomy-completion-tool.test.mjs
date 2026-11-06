// Review 1, item 5: the owner completion tool has to read the session journal back, or the token it is about can never
// leave "unknown" and the team stays frozen.
//
// A completion verdict is decided on log evidence (§12 U7). The gate owns the reader; the profile publishes it as
// core.ports.sessionJournal; this entry asks it, outside the transaction, and hands the proof to the same reducer the
// owner channel uses. Two things the review found are pinned here: the row is addressed to the owner (or nobody sees it),
// and the proof can never come from the request body.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ControlStore } from '../../store/index.mjs';
import { TeamCore, GoalGate, handleTool } from '../index.mjs';
import { snapshot } from '../snapshot.mjs';
import { createGitGuardRunner } from '../../delivery/index.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../runs');

function team(label) {
  fs.mkdirSync(root, { recursive: true });
  const dir = fs.mkdtempSync(path.join(root, 'autonomy-completion-' + label + '-'));
  const store = new ControlStore(dir);
  const core = new TeamCore(store, {}, { enabled: true, autonomy: 'on', attach: true });
  core.member('member:root', 'root');
  return { dir, store, core, close() { core.store.close?.(); fs.rmSync(dir, { recursive: true, force: true }); } };
}

/** An authorized completion token whose goal the journal completes at revision 4. */
const EVENTS = [{ seq: 7, type: 'goal/change', data: { goal: { id: 'g2', revision: 4, phase: 'complete',
  objective: 'ship', maxGoalRounds: 4 } } }];
function unknownCompletion(t) {
  const tokenId = 'completion:t1';
  t.core.mutate(tokenId, 'root', {}, tx => tx.put(tokenId, { input: { sessionId: 's2',
    goal: { id: 'g2', revision: 3, objective: 'ship', maxGoalRounds: 4 } }, status: 'authorized' }));
  const gate = new GoalGate(t.core, () => {}, { gitGuard: createGitGuardRunner({ roots: [t.dir] }) });
  gate.reconcile({ id: 's2', snapshotEvents: () => EVENTS });
  const token = t.store.read(tokenId);
  const decision = t.store.list('decision:').find(row => row.subject?.id === tokenId);
  return { tokenId, token, decision, gate };
}

test('§12 U7: the completion row is addressed to the owner, so the owner inbox carries it', () => {
  const t = team('inbox');
  try {
    const { decision } = unknownCompletion(t);
    assert.ok(decision, 'an unknown completion opens a decision row');
    assert.equal(decision.kind, 'completion');
    assert.equal(decision.openedFor, 'member:root', 'the row is addressed to the owner, not to nobody');
    const candidate = snapshot(t.core, 'member:root', null, 0);
    assert.ok(candidate, 'the owner has a snapshot to read');
    const listed = candidate.payload.decisions ?? [];
    assert.ok(listed.some(row => row.id === decision.entityId), 'and the row that unfreezes the team is in it');
  } finally { t.close(); }
});

test('§12 U7: root decides a completion through team_decide, on the journal the profile reads back', () => {
  const t = team('tool');
  try {
    t.core.ports.sessionJournal = ({ sessionId }) => ({ sessionId, available: true, complete: true, events: EVENTS, seq: 7 });
    const { tokenId, decision } = unknownCompletion(t);
    assert.equal(t.store.read(tokenId).status, 'unknown');
    // A request that tries to carry its own journal is refused as an unknown field, before any reducer sees it.
    assert.throws(() => handleTool(t.core, { actor: 'member:root' }, 'team_decide',
      { operationId: 'v1:operation:completion-tool-1', decisionId: decision.entityId, decision: 'consumed',
        journal: { sessionId: 's2', seq: 7 } }), { code: 'INVALID_TOOL_FIELDS' });
    assert.equal(t.store.read(tokenId).status, 'unknown', 'and the token did not move');
    // The trusted entry asks the port, and the same reducer the owner channel uses applies the verdict.
    handleTool(t.core, { actor: 'member:root' }, 'team_decide', { operationId: 'v1:operation:completion-tool-2',
      decisionId: decision.entityId, decision: 'consumed', reason: 'the journal proves the completion' });
    assert.equal(t.store.read(tokenId).status, 'consumed');
    assert.equal(t.store.read(tokenId).seq, 7, 'the token records the event the journal showed');
    assert.equal(t.store.read(decision.entityId).state, 'decided');
    assert.equal(t.store.read(decision.entityId).verdict.byKind, 'owner');
  } finally { t.close(); }
});

test('§12 U7: a composition with no journal readback refuses instead of believing a verdict', () => {
  const t = team('no-port');
  try {
    const { tokenId, decision } = unknownCompletion(t);
    assert.throws(() => handleTool(t.core, { actor: 'member:root' }, 'team_decide',
      { operationId: 'v1:operation:completion-tool-3', decisionId: decision.entityId, decision: 'consumed' }),
    { code: 'SESSION_LOG_UNAVAILABLE' });
    assert.equal(t.store.read(tokenId).status, 'unknown');
    assert.equal(t.store.read(decision.entityId).state, 'open', 'a refused verdict leaves the row open');
  } finally { t.close(); }
});
test('review 1 #3 and #5: a consumed verdict closes the goal, and its replay never touches the journal again', () => {
  const t = team('goal');
  try {
    t.core.ports.sessionJournal = ({ sessionId }) => ({ sessionId, available: true, complete: true, events: EVENTS, seq: 7 });
    // The one goal row of the team (§5.2.1), open, as a running team has it.
    t.core.mutate('team-goal:team', 'root', {}, tx => tx.put('team-goal:team', { state: 'open', objective: 'ship',
      bases: [], openedAt: 1 }));
    const { tokenId, decision } = unknownCompletion(t);
    const args = { operationId: 'v1:operation:completion-tool-4', decisionId: decision.entityId, decision: 'consumed' };
    handleTool(t.core, { actor: 'member:root' }, 'team_decide', args);
    assert.equal(t.store.read(tokenId).status, 'consumed');
    const goal = t.store.read('team-goal:team');
    assert.equal(goal.state, 'completed', 'the consumed completion is what closes the goal (§5.2.2)');
    assert.equal(goal.completionTokenRef, tokenId, 'and the token that closed it stays named on the row');
    // Review 1 #5: the same call replayed once the journal can no longer be read answers with its own receipt. The
    // proof used to be read before the durable receipt was consulted, so a successful verdict failed its own retry.
    delete t.core.ports.sessionJournal;
    const replay = handleTool(t.core, { actor: 'member:root' }, 'team_decide', args);
    assert.equal(replay.status, 'confirmed');
    assert.equal(replay.entityId, 'tool-intent:' + args.operationId);
    assert.equal(t.store.read(tokenId).status, 'consumed');
    // A different payload under the same operationId is still a conflict, never a replay.
    assert.throws(() => handleTool(t.core, { actor: 'member:root' }, 'team_decide', { ...args, reason: 'different' }),
      { code: 'ID_CONFLICT' });
  } finally { t.close(); }
});

test('review 1 #3: a verdict that is refused still rewrites nothing, and a fresh call re-reads the journal', () => {
  const t = team('no-replay');
  try {
    t.core.mutate('team-goal:team', 'root', {}, tx => tx.put('team-goal:team', { state: 'open', objective: 'ship',
      bases: [], openedAt: 1 }));
    const { tokenId, decision } = unknownCompletion(t);
    assert.throws(() => handleTool(t.core, { actor: 'member:root' }, 'team_decide',
      { operationId: 'v1:operation:completion-tool-5', decisionId: decision.entityId, decision: 'consumed' }),
    { code: 'SESSION_LOG_UNAVAILABLE' });
    assert.equal(t.store.read(tokenId).status, 'unknown');
    assert.equal(t.store.read('team-goal:team').state, 'open', 'a refused verdict closes nothing');
    assert.equal(t.store.read(decision.entityId).state, 'open');
  } finally { t.close(); }
});
