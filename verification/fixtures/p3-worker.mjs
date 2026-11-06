import fs from 'node:fs';
import { ControlStore } from '../../packages/store/index.mjs';
import { TeamCore } from '../../packages/core/index.mjs';
import { digest } from '../../packages/contracts/index.mjs';
const [mode, root, argument] = process.argv.slice(2);
const pause = point => {
  fs.writeFileSync(root + '/ready-' + point, 'ready');
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
};
const store = new ControlStore(root, mode === 'kill' ? { [argument]: () => pause(argument) } : {});
const core = new TeamCore(store, {}, { enabled: true, attach: mode === 'race' });
if (mode === 'kill') {
  const command = core.command('kill-entity', 'test', { durable: true }, 'v1:operation:00000000-0000-4000-8000-000000000001');
  store.commit(command, tx => tx.put('kill-entity', { durable: true }));
} else if (mode === 'race') {
  try { core.schedule('race-' + argument, 'task:race'); console.log('admitted'); }
  catch (error) { console.log('rejected:' + error.message); }
} else if (mode === 'cold') {
  console.log(JSON.stringify(store.read('kill-entity')));
}
store.close();
