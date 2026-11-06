import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { taskBrief } from './collab-task/brief.mjs';
import { workspaceOf } from './collab-session.mjs';

/** Prompts and per-role descriptions for the collaboration stage; the stage keeps its transitions and main loop. */
const here = path.dirname(fileURLToPath(import.meta.url));
export const hiddenSet = path.join(here, 'collab-task', 'hidden-set', 'e2e-hidden.test.mjs');
export const executors = ['be', 'fe', 'qa'];

export function roleOf(engine, actor) {
  const entry = engine.topology.find(([name]) => name === actor);
  return entry ? entry[1] : 'worker';
}

/** Root states the objective and never states an interface. */
export function briefPrompt(engine) {
  return taskBrief.text + ' Your team: ' + engine.topology.map(([actor]) => 'member:' + actor + ' (' + roleOf(engine, actor) + ')').join(', ') +
    '. Delegate one action to member:be, member:fe, member:qa and member:verifier with team_message, then stop.';
}

export function deliverable(actor) {
  return { be: 'the backend API and its storage in server.mjs',
    fe: 'the static frontend page in index.html',
    qa: 'the end-to-end test suite in e2e.test.mjs',
    verifier: 'the independent acceptance of what the three executors produced',
    root: 'coordination, integration and the decision on the batch' }[actor] ?? 'your assigned part';
}

/**
 * Where each executor's part has to live, relative to its own workspace.
 *
 * The integration step copies exactly these three files into one application directory and runs the hidden set
 * against it, so the file name is part of the workload and not part of the open interface: endpoints, payload shapes
 * and field names stay the member's choice, the artifact's location cannot be. The second real run wrote a correct
 * backend to ws/qa/server.mjs and a working page to ws/fe/index.html plus ws/fe/api.js, and the integration copied
 * nothing at all, because nothing said where the artifact was expected. The prompt states it, the delegation states
 * it, and integrate() records what it did not find.
 */
export const deliverablePath = { be: 'server.mjs', fe: 'index.html', qa: 'e2e.test.mjs' };

/** The delivery row the executor submits against; root records the expectation when it delegates. */
export const deliveryRefOf = actor => 'delivery:collab:' + actor + ':v1';

export function memberPrompt(engine, actor) {
  const state = engine.states.get(actor), taskRef = state?.task ?? 'task:collab:' + actor;
  return 'You are member:' + actor + '. Your workspace is ' + workspaceOf(engine, actor) + '. ' +
    'Your part is ' + deliverable(actor) + ', and the file the team integrates is ' + deliverablePath[actor] +
    ' at the root of your workspace. Work there with the read, write, edit and bash tools; use the team tools for your part of the interface. ' +
    'When that file is complete, submit it with team_task {op:"produce", taskRef:"' + taskRef + '", deliveryRef:"' +
    deliveryRefOf(actor) + '"} -- an unsubmitted file is not a delivery and the integration cannot see it. ' +
    'On the collaboration arm the submission is refused with INTENT_REQUIRED until you have announced the interface ' +
    'with team_message kind=intent to the member who consumes your part (to:["member:<downstream>"], taskRef, ' +
    'contractRevision), so send that first: the window closes by itself and silence counts as ok, so you never wait for ' +
    'an ack. Then stop.';
}

export function verifyPrompt(engine) {
  return 'Independent acceptance of what member:be, member:fe and member:qa produced in their workspaces ' +
    ['be', 'fe', 'qa'].map(actor => 'member:' + actor + '=' + workspaceOf(engine, actor)).join(', ') + '. ' +
    'Read the files, decide whether the application meets the brief, and record one verdict per delivery with ' +
    'team_verify {deliveryRef, contractRevision:1, verdict:"pass" or "fail", evidenceRefs:[], reason:"what you ran"}. ' +
    'The deliveries to record are ' + executors.map(actor => deliveryRefOf(actor) + ' (member:' + actor + ')').join(', ') +
    '; a delivery you do not record stays unverified and blocks the integration. ' +
    'On the collaboration arm announce the acceptance contract with one team_message kind=intent first (to:["member:root"], ' +
    'taskRef, contractRevision); until that window closes team_verify is refused. Silence is consent, so do not wait for ' +
    'an answer. You do not write the application. Then stop.';
}
