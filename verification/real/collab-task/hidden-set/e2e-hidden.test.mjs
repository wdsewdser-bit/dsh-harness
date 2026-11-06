import test from 'node:test';
import assert from 'node:assert/strict';
import { startBackend, stopBackend } from './backend.mjs';
import path from 'node:path';
import fs from 'node:fs';

/**
 * The hidden acceptance set: end-to-end tests the members never see.
 *
 * It lives outside every member workspace and is only ever run by this script after the run has finished. It checks the
 * product, not the members' own tests: the API shape they were free to choose is discovered from whatever the backend
 * actually serves, and every assertion is about observable behaviour. The colour checks are the ones the mid-run
 * requirement change introduced, so hiddenTestPass is the final quality number the plan asks for.
 */
// The workspace arrives in the environment: node --test does not forward extra arguments to the test file, and the
// runner that owns this set is the only caller.
const workspace = process.env.APP_WORKSPACE;
if (!workspace) { throw new Error('HIDDEN_TEST_USAGE: APP_WORKSPACE is required'); }
process.env.APP_WORKSPACE_BE = path.join(workspace, 'be');
process.env.APP_WORKSPACE_FE = path.join(workspace, 'fe');

const beFile = path.join(process.env.APP_WORKSPACE_BE, 'server.mjs');
const feFile = path.join(process.env.APP_WORKSPACE_FE, 'index.html');
const present = { backend: fs.existsSync(beFile), frontend: fs.existsSync(feFile) };

async function bootBackend() {
  if (!present.backend) return null;
  return startBackend(beFile);
}

/** Find the todo collection path the backend actually serves, without assuming the members' naming. */
async function discoverCollection(url) {
  for (const candidate of ['/api/todos', '/todos', '/api/todo', '/todo', '/api/items', '/items']) {
    try {
      const response = await fetch(url + candidate, { signal: AbortSignal.timeout(5000) });
      if (response.status === 404) continue;
      const body = await response.json().catch(() => null);
      if (Array.isArray(body)) return { path: candidate, list: body };
    } catch { /* try the next candidate */ }
  }
  return null;
}

const colour = value => typeof value === 'string' && /^#[0-9a-fA-F]{6}$/.test(value);
const tagValues = row => Array.isArray(row?.tags) ? row.tags : null;

test('the application is present and its backend answers', async () => {
  assert.equal(present.backend, true, 'backend server.mjs is missing');
  assert.equal(present.frontend, true, 'frontend index.html is missing');
});

test('the todo API creates, lists, completes and deletes', async () => {
  const started = await bootBackend();
  assert(started, 'backend did not start');
  try {
    const found = await discoverCollection(started.url);
    assert(found, 'no todo collection endpoint answered with a list');
    const created = await fetch(started.url + found.path, { method: 'POST',
      headers: { 'content-type': 'application/json' }, body: JSON.stringify({ title: 'hidden one', tags: ['alpha'] }) });
    assert([200, 201].includes(created.status), 'create returned ' + created.status);
    const row = await created.json();
    assert.equal(typeof row.id, 'string');
    assert.equal(row.title, 'hidden one');
    const listed = await (await fetch(started.url + found.path)).json();
    assert.equal(listed.length, 1);
    const patched = await fetch(started.url + found.path + '/' + encodeURIComponent(row.id), { method: 'PATCH',
      headers: { 'content-type': 'application/json' }, body: JSON.stringify({ done: true }) });
    assert([200, 204].includes(patched.status), 'complete returned ' + patched.status);
    const after = await (await fetch(started.url + found.path + '/' + encodeURIComponent(row.id))).json();
    assert.equal(after.done ?? after.completed ?? after.finished, true, 'the todo did not become done');
    const removed = await fetch(started.url + found.path + '/' + encodeURIComponent(row.id), { method: 'DELETE' });
    assert([200, 202, 204].includes(removed.status), 'delete returned ' + removed.status);
    assert.deepEqual(await (await fetch(started.url + found.path)).json(), []);
  } finally { await stopBackend(started); }
});

test('a tag comes back with a hex colour whether or not the caller sent one', async () => {
  const started = await bootBackend();
  assert(started, 'backend did not start');
  try {
    const found = await discoverCollection(started.url);
    assert(found, 'no todo collection endpoint answered with a list');
    const named = await (await fetch(started.url + found.path, { method: 'POST',
      headers: { 'content-type': 'application/json' }, body: JSON.stringify({ title: 'coloured', tags: [{ name: 'alpha', color: '#3366cc' }] }) })).json();
    const namedTags = tagValues(named);
    assert(namedTags && namedTags.length === 1, 'the created todo lost its tag');
    assert.equal(namedTags[0].name, 'alpha');
    assert(colour(namedTags[0].color), 'the explicit colour did not survive: ' + JSON.stringify(namedTags[0]));
    const bare = await (await fetch(started.url + found.path, { method: 'POST',
      headers: { 'content-type': 'application/json' }, body: JSON.stringify({ title: 'default colour', tags: [{ name: 'beta' }] }) })).json();
    const bareTags = tagValues(bare);
    assert(bareTags && bareTags.length === 1, 'the created todo lost its tag');
    assert(colour(bareTags[0].color), 'a tag without a colour came back without one: ' + JSON.stringify(bareTags[0]));
  } finally { await stopBackend(started); }
});

test('the frontend page actually talks to the API', async () => {
  assert.equal(present.frontend, true, 'frontend index.html is missing');
  const html = fs.readFileSync(feFile, 'utf8');
  assert(/fetch\s*\(/.test(html), 'the page never calls fetch, so it cannot reach the API');
  assert(/<script/i.test(html), 'the page carries no script');
  assert(/todo/i.test(html), 'the page does not mention todos at all');
  assert(/color|colour/i.test(html), 'the page does not know about tag colours after the requirement change');
});
