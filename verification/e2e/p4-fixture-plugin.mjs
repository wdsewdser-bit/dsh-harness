import { digest } from '../../packages/contracts/index.mjs';
import { snapshot } from '../../packages/core/snapshot.mjs';
import { registerOfflineAdapter, requestMember, until } from './p4-product.mjs';
import { waitDone } from './p4-sequence.mjs';

export const inject = ['teamRuntime', 'llm', 'goals', 'agents', 'sessions'];

/**
 * Fixture projection for visual acceptance of the Team UI.
 *
 * Every row the UI has a dedicated surface for is produced here through the ordinary committed paths — no store
 * stubs — so what a browser renders is what the server actually derives:
 *   collecting thread with a recorded reply (escalate + decide both available to root),
 *   an unknown *message* and an unknown *delivery* (the two adjudication kinds the UI routes differently),
 *   a draft contract awaiting approval (scheduler.approveContract),
 *   members that are not retired (organization.retire available),
 *   and, written LAST, a prepared completion token (goal-gate.authorizeCompletion is shown disabled).
 *
 * The token is last because COMPLETION_FROZEN refuses every later write outside completion:/inconsistency:.
 * Only TeamCore, the host's own ports (member requests, the visibility port) and llm are touched, so the same fixture
 * runs on the 0.2.2-alpha.2 C1 build (the previous release) and on 0.2.2-rc.1.
 *
 * F2b: the member sessions come from the product too. A member's native execution is created by the host from a
 * confirmed `team.member.request` intent, and the goal rides the team's owner session - the session bound to
 * `member:root` - instead of a native agent this script built for root.
 */
export async function apply(ctx, config) {
  // The scenario plugin registers the same provider in the acceptance host; the fixture never needs a second copy,
  // because any offline adapter answers these sessions identically. A duplicate registration is therefore not fatal.
  await registerOfflineAdapter(ctx, 'offline fixture step');
  const runtime = ctx.teamRuntime;
  // The service is declared as soon as the profile applies; its composition root finishes asynchronously.
  await runtime.ready;
  const core = runtime.core;
  const at = ms => new Date(Date.now() + ms).toISOString();
  const steps = [];

  // Plugins load concurrently, so a host that also runs the scripted scenario cannot rely on insertion order.
  // `after:'scenario'` makes this fixture wait for that run's committed rows before it writes anything: the prepared
  // completion token it ends with freezes every later write, so it must be last (COMPLETION_FROZEN).
  if (config.after === 'scenario') {
    await waitDone('scenario:' + config.root);
    steps.push('scenario-ready');
  }

  // Idempotent on purpose: in the acceptance host the scripted scenario may already have created these members.
  for (const [who, role] of [['root', 'root'], ['a', 'worker'], ['b', 'worker'], ['v', 'verifier']]) {
    if (!core.store.read('member:' + who)) core.member('member:' + who, role);
  }
  steps.push('members');
  // Standalone, nobody else creates the workers' native sessions, and a member that never had one shows as
  // "requested" rather than "active". In the acceptance host the scripted run already requested them, so this is a
  // no-op there: requesting a second session for one member is a reconciliation conflict, not a second member.
  for (const [whose, role] of [['a', 'worker'], ['b', 'worker'], ['v', 'verifier']]) await requestMember(runtime, whose, role);
  steps.push('member-sessions');

  // The goal lives on the team's owner session, never on a native agent built for member:root. In the acceptance host
  // the scenario bound that session and paused the goal already, so the fixture only reads the committed row back;
  // standalone it binds the session itself, the same way p3b-tests does.
  if (config.after !== 'scenario') {
    const owner = await ctx.agents.create({ sessionId: 'p4-fixture-root',
      agentOptions: { provider: 'offline', model: 'model' }, meta: { cwd: config.root } });
    runtime.router.bindExecution({ executionSessionId: owner.agent.session.id, teamId: runtime.host.teamId,
      memberId: 'member:root', generation: 1 });
    ctx.goals.create(owner.agent, { objective: 'P4 fixture: every Team surface in one projection', maxGoalRounds: 1 });
    const created = ctx.goals.get(owner.agent);
    ctx.goals.pause(owner.agent, { id: created.id, revision: created.revision });
  }
  const goalRow = await until(() => core.store.list('read-model:goal:').at(-1), 'the owner session goal');
  const goalSessionId = goalRow.sessionId;
  const goal = goalRow.goal;
  steps.push('goal');

  core.mutate('artifact:fixture-review', 'root', {}, tx => tx.put('artifact:fixture-review', { acl: ['member:root', 'member:b'],
        summary: 'review note for the collecting thread' }));
  core.mutate('artifact:fixture-adjudication', 'root', {}, tx => tx.put('artifact:fixture-adjudication', { acl: ['member:root', 'member:a'],
        summary: 'evidence bundle the operator names when adjudicating' }));
  steps.push('artifacts');

  // Task scopes are canonical absolute paths (core/scopes.mjs), so the fixture anchors them inside the run root.
  const scope = (config.root + '/fixture-task').replaceAll('\\', '/');
  core.task('task:fixture-draft', 'member:a', [scope + '/draft']);
  core.mutate('task:fixture-draft', 'root', {}, (tx, t) => tx.put('task:fixture-draft',
    { ...t, title: 'Draft contract awaiting approval', approved: false, status: 'draft', scopeApproval: { status: 'requested', requestedAt: Date.now() } }));
  core.task('task:fixture-delivery', 'member:a', [scope + '/delivery']);
  core.mutate('task:fixture-delivery', 'root', {}, (tx, t) => tx.put('task:fixture-delivery', { ...t, title: 'Batch with a lost merge receipt',
        status: 'produced' }));
  core.mutate('delivery:fixture-unknown', 'root', {}, tx => tx.put('delivery:fixture-unknown', { taskId: 'task:fixture-delivery', owner: 'member:a',
    target: 'refs/heads/main', status: 'unknown', responsible: 'operator',
    reason: 'fixture: the target ref moved while the merge receipt was in flight' }));
  steps.push('tasks-delivery');

  const lost = core.send('member:root', 'member:a', 'action', 'fixture: confirm the batch artifact landed',
    { expectedOutcome: 'ack with the target ref, or the rollback', deadline: at(3600000) });
  core.mutate(lost.result.entityId, 'root', {}, (tx, m) => tx.put(lost.result.entityId,
    { ...m, status: 'unknown', responsible: 'operator', reason: 'fixture: recipient session ended before the receipt was observed' }));
  const seen = core.send('member:root', 'member:b', 'info', 'fixture: the batch is on the review thread');
  // A visible fact needs the source the request really carried (invariant 8). The manifest row, the visible write and
  // its audit row are one write through the CA lifecycle port - never a test-side manifest, and never a direct
  // core.mutate on those entities (design §F 接线约束 2/3).
  const carried = snapshot(core, 'member:b');
  runtime.host.coreAccess.lifecycle().visibility(carried, 'native:fixture-visible', ['fixture-seq'],
    core.store.read('member:b').generation, { requestId: 'fixture-request-1', sessionSeq: 7, requestedAt: Date.now() });
  steps.push('messages');

  const issue = core.thread('member:root', ['member:b'], 'fixture: may the batch integrate once the unknown delivery is adjudicated?', at(1800000), 'operator',
    []).result;
  core.reply(issue.entityId, 'member:b', 1, 'artifact:fixture-review');
  steps.push('thread');

  // One last committed check: it is blocked by the unknown delivery above, which is the state the UI must show.
  runtime.gate.check({ sessionId: goalSessionId, goal: { id: goal.id, revision: goal.revision } });
  steps.push('goal-gate');

  // LAST when it exists: COMPLETION_FROZEN refuses every subsequent write outside completion:/inconsistency:.
  // completion='none' keeps the same fixture without the token, for a session that needs the admin commands usable.
  let tokenId = null;
  if (config.completion !== 'none') {
    tokenId = 'completion:fixture-token';
    core.mutate(tokenId, 'root', { fixture: true }, tx => tx.put(tokenId, {
      status: 'prepared', fixture: true,
      note: 'Fixture token: prepared so the UI renders the prepared state; goal-gate.authorizeCompletion is unsupported on the server, so its button must ' +
        'be disabled.',
        
        
      input: { sessionId: goalSessionId, goal: { id: goal.id, objective: goal.objective, revision: goal.revision, maxGoalRounds: goal.maxGoalRounds } },
      evidenceHash: digest({ fixture: 'completion-evidence' }) }));
    steps.push('completion-token');
  }

  ctx.provide('p4Fixture', { steps, rootSessionId: goalSessionId, goalId: goal.id, goalRevision: goal.revision, threadId: issue.entityId,
    messageId: lost.result.entityId, visibleMessageId: seen.result.entityId, tokenId });
  console.log('P4_FIXTURE ' + JSON.stringify({ steps, rootSessionId: goalSessionId, goalId: goal.id, threadId: issue.entityId, tokenId }));
}