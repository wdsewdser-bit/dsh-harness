// Fixture: starts the listener and then keeps running, the shape a long suite has when the runner is interrupted.
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const listener = fileURLToPath(new URL('./orphan-listener.mjs', import.meta.url));
const child = spawn(process.execPath, [listener, String(process.argv[2] ?? 40290)], { stdio: 'ignore' });
child.unref();
console.log('INTERRUPT PARENT READY');
setInterval(() => {}, 1000);
