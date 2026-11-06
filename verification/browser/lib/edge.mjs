// Headless Edge over the CDP WebSocket. No downloaded driver, no dependency: Node's built-in fetch + WebSocket.
// Edge must exist: a missing browser is EDGE_NOT_FOUND, never a skipped run (22 §WP-6 连锁风险).
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { delay, until, killTree, freePort } from './process.mjs';

export class EdgeNotFound extends Error {
  constructor(message) { super('EDGE_NOT_FOUND: ' + message); this.name = 'EdgeNotFound'; this.code = 'EDGE_NOT_FOUND'; }
}

export function edgeCandidates(env = process.env, platform = process.platform) {
  if (platform === 'win32') {
    return [
      'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
      'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
      env.LOCALAPPDATA ? path.join(env.LOCALAPPDATA, 'Microsoft/Edge/Application/msedge.exe') : null,
    ].filter(Boolean);
  }
  if (platform === 'darwin') return ['/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge'];
  return ['/usr/bin/microsoft-edge', '/usr/bin/microsoft-edge-stable', '/opt/microsoft/msedge/msedge'];
}

/**
 * Resolve the browser. DSH_EDGE_PATH is an explicit override: when it is set it must exist, and a bad value never
 * falls back to another install (that is how a broken path would otherwise "pass").
 */
export function findEdge({ env = process.env, platform = process.platform, exists = fs.existsSync } = {}) {
  const named = env.DSH_EDGE_PATH;
  if (named) return exists(named) ? named : raise('DSH_EDGE_PATH 指向的 Edge 不存在：' + named);
  for (const candidate of edgeCandidates(env, platform)) if (exists(candidate)) return candidate;
  throw new EdgeNotFound('找不到 Edge 可执行文件；试过 ' + edgeCandidates(env, platform).join('、') +
    '。安装 Edge 或用 DSH_EDGE_PATH 指定（本验收不接受别的浏览器顶替）');
}
function raise(message) { throw new EdgeNotFound(message); }

class CdpSession {
  constructor(socket) {
    this.socket = socket;
    this.seq = 0;
    this.pending = new Map();
    this.listeners = new Set();
    this.errors = [];
    socket.onmessage = event => this.#onMessage(event);
  }
  static async connect(url, timeoutMs = 20000) {
    const socket = new WebSocket(url);
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('CDP 连接超时')), timeoutMs);
      socket.onopen = () => { clearTimeout(timer); resolve(); };
      socket.onerror = error => { clearTimeout(timer); reject(new Error('CDP 连接失败：' + (error?.message ?? 'error'))); };
    });
    return new CdpSession(socket);
  }
  #onMessage(event) {
    const message = JSON.parse(event.data);
    if (message.id) {
      const waiter = this.pending.get(message.id);
      if (!waiter) return;
      this.pending.delete(message.id);
      message.error ? waiter.reject(Error(message.error.message ?? 'CDP error')) : waiter.resolve(message.result);
      return;
    }
    this.#track(message);
    for (const listener of this.listeners) { try { listener(message); } catch { /* a listener never breaks the wire */ } }
  }
  #track(message) {
    if (message.method === 'Runtime.exceptionThrown') {
      const details = message.params.exceptionDetails;
      this.errors.push('exception: ' + (details.exception?.description ?? details.text));
    } else if (message.method === 'Runtime.consoleAPICalled' && message.params.type === 'error') {
      this.errors.push('console.error: ' + message.params.args.map(a => a.value ?? a.description ?? '').join(' '));
    } else if (message.method === 'Log.entryAdded' && message.params.entry.level === 'error') {
      this.errors.push('log: ' + message.params.entry.text);
    }
  }
  on(listener) { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  send(method, params = {}, timeoutMs = 30000) {
    const id = ++this.seq;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error('CDP ' + method + ' 超时')); }, timeoutMs);
      this.pending.set(id, { resolve: value => { clearTimeout(timer); resolve(value); },
        reject: error => { clearTimeout(timer); reject(error); } });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }
  close() { try { this.socket.close(); } catch { /* already gone */ } }
}

/**
 * Launch headless Edge and open one page session. The caller owns close(): it stops the whole browser tree, so a
 * failed run cannot leave an msedge.exe behind holding a port.
 */
export async function startEdge({ workDir, timeoutMs = 45000 } = {}) {
  const exe = findEdge();
  const debugPort = await freePort();
  const profileDir = path.join(path.resolve(workDir), 'edge-profile');
  // Always a fresh profile: a lock left by an interrupted run makes Edge hang instead of opening the debugging port.
  fs.rmSync(profileDir, { recursive: true, force: true });
  fs.mkdirSync(profileDir, { recursive: true });
  const child = spawn(exe, ['--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
    '--disable-background-networking', '--disable-extensions', '--hide-scrollbars', '--force-device-scale-factor=1',
    // Without this every navigation leaves its document (and its open event stream) in the back/forward cache; after
    // six navigations the next document request queues forever behind the held sockets. The harness navigates a lot.
    '--disable-features=BackForwardCache', '--remote-debugging-port=' + debugPort,
    '--user-data-dir=' + profileDir, 'about:blank'],
  { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true });
  let tail = '';
  child.stderr.on('data', chunk => { tail = (tail + chunk.toString()).slice(-4000); });
  const spawnError = new Promise((_, reject) => child.once('error', reject));
  try {
    const page = await Promise.race([untilPage(debugPort, timeoutMs), spawnError]);
    const session = await CdpSession.connect(page.webSocketDebuggerUrl);
    const api = createPage(session, child, profileDir);
    await api.ready();
    return api;
  } catch (error) {
    killTree(child);
    throw Error(error.message + '（' + exe + '，profile ' + profileDir + (tail ? '；Edge 输出：' + tail.slice(-600) : '') + '）');
  }
}

async function untilPage(debugPort, timeoutMs) {
  return until(async () => {
    const response = await fetch('http://127.0.0.1:' + debugPort + '/json/list');
    const targets = await response.json();
    return targets.find(target => target.type === 'page') ?? null;
  }, 'Edge CDP 就绪', { timeoutMs, intervalMs: 200 });
}

function createPage(session, child, profileDir) {
  const page = {
    session, child, profileDir, errors: session.errors,
    send: (method, params) => session.send(method, params),
    async ready() {
      await session.send('Page.enable');
      await session.send('Runtime.enable');
      await session.send('Log.enable');
    },
    async evaluate(expression) {
      const result = await session.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
      if (result.exceptionDetails) {
        const details = result.exceptionDetails;
        throw Error('页面求值失败：' + (details.exception?.description ?? details.text));
      }
      return result.result.value;
    },
    async waitFor(expression, label, options = {}) {
      return until(() => page.evaluate(expression), label, options);
    },
    /** Navigate and wait for the new document to start. One retry covers a stall without hiding a real hang. */
    async navigate(url, timeoutMs = 20000) {
      try {
        await session.send('Page.navigate', { url }, timeoutMs);
      } catch {
        await delay(1000);
        await session.send('Page.navigate', { url }, timeoutMs);
      }
      await delay(150);
    },
    async setViewport(width, height) {
      await session.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });
      await page.evaluate('new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)))');
      await delay(120);
    },
    async screenshot() {
      const shot = await session.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
      return Buffer.from(shot.data, 'base64');
    },
    async press(key, { code, windowsVirtualKeyCode, text } = {}) {
      const base = { key, ...(code ? { code } : {}), ...(windowsVirtualKeyCode ? { windowsVirtualKeyCode } : {}) };
      await session.send('Input.dispatchKeyEvent', { type: text ? 'keyDown' : 'rawKeyDown', ...base, ...(text ? { text } : {}) });
      await session.send('Input.dispatchKeyEvent', { type: 'keyUp', ...base });
      await delay(60);
    },
    async close() {
      session.close();
      killTree(child);
      await delay(300);
      try { fs.rmSync(profileDir, { recursive: true, force: true }); } catch { /* profile is best effort */ }
    },
  };
  return page;
}
