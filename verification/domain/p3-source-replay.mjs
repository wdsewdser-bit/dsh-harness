import assert from 'node:assert/strict';
import { ControlStore } from '../../packages/store/index.mjs';
import { TeamCore } from '../../packages/core/index.mjs';
import { preStep, trustedManifests } from '../../packages/core/provenance.mjs';
import { Coordinator } from '../../packages/context/policy.mjs';
import { planClosedSteps } from '../../packages/context/fold-adapter.mjs';
import { measureUsage, checkWire, estimateRequest } from '../../packages/context/budget.mjs';
import { plannerProperties } from './planner-properties.mjs';

/** Replay complete trusted sources, mixed boundaries and stale usage; 08 §7.2 C/D/F/K. */
export async function sourceReplay(root) {
  const store = new ControlStore(root);
  const core = new TeamCore(store, {}, { enabled: true });
  core.member('member:r', 'root');
  const writer = new Coordinator(root);
  let seq = 0;
  let generation = 1;
  const nodes = [];
  const step = () => nodes.push({ kind: 'step', closed: true, calls: [], results: [], seqs: [++seq] });
  const ports = { serialize: op => writer.run(op), inject: async text => {
    const node = { kind: 'user', messageId: 'source:' + (++seq), text, seqs: [seq],
      source: 'trusted-team-plugin', sections: [{ authorized: true }] };
    nodes.push(node);
    return { messageId: node.messageId, sourceEventSeqs: node.seqs, generation };
  } };
  step();
  const old = await preStep(core, 'member:r', ports);
  step();
  core.task('task:supervise', 'member:r');
  const latest = await preStep(core, 'member:r', ports);
  for (let i = 0; i < 12; i++) step();
  const manifests = trustedManifests(core, nodes);
  assert.equal(manifests.length, 2);
  const plans = planClosedSteps(nodes, manifests);
  const covered = plans.flatMap(plan => plan.sourceEventSeqs);
  assert(covered.includes(old.manifest.sourceEventSeqs[0]));
  assert(!covered.includes(latest.manifest.sourceEventSeqs[0]));
  for (const plan of plans) assert.deepEqual(plan.sourceEventSeqs, plan.nodes.flatMap(node => node.seqs));
  const mixed = nodes.map(node => node.messageId === old.manifest.messageId ? { ...node, sections: [{ authorized: true }, { authorized: false }] } : node);
  assert(!planClosedSteps(mixed, manifests).some(plan => plan.sourceEventSeqs.includes(old.manifest.sourceEventSeqs[0])));
  const fake = nodes.map(node => node.messageId === old.manifest.messageId ? { ...node, source: 'user' } : node);
  assert(!planClosedSteps(fake, trustedManifests(core, fake)).some(plan => plan.sourceEventSeqs.includes(old.manifest.sourceEventSeqs[0])));
  const expected = generation;
  const result = await Promise.all([
    writer.run(async () => { generation++; core.task('task:next', 'member:r'); return 'compression-committed'; }),
    writer.run(async () => generation === expected ? 'fold-committed' : 'CAS_ABORT'),
    preStep(core, 'member:r', ports),
  ]);
  assert.equal(result[1], 'CAS_ABORT');
  const before = nodes.length;
  assert.equal(await preStep(core, 'member:r', ports, result[2].manifest), null);
  assert.equal(nodes.length, before);
  const cold = new ControlStore(root);
  assert.deepEqual(cold.read('manifest:' + old.manifest.hash).sourceEventSeqs, old.manifest.sourceEventSeqs);
  cold.close();
  assert.equal(measureUsage({ inputTokens: 1, outputTokens: 0 }).cacheWrite, null);
  assert.throws(() => measureUsage({ inputTokens: 1, outputTokens: 0, cacheWriteTokens: 0, cache_write_tokens: 7 }), /UNKNOWN_BUDGET/);
  const payload = { messages: [{ role: 'user', content: 'x'.repeat(10000) }] };
  assert(estimateRequest(payload, 1) > 10000);
  // M3a: the estimate is this payload's UTF-8 byte count (~10043) and the gate reads the input alone, so the window
  // that puts it past the line is 12000. The assertion is still "past the line is refused".
  assert.throws(() => checkWire(payload, { W: 12000, R: 100, M: 100 }, 'retry', 1), /BLOCKED_BUDGET/);
  const properties = [];
  plannerProperties(properties);
  writer.close();
  store.close();
  return { sourceExactReplay: true, oldFoldedLatestProtected: true, mixedAndRealUserProtected: true,
    compressionFoldTeamRace: true, staleUsageHardGate: true, committedReplacementNoReexecution: true };
}
