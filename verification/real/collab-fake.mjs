import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * The scripted provider behaviour for the collaboration stage, and the plan the members follow.
 *
 * The stage is offline: this module decides which tool each member calls next, exactly as fake.mjs does for the
 * release stages, so the wiring (guard, assumption delivery, decision ledger, snapshot block, native workspace tools)
 * is exercised without a provider request. What the members produce is real code: the fixtures are written through
 * the real native write tool into each member own workspace, and the hidden acceptance set then runs against those
 * files. That is what makes hiddenTestPass, integrationFailures and reworkRate measurements of the pipeline rather
 * than of a transcript.
 */
const here = path.dirname(fileURLToPath(import.meta.url));
export const fixtureText = (...parts) => fs.readFileSync(path.join(here, 'collab-task', 'fixtures', ...parts), 'utf8');

/** Stable operation ids: readable, unique per call site, and replayable. */
export const op = label => 'v1:operation:collab-' + label;

export const delegation = Object.fromEntries(['fe', 'be', 'qa', 'verifier'].map(actor => [actor, 'message:delegate-' + actor]));

/**
 * The server clock is the product's (host-protocol 4.5 rule 1: the window is closed by the clock, and the clock is the
 * only timer). The offline stage waits until the window it wants closed really has passed, then lets the host's
 * ordinary cycle close it; the collaboration profile shortens intentWindowMs to one second in every non-live mode, so
 * the wait is a real window rather than a five-minute one.
 *
 * A member that has announced an interface does not wait for an ack: silence when the window closes is consent.
 * Nothing here ticks the core or ends a window on its own -- the product's cycle owns the transition, exactly as it
 * does in production; the harness only paces itself to the deadline.
 */
export async function settleWindows(engine, actor) {
  const host = engine.runtime.host;
  const openRows = () => engine.core.store.list('message:').filter(row => row.kind === 'intent' &&
    row.sender === 'member:' + actor && !row.decision && Number.isFinite(row.closesAt));
  const open = openRows();
  if (open.length === 0) return 0;
  const until = Math.max(...open.map(row => row.closesAt));
  while (host.clock.now() <= until) await sleep(Math.min(50, until - host.clock.now() + 1));
  // The cycle timer would close the window anyway; one ordinary round makes the stage independent of where the timer
  // happens to be, and a round that raced the deadline is retried after a short wait.
  for (let attempt = 0; attempt < 20 && openRows().length > 0; attempt += 1) {
    await host.cycle.run();
    if (openRows().length > 0) await sleep(5);
  }
  return open.length;
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, Math.max(1, ms)));
// The four members and what each one is asked to do first.
export function buildPlan(engine) {
  const plan = new Map();
  const push = (actor, name, args) => {
    if (!plan.has(actor)) plan.set(actor, []);
    plan.get(actor).push({ name, args });
  };
  const accept = actor => push(actor, 'team_message', { operationId: op(actor + '-accept'), expectedRevision: 0,
    op: 'accept', messageId: delegation[actor], checkpointRef: 'checkpoint:collab-' + actor });
  // The simplified send of host-protocol 4.3: a recipient set, the contract revision the intent binds, and no deadline
  // -- the server owns the window. expectedRevision is filled per call by nextCall from the task the intent names.
  const intent = (actor, to, summary) => push(actor, 'team_message', { operationId: op(actor + '-intent'),
    op: 'send', to: ['member:' + to], kind: 'intent', summary,
    expectedOutcome: 'ok, or object with what breaks', taskRef: 'task:collab:' + actor, contractRevision: 1 });
  const write = (actor, rel, text) => push(actor, 'write', { file_path: rel, content: text });
  const decision = (actor, label, summary, affects) => push(actor, 'team_decision', {
    operationId: op(actor + '-decision-' + label), expectedRevision: 0, summary, affects });
  const assume = (actor, about, claim, impact) => push(actor, 'team_assume', { operationId: op(actor + '-assume'),
    expectedRevision: 0, about, claim, impact });
  const produce = actor => push(actor, 'team_task', { operationId: op(actor + '-produce'), expectedRevision: 0,
    op: 'produce', taskRef: 'task:collab:' + actor, deliveryRef: 'delivery:collab:' + actor + ':v1' });
  // §22 (ruling A): the responsibility is deliberately left open. It used to be resolved so that the member would not
  // be woken by a mailbox task it could not escape; a wake is now released when its turn ends and never holds a work
  // slot, and the message stops waking anyone as soon as one request has made it visible. A resolve was also the one
  // call the scripted member could not make stable: while a message is pending, every request that carries it rewrites
  // its visibility provenance and bumps the revision, so the revision the call planned is always one behind (CAS_CONFLICT)
  // - a real model re-reads and retries, a scripted one would only chase it.
  // The arm, not the script, decides which calls exist: on the control arm the intent kind and the two collaboration
  // tools are not published at all, so a script that sent them would be measuring a tool that the arm never had. The
  // task, the files and the integration are identical on both arms.
  const on = engine.collab === 'on';
  const say = (actor, to, summary) => on ? intent(actor, to, summary) : null;
  const log = (...args) => on ? decision(...args) : null;
  const note = (...args) => on ? assume(...args) : null;

  // be: the API producer. It writes its first file before it has said anything, which is the call the guard
  // refuses on the collaboration arm and lets through on the control arm.
  accept('be');
  write('be', 'server.mjs', fixtureText('be-v1', 'server.mjs'));
  say('be', 'fe', 'collection at /api/todos, POST {title,tags} returns 201 row, PATCH {done}, DELETE 204');
  write('be', 'server.mjs', fixtureText('be-v1', 'server.mjs'));
  log('be', 'ids', 'ids are server-minted strings, clients never send them', ['task:collab:qa']);
  produce('be');
  // fe: the consumer of the API, so its downstream for the interface is qa.
  accept('fe');
  write('fe', 'index.html', fixtureText('fe-v1', 'index.html'));
  say('fe', 'qa', 'page posts {title, tags:[name]} to the backend collection and renders one row per todo');
  write('fe', 'index.html', fixtureText('fe-v1', 'index.html'));
  note('fe', 'member:be', 'GET collection returns the full array, not an items envelope',
    'the page maps over the response body directly');
  log('fe', 'constant', 'the page reads the collection path from one constant', ['task:collab:be']);
  produce('fe');
  // qa: the end-to-end tests, driving the backend the same way the hidden set does.
  accept('qa');
  write('qa', 'e2e.test.mjs', fixtureText('qa-v1', 'e2e.test.mjs'));
  say('qa', 'verifier', 'the e2e test boots the backend on an ephemeral port and drives add/list/complete/delete');
  write('qa', 'e2e.test.mjs', fixtureText('qa-v1', 'e2e.test.mjs'));
  log('qa', 'boot', 'tests spawn the backend with PORT=0 and read the printed url', ['task:collab:be']);
  produce('qa');
  // verifier: independent acceptance. It reads back what the three produced, and it is gated by the same mechanism:
  // its own shell call is refused until it has told root what it is about to check against.
  accept('verifier');
  say('verifier', 'root', 'independent acceptance: read every produced file, run the members own suites, record a verdict');
  push('verifier', 'bash', { description: 'independent readback of the produced files', command: 'ls -l' });
  // One verdict per delivery, which is what makes a cycle complete: an integration nobody verified is not accepted, and
  // the report's cycle count reads these evidence rows rather than the fact that the stage reached its last line.
  for (const actor of ['be', 'fe', 'qa'])
    push('verifier', 'team_verify', { operationId: op('verifier-verify-' + actor), deliveryRef: 'delivery:collab:' + actor + ':v1',
      contractRevision: 1, verdict: 'pass', evidenceRefs: [], reason: 'read back ' + actor + ' artifact and re-ran it' });
  // The verifier produces no delivery, so nothing resolves its responsibility against one: a resolve that names
  // 'delivery:collab:verifier:v1' is refused with MISSING_REFERENCE (the guard that says only existing references are
  // written). Its delegation stays open on purpose; the product wakes it once per idle window and that wake is released.
  return { plan, push, accept, intent, write, decision, assume, produce };
}
/**
 * The answer round: an assumption raised after its owner already spoke is answered at the owner's next boundary.
 *
 * The plan is built from the committed ledger and not from the script, because the row to answer is whatever the
 * raise produced: the script knows who owes an answer, the store knows the id and the claim. Nothing here is derived
 * from the raise operationId, so the answer cannot pass by recomputing an implementation detail.
 */
export function buildAnswerPlan(engine) {
  const plan = new Map();
  if (engine.collab !== 'on') return plan;
  for (const row of engine.core.store.list('assumption:')) {
    if (row.status !== 'open' || !String(row.owner).startsWith('member:')) continue;
    const actor = row.owner.slice('member:'.length);
    if (!plan.has(actor)) plan.set(actor, []);
    plan.get(actor).push({ name: 'team_assume', args: { operationId: op(actor + '-answer-' + row.entityId.split(':')[1].slice(0, 16)),
      expectedRevision: 0, assumptionId: row.entityId, verdict: 'confirm' } });
  }
  return plan;
}

/**
 * The change round: the requirement change arrives and every affected member reacts in its own workspace.
 *
 * Each member rewrites the file it already produced, so reworkRate has something real to count and
 * changePropagationLatency is the wall-clock distance from the injection to that member first mutating call.
 */
export function buildChangePlan(engine) {
  const on = engine.collab === 'on';
  const plan = new Map();
  const push = (actor, name, args) => {
    if (!plan.has(actor)) plan.set(actor, []);
    plan.get(actor).push({ name, args });
  };
  push('be', 'write', { file_path: 'server.mjs', content: fixtureText('be-v2', 'server.mjs') });
  if (on) push('be', 'team_decision', { operationId: op('be-change'), expectedRevision: 0,
    summary: 'tags now carry color and a missing colour is filled with the default', affects: ['task:collab:fe'] });
  push('fe', 'write', { file_path: 'index.html', content: fixtureText('fe-v2', 'index.html') });
  if (on) push('fe', 'team_decision', { operationId: op('fe-change'), expectedRevision: 0,
    summary: 'tag chips render the colour the API returns', affects: ['task:collab:qa'] });
  push('qa', 'write', { file_path: 'e2e.test.mjs', content: fixtureText('qa-v2', 'e2e.test.mjs') });
  if (on) push('qa', 'team_decision', { operationId: op('qa-change'), expectedRevision: 0,
    summary: 'tests assert a hex colour on every returned tag', affects: ['task:collab:be'] });
  return plan;
}

/**
 * The next scripted call for one member, or null when the member has nothing left in this round.
 *
 * expectedRevision is filled from the committed row the call names. A script cannot know it in advance: accepting a
 * message that root just sent and producing against a task the scheduler just admitted both name rows whose revision
 * moved after the plan was built, and a stale expectation is a CAS refusal for a reason that has nothing to do with
 * the experiment.
 */
export function nextCall(engine, actor) {
  // The scripted member works only under its own task's lease: a mailbox wake has a task of its own and no scope, so
  // acting there would spend the round's calls on refusals. The turn ends and the work attempt takes the next one.
  if (!actingUnderWorkTask(engine, actor)) return null;
  // F2: the host preempts a live step when a durable message arrives, and the preempted response is discarded by the
  // product and the request issued again. A scripted plan that advanced on every request therefore lost the call the
  // discarded step carried - the change round's rewrite disappeared and the old artifact stayed in place. So a call
  // stays pending until it is visible in the actor's own journal as a tool call; only then is the next one issued.
  const held = (engine.heldCalls ??= new Map()).get(actor);
  if (held) {
    if (!executedSince(engine, actor, held.seq)) return withRevision(engine, held.call);
    engine.heldCalls.delete(actor);
  }
  const queue = engine.plan?.get(actor);
  if (!queue || !queue.length) return null;
  // §22 (ruling A): no read-before-produce. The wake attempt is released when the turn it woke ends and never
  // occupies a work slot, so unseen mail no longer has to be cleared before the member produces: the message becomes
  // visible in the request the wake itself opens, and that turn has nothing to do here (actingUnderWorkTask is false).
  const call = queue.shift();
  // §22: a round has its own task (admit names task:collab:<actor>:<round>), because producing finishes the attempt the
  // previous round ran on. The plan is built once, so the task a call binds to is resolved here, at call time: a
  // produce or an intent that named the round-less 'task:collab:<actor>' was refused with TASK_NOT_OWNED.
  if ((call.name === 'team_task' && call.args?.op === 'produce') || (call.name === 'team_message' && call.args?.op === 'send')) {
    const task = engine.states.get(actor)?.task;
    if (task) call.args = { ...call.args, taskRef: task };
  }
  engine.heldCalls.set(actor, { call, seq: engine.agent(actor).session.seq });
  return withRevision(engine, call);
}

function actingUnderWorkTask(engine, actor) {
  const route = engine.runtime.router.route(engine.agent(actor).session.id);
  const attempt = route?.attemptId ? engine.core.store.read(route.attemptId) : null;
  return Boolean(attempt) && !String(attempt.taskId).startsWith('task:mail-');
}

/** A call that reached the member's journal is one the member really made; a preempted step left nothing behind. */
function executedSince(engine, actor, seq) {
  return engine.agent(actor).session.snapshotEvents().some(event => event.seq > seq && event.type === 'tool/call');
}

function withRevision(engine, call) {
  return { ...call, args: { ...call.args, ...(call.name === 'team_task' || call.name === 'team_message'
    ? { expectedRevision: expectedRevision(engine, call.name, call.args) } : {}) } };
}

function expectedRevision(engine, name, args) {
  const ref = args.messageId ?? args.taskRef;
  if (!ref) return args.expectedRevision ?? 0;
  const row = engine.core.store.read(ref);
  return row ? row.revision : (args.expectedRevision ?? 0);
}