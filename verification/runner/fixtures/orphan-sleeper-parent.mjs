// Fixture 2: the same shape without a port — a detached grandchild that only sleeps. The job holds it too, so a
// leftover that binds nothing is still found and killed.
import { spawn } from 'node:child_process';

console.log('pass 1');
console.log('fail 0');
spawn(process.execPath, ['-e', 'setTimeout(() => {}, 600000)'], { stdio: 'ignore', detached: true }).unref();
setTimeout(() => process.exit(0), 400);
