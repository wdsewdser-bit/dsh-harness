import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';
const [suite, ...args] = process.argv.slice(2);
if (suite !== 'p4-projections') throw Error('UNKNOWN_SUITE');
const options = {};
for (let i = 0; i < args.length; i++) { const key = args[i].replace(/^--/, ''); options[key] = key === 'keep-alive' ? true : args[++i]; }
const root = path.resolve(options.root);
if (!root.replaceAll('\\', '/').toLowerCase().startsWith(process.cwd().replaceAll('\\', '/').toLowerCase() + '/runs/')) throw Error('WRITE_SCOPE');
const child = spawn(process.execPath, [fileURLToPath(new URL('./p4-projections.mjs', import.meta.url)), root,
    ...(options['keep-alive'] ? ['--keep-alive'] : [])], { stdio: ['ignore', 'pipe', 'pipe'] });
let pending = '';
const capture = (chunk, stream) => {
  stream.write(chunk); pending += chunk;
  if (fs.existsSync(root)) { fs.appendFileSync(root + '/p4-run.log', pending); pending = ''; }
};
child.stdout.on('data', x => capture(x, process.stdout)); child.stderr.on('data', x => capture(x, process.stderr));
let stopTimer;
const stop = () => {
  if (stopTimer) return;
  const request = () => {
    const dir = root + '/manual-web';
    if (fs.existsSync(dir)) fs.writeFileSync(dir + '/STOP', 'launcher shutdown requested');
  };
  request(); stopTimer = setInterval(request, 100);
};
process.on('SIGINT', stop); process.on('SIGTERM', stop);
child.once('error', error => { console.error(error); process.exitCode = 1; });
child.once('exit', code => { clearInterval(stopTimer); process.removeListener('SIGINT', stop); process.removeListener('SIGTERM', stop); process
    .exitCode = code ?? 1; });
