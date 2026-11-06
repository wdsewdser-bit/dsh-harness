// Shared by a pristine git archive of 5325aeb and the working tree. No product code is mocked.
// The child process owns a deterministic clock/UUID source, so timestamps, ref relationships,
// payload hashes and snapshot text are compared exactly instead of being erased by normalization.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { syncBuiltinESMExports } from 'node:module';
import { ControlStore } from '../../packages/store/index.mjs';
import { TeamCore, snapshot } from '../../packages/core/index.mjs';
import { handleTool } from '../../packages/core/tools.mjs';
import * as toolContracts from '../../packages/contracts/team-tools.mjs';
import { codes, collabConfig, autonomyConfig } from '../../packages/contracts/index.mjs';
import { generate } from '../../packages/profiles/index.mjs';
import { profile as mountProfile } from '../../packages/host/test-support/profile.mjs';

const dir = path.resolve(process.argv[2]);
const explicitOff = process.argv[3] === 'explicit-off';
const borrow = explicitOff ? { superagentBorrow: 'off' } : {};
const NativeDate = Date;
const now = NativeDate.parse('2026-11-01T00:00:00.000Z');
globalThis.Date = class extends NativeDate {
  constructor(...args) { super(...(args.length ? args : [now])); }
  static now() { return now; }
};
let uuid = 0;
crypto.randomUUID = () => '00000000-0000-4000-8000-' + (++uuid).toString(16).padStart(12, '0');
let byte = 0;
crypto.randomBytes = size => Buffer.from(Array.from({ length: size }, () => (++byte) & 255));
syncBuiltinESMExports();

// Only the fixture's physical location is normalized. Changes to roots/suffixes still differ.
function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(key => [key, stable(value[key])]));
  if (typeof value === 'string') return value.split(dir).join('<work>').split(dir.replaceAll('\\', '/')).join('<work>');
  return value;
}
const pluginURL = new URL('../../packages/profiles/team-plugin.mjs', import.meta.url).href;
const specifications = {
  default: { team: false, guard: false, goalCheck: false },
  team: { team: true, guard: true, goalCheck: true },
  collab: { team: true, guard: true, goalCheck: true, collab: 'on', decisionLimit: 4, assumptionDeadline: 'PT1M' },
  autonomy: { team: true, guard: true, goalCheck: true, autonomy: 'on', goalGate: { strict: true }, stopGraceMs: 1000,
    decisionTtlMs: 600000, budget: { unknownUsage: 'stop', unknownGraceMs: 1000 } },
  full: { team: true, guard: true, goalCheck: true, autonomy: 'on', collab: 'on', intentWindowMs: 1000 },
};
const profiles = {};
for (const [name, specification] of Object.entries(specifications)) {
  const profileRoot = path.join(dir, 'profiles', name);
  const generated = generate(profileRoot, { ...specification, ...(specification.team ? borrow : {}) });
  let patchText = fs.readFileSync(path.join(profileRoot, 'cordis.patch.yml'), 'utf8');
  if (explicitOff && specification.team) {
    const patch = JSON.parse(patchText);
    const config = patch[0].insert.find(entry => entry.name === pluginURL).config;
    if (config.superagentBorrow !== 'off' || config.ownerModel !== null || config.intentSemantics !== 'undecided') {
      throw Error('serialized explicit off config was not forwarded intact');
    }
    delete config.superagentBorrow; delete config.ownerModel; delete config.intentSemantics;
    patchText = JSON.stringify(patch);
  }
  profiles[name] = {
    files: { base: fs.readFileSync(path.join(profileRoot, 'cordis.yml'), 'utf8'),
      patch: patchText.split(JSON.stringify(dir).slice(1, -1)).join('<work>').split(pluginURL).join('<team-plugin>') },
    entries: generated.entries.map(entry => {
      const config = { ...entry.config };
      // The only intended serialized difference when off is explicitly named. Assert before removing it.
      if (explicitOff && entry.name === pluginURL) {
        if (config.superagentBorrow !== 'off' || config.ownerModel !== null || config.intentSemantics !== 'undecided') {
          throw Error('explicit off config was not forwarded intact');
        }
        delete config.superagentBorrow; delete config.ownerModel; delete config.intentSemantics;
      }
      return { id: entry.id, name: entry.name === pluginURL ? '<team-plugin>' : entry.name, config: stable(config) };
    }),
    whitelist: generated.whitelist.map(name => name === pluginURL ? '<team-plugin>' : name),
    capabilityHash: generated.capabilityHash,
  };
}
fs.rmSync(path.join(dir, 'profiles'), { recursive: true, force: true });

const positions = {}, executions = {};
for (const collab of ['off', 'on']) for (const autonomy of ['off', 'on']) {
  const key = collab + '/' + autonomy;
  const schemas = explicitOff ? toolContracts.teamSchemasForBorrow('off', collab, autonomy) : toolContracts.teamSchemasFor(collab, autonomy);
  positions[key] = {
    identityWithDefault: schemas === toolContracts.teamSchemas,
    schemas: JSON.stringify(schemas),
    catalogHash: crypto.createHash('sha256').update(JSON.stringify(['root', 'subCoordinator', 'worker', 'verifier']
      .map(role => toolContracts.roleTools(role, collab, autonomy)))).digest('hex'),
    roles: Object.fromEntries(['root', 'subCoordinator', 'worker', 'verifier']
      .map(role => [role, JSON.stringify(toolContracts.roleTools(role, collab, autonomy))])),
  };
  const store = new ControlStore(path.join(dir, key.replace('/', '-')));
  try {
    const core = new TeamCore(store, {}, { enabled: true, collab, autonomy });
    core.member('member:root', 'root');
    core.member('member:w', 'worker');
    const sent = core.send('member:root', 'member:w', 'info', 'off baseline hello');
    core.send('member:root', 'member:w', 'info', 'second distinct message');
    const messageId = sent.result.entityId;
    // Thread reads/writes were missing from the original golden: a new default kind must not escape in off.
    core.thread('member:root', [], 'off review', '2026-11-01T00:01:00.000Z', 'member:root');
    const threadRead = handleTool(core, { actor: 'member:root' }, 'team_read', { view: 'thread' });
    const toolResults = { threadRead };
    const calls = {
      read: () => handleTool(core, { actor: 'member:root' }, 'team_read', { view: 'team' }),
      provision: () => handleTool(core, { actor: 'member:root' }, 'team_member',
        { operationId: 'v1:operation:off-provision-0001', op: 'provision', role: 'worker' }),
      decide: () => handleTool(core, { actor: 'member:root' }, 'team_decide',
        { operationId: 'v1:operation:off-decide-0001', decisionId: 'decision:none', decision: 'waive' }),
      accept: () => handleTool(core, { actor: 'member:w' }, 'team_message',
        { operationId: 'v1:operation:off-accept-0001', expectedRevision: 1, op: 'accept', messageId, checkpointRef: 'checkpoint:cp-1' }),
    };
    for (const [name, call] of Object.entries(calls)) {
      try { const receipt = call(); toolResults[name] = { ok: true, result: receipt.result ?? null }; }
      catch (error) { toolResults[name] = { ok: false, code: String(error?.code ?? error?.message ?? error) }; }
    }
    executions[key] = { toolResults, snapshots: [snapshot(core, 'member:w'), snapshot(core, 'member:w', null, 1)],
      rows: store.list(''), journal: store.events(), teamPolicyRows: store.list('team-policy:').length };
  } finally { store.close(); }
  // Exercise the production plugin entry as well, not only the direct core. Large interval prevents timer-driven work.
  const mounted = await mountProfile({ root: path.join(dir, 'runtime-' + key.replace('/', '-')),
    lifecycleIntervalMs: 600000, collab, autonomy, ...borrow });
  try {
    executions[key].runtime = { configuration: mounted.runtime.core.configuration,
      toolNames: [...mounted.globalTools.keys()].sort(), teamPolicyRows: mounted.runtime.store.list('team-policy:').length };
  } finally { await mounted.close(); }
}
const contracts = { collab: JSON.stringify(collabConfig()), autonomy: JSON.stringify(autonomyConfig()), codes: [...codes] };
process.stdout.write(JSON.stringify(stable({ profiles, positions, contracts, executions })) + '\n');
