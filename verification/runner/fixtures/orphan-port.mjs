// Fixture 1: the suite starts a detached listener and exits at once, without waiting for it. The job object still
// holds the listener, so the launcher finds it after the suite is gone.
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

console.log('pass 1');
console.log('fail 0');
const listener = fileURLToPath(new URL('./orphan-listener.mjs', import.meta.url));
spawn(process.execPath, [listener, String(process.argv[2] ?? 40290)], { stdio: 'ignore', detached: true }).unref();
setTimeout(() => process.exit(0), 400);
