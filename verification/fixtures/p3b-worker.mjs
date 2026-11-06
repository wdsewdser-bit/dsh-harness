import { ControlStore } from '../../packages/store/index.mjs';
import { TeamCore } from '../../packages/core/index.mjs';
import { createHostDelivery } from '../../packages/host/src/delivery.mjs';
const [mode, root, argument] = process.argv.slice(2);
const store = new ControlStore(root);
if (mode === 'cold-token') {
  const token = store.read(argument);
  if (token?.status !== 'authorized') throw Error('COLD_TOKEN_MISMATCH');
  console.log(JSON.stringify({ status: token.status }));
  store.close();
} else if (mode === 'git-kill') {
  const core = new TeamCore(store, {}, { enabled: true, attach: true });
  const delivery = createHostDelivery({ core, repository: argument });
  await delivery.integrate('task:one', 'refs/heads/main', point => {
    if (point === 'afterGit') process.kill(process.pid, 'SIGKILL');
  });
  throw Error('KILL_NOT_REACHED');
} else throw Error('UNKNOWN_WORKER_MODE');
