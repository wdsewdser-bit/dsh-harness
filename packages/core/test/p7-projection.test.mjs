// P7 (docs/decisions/team-autonomy-design.md §10 P7, appendix 8): the projection the owner panel reads.
//
// Two things are pinned here. First, that a team which never used P1-P6 produces the exact envelope it produced before
// this package: the added blocks are not empty arrays, they are absent, and the JSON of the legacy row set hashes to the
// value it hashed to with the pre-P7 view (the digest below was taken from git HEAD's view.mjs over this same fixture).
// Second, that a team which does use the packages has every one of them visible to root, and that a member sees only
// what names it.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ControlStore } from '../../store/index.mjs';
import { Projection } from '../../projections/index.mjs';
import { hash } from '../../contracts/index.mjs';
import { TeamCore, recordUsage, snapshot } from '../index.mjs';
import { delegate } from '../organization.mjs';
import { openDecision } from '../commands/decisions.mjs';
import { legacyRows } from '../test-support/p7-rows.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../runs');
/** The JSON of the pre-P7 view over `legacyRows()`: sha256 of the bytes HEAD's view.mjs produced from them. */
const LEGACY_DIGEST = 'e6fee0e81ba69c841a665bd0d87b2f020c9d030244b45e20b4de1308e0e925e2';
const LEGACY_KEYS = ['approvals', 'approvalsStatus', 'goal', 'groups', 'members', 'messages', 'restrictedMembers',
  'tasks', 'threads', 'unknownEffects'];

const later = () => new Date(Date.now() + 3600000).toISOString();

function team(label) {
  fs.mkdirSync(root, { recursive: true });
  const dir = fs.mkdtempSync(path.join(root, 'p7-projection-' + label + '-'));
  const repo = path.join(dir, 'repo');
  for (const name of ['a', 'b']) fs.mkdirSync(path.join(repo, name), { recursive: true });
  const store = new ControlStore(dir);
  const core = new TeamCore(store, {}, { enabled: true, attach: true, autonomy: 'on', teamId: 'team',
    subCoordinatorMinWorkers: 1 });
  core.member('member:root', 'root');
  core.member('member:a', 'worker', 'g1');
  core.member('member:qa', 'verifier', 'g1');
  core.member('member:coord', 'subCoordinator', 'g1');
  return { dir, repo, store, core, at: name => path.join(repo, name),
    close() { store.close?.(); fs.rmSync(dir, { recursive: true, force: true }); } };
}

const projectionOf = store => new Projection({ events: seq => store.events(seq), scanEvents: seq => store.scanEvents(seq) });

test('appendix 8: the envelope of a team that never used P1-P6 is byte for byte the one the pre-P7 view built', () => {
  // Two steps, both pinned: the replay must reproduce the fixture exactly (so the hash compares like for like), and the
  // envelope the projection builds from it must be the one HEAD's view.mjs built from the same rows.
  const rows = legacyRows();
  const events = [...rows.values()].map((row, index) => ({ seq: index + 1, entity: row.entityId,
    revision: row.revision, payload: row }));
  // The byte oracle must exercise the default production constructor, never a legacy-only branch.
  const reader = { events: seq => events.filter(event => event.seq > seq) };
  const projection = new Projection(reader);
  const before = projection.snapshot('member:root').data;
  assert.equal(JSON.stringify([...projection.rows]), JSON.stringify([...rows]), 'the replay reproduced the fixture');
  assert.equal(hash(JSON.stringify(before)), LEGACY_DIGEST, 'the legacy envelope changed');
  assert.deepEqual(Object.keys(before).sort(), LEGACY_KEYS, 'no autonomy key may appear for a team with none of the facts');
  const worker = projection.snapshot('member:a').data;
  assert.deepEqual(Object.keys(worker).sort(), LEGACY_KEYS, 'the same is true for a member view');
  // No M6 facts: compare every existing value and the complete bytes, not only entity IDs.
  const panel = new Projection(reader).snapshot('member:root').data;
  assert.deepEqual(Object.keys(panel).sort(), LEGACY_KEYS, 'off teams omit M6 blocks on the default path');
  assert.equal(JSON.stringify(panel), JSON.stringify(before), 'all existing field values are byte identical');
  assert.equal('summary' in before, false, 'the legacy shape has no panel blocks');
  for (const key of ['approvals', 'members', 'messages', 'tasks', 'threads', 'unknownEffects']) {
    assert.deepEqual(panel[key], before[key], key + ': same rows, same order');
  }
});

test('appendix 8: decisions, audit, goal, stop proofs, effects, budget, groups and workspaces reach root', () => {
  const t = team('full');
  try {
    delegate(t.core, 'delegation:d1', 'member:coord', [t.repo],
      { tasks: 4, concurrency: 2, tokens: { inputLimit: 100, outputLimit: 60 } }, later());
    t.core.task('task:a', 'member:a', [t.at('a')], { delegationRef: 'delegation:d1' });
    t.core.schedule('admit-a', 'task:a');
    recordUsage(t.core, { memberId: 'member:a', sessionId: 's1', input: 70, output: 20, source: 'usage-event',
      eventKey: 'session:s1:1', revision: 1, totalInput: 70, totalOutput: 20 });
    t.core.mutate('group:g1', 'root', {}, tx => tx.put('group:g1', { name: 'g1', lead: 'member:coord',
      createdAt: 150, by: 'member:root' }));
    t.core.mutate('member.workspace:member:a', 'adapter', {}, tx => tx.put('member.workspace:member:a', {
      memberId: 'member:a', relPath: 'work/a', base: t.repo, resolved: path.join(t.repo, 'work', 'a'),
      recordedAt: 160, by: 'member:root', lockedAt: 170 }));
    t.core.mutate('stop-proof:member:qa:1:1', 'adapter', {}, tx => tx.put('stop-proof:member:qa:1:1', {
      kind: 'stop-proof', subject: { kind: 'member', id: 'member:qa', fence: 1 }, verified: true,
      method: 'in-process-session', confidence: 'medium', writtenBy: 'adapter', switch: 'on', at: 5000,
      roots: [4242], polls: 3 }));
    t.core.mutate('effect:start:1', 'adapter', {}, tx => tx.put('effect:start:1', { effectId: 'start:1',
      payload: { kind: 'start' }, status: 'unknown', tries: 2, fence: 0, nextDue: 0 }));
    t.core.mutate('effect-evidence:start:1', 'adapter', {}, tx => tx.put('effect-evidence:start:1', {
      effectId: 'start:1', kind: 'start', code: 'EFFECT_RETRY_EXHAUSTED', message: 'the safe retry cap was reached',
      attempts: 2, evidence: null, at: 6000, switch: 'on' }));
    t.core.mutate('team-goal:team', 'root', {}, tx => tx.put('team-goal:team', { id: 'team-goal:team',
      objective: 'ship P7', openedBy: 'member:root', openedAt: 100, state: 'open',
      bases: [{ key: { realCommonDir: '/repo', target: 'main' }, directory: '/repo', target: 'main',
        commit: 'abcdef1', tree: 'abcdef2', recordedAt: 100 }],
      legacy: { mode: 'adopt-tail', chains: [{ key: { realCommonDir: '/repo', target: 'main' },
        tail: { commit: 'abcdef1', tree: 'abcdef2' }, deliveries: [{ deliveryId: 'delivery:1' }] }] },
      completionTokenRef: null }));
    // A real decision and its real verdict, so the audit row is the one the reducer writes.
    t.core.mutate('usage-unknown:member:a', 'adapter', {}, tx => tx.put('usage-unknown:member:a',
      { memberId: 'member:a', since: 1, lastAt: 2 }));
    const now = Date.now();
    const open = id => t.core.mutate(id, 'adapter', {}, tx => openDecision(tx, { autonomy: 'on', now, decisionTtlMs: 60000 },
      { kind: 'budget-unknown', subject: { type: 'budget', id: 'usage-unknown:member:a', revision: 1 },
        openedFor: 'member:root', decisionId: id, fallback: 'stay',
        evidence: [{ at: now, kind: 'usage', ref: 'usage-unknown:member:a', text: 'no token measurement for 90s' }] }));
    open('decision:open');
    open('decision:decided');
    t.core.decideDecision('decision:decided', 'member:root', { decision: 'continue', reason: 'keep the team running',
      evidenceRef: 'usage-unknown:member:a' });
    const data = projectionOf(t.store).snapshot('member:root').data;
    const decided = data.decisions.find(row => row.id === 'decision:decided');
    assert.equal(decided.state, 'decided');
    assert.equal(decided.verdict.option, 'continue');
    assert.deepEqual(decided.options, ['continue', 'stop'], 'the closed option set travels with the row');
    assert.deepEqual(decided.evidence.map(entry => entry.ref), ['usage-unknown:member:a'], 'evidence refs travel too');
    const openRow = data.decisions.find(row => row.id === 'decision:open');
    assert.equal(openRow.state, 'open');
    // openDecision's default TTL is 15 minutes (§12 U8); the projection reports what is left of it.
    assert(openRow.ttlRemainingMs > 0 && openRow.ttlRemainingMs <= 900000, 'the UI can count down: ' + openRow.ttlRemainingMs);
    assert.equal(data.auditTrail.length, 1, 'one verdict, one audit row');
    assert.equal(data.auditTrail[0].option, 'continue');
    assert.equal(data.auditTrail[0].by, 'member:root');
    assert.equal(data.teamGoal.objective, 'ship P7');
    assert.equal(data.teamGoal.bases.length, 1);
    assert.equal(data.teamGoal.bases[0].commit, 'abcdef1', 'the initial base of every target');
    assert.equal(data.teamGoal.legacy.mode, 'adopt-tail', 'the legacy chain hint');
    assert.equal(data.teamGoal.legacy.chains[0].deliveries, 1);
    assert.equal(data.stopProofs.length, 1);
    assert.equal(data.stopProofs[0].verified, true);
    assert.equal(data.stopProofs[0].subject.id, 'member:qa');
    assert.equal(data.stopProofs[0].method, 'in-process-session');
    assert.equal(data.effects.unknown.length, 1);
    assert.equal(data.effects.unknown[0].kind, 'start');
    assert.equal(data.effects.unknown[0].code, 'EFFECT_RETRY_EXHAUSTED', 'the capability verdict the adapter reached');
    assert.equal(data.effects.tickets.length, 1);
    assert.deepEqual(data.effects.kinds, [{ kind: 'start', effects: 1, unknown: 1 }]);
    const budget = data.budget.delegations[0];
    assert.deepEqual(budget.tasks, { used: 1, limit: 4 });
    assert.deepEqual(budget.concurrency, { running: 1, limit: 2 });
    assert.equal(budget.tokens.input, 70);
    assert.equal(budget.tokens.output, 20);
    assert.equal(budget.tokens.inputLimit, 100);
    assert.equal('cost' in budget.tokens, false, 'no price table is reachable from rows: appendix 8 says so');
    const group = data.groups.find(entry => entry.id === 'g1');
    assert.equal(group.lead, 'member:coord', 'the group row supplies the lead');
    assert.equal(group.by, 'member:root');
    assert.equal(data.members.find(member => member.id === 'member:a').workspace.relPath, 'work/a');
  } finally { t.close(); }
});

test('appendix 8: a member reads its own workspace, not the owner inbox', () => {
  const t = team('member');
  try {
    t.core.mutate('member.workspace:member:a', 'adapter', {}, tx => tx.put('member.workspace:member:a', {
      memberId: 'member:a', relPath: 'work/a', base: t.repo, resolved: path.join(t.repo, 'work', 'a'),
      recordedAt: 160, by: 'member:root', lockedAt: 170 }));
    t.core.mutate('decision:d1', 'adapter', {}, tx => openDecision(tx, { autonomy: 'on', decisionTtlMs: 60000 },
      { kind: 'budget-unknown', subject: { type: 'budget', id: 'usage-unknown:member:a', revision: 1 },
        openedFor: 'member:root', decisionId: 'decision:d1', fallback: 'stay',
        evidence: [{ at: 1, kind: 'usage', ref: 'usage-unknown:member:a', text: 'gap' }] }));
    const data = projectionOf(t.store).snapshot('member:a').data;
    assert.equal(data.decisions, undefined, 'the decision inbox belongs to the owner');
    assert.equal(data.auditTrail, undefined);
    assert.equal(data.members.find(member => member.id === 'member:a').workspace.relPath, 'work/a', 'its own workspace');
  } finally { t.close(); }
});

test('appendix 8: the member snapshot names the goal it works under and the decisions addressed to it', () => {
  const t = team('snapshot');
  try {
    const before = snapshot(t.core, 'member:a');
    assert.deepEqual(before.payload.goal, { ref: 'goal', acceptanceGaps: ['P3b delivery and Goal veto pending'] },
      'with no goal record the placeholder is untouched');
    assert.equal('decisions' in before.payload, false);
    const teamId = t.core.configuration.teamId;
    t.core.mutate('team-goal:' + teamId, 'root', {}, tx => tx.put('team-goal:' + teamId, { id: 'team-goal:' + teamId,
      objective: 'ship P7', openedBy: 'member:root', openedAt: 100, state: 'open',
      bases: [{ key: { realCommonDir: '/repo', target: 'main' }, directory: '/repo', target: 'main',
        commit: 'abcdef1', tree: 'abcdef2' }], completionTokenRef: null }));
    t.core.mutate('decision:d1', 'adapter', {}, tx => openDecision(tx, { autonomy: 'on', decisionTtlMs: 60000 },
      { kind: 'budget-unknown', subject: { type: 'budget', id: 'usage-unknown:member:a', revision: 1 },
        openedFor: 'member:a', decisionId: 'decision:d1', fallback: 'stay',
        evidence: [{ at: 1, kind: 'usage', ref: 'usage-unknown:member:a', text: 'gap' }] }));
    const after = snapshot(t.core, 'member:a');
    assert.equal(after.payload.goal.ref, 'team-goal:' + teamId);
    assert.equal(after.payload.goal.state, 'open');
    assert.equal(after.payload.goal.bases, 1);
    assert.equal(after.payload.decisions.length, 1);
    assert.equal(after.payload.decisions[0].id, 'decision:d1');
    assert.equal(after.payload.decisions[0].kind, 'budget-unknown');
    assert.match(after.text, /team-goal:team/, 'and the rendered text carries it');
  } finally { t.close(); }
});
