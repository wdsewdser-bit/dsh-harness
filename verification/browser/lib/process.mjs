// Small process / timing helpers shared by the browser entries (no dependencies).
import net from 'node:net';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { assertAllowedPort } from './guard.mjs';

export const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

/** The harness runs one browser and one server; keep well below half the cores even on a small machine. */
export function childBudget(cpus = os.cpus().length) {
  return Math.max(1, Math.floor(cpus / 2));
}
export function assertChildBudget(planned) {
  const limit = childBudget();
  if (planned > limit) throw Error('进程预算超限：计划 ' + planned + ' 个，上限 ' + limit + '（核数一半）');
  return limit;
}

export class TimeoutError extends Error {
  constructor(label, ms) { super('TIMEOUT: ' + label + '（' + ms + 'ms）'); this.name = 'TimeoutError'; this.code = 'TIMEOUT'; }
}

/** Poll a predicate until it returns a truthy value; every failure carries the label of what was awaited. */
export async function until(fn, label, { timeoutMs = 20000, intervalMs = 100 } = {}) {
  const end = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < end) {
    try {
      const value = await fn();
      if (value) return value;
      last = value;
    } catch (error) { last = String(error?.message ?? error); }
    await delay(intervalMs);
  }
  throw new TimeoutError(label + (last ? '（最后结果：' + String(last).slice(0, 200) + '）' : ''), timeoutMs);
}

/** Kill a process and its children. Windows needs taskkill /T, POSIX a process group. */
export function killTree(child, signal = 'SIGKILL') {
  if (!child || child.exitCode !== null) return false;
  try {
    if (process.platform === 'win32') {
      execFileSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
    } else {
      try { process.kill(-child.pid, signal); } catch { child.kill(signal); }
    }
    return true;
  } catch { return false; }
}

/** A port nobody listens on right now; the metered port is refused rather than probed. */
export async function freePort() {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const port = await new Promise((resolve, reject) => {
      const server = net.createServer();
      server.unref();
      server.on('error', reject);
      server.listen(0, '127.0.0.1', () => { const { port } = server.address(); server.close(() => resolve(port)); });
    });
    try { assertAllowedPort(port, '随机端口'); return port; } catch { /* metered or unusable: draw another */ }
  }
  throw Error('没有可用的本地端口');
}
