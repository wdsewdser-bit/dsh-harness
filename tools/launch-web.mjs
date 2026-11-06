#!/usr/bin/env node
/**
 * DSH v2 deployment launcher — the web host of the team-plugin rebuild.
 *
 * Everything machine-specific arrives through the environment, because this file ships in the repository
 * (check-deps rule (c): no drive-letter literal in a source file) and because the desktop shortcut owns the
 * machine layout: DSH_V2_HOME (the 0.2.2 home), DSH_LOGS, DSH_TMP, DSH_CREDENTIALS_SRC, DSH_START_PORT,
 * DSH_PROJECTION_PORT, DSH_NO_BROWSER.
 *
 * The sequence:
 *   1. a healthy instance of *this* deployment is reused (recorded pid still alive, its command line is the
 *      build entry, its login URL answers 200) instead of starting a duplicate;
 *   2. otherwise the ports are chosen by an actual bind (netstat cannot see WSL2-forwarded ports, bind can);
 *   3. the team overlay is written by packages/profiles/web.mjs webOverlay (team-runtime + projections +
 *      client-team) with a freshly drawn projection token, never persisted in the repository;
 *   4. the shipped web host starts detached, and only a login URL written *after* this attempt's marker in the
 *      log can be adopted, so a stale URL from an earlier run is never opened;
 *   5. the login URL and the projection snapshot are both answered 200 before the instance is recorded.
 *
 * The provider is not configured here: it is the home's own profile user layer
 * (profiles/web/cordis.patch.yml), which pins the endpoint and the credential *reference*. The credential
 * document is only ever copied file-to-file or named by reference, never read into an output.
 */
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { buildTarget } from '../packages/adapter-dsh/index.mjs';
import { webOverlay } from '../packages/profiles/web.mjs';

/** The login URL the web host prints once it accepts connections; the port is matched per attempt. */
const LOGIN = /http:\/\/127\.0\.0\.1:(\d+)\/\?token=[A-Za-z0-9_-]+/g;
/** The provider rows this deployment writes into a fresh home, in the 0.2.2 profile user-layer format. */
const PROVIDER_LAYER = [
  '# DSH v2 deployment: the 0.2.2 web profile user layer.',
  '# The shipped base mounts llm-deepseek; this pins this deployment endpoint and the credential reference.',
  '# The secret itself lives only in ../.credentials.yaml and is resolved per request by reference.',
  '- id: llm-deepseek',
  '  config:',
  '    baseURL: https://api.deepseek.com/anthropic',
  '    apiKeyEnv: DEEPSEEK_API_KEY',
  '',
].join('\n');

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const note = message => console.log('[DSH v2] ' + message);
const fail = message => { console.error('[DSH v2] ' + message); process.exit(1); };

const home = process.env.DSH_V2_HOME ? path.resolve(process.env.DSH_V2_HOME) : '';
if (!home) fail('DSH_V2_HOME is not set; the start script provides it.');
const logsDir = path.resolve(process.env.DSH_LOGS ?? path.join(home, 'logs'));
const startPort = Number(process.env.DSH_START_PORT ?? 40123);
const projectionStartPort = Number(process.env.DSH_PROJECTION_PORT ?? 40292);
const maxTries = Number(process.env.DSH_PORT_TRIES ?? 40);
const readyTimeoutMs = Number(process.env.DSH_READY_TIMEOUT_MS ?? 180000);
const maxOldSpaceMb = Number(process.env.DSH_NODE_MAX_OLD_SPACE_MB ?? 12288);
const tmpDir = process.env.DSH_TMP ? path.resolve(process.env.DSH_TMP) : '';
const credentialsSource = process.env.DSH_CREDENTIALS_SRC ? path.resolve(process.env.DSH_CREDENTIALS_SRC) : '';
const noBrowser = process.env.DSH_NO_BROWSER === '1' || process.argv.includes('--no-browser');
const logFile = path.join(logsDir, process.env.DSH_LOG_NAME ?? 'dsh-v2.log');
const files = {
  port: path.join(logsDir, 'current-port.txt'),
  pid: path.join(logsDir, 'current-pid.txt'),
  url: path.join(logsDir, 'current-url.txt'),
  token: path.join(logsDir, 'runtime-token.txt'),
  runtime: path.join(logsDir, 'runtime-v2.json'),
};

const readText = file => { try { return fs.readFileSync(file, 'utf8'); } catch { return ''; } };
const readJson = file => { try { return JSON.parse(readText(file)); } catch { return null; } };
const openBrowser = url => {
  if (noBrowser) { note('browser: not opened (DSH_NO_BROWSER=1)'); return; }
  const command = process.platform === 'win32' ? 'cmd.exe' : process.platform === 'darwin' ? 'open' : 'xdg-open';
  const args = process.platform === 'win32' ? ['/c', 'start', '', url] : [url];
  try {
    spawn(command, args, { stdio: 'ignore', windowsHide: true, detached: true }).unref();
    note('browser: opened');
  } catch (error) { note('browser: could not start (' + error.message + '); open the URL recorded in ' + files.url); }
};

/** The login URL shows its token only masked: the console must never carry it. */
const maskUrl = url => url.replace(/([?&]token=)[^&]*/u, '$1***');

function portFree(port) {
  return new Promise(resolve => {
    const server = net.createServer();
    server.once('error', () => resolve(false));
    server.once('listening', () => server.close(() => resolve(true)));
    server.listen(port, '127.0.0.1');
  });
}

/** A printed URL is not a listener; only a real TCP connect proves the host accepts connections. */
function canConnect(port) {
  return new Promise(resolve => {
    const socket = net.connect({ host: '127.0.0.1', port });
    const done = value => { try { socket.destroy(); } catch { /* already closed */ } resolve(value); };
    socket.setTimeout(2000);
    socket.once('connect', () => done(true));
    socket.once('error', () => done(false));
    socket.once('timeout', () => done(false));
  });
}

/**
 * The login URL answers 303 with a login cookie, and the page it leads to answers 200 — that pair is what a
 * browser does when the operator opens the URL. An already authenticated first hop answers 200 directly.
 */
async function loginStatus(url) {
  try {
    const first = await fetch(url, { redirect: 'manual' });
    if (first.status === 200 || first.status >= 400) return { first: first.status, final: first.status };
    const location = first.headers.get('location');
    if (!location) return { first: first.status, final: first.status };
    const cookie = (first.headers.getSetCookie?.() ?? []).map(value => value.split(';')[0]).join('; ');
    const page = await fetch(new URL(location, url), { headers: cookie ? { cookie } : {} });
    return { first: first.status, final: page.status };
  } catch { return { first: 0, final: 0 }; }
}

const snapshotUrl = port => 'http://127.0.0.1:' + port + '/team/projection/snapshot';
async function snapshotStatus(token, projectionPort) {
  try {
    const response = await fetch(snapshotUrl(projectionPort), { headers: { authorization: 'Bearer ' + token } });
    return response.status;
  } catch { return 0; }
}

/**
 * The host this deployment boots: buildTarget(), the repository's single build switch, which resolves the
 * prepared copy (build/builds.json default prepared by verification/prepare-build.mjs, DSH_UPSTREAM_BUILD or
 * the runs/ pointer overriding it). The raw C1 install named in builds.json carries no dispatch contract, so
 * buildTarget refuses it — running the unprepared copy is PATCH_MISSING, never a quiet fall back.
 */
function entryPath() { return buildTarget().base + 'dsh/lib/bin.js'; }

/** The provider rows a fresh home needs; an existing user layer is never rewritten. */
function ensureHome() {
  fs.mkdirSync(logsDir, { recursive: true });
  fs.mkdirSync(path.join(home, 'profiles', 'web'), { recursive: true });
  if (tmpDir) fs.mkdirSync(tmpDir, { recursive: true });
  const credentials = path.join(home, '.credentials.yaml');
  if (!fs.existsSync(credentials) && credentialsSource && fs.existsSync(credentialsSource)) {
    fs.copyFileSync(credentialsSource, credentials);
    note('credentials: copied the document into the home (values are never printed)');
  }
  if (!fs.existsSync(credentials)) note('credentials: none in the home; provider requests fail until its refs are present');
  const layer = path.join(home, 'profiles', 'web', 'cordis.patch.yml');
  const current = fs.existsSync(layer) ? fs.readFileSync(layer, 'utf8').trim() : '';
  if (current === '' || current === '[]') fs.writeFileSync(layer, PROVIDER_LAYER);
}

/** The provider environment is inherited on purpose: this host talks to the real provider, unlike the fixture. */
function childEnv() {
  const env = { ...process.env, DSH_HOME: home, DSH_TELEMETRY_DISABLED: '1' };
  if (tmpDir) { env.TEMP = tmpDir; env.TMP = tmpDir; }
  return env;
}

function pidAlive(pid) {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

/** Normalised command-line match for one process, used to prove a recorded pid is still *our* host. */
function commandLineOf(pid) {
  const script = 'Get-CimInstance Win32_Process -Filter "ProcessId=' + Number(pid) + '" | ' +
    'ForEach-Object { $_.CommandLine }';
  try {
    const result = spawnSync('powershell', ['-NoProfile', '-Command', script], { encoding: 'utf8', windowsHide: true });
    return (result.stdout ?? '').trim();
  } catch { return ''; }
}

const normalise = text => String(text ?? '').toLowerCase().replaceAll('/', '\\');

/** A running instance this launcher may adopt: recorded pid, build entry, open port, and a 200 login page. */
async function healthyInstance() {
  const runtime = readJson(files.runtime);
  if (!runtime || !Number.isInteger(runtime.pid) || !Number.isInteger(runtime.port)) return null;
  const url = readText(files.url).trim();
  if (!url || !url.includes('127.0.0.1:' + runtime.port + '/')) return null;
  if (!pidAlive(runtime.pid)) return null;
  const command = normalise(commandLineOf(runtime.pid));
  if (!command.includes(normalise(runtime.entry ?? entryPath()))) return null;
  if (!(await canConnect(runtime.port))) return null;
  const login = await loginStatus(url);
  if (login.final !== 200) return null;
  const snapshot = await snapshotStatus(readText(files.token).trim(), runtime.projectionPort);
  if (snapshot !== 200) return null;
  return { ...runtime, url, login, snapshot };
}

function appendMarker(port) {
  const marker = '\n=== DSH v2 attempt port ' + port + ' @ ' + new Date().toISOString() + ' ===\n';
  fs.appendFileSync(logFile, marker);
}

/** Only text written after this attempt's marker can name this attempt's login URL. */
function loginAfter(offset, port) {
  let text;
  try {
    const handle = fs.openSync(logFile, 'r');
    const size = fs.fstatSync(handle).size;
    if (size <= offset) { fs.closeSync(handle); return null; }
    const buffer = Buffer.alloc(size - offset);
    fs.readSync(handle, buffer, 0, buffer.length, offset);
    fs.closeSync(handle);
    text = buffer.toString('utf8');
  } catch { return null; }
  const found = [...text.matchAll(LOGIN)].map(match => match[0]).filter(url => url.includes('127.0.0.1:' + port + '/'));
  return found.length ? found[found.length - 1] : null;
}

function tail(offset, limit = 1200) {
  const text = readText(logFile);
  return text.slice(Math.max(offset, text.length - limit));
}

function killTree(child) {
  if (!child || !child.pid) return;
  try { spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true }); } catch { /* already gone */ }
}

async function attempt(port, projectionPort) {
  const token = randomBytes(24).toString('hex');
  const patch = webOverlay(home, { token, team: true, port: projectionPort });
  const entry = entryPath();
  appendMarker(port);
  const offset = fs.statSync(logFile).size;
  const out = fs.openSync(logFile, 'a');
  const child = spawn(process.execPath, ['--max-old-space-size=' + String(maxOldSpaceMb), entry, '--profile', 'web',
    '--patch', patch, '--no-open', '--host', '127.0.0.1', '--port', String(port)],
  { cwd: home, env: childEnv(), stdio: ['ignore', out, out], windowsHide: true, detached: true });
  fs.closeSync(out);
  let exited = null;
  child.once('exit', code => { exited = code ?? -1; });
  const deadline = Date.now() + readyTimeoutMs;
  let url = null;
  while (Date.now() < deadline) {
    await sleep(500);
    url = loginAfter(offset, port);
    if (url || exited !== null) break;
  }
  if (!url) {
    const output = tail(offset);
    killTree(child);
    const busy = output.includes('EADDRINUSE');
    return { ok: false, retry: busy, reason: exited === null ? 'timeout waiting for the login URL' :
      'the host exited (' + exited + ')' + (busy ? ': EADDRINUSE' : '; tail: ' + output.trim().split('\n').slice(-3).join(' | ')) };
  }
  let login = { first: 0, final: 0 };
  let snapshot = 0;
  const verifyUntil = Date.now() + 30000;
  while (Date.now() < verifyUntil) {
    if (await canConnect(port)) {
      login = await loginStatus(url);
      if (login.final === 200) {
        snapshot = await snapshotStatus(token, projectionPort);
        if (snapshot === 200) break;
      }
    }
    await sleep(300);
  }
  if (login.final !== 200 || snapshot !== 200) {
    killTree(child);
    return { ok: false, retry: false,
      reason: 'login/snapshot did not answer 200 (login ' + login.first + '->' + login.final + ', snapshot ' + snapshot + ')' };
  }
  return { ok: true, child, entry, port, projectionPort, token, url, login, snapshot };
}

function record(state) {
  fs.writeFileSync(files.port, String(state.port));
  fs.writeFileSync(files.pid, String(state.pid));
  fs.writeFileSync(files.url, state.url);
  fs.writeFileSync(files.token, state.token);
  const runtime = { pid: state.pid, port: state.port, projectionPort: state.projectionPort, entry: state.entry,
    home, startedAt: new Date().toISOString() };
  fs.writeFileSync(files.runtime + '.tmp', JSON.stringify(runtime, null, 2));
  fs.renameSync(files.runtime + '.tmp', files.runtime);
}

function summary(state, reused) {
  note((reused ? 'reusing the running instance: pid ' : 'started: pid ') + state.pid);
  note('web 127.0.0.1:' + state.port + ', projection 127.0.0.1:' + state.projectionPort);
  note('login URL ' + state.login.first + ' -> ' + state.login.final + ', projection snapshot ' + state.snapshot);
  note('login URL (token hidden): ' + maskUrl(state.url));
  note('full URL: ' + files.url + ' (contains the one-time login token; treat it as private)');
  note('log: ' + logFile);
}

/** A profile-layer mistake fails here, before a detached process exists to clean up. */
function preflight(patch, entry) {
  if (process.env.DSH_SKIP_PREFLIGHT === '1') return;
  const result = spawnSync(process.execPath, [entry, '--profile', 'web', '--patch', patch, '--dump-config'],
    { cwd: home, env: childEnv(), encoding: 'utf8', windowsHide: true, timeout: 120000 });
  if (result.status === 0) return;
  const output = ((result.stdout ?? '') + (result.stderr ?? '')).trim().split('\n').slice(-8).join('\n');
  fail('profile composition preflight failed; fix the configuration before starting\n' + output);
}

(async () => {
  ensureHome();
  const running = await healthyInstance();
  if (running) {
    summary(running, true);
    openBrowser(running.url);
    process.exitCode = 0;
    return;
  }
  note('starting the v2 web host from port ' + startPort + ' (home ' + home + ')');
  const preflightPatch = webOverlay(home, { token: randomBytes(24).toString('hex'), team: true, port: projectionStartPort });
  preflight(preflightPatch, entryPath());
  for (let index = 0; index < maxTries; index += 1) {
    const port = startPort + index;
    if (port > 65535) break;
    if (!(await portFree(port))) { note('port ' + port + ' is busy; trying the next one'); continue; }
    let projectionPort = 0;
    for (let step = 0; step < maxTries && !projectionPort; step += 1) {
      const candidate = projectionStartPort + step;
      if (candidate === port || candidate > 65535) continue;
      if (await portFree(candidate)) projectionPort = candidate;
    }
    if (!projectionPort) fail('no free projection port from ' + projectionStartPort);
    const result = await attempt(port, projectionPort);
    if (result.ok) {
      record({ pid: result.child.pid, port, projectionPort: result.projectionPort, entry: result.entry,
        url: result.url, token: result.token });
      result.child.unref();
      summary({ ...result, pid: result.child.pid, snapshot: result.snapshot }, false);
      openBrowser(result.url);
      process.exitCode = 0;
      return;
    }
    note('port ' + port + ' failed: ' + result.reason);
    if (!result.retry) break;
  }
  fail('giving up: no usable port for the v2 web host');
})();
