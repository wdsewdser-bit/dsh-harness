import { fork } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const worker = fileURLToPath(new URL('./fault-worker.mjs', import.meta.url));

/** Kill the child only after its exact operation boundary is reached; 08 §7.3. */
export async function kill(mode, root, point) {
  await new Promise((resolve, reject) => {
    const child = fork(worker, [mode, root, point], { stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
    let reached = false;
    let stderr = '';
    child.stderr.on('data', chunk => stderr += chunk);
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(Error('kill timeout ' + stderr));
    }, 30000);
    child.on('message', message => {
      if (message.point === point) {
        reached = true;
        child.kill('SIGKILL');
      }
    });
    child.on('exit', (code, signal) => {
      clearTimeout(timer);
      reached ? resolve() : reject(Error('worker exited before point ' + code + stderr));
    });
    child.on('error', reject);
  });
}
