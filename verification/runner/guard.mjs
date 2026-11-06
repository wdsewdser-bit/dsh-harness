import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import net from 'node:net';

/**
 * Run-level guards for verification/runner/run.mjs.
 *
 *   ledger  - runs/real-budget.json is hashed before and after; a change fails the run.
 *   offline - no suite may carry a live-provider argument; the run refuses to start instead of skipping quietly.
 *   ports   - 40290-40299 belong to the P4 and collaboration stages. The run refuses to start while one is taken,
 *             and names the process that holds it.
 *
 * Process-tree control lives in job.mjs (Windows job objects), not here: a job does not care about pids.
 */

export const PORTS = Array.from({ length: 10 }, (_, offset) => 40290 + offset);

export function digest(file) {
  try {
    return createHash('sha256').update(fs.readFileSync(file)).digest('hex');
  } catch (error) {
    return error.code === 'ENOENT' ? 'missing' : 'unreadable:' + error.code;
  }
}

/** A live provider call is never part of npm test: refuse the whole run rather than run it. */
export function assertOffline(suites) {
  const offenders = [];
  for (const suite of suites) {
    for (const arg of suite.entry) {
      const metered = process.env.DSH_METERED_PROVIDER_PORT;
      if ((metered !== undefined && metered !== '' && arg.includes(metered)) || arg.includes('--authorize-provider')) {
        offenders.push(suite.id + ': ' + arg);
      }
    }
  }
  if (offenders.length > 0) throw Error('a live provider entry is not allowed in npm test: ' + offenders.join(', '));
}

/** The child environment: the caller's provider key is stripped, and a runs-root suite is pointed at the ledger copy. */
export function childEnv(base, options = {}) {
  const env = { ...base };
  delete env.CLOSEOUT_PROVIDER_KEY;
  if (options.ledger) env.DSH_BUDGET_LEDGER = options.ledger;
  if (options.runId) env.DSH_TEST_RUN_ID = options.runId;
  return env;
}

/** Copy the guarded ledger byte for byte into the runs scratch, so a suite can never touch the original. */
export function prepareLedger(guardedLedger, scratchLedger) {
  fs.mkdirSync(path.dirname(scratchLedger), { recursive: true });
  if (fs.existsSync(guardedLedger)) fs.copyFileSync(guardedLedger, scratchLedger);
}

export async function openPorts(ports = PORTS) {
  const results = await Promise.all(ports.map(port => new Promise(resolve => {
    const socket = net.connect({ host: '127.0.0.1', port });
    const settle = open => {
      socket.destroy();
      resolve(open ? port : null);
    };
    socket.setTimeout(1000);
    socket.once('connect', () => settle(true));
    socket.once('error', () => settle(false));
    socket.once('timeout', () => settle(false));
  })));
  return results.filter(port => port !== null);
}

/** One PowerShell call that must produce JSON. A non-zero exit, any stderr, or unparsable output is a failure. */
function powershellJson(script, label) {
  const result = spawnSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', script],
    { encoding: 'utf8', maxBuffer: 16 << 20 });
  if (result.error) throw Error(label + ': ' + result.error.message);
  const stderr = String(result.stderr ?? '').trim();
  if (result.status !== 0) {
    throw Error(label + ': exit ' + result.status + (stderr === '' ? '' : ' ' + stderr.slice(0, 300)));
  }
  if (stderr !== '') throw Error(label + ': ' + stderr.slice(0, 300));
  const text = String(result.stdout ?? '').trim();
  if (text === '') return [];
  try {
    const parsed = JSON.parse(text);
    return Array.isArray(parsed) ? parsed : [parsed];
  } catch {
    throw Error(label + ': unreadable JSON ' + text.slice(0, 200));
  }
}

const TABLE_SCRIPT = "Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId," +
  "@{n='Creation';e={ if ($_.CreationDate) { $_.CreationDate.ToString('o') } }},CommandLine | ConvertTo-Json -Compress";

/** pid, parent pid and command line for every process. Diagnostic only: port ownership and its failure message. */
export function processTable() {
  if (process.platform !== 'win32') {
    const result = spawnSync('ps', ['-eo', 'pid=,ppid=,args='], { encoding: 'utf8' });
    return String(result.stdout ?? '').split('\n').map(line => {
      const match = line.trim().match(/^(\d+)\s+(\d+)\s+(.*)$/);
      return match
        ? { pid: Number(match[1]), parent: Number(match[2]), creation: null, command: match[3] }
        : null;
    }).filter(Boolean);
  }
  return powershellJson(TABLE_SCRIPT, 'process enumeration').map(row => ({
    pid: Number(row.ProcessId),
    parent: Number(row.ParentProcessId),
    creation: row.Creation ? String(row.Creation) : null,
    command: String(row.CommandLine ?? '')
  }));
}

/**
 * Who holds 40290-40299, with the command line to put in the failure message. Get-NetTCPConnection is the source;
 * netstat remains as a fallback and is marked as diagnostics only, because it cannot tell a stale entry from a live one.
 */
function netstatPorts(ports) {
  const result = spawnSync('netstat', ['-ano'], { encoding: 'utf8' });
  const rows = [];
  for (const line of String(result.stdout ?? '').split('\n')) {
    const match = line.match(/TCP\s+\S+:(\d+)\s+\S+\s+LISTENING\s+(\d+)/i);
    if (!match) continue;
    const port = Number(match[1]);
    if (ports.includes(port)) rows.push({ LocalPort: port, OwningProcess: Number(match[2]) });
  }
  return rows;
}

export function portOwners(ports = PORTS) {
  let rows;
  let source = 'Get-NetTCPConnection';
  try {
    const script = 'Get-NetTCPConnection -State Listen -LocalPort ' + ports.join(',') +
      " -ErrorAction Stop | Select-Object LocalPort,OwningProcess | ConvertTo-Json -Compress";
    rows = powershellJson(script, 'port enumeration');
  } catch (error) {
    source = 'netstat fallback (diagnostics only: ' + error.message + ')';
    rows = netstatPorts(ports);
  }
  if (rows.length === 0) return [];
  let table = [];
  try {
    table = processTable();
  } catch {
    table = [];
  }
  const owners = new Map();
  for (const row of rows) {
    const port = Number(row.LocalPort);
    const pid = Number(row.OwningProcess);
    if (!ports.includes(port) || owners.has(port)) continue;
    owners.set(port, { port, pid, source, command: table.find(entry => entry.pid === pid)?.command ?? '(unknown)' });
  }
  return [...owners.values()].sort((a, b) => a.port - b.port);
}
