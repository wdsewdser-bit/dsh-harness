import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import path from 'node:path';

const BE = path.join(process.env.APP_WORKSPACE_BE || '../be', 'server.mjs');

async function boot() {
  const child = spawn(process.execPath, [BE], { env: { ...process.env, PORT: '0' }, stdio: ['ignore', 'pipe', 'inherit'] });
  const url = await new Promise((resolve, reject) => {
    child.stdout.once('data', chunk => resolve(String(chunk).trim()));
    child.once('error', reject);
    child.once('exit', code => reject(new Error('backend exited ' + code)));
  });
  return { child, url };
}

test('add, list, complete and delete a todo end to end', async () => {
  const { child, url } = await boot();
  try {
    const created = await fetch(url + '/api/todos', { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'ship it', tags: ['work'] }) });
    assert.equal(created.status, 201);
    const row = await created.json();
    assert.equal(row.title, 'ship it');
    assert.equal(row.done, false);
    const listed = await (await fetch(url + '/api/todos')).json();
    assert.equal(listed.length, 1);
    const tagged = listed[0].tags[0];
    assert.equal(tagged.name, 'work');
    const patched = await (await fetch(url + '/api/todos/' + encodeURIComponent(row.id), { method: 'PATCH',
      headers: { 'content-type': 'application/json' }, body: JSON.stringify({ done: true }) })).json();
    assert.equal(patched.done, true);
    const removed = await fetch(url + '/api/todos/' + encodeURIComponent(row.id), { method: 'DELETE' });
    assert.equal(removed.status, 204);
    assert.deepEqual(await (await fetch(url + '/api/todos')).json(), []);
  } finally { child.kill(); }
});
