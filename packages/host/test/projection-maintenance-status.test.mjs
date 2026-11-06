import test from 'node:test';
import assert from 'node:assert/strict';
import { profile, until } from '../test-support/profile.mjs';
import { applyTeamProjections } from '../../profiles/index.mjs';

test('retention projection service status: idle sync faults are visible without any HTTP request and clear on recovery', { timeout: 30000 }, async () => {
  const w = await profile();
  try {
    await applyTeamProjections(w.ctx, { port: 40295, sessions: {} });
    const service = w.ctx.teamProjections, projection = service.projection, original = projection.sync.bind(projection);
    const failure = Object.assign(Error('idle consumer failed'), { code: 'INJECTED_PROJECTION_SYNC' });
    const identity = w.runtime.store.readers().find(row => row.id === projection.reader.id).identity;
    projection.sync = () => { throw failure; };
    await until(() => w.runtime.status().projection?.lastSyncError?.code === failure.code);
    const failed = w.runtime.status().projection;
    assert.equal(failed.state, 'running'); assert(failed.syncFailures >= 1);
    assert.equal(failed.warnings[0].code, 'PROJECTION_SYNC_FAILED');
    assert.equal(failed.warnings[0].reader, projection.reader.id);
    assert.deepEqual(failed.identity, identity);
    assert.equal(failed.lastFailure.code, failure.code); assert.equal(typeof failed.lastFailure.at, 'number');
    assert.equal(service.status().lastSyncError.message, failure.message);
    projection.sync = original;
    await until(() => w.runtime.status().projection.lastSyncError === null && w.runtime.status().projection.lastSyncAt !== null);
    const healthy = w.runtime.status().projection;
    assert.deepEqual(healthy.warnings, []); assert(healthy.syncFailures >= 1, 'recovery does not erase the failure counter');
    assert.equal(healthy.lastFailure.code, failure.code);
    assert.equal(healthy.lastSuccessfulSyncSeq, projection.seq);
  } finally { await w.ctx.emit('dispose'); await w.close(); }
});
