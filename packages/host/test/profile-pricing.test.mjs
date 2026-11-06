// P9 (docs/decisions/team-autonomy-design.md §10 P9, appendix 9): the price table is configuration, so it travels
// profile -> runtime -> projection. These two cases boot the real team profile in-process (offline: no provider is
// contacted) and read the projection object the HTTP gateway serves, so the path under test is the deployment's.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { profile } from '../test-support/profile.mjs';
import { applyTeamProjections as projections } from '../../profiles/index.mjs';
import { recordUsage } from '../../core/index.mjs';

const price = Object.freeze({ currency: 'USD', perInputToken: 0.000003, perOutputToken: 0.000015 });

async function priced({ pricing, port }) {
  const w = await profile({ ...(pricing ? { pricing } : {}) },
    ({ root }) => { fs.mkdirSync(path.join(root, 'w', 'a'), { recursive: true }); });
  const teamId = w.runtime.host.teamId;
  await projections(w.ctx, { port, sessions: { root: { teamId, memberId: 'member:root' } } });
  const core = w.runtime.core;
  core.member('member:a', 'worker');
  core.mutate('delegation:d1', 'root', {}, tx => tx.put('delegation:d1', { owner: 'member:a',
    budget: { tasks: 2, concurrency: 1, tokens: { inputLimit: 1000, outputLimit: 1000 } },
    expiresAt: Date.now() + 600000 }));
  core.task('task:a', 'member:a', [path.join(w.root, 'w', 'a')], { delegationRef: 'delegation:d1' });
  recordUsage(core, { memberId: 'member:a', sessionId: 's1', input: 100, output: 10, source: 'usage-event',
    eventKey: 'session:s1:1', revision: 1, totalInput: 100, totalOutput: 10 });
  const projection = w.ctx.teamProjections.projection;
  return { w, projection, data: projection.snapshot('member:root').data };
}

test('appendix 9: a price table configured in the profile prices the delegation the panel shows', async () => {
  const { w, projection, data } = await priced({ pricing: price, port: 40296 });
  try {
    assert.deepEqual(projection.pricing, price, 'the profile handed its table to the projection');
    const tokens = data.budget.delegations[0].tokens;
    assert.equal(tokens.input, 100);
    assert.equal(tokens.output, 10);
    assert.deepEqual(tokens.cost, { currency: 'USD', amount: 100 * price.perInputToken + 10 * price.perOutputToken },
      'the amount is the one core usageProjection would report');
  } finally {
    await w.ctx.teamProjections?.transport.close();
    await w.close();
  }
});

test('appendix 9: a profile without a price table projects no cost at all', async () => {
  const { w, projection, data } = await priced({ pricing: null, port: 40297 });
  try {
    assert.equal(projection.pricing, null);
    const tokens = data.budget.delegations[0].tokens;
    assert.equal(tokens.input, 100, 'the tokens are measured either way');
    assert.equal('cost' in tokens, false, 'no table, no amount, no currency symbol');
  } finally {
    await w.ctx.teamProjections?.transport.close();
    await w.close();
  }
});
