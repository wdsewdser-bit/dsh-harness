import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { ControlStore, TEAM_STORE_VERSION } from '../../store/index.mjs';
import { TeamCore } from '../../core/index.mjs';
import { createTeamHost } from '../index.mjs';

const temp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-version-'));
function bytes(root) {
 const result = {};
 for (const entry of fs.readdirSync(root, { recursive: true, withFileTypes: true })) {
  if (!entry.isFile()) continue;
  const filename = path.join(entry.parentPath, entry.name);
  result[path.relative(root, filename)] = fs.readFileSync(filename).toString('hex');
 }
 return result;
}
function legacy(root, version, populated = true) {
 fs.mkdirSync(path.join(root, 'state-v2'));
 const db = new DatabaseSync(path.join(root, 'state-v2/control.sqlite'));
 db.exec('CREATE TABLE entities(id TEXT PRIMARY KEY, revision INTEGER, data TEXT)');
 if (populated) db.prepare('INSERT INTO entities VALUES(?,?,?)').run('task:legacy', 1, JSON.stringify({ status: 'ready', owner: 'member:old' }));
 if (version !== null) {
  db.exec('CREATE TABLE driver_metadata(key TEXT PRIMARY KEY, value TEXT NOT NULL)');
  db.prepare('INSERT INTO driver_metadata VALUES(?,?)').run('team-store-version', JSON.stringify(version));
 }
 db.close();
}

test('new empty team database writes the current compatibility marker and preserves it on reopen', () => {
 const root = temp();
 try {
  let store = new ControlStore(root);
  assert.deepEqual(store.version(), TEAM_STORE_VERSION);
  assert.equal(store.latestEventSeq(), 0); assert.deepEqual(store.list(), []);
  store.close(); store = new ControlStore(root);
  assert.deepEqual(store.version(), TEAM_STORE_VERSION); store.close();
 } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('an existing but actually empty database may acquire a version', () => {
 const root = temp();
 try { legacy(root, null, false); const store = new ControlStore(root); assert.deepEqual(store.version(), TEAM_STORE_VERSION); store.close(); }
 finally { fs.rmSync(root, { recursive: true, force: true }); }
});

for (const [label, version] of [
 ['missing', null], ['old-format', { format: 0, driver: 'm1b-1' }],
 ['old-driver', { format: 1, driver: 'm1a-1' }], ['unknown', { format: 999, driver: 'future' }],
]) test('nonempty ' + label + ' database refuses writable use byte-for-byte, while P5 reads remain usable', async () => {
 const root = temp(); let reader, host;
 try {
  legacy(root, version); const before = bytes(root);
  assert.throws(() => new ControlStore(root), { code: 'INCOMPATIBLE_TEAM_STORE' });
  assert.deepEqual(bytes(root), before, 'refusal must precede schema/WAL/version writes');
  reader = ControlStore.openReadOnly(root);
  assert.equal(reader.read('task:legacy').owner, 'member:old'); assert.equal(reader.list('task:').length, 1);
  assert.deepEqual(reader.version(), version);
  assert.throws(() => reader.commit(null, () => null), { code: 'READ_ONLY_TEAM_STORE' });
  const core = new TeamCore(reader, {}, { enabled: true, attach: true, teamId: 'team:legacy' });
  host = createTeamHost({ root, teamId: 'team:legacy', core, recoverer: async () => ({ status: 'ok', admission: true }) });
  await assert.rejects(host.start(), { code: 'READ_ONLY_TEAM_STORE' });
  reader.close(); reader = null;
  assert.deepEqual(bytes(root), before, 'read-only access and rejected host start must not write even ownership metadata');
 } finally { await host?.stop(); reader?.close(); fs.rmSync(root, { recursive: true, force: true }); }
});

for (const [label, version] of [['missing', null], ['old', { format: 0, driver: 'm1a' }], ['unknown', { format: 99, driver: 'future' }]])
 test('lazy openStore ' + label + ' version refuses before ownership and leaves all bytes unchanged', async () => {
  const root = temp(); let host; let opened = 0, acquired = 0;
  try {
   legacy(root, version); const before = bytes(root);
   const reader = ControlStore.openReadOnly(root);
   assert.equal(reader.read('task:legacy').status, 'ready'); reader.close();
   host = createTeamHost({ root, teamId: 'team:lazy',
    acquire: () => { acquired++; throw Error('must not acquire'); },
    openStore: () => { opened++; return new ControlStore(root); }, recoverer: async () => ({ status: 'ok', admission: true }) });
   await assert.rejects(host.start(), { code: 'INCOMPATIBLE_TEAM_STORE' });
   assert.equal(opened, 0); assert.equal(acquired, 0); assert.deepEqual(bytes(root), before);
  } finally { await host?.stop(); fs.rmSync(root, { recursive: true, force: true }); }
 });

test('a store adapter without version preflight is forbidden before acquiring ownership', async () => {
 const root = temp(); let host; let store;
 try {
  store = new ControlStore(root);
  const core = new TeamCore(store, {}, { enabled: true, attach: true });
  store.assertWritableDriver = undefined; // Same real store, but an unsupported adapter contract.
  const before = bytes(root); let acquired = 0;
  host = createTeamHost({ root, core, teamId: 'team:no-preflight', acquire: () => { acquired++; throw Error('must not acquire'); } });
  await assert.rejects(host.start(), { code: 'UNSUPPORTED_STORE_PREFLIGHT' });
  assert.equal(acquired, 0); assert.deepEqual(bytes(root), before);
 } finally { await host?.stop(); store?.close(); fs.rmSync(root, { recursive: true, force: true }); }
});
