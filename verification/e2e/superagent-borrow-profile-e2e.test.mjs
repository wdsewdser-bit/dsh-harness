// P5 component checks plus an assembled-profile integration below. The first test deliberately seeds reducer facts;
// it is NOT evidence of product-driven batch injection or role-guard installation. The second test installs the
// production runtime/host/projection plugins and observes their driver without pumping, injecting or opening turns.
//
// This does NOT activate v1. The public profile entry still refuses it, which the first case pins: the suite builds the
// core the profile will build once activation is approved, so the read/command surface is exercised against the real
// domain rather than a fixture.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ControlStore } from '../../packages/store/index.mjs';
import { TeamCore, batchCandidate, recordBatchInjection } from '../../packages/core/index.mjs';
import { createTeamHost } from '../../packages/host/index.mjs';
import { Projection } from '../../packages/projections/index.mjs';
import { submit } from '../../packages/projections/commands.mjs';
import { RoleToolGuard, ToolCapabilityRegistry } from '../../packages/host/index.mjs';
import { ROOT_DECISION_SEMANTICS, assertProtocolSupported } from '../../packages/contracts/index.mjs';

const TEAM = 'team:s5-e2e';
const future = ms => new Date(Date.now() + ms).toISOString();
const ROOT = { kind: 'owner', role: 'root', memberId: 'member:root', sessionId: 'owner:s5' };
const codeOf = fn => { try { fn(); return null; } catch (error) { return error.code ?? String(error.message); } };

test('P5 component contract: S1-S4 facts project correctly, and v1 remains refused at the profile entry', async () => {
  // §2: the e2e does not pretend to be activation. The public entry still fails closed.
  assert.equal(codeOf(() => assertProtocolSupported({ superagentBorrow: 'v1', intentSemantics: ROOT_DECISION_SEMANTICS })),
    'PROTOCOL_UNSUPPORTED');

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 's5-e2e-'));
  const store = new ControlStore(dir);
  const core = new TeamCore(store, { enabled: true }, { enabled: true, attach: true, teamId: TEAM,
    collab: 'on', autonomy: 'on', superagentBorrow: 'v1', intentSemantics: ROOT_DECISION_SEMANTICS,
    decisionTtlMs: 600000, maxRuns: 1, repositories: [{ repositoryKey: 'repo:acme/app', root: dir }] });
  const host = createTeamHost({ root: dir, teamId: TEAM, core, cycleIntervalMs: 1000000,
    recoverer: async () => ({ status: 'ok', admission: true }), openStore: () => ({ close() {} }) });
  let operations = 0;
  const op = name => 'v1:operation:s5-e2e-' + name + '-' + String(++operations).padStart(3, '0');
  const projection = () => new Projection({ events: seq => store.events(seq), scanEvents: seq => store.scanEvents(seq) },
    { protocol: 'v1', maxRuns: core.configuration.maxRuns });
  try {
    await host.start();
    core.member('member:root', 'root');
    core.member('member:fe', 'worker', 'A');
    core.member('member:be', 'worker', 'A');
    core.member('member:qa', 'verifier', 'V');

    // --- S1: resource thread, subscription fan-out, root coordination decision ------------------------------------
    const issueId = 'thread:' + op('resource');
    const opened = submit(core, 'member:fe', { name: 'threads.openResource', target: issueId, expectedRevision: 0,
      operationId: op('open'), args: { resource: { kind: 'branch', repositoryKey: 'repo:acme/app', key: 'refs/heads/main' },
        descriptionRef: 'artifact:desc:1' } });
    assert.equal(opened.status, 'accepted', JSON.stringify(opened));
    for (const [actor, label] of [['member:fe', 'fe'], ['member:be', 'be']]) {
      const receipt = submit(core, actor, { name: 'threads.subscribe', target: issueId,
        expectedRevision: store.read(issueId).revision, operationId: op('subscribe-' + label), args: {} });
      assert.equal(receipt.status, 'accepted', JSON.stringify(receipt));
    }
    const published = submit(core, 'member:fe', { name: 'threads.publish', target: issueId,
      expectedRevision: store.read(issueId).revision, operationId: op('publish'),
      args: { eventType: 'conflict-observed', summary: 'main moved under the feature branch' } });
    assert.equal(published.status, 'accepted', JSON.stringify(published));
    assert.equal(store.list('thread-delivery:' + issueId + ':').filter(row => row.state === 'pending').length, 2);
    assert.equal(store.effects().filter(effect => effect.payload.kind === 'wake' && effect.payload.threadRef === issueId).length, 2);
    core.task('task:e2e', 'member:fe');
    const requestId = 'message:' + op('intent');
    const payload = { messageId: requestId, to: 'member:root', kind: 'intent', summary: 'rule on the contract',
      taskRef: 'task:e2e', contractRevision: 1, expectedOutcome: 'root decides', reason: 'the commitment must change',
      evidenceRefs: ['task:e2e'], bodyRef: 'artifact:body:1' };
    const request = core.dispatch(requestId, 'member:fe', payload, { type: 'message.send', payload });
    const decisionId = request.result.decisionRef;
    assert.equal(store.read(decisionId).kind, 'coordination');
    core.decideDecision(decisionId, 'member:root', { decision: 'approve', reason: 'approved', evidenceRef: null }, 'owner');
    assert.equal(store.read(decisionId).state, 'decided');
    assert(store.effects().some(effect => effect.payload.kind === 'intent-result' && effect.payload.messageId === requestId));
    let data = projection().snapshot('member:be').data;
    assert.equal(data.threads.some(thread => thread.id === issueId), false);
    assert.equal(data.resourceThreads.length, 1);
    assert.equal(data.resourceThreads[0].head, 1);
    assert.equal(data.resourceThreads[0].subscribers.length, 1, 'a subscriber sees only its own subscription');
    assert.equal(projection().snapshot('member:root').data.resourceThreads[0].subscribers.length, 2);

    // --- S2: the real role guard refuses owner execution and records the audit row --------------------------------
    const registry = new ToolCapabilityRegistry();
    const bash = () => 'executed';
    const read = () => 'read';
    registry.register({ identity: 'bash', capabilities: ['opaque'], implementation: bash, source: 'trusted-e2e' });
    registry.register({ identity: 'read', capabilities: ['read-local'], implementation: read, source: 'trusted-e2e' });
    let audits = 0;
    const guard = new RoleToolGuard({ registry, teamId: TEAM, audit: record => {
      audits++; core.mutate('guard-audit:' + op('audit'), 'adapter', {}, tx => tx.put('guard-audit:' + op('audit'), record));
    } });
    guard.installed(true);
    const denied = guard.check({ principal: ROOT, toolDefinition: { identity: 'bash', implementation: bash } });
    assert.equal(denied.decision, 'deny');
    assert.equal(denied.reason, 'CAPABILITY_DENIED');
    assert.equal(guard.check({ principal: ROOT, toolDefinition: { identity: 'read', implementation: read } }).decision, 'allow');
    assert.equal(audits, 1);
    const guarded = new Projection({ events: seq => store.events(seq), scanEvents: seq => store.scanEvents(seq) },
      { protocol: 'v1', maxRuns: core.configuration.maxRuns, roleGuard: () => guard.status() });
    const guardView = guarded.snapshot('member:root').data.roleGuard;
    assert.equal(guardView.coordinatorOnly, true);
    assert.equal(guardView.installed, true);
    assert.equal(guardView.denials, 1);
    assert.equal(guardView.audit.byTool.find(entry => entry.identity === 'bash').denied, 1);

    // --- S3: one bounded batch from the real input set, then the committed manifest is projected ------------------
    core.send('member:root', 'member:fe', 'action', 'check the interface', { deadline: future(600000), expectedOutcome: 'confirm' });
    const candidate = batchCandidate(core, 'member:fe');
    assert(candidate, 'the addressed action must be pending');
    recordBatchInjection(core, candidate, 'native:s5-e2e', [candidate.manifest.revision]);
    data = projection().snapshot('member:fe').data;
    assert.equal(data.inputs.count, 1);
    assert.equal(data.inputs.latest.memberId, 'member:fe');
    assert(data.inputs.latest.items >= 1);

    // --- S4: N is occupied, an unknown effect closes admission, and an explicit settle reopens it ----------------
    core.schedule(op('admit'), 'task:e2e');
    let capacity = projection().snapshot('member:root').data.capacity;
    assert.equal(capacity.normal.current, 1);
    assert.equal(capacity.normal.limit, 1);
    assert.equal(capacity.admissionClosed, false);
    core.controlFact('effect-io:e2e', { state: 'unknown' }, tx => tx.put('effect-io:e2e', { effectId: 'e2e', lane: 'normal', state: 'unknown' }));
    capacity = projection().snapshot('member:root').data.capacity;
    assert.equal(capacity.admissionClosed, true);
    assert(capacity.unknown >= 1);
    core.controlFact('effect-io:e2e', { state: 'confirmed' }, tx => tx.put('effect-io:e2e', { effectId: 'e2e', lane: 'normal', state: 'confirmed' }));
    capacity = projection().snapshot('member:root').data.capacity;
    assert.equal(capacity.admissionClosed, false);

    // --- command authorization: a viewer has no write path; an outsider cannot act for a member ------------------
    const viewer = submit(core, 'viewer', { name: 'threads.subscribe', target: issueId,
      expectedRevision: store.read(issueId).revision, operationId: op('viewer'), args: {} });
    assert.equal(viewer.status, 'rejected');
    const proxy = submit(core, 'member:qa', { name: 'threads.subscribe', target: issueId,
      expectedRevision: store.read(issueId).revision, operationId: op('proxy'), args: { memberId: 'member:be' } });
    assert.equal(proxy.status, 'rejected');
    assert.equal(proxy.message, 'ROLE_DENIED');
    // The resource thread never blocks Goal completion (a decision thread would).
    assert.equal(store.read(issueId).kind, 'resource');
  } finally {
    try { await host.stop(); } catch { /* the failure above is the result */ }
    try { core.store.close?.(); } catch { /* already closed */ }
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

import { host as nativeHost, loadBuild } from '../../packages/adapter-dsh/index.mjs';
import { GoalGate } from '../../packages/core/index.mjs';
import { prepareHost, activateHost } from '../../packages/profiles/host-driver.mjs';
import { installRuntime } from '../../packages/profiles/runtime.mjs';
import { registerHostVisibility } from '../../packages/profiles/team-plugin.mjs';
import { apply as applyProjection } from '../../packages/profiles/projections-plugin.mjs';
import { summariseDispatchMessages } from '../../packages/contracts/index.mjs';

const observe = async (predicate, label) => {
  const end = Date.now() + 15000;
  while (!predicate()) {
    if (Date.now() >= end) throw Error('timeout: ' + label);
    await new Promise(resolve => setTimeout(resolve, 20));
  }
};
const finishText = text => [{ type: 'block-start', index: 0, blockType: 'text' },
  { type: 'text-delta', index: 0, text }, { type: 'block-end', index: 0, block: { type: 'text', text } },
  { type: 'finish', reason: { kind: 'stop' } }];

test('P5 assembled profile: public commands drive native owner, bounded H, real batch evidence and read-only HTTP/SSE', { timeout: 60000 }, async () => {
  // Bootstrap the internal installed consumers, exactly as P2-P4 integration does. No public v1 activation bypass
  // is added: profile()/teamSchemasForBorrow still reject v1 and policy migration remains an activation prerequisite.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 's5-profile-driver-'));
  const stack = await nativeHost(dir, { prepared: true });
  const held = Promise.withResolvers(), entered = Promise.withResolvers();
  const credential = {};
  let driver, store, handle, prepared, projections, runtime, transport, requests = 0, toolIO = 0;
  const disposers = [];
  try {
    handle = await stack.create({ sessionId: 's5-native-owner', agentOptions: { provider: 'offline', model: 'model' }, meta: { cwd: dir } });
    const config = { root: dir, home: dir, ownerSessionId: 's5-native-owner', lifecycleIntervalMs: 20, gcIntervalMs: 1000000,
      authenticateHumanInput: c => c === credential ? { teamId: prepared.teamId, ownerSessionId: 's5-native-owner',
        authenticatedEntry: 'owner-user-input' } : null };
    prepared = await prepareHost(stack.ctx, config);
    store = new ControlStore(dir);
    const core = new TeamCore(store, {}, { enabled: true, attach: true, teamId: prepared.teamId,
      superagentBorrow: 'v1', intentSemantics: ROOT_DECISION_SEMANTICS, autonomy: 'on', collab: 'on', maxRuns: 1,
      repositories: [{ repositoryKey: 'repo:app', root: dir }] });
    core.member('member:viewer', 'verifier'); // fixture bootstrap, before the driver starts
    const module = await loadBuild('dsh-llm');
    // Only the external transport is scripted. It reports the messages the real native request actually carries,
    // through the same adapter dispatch contract as production; it cannot prepare/commit a batch or start a turn.
    const adapter = new class extends stack.LlmAdapter {
      executionPermitContract = 'execution-permit/1';
      providerInfo(id) { return { id, name: 'offline P5' }; }
      async prepareCall(provider, id) { return { model: { provider, id, name: id, contextWindow: 1e6, inputModalities: ['text'] }, stream: options => this
          .stream(options) }; }
      async *stream(options) {
        requests++;
        const at = Date.now(), event = { contract: 'team-dispatch/2', attempt: 's5-request-' + requests,
          sessionId: handle.agent.session.id, kind: 'main', purpose: null, messages: summariseDispatchMessages(options.messages), at };
        for (const phase of ['prepared', 'send-started', 'committed']) stack.ctx.emit('llm/dispatch', { ...event, phase, transmission: 1, sendStartedAt: at,
            provider: 'offline' });
        entered.resolve();
        if (requests === 1) {
          await held.promise;
          const name = 'p5_read';
          yield { type: 'block-start', index: 0, blockType: 'tool-call' };
          yield { type: 'tool-call-delta', index: 0, id: 's5-call-' + requests, name, argumentsDelta: '{}' };
          yield { type: 'block-end', index: 0, block: { type: 'tool-call', id: 's5-call-' + requests, name, arguments: '{}' } };
          yield { type: 'finish', reason: { kind: 'tool-calls' } };
        } else yield* finishText('observed report');
      }
    }();
    module.registerExecutionTarget(adapter); stack.ctx.llm.registerAdapter(['offline'], adapter);
    runtime = { core, ready: Promise.resolve() };
    Object.assign(runtime, installRuntime(stack.ctx, core, { ownerSessionId: config.ownerSessionId,
      route: id => runtime.router?.route(id), authorize: (kind, work) => runtime.host.executeAuthorized(kind, work) }));
    await runtime.stop.ready;
    const tool = { name: 'p5_write', description: 'must never execute for owner', parameters: {}, output: { schema: {}, render: () => [] }, execute(
      ) { toolIO++;
        return {}; } };
    stack.ctx.tools.register(tool);
    const readTool = { ...tool, name: 'p5_read', execute() { return {}; } };
    stack.ctx.tools.register(readTool);
    runtime.roleGuard.register({ identity: 'p5_read', capabilities: ['read-local'], implementation: readTool, source: 'trusted-test-transport' });
    runtime.roleGuard.register({ identity: 'p5_write', capabilities: ['write-local'], implementation: tool, source: 'trusted-test-transport' });
    Object.defineProperty(stack.ctx, 'goals', { value: { registerCompletionGuard: () => () => {} }, configurable: true });
    driver = await activateHost({ ctx: stack.ctx, core, runtime, gate: new GoalGate(core), configuration: config, registerVisibility: registerHostVisibility,
        prepared });
    Object.assign(runtime, driver);
    // Mount the real projection plugin, including principal binding and host authorization, not a submit() substitute.
    const projectionContext = { teamRuntime: runtime, on: (name, fn) => { if (name === 'dispose') disposers.push(fn); },
      provide: (name, value) => { if (name === 'teamProjections') projections = value; } };
    for (let port = 40290; port <= 40299; port++) {
      try { await applyProjection(projectionContext, { port, sessions: { root: 'member:root', viewer: 'member:viewer' } }); transport = 'http://127.0.0.1:' +
        port;
        break; }
      catch (error) { if (error.code !== 'EADDRINUSE') throw error; }
    }
    assert(transport, 'a scoped loopback port is available');
    const command = async (token, value) => (await fetch(transport + '/team/commands', { method: 'POST', headers: { authorization: 'Bearer ' + token,
            'content-type': 'application/json' }, body: JSON.stringify(value) })).json();
    const snapshot = async token => (await fetch(transport + '/team/projection/snapshot', { headers: { authorization: 'Bearer ' + token } })).json();
    driver.humanInput.send({ operationId: 'v1:operation:s5-real-human', recipient: 'member:root', purpose: 'status', summary: 'read status' }, credential);
    await entered.promise;
    let data = (await snapshot('root')).data;
    assert.equal(data.capacity.human.current, 1); assert.equal(data.capacity.normal.current, 0);
    assert.equal(data.roleGuard.installed, true);
    const target = 'thread:s5-real-resource';
    assert.equal((await command('root', { name: 'threads.openResource', target, expectedRevision: 0, operationId: 'v1:operation:s5-real-open', args: { resource:
      {
                kind: 'branch', repositoryKey: 'repo:app', key: 'refs/heads/main' }, descriptionRef: 'doc:external' } })).status, 'accepted');
    assert.equal((await command('root', { name: 'threads.subscribe', target, expectedRevision: store.read(target).revision,
            operationId: 'v1:operation:s5-real-sub', args: {} })).status, 'accepted');
    assert.equal((await command('root', { name: 'threads.publish', target, expectedRevision: store.read(target).revision, operationId:
      'v1:operation:s5-real-pub',
            args: { eventType: 'report', summary: 'natural-boundary-report' } })).status, 'accepted');
    assert.equal((await command('viewer', { name: 'threads.publish', target, expectedRevision: store.read(target).revision,
            operationId: 'v1:operation:s5-real-forged', actor: 'member:root', args: { eventType: 'report', summary: 'forged' } })).status, 'rejected');
    assert.deepEqual((await snapshot('viewer')).data.resourceThreads, []);
    assert.equal(store.list('attempt:').length, 0, 'owner control never acquires work');
    assert.equal(handle.agent.session.snapshotEvents().filter(e => e.type === 'turn/start').length, 1);
    held.resolve();
    await observe(() => requests >= 2, 'natural tool-result boundary');
    await handle.agent.whenIdle(); await driver.visibility.settled();
    await observe(() => projections.projection.snapshot('member:root').data.capacity.human.current === 0, 'H terminal release');
    // Submit a public native tool command under the bound owner identity; do not manufacture a turn or a guard result.
    await assert.rejects(stack.ctx.tools.execute({ agent: handle.agent, signal: new AbortController().signal,
      calls: [{ id: 's5-denied', name: 'p5_write', arguments: '{}' }] }), error => error.code === 'ROLE_GUARD_DENIED');
    data = (await snapshot('root')).data;
    assert.equal(toolIO, 0); assert(data.roleGuard.denials >= 1);
    assert.equal(requests, 2, 'one initial request and one natural next step, not per input turns');
    assert.equal(handle.agent.session.snapshotEvents().filter(e => e.type === 'turn/start').length, 1);
    assert(data.inputs.count >= 1);
    const delivered = store.list('thread-delivery:' + target + ':');
    assert.equal(delivered.length, 1); assert.equal(delivered[0].state, 'visible');
    assert(store.list('manifest:').some(m => m.inputBindings?.some(b => b.ref === delivered[0].entityId)),
      'product committed the real carried resource binding');
    assert.equal(data.capacity.human.current, 0); assert.equal(data.capacity.normal.current, 0);
  } finally {
    held.resolve();
    for (const dispose of disposers.reverse()) await dispose();
    if (handle) await handle.agent.whenIdle();
    if (driver) await driver.stop(); else { try { store?.close(); } catch {} await prepared?.manager.close(); prepared?.ownership.release(); }
    if (handle) await handle.dispose(); await stack.ctx.fiber.dispose(); fs.rmSync(dir, { recursive: true, force: true });
  }
});
