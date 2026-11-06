import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ControlStore } from '../../store/index.mjs';
import { TeamCore, GoalGate } from '../../core/index.mjs';
function rig() {
 const root = fs.mkdtempSync(path.join(os.tmpdir(), 'f1-verdict-')); const store = new ControlStore(root);
 const core = new TeamCore(store, {}, { enabled: true });
 const goal = { id: 'goal:one', revision: 1, objective: 'finish', maxGoalRounds: 3 };
 let events = [{ seq: 7, type: 'goal/change', data: { goal: { ...goal, revision: 2, phase: 'complete' } } }];
 core.mutate('completion:one', 'operator', {}, tx => tx.put('completion:one', { status: 'unknown', input: { sessionId: 'session:one', goal } }));
 const gate = new GoalGate(core); const session = { id: 'session:one', seq: 7, snapshotEvents: () => events };
 return { core, store, gate, session, setEvents: value => { events = value; }, close() { store.close(); fs.rmSync(root, { recursive: true, force: true }); } };
}
for (const scenario of ['missing seq', 'other goal', 'field mismatch', 'not operator', 'opposite terminal']) test('completion verdict rejects ' + scenario, (
  ) => {
 const w = rig();
 try {
  let evidence = { seq: 7 }, actor = 'operator';
  if (scenario === 'missing seq') evidence = { seq: 999 };
  if (scenario === 'other goal') w.setEvents([{ seq: 7, type: 'goal/change', data: { goal: { id: 'goal:other', revision: 2, objective: 'finish',
    maxGoalRounds: 3, phase: 'complete' } } }]);
  if (scenario === 'field mismatch') w.setEvents([{ seq: 7, type: 'goal/change', data: { goal: { id: 'goal:one', revision: 2, objective: 'forged',
    maxGoalRounds: 3, phase: 'complete' } } }]);
  if (scenario === 'not operator') actor = 'root';
  if (scenario === 'opposite terminal') w.gate.resolveCompletion(w.session, 'completion:one', 'consumed', evidence, 'operator');
  const before = JSON.stringify(w.store.read('completion:one'));
  assert.throws(() => w.gate.resolveCompletion(w.session, 'completion:one', scenario === 'opposite terminal' ? 'cancelled' : 'consumed', evidence, actor),
    /DENIED|JOURNAL_CONFLICT/);
  assert.equal(JSON.stringify(w.store.read('completion:one')), before);
 } finally { w.close(); }
});
test('historical adjudication cannot short-circuit a newly unknown token', () => {
 const w = rig();
 try {
  w.gate.resolveCompletion(w.session, 'completion:one', 'consumed', { seq: 7 }, 'operator');
  w.core.mutate('completion:one', 'operator', {}, (tx, current) => tx.put('completion:one', { ...current, status: 'unknown' }));
  w.setEvents([]);
  assert.throws(() => w.gate.resolveCompletion(w.session, 'completion:one', 'consumed', { seq: 7 }, 'operator'), /JOURNAL_CONFLICT/);
  assert.equal(w.store.read('completion:one').status, 'unknown');
 } finally { w.close(); }
});
