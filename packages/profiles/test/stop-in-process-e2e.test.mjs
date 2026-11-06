import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { host, load, loadBuild } from '../../adapter-dsh/index.mjs';
import { ControlStore } from '../../store/index.mjs';
import { TeamCore } from '../../core/index.mjs';
import { applyLifecycle } from '../../core/index.mjs';
import { installRuntime } from '../runtime.mjs';

// P5b end-to-end (docs/decisions/team-autonomy-design.md appendix 4): a real session, a real OS child, a real stop.
// A minimal composition: the real published host stack, the profile's subprocess subclass mounted on it, one tool
// that spawns a long-lived node child (no fake process anywhere), a scripted provider that asks for that tool, and
// the team's own lifecycle stop. The child survives the cancel on purpose -- the tool never hands its abort signal to
// the provider -- so nothing but the stop proof (c) can kill it.
//
// Two witnesses are independent of the proof row it reads back: the heartbeat file (the child keeps rewriting it until
// it is gone) and an operating-system query for the pid the child reported (tasklist on Windows, ps elsewhere). The
// proof row is evidence, but a proof that only agrees with itself proves nothing, so the test asks the OS too.

const delay = ms => new Promise(resolve => { const timer = setTimeout(resolve, ms); timer.unref?.(); });

/** Ask the operating system, not this process's bookkeeping, whether a pid is still running. */
function osProcessAlive(pid) {
  try {
    if (process.platform === 'win32') {
      const out = execFileSync('tasklist', ['/FI', 'PID eq ' + pid, '/NH', '/FO', 'CSV'], { encoding: 'utf8', windowsHide: true });
      return out.includes('"' + pid + '"');
    }
    const out = execFileSync('ps', ['-p', String(pid), '-o', 'pid='], { encoding: 'utf8' });
    return out.trim() !== '';
  } catch {
    // The query itself failing is not an observation of death; the caller polls with a bound and would time out.
    return true;
  }
}

/** Immutable PID witness, separate from the heartbeat file which is truncated on every write. */
const reportedPid = beat => {
  const [pid] = fs.readFileSync(beat, 'utf8').split(':');
  return Number.parseInt(pid, 10);
};

test('a session that spawned a real child is proven stopped, and the OS confirms the child is gone', { timeout: 120000 }, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-p5b-e2e-'));
  const beat = path.join(root, 'beat.txt');
  const identity = path.join(root, 'pid.txt');
  // The child reports its own pid, then rewrites heartbeats every 50ms until it is killed.
  const childScript = "const fs=require('node:fs');const beat=process.argv[1];fs.writeFileSync(process.argv[2],String(process.pid));" +
    "const write=()=>{try{fs.writeFileSync(beat,process.pid+':'+Date.now())}catch{}};write();setInterval(write,50);";
  let stack = null;
  let store = null;
  const spawned = [];
  try {
    stack = await host(root,{prepared:true});
    const { LlmAdapter, registerExecutionTarget } = await loadBuild('dsh-llm');
    const { ctx } = stack;
    store = new ControlStore(path.join(root, 'team'));
    const core = new TeamCore(store, {}, { enabled: true, autonomy: 'on', stopGraceMs: 50, stopProofTimeoutMs: 15000 });
    core.member('member:w', 'worker');
    const runtime = installRuntime(ctx, core, { authorize: (kind, work) => work() });
    const ready = await runtime.stop.ready;
    // The profile is the provider here: dsh-subprocess-local is mounted once, as this subclass (SPI: load the
    // subclass as a plugin). Nothing else registered ctx.subprocess before it, and the mount replaced nothing.
    assert.equal(ready.mounted, true, 'the profile mounted its subprocess subclass: ' + JSON.stringify(ready));
    assert.equal(typeof ctx.subprocess?.spawn, 'function');
    assert.equal(ctx.subprocess?.constructor?.name, 'SessionSubprocessRuntime');

    ctx.tools.register({ name: 'spawner', description: 'spawn one long-lived child process',
      parameters: { type: 'object', properties: {} },
      output: { schema: { type: 'string' }, render: (unused, value) => [{ type: 'text', text: String(value) }] },
      async execute(args, exec) {
        const signal = exec?.signal;
        if (!signal) throw Error('NO_TOOL_SIGNAL');
        const handle = ctx.subprocess.spawn({ argv: [process.execPath, '-e', childScript, beat, identity], cwd: root,
          stdio: { stdin: 'ignore', stdout: 'inherit', stderr: 'inherit' }, graceMs: 100 });
        spawned.push(handle);
        await new Promise(resolve => { if (signal.aborted) resolve(); else signal.addEventListener('abort', resolve, { once: true }); });
        return 'aborted';
      } });

    const requests = [];
    const adapter = new class extends LlmAdapter {
      executionPermitContract='execution-permit/1'; // pure scripted provider, no transport or retries
      providerInfo(id) { return { id, name: 'p5b-scripted' }; }
      async prepareCall(provider, id) {
        return { model: { provider, id, name: id, contextWindow: 1000000, inputModalities: ['text'] },
          stream: options => this.stream(options) };
      }
      async *stream() {
        const index = requests.length;
        requests.push(index);
        if (index === 0) {
          yield { type: 'block-start', index: 0, blockType: 'tool-call' };
          yield { type: 'tool-call-delta', index: 0, id: 'call-1', name: 'spawner', argumentsDelta: '{}' };
          yield { type: 'block-end', index: 0, block: { type: 'tool-call', id: 'call-1', name: 'spawner', arguments: '{}' } };
          yield { type: 'finish', reason: { kind: 'tool-calls' } };
          return;
        }
        yield { type: 'block-start', index: 0, blockType: 'text' };
        yield { type: 'text-delta', index: 0, text: 'done' };
        yield { type: 'block-end', index: 0, block: { type: 'text', text: 'done' } };
        yield { type: 'finish', reason: { kind: 'stop' } };
      }
    }();
    registerExecutionTarget(adapter); // trusted fixture installation: scripted body has no network
    ctx.llm.registerAdapter(['offline'], adapter);

    const created = await core.ports.create({ memberId: 'member:w', cwd: root });
    assert.ok(created.nativeRef);
    const agent = runtime.handles.get('member:w').agent;
    core.mutate('attempt:e2e','scheduler',{},tx=>tx.put('attempt:e2e',{owner:'member:w',taskId:'task:e2e',generation:1,fence:1,lease:'active',status:
      'running',executionSessionId:agent.session.id}));
    runtime.executionScopes.open({teamId:'team',memberId:'member:w',generation:1,attemptId:'attempt:e2e',attemptFence:1,executionSessionId:agent.session.id},
      {gates:true,attribution:true,transport:false,subprocess:true});
    agent.followup({ id: 'user', role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'spawn a child' }] });
    for (let i = 0; i < 300 && !fs.existsSync(beat); i++) await delay(50);
    assert.ok(fs.existsSync(beat), 'the tool really started a child: it wrote its first heartbeat');

    // The spawn reached the subclass: one handle, attributed to the member whose turn caused it.
    const st = runtime.stop.tracker;
    assert.equal(st.forMember('member:w').length, 1);
    assert.equal(st.unattributed().length, 0);
    assert.equal(st.all()[0].basis, 'scope');

    // The OS sees the child now. This is the same witness that is asked again after the stop.
    const pid = reportedPid(identity);
    assert.ok(Number.isSafeInteger(pid) && pid > 0, 'the child reported its own pid: ' + fs.readFileSync(beat, 'utf8'));
    assert.equal(osProcessAlive(pid), true, 'the child process ' + pid + ' is running before the stop');

    await applyLifecycle(core, 'member:w', 'cancel');
    const member = core.store.read('member:w');
    const proof = core.store.read(member.lastStopProof);
    assert.ok(proof);
    assert.equal(proof.verified, false);
    assert.equal(member.status, 'unknown');
    assert.equal(member.observed, 'unknown');
    assert.equal(proof.method, 'sealed-execution');
    assert.equal(proof.writtenBy, 'adapter');
    assert.equal(proof.checks.idle.ok, true);
    assert.equal(proof.checks.children.registered, 1);
    assert.equal(proof.checks.children.terminated, 1);
    assert.equal(proof.checks.children.exited, 1);
    assert.equal(proof.checks.children.unattributed, 0);
    assert.equal(proof.checks.llm.open.length, 0);
    // A verified stop opens no decision: the stuck-member row is for the unproven ending only.
    assert.equal(core.store.list('decision:').length, 1);
    assert.ok(member.stopDecision);
    assert.equal(core.store.read('attempt:e2e').lease,'active');

    // (c) read back through the provider's own range accounting...
    assert.equal(await spawned[0].waitForExit(), true);
    // ...and then through the operating system, which knows nothing about this proof row.
    const deadline = Date.now() + 5000;
    while (osProcessAlive(pid) && Date.now() < deadline) await delay(50);
    assert.equal(osProcessAlive(pid), false, 'the OS no longer knows a process ' + pid + '; the stop proof is not the only witness');
    // The heartbeat is frozen too: nothing is writing it any more.
    const frozen = fs.readFileSync(beat, 'utf8');
    await delay(200);
    assert.equal(fs.readFileSync(beat, 'utf8'), frozen);
    assert.equal(reportedPid(identity), pid);
  } finally {
    // Every child this test derived must be gone before it leaves, whatever happened above: terminate each handle
    // through the provider and join its exit rather than trusting the composition's teardown.
    for (const handle of spawned) {
      try { handle.terminate(); } catch { /* already terminated */ }
      try { await handle.waitForExit(); } catch { /* reported below by the OS */ }
    }
    try { await stack?.ctx?.fiber?.dispose?.(); } catch { /* teardown must not mask a failure */ }
    try { store?.close?.(); } catch { /* already closed */ }
    fs.rmSync(root, { recursive: true, force: true });
  }
});
