import test from 'node:test';
import assert from 'node:assert/strict';
import { pollProjection } from '../fixtures/p4-web-poll.mjs';
const reply = (status, value) => ({ status, ok: status === 200, text: async () => JSON.stringify(value) });
test('P4 poll fails immediately on EVENT_GAP and preserves the last good snapshot watermark', async () => {
  let calls = 0; const samples = [];
  const responses = [reply(200, { asOfSeq: 17, retention: { replayAfterSeq: 3 }, data: { messages: [1,2,3], goal: {} } }), reply(400, { error: 'EVENT_GAP' })];
  await assert.rejects(pollProjection({ url: 'offline:test', token: 'fake', deadline: Infinity, alive: () => true,
    fetcher: async () => { calls++; return responses.shift(); }, pause: async () => {}, onPoll: value => samples.push(value) }), error => {
      assert.equal(error.code, 'EVENT_GAP'); assert.equal(error.projectionPoll.httpStatus, 400);
      assert.match(error.projectionPoll.body, /EVENT_GAP/); assert.equal(error.projectionPoll.snapshotSeq, 17);
      assert.deepEqual(error.projectionPoll.retention, { replayAfterSeq: 3 }); return true;
    });
  assert.equal(calls, 2); assert.equal(samples.length, 2);
});
test('P4 poll exposes HTTP and parsing exceptions rather than silently timing out', async () => {
  for (const response of [reply(401, { error: 'AUTH_REQUIRED' }), { status: 200, ok: true, text: async () => 'not json' }]) {
    await assert.rejects(pollProjection({ url: 'offline:test', token: 'fake', deadline: Infinity, alive: () => true,
      fetcher: async () => response, pause: async () => assert.fail('must not retry a deterministic response') }),
      error => { assert.equal(error.projectionPoll.httpStatus, response.status); assert(error.projectionPoll.body); return true; });
  }
});
test('P4 poll records transient connection refusal and returns only the prepared snapshot', async () => {
  let calls = 0; const samples = [];
  const result = await pollProjection({ url: 'offline:test', token: 'fake', deadline: Infinity, alive: () => true,
    fetcher: async () => { if (!calls++) throw Object.assign(Error('fetch failed'), { cause: { code: 'ECONNREFUSED' } });
      return reply(200, { asOfSeq: 20, data: { goal: { completionToken: 'prepared' } } }); }, pause: async () => {}, onPoll: value => samples.push(value) });
  assert.equal(samples[0].error.code, 'ECONNREFUSED'); assert.equal(result.snapshot.asOfSeq, 20); assert.equal(calls, 2);
});
