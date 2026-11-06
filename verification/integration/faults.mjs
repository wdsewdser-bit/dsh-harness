import fs from 'node:fs';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { config, hash } from '../../packages/contracts/index.mjs';
import {
  ArtifactStore, recall, checkWire, measureUsage, Coordinator, evaluate, planClosedSteps,
} from '../../packages/context/index.mjs';
import { kill } from '../fixtures/kill-worker.mjs';
import { plannerProperties } from '../domain/planner-properties.mjs';

const worker = fileURLToPath(new URL('../fixtures/fault-worker.mjs', import.meta.url));

/** Exercise persistence, authorization, metering and source failure cases; 08 §7.2–7.3, §8 P2. */
export async function faults(root) {
  const passed = [];
  const ok = (name, assertion) => {
    assertion();
    passed.push(name);
  };
  const configuration = config({ W: 1000000 });
  ok('F missing usage and alias conflict', () => {
    assert.throws(() => config());
    assert.throws(() => config({ W: 1000000, fold: true }));
    assert.throws(() => measureUsage({}));
    assert.throws(() => measureUsage({
      inputTokens: 1, outputTokens: 1, cacheWriteTokens: 0, cache_write_tokens: 7,
    }));
    assert.equal(measureUsage({ inputTokens: 1, outputTokens: 1 }).economics, 'unknown');
  });
  ok('I01 exact hard boundary and missing W', () => {
    const options = { messages: [{ role: 'user', content: [{ type: 'text', text: 'x'.repeat(2000) }] }] };
    assert.throws(() => checkWire(options, { ...configuration, W: undefined }));
    // M3a: the estimate is the transport's full-byte bound (this payload is ~2068 B; no *2 + 1024) and the gate
    // reads the input alone, so the window that puts it past the line is 2048. The assertion is unchanged.
    assert.throws(() => checkWire(options, { ...configuration, W: 2048 }));
    assert.throws(() => checkWire(options, configuration, 'retry', 750000));
    assert.equal(evaluate(configuration, 199999).optimizationPermit, false);
  });

  const store = new ArtifactStore(root + '/store');
  const principal = { session: 's', agent: 'a' };
  const reference = store.publish('call', 'abcdef'.repeat(3000), principal);
  const other = { session: 'other-session', agent: 'other-agent' };
  const same = store.publish('dedup', 'abcdef'.repeat(3000), other);
  assert.equal(same.sha256, reference.sha256);
  assert.notEqual(same.artifactRef, reference.artifactRef);
  assert.equal(recall(store, same.artifactRef, {}, principal).status, 'denied');
  passed.push('same content independent grant');
  ok('ACL and bounded recall', () => {
    assert.equal(recall(store, reference.artifactRef, {}, { session: 'other', agent: 'a' }).status, 'denied');
    assert.equal(recall(store, reference.artifactRef, { length: 999999 }, principal).length, 4096);
    const target = { session: 'shared', agent: 'b' };
    store.grant(reference.artifactRef, principal, target);
    assert.equal(recall(store, reference.artifactRef, {}, target).status, 'ok');
    store.revoke(reference.artifactRef, principal, target);
    assert.equal(recall(store, reference.artifactRef, {}, target).status, 'denied');
  });
  ok('A/D stale revision and idempotency', () => {
    store.cas('v1:operation:fixture-0001', { ref: reference.artifactRef }, 0);
    assert.equal(store.cas('v1:operation:fixture-0001', { ref: reference.artifactRef }, 0).revision, 1);
    assert.throws(() => store.cas('v1:operation:fixture-0002', { ref: reference.artifactRef }, 0), /CAS_CONFLICT/);
    assert.throws(() => store.cas('v1:operation:fixture-0001', { ref: 'other' }, 0), /ID_CONFLICT/);
  });
  ok('corrupt hash', () => {
    fs.writeFileSync(root + '/store/artifacts/' + reference.sha256, 'corrupt');
    assert.equal(recall(store, reference.artifactRef, {}, principal).status, 'corrupt');
  });
  const unicode = store.publish('unicode', '原文'.repeat(3000), principal);
  const chunks = [];
  for (let offset = 0; offset < unicode.bytes; offset += 4096) {
    chunks.push(Buffer.from(recall(store, unicode.artifactRef, {
      offset, length: 4096,
    }, principal).dataBase64, 'base64'));
  }
  assert.equal(hash(Buffer.concat(chunks)), unicode.sha256);
  passed.push('lossless UTF8 chunk offsets');
  const expired = store.publish('expired', 'expiry', principal);
  ok('30 days, pin and tombstone', () => {
    store.terminal(expired.artifactRef, Date.now() - 31 * 86400000, true);
    store.gc();
    assert.equal(recall(store, expired.artifactRef, {}, principal).status, 'ok');
    store.terminal(expired.artifactRef, Date.now() - 31 * 86400000, false);
    store.protect(expired.artifactRef, 'unknown', 'unknown-operation');
    store.gc();
    assert.equal(recall(store, expired.artifactRef, {}, principal).status, 'ok');
    store.release(expired.artifactRef, 'unknown', 'unknown-operation');
    store.gc();
    assert.equal(recall(store, expired.artifactRef, {}, principal).status, 'expired');
    assert(store.db.prepare('SELECT 1 FROM manifests WHERE ref=?').get(expired.artifactRef));
  });
  store.close();
  const replay = spawnSync(process.execPath, [worker, 'cas', root + '/store', 'none'], {
    encoding: 'utf8', timeout: 30000,
  });
  assert.equal(replay.status, 0, replay.stderr);
  passed.push('A/D independent-process stale CAS rejection');

  for (const point of ['half', 'fsync', 'rename', 'before-commit']) {
    const directory = root + '/throw-' + point;
    const failingStore = new ArtifactStore(directory);
    assert.throws(() => failingStore.publish('failed', 'data', principal, where => {
      if (where === point) {
        throw Error('injected ENOSPC/EACCES');
      }
    }));
    assert.equal(failingStore.db.prepare('SELECT count(*) n FROM manifests').get().n, 0);
    failingStore.gc();
    assert.equal(fs.readdirSync(directory + '/artifacts').length, 0);
    failingStore.close();
    passed.push('publish failure no false ref ' + point);
  }
  for (const point of ['half', 'fsync', 'rename', 'before-commit', 'after-commit']) {
    const directory = root + '/kill-' + point;
    await kill('artifact', directory, point);
    const cold = new ArtifactStore(directory);
    const rows = cold.db.prepare('SELECT * FROM manifests').all();
    assert.equal(rows.length, point === 'after-commit' ? 1 : 0);
    if (rows.length) {
      assert.equal(recall(cold, rows[0].ref, {}, { session: 's', agent: 'a' }).status, 'ok');
    }
    cold.gc();
    cold.close();
    passed.push('J killed artifact ' + point);
  }

  let active = 0;
  let maximum = 0;
  const coordinator = new Coordinator('serial-test');
  await Promise.all(['native-pressure', 'offline-replace', 'source-change'].map(operation => (
    coordinator.run(async () => {
      maximum = Math.max(maximum, ++active);
      await Promise.resolve();
      active--;
    })
  )));
  assert.equal(maximum, 1);
  assert.throws(() => new Coordinator('serial-test'));
  coordinator.close();
  passed.push('C serialized mutation entry');
  plannerProperties(passed);

  for (const point of ['append', 'flush']) {
    const directory = root + '/surface-' + point;
    await kill('surface', directory, point);
    const result = spawnSync(process.execPath, [
      fileURLToPath(new URL('../unit/surface-cold.mjs', import.meta.url)), directory, point,
    ], { encoding: 'utf8', timeout: 30000 });
    assert.equal(result.status, 0, result.stderr);
    passed.push('J surface ' + point + ' cold-read no next wire');
  }
  return { passed };
}
