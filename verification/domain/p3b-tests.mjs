import fs from 'node:fs';
import { hostScenario } from '../integration/p3b-host.mjs';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const childWorker = fileURLToPath(new URL('../fixtures/p3b-worker.mjs', import.meta.url));
import { ControlStore } from '../../packages/store/index.mjs';
import { TeamCore } from '../../packages/core/index.mjs';
import { createGitGuardRunner, git } from '../../packages/delivery/index.mjs';
import { createHostDelivery } from '../../packages/host/src/delivery.mjs';
import { GoalGate } from '../../packages/core/index.mjs';
import { bootProfile, generate } from '../../packages/profiles/index.mjs';

/** The repository root: the goal gate's git evidence is read from a worktree that contains it. */
const repoRoot = fileURLToPath(new URL('../..', import.meta.url)).replace(/[/\\]+$/, '');

/** Exercise exact Git CAS and committed-state Goal approval offline; 08 §7.2 G/I/J. */
export async function p3Team(root, allFaults = false) {
  const repository = root + '/repo';
  fs.mkdirSync(repository, { recursive: true });
  await git(repository, 'init', '-b', 'main');
  await git(repository, 'config', 'user.email', 'offline@example.invalid');
  await git(repository, 'config', 'user.name', 'Offline Verification');
  fs.writeFileSync(repository + '/source.txt', 'baseline');
  await git(repository, 'add', '.'); await git(repository, 'commit', '-m', 'baseline');
  await git(repository, 'checkout', '--detach');
  const store = new ControlStore(root);
  const core = new TeamCore(store, {}, { enabled: true });
  core.member('member:worker', 'worker'); core.member('member:verifier', 'verifier');
  core.task('task:one', 'member:worker');
  // The delivery port is IO-only now; the transitions run here through the host side (design §3.7).
  const delivery = createHostDelivery({ core, repository });
  const work = await delivery.worktree('task:one', 'member:worker');
  core.mutate('task:one', 'root', {}, (tx, task) => tx.put('task:one', { ...task, scopeSet: [work.directory] }));
  assert.equal((await delivery.worktree('task:one', 'member:worker')).directory, work.directory);
  fs.writeFileSync(work.directory + '/source.txt', 'candidate');
  await git(work.directory, 'add', '.'); await git(work.directory, 'commit', '-m', 'candidate');
  await delivery.produce('task:one');
  await assert.rejects(() => delivery.verify('task:one', 'member:worker', 'test'), /NOT_INDEPENDENT/);
  await assert.rejects(() => delivery.verify('task:one', 'member:missing', 'test'), /MISSING_VERIFICATION_CONTRACT/);
  core.mutate('task:one', 'root', {}, (tx, task) => tx.put('task:one', { ...task, approved: false }));
  await assert.rejects(() => delivery.verify('task:one', 'member:verifier', 'test'), /MISSING_VERIFICATION_CONTRACT/);
  core.mutate('task:one', 'root', {}, (tx, task) => tx.put('task:one', { ...task, approved: true }));
  await delivery.verify('task:one', 'member:verifier', 'independent-readback');
  core.mutate('task:one', 'root', {}, (tx, task) => tx.put('task:one', { ...task, contractRevision: 2 }));
  await assert.rejects(() => delivery.integrate('task:one'), /STALE_CONTRACT/);
  core.mutate('task:one', 'root', {}, (tx, task) => tx.put('task:one', { ...task, contractRevision: 1 }));
  fs.writeFileSync(work.directory + '/dirty.txt', 'dirty');
  await assert.rejects(() => delivery.integrate('task:one'), /STALE_CANDIDATE/);
  fs.unlinkSync(work.directory + '/dirty.txt');
  fs.writeFileSync(repository + '/dirty-target.txt', 'dirty');
  await assert.rejects(() => delivery.integrate('task:one'), /DIRTY_TARGET_WORKTREE/);
  fs.unlinkSync(repository + '/dirty-target.txt');
  const base = await git(repository, 'rev-parse', 'main');
  const candidate = await git(work.directory, 'rev-parse', 'HEAD');
  await git(repository, 'update-ref', 'refs/heads/main', candidate, base);
  await assert.rejects(() => delivery.integrate('task:one'), /TARGET_MOVED/);
  await git(repository, 'update-ref', 'refs/heads/main', base, candidate);
  await assert.rejects(() => delivery.integrate('task:one', 'refs/heads/main', () => { throw Error('beforeGit-interrupt'); }), /beforeGit-interrupt/);
  assert.equal((await delivery.reconcile('task:one')).status, 'unknown');
  await assert.rejects(() => delivery.adjudicate('task:one', 'checked', 'worker'), /DENIED/);
  assert.equal((await delivery.adjudicate('task:one', 'target still equals base; Git not applied')).status, 'verified');
  const killed = spawnSync(process.execPath, [childWorker, 'git-kill', root, repository], { encoding: 'utf8' });
  assert.notEqual(killed.status, 0);
  assert.equal(await git(repository, 'rev-parse', 'main'), candidate);
  assert.equal(store.read('delivery:task:one').status, 'applying');
  assert.equal((await delivery.reconcile('task:one')).status, 'accepted');
  const gate = new GoalGate(core, () => {}, { gitGuard: createGitGuardRunner() });
  const input = { sessionId: 'session:one', goal: { id: 'goal:one', revision: 1, objective: 'deliver', maxGoalRounds: 5 } };
  assert.equal(gate.check(input), false);
  const token = gate.prepare(input);
  assert.throws(() => core.member('member:frozen', 'worker'), /COMPLETION_FROZEN/);
  assert.equal(gate.check(input), true);
  assert.equal(gate.check(input), false);
  const cold = spawnSync(process.execPath, [childWorker, 'cold-token', root, token], { encoding: 'utf8' });
  assert.equal(cold.status, 0, cold.stderr);
  assert.equal(JSON.parse(cold.stdout).status, 'authorized');
  gate.inspect({ id: input.sessionId }, { type: 'goal/change', seq: 2,
    data: { goal: { ...input.goal, revision: 2, phase: 'complete' } } });
  assert.equal(store.read(token).status, 'consumed');
  const interruptedInput = { ...input, goal: { ...input.goal, revision: 3 } };
  const interruptedToken = gate.prepare(interruptedInput);
  assert.equal(gate.check(interruptedInput), true);
  const absentSession = { id: input.sessionId, snapshotEvents: () => [] };
  gate.reconcile(absentSession);
  assert.equal(store.read(interruptedToken).status, 'unknown');
  gate.resolveAbsent(absentSession, interruptedToken, 'independent journal absence readback', 'operator');
  // The prior consumed token is also absent from this deliberately empty cold journal.
  assert.equal(store.read(token).status, 'unknown');
  gate.resolveAbsent(absentSession, token, 'independent journal absence readback', 'operator');
  store.close();
  await assert.rejects(() => bootProfile(root + '/negative', { team: true, guard: true, goalCheck: true },
    [{ name: 'file:///untrusted-plugin.mjs' }]), /UNTRUSTED_PLUGIN/);
  const team = await bootProfile(root + '/host', { team: true, guard: true, goalCheck: true, gitRoots: [repoRoot] });
  const ctx = team.ctx;
  // F2b: the completion guard is the host's route binding, not a gate attached to any agent. Only a session the router
  // holds for this team is guarded, so the goal is driven by the real owner session - the one that opened the team.
  const h = await ctx.agents.create({ sessionId: 'p3b-host', agentOptions: { provider: 'offline', model: 'model' }, meta: { cwd: root + '/host' } });
  // F2b: the guard is the host's route binding. This session is bound to the owner member the way the host binds
  // executions, so ctx.goals goes through the real registerCompletionGuard path instead of an attached gate.
  ctx.teamRuntime.router.bindExecution({ executionSessionId: 'p3b-host', teamId: ctx.teamRuntime.host.teamId, memberId: 'member:root', generation: 1 });
  const goal = ctx.goals.create(h.agent, { objective: 'unmet delivery' });
  assert.throws(() => ctx.goals.complete(h.agent, { id: goal.id, revision: goal.revision }));
  await ctx.sessions.flush(h.agent.session);
  const source = new ControlStore(root);
  for (const row of [...source.list('delivery:'), ...source.list('task:')]) {
    ctx.teamRuntime.core.mutate(row.entityId, 'root', {}, tx => tx.put(row.entityId, row));
  }
  source.close();
  const completionInput = { agentId: h.agent.id, sessionId: h.agent.session.id, goal: {
    id: goal.id, revision: goal.revision, objective: goal.objective, phase: goal.phase, maxGoalRounds: goal.maxGoalRounds } };
  const hostToken = ctx.teamRuntime.gate.prepare(completionInput);
  ctx.goals.complete(h.agent, { id: goal.id, revision: goal.revision });
  await ctx.sessions.flush(h.agent.session);
  assert.equal(ctx.teamRuntime.store.read(hostToken).status, 'consumed');
  const rawGoal = ctx.goals.create(h.agent, { objective: 'raw bypass' });
  const creation = h.agent.session.snapshotEvents().filter(e => e.type === 'goal/change').at(-1);
  h.agent.session.append('goal/change', { ...creation.data, operation: 'complete',
    goal: { ...creation.data.goal, phase: 'complete', revision: rawGoal.revision + 1 } });
  await ctx.sessions.flush(h.agent.session);
  assert.equal(ctx.teamRuntime.store.list('inconsistency:').length, 1);
  ctx.teamRuntime.gate.reconcile(h.agent.session);
  assert.equal(ctx.teamRuntime.store.list('inconsistency:').length, 1);
  const sessionId = h.agent.session.id;
  h.agent.cancel({ keepInbox: true });
  h.agent.cancel({ keepInbox: false });
  await h.dispose();
  const resumed = await ctx.agents.resume({ resumeSessionId: sessionId, agentOptions: { provider: 'offline', model: 'model' } });
  await resumed.dispose();
  await ctx.fiber.dispose();
  assert.throws(() => generate(root + '/unsafe', { team: true }), /UNSAFE_PROFILE/);
  const a = generate(root + '/headless', { team: true, guard: true, goalCheck: true, headless: true });
  assert.equal(a.capabilityHash, team.profile.capabilityHash);
  const plain = await bootProfile(root + '/default', { team: false });
  assert(!plain.ctx.teamRuntime);
  assert(!plain.ctx.tools.schemas().some(tool => tool.name.startsWith('team_')));
  assert(!fs.existsSync(root + '/default/state-v2'));
  await plain.ctx.fiber.dispose();
  const native = await hostScenario(root + '/native');
  const reusedFaults = allFaults ? await (await import('./p3-tests.mjs')).p3Regressions(root + '/reused-faults', 'A-H,K') : null;
  return { reusedFaults, native, exactSha: candidate, dirtyRejected: true, targetMovedRejected: true, lostReceiptRecovered: true,
    tokenColdRead: true, officialLoader: team.actual, defaultNoTeam: true, nativeLifecycle: true };
}
