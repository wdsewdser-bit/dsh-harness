// Command assembly for the administrative writes opened on the server (09 §3.3, projection.mjs COMMANDS).
// ui.mjs is a browser module (React comes from the DSH module loader): stub the two globals, then import it.
import test from 'node:test';
import assert from 'node:assert/strict';

globalThis.React = { createElement: () => null, Fragment: Symbol('Fragment'), useState: () => [null, () => {}], useEffect: () => {},
  useRef: () => ({ current: null }), useSyncExternalStore: () => null, useMemo: x => x, useCallback: x => x };
globalThis.ReactDOM = { createPortal: () => null };

const { scenarioDefault, MOCK_VIEWER } = await import('../src/mock.mjs');
const { commandFor, retireAction, retireOperationId } = await import('../src/ui.mjs');
const { COMMANDS, unsupportedReason } = await import('../src/projection.mjs');

const NOW = Date.UTC(2026, 9, 26, 14, 6);
const data = scenarioDefault(NOW);
const OP = MOCK_VIEWER;                        // the operator works through the root principal
const WORKER = 'member:worker-a';
const member = name => data.members.find(m => m.id === 'member:' + name);
const thread = id => data.threads.find(t => t.id === id);
const message = id => data.messages.find(m => m.id === id);
const field = (cmd, key) => (cmd.fields ?? []).find(f => f.key === key) ?? null;

test('every newly opened command is in the server table and no longer reports UNSUPPORTED_COMMAND', () => {
  for (const name of ['organization.retire', 'threads.escalate', 'mailbox.cancelMessage', 'mailbox.rebind',
    'mailbox.resolveUnknown', 'scheduler.approveContract', 'delivery.reconcile']) {
    assert.ok(COMMANDS[name], name);
    assert.equal(unsupportedReason(name), null, name);
  }
  assert.ok(unsupportedReason('goal-gate.authorizeCompletion'), 'goal gate stays disabled with its reason');
});

test('organization.retire: target = member, expectedRevision = the member current revision, reason field', () => {
  const m = member('worker-a');
  const cmd = commandFor('retire', m, data, OP);
  assert.equal(cmd.name, 'organization.retire');
  assert.equal(cmd.target, m.id);
  assert.equal(cmd.expectedRevision, m.revision);
  assert.deepEqual(cmd.args, {});
  assert.equal(cmd.disabledReason, null);
  assert.equal(field(cmd, 'reason').required, true);
});

test('threads.escalate: target = thread, expectedRevision = thread revision, reason required', () => {
  const t = thread('thr-7');
  const cmd = commandFor('escalate', t, data, OP);
  assert.equal(cmd.name, 'threads.escalate');
  assert.equal(cmd.target, t.id);
  assert.equal(cmd.expectedRevision, t.revision);
  assert.deepEqual(cmd.args, {});
  assert.equal(cmd.disabledReason, null);
  assert.equal(field(cmd, 'reason').required, true);
});

test('mailbox.cancelMessage: target = message, expectedRevision = message revision, reason required', () => {
  const m = message('msg-88');
  const cmd = commandFor('cancelMessage', m, data, OP);
  assert.equal(cmd.name, 'mailbox.cancelMessage');
  assert.equal(cmd.target, m.id);
  assert.equal(cmd.expectedRevision, m.revision);
  assert.equal(field(cmd, 'reason').required, true);
  assert.match(cmd.notes.join(' '), /不撤销已经发生的副作用/);
});

test('mailbox.rebind: target = message, recipient + evidenceRef fields; current/retired members are not offered', () => {
  const m = message('msg-88');
  const cmd = commandFor('rebind', m, data, OP);
  assert.equal(cmd.name, 'mailbox.rebind');
  assert.equal(cmd.target, m.id);
  assert.equal(cmd.expectedRevision, m.revision);
  assert.deepEqual(cmd.args, {});
  const recipient = field(cmd, 'recipient'), evidence = field(cmd, 'evidenceRef');
  assert.equal(recipient.required, true); assert.equal(evidence.required, true);
  const offered = recipient.options.map(([id]) => id);
  assert.ok(!offered.includes(m.to), 'the current recipient is not offered');
  assert.ok(!offered.includes('member:worker-r'), 'a retired member is not offered');
  assert.equal(evidence.validate('artifact:evidence'), null);
  assert.match(evidence.validate('nope'), /kind/);
});

// The verdict on an unknown effect is operator-only on the server (core/mailbox.mjs, delivery/index.mjs): root and
// every member are refused with ROLE_DENIED, so the panel only offers it to the operator principal.
const OPERATOR = 'operator';
test('mailbox.resolveUnknown: message:* unknown row, decision + evidenceRef, a verdict replays nothing', () => {
  const row = { id: 'message:msg-unknown', kind: 'external', ref: 'message:msg-unknown', summary: '投递回执丢失',
    evidence: ['outbox 已提交'], openedAt: NOW - 1000, revision: 4 };
  const cmd = commandFor('unknown', row, data, OPERATOR);
  assert.equal(cmd.name, 'mailbox.resolveUnknown');
  assert.equal(cmd.target, 'message:msg-unknown');
  assert.equal(cmd.expectedRevision, 4);
  assert.deepEqual(cmd.args, {});
  const decision = field(cmd, 'decision');
  assert.deepEqual(decision.options.map(([v]) => v), ['effective', 'not-effective', 'abandoned']);
  assert.equal(decision.value, '', 'no verdict is preselected');
  assert.equal(decision.required, true);
  assert.equal(field(cmd, 'evidenceRef').required, true);
  assert.match(cmd.notes.join(' '), /不会重放外部效果/);
  assert.match(cmd.notes.join(' '), /不会变成/);
});

test('delivery.reconcile: delivery:* unknown row keeps expectedRevision = delivery revision and stays a verdict', () => {
  const row = { id: 'delivery:task-13', kind: 'delivery', ref: 'delivery:task-13', summary: '目标 ref 已移动',
    evidence: ['refs/heads/main 现为 9f2c1e7'], openedAt: NOW - 1000, revision: 7 };
  const cmd = commandFor('unknown', row, data, OPERATOR);
  assert.equal(cmd.name, 'delivery.reconcile');
  assert.equal(cmd.target, 'delivery:task-13');
  assert.equal(cmd.expectedRevision, 7);
  assert.deepEqual(field(cmd, 'decision').options.map(([v]) => v), ['effective', 'not-effective', 'abandoned']);
  assert.match(cmd.impact.join(' '), /独立证书读回/, 'a verdict is not a certified acceptance');
});

test('unknown rows the server cannot adjudicate are hard-disabled, never sent to a delivery:/message: command', () => {
  const cmd = commandFor('unknown', data.unknownEffects[0], data, OP); // fixture id 'op-91' (an effect, not an entity)
  assert.equal(cmd.name, null);
  assert.equal(cmd.hardDisabled, true);
  assert.match(cmd.disabledReason, /delivery:/);
  assert.deepEqual(cmd.fields, []);
});

test('scheduler.approveContract: target = the task, expectedRevision = task revision, contractRevision from the task', () => {
  const a = data.approvals[0];
  const task = data.tasks.find(t => t.id === a.task);
  assert.ok(task, 'the fixture approval points at a projected task');
  const cmd = commandFor('approval', a, data, OP);
  assert.equal(cmd.name, 'scheduler.approveContract');
  assert.equal(cmd.target, task.id);
  assert.notEqual(cmd.target, a.id, 'never CAS the approval row');
  assert.equal(cmd.expectedRevision, task.revision);
  assert.deepEqual(cmd.args, { contractRevision: task.contractRevision });
  assert.equal(field(cmd, 'contractRevision').value, task.contractRevision);
  assert.equal(field(cmd, 'contractRevision').validate(task.contractRevision), null);
  assert.match(field(cmd, 'contractRevision').validate(task.contractRevision + 1), /已变化/);
});

test('a task missing from the projection disables the approval instead of inventing an expectedRevision', () => {
  const cmd = commandFor('approval', { ...data.approvals[0], task: 'task:gone' }, data, OP);
  assert.equal(cmd.expectedRevision, null);
  assert.equal(cmd.hardDisabled, true);
  assert.match(cmd.disabledReason, /task:gone/);
  assert.deepEqual(cmd.fields, []);
});

test('a viewer that is not operator/root: administrative commands are hard-disabled with a reason', () => {
  const cases = [
    ['retire', member('worker-a')], ['escalate', thread('thr-7')], ['cancelMessage', message('msg-88')],
    ['rebind', message('msg-88')], ['approval', data.approvals[0]],
    ['unknown', { id: 'message:msg-unknown', kind: 'external', ref: 'x', summary: 's', evidence: [], revision: 1 }],
  ];
  for (const [kind, obj] of cases) {
    const cmd = commandFor(kind, obj, data, WORKER);
    assert.equal(cmd.hardDisabled, true, kind);
    assert.match(cmd.disabledReason, /operator/, kind);
    assert.deepEqual(cmd.fields, [], kind + ' shows no input it cannot submit');
  }
  // No viewer at all is never treated as the operator either.
  assert.equal(commandFor('retire', member('worker-a'), data, null).hardDisabled, true);
  // Non-administrative commands keep their existing wiring.
  assert.equal(commandFor('send', member('worker-b'), data, WORKER).name, 'mailbox.send');
  assert.equal(commandFor('freeze', member('worker-b'), data, WORKER).hardDisabled, false);
});

test('expectedRevision comes from the projection and follows it (never the newest value to bypass a conflict)', () => {
  const m = member('worker-a');
  assert.equal(commandFor('retire', m, data, OP).expectedRevision, m.revision);
  const stale = { ...m, revision: m.revision - 2 };
  assert.equal(commandFor('retire', stale, data, OP).expectedRevision, stale.revision);
  assert.notEqual(commandFor('retire', stale, data, OP).expectedRevision, m.revision);
  const t = thread('thr-7');
  assert.equal(commandFor('escalate', { ...t, revision: t.revision + 3 }, data, OP).expectedRevision, t.revision + 3);
});

test('no panel note interpolates an unsupportedReason() result that can now be null', async () => {
  const fs = await import('node:fs');
  // M6 WP-3 split the panel into src/ui/*; the scan follows the same source it always did, now across the parts.
  const dir = new URL('../src/ui/', import.meta.url);
  const src = [fs.readFileSync(new URL('../src/ui.mjs', import.meta.url), 'utf8'),
    ...fs.readdirSync(dir).filter(file => file.endsWith('.mjs')).map(file => fs.readFileSync(new URL(file, dir), 'utf8'))].join('\n');
  // The old bug: a note rendered "退役：" + unsupportedReason(...) and printed "退役：null" once the command was opened.
  assert.ok(!src.includes('${unsupportedReason('), 'unsupportedReason() is never interpolated directly');
  assert.ok(!/\.replace\(/.test(src.slice(src.indexOf("unsupportedReason('mailbox.cancelMessage')"))), 'no .replace on an unsupportedReason() result');
  for (const name of ['organization.retire', 'threads.escalate', 'mailbox.cancelMessage']) {
    assert.ok(src.includes('unsupportedReason(\'' + name + '\')'), name + ' note is still guarded by a null check');
  }
});

test('a retire keeps one publishable operationId per member and generation', () => {
  const m = member('worker-a');
  const cmd = commandFor('retire', m, data, OP);
  assert.equal(cmd.operationId, retireOperationId(m));
  // Stable across re-renders of the same member: a repeat click replays the durable receipt instead of queueing a
  // second intent. A new generation (after a completed retire) is a different intent and gets a different id.
  assert.equal(commandFor('retire', { ...m }, data, OP).operationId, cmd.operationId);
  assert.match(cmd.operationId, /^v1:operation:[A-Za-z0-9._-]{8,128}$/);
  assert.notEqual(commandFor('retire', { ...m, generation: (m.generation ?? 1) + 1 }, data, OP).operationId, cmd.operationId);
  // Only retire carries it; the other administrative writes keep their existing wiring.
  assert.equal(commandFor('freeze', m, data, OP).operationId, undefined);
});

test('the retire button is disabled and reports the wait while the retirement is in flight', () => {
  const m = member('worker-a');
  assert.deepEqual(retireAction(m, NOW), { disabled: false, label: '退役…', waited: null });
  const pending = { ...m, desired: 'retired', observed: 'active', pendingLifecycle: { op: 'retire', since: NOW - 90000 } };
  const action = retireAction(pending, NOW);
  assert.equal(action.disabled, true);
  assert.equal(action.label, '退役请求中 · 已等待 2m');
  // An older projection without the wait clock still refuses a duplicate, without inventing a duration.
  const legacy = retireAction({ ...pending, pendingLifecycle: null }, NOW);
  assert.equal(legacy.disabled, true);
  assert.equal(legacy.label, '退役请求中 · 等待原生确认');
  // Converged or unknown members are not "in flight".
  assert.equal(retireAction({ ...pending, observed: 'retired' }, NOW).disabled, false);
  assert.equal(retireAction({ ...pending, desired: 'active' }, NOW).disabled, false);
});

