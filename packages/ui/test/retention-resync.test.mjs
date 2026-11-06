import test from 'node:test';
import assert from 'node:assert/strict';
import { createRealSource } from '../src/real-source.mjs';
import { ProjectionClient } from '../src/projection.mjs';

test('retention resync: HTTP stale-cursor response triggers a fresh snapshot, not an endless reconnect', async () => {
  const original = globalThis.fetch; let snapshots = 0, streams = 0; const urls = [];
  globalThis.fetch = async (url, init) => {
    urls.push(url);
    if (url.includes('/snapshot')) return new Response(JSON.stringify({ schemaVersion: 1, asOfSeq: ++snapshots, retention: { checkpointEpoch: 4 },
      data: { members: [], tasks: [], threads: [], messages: [], unknownEffects: [], approvals: [] } }), { status: 200 });
    if (!streams++) return new Response(JSON.stringify({ error: 'RESYNC_REQUIRED', resync: true }), { status: 409 });
    return new Promise((resolve, reject) => init.signal.addEventListener('abort', () => reject(Error('aborted')), { once: true }));
  };
  const client = new ProjectionClient(createRealSource({ token: 'offline' }).source);
  try {
    await client.start();
    for (let i = 0; i < 100 && snapshots < 2; i++) await new Promise(resolve => setTimeout(resolve, 1));
    assert.equal(snapshots, 2); assert.equal(client.state.lastResyncReason, 'retention'); assert.equal(client.state.asOfSeq, 2);
    assert(urls.some(url => url.endsWith('afterSeq=2&checkpointEpoch=4')), 'reconnect uses the new snapshot watermark');
  } finally { client.stop(); globalThis.fetch = original; }
});

test('retention resync: a resync frame on an already-open SSE stream requests another snapshot', async () => {
  const original = globalThis.fetch; let connections = 0; let status;
  globalThis.fetch = async () => { connections++; return new Response('event: resync\ndata: {"error":"RESYNC_REQUIRED","resync":true}\n\n',
    { status: 200, headers: { 'content-type': 'text/event-stream' } }); };
  let stop;
  try {
    stop = createRealSource({ token: 'offline' }).source.subscribe(7, () => assert.fail('resync is not a business delta'), value => { status = value; });
    for (let i = 0; i < 100 && status !== 'resync'; i++) await new Promise(resolve => setTimeout(resolve, 1));
    assert.equal(status, 'resync'); assert.equal(connections, 1);
  } finally { stop?.(); globalThis.fetch = original; }
});
