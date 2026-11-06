import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ControlStore } from '../../store/index.mjs';
import { TeamCore } from '../../core/index.mjs';
import { SessionRouter } from '../../host/index.mjs';
import { installRuntime } from '../runtime.mjs';
import { createRoleToolBoundary } from '../../adapter-dsh/index.mjs';
import { registerBusinessTool } from '../business-tools.mjs';
import { resolveOwnerModel } from '../llm-execution.mjs';
import { ToolCapabilityRegistry, RoleToolGuard, authorizeRoleTool, NATIVE_IMPLEMENTATION, NATIVE_TOOL_CAPABILITIES,
  shapeCapabilities } from '../../host/index.mjs';
import { ROOT_TOOL_POLICY, TOOL_CAPABILITY_DECLARATIONS, TOOL_OPERATION_CAPABILITIES, toolOperationCapabilities,
  assertProtocolSupported } from '../../contracts/index.mjs';


import { TEAM, OWNER, AUDIT_FIELDS, world, call } from '../test-support/s2-fixtures.mjs';

test('R01: the owner session reaches no execution, write or opaque tool, and the refusal is metadata-independent', async () => {
  const w = await world();
  try {
    assert(w.runtime?.roleGuard, 'v1 installs the role guard');
    for (const name of ['bash', 'shell', 'PTC', 'run_code', 'write', 'edit', 'apply-patch', 'move', 'delete',
      'fetch', 'webfetch', 'search', 'todo', 'list', 'team_verify', 'mcp__filesystem__write_file', 'mcp:shell',
      'batch_execute', 'parallel_tools', 'multi_tool_use', 'some_plugin']) {
      const result = await call(w, name, { file_path: 'src/a.mjs', command: 'echo hi' });
      assert.equal(result.ok, false, name + ' is refused');
      assert.equal(result.executed, 0, name + ' never reached its implementation');
      assert.equal(result.code, 'ROLE_GUARD_DENIED', name);
      assert.equal(result.decision?.principalKind, 'owner', name);
      assert.equal(result.decision?.role, 'root', name);
    }
    // The model's own arguments never decide the class: role/toolClass/capability/targets are inert.
    const tampered = await call(w, 'write', { file_path: 'src/a.mjs', role: 'user', toolClass: 'read-local',
      capability: 'coordinate', targets: ['src'], tool: 'read' });
    assert.equal(tampered.ok, false);
    assert.equal(tampered.executed, 0);
    assert.equal(tampered.decision.reason, 'CAPABILITY_DENIED');
    // The prompt-side claim that a tool is "read only" does not reach the guard either.
    for (const name of ['read', 'read_image', 'glob', 'grep']) {
      const result = await call(w, name, { file_path: 'src/a.mjs' });
      assert.equal(result.ok, true, name + ' is a local read');
      assert.equal(result.executed, 1);
    }
    // The team produce/verify tools carry execute, so the owner never reaches them.
    assert.equal((await call(w, 'team_task', { op: 'produce', taskRef: 'task:1' })).decision?.reason, 'CAPABILITY_DENIED');
    assert.equal((await call(w, 'team_verify', { deliveryRef: 'delivery:1' })).decision?.reason, 'CAPABILITY_DENIED');
  } finally { w.close(); }
});

test('R02: root reads, dispatches, speaks, decides and checkpoints; produce/verify and unknown ops stay refused', async () => {
  const w = await world();
  try {
    const allowed = [
      ['team_read', { view: 'team', ref: TEAM }],
      ['team_message', { op: 'send', to: 'member:w', kind: 'info', summary: 's' }],
      ['team_thread', { op: 'reply', issueId: 'thread:1' }],
      ['team_thread', { op: 'decide', issueId: 'thread:1' }],
      ['team_plan', { op: 'create' }],
      ['team_plan', { op: 'approve', taskRef: 'task:1' }],
      ['team_member', { op: 'request', role: 'worker' }],
      ['team_goal', { op: 'inspect', goalRef: 'goal:1' }],
      ['team_task', { op: 'checkpoint', taskRef: 'task:1' }],
      ['team_thread', { op: 'open-resource' }],
      ['team_thread', { op: 'subscribe' }],
    ];
    for (const [name, args] of allowed) {
      const result = await call(w, name, args);
      assert.equal(result.ok, true, name + ' ' + JSON.stringify(args) + ' is coordination');
      assert.equal(result.executed, 1);
    }
    for (const [name, args, reason] of [
      ['team_task', { op: 'produce', taskRef: 'task:1' }, 'CAPABILITY_DENIED'],
      ['team_task', {}, 'UNKNOWN_OPERATION'],
      ['team_task', { op: 'invent' }, 'UNKNOWN_OPERATION'],
      ['team_thread', { op: 'invent' }, 'UNKNOWN_OPERATION'],
      ['team_verify', {}, 'CAPABILITY_DENIED'],
    ]) {
      const result = await call(w, name, args);
      assert.equal(result.ok, false, name + ' ' + JSON.stringify(args));
      assert.equal(result.executed, 0);
      assert.equal(result.decision?.reason, reason, name + ' ' + JSON.stringify(args));
    }
    // The whole-tool template is not rewritten by the refinement: team_task still carries execute, so a caller that
    // ignores operations is denied by the conservative answer.
    assert.deepEqual(TOOL_CAPABILITY_DECLARATIONS.team_task, ['coordinate', 'execute']);
    assert.deepEqual(toolOperationCapabilities('team_task', 'checkpoint'), ['coordinate']);
    assert.equal(toolOperationCapabilities('team_task', 'invent'), null);
    assert.equal(toolOperationCapabilities('team_task', undefined), null);
    assert.deepEqual(toolOperationCapabilities('team_read', undefined), ['read-local', 'coordinate']);
    // A member execution session is out of this policy's scope: the member fence is exactly as it was.
    w.router.bindExecution({ executionSessionId: 'session:worker', teamId: TEAM, memberId: 'member:w', generation: 1 });
    const worker = await call(w, 'write', { file_path: 'src/w.mjs' }, 'session:worker');
    assert.equal(worker.ok, true, 'the role policy does not replace the member fence');
    assert.equal(worker.executed, 1);
    const workerProduce = await call(w, 'team_task', { op: 'produce' }, 'session:worker');
    assert.equal(workerProduce.ok, true, 'a member produces under its own lease, not under the root policy');
  } finally { w.close(); }
});

test('R03: business tools are guard-checked by their registration, their replacement and their nested calls', async () => {
  const w = await world();
  try {
    const owner = w.agent;
    w.setInitiator(OWNER);
    const declared = (definition) => registerBusinessTool(w.hostRuntime, owner, definition);
    // No declaration: registered for its own agent, but undeclared for the owner role.
    declared({ name: 'biz:bare', execute: () => 'bare' });
    const bare = await call(w, 'biz:bare', { op: 'inspect' }, OWNER);
    assert.equal(bare.ok, false);
    assert.equal(bare.executed, 0);
    assert.equal(bare.decision?.reason, 'UNDECLARED_TOOL');
    // A direct execute() never crosses the platform boundary, and is refused by the same guard.
    assert.throws(() => w.agentTools.get('biz:bare').execute({ op: 'inspect' }), error => error.code === 'ROLE_GUARD_DENIED');
    // A declared registration is bound to its own implementation and refined per operation.
    declared({ name: 'biz:cfg', capabilities: ['read-local'], allowedOperations: { inspect: ['read-local'], mutate: ['write-local'] },
      execute: args => 'cfg:' + args.op });
    const inspect = await call(w, 'biz:cfg', { op: 'inspect' });
    assert.equal(inspect.ok, true, 'a declared read operation is allowed: ' + String(inspect.error?.message ?? ''));
    assert.equal(inspect.executed, 1);
    assert.equal(w.agentTools.get('biz:cfg').execute({ op: 'inspect' }), 'cfg:inspect', 'a genuine direct read succeeds');
    assert.equal((await call(w, 'biz:cfg', { op: 'mutate' })).ok, false, 'a declared write operation stays refused');
    assert.equal((await call(w, 'biz:cfg', {})).decision?.reason, 'UNKNOWN_OPERATION', 'a missing operation is not the tool');
    // Same-name replacement does not inherit: the old wrapper no longer resolves, the new one is judged by its own declaration.
    const old = w.agentTools.get('biz:cfg');
    declared({ name: 'biz:cfg', capabilities: ['read-local'], allowedOperations: { inspect: ['read-local'] },
      execute: args => 'new:' + args.op });
    const replaced = await call(w, 'biz:cfg', { op: 'inspect' });
    assert.equal(replaced.ok, true, 'the new registration is judged by its own declaration');
    assert.throws(() => old.execute({ op: 'inspect' }), error => error.code === 'ROLE_GUARD_DENIED',
      'the replaced implementation cannot inherit the declaration');
    // A business registration under a native name does not inherit the native declaration either.
    declared({ name: 'read', execute: () => 'fake read' });
    const fakeRead = await call(w, 'read', { file_path: 'src/a.mjs' });
    assert.equal(fakeRead.ok, false, 'same name, different implementation is a different identity');
    assert.equal(fakeRead.decision?.reason, 'UNDECLARED_TOOL');
    w.agentTools.delete('read');
    // Nested: an allowed outer call cannot reach an undeclared inner tool.
    declared({ name: 'biz:inner', execute: () => 'inner' });
    declared({ name: 'biz:outer', capabilities: ['read-local'], allowedOperations: { run: ['read-local'] },
      execute: () => w.agentTools.get('biz:inner').execute({}) });
    assert.throws(() => w.agentTools.get('biz:outer').execute({ op: 'run' }), error => error.code === 'ROLE_GUARD_DENIED',
      'a nested call is checked again');
    // The team tool entry is guarded just as strictly when it is called directly instead of through the platform.
    w.setInitiator(OWNER);
    assert.throws(() => w.globalTools.get('team_task').execute({ op: 'produce', taskRef: 'task:1' }),
      error => error.code === 'ROLE_GUARD_DENIED');
    assert.throws(() => w.globalTools.get('team_verify').execute({ deliveryRef: 'delivery:1' }),
      error => error.code === 'ROLE_GUARD_DENIED');
  } finally { w.close(); }
});

test('R04: no route, no durable role, a new owner session, a stale callback, a failed audit and a human session', async () => {
  // The host installs the guard before the owner route exists: the owner session has no role yet, so nothing runs.
  const unrouted = await world({ registerOwner: false });
  try {
    assert.equal(unrouted.failure, null);
    for (const name of ['read', 'bash', 'team_read']) {
      const result = await call(unrouted, name, { view: 'team', ref: TEAM });
      assert.equal(result.ok, false, name + ' before the owner role is bound');
      assert.equal(result.executed, 0);
      assert.equal(result.decision?.reason, 'ROOT_PRINCIPAL_UNBOUND');
    }
    // A session that is not this team's owner is not locked out by the owner policy.
    const human = await call(unrouted, 'bash', {}, 'session:human');
    assert.equal(human.ok, true, 'a non-team human session is not fenced by the owner guard');
    assert.equal(human.executed, 1);
  } finally { unrouted.close(); }

  // Routed owner without the durable root row: still no execution.
  const noRole = await world({ rootRole: null });
  try {
    const result = await call(noRole, 'bash', {});
    assert.equal(result.ok, false);
    assert.equal(result.executed, 0);
    assert.equal(result.decision?.reason, 'ROOT_PRINCIPAL_UNBOUND');
  } finally { noRole.close(); }

  // A route that points at a durable non-root role is a principal mismatch, not a promotion.
  const wrongRole = await world({ rootRole: 'worker' });
  try {
    const result = await call(wrongRole, 'bash', {});
    assert.equal(result.ok, false);
    assert.equal(result.decision?.reason, 'PRINCIPAL_MISMATCH');
  } finally { wrongRole.close(); }

  // The guard is revoked with the team/owner route; the listener it left behind still refuses.
  const revoked = await world();
  try {
    const stale = [...revoked.listeners.get('tools/execute')];
    const read = revoked.globalTools.get('read');
    assert.equal(stale.length, 1);
    revoked.runtime.roleGuard.revoke();
    assert.equal(revoked.listeners.get('tools/execute').size, 0, 'the listener is detached');
    assert.equal(revoked.runtime.roleGuard.status().installed, false);
    assert.equal(revoked.runtime.roleGuard.status().revoked, true);
    let executed = 0;
    await assert.rejects(async () => stale[0]({ agent: { session: { id: OWNER } }, name: 'bash', callId: 'stale', arguments: {} },
      () => { executed++; }), error => error.code === 'ROLE_GUARD_DENIED');
    assert.equal(executed, 0, 'a callback captured before the revoke cannot borrow the old identity');
    assert.equal((await call(revoked, 'read')).ok, false, 'even reads fail after revoke');
    revoked.setInitiator(OWNER);
    assert.throws(() => read.execute({}), error => error.code === 'ROLE_GUARD_DENIED');
    // Re-installing after the host restores the owner (new session, same team) guards it again.
    revoked.router.unregisterTeam(TEAM);
    revoked.router.registerTeam({ teamId: TEAM, ownerSessionId: 'session:owner-2' });
    revoked.runtime.roleGuard.bindOwnerSession('session:owner-2');
    revoked.runtime.roleGuard.install();
    assert.equal((await call(revoked, 'bash', {}, 'session:owner-2')).ok, false);
    assert.equal((await call(revoked, 'read', {}, 'session:owner-2')).ok, true);
    assert.equal((await call(revoked, 'read', {}, OWNER)).ok, false, 'retired owner cannot become a human session');
    revoked.router.unregisterTeam(TEAM);
    revoked.router.registerTeam({ teamId: TEAM, ownerSessionId: 'session:other-owner' });
    revoked.router.bindExecution({ executionSessionId: 'session:owner-2', teamId: TEAM, memberId: 'member:w', generation: 1 });
    assert.equal((await call(revoked, 'write', {}, 'session:owner-2')).ok, false, 'owner callback cannot borrow a new execution route');
    await assert.rejects(async () => stale[0]({ agent: { session: { id: 'session:owner-2' } }, name: 'read', arguments: {} }, () => { executed++; }));
    assert.equal(executed, 0);
  } finally { revoked.close(); }

  // A denial whose ledger write fails is still a denial, and the status says the ledger is behind.
  const auditDown = await world({ authorizeFails: true });
  try {
    const result = await call(auditDown, 'bash', {});
    assert.equal(result.ok, false);
    assert.equal(result.decision?.reason, 'CAPABILITY_DENIED');
    assert.equal(auditDown.runtime.roleGuard.status().auditPersistFailed, true);
  } finally { auditDown.close(); }

  // The closed audit record carries exactly the design's fields and never the arguments.
  const audited = await world();
  try {
    await call(audited, 'bash', { command: 'rm -rf /', secret: 'token' });
    const row = audited.store.read('guard-audit:latest');
    assert(row, 'the refusal is recorded');
    assert.deepEqual(AUDIT_FIELDS.filter(field => !Object.hasOwn(row, field)), []);
    assert.equal(row.teamId, TEAM);
    assert.equal(row.sessionId, OWNER);
    assert.equal(row.principalKind, 'owner');
    assert.equal(row.role, 'root');
    assert.equal(row.toolIdentity, 'bash');
    assert.equal(row.op, null);
    assert.equal(row.decision, 'deny');
    assert.equal(row.reason, 'CAPABILITY_DENIED');
    assert.equal(JSON.stringify(row).includes('rm -rf'), false, 'arguments never reach the ledger');
    assert.equal(JSON.stringify(row).includes('token'), false);
    // The hook answers before every listener installed after it.
    let later = 0;
    audited.listeners.get('tools/execute').add((execution, next) => { later++; return next(); });
    assert.equal((await call(audited, 'bash', {})).ok, false);
    assert.equal(later, 0, 'a denied call never reaches the later listener');
    assert.equal((await call(audited, 'read', {})).ok, true);
    assert.equal(later, 1);
    audited.core.mutate('completion:s2', 'root', {}, tx => tx.put('completion:s2', { status: 'prepared' }));
    assert.equal((await call(audited, 'write')).executed, 0, 'a real completion freeze cannot open the guard');
    assert.equal(audited.runtime.roleGuard.status().auditPersistFailed, true, 'frozen audit ledger is explicitly reported');
  } finally { audited.close(); }

  // A context whose listener cannot be revoked cannot host the guard: the mount fails closed.
  const unrevocable = await world({ revocable: false });
  try {
    assert.equal(unrevocable.failure?.code, 'ROOT_GUARD_UNAVAILABLE');
  } finally { unrevocable.close(); }
  const missing = await world({ boundary: false });
  try { assert.equal(missing.failure?.code, 'ROOT_GUARD_UNAVAILABLE'); } finally { missing.close(); }
});

test('R05: the owner model entry is optional, effective when supported, and refuses what it cannot select', async () => {
  assert.deepEqual(await resolveOwnerModel({ ownerModel: null, ctx: null }), { configured: null, effective: null, source: 'host-default' });
  let selected = null;
  const agent = { session: { id: OWNER }, model: { select(value) { selected = value; }, current() { return selected; } } };
  const llm = { registration: provider => ['p1','p2'].includes(provider) ? { adapter: { trusted: true } } : null,
    async resolveModelInfo(provider, model) { if (model === 'missing') throw Error('unknown model'); return { provider, id: model }; } };
  const ctx = { llm, agents: { get: () => agent } };
  const select = ownerModel => resolveOwnerModel({ ownerModel, ctx, ownerSessionId: OWNER });
  assert.deepEqual(await select({ provider: 'p1', model: 'm1' }),
    { configured: { provider: 'p1', model: 'm1' }, effective: { provider: 'p1', model: 'm1' }, source: 'owner-model' });
  assert.deepEqual(selected, { provider: 'p1', model: 'm1' }, 'real selection entry is called');
  assert.deepEqual((await select({ provider: 'p2', model: 'm2' })).effective, { provider: 'p2', model: 'm2' });
  for (const selection of [{ provider: 'nope', model: 'm' }, { provider: 'p1' }, { provider: 'p1', model: 'missing' }]) {
    await assert.rejects(select(selection), error => error.code === 'ROOT_MODEL_UNAVAILABLE');
  }
  await assert.rejects(resolveOwnerModel({ ownerModel: { provider: 'p1', model: 'm1' }, ctx: { llm }, ownerSessionId: OWNER }),
    error => error.code === 'ROOT_MODEL_UNAVAILABLE');

  // Off never consults the model entry, and installs no guard at all: this is HEAD.
  const off = await world({ borrow: 'off' });
  try {
    assert.equal(off.runtime.roleGuard, undefined);
    assert.equal(off.runtime.ownerModel, undefined);
    assert.equal(off.listeners.has('tools/execute'), false, 'off installs no tools/execute listener');
    const result = await call(off, 'bash', {});
    assert.equal(result.ok, true, 'off behaviour is HEAD behaviour');
    assert.equal(result.executed, 1);
  } finally { off.close(); }

  // v1 without a configured model keeps the host default and adds nothing to the selection.
  const unconfigured = await world();
  try { assert.equal(unconfigured.runtime.ownerModel, null); } finally { unconfigured.close(); }

  // A configured, supported model is recorded as effective; an unsupported one fails the mount.
  const configured = await world({ ownerModel: { provider: 'p1', model: 'm1' }, llm });
  try {
    assert.deepEqual(configured.runtime.ownerModel, { provider: 'p1', model: 'm1' });
  } finally { configured.close(); }
  const unsupported = await world({ ownerModel: { provider: 'nope', model: 'm1' } });
  try { assert.equal(unsupported.failure?.code, 'ROOT_MODEL_UNAVAILABLE'); } finally { unsupported.close(); }

  // The protocol itself stays fail-closed: v1 is still not activatable in this build.
  assert.throws(() => assertProtocolSupported({ superagentBorrow: 'v1', intentSemantics: 'root-decision-v1' }),
    error => error.code === 'PROTOCOL_UNSUPPORTED');
});

test('§4.1 unit: the registry binds declarations to implementations and denies unknown operations', () => {
  const registry = new ToolCapabilityRegistry();
  const first = { name: 'biz:x' }, second = { name: 'biz:x' };
  registry.register({ identity: 'biz:x', capabilities: ['read-local'], implementation: first, source: 'test' });
  assert.equal(registry.decide({ identity: 'biz:x', implementation: first }).decision, 'allow');
  assert.equal(registry.decide({ identity: 'biz:x', implementation: second }).reason, 'UNDECLARED_TOOL');
  registry.register({ identity: 'biz:x', capabilities: ['write-local'], implementation: second, source: 'test' });
  assert.equal(registry.decide({ identity: 'biz:x', implementation: first }).reason, 'UNDECLARED_TOOL', 'replacement wins');
  assert.equal(registry.decide({ identity: 'biz:x', implementation: second }).reason, 'CAPABILITY_DENIED');
  assert.equal(registry.decide({ identity: 'nobody', implementation: first }).reason, 'UNDECLARED_TOOL');
  assert.throws(() => registry.register({ identity: 'biz:y', capabilities: ['read-only'], implementation: first }), /UNKNOWN_CAPABILITY/);
  assert.throws(() => registry.register({ identity: 'biz:y', capabilities: ['read-local'] }), /INVALID_TOOL_IMPLEMENTATION/);
  assert.equal(authorizeRoleTool({ principal: { kind: 'member', role: 'worker' }, toolDefinition: { identity: 'bash', implementation: NATIVE_IMPLEMENTATION },
    registry }).applies, false);
  assert.equal(authorizeRoleTool({ principal: { kind: 'owner', role: 'root' }, toolDefinition: null, registry }).reason, 'UNDECLARED_TOOL');
  assert.equal(authorizeRoleTool({ principal: { kind: 'owner', role: 'root' }, toolDefinition: { identity: 'read', implementation: NATIVE_IMPLEMENTATION },
    registry: null }).reason, 'UNDECLARED_TOOL');
  assert.equal(NATIVE_TOOL_CAPABILITIES.bash.includes('opaque'), true);
  assert.deepEqual(shapeCapabilities('mcp__server__tool'), ['opaque']);
  assert.deepEqual(shapeCapabilities('batch_execute'), ['opaque']);
  assert.equal(shapeCapabilities('read'), null);
  assert.deepEqual(TOOL_OPERATION_CAPABILITIES.team_task.produce, ['execute']);
  assert.throws(() => new RoleToolGuard({ registry: null }), error => error.code === 'ROOT_GUARD_UNAVAILABLE');
  const guard = new RoleToolGuard({ registry, teamId: TEAM });
  assert.equal(guard.check({ principal: { kind: 'owner', role: 'root' }, toolDefinition: { identity: 'read', implementation:
    NATIVE_IMPLEMENTATION } }).reason, 'UNDECLARED_TOOL');
  assert.equal(guard.status().installed, false);
  assert.equal(ROOT_TOOL_POLICY.unknown, 'deny');
});

