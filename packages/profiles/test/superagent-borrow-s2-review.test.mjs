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

test('R06: real owner boundary precedes old/new listeners, replacement bodies, executor and nested identities', async () => {
  const { host } = await import('../../adapter-dsh/index.mjs');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 's2-native-'));
  const stack = await host(root, { prepared: true });
  const store = new ControlStore(path.join(root, 'control'));
  let handle;
  try {
    handle = await stack.create({ sessionId: OWNER, agentOptions: { provider: 'offline', model: 'model' } });
    const agent = handle.agent;
    const router = new SessionRouter(); router.registerTeam({ teamId: TEAM, ownerSessionId: OWNER });
    const core = new TeamCore(store, {}, { enabled: true, teamId: TEAM, superagentBorrow: 'v1' });
    core.member('member:root', 'root');
    let listenerIO = 0, bodyIO = 0;
    // This listener exists BEFORE installRuntime and does not call next at all.
    const early = stack.ctx.on('tools/execute', () => { listenerIO++; return { content: [] }; });
    const tool = name => ({ name, parameters: {}, output: { schema: {}, render: () => [] }, execute() { bodyIO++; return {}; } });
    const write = tool('write'); stack.ctx.tools.register(write);
    const read = tool('read'); stack.ctx.tools.register(read);
    const runtime = installRuntime(stack.ctx, core, { route: id => router.route(id), ownerSessionId: OWNER });
    runtime.roleGuard.register({ identity: 'read', capabilities: ['read-local'], implementation: read, source: 'trusted-native-fixture' });
    const input = (name, args = {}, target = agent) => ({ agent: target, signal: new AbortController().signal,
      calls: [{ id: 'c', name, arguments: JSON.stringify(args) }] });
    const denied = async (name, args) => {
      const before = [bodyIO, listenerIO];
      await assert.rejects(stack.ctx.tools.execute(input(name, args)), e => e.code === 'ROLE_GUARD_DENIED');
      assert.deepEqual([bodyIO, listenerIO], before, name + ': zero IO before ALL listeners');
    };
    for (const name of ['write','bash','edit','run_code','mcp__fs__write','batch_execute','team_verify']) await denied(name, { role: 'worker', capability:
      'read-local', targets: [] });
    assert.throws(() => write.execute({}, { agent }), e => e.code === 'ROLE_GUARD_DENIED', 'registered direct body is covered');
    assert.throws(() => read.execute({}), e => e.code === 'ROLE_GUARD_DENIED', 'no principal is not a human');
    assert.equal(bodyIO, 0);
    await stack.ctx.tools.execute(input('read'));
    assert.equal(listenerIO, 1, 'safe calls still enter the listener chain');
    early();
    const late = stack.ctx.on('tools/execute', (exec, next) => { listenerIO++; return next(); }, { prepend: true });
    await denied('write'); late();
    // Agent-scoped shadowing has the same name but a different implementation and cannot inherit read permission.
    const shadow = tool('read'); agent.ctx.tools.register(shadow);
    await denied('read');
    const nestedAgent = { session: { id: 'session:human' } };
    const outer = tool('outer');
    outer.execute = () => write.execute({}, { agent: nestedAgent });
    stack.ctx.tools.register(outer);
    runtime.roleGuard.register({ identity: 'outer', capabilities: ['coordinate'], implementation: outer, source: 'trusted-fixture' });
    assert.equal((await stack.ctx.tools.execute(input('outer'))).results[0].result.isError, true);
    assert.equal(bodyIO, 0, 'inner fake human identity does not escape owner carrier');
    const { NativeToolExecutor } = await import((await import('node:url')).pathToFileURL(
      (await import('../../adapter-dsh/index.mjs')).buildTarget().base + 'dsh-tool-executor-native/lib/index.js'));
    const executor = new NativeToolExecutor(stack.ctx);
    await assert.rejects(executor.execute(input('write')), e => e.cause?.code === 'ROLE_GUARD_DENIED' || e.code === 'ROLE_GUARD_DENIED');
    assert.equal(bodyIO, 0);
    // Mixed batch is denied before even its safe item or an arbitrary executor starts.
    await assert.rejects(stack.ctx.tools.execute({ ...input('outer'), calls: [...input('outer').calls, ...input('write').calls] }));
    const mutate = stack.ctx.on('tools/execute', (exec, next) => { exec.name = 'write'; return next(); });
    const safe = tool('safe'); stack.ctx.tools.register(safe);
    runtime.roleGuard.register({ identity: 'safe', capabilities: ['read-local'], implementation: safe, source: 'trusted-fixture' });
    const changed = await stack.ctx.tools.execute(input('safe'));
    assert.equal(changed.results[0].result.isError, true);
    assert.equal(bodyIO, 0, 'changing name after authorization cannot swap the body'); mutate();
    let release, started;
    const gate = new Promise(resolve => { release = resolve; });
    const entered = new Promise(resolve => { started = resolve; });
    const delayed = tool('delayed');
    delayed.execute = async () => { started(); await gate; return safe.execute({}, { agent }); };
    stack.ctx.tools.register(delayed);
    runtime.roleGuard.register({ identity: 'delayed', capabilities: ['coordinate'], implementation: delayed, source: 'trusted-fixture' });
    const inflight = stack.ctx.tools.execute(input('delayed'));
    await entered;
    runtime.roleGuard.revoke(); runtime.roleGuard.install();
    release();
    assert.equal((await inflight).results[0].result.isError, true, 'an old async callback cannot borrow a new owner guard generation');
    assert.equal(bodyIO, 0);
    runtime.roleGuard.revoke(); router.unregisterTeam(TEAM);
    await denied('safe');
    assert.equal(bodyIO, 0);
    // A real, unrelated human session remains outside the role policy.
    const human = await stack.create({ sessionId: 'session:human', agentOptions: { provider: 'offline', model: 'model' } });
    try { await stack.ctx.tools.execute(input('write', {}, human.agent)); assert.equal(bodyIO, 1); }
    finally { await human.dispose(); }
  } finally {
    if (handle) await handle.dispose();
    await stack.ctx.fiber.dispose(); store.close(); fs.rmSync(root, { recursive: true, force: true });
  }
});

test('R02 admission: v1 root cannot acquire work or mailbox attempt; off keeps its legacy path', async () => {
  for (const borrow of ['off','v1']) {
    const w = await world({ borrow });
    try {
      w.core.task('task:root-work', 'member:root', []);
      w.core.mutate('task:root-work', 'root', {}, (tx, task) => tx.put('task:root-work', { ...task, approved: true, worktreeReady: true, status: 'ready' }));
      w.core.mutate('member:root', 'root', {}, (tx, member) => tx.put('member:root', { ...member, desired: 'active', status: 'ready' }));
      w.core.recovered = true;
      if (borrow === 'v1') {
        for (const mailboxOnly of [false, true]) {
          w.core.mutate('task:root-work', 'root', {}, (tx, task) => tx.put('task:root-work', { ...task, mailboxOnly }));
          const before = { attempts: w.store.list('attempt:'), effects: w.store.effects() };
          assert.throws(() => w.core.schedule('root-' + mailboxOnly, 'task:root-work'), e => e.code === 'ROOT_WORK_ATTEMPT_DENIED');
          assert.deepEqual({ attempts: w.store.list('attempt:'), effects: w.store.effects() }, before);
          assert.throws(() => w.core.dispatch('scheduler', 'scheduler', {}, { type: 'schedule.admit', superagentBorrow: 'off',
            payload: { eventId: 'forged', taskId: 'task:root-work', now: Date.now(), maxRuns: 30 } }), e => e.code === 'ROOT_WORK_ATTEMPT_DENIED');
        }
      } else { w.core.schedule('legacy-root', 'task:root-work'); assert.equal(w.store.list('attempt:').length, 1); }
    } finally { w.close(); }
  }
});

test('R07: selected owner model reaches the real owner request, not a status-only effective value', async () => {
  const { host } = await import('../../adapter-dsh/index.mjs');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 's2-model-'));
  const stack = await host(root, { prepared: true });
  let handle;
  try {
    const calls = [];
    const adapter = new class extends stack.LlmAdapter {
      providerInfo(id) { return { id, name: id }; }
      async resolveModel(provider, id) {
        if (id !== 'coordinator') throw Error('unsupported model');
        return { provider, id, name: id };
      }
      async prepareCall(provider, id) {
        calls.push({ provider, model: id });
        return { model: { provider, id, name: id, contextWindow: 100000, inputModalities: ['text'] }, stream: () => this.stream() };
      }
      async *stream() {
        yield { type: 'block-start', index: 0, blockType: 'text' };
        yield { type: 'text-delta', index: 0, text: 'coordinated' };
        yield { type: 'block-end', index: 0, block: { type: 'text', text: 'coordinated' } };
        yield { type: 'finish', reason: { kind: 'stop' } };
      }
    }();
    stack.ctx.llm.registerAdapter(['scripted-owner'], adapter);
    handle = await stack.create({ sessionId: OWNER, agentOptions: { provider: 'scripted-owner', model: 'original' } });
    const before = handle.agent.model.current();
    await resolveOwnerModel({ ownerModel: null, ctx: stack.ctx, ownerSessionId: OWNER });
    assert.deepEqual(handle.agent.model.current(), before, 'default null is a no-op');
    await assert.rejects(resolveOwnerModel({ ownerModel: { provider: 'scripted-owner', model: 'missing' }, ctx: stack.ctx, ownerSessionId: OWNER }),
      e => e.code === 'ROOT_MODEL_UNAVAILABLE');
    assert.deepEqual(handle.agent.model.current(), before, 'unsupported model does not overwrite the owner');
    const selected = await resolveOwnerModel({ ownerModel: { provider: 'scripted-owner', model: 'coordinator' }, ctx: stack.ctx, ownerSessionId: OWNER });
    assert.deepEqual(selected.effective, { provider: 'scripted-owner', model: 'coordinator' });
    handle.agent.followup({ id: 'user-1', role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'coordinate' }] });
    await handle.agent.whenIdle();
    assert.deepEqual(calls, [{ provider: 'scripted-owner', model: 'coordinator' }]);
    assert.equal(handle.agent.session.requestHeader().config.model, 'coordinator');
  } finally { if (handle) await handle.dispose(); await stack.ctx.fiber.dispose(); fs.rmSync(root, { recursive: true, force: true }); }
});

test('R08: trusted native registration permits actual local reads; preempt and revoked registrations remain closed', async () => {
  const { host, loadBuild } = await import('../../adapter-dsh/index.mjs');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 's2-native-read-'));
  const stack = await host(root, { prepared: true });
  const store = new ControlStore(path.join(root, 'control'));
  let handle;
  try {
    for (const [name, config] of [['dsh-working-directory', { defaultDirectory: root }], ['dsh-fs-local', { cwd: root }]]) {
      const module = await loadBuild(name); await stack.ctx.plugin(module.default ?? module, config).await();
    }
    const module = await loadBuild('dsh-tool-fs');
    const fsTools = stack.ctx.plugin(module.default ?? module, { read: true, readImage: false, write: true, edit: true });
    await fsTools.await();
    fs.writeFileSync(path.join(root, 'sample.txt'), 'native-read-sentinel');
    handle = await stack.create({ sessionId: OWNER, agentOptions: { provider: 'offline', model: 'model' } });
    const router = new SessionRouter(); router.registerTeam({ teamId: TEAM, ownerSessionId: OWNER });
    const core = new TeamCore(store, {}, { enabled: true, teamId: TEAM, superagentBorrow: 'v1' }); core.member('member:root', 'root');
    const runtime = installRuntime(stack.ctx, core, { route: id => router.route(id), ownerSessionId: OWNER });
    const input = (name, args) => ({ agent: handle.agent, signal: new AbortController().signal,
      calls: [{ id: 'c', name, arguments: JSON.stringify(args) }] });
    const read = stack.ctx.tools.get('read', handle.agent);
    assert(read, 'the actual native read plugin is mounted');
    const result = await stack.ctx.tools.execute(input('read', { file_path: path.join(root, 'sample.txt') }));
    assert.notEqual(result.results[0].result.isError, true, JSON.stringify(result));
    assert.match(JSON.stringify(result), /native-read-sentinel/);
    assert.equal(runtime.roleGuard.registry.resolve('read', read).source, 'trusted-native-registration');
    await assert.rejects(stack.ctx.tools.execute(input('write', { file_path: path.join(root, 'sample.txt'), content: 'changed' })), e =>
      e.code === 'ROLE_GUARD_DENIED');
    assert.equal(fs.readFileSync(path.join(root, 'sample.txt'), 'utf8'), 'native-read-sentinel');
    const preempt = await loadBuild('dsh-tool-executor-preempt');
    await handle.agent.ctx.plugin(preempt.default ?? preempt, {}).await();
    await assert.rejects(stack.ctx.tools.execute(input('run_code', { code: 'throw Error("no root code")' })), e => e.code === 'ROLE_GUARD_DENIED');
    assert.throws(() => handle.agent.ctx.tools.selectExecutor(handle.agent).execute(input('run_code', { code: '1+1' })), e => e.code === 'ROLE_GUARD_DENIED');
    await fsTools.dispose();
    assert.throws(() => read.execute({ file_path: path.join(root, 'sample.txt') }, { agent: handle.agent }), e => e.code === 'ROLE_GUARD_DENIED',
      'an unregistered native body cannot keep its old permission');
    const replacement = stack.ctx.plugin(module.default ?? module, { read: true, readImage: false, write: true, edit: true });
    await replacement.await();
    const freshRead = stack.ctx.tools.get('read', handle.agent);
    assert.notEqual(freshRead, read);
    const fresh = await stack.ctx.tools.execute(input('read', { file_path: path.join(root, 'sample.txt') }));
    assert.notEqual(fresh.results[0].result.isError, true, 'a fresh native registration supplies its own declaration');
    assert.match(JSON.stringify(fresh), /native-read-sentinel/);
    const oldToolSet = { view: () => new Map([['read', read]]) };
    await assert.rejects(stack.ctx.tools.execute({ ...input('read', { file_path: path.join(root, 'sample.txt') }), toolSet: oldToolSet }),
      e => e.code === 'ROLE_GUARD_DENIED', 'old admission toolSet cannot borrow the replacement implementation');
    await replacement.dispose();
  } finally { if (handle) await handle.dispose(); await stack.ctx.fiber.dispose(); store.close(); fs.rmSync(root, { recursive: true, force: true }); }
});

