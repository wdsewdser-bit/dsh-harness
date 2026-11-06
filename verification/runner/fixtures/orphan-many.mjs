// Fixture 4: two descendants at once, so the job process list is bigger than a one-pid buffer.
import { spawn } from 'node:child_process';

console.log('pass 1');
console.log('fail 0');
for (const millis of [600000, 600001]) {
  spawn(process.execPath, ['-e', 'setTimeout(() => {}, ' + millis + ')'], { stdio: 'ignore', detached: true }).unref();
}
setTimeout(() => process.exit(0), 400);
