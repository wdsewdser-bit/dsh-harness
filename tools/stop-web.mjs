#!/usr/bin/env node
/**
 * DSH v2 deployment stop — the counterpart of tools/launch-web.mjs.
 *
 * It kills a node process only when its command line is *this deployment*: the build entry
 * (buildTarget().base + 'dsh/lib/bin.js' — the prepared copy of the 0.2.2 release), the entry an earlier
 * launch recorded, or the launcher script itself. Any other node process on the machine — another DSH deployment, an editor server, a
 * test run — carries a different command line and is left alone.
 *
 * Afterwards the ports this deployment used must refuse connections and the pid/port/url/token records are
 * removed, so a later start cannot adopt a dead instance.
 */
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { buildTarget } from '../packages/adapter-dsh/index.mjs';

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const note = message => console.log('[DSH v2 stop] ' + message);

const home = process.env.DSH_V2_HOME ? path.resolve(process.env.DSH_V2_HOME) : '';
const logsDir = path.resolve(process.env.DSH_LOGS ?? path.join(home || process.cwd(), 'logs'));
const files = {
  port: path.join(logsDir, 'current-port.txt'),
  pid: path.join(logsDir, 'current-pid.txt'),
  url: path.join(logsDir, 'current-url.txt'),
  token: path.join(logsDir, 'runtime-token.txt'),
  runtime: path.join(logsDir, 'runtime-v2.json'),
};
const readText = file => { try { return fs.readFileSync(file, 'utf8'); } catch { return ''; } };
const readJson = file => { try { return JSON.parse(readText(file)); } catch { return null; } };
const normalise = text => String(text ?? '').toLowerCase().replaceAll('/', '\\');

function canConnect(port) {
  return new Promise(resolve => {
    const socket = net.connect({ host: '127.0.0.1', port });
    const done = value => { try { socket.destroy(); } catch { /* already closed */ } resolve(value); };
    socket.setTimeout(1500);
    socket.once('connect', () => done(true));
    socket.once('error', () => done(false));
    socket.once('timeout', () => done(false));
  });
}

/** Every node process whose command line names one of this deployment's own entry points. */
function matchingPids(needles) {
  const script = [
    '$entry = $env:DSH_STOP_ENTRY; $launcher = $env:DSH_STOP_LAUNCHER;',
    'Get-CimInstance Win32_Process | Where-Object { $_.Name -in @(\'node.exe\', \'node\') } | ForEach-Object {',
    '  $c = $_.CommandLine; if (-not $c) { return }',
    "  $n = $c.ToLower().Replace('/', '\\');",
    '  if (($entry -and $n.Contains($entry)) -or ($launcher -and $n.Contains($launcher))) { $_.ProcessId }',
    '}',
  ].join('\n');
  const env = { ...process.env, DSH_STOP_ENTRY: normalise(needles.entry), DSH_STOP_LAUNCHER: normalise(needles.launcher) };
  const result = spawnSync('powershell', ['-NoProfile', '-Command', script], { encoding: 'utf8', windowsHide: true, env });
  const output = (result.stdout ?? '').trim();
  return output.split(/\s+/u).map(value => Number(value)).filter(pid => Number.isInteger(pid) && pid > 0 &&
    pid !== process.pid);
}

(async () => {
  const runtime = readJson(files.runtime);
  let entry = runtime && typeof runtime.entry === 'string' ? runtime.entry : '';
  if (!entry) {
    try { entry = buildTarget().base + 'dsh/lib/bin.js'; }
    catch (error) { note('no build entry could be resolved (' + error.message + '); matching the launcher only'); }
  }
  const launcher = fileURLToPath(new URL('./launch-web.mjs', import.meta.url));
  const recorded = Number(readText(files.pid).trim());
  note('home ' + (home || '(unset)') + ', entry ' + (entry || '(unresolved)'));

  // Only a process whose own command line names one of these entry points is stopped. A recorded pid that does
  // not match belongs to something else and is reported, never killed.
  const verified = matchingPids({ entry, launcher });
  if (Number.isInteger(recorded) && recorded > 0 && !verified.includes(recorded)) {
    note('recorded pid ' + recorded + ' does not belong to this deployment; left alone');
  }
  if (verified.length === 0) note('no running v2 process was found');
  for (const pid of verified) {
    note('stopping pid ' + pid);
    spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
  }

  const ports = [Number(runtime?.port), Number(readText(files.port).trim())].filter(port => Number.isInteger(port) && port > 0);
  for (const port of new Set(ports)) {
    let freed = false;
    for (let step = 0; step < 30 && !freed; step += 1) {
      if (!(await canConnect(port))) freed = true; else await sleep(500);
    }
    note('port ' + port + ': ' + (freed ? 'released' : 'STILL LISTENING'));
  }
  const projectionPort = Number(runtime?.projectionPort);
  if (Number.isInteger(projectionPort) && projectionPort > 0) {
    let freed = false;
    for (let step = 0; step < 30 && !freed; step += 1) {
      if (!(await canConnect(projectionPort))) freed = true; else await sleep(400);
    }
    note('projection port ' + projectionPort + ': ' + (freed ? 'released' : 'STILL LISTENING'));
  }

  for (const file of [files.pid, files.port, files.url, files.token, files.runtime]) fs.rmSync(file, { force: true });
  const left = matchingPids({ entry, launcher });
  if (left.length > 0) { note('still running: ' + left.join(', ')); process.exit(1); }
  note('stopped; records cleared');
})().catch(error => { console.error('[DSH v2 stop] ' + error.message); process.exit(1); });
