import fs from 'node:fs';
import { spawn } from 'node:child_process';
const [mode, pidFile, readyFile] = process.argv.slice(2);
if (mode === 'ghost') fs.writeFileSync(pidFile, JSON.stringify({ pid: 777777, startTime: 'old', source: 'authoritative' }));
if (mode === 'ghost-estimated') fs.writeFileSync(pidFile, JSON.stringify({ pid: 777777, startTime: '2000-01-01T00:00:00.000Z', source: 'estimated' }));
if (mode === 'ready' && readyFile) fs.writeFileSync(readyFile, 'ready');
if (mode === 'exit') process.exit(0);
if (mode === 'exit-soon') setTimeout(() => process.exit(0), 2000);
// 'slow' keeps making progress for the whole duration; 'silent' is alive but says nothing.
if (mode === 'slow') {
  const end = Date.now() + Number(pidFile || 3000);
  const tick = setInterval(() => { console.log('tick ' + Date.now()); if (Date.now() >= end) { clearInterval(tick); process.exit(0); } }, 200);
} else if (mode === 'silent') {
  setTimeout(() => process.exit(0), Number(pidFile || 3000));
} else if (mode === 'tree' && pidFile) {
  // A root that never exits and owns one grandchild: the contract checks that termination reaches the descendant, not
  // only the root handle. The pid file is read after the run to prove the grandchild is gone.
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore', windowsHide: true });
  fs.writeFileSync(pidFile, String(child.pid));
}
setInterval(() => {}, 1000);
