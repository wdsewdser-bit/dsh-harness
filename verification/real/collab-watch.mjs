import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { webOverlay } from '../../packages/profiles/web.mjs';
import { buildTarget } from '../../packages/adapter-dsh/build-target.mjs';

/**
 * Read-only Team Web UI for a live collaboration run; 11 §2, 08 §5.
 *
 * The collaboration stage boots its team inside verification/real/worker.mjs, so that process owns the state. Two hosts
 * are needed, exactly as in verification/archive/p4-fixture.mjs:
 *
 *   127.0.0.1:40298  projection gateway, mounted IN the collab host (native-host.mjs mounts it when COLLAB_WATCH_TOKEN
 *                    is set). It serves /team/projection/snapshot and /team/projection/stream behind that bearer.
 *   127.0.0.1:40299  this viewer host: browser half only, no team state of its own, pointed at 40298 with the same
 *                    bearer. Its page is behind the native web login, so the login URL always carries a token.
 *
 * Usage:
 *   COLLAB_WATCH_TOKEN=<32+ chars> node verification/real/collab-watch.mjs <absolute empty root inside runs/>
 * then, in another shell, the same COLLAB_WATCH_TOKEN plus:
 *   node verification/real/run.mjs collab --root <other root> --authorize-provider --arm on
 * Stop with Ctrl+C or by creating <root>/STOP.
 */
const root = path.resolve(process.argv[2] ?? '');
if (!root.replaceAll('\\', '/').toLowerCase().startsWith(process.cwd().replaceAll('\\', '/').toLowerCase() + '/runs/')) {
  console.error('USAGE: COLLAB_WATCH_TOKEN=<token> node verification/real/collab-watch.mjs <absolute root inside runs/>');
  process.exit(2);
}
const token = process.env.COLLAB_WATCH_TOKEN;
if (!token || token.length < 16) {
  console.error('COLLAB_WATCH_TOKEN is required (32+ random characters; the same value must be given to run.mjs)');
  process.exit(2);
}
const ports = { projection: Number(process.env.COLLAB_WATCH_PORT ?? 40298), viewer: Number(process.env.COLLAB_WATCH_VIEWER_PORT ?? 40299) };
const open = port => new Promise(resolve => {
  const socket = net.connect({ host: '127.0.0.1', port });
  socket.once('connect', () => { socket.destroy(); resolve(true); });
  socket.once('error', () => resolve(false));
});
// The projection port may already be served by a running collab worker (attaching mid-run); only the viewer port must be free.
for (const port of process.env.COLLAB_WATCH_ATTACH ? [ports.viewer] : [ports.viewer, ports.projection]) {
  if (await open(port)) { console.error('PORT_IN_USE:' + port); process.exit(2); }
}
fs.mkdirSync(root, { recursive: true });

// The viewer host carries no team-runtime of its own: that would be a second, empty store. It only serves the page and
// publishes where the real projection lives, which is what the ui plugin injects into the index behind login.
const patch = webOverlay(root + '/viewer', { token, team: false, client: true, port: ports.projection,
  viewer: 'member:root', origins: ['http://127.0.0.1:' + ports.viewer] });
const { base, version } = buildTarget();
const env = { ...process.env, DSH_HOME: root + '/viewer', DSH_TELEMETRY_DISABLED: '1' };
for (const key of Object.keys(env)) if (/TOKEN|API_KEY|PROXY|DSH_HOST_NODE|DSH_RUNTIME_DIR/i.test(key)) delete env[key];
const child = spawn(process.execPath, [base + 'dsh/lib/bin.js', '--profile', 'web', '--patch', patch, '--no-open',
  '--host', '127.0.0.1', '--port', String(ports.viewer)], { cwd: root + '/viewer', env, stdio: ['ignore', 'pipe', 'pipe'] });

const state = { build: version, viewer: ports.viewer, projection: ports.projection, status: 'starting', loginUrl: null, stopFile: root + '/STOP' };
const save = () => fs.writeFileSync(root + '/watch.json', JSON.stringify(state, null, 2));
let log = '';
const capture = chunk => {
  log += chunk;
  fs.appendFileSync(root + '/watch.log', chunk);
  const url = log.match(/http:\/\/127\.0\.0\.1:\d+\/\?token=[A-Za-z0-9_-]+/);
  if (url && !state.loginUrl) {
    state.loginUrl = url[0]; state.status = 'ready'; save();
    console.log('COLLAB_WATCH_READY ' + JSON.stringify({ loginUrl: state.loginUrl, projection: 'http://127.0.0.1:' + ports.projection,
      read: 'GET /team/projection/snapshot', readAuth: 'Authorization: Bearer <COLLAB_WATCH_TOKEN>' }));
  }
};
child.stdout.on('data', capture);
child.stderr.on('data', capture);

let stopping = false;
const stop = async () => {
  if (stopping) return;
  stopping = true;
  if (child.exitCode === null) child.kill('SIGTERM');
  if (child.exitCode === null) await new Promise(resolve => child.once('exit', resolve));
  const busy = [];
  for (const port of [ports.viewer, ports.projection]) if (await open(port)) busy.push(port);
  state.status = busy.length ? 'stopped-with-open-ports' : 'stopped';
  state.exitCode = child.exitCode ?? child.signalCode;
  save();
  console.log('COLLAB_WATCH_STOPPED ' + JSON.stringify({ ports, busy, exitCode: child.exitCode ?? child.signalCode }));
  if (busy.length) process.exitCode = 1;
};
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => { stop(); });
child.once('exit', code => { if (!stopping) { state.status = 'host-exited'; state.exitCode = code; save(); console.log('COLLAB_WATCH_HOST_EXITED ' + code);
      } });

// Runs until the STOP file appears or a signal arrives: a live collaboration run lasts up to 30 minutes.
const deadline = Date.now() + Number(process.env.COLLAB_WATCH_MAX_MS ?? 3 * 3600 * 1000);
while (Date.now() < deadline && !stopping && !fs.existsSync(state.stopFile)) await new Promise(resolve => setTimeout(resolve, 250));
await stop();
process.exit(process.exitCode ?? 0);
