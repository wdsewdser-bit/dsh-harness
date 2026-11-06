// UI gating for the frozen control plane (visual acceptance item 4a), offline and without a browser.
// React stands in for the loader's module; only pure decisions are exercised, no rendering.
import test from 'node:test';
import assert from 'node:assert/strict';

globalThis.React = { createElement: () => null, Fragment: Symbol('Fragment'), useState: () => [null, () => {}], useEffect: () => {},
  useRef: () => ({ current: null }), useSyncExternalStore: () => null, useMemo: x => x, useCallback: x => x };
globalThis.ReactDOM = { createPortal: () => null };

const { scenarioDefault, MOCK_VIEWER } = await import('../src/mock.mjs');
const { commandFor, frozenReason, explainError } = await import('../src/ui.mjs');
const { needsYou, unknownLabel, hasDeadline, relTime } = await import('../src/model.mjs');

const NOW = Date.UTC(2026, 9, 26, 14, 6);
const OP = MOCK_VIEWER;
const base = scenarioDefault(NOW);
// The frozen state: a prepared completion token, which is what the server freezes the control plane on.
const frozen = { ...base, goal: { ...base.goal, completionToken: 'prepared' } };
const writable = { ...base, goal: { ...base.goal, completionToken: 'none' } };

test('frozen: every administrative write is hard-disabled before submission, with the freeze as the reason', () => {
  const cases = [
    ['retire', base.members.find(m => m.id === 'member:worker-a')],
    ['escalate', base.threads.find(t => t.id === 'thr-7')],
    ['decide', base.threads.find(t => t.id === 'thr-7')],
    ['approval', base.approvals[0]],
    ['freeze', base.members.find(m => m.id === 'member:worker-b')],
    ['send', base.members.find(m => m.id === 'member:worker-b')],
  ];
  for (const [kind, obj] of cases) {
    const cmd = commandFor(kind, obj, frozen, OP);
    assert.equal(cmd.hardDisabled, true, kind + ' must not look usable while frozen');
    assert.match(cmd.disabledReason, /COMPLETION_FROZEN/, kind);
    assert.match(cmd.disabledReason, /冻结/, kind + ' explains the refusal in words');
    // A palette that cannot be submitted shows no form to fill in (decide/send keep their fields behind a blocked submit).
    if (['retire', 'escalate', 'approval', 'unknown'].includes(kind)) assert.deepEqual(cmd.fields, [], kind + ' shows no form it cannot submit');
  }
  // The two unknown verdicts are operator-only on the server, so for the root principal they are refused for that
  // reason rather than for the freeze; the operator principal sees the freeze. Both are disabled either way.
  for (const row of [{ id: 'message:msg-unknown', kind: 'external', ref: 'message:msg-unknown', summary: '投递回执丢失', evidence: [], revision: 4 },
    { id: 'delivery:task-13', kind: 'delivery', ref: 'delivery:task-13', summary: '目标 ref 已移动', evidence: [], revision: 7 }]) {
    const memberView = commandFor('unknown', row, frozen, OP);
    assert.equal(memberView.hardDisabled, true);
    assert.match(memberView.disabledReason, /operator/);
    const operatorView = commandFor('unknown', row, frozen, 'operator');
    assert.equal(operatorView.hardDisabled, true);
    assert.match(operatorView.disabledReason, /COMPLETION_FROZEN/);
    assert.equal(commandFor('unknown', row, writable, OP).hardDisabled, true, 'still not the root principal\'s to submit');
  }
  // The same commands are usable when the token is absent: the freeze is the only reason they were disabled.
  assert.equal(commandFor('retire', base.members.find(m => m.id === 'member:worker-a'), writable, OP).hardDisabled, false);
  assert.equal(commandFor('escalate', base.threads.find(t => t.id === 'thr-7'), writable, OP).hardDisabled, false);
  assert.equal(commandFor('approval', base.approvals[0], writable, OP).hardDisabled, false);
  assert.equal(commandFor('unknown', { id: 'delivery:task-13', kind: 'delivery', ref: 'x', summary: 's', evidence: [], revision: 7 }, writable,
    'operator').hardDisabled, false,
    'the operator gets the form once the freeze is gone');
  assert.equal(frozenReason(writable), null);
});

test('frozen: a non-root viewer still reads as a permission problem, not as a freeze', () => {
  const cmd = commandFor('retire', base.members.find(m => m.id === 'member:worker-a'), frozen, 'member:worker-a');
  assert.equal(cmd.hardDisabled, true);
  assert.match(cmd.disabledReason, /operator/);
});

test('unknown rows say what they are instead of "unknown unknown"', () => {
  const row = { id: 'read-model:context:member:a', kind: 'external', ref: 'read-model:context:member:a', summary: 'unknown', owner: 'member:a', revision: 2 };
  const label = unknownLabel(row);
  assert.doesNotMatch(label, /^unknown unknown$/);
  assert.match(label, /read-model/);
  assert.match(label, /context/);
  assert.match(label, /member:a/);
  // A committed summary still wins, and an id with a summary reads as both.
  assert.match(unknownLabel({ id: 'delivery:fixture-unknown', kind: 'delivery', summary: '把合入回执弄丢了' }), /把合入回执弄丢了/);
  const items = needsYou({ ...writable, unknownEffects: [row] }, NOW, OP);
  assert.equal(items.find(i => i.id === row.id).title, label, 'the needs list uses the same label');
});

test('a missing deadline is reported as missing, never as an elapsed time', () => {
  assert.equal(hasDeadline(null), false);
  assert.equal(hasDeadline(0), false);
  assert.equal(hasDeadline(undefined), false);
  assert.equal(hasDeadline(NaN), false);
  assert.equal(hasDeadline(NOW), true);
  // The regression the screenshot showed: a null/0 deadline measured against "now" read as 超期 498106h11m.
  assert.match(relTime(0 - NOW), /超期/, 'a zero deadline measured against now is what read as 超期 498106h11m');
  const approval = { ...base.approvals[0], deadline: null, openedAt: NOW - 1000 };
  const item = needsYou({ ...writable, approvals: [approval], unknownEffects: [], threads: [] }, NOW, OP)
    .find(i => i.id === approval.id);
  assert.equal(item.deadline, null);
  assert.equal(hasDeadline(item.deadline), false, 'the renderer prints 无截止时间 for this row');
});

test('server error codes carry an explanation and keep the raw code', () => {
  assert.match(explainError('COMPLETION_FROZEN').explanation, /冻结/);
  assert.match(explainError('ROLE_DENIED').explanation, /身份/);
  assert.match(explainError('UNSUPPORTED_COMMAND').explanation, /没有这个命令/);
  assert.equal(explainError('COMPLETION_FROZEN').code, 'COMPLETION_FROZEN');
  assert.equal(explainError('CAS_CONFLICT: member:a').code, 'CAS_CONFLICT');
  assert.equal(explainError('something else').explanation, null, 'an unknown code is shown verbatim, never invented');
});
