import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { profile, until } from './profile.mjs';

/**
 * What the native file backend (dsh-fs-local) does with the path a call names, written out independently of the fence.
 *
 * The fence is only correct if it answers with THIS result and then compares it against the lease, so the test's writer
 * must not borrow the fence's resolver: a shared resolver would agree with itself no matter which of the two is wrong.
 * The two aliases the review named are here: `~` is the home directory, and a Windows root-relative path resolves
 * against the drive of the session directory rather than of the process.
 */
export function nativeWriteTarget(value, base) {
  let target = value;
  if (target === '~' || target.startsWith('~/') || target.startsWith('~\\')) {
    target = target === '~' ? os.homedir() : path.join(os.homedir(), target.slice(2));
  }
  const win = process.platform === 'win32';
  // A drive path (C:\x) or a complete UNC path (\\server\share\x) names its own root.
  if (win ? /^[A-Za-z]:[\\/]/.test(target) : target.startsWith('/')) return path.resolve(target);
  if (win && /^[\\/]{2}[^\\/]+[\\/][^\\/]+/.test(target)) return path.resolve(target);
  // Everything else is resolved against the SESSION directory. A path that starts with a separator (one, several, or a
  // lone backslash) keeps no root of its own: on Windows it takes the drive of the directory it is resolved against -
  // the session's - which is precisely the fact the fence cannot recover from the process it happens to be running in.
  const root = win ? path.parse(path.resolve(base)).root : '/';
  if (/^[\\/]/.test(target)) return path.resolve(root, target.replace(/^[\\/]+/, ''));
  return path.resolve(base, target);
}

/**
 * A member with a real assigned workspace, a work task holding its lease, and the tool pipeline the native surface
 * uses: the profile's own guards (captured as ctx.tools.guard receives them) and a writer that resolves a relative
 * path exactly as the native file tools do - against the session's working directory.
 *
 * Review 2 #1/#2 are about where the fence's facts come from, so the tests drive the guard the profile installed for
 * the member instead of calling ToolGuard directly: a call is pushed down the same two steps a real tool call takes
 * (guard, then the tool's own path resolution).
 */
export async function guardWorld(options = {}) {
  const control = { guards: new Map(), tools: new Map(), live: null, liveService: null, resumeCwd: null, cwd: null, turn: 0,
    liveError: false, liveReadError: false, liveInjectError: false };
  const w = await profile(options, async ({ root, ctx, sessions }) => {
    fs.mkdirSync(path.join(root, 'ws'), { recursive: true });
    fs.mkdirSync(path.join(root, 'elsewhere'), { recursive: true });
    let counter = 0;
    const open = (opts, sessionId) => {
      // A created session records the directory it was created with; a resumed one restores the directory recorded in
      // its log (control.resumeCwd), which is exactly the fact the host has to agree with (review 2 #2).
      const dir = opts?.meta?.cwd ?? control.resumeCwd ?? null;
      const session = { id: sessionId, seq: 0, header: dir ? { cwd: dir } : {}, snapshotEvents: () => [],
        get turn() { return control.turn ?? 0; } };
      sessions.set(sessionId, session);
      return session;
    };
    const agentOf = session => {
      const agent = { session, phase: { kind: 'idle' }, wakeDriver() { agent.phase = { kind: 'running' }; }, preemptStep() { return false; },
        cancel() {}, async whenIdle() {},
        ctx: { tools: { register(tool) { control.tools.set(tool.name, tool); }, restrict() {},
          guard(fn) { const list = control.guards.get(session.id) ?? []; list.push(fn); control.guards.set(session.id, list); return () => {}; } } } };
      // The context serves the working directory the way cordis does: through get(name), which answers with the service
      // or with nothing. null means "this runtime has none", so the fence falls back to the session header.
      //   control.liveError      the supported accessor itself fails (a real read failure, not an absence);
      //   control.liveReadError  the service is there but its read fails;
      //   control.liveInjectError  a property this context never offered (cordis: "without inject"): a genuine absence.
      // The service the composition hands out: either the one the test put there verbatim (control.liveService - a
      // service with no get(), one whose get() answers nothing, ...), or the ordinary one over control.live, or none
      // at all, which is the single case that means "this runtime has no working-directory service".
      const serviceOf = () => {
        if (control.liveService !== null && control.liveService !== undefined) return control.liveService;
        if (control.live === null) return undefined;
        return { get: () => {
          if (control.liveReadError) throw Object.assign(Error('the working-directory read failed'), { code: 'READ_FAILED' });
          return control.live;
        } };
      };
      agent.ctx.get = name => {
        if (name !== 'workingDirectory') return undefined;
        if (control.liveError) throw Object.assign(Error('the working-directory service could not be read'), { code: 'READ_FAILED' });
        if (control.liveInjectError) return undefined;
        return serviceOf();
      };
      Object.defineProperty(agent.ctx, 'workingDirectory', { get: () => {
        if (control.liveInjectError) throw Object.assign(Error('cannot get property "workingDirectory" without inject'), { code: 'INJECT_MISSING' });
        if (control.liveError) throw Object.assign(Error('the working-directory service could not be read'), { code: 'READ_FAILED' });
        return serviceOf();
      } });
      return agent;
    };
    ctx.agents.create = async opts => {
      const session = open(opts, opts?.sessionId ?? 'session:guard-' + (++counter));
      return { agent: agentOf(session), dispose: async () => {} };
    };
    ctx.agents.resume = async opts => {
      const session = open({}, opts?.resumeSessionId ?? 'session:resumed-' + (++counter));
      return { agent: agentOf(session), dispose: async () => {} };
    };
  });
  const runtime = w.runtime;
  const command = payload => runtime.host.command({ teamId: runtime.host.teamId, actor: 'root',
    requestId: payload.entityId, operationId: 'v1:operation:' + payload.operation.padEnd(20, 'x'), payload: payload.body });
  command({ entityId: 'member-intent:w', operation: 'member-w',
    body: { command: 'team.member.request', entityId: 'member-intent:w', role: 'worker', workspaceRel: 'ws' } });
  await until(() => runtime.store.read('member-intent:w')?.status === 'confirmed');
  control.cwd = runtime.store.read('member.workspace:member:w').resolved;
  command({ entityId: 'task:work', operation: 'task-work',
    body: { command: 'team.task.request', entityId: 'task:work', owner: 'member:w', scopeSet: [control.cwd] } });
  await until(() => runtime.store.list('attempt:').some(row => row.taskId === 'task:work' && row.lease === 'active'));
  await until(() => [...control.guards.values()].some(list => list.length > 0));
  const sessionId = [...control.guards.keys()][0];
  const session = w.sessions.get(sessionId);
  return {
    ...w, control,
    /** Push one tool call down the profile's pipeline: the guards it installed, then the tool's own write. */
    run(name, args) {
      for (const guard of control.guards.get(sessionId) ?? []) {
        const reason = guard({ name, arguments: args });
        if (reason !== undefined) return { refused: String(reason) };
      }
      // What the native file tool does once the guard allows it: resolve against its own working directory and write.
      const base = control.live ?? session.header.cwd;
      const target = nativeWriteTarget(args.file_path, base);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, String(args.content ?? ''));
      return { written: target };
    },
  };
}
