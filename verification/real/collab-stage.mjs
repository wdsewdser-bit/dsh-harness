import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { buildPlan, buildChangePlan, buildAnswerPlan, nextCall, settleWindows, delegation, op } from './collab-fake.mjs';
import { taskBrief, changeNotice } from './collab-task/brief.mjs';
import { workspaceOf, collabCatalog } from './collab-session.mjs';
import { collabMetrics } from './collab-metrics.mjs';
import { handleTool } from '../../packages/core/tools.mjs';

/**
 * The collaboration stage: plan 11 section 3 as a runnable workload.
 *
 * Three executors and one independent verifier build a small full-stack tagged-todo application, each in its own
 * workspace, with the host's native file and shell tools. The brief states no interface. After the first integration
 * the requirement change is injected and the affected members have to propagate it themselves. The workload is the
 * same on both arms; the arm only decides whether the three collaboration mechanisms exist, which is what makes the
 * difference between the runs a measurement of the mechanisms instead of a measurement of two different tasks.
 */
import { hiddenSet, executors, roleOf, briefPrompt, deliverable, deliverablePath, deliveryRefOf, memberPrompt, verifyPrompt } from './collab-prompts.mjs';
import { delegate, bindTask } from './collab-delegate.mjs';
export { hiddenSet, executors, roleOf, briefPrompt, deliverable, deliverablePath, deliveryRefOf, memberPrompt, verifyPrompt } from './collab-prompts.mjs';
export { delegate } from './collab-delegate.mjs';
const planLeft=(engine,actor)=>(engine.plan?.get(actor)?.length??0)+(engine.heldCalls?.has(actor)?1:0);
/** Resolve every instruction root still owes this member, through the product's own command. */
function closeInstructions(engine, actor) {
  const open = engine.core.store.list('message:').filter(m => m.recipient === 'member:' + actor && m.sender === 'member:root' &&
    m.kind === 'action' && !['resolved', 'cancelled', 'expired', 'escalated', 'dead-letter'].includes(m.status));
  for (const message of open) {
    engine.runtime.host.executeAuthorized('business', () => handleTool(engine.core, { actor: 'member:root' }, 'team_message',
      { operationId: 'v1:operation:collab-close-' + message.entityId.split(':').at(-1), expectedRevision: message.revision,
        op: 'resolve', messageId: message.entityId, resultRef: 'task:collab:' + actor }));
  }
}
const until=async(predicate,what,timeoutMs=60000)=>{const end=Date.now()+timeoutMs;for(;;){const value=predicate();if(value)return value;if(Date
      .now()>end)throw Error('TIMEOUT: '+what);await new Promise(resolve=>setTimeout(resolve,10))}};
/**
 * §22: the member's live work attempt is found in the store, not from whatever the session happens to be routed to.
 *
 * A mailbox wake re-binds the session to 'task:mail-...', and the product's ruling A releases that wake when its turn
 * ends. Reading the route therefore says nothing about whether the member still holds a work lease, and admitting a
 * second task on top of a live one gave the member two work attempts (the produce then bound to the wrong one). The
 * store is the authority: any active attempt of this member that is not a mailbox wake is the round's work lease.
 */
export async function admit(engine,actor,label){if(actor==='root')return null;
 const live=engine.core.store.list('attempt:').find(a=>a.owner==='member:'+actor&&a.lease==='active'&&!String(a.taskId).startsWith('task:mail-'));
 if(live)return bindTask(engine,actor,live.taskId);
 const state=engine.states.get(actor),taskRef='task:collab:'+actor+':'+label;state.task=taskRef;if(!engine.core.store.read(taskRef))engine
 .submit('team.task.request',taskRef,{owner:'member:'+actor,scopeSet:[workspaceOf(engine,actor)]});return bindTask(engine,actor,taskRef);
   }

/**
 * One integration: copy what the members produced into the accepted application directory and run the hidden
 * end-to-end set against that copy. The result is the integration outcome, so a part nobody fixed fails here.
 */
export function integrate(engine, label) {
  const app = path.join(engine.root, 'app');
  // The expected path is the one the prompt and the delegation name. A file the member placed somewhere else in its own
  // workspace is searched for by basename and copied from there, because "the integration found nothing" and "the member
  // wrote the wrong name" are different facts and the second one must not be reported as the first: a delivery nobody
  // could integrate is the workload's failure, and it has to be visible as such.
  const parts = { be: [deliverablePath.be], fe: [deliverablePath.fe], qa: [deliverablePath.qa] };
  for (const actor of Object.keys(parts)) fs.mkdirSync(path.join(app, actor), { recursive: true });
  const copied = [], missing = [], relocated = [];
  for (const [actor, names] of Object.entries(parts)) {
    for (const name of names) {
      const expected = path.join(workspaceOf(engine, actor), name);
      const source = fs.existsSync(expected) ? expected : findByName(workspaceOf(engine, actor), name);
      if (!source) { missing.push({ actor, name }); continue; }
      const target = path.join(app, actor, name);
      fs.copyFileSync(source, target);
      if (source !== expected) relocated.push({ actor, name, foundAt: path.relative(workspaceOf(engine, actor), source) });
      copied.push({ actor, name, bytes: fs.statSync(target).size });
    }
  }
  const row = { label, at: Date.now(), copied, missing, relocated, ...runHidden(app) };
  engine.facts.collab.integrations.push(row);
  // An integration is the largest unit of progress this workload produces, so it moves the stop clock too.
  engine.progress('integration:' + label);
  return row;
}

/** One integration's hidden-set outcome, in the shape the delivery record reports it. */
export function hiddenOf(integration) {
  return integration ? { pass: integration.pass, fail: integration.fail, total: integration.total,
    copied: integration.copied.length, missing: integration.missing ?? [], relocated: integration.relocated ?? [] } : null;
}

/**
 * Record the cycle that has just been integrated, at the moment it is integrated.
 *
 * The stage used to write this once, after the change round, which made a completed cycle invisible whenever the run
 * ended in between: the fourth real run integrated a full build round (three artifacts copied, three deliveries
 * verified, three of four hidden checks passing) and was cut during the change round, so the report read
 * completedCycles 0 and had to reconstruct the cycle from the pre-integration snapshot by hand.
 *
 * So it is written twice: immediately after the first integration and again after the change round, where the second
 * call reports the change cycle and keeps the first cycle's hidden outcome beside it. completedCycles never decreases
 * within a run -- a cycle that finished is not undone by a later round that did not -- and both writes read the same
 * deliveryState(), so the record and the assertion cannot disagree about what was submitted and verified.
 */
export function writeDelivery(engine, integration) {
  const state = deliveryState(engine);
  const previous = engine.facts.collab.delivery ?? null;
  // The pre-change state is captured by the stage before the first integration. When this is the first write and no
  // such capture exists, the state being written now is that capture: without this the record claims there was no
  // first cycle at all, which is exactly the hole the fourth real run fell into.
  const first = engine.facts.collab.firstIntegration ?? previous?.firstIntegration ?? state;
  const firstHidden = previous?.firstHidden ?? hiddenOf(integration);
  const cycles = Math.max(previous?.completedCycles ?? 0, state.completedCycles);
  engine.facts.collab.delivery = { ...state, completedCycles: cycles, hidden: hiddenOf(integration),
    firstIntegration: first, firstHidden };
  engine.facts.completedCycles = Math.max(engine.facts.completedCycles ?? 0, cycles);
  return engine.facts.collab.delivery;
}

/** The nearest file with this basename inside the member workspace, so a mis-placed artifact is still read back. */
function findByName(root, name) {
  const queue = [root];
  while (queue.length) {
    const current = queue.shift();
    let entries = [];
    try { entries = fs.readdirSync(current, { withFileTypes: true }); } catch { continue; }
    for (const entry of entries) {
      if (entry.isDirectory()) { if (entry.name !== 'node_modules' && !entry.name.startsWith('.')) queue.push(path.join(current, entry.name)); }
      else if (entry.name === name) return path.join(current, entry.name);
    }
  }
  return null;
}

/**
 * What the team actually delivered, counted from committed rows and from disk.
 *
 * The second real run is the reason this exists. Its stage returned after its rounds, every turn had ended by itself,
 * and nothing had ever been produced: no task was submitted, no delivery was verified, and the hidden set had nothing
 * to run. The report called that a pass because no assertion asked whether a cycle had completed. So the count is
 * derived here, once, and the summary refuses a run whose count is zero.
 */
export function deliveryState(engine) {
  const tasks = engine.core.store.list('task:').filter(row => row.entityId.startsWith('task:collab:'));
  const produced = tasks.filter(row => ['produced', 'verified', 'accepted'].includes(row.status));
  const evidence = engine.core.store.list('verification-evidence:');
  const files = Object.fromEntries(executors.map(actor => {
    const expected = deliverablePath[actor];
    const absolute = path.join(workspaceOf(engine, actor), expected);
    return [actor, { expected, present: fs.existsSync(absolute),
      bytes: fs.existsSync(absolute) ? fs.statSync(absolute).size : 0 }];
  }));
  const applied = Object.values(files).filter(row => row.present).length;
  // A verification is the accepted evidence row the independent verifier wrote against that delivery, so a delivery
  // counts as verified only when its own deliveryRef appears in one: a status column alone would accept the verifier's
  // review of one artifact as the acceptance of three.
  const verifiedRefs = new Set(evidence.filter(row => row.status === 'evidence-only' || row.certificate !== undefined)
    .map(row => row.deliveryRef).filter(Boolean));
  const verified = executors.filter(actor => verifiedRefs.has(deliveryRefOf(actor))).length;
  const submitted = executors.filter(actor => tasks.some(row => row.owner === 'member:' + actor &&
    ['produced', 'verified', 'accepted'].includes(row.status))).length;
  return {
    // A cycle completes when every artifact exists at its published path, every executor submitted its delivery and
    // every delivery was independently verified. Producing without the file, or a file nobody submitted, is exactly the
    // half-state this stage kept reporting as a finished cycle.
    tasks: tasks.length, produced: produced.length, submitted, verified, accepted: tasks.filter(row => row.status === 'accepted').length,
    evidence: evidence.length, files, filesPresent: applied,
    completedCycles: applied === executors.length && submitted === executors.length && verified === executors.length ? 1 : 0,
    note: 'a cycle completes only when every executor artifact exists at its published path, every delivery was submitted with team_task produce and every ' +
      'delivery was verified with team_verify',
  };
}

/**
 * The security checks the release stages run, restated for this topology, plus the workspace boundary.
 *
 * The release harness proves role escalation, forged actors and message-id misuse are refused. The collaboration
 * stage adds the property that made native tools usable at all: a member cannot write outside its own workspace, and
 * the refusal is the running guard and not this script's opinion of what the guard should say.
 */
export async function collabSecurity(engine) {
  const be = engine.states.get('be');
  const binding = be.binding;
  const checks = [
    ['role escalation', () => engine.core.store.read('member:be').role !== 'verifier' &&
      handleToolFor(engine, 'be', 'team_verify', { operationId: 'v1:operation:collab-security-verify', expectedRevision: 0,
        deliveryRef: 'delivery:collab:be:v1', contractRevision: 1, verdict: 'pass', evidenceRefs: [], reason: 'self approval' })],
    ['forged actor', () => handleToolFor(engine, 'be', 'team_message', { operationId: 'v1:operation:collab-security-forged',
      expectedRevision: 0, op: 'send', to: 'member:root', kind: 'info', summary: 'x', actor: 'member:root' })],
    ['message ID misuse', () => handleToolFor(engine, 'be', 'team_message', { operationId: 'v1:operation:collab-security-accept',
      expectedRevision: 0, op: 'accept', messageId: 'operation:fake', checkpointRef: 'checkpoint:forged' })],
  ];
  for (const [name, run] of checks) {
    try { run(); engine.facts.security.push({ name, rejected: false, rawError: null }); }
    catch (error) { engine.facts.security.push({ name, rejected: true, rawError: error.message }); }
  }
  // The workspace boundary, exercised through the same tool pipeline the model uses.
  const escape = path.join(engine.root, 'escape.txt');
  const refusal = await callTool(engine.agent('be').ctx, { callId: 'collab-escape-' + Date.now(), name: 'write',
    arguments: { file_path: escape, content: 'outside' }, agent: engine.agent('be'), signal: new AbortController().signal });
  const blocked = !fs.existsSync(escape) && String(refusal?.content?.[0]?.text ?? '').includes('WORKSPACE_BOUNDARY');
  engine.facts.security.push({ name: 'workspace escape refused', rejected: blocked,
    rawError: blocked ? null : String(refusal?.content?.[0]?.text ?? '').slice(0, 120) });
  engine.facts.collab.security = engine.facts.security.map(row => ({ name: row.name, rejected: row.rejected }));
  return engine.facts.security;
}

/**
 * Run one call through the registry and return its materialized result.
 *
 * 0.2.2 moved execution behind a mounted executor plugin: `tools.execute` now takes an assistant step's batch of raw
 * calls and settles them through that executor, so a single call is a one-call batch and the result comes back as the
 * ordered settlement entry. The release before it takes the typed call itself and returns the result directly. Both
 * paths run the same registry, the same guards and the same workspace refusal this probe exists to observe.
 */
async function callTool(ctx, exec) {
  if (typeof ctx.tools.selectExecutor !== 'function') return ctx.tools.execute(exec);
  const batch = await ctx.tools.execute({ calls: [{ id: exec.callId, name: exec.name,
    arguments: JSON.stringify(exec.arguments) }], agent: exec.agent, signal: exec.signal });
  return batch.results[0].result;
}

function handleToolFor(engine, actor, name, args) {
  return handleTool(engine.core, { actor: 'member:' + actor, ...engine.states.get(actor).binding }, name, args);
}

/** The hidden set runs here and only here: the members never see this path or these files. */
export function runHidden(workspace) {
  // node --test does not hand extra argv to the test file, so the workspace travels in the environment.
  const run = spawnSync(process.execPath, ['--test', '--test-reporter=tap', hiddenSet], { encoding: 'utf8', timeout: 120000,
    env: { ...Object.fromEntries(Object.entries(process.env).filter(([key]) => /^(PATH|Path|SYSTEMROOT|WINDIR|TEMP|TMP|COMSPEC|PATHEXT)$/i.test(key))),
      APP_WORKSPACE: workspace } });
  const output = String(run.stdout ?? '') + String(run.stderr ?? '');
  // The reporter differs between a terminal (spec, "i pass 4") and a pipe (tap, "# pass 4"); both are counted so the
  // number does not depend on how the stage was launched.
  const count = label => { const match = output.match(new RegExp('^(?:# |.{0,3})' + label + ' (\\d+)\\s*$', 'm')); return match ? Number(match[1]) : null; };
  const pass = count('pass') ?? 0, fail = count('fail') ?? 0, total = count('tests');
  return { pass, fail, total: total ?? pass + fail, exitCode: run.status,
    failures: output.split('\n').filter(line => /^not ok /.test(line)).map(line => line.trim()).slice(0, 6),
    ...(run.status !== 0 ? { failureOutput: output.slice(-16000), spawnError: run.error?.message ?? null } : {}) };
}

/**
 * The provider behaviour for this stage.
 *
 * Each request answers with the member's next scripted call, the way fake.mjs answers for the release stages. A call
 * the server refuses is not retried by the script: the refusal is the observation (INTENT_REQUIRED, WORKSPACE_BOUNDARY),
 * and the following scripted call is what a model would do after reading it. Recording the refusal and moving on keeps
 * the stage honest about what the guard did without pretending the model reasoned its way out of it.
 */
export function collabFake(engine) {
  let serial = 0;
  return async (body, meta) => {
    const seq = ++serial;
    const usage = { input_tokens: Math.ceil(JSON.stringify(body).length / 4), output_tokens: 40,
      input_tokens_details: { cached_tokens: meta.purpose === 'replay' ? 100 : 0 }, cost: 0 };
    const state = engine.states.get(meta.actor);
    let planned = null;
    // The host clock runs between steps: an announcement made in an earlier step has its window closed before the
    // next call is issued, so a member that heard nothing reads its silence as consent (host-protocol 4.2 rule 3).
    if (state && meta.purpose !== 'replay') await settleWindows(engine, meta.actor);
    if (state && meta.purpose !== 'replay') planned = nextCall(engine, meta.actor);
    (engine.facts.collab.planTrace ??= []).push({ actor: meta.actor, at: Date.now(), call: planned?.name ?? null,
      left: engine.plan?.get(meta.actor)?.length ?? null });
    const reasoning = { type: 'reasoning', id: 'rs-collab-' + seq, summary: [], encrypted_content: 'fake-signed:collab-' + seq };
    const call = planned ? [{ type: 'function_call', id: 'fc-collab-' + seq, call_id: 'call-collab-' + seq,
      name: planned.name, arguments: JSON.stringify(planned.args) }]
      : [{ type: 'message', id: 'msg-collab-' + seq, role: 'assistant', content: [{ type: 'output_text', text: 'done' }] }];
    return { id: 'collab-response-' + seq, usage, output: [reasoning, ...call] };
  };
}

/**
 * The run: build, integrate, inject the change, react, integrate again.
 *
 * The engine is already open and bound by the worker; this function owns only the turns, so a stage run and a failed
 * stage tear down through the same path as every other stage.
 */
/**
 * Append a round's scripted calls to the queue the members are already reading.
 *
 * Each member takes the next call from its own queue on each request, so a round is a set of additions and never a
 * replacement: replacing the map discarded the calls of every member whose turn had not started yet.
 */
export function mergePlan(engine, extra) {
  const merged = new Map(engine.plan ?? []);
  for (const [actor, calls] of extra) merged.set(actor, [...(merged.get(actor) ?? []), ...calls]);
  engine.plan = merged;
  return merged;
}

export async function collab(engine, { stopped }) {
  engine.facts.collab = { arm: engine.collab, delegated: [], injectedAt: null, rounds: [], integrations: [],
    startedAt: Date.now() };
  // The stop clock for this stage starts here, not at the stage start of some earlier work: the stage's own first
  // admission and delegation are progress, and the window is measured from the newest such signal.
  engine.progress('stage:start');
  // Admission first: root needs a live lease to speak, and the four members need theirs to accept.
  await delegate(engine);
  // Security runs before the first turn, not after the build round. Every probe reads a live lease and two of them only
  // need committed authority, so nothing in them depends on a member having produced anything; running them last meant
  // a run that stopped early reported one probe of four, and a control that is only measured when the workload happens
  // to finish cannot be compared between the arms.
  await collabSecurity(engine);
  // The published tool list per member is recorded before any turn, so the report can show exactly what this arm gave
  // the model instead of inferring it from the calls it happened to make.
  engine.facts.collab.catalog = Object.fromEntries(['root', 'be', 'fe', 'qa', 'verifier'].map(actor => {
    const published = collabCatalog(engine, actor);
    const message = published.find(schema => schema.name === 'team_message');
    // The intent kind is a branch of its own since the simplified send (host-protocol 4.3): it is published when any
    // branch of team_message either lists it in a kind enum or pins it as a const.
    const branches = message?.parameters?.oneOf ?? (message?.parameters ? [message.parameters] : []);
    const intentKind = branches.some(branch => {
      const kind = branch?.properties?.kind;
      return kind?.const === 'intent' || (Array.isArray(kind?.enum) && kind.enum.includes('intent'));
    });
    return [actor, { tools: published.map(schema => schema.name), intentKind }];
  }));
  await engine.turn('root', briefPrompt(engine));
  const round = async (label, actors, prompt) => {
    const started = Date.now();
    for (const actor of actors) {
      if (stopped()) break;
      await admit(engine, actor, label);
      // The instruction is a durable message, and the member holds the work attempt that authorizes the round, so the
      // product merges it into a live turn or opens the next one - never a mailbox task.
      await engine.turn(actor, prompt(actor));
      // A preempt can end a turn with scripted calls still queued; the same attempt takes them at its next turn. Only a
      // live attempt may be woken: a message sent to a member whose attempt has ended is not an instruction, it is the
      // product's mailbox-task fallback.
      if (planLeft(engine, actor) > 0 && engine.core.store.list('attempt:').some(a => a.owner === 'member:' + actor && a.lease === 'active'))
        await engine.turn(actor, prompt(actor));
    }
    engine.facts.collab.rounds.push({ label, started, finished: Date.now(), members: actors });
    engine.progress('round:' + label);
  };
  engine.plan = buildPlan(engine).plan;
  await round('build', executors, actor => memberPrompt(engine, actor));
  // An assumption raised after the owner's turn leaves the answer queued. The owner answers at its next boundary, which
  // is what mechanism 2 promises: the raiser is never blocked, and the answer lands before the first integration.
  // The rounds add to the queue instead of replacing it: replacing it dropped every scripted call of a member whose turn
  // had not come yet, which is how the verifier's acceptance run reached its turn with an empty plan and recorded no
  // verdict at all.
  mergePlan(engine, buildAnswerPlan(engine));
  if (buildAnswerPlan(engine).size) await round('answers', [...buildAnswerPlan(engine).keys()], () =>
    'A teammate raised an assumption that names you. Answer it with team_assume (confirm or correct) now, then stop.');
  if (!stopped()) await engine.turn('verifier', verifyPrompt(engine));
  // The delivery state at the instant before the first integration, captured rather than reconstructed: the change
  // round writes and submits again, so a state read only at the end of the stage could let round two stand in for a
  // first round that delivered nothing -- which is exactly the pass the second real run must not earn.
  engine.facts.collab.firstIntegration = deliveryState(engine);
  const first = integrate(engine, 'build');
  engine.facts.collab.integrationFailures = first.fail;
  // The first cycle is decided and recorded HERE, before the requirement change has any chance to run.
  //
  // The fourth real run completed exactly this cycle -- three artifacts at their published paths, three deliveries
  // produced, all three verified, one integration with three of four hidden checks passing -- and then stopped during
  // the change round, so the record that said so was never written and the report counted zero completed cycles. A
  // cycle that finished is a fact of its own; the change round is a second cycle whose verdict is written below when
  // it finishes, and it can only replace this record by delivering and integrating again.
  writeDelivery(engine, first);
  // The injection instant is recorded before the message is delivered, so propagation is measured from the change
  // and not from whenever the harness got round to the first turn after it.
  engine.facts.collab.injectedAt = Date.now();
  engine.facts.collab.change = { field: changeNotice.field, affected: changeNotice.affected, text: changeNotice.text };
  mergePlan(engine, buildChangePlan(engine));
  await round('change', changeNotice.affected.map(ref => ref.replace('member:', '')),
    actor => 'Requirement change from the user, authoritative: ' + changeNotice.text + ' Your workspace is ' + workspaceOf(engine, actor) + '.');
  if (!stopped()) await engine.turn('verifier', 'Re-accept the application after the requirement change, then stop.');
  const second = integrate(engine, 'change');
  engine.facts.collab.final = second;
  engine.facts.collab.hiddenTestPass = second.total ? second.pass / second.total : 0;
  // The cycle's own verdict, from committed state: deliverables were submitted (delivery rows), verified
  // (verification evidence rows) and the application was integrated and accepted. This is what the report reads
  // instead of treating "the stage returned" as "the workload succeeded".
  writeDelivery(engine, second);
  // The same two ledgers the metrics read, recorded as facts so an assertion can judge them even when the stage never
  // reaches its metrics: a run cut short by its own budget still raised assumptions and logged decisions, and a report
  // that can only count them after a completed stage calls those mechanisms failed when they were never measured.
  engine.facts.collab.assumptions = engine.core.store.list('assumption:').map(row => ({ entityId: row.entityId, raiser: row.raiser,
    owner: row.owner, status: row.status, raisedAt: row.raisedAt ?? null, answeredAt: row.answeredAt ?? null, about: row.about }));
  engine.facts.collab.decisions = engine.core.store.list('decision-log:').map(row => ({ entityId: row.entityId, actor: row.actor,
    summary: row.summary, affects: row.affects ?? [], decidedAt: row.decidedAt ?? null }));
  // completedCycles is the report's own word for "a cycle finished", so the stage sets it from committed state instead
  // of letting the worker's default zero mean both "no cycle" and "the stage never got that far".
  engine.facts.completedCycles = engine.facts.collab.delivery.completedCycles;
  // The stage owns its own clock: the worker's facts.elapsedMs is only written in its finally block, which runs after
  // the metrics are computed, so it would always be null here.
  engine.facts.collab.wallClock = Date.now() - engine.facts.collab.startedAt;
  engine.facts.collab.metrics = collabMetrics(engine);
  return engine.facts.collab.metrics;
}