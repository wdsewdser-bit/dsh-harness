import fs from 'node:fs';
import assert from 'node:assert/strict';
import { host } from '../../packages/adapter-dsh/index.mjs';

const [root, point] = process.argv.slice(2);
const adapter = await host(root);
const handle = await adapter.resume({
  resumeSessionId: 'surface',
  agentOptions: { provider: 'offline', model: 'model' },
});
const messages = handle.agent.session.deriveMessages();
if (point === 'flush') {
  assert.deepEqual(messages, JSON.parse(fs.readFileSync(root + '/expected.json')));
} else {
  assert(/recoverable original input|replacement op-surface/.test(JSON.stringify(messages)));
}
await handle.dispose();
console.log('cold recovered without provider or tools');
