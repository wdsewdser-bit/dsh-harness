// Fixture 3: the descendant inherits the suite's stdio and keeps running. The copy of that stream never reaches EOF,
// so the leftover check must not wait for it.
import { spawn } from 'node:child_process';

console.log('pass 1');
console.log('fail 0');
spawn(process.execPath, ['-e', 'setTimeout(() => {}, 600000)'], { stdio: 'inherit', detached: true }).unref();
setTimeout(() => process.exit(0), 400);
