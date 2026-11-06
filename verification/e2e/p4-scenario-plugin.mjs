import { commands, registerOfflineAdapter, requestMember, until } from './p4-product.mjs';
import { markDone } from './p4-sequence.mjs';
export const inject = ['teamRuntime', 'llm', 'goals', 'agents', 'sessions'];

/**
 * Produce real committed changes through a scripted team; 08 §5, §7.3.
 *
 * F2b: the scenario submits public commands and observes. The roster is three confirmed `team.member.request` intents,
 * whose native executions the host's effect runner creates; the work is one `team.task.request` per member, whose
 * first dispatch the host owns; and the recorded traffic is ordinary team messages. The scenario creates no agent for
 * a member, schedules no attempt, binds no agent and writes no visibility record - the F1 harness outlets are gone and
 * nothing replaces them from the outside.
 *
 * Root is the team's owner session, not a native member execution. The session that owns the team is bound to the
 * owner member with router.bindExecution - the binding the host itself writes for an execution - so the goal it
 * carries is inspected by the host's completion guard through the same route. `member:root` never gets a nativeRef,
 * which is what the projection must show.
 */
export async function apply(ctx, config) {
  const runtime = ctx.teamRuntime;
  // The service is declared as soon as the profile applies; its composition root finishes asynchronously. Everything
  // below reads the host, so it must not run before the host is up.
  await runtime.ready;
  const adapter = await registerOfflineAdapter(ctx, 'offline team step');
  const submit = commands(runtime);
  // The whole roster exists before any traffic starts: a message to a member that is not on the roster is refused
  // (UNKNOWN_MEMBER), and the host creates each native execution from the confirmed intent.
  for (const [name, role] of [['a', 'worker'], ['b', 'worker'], ['v', 'verifier']]) await requestMember(runtime, name, role);
  // The owner session, bound to the owner member the way p3b-tests binds the session that owns the team.
  const owner = await ctx.agents.create({ sessionId: 'p4-owner',
    agentOptions: { provider: 'offline', model: 'model' }, meta: { cwd: config.root } });
  runtime.router.bindExecution({ executionSessionId: owner.agent.session.id, teamId: runtime.host.teamId,
    memberId: 'member:root', generation: 1 });
  ctx.goals.create(owner.agent, { objective: 'Offline P4 projection verification', maxGoalRounds: 1 });
  const rootGoal = ctx.goals.get(owner.agent);
  ctx.goals.pause(owner.agent, { id: rootGoal.id, revision: rootGoal.revision });
  // One recorded message per member. They are sent before the work: a notice to a member that has no execution yet is
  // a delivery, not a wake, and the request the dispatch opens later carries it - which is what makes it visible
  // through the host's own flush instead of a test-side write.
  for (const name of ['a', 'b', 'v']) runtime.core.send('member:root', 'member:' + name, 'info', 'native step completed');
  for (const name of ['a', 'b', 'v']) {
    submit('team.task.request', 'task:' + name, { owner: 'member:' + name });
    // A mailbox delivery may open the turn before this loop reaches it, so the fact to wait for is the attempt the
    // host scheduled for the task - not that it is still running when we look.
    await until(() => runtime.store.list('attempt:').find(row => row.taskId === 'task:' + name), 'host-scheduled attempt for member ' + name);
    const handle = runtime.handles.get('member:' + name);
    await handle.agent.whenIdle();
    await ctx.sessions.flush(handle.agent.session);
    // The turn really ran: the host observed the usage sample the scripted adapter reported.
    await until(() => runtime.store.read('read-model:context:member:' + name)?.status === 'known', 'context sample for member ' + name);
  }
  ctx.provide('p4Scenario', { requests: adapter.requests, rootSessionId: owner.agent.session.id,
    goalId: rootGoal.id, goalRevision: rootGoal.revision });
  // Last statement on purpose: the fixture plugin waits on this before it writes (see ./p4-sequence.mjs).
  markDone('scenario:' + config.root);
}
