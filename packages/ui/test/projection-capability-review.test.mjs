// Review #7: compare every advertised command to the actual submit gateway with valid arguments/fresh CAS.
import test from 'node:test';
import assert from 'node:assert/strict';
import { capabilitiesFor, Projection, submit } from '../../projections/index.mjs';
import { submitDeliveryReconciliation } from '../../host/index.mjs';
import { realTeam, ROOT, WORKER } from './review-fixture.mjs';

function prediction(team, actor, kind, id, command, policy = {}) {
  const rows = new Map(team.store.list('').map(row => [row.entityId, row]));
  if (rows.has(actor)) {
    const projection = new Projection(team.store, { protocol: 'v1', commandPolicy: {
      enabled: team.core.configuration.enabled, collab: team.core.configuration.collab ?? 'off',
      intentProtocol: team.core.configuration.intentSemantics ?? null, ...policy } });
    try {
      const data = projection.snapshot(actor).data;
      const collection = { member: 'members', task: 'tasks', thread: 'threads', message: 'messages',
        unknownEffect: 'unknownEffects' }[kind];
      const object = kind === 'attempt' ? data.members.map(member => member.attempt).find(attempt => attempt?.id === id)
        : data[collection].find(object => object.id === id);
      return object?.capabilities[command];
    } finally { projection.close(); }
  }
  // The literal operator is not a browser reader. Keep its non-browser unit cases separate.
  const row = rows.get(id);
  return capabilitiesFor(kind, { ...row, id, state: row.status, lifecycle: row.status },
    { role: 'operator', desired: 'active' }, actor, { rows, enabled: team.core.configuration.enabled, ...policy })[command];
}
function compare(team, actor, kind, id, name, args, policy = {}, ports = {}) {
  const capability = prediction(team, actor, kind, id, name, policy);
  const result = submit(team.core, actor, { name, target: id, args, expectedRevision: team.store.read(id).revision }, ports);
  assert.ok(capability || result.status === 'rejected', name + ' is described or its private target is omitted');
  assert.equal(capability?.allowed === true, result.status === 'accepted', name + ': ' + actor + ' -> ' + result.message);
  if (!capability?.allowed) {
    assert.ok(capability?.reasonCode ?? result.message, name + ' refusal code');
    assert.ok(capability?.reasonText ?? result.message, name + ' refusal explanation');
  }
  return result;
}
function thread(team, state = 'collecting', owner = ROOT) {
  team.put('thread:x', { kind: 'decision', question: 'choose', owner, escalationOwner: ROOT,
    status: state, proposalRevision: 1, decisionRevision: 0, requiredRespondents: [], requiredEvidence: [],
    replies: [], createdAt: 100, deadline: new Date(Date.now() + 600000).toISOString() });
  team.put('artifact:evidence', { summary: 'valid evidence', acl: [WORKER, 'member:coord'] });
}

test('each lifecycle command matches submit for root/worker; root freeze is not a universal admission rule', () => {
  const team = realTeam();
  try {
    for (const name of ['organization.requestFreeze', 'organization.requestResume', 'organization.retire']) {
      assert.equal(compare(team, ROOT, 'member', WORKER, name, { reason: 'test reason' }).status, 'accepted');
      assert.equal(compare(team, WORKER, 'member', WORKER, name, { reason: 'test reason' }).status, 'rejected');
    }
    team.put(ROOT, { ...team.store.read(ROOT), desired: 'frozen' });
    assert.equal(compare(team, ROOT, 'member', WORKER, 'organization.requestResume', { reason: 'resume' }).status, 'accepted');
  } finally { team.close(); }
});

test('contract approval matches draft/approved/blocked and role admission at the actual reducer', () => {
  const team = realTeam();
  try {
    for (const [status, approved, actor] of [['draft', false, ROOT], ['draft', true, ROOT],
      ['blocked', false, ROOT], ['draft', false, WORKER]]) {
      team.put('task:x', { owner: WORKER, title: 'scope', status, approved, scopeSet: [], contractRevision: 1 });
      compare(team, actor, 'task', 'task:x', 'scheduler.approveContract', { contractRevision: 1 });
    }
  } finally { team.close(); }
});

test('decide and escalate have separate role/owner/state rules, including worker browser without a lease', () => {
  const team = realTeam();
  try {
    for (const [actor, owner, state] of [[ROOT, ROOT, 'collecting'], [ROOT, ROOT, 'escalated'],
      [ROOT, WORKER, 'collecting'], [WORKER, WORKER, 'collecting'],
      ['member:coord', 'member:coord', 'collecting'], ['member:coord', ROOT, 'collecting']]) {
      thread(team, state, owner);
      compare(team, actor, 'thread', 'thread:x', 'threads.decide', { proposalRevision: 1, conclusionRef: 'artifact:evidence' });
    }
    for (const [actor, state] of [[ROOT, 'open'], [ROOT, 'collecting'], [ROOT, 'deciding'], [ROOT, 'escalated'],
      [WORKER, 'collecting'], ['member:coord', 'collecting']]) {
      thread(team, state);
      compare(team, actor, 'thread', 'thread:x', 'threads.escalate', { reason: 'operator responsibility' });
    }
  } finally { team.close(); }
});

test('mailbox.send is a member-targeted command; worker browser cannot borrow execution authority', () => {
  const team = realTeam();
  try {
    for (const actor of [ROOT, WORKER, 'member:coord']) {
      compare(team, actor, 'member', ROOT, 'mailbox.send', { recipient: ROOT, kind: 'info', summary: 'hello' });
    }
    team.put(ROOT, { ...team.store.read(ROOT), acl: ['member:coord'] });
    assert.equal(compare(team, 'member:coord', 'member', ROOT, 'mailbox.send',
      { recipient: ROOT, kind: 'info', summary: 'visible recipient' }).status, 'accepted');
    team.put('message:x', { sender: ROOT, recipient: WORKER, kind: 'info', status: 'stored' });
    compare(team, ROOT, 'message', 'message:x', 'mailbox.send', { recipient: WORKER, kind: 'info', summary: 'wrong target' });
  } finally { team.close(); }
});

test('cancel/rebind match terminal/unknown/intent/dead-letter state rules rather than only root role', () => {
  const team = realTeam();
  try {
    team.put('artifact:evidence', { summary: 'receipt' });
    for (const name of ['mailbox.cancelMessage', 'mailbox.rebind']) {
      for (const [status, kind] of [['stored', 'info'], ['dead-letter', 'info'], ['resolved', 'info'],
        ['cancelled', 'info'], ['unknown', 'info'], ['open', 'intent']]) {
        team.put('message:x', { sender: ROOT, recipient: WORKER, recipients: [WORKER], status, kind, generation: 1 });
        compare(team, ROOT, 'message', 'message:x', name,
          { reason: 'test reason', recipient: 'member:b', evidenceRef: 'artifact:evidence' });
      }
      team.put('message:x', { sender: WORKER, recipient: ROOT, status: 'stored', kind: 'info', generation: 1 });
      compare(team, WORKER, 'message', 'message:x', name,
        { reason: 'test reason', recipient: 'member:b', evidenceRef: 'artifact:evidence' });
    }
  } finally { team.close(); }
});

test('operator unknown entries match object type and the gateway/reconciliation reducer', () => {
  const team = realTeam();
  try {
    team.put('artifact:evidence', { summary: 'operator evidence' });
    team.put('message:x', { sender: ROOT, recipient: WORKER, status: 'unknown', kind: 'info' });
    for (const actor of [ROOT, WORKER, 'operator']) compare(team, actor, 'unknownEffect', 'message:x',
      'mailbox.resolveUnknown', { decision: 'effective', evidenceRef: 'artifact:evidence' });
    team.put('effect:x', { status: 'unknown', payload: { kind: 'merge' } });
    compare(team, 'operator', 'unknownEffect', 'effect:x', 'mailbox.resolveUnknown',
      { decision: 'effective', evidenceRef: 'artifact:evidence' });
    team.put('task:x', { owner: WORKER, status: 'integrating', contractRevision: 1 });
    team.put('delivery:x', { status: 'unknown', taskId: 'task:x', candidate: 'abc', tree: 'def' });
    compare(team, ROOT, 'unknownEffect', 'delivery:x', 'delivery.reconcile',
      { decision: 'not-effective', evidenceRef: 'artifact:evidence' }, {}, { reconcile: submitDeliveryReconciliation });
    compare(team, 'operator', 'unknownEffect', 'delivery:x', 'delivery.reconcile',
      { decision: 'not-effective', evidenceRef: 'artifact:evidence' }, {}, { reconcile: submitDeliveryReconciliation });
  } finally { team.close(); }
});

test('disabled team and completion fence refuse commands exactly as submit does', () => {
  const disabled = realTeam();
  try {
    thread(disabled);
    disabled.core.configuration.enabled = false;
    compare(disabled, ROOT, 'thread', 'thread:x', 'threads.escalate', { reason: 'test' });
  } finally { disabled.close(); }
  const team = realTeam();
  try {
    thread(team);
    team.put('completion:x', { status: 'prepared' });
    compare(team, ROOT, 'thread', 'thread:x', 'threads.decide', { proposalRevision: 1, conclusionRef: 'artifact:evidence' });
    compare(team, ROOT, 'thread', 'thread:x', 'threads.escalate', { reason: 'test' });
    compare(team, ROOT, 'member', WORKER, 'organization.retire', { reason: 'test' });
    assert.equal(team.store.read('thread:x').status, 'collecting');
  } finally { team.close(); }
});

test('decide matches legacy intent windows and v1 coordination publish gates, including predecessor approval', () => {
  const legacy = realTeam({ collab: 'on' });
  try {
    legacy.put('task:x', { owner: WORKER, status: 'ready', contractRevision: 1 });
    for (const decision of [null, 'open', 'passed', 'objected']) {
      thread(legacy);
      legacy.put('thread:x', { ...legacy.store.read('thread:x'), taskRef: 'task:x' });
      if (decision) legacy.put('message:intent', { kind: 'intent', sender: ROOT, taskRef: 'task:x',
        contractRevision: 1, status: decision === 'open' ? 'open' : 'closed', decision });
      compare(legacy, ROOT, 'thread', 'thread:x', 'threads.decide',
        { proposalRevision: 1, conclusionRef: 'artifact:evidence' }, { collab: 'on' });
    }
  } finally { legacy.close(); }
  const team = realTeam({ collab: 'on', autonomy: 'on', superagentBorrow: 'v1', intentSemantics: 'root-decision-v1' });
  try {
    team.put('task:x', { owner: WORKER, status: 'ready', contractRevision: 1 });
    for (const [state, option] of [['open', null], ['expired', null], ['decided', 'reject'], ['decided', 'approve']]) {
      thread(team);
      team.put('thread:x', { ...team.store.read('thread:x'), taskRef: 'task:x' });
      team.put('decision:coord', { kind: 'coordination', state, verdict: option ? { option } : null,
        binding: { taskRef: 'task:x', contractRevision: 1 } });
      compare(team, ROOT, 'thread', 'thread:x', 'threads.decide',
        { proposalRevision: 1, conclusionRef: 'artifact:evidence' }, { intentProtocol: 'root-decision-v1' });
    }
    thread(team);
    team.put('thread:x', { ...team.store.read('thread:x'), taskRef: 'task:x' });
    team.put('decision:coord', { ...team.store.read('decision:coord'), state: 'expired', verdict: null });
    team.put('decision:renewal', { kind: 'coordination', state: 'decided', verdict: { option: 'approve' },
      binding: { taskRef: 'task:x', contractRevision: 1, previousDecisionId: 'decision:coord' } });
    assert.equal(compare(team, ROOT, 'thread', 'thread:x', 'threads.decide',
      { proposalRevision: 1, conclusionRef: 'artifact:evidence' }, { intentProtocol: 'root-decision-v1' }).status, 'accepted');
  } finally { team.close(); }
});


test('v1 ordinary info send does not invent an active-sender gate for root or coordinator', () => {
  const team = realTeam({ collab: 'on', autonomy: 'on', superagentBorrow: 'v1', intentSemantics: 'root-decision-v1' });
  try {
    for (const actor of [ROOT, 'member:coord']) {
      team.put(actor, { ...team.store.read(actor), desired: 'frozen' });
      assert.equal(compare(team, actor, 'member', actor, 'mailbox.send',
        { recipient: actor, kind: 'info', summary: 'control-plane info' },
        { intentProtocol: 'root-decision-v1' }).status, 'accepted');
    }
    for (const command of ['organization.requestFreeze', 'organization.requestResume', 'organization.retire']) {
      compare(team, 'operator', 'member', WORKER, command, { reason: 'operator test' });
    }
  } finally { team.close(); }
});


test('the safety note names the actual operator decision API; wait records ownership but never stops a session', () => {
  const team = realTeam({ autonomy: 'on' });
  try {
    team.put(WORKER, { ...team.store.read(WORKER), status: 'unknown', observed: 'unknown' });
    team.put('decision:stuck', { kind: 'stuck-member', options: ['wait'], state: 'open',
      subject: { type: 'member', id: WORKER, revision: team.store.read(WORKER).revision },
      evidence: [], openedFor: 'operator', openedAt: Date.now(), expiresAt: Date.now() + 600000, fallback: 'escalate' });
    const result = team.core.decideDecision('decision:stuck', 'operator',
      { decision: 'wait', reason: 'operator confirms ownership' }, 'operator');
    assert.equal(result.result.state, 'decided');
    assert.equal(team.store.read('decision:stuck').verdict.byKind, 'operator');
    assert.equal(team.store.read(WORKER).status, 'unknown');
  } finally { team.close(); }
});


test('stop confirmation is described exactly as the gateway admits it: operator only, ahead of the freeze gate', () => {
  const team = realTeam();
  try {
    team.put('artifact:stop', { summary: 'stop evidence' });
    const stuck = (id, owner = WORKER) => team.put(id, { owner, taskId: 'task:' + id.replace('attempt:', ''),
      lease: 'unknown', status: 'unknown', fence: 1, generation: 1 });
    stuck('attempt:stop-browser');
    // The target is the actual nested attempt, never a member row standing in for an attempt.
    assert.equal(prediction(team, ROOT, 'attempt', 'attempt:stop-browser',
      'organization.confirmStopped').reasonCode, 'OPERATOR_ONLY');
    for (const actor of [ROOT, WORKER]) {
      assert.equal(compare(team, actor, 'attempt', 'attempt:stop-browser', 'organization.confirmStopped',
        { evidenceRef: 'artifact:stop' }).status, 'rejected');
    }
    team.put('attempt:stop-browser', { ...team.store.read('attempt:stop-browser'), lease: 'revoked', status: 'cancelled' });
    stuck('attempt:stop-frozen');
    team.put('completion:x', { status: 'prepared' });
    assert.equal(compare(team, 'operator', 'attempt', 'attempt:stop-frozen', 'organization.confirmStopped',
      { evidenceRef: 'artifact:stop' }).status, 'rejected', 'the freeze gate reaches this entry too');
    assert.equal(team.store.read('completion:x').status, 'prepared');
    assert.equal(team.store.read('attempt:stop-frozen').lease, 'unknown');
    team.put('completion:x', { ...team.store.read('completion:x'), status: 'settled' });
    stuck('attempt:stop-operator', 'member:b');
    assert.equal(compare(team, 'operator', 'attempt', 'attempt:stop-operator', 'organization.confirmStopped',
      { evidenceRef: 'artifact:stop' }).status, 'accepted');
    assert.equal(team.store.read('attempt:stop-operator').lease, 'revoked');
  } finally { team.close(); }
});


test('stop capability matches the real attempt target and unknown lease, not a member-shaped stand-in', () => {
  const team = realTeam();
  try {
    team.put('artifact:stop', { summary: 'stop evidence' });
    assert.equal(prediction(team, 'operator', 'member', WORKER, 'organization.confirmStopped'), undefined,
      'member targets never advertise an attempt-only command');
    assert.equal(compare(team, 'operator', 'member', WORKER, 'organization.confirmStopped',
      { evidenceRef: 'artifact:stop' }).message, 'NOT_UNKNOWN');
    for (const [lease, status] of [['active', 'running'], ['revoked', 'cancelled'], ['unknown', 'unknown']]) {
      const target = 'attempt:stop-' + lease;
      team.put(target, { owner: lease === 'unknown' ? 'member:b' : WORKER,
        taskId: 'task:' + lease, lease, status, fence: 1, generation: 1 });
      const cap = prediction(team, 'operator', 'attempt', target, 'organization.confirmStopped');
      assert.equal(cap.allowed, lease === 'unknown');
      const result = compare(team, 'operator', 'attempt', target, 'organization.confirmStopped',
        { evidenceRef: 'artifact:stop' });
      assert.equal(result.status, lease === 'unknown' ? 'accepted' : 'rejected');
      if (lease !== 'unknown') assert.equal(result.message, 'NOT_UNKNOWN');
      assert.equal(team.store.read(target).lease, lease === 'unknown' ? 'revoked' : lease);
    }
  } finally { team.close(); }
});

test('real snapshots put the browser stop refusal on the actual nested attempt target', () => {
  const team = realTeam();
  try {
    team.put('attempt:browser-stop', { owner: WORKER, taskId: 'task:a', lease: 'unknown', status: 'unknown',
      fence: 1, generation: 1 });
    for (const actor of [ROOT, WORKER]) {
      assert.equal(prediction(team, actor, 'attempt', 'attempt:browser-stop',
        'organization.confirmStopped').reasonCode, 'OPERATOR_ONLY');
      assert.equal(compare(team, actor, 'attempt', 'attempt:browser-stop', 'organization.confirmStopped',
        { evidenceRef: 'artifact:stop' }).message, 'ROLE_DENIED');
    }
    assert.equal(team.store.read('attempt:browser-stop').lease, 'unknown');
  } finally { team.close(); }
});

