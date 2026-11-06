// P6 appendix 6 deviation 2, closed in P2: the profile validates `budget` and `pricing`, and now hands them to the core.
//
// Before this the two options were validated by autonomyConfig and then dropped on the floor when team-plugin built the
// TeamCore, so every deployment silently ran on the contract defaults (30 minutes, no price table). These tests boot the
// real profile and read the values the reducers actually see.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { profile } from '../test-support/profile.mjs';
import { budgetSettings, pricingOf, usageProjection } from '../../core/index.mjs';

const temp = label => fs.mkdtempSync(path.join(os.tmpdir(), 'p2-budget-' + label + '-'));

test('§8.2.3/§8.2.4: the configured grace period and price table reach the core through the profile', async () => {
  const w = await profile({ root: temp('configured'),
    budget: { unknownGraceMs: 1234, unknownUsage: 'stop' },
    pricing: { currency: 'USD', perInputToken: 2, perOutputToken: 3 } });
  try {
    const core = w.runtime.core;
    assert.equal(budgetSettings(core).unknownGraceMs, 1234, 'the admission reads the configured grace period');
    assert.equal(budgetSettings(core).unknownUsage, 'stop');
    assert.deepEqual({ ...pricingOf(core) }, { currency: 'USD', perInputToken: 2, perOutputToken: 3 });
    assert.equal(w.runtime.autonomy.budget.unknownGraceMs, 1234, 'and the validated contract object agrees');
    assert.equal(typeof usageProjection(core, { memberId: 'member:nobody' }).cost.amount, 'number',
      'the projection is the one place an amount exists');
  } finally { await w.close(); }
});

test('§8.2.3/§8.2.4: a profile that names neither keeps the contract defaults, and carries no price at all', async () => {
  const w = await profile({ root: temp('default') });
  try {
    const core = w.runtime.core;
    assert.equal(budgetSettings(core).unknownGraceMs, 1800000);
    assert.equal(budgetSettings(core).unknownUsage, 'continue');
    assert.equal(pricingOf(core), null);
    assert.equal('cost' in usageProjection(core, { memberId: 'member:nobody' }), false, 'no table, no amount');
  } finally { await w.close(); }
});
