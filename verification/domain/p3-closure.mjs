import assert from 'node:assert/strict';
import fs from 'node:fs';
import { ControlStore } from '../../packages/store/index.mjs';
import { TeamCore } from '../../packages/core/index.mjs';
import { drain, heartbeat } from '../../packages/core/runtime.mjs';
import { applyLifecycle } from '../../packages/core/native.mjs';
import { rebindMessage } from '../../packages/core/mailbox.mjs';
import { preStep, requestBoundary, trustedManifests } from '../../packages/core/provenance.mjs';
import { snapshot } from '../../packages/core/snapshot.mjs';
import { authorize, rolePrompt } from '../../packages/core/authorization.mjs';
import { delegate } from '../../packages/core/organization.mjs';
import { roleTools, validateTool } from '../../packages/contracts/team-tools.mjs';
import { id } from '../../packages/contracts/index.mjs';
import { Coordinator } from '../../packages/context/policy.mjs';
import { planClosedSteps } from '../../packages/context/fold-adapter.mjs';
import { handleTool } from '../../packages/core/tools.mjs';
import { createLifecycleConsumer } from '../../packages/host/index.mjs';
import { applyEffect } from '../../packages/core/effects.mjs';
const future = () => new Date(Date.now() + 120000).toISOString();

/** Close scheduling, provenance and lifecycle offline contracts; 08 §7.2 A–H/K. */
export async function closure(root) {
  const store = new ControlStore(root);
  const calls = [];
  const ports = Object.fromEntries(['create', 'resume', 'cancel', 'dispose'].map(name => [name, async args => {
    calls.push({ name, ...args });
    return { nativeRef: 'native-' + args.memberId, stopped: ['cancel', 'dispose'].includes(name) };
  }]));
  let core = new TeamCore(store, ports, { enabled: true, maxRuns: 2, subCoordinatorMinWorkers: 2 });
  for (const [name, role] of [['root', 'root'], ['a', 'worker'], ['b', 'worker'], ['v', 'verifier']]) core.member('member:' + name, role);
  const tests = [];
  const record = name => tests.push(name);
  core.task('task:a', 'member:a');
  drain(core);
  const first = store.list('attempt:')[0];
  assert(first);
  drain(core);
  assert.equal(store.list('attempt:').length, 1);
  record('durable-event-consumer-dedup');
  const recovered = new TeamCore(store, ports, { enabled: true, maxRuns: 2, subCoordinatorMinWorkers: 2 });
  assert.throws(() => recovered.authority(first.entityId, first.fence), /INVALID_LEASE/);
  assert(store.read(first.entityId).fence > first.fence);
  assert.equal(store.read(first.entityId).lease, 'unknown');
  core = recovered;
  const staleStart = await applyEffect(core, first.entityId);
  assert.equal(staleStart.result.status, 'cancelled');
  record('restart-fence-and-resource-retention');
  await applyLifecycle(core, 'member:a', 'cancel', { keepInbox: true });
  await applyLifecycle(core, 'member:a', 'resume');
  const action = core.send('member:b', 'member:a', 'action', 'wake', { deadline: future(), expectedOutcome: 'accept' }).result;
  drain(core);
  const active = store.list('attempt:').find(a => a.owner === 'member:a' && a.lease === 'active');
  assert(active);
  heartbeat(core, active.entityId, active.fence);
  assert(store.read(active.entityId).heartbeat);
  assert.equal(core.configuration.maxRuns, 2);
  record('mailbox-auto-admission-heartbeat');
  const oldGeneration = active.generation;
  await applyLifecycle(core, 'member:a', 'cancel', { keepInbox: false });
  await applyLifecycle(core, 'member:a', 'create');
  rebindMessage(core, action.entityId, 'member:b', 'explicit ownership transfer');
  assert.throws(() => core.accept(action.entityId, active.entityId, active.fence, 'late'), /INVALID_LEASE/);
  assert(store.read('member:a').generation > oldGeneration);
  await applyLifecycle(core, 'member:a', 'dispose');
  assert(calls.some(call => call.name === 'cancel' && call.keepInbox === true));
  assert(calls.some(call => call.name === 'cancel' && call.keepInbox === false));
  record('lifecycle-create-resume-cancel-dispose-rebind-late-ack');
  core.member('member:sub', 'subCoordinator');
  delegate(core, 'delegation:bounded', 'member:sub', [], { tasks: 1, concurrency: 1, cost: 5 }, future());
  core.mutate('artifact:acceptance', 'root', {}, tx => tx.put('artifact:acceptance', { acl: ['member:sub'] }));
  const plan = { op: 'create', operationId: id('operation'), expectedRevision: 0, requirementRef: 'requirement:1',
    owner: 'member:b', scopeSet: [], deliveryKind: 'evidence', acceptanceRef: 'artifact:acceptance', delegationRef: 'delegation:bounded' };
  handleTool(core, { actor: 'member:sub' }, 'team_plan', plan);
  assert.throws(() => handleTool(core, { actor: 'member:sub' }, 'team_plan', { ...plan, operationId: id('operation'), requirementRef: 'requirement:2' }),
    /DELEGATION_BUDGET/);
  record('delegation-task-budget');
  core.task('task:cost', 'member:b', [], { delegationRef: 'delegation:bounded', estimatedCost: 6 });
  assert.throws(() => core.schedule('cost-event', 'task:cost'), /DELEGATION_COST/);
  core.task('task:quota1', 'member:b');
  core.schedule('quota1', 'task:quota1');
  core.task('task:quota2', 'member:b');
  assert.throws(() => core.schedule('quota2', 'task:quota2'), /CAPACITY/);
  core.task('task:quota3', 'member:v');
  core.schedule('quota3', 'task:quota3');
  core.task('task:quota4', 'member:root');
  assert.throws(() => core.schedule('quota4', 'task:quota4'), /CAPACITY/);
  record('delegation-cost-global-quota-single-agent-slot');
  for (let i = 0; i < 12; i++) core.send('member:root', 'member:b', i % 2 ? 'info' : 'action', '<unsafe>' + 'x'.repeat(1000),
    i % 2 ? {} : { deadline: future(), expectedOutcome: 'ack' });
  let page = 0;
  const seen = new Set();
  do {
    const current = snapshot(core, 'member:b', null, page);
    assert(Buffer.byteLength(current.text) * 2 <= 4096);
    current.manifest.messageIds.forEach(messageId => seen.add(messageId));
    if (page === 0) assert.notEqual(current.payload.responsibilities[0].kind, 'info');
    page = current.payload.responsibilityPage.nextPage;
  } while (page !== null);
  assert.equal(seen.size, core.pending('member:b').length);
  record('responsibility-pagination-priority-all-ids');
  const coordinator = new Coordinator(root);
  const nodes = [];
  let generation = 1;
  let seq = 0;
  const injectPorts = { serialize: operation => coordinator.run(operation), inject: async text => {
    const node = { kind: 'user', messageId: 'native:' + (++seq), seqs: [seq], source: 'trusted-team-plugin',
      text, sections: [{ authorized: true }] };
    nodes.push(node);
    return { messageId: node.messageId, sourceEventSeqs: node.seqs, generation };
  } };
  const injected = await preStep(core, 'member:b', injectPorts);
  assert.equal(store.read(injected.manifest.messageIds[0]).visible, false);
  requestBoundary(core, injected.manifest.hash, { generation, requestId: 'request:1', sessionSeq: seq, requestedAt: Date.now() });
  assert.equal(store.read(injected.manifest.messageIds[0]).accepted, false);
  rebindMessage(core, injected.manifest.messageIds[0], 'member:b', 'renew binding');
  assert.throws(() => requestBoundary(core, injected.manifest.hash, { generation, requestId: 'late-request', sessionSeq: seq, requestedAt: Date.now() }),
    /STALE_MESSAGE_BINDING/);
  assert.throws(() => requestBoundary(core, injected.manifest.hash, { generation: 0 }), /MISSING_SOURCE/);
  const cold = new ControlStore(root);
  assert(cold.read('manifest:' + injected.manifest.hash));
  cold.close();
  assert.equal(trustedManifests(core, nodes).length, 1);
  assert.equal(trustedManifests(core, [{ ...nodes[0], seqs: [999] }]).length, 0);
  record('durable-manifest-full-source-replay-request-boundary');
  const expected = generation;
  const concurrency = await Promise.all([
    coordinator.run(async () => { generation++; core.task('task:next-snapshot', 'member:root'); return 'compression'; }),
    coordinator.run(async () => generation === expected ? 'fold' : 'safe-abort'),
    preStep(core, 'member:b', injectPorts),
  ]);
  assert.equal(concurrency[1], 'safe-abort');
  assert.equal(nodes.length, 2);
  const forged = { ...nodes[0], messageId: 'forged-user', source: 'user' };
  const steps = Array.from({ length: 10 }, (_, i) => ({ kind: 'step', closed: true, seqs: [10 + i], calls: [], results: [] }));
  const plans = planClosedSteps([nodes[0], nodes[1], forged, ...steps].map((node, i) => ({ ...node, seqs: [i + 1] })), [], 8);
  assert(plans.every(plan => !plan.nodes.includes(forged)));
  assert.equal(trustedManifests(core, [forged]).length, 0);
  coordinator.close();
  record('team-injection-fold-compression-single-writer-generation-conflict');
  assert.throws(() => validateTool(roleTools('worker').team_message, { op: 'accept', operationId: id('operation'),
    expectedRevision: 0, messageId: first.entityId, checkpointRef: 'checkpoint:1' }), /INVALID/);
  assert.throws(() => authorize(core, 'member:a', action.entityId), /REFERENCE_ACL/);
  for (const role of ['root', 'subCoordinator', 'worker', 'verifier']) assert.match(rolePrompt(role).hash, /^[a-f0-9]{64}$/);
  const source = fs.readFileSync(new URL('../../packages/core/index.mjs', import.meta.url), 'utf8');
  assert.equal((source.match(/kind: 'start'/g) ?? []).length, 1);
  const otherFiles = ['runtime', 'tools', 'native', 'tool-reducer'];
  assert(otherFiles.every(file => !fs.readFileSync(new URL('../../packages/core/' + file + '.mjs', import.meta.url), 'utf8').includes("kind: 'start'")));
  record('schema-id-acl-role-prompts-single-admission-entry');
  const request = handleTool(core, { actor: 'member:root' }, 'team_member', { op: 'request',
    operationId: id('operation'), expectedRevision: 0, role: 'worker', subgoalRef: 'goal:child', reason: 'capacity' });
  const lifecycle = createLifecycleConsumer(core, { root });
  const driven = await lifecycle.cycle();
  assert.equal(driven.length, 1);
  assert.equal((await lifecycle.cycle()).length, 0);
  await lifecycle.stop();
  assert.equal(store.read(request.result.entityId).status, 'confirmed');
  record('model-lifecycle-intent-native-mapping-dedup');
  core.tick(Date.now() + 180000);
  assert(core.pending('member:b').every(message => message.kind === 'info' || message.accepted));
  assert(store.list('attempt:').filter(attempt => attempt.lease === 'unknown').length >= 2);
  record('action-deadlines-and-expired-lease-occupancy');
  store.close();
  return { tests, nativeCalls: calls.length, paginationIds: seen.size, protocolOnly: true };
}
