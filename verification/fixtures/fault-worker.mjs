import fs from 'node:fs';
import { ArtifactStore } from '../../packages/context/index.mjs';
import { host } from '../../packages/adapter-dsh/index.mjs';

const [mode, root, point] = process.argv.slice(2);
fs.mkdirSync(root, { recursive: true });
const mark = boundary => {
  if (boundary === point) {
    process.send({ point: boundary });
    setInterval(() => {}, 1000);
    return new Promise(() => {});
  }
};

if (mode === 'cas') {
  const store = new ArtifactStore(root);
  const ref = store.db.prepare('SELECT ref FROM manifests ORDER BY rowid LIMIT 1').get().ref;
  try {
    store.cas('v1:operation:fixture-0003', { ref }, 0);
    throw Error('stale CAS accepted');
  } catch (error) {
    if (error.code !== 'CAS_CONFLICT') {
      throw error;
    }
  }
  store.close();
  process.exit(0);
}
if (mode === 'artifact') {
  const store = new ArtifactStore(root);
  store.publish('op-kill', 'durable evidence'.repeat(1000), { session: 's', agent: 'a' }, boundary => {
    if (boundary === point) {
      process.send({ point: boundary });
      // Keep the transaction at this exact boundary until the parent forcibly kills it.
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
    }
  });
  store.close();
} else {
  const adapter = await host(root);
  const handle = await adapter.create({
    sessionId: 'surface',
    agentOptions: { provider: 'offline', model: 'model' },
    meta: { cwd: root },
  });
  const session = handle.agent.session;
  const user = text => adapter.createUserMessage({
    content: [{ type: 'text', text }],
    source: { kind: 'user' },
  });
  const original = session.append('user/message', user('recoverable original input'), {
    surfaceOp: 'append',
  });
  await adapter.flush(session);
  const replacement = session.append('user/message', user('replacement op-surface'), {
    surfaceOp: { op: 'replace', startSeq: original.seq, endSeq: original.seq },
    sourceEventSeqs: [original.seq],
  });
  if (point === 'append') {
    await mark('append');
  }
  await adapter.flush(session);
  fs.writeFileSync(root + '/expected.json', JSON.stringify(session.deriveMessages()));
  await mark('flush');
  await handle.dispose();
}
