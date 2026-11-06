// The HEAD baseline scenario (review 1, item 6): what one tree does with the autonomy switch OFF, as data.
//
// This file is copied verbatim into a pristine `git archive f41fdd1` checkout and run against THIS tree with the same
// arguments, by packages/profiles/test/autonomy-off-baseline.test.mjs. It therefore imports only modules that exist on
// both sides, and it never names the new switch's behaviour: it runs a fixed, offline sequence and prints what happened.
//
//   node autonomy-off-baseline-scenario.mjs <store-dir>
//
// Everything volatile is normalised (uuids, operationIds, wall-clock fields), so two runs of the same behaviour produce
// byte-identical JSON and any difference is a behavioural one: a tool branch, a journal row, an observation write.
//
// It lives outside packages/ on purpose: it is a verification fixture, not product code, and check-deps only arbitrates
// the package graph.
import { ControlStore } from '../../packages/store/index.mjs';
import { TeamCore } from '../../packages/core/index.mjs';
import { handleTool } from '../../packages/core/tools.mjs';
import { observeNative } from '../../packages/profiles/native-observations.mjs';
import { roleTools, teamSchemasFor } from '../../packages/contracts/team-tools.mjs';

const dir = process.argv[2];
const TIME_KEYS = new Set(['createdAt', 'updatedAt', 'recordedAt', 'at', 'measuredAt', 'expiresAt', 'nextReviewAt',
  'closesAt', 'deadline', 'evaluatedAt', 'answeredAt', 'admittedAt', 'since', 'lastAt', 'requestedAt', 'dueAt']);
const UUID = /v1:[a-z-]+:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g;
const ISO = /^\d{4}-\d\d-\d\dT[\d:.]+Z$/;

function stable(value, key = null) {
  if (Array.isArray(value)) return value.map(entry => stable(entry));
  if (value && typeof value === 'object') {
    const out = {};
    for (const name of Object.keys(value).sort()) out[name] = TIME_KEYS.has(name) ? '<time>' : stable(value[name], name);
    return out;
  }
  if (typeof value === 'string') return value.replace(UUID, 'v1:<id>').replace(ISO, '<time>');
  return value;
}

const store = new ControlStore(dir);
const core = new TeamCore(store, {}, { enabled: true, autonomy: 'off', collab: 'off' });
core.member('member:root', 'root');
core.member('member:w', 'worker');

// One session observation: a goal change (the read-model fact) and a measured spend (the usage boundary P6 adds). A tree
// that observes usage writes a usage row and a journal event here, even with the switch off -- which is what this
// baseline has to catch.
const sessionEvents = [{ seq: 4, type: 'goal/change', data: { goal: { id: 'goal-1', revision: 1, phase: 'working',
  objective: 'ship the baseline', maxGoalRounds: 3 } } }];
const session = { id: 'session:baseline', seq: 4, snapshotEvents: () => sessionEvents };
const ctx = {
  tokenMeter: { contextPressure: () => ({ pressureTokens: 120, contextWindow: 1000 }),
    measure: () => ({ logRevision: 4, totalTokens: 180 }) },
  sessionProjections: { stateOf: (unused, unit) => unit === 'tokenUsage'
    ? { uncachedInputTokens: 100, cacheReadTokens: 20, cacheWriteTokens: 0, outputTokens: 40 }
    : { pressureTokens: 120, contextWindow: 1000 } },
};
observeNative(ctx, core, 'member:w', session);
// A second observation at the same revision: a replay must add nothing either way.
observeNative(ctx, core, 'member:w', session);

const sent = core.send('member:root', 'member:w', 'info', 'baseline hello');
const messageId = sent.result.entityId;

// The tool surface, by identity and by content.
const schemas = JSON.stringify(teamSchemasFor('off'));
const roles = Object.fromEntries(['root', 'subCoordinator', 'worker', 'verifier']
  .map(role => [role, JSON.stringify(roleTools(role, 'off'))]));

// A fixed sequence of tool calls through the real entry. Each answer is the receipt's shape or the refusal code, so a
// branch that was added to the default surface (or a reducer that stopped refusing it) shows up as a difference.
const calls = {
  read: () => handleTool(core, { actor: 'member:root' }, 'team_read', { view: 'team' }),
  provision: () => handleTool(core, { actor: 'member:root' }, 'team_member',
    { operationId: 'v1:operation:baseline-provision-01', op: 'provision', role: 'worker' }),
  group: () => handleTool(core, { actor: 'member:root' }, 'team_member',
    { operationId: 'v1:operation:baseline-group-01', op: 'group', group: 'g1' }),
  decide: () => handleTool(core, { actor: 'member:root' }, 'team_decide',
    { operationId: 'v1:operation:baseline-decide-01', decisionId: 'decision:none', decision: 'waive' }),
  accept: () => handleTool(core, { actor: 'member:w' }, 'team_message',
    { operationId: 'v1:operation:baseline-accept-01', expectedRevision: 1, op: 'accept', messageId, checkpointRef: 'checkpoint:cp-1' }),
};
const toolResults = {};
for (const [name, call] of Object.entries(calls)) {
  try { const receipt = call(); toolResults[name] = { ok: true, result: stable(receipt.result ?? null) }; }
  catch (error) { toolResults[name] = { ok: false, code: String(error?.code ?? error?.message ?? error) }; }
}

const journal = store.events().map(event => ({ seq: event.seq, entity: stable(event.entity), revision: event.revision,
  payload: stable(event.payload) }));
const rows = store.list('').map(row => ({ id: stable(row.entityId), revision: row.revision,
  data: stable(Object.fromEntries(Object.keys(row).filter(key => key !== 'entityId' && key !== 'revision')
    .map(key => [key, row[key]]))) }))
  .sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));

process.stdout.write(JSON.stringify({ schemas, roles, toolResults, journal, rows,
  usageRows: store.list('usage:').length, readModels: store.list('read-model:').map(row => stable(row.entityId)) }) + '\n');
store.close();
