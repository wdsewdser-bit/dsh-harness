#!/usr/bin/env node
/**
 * DSH Windows 启动器：
 *  1) 用实测 bind 探测真正可用端口（WSL2 转发的端口在 Windows netstat 里不可见，
 *     但 bind 会 EADDRINUSE，所以必须实测）；
 *  2) 启动 dsh web 子进程，并且只匹配「本次尝试之后」写入日志的 URL，
 *     避免命中上一次运行残留的旧 token；
 *  3) 成功后写 current-port.txt / current-pid.txt 并脱离，stdout 输出一行 URL。
 *
 * 用法：node launch-dsh.cjs <entry> <dshHome> <startPort> <logFile> [maxTries]
 */
const net = require('net');
const fs = require('fs');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const { ensure: ensureSubagentSettlementGuard } = require('./patch/settlement-guard.cjs');
const { ensure: ensureMilestoneOnlyCompaction } = require('./patch/milestone-only-compaction.cjs');

if (!ensureSubagentSettlementGuard()) {
  console.error('[launcher] failed to enforce the Team settlement guard');
  process.exit(1);
}

if (!ensureMilestoneOnlyCompaction()) {
  console.error('[launcher] failed to enforce milestone-only compaction');
  process.exit(1);
}


const [entry, dshHome, startPortArg, logFile, maxTriesArg] = process.argv.slice(2);
const startPort = Number(startPortArg || 39123);
const maxTries = Number(maxTriesArg || 40);
const LOGDIR = path.dirname(logFile);
const preflight = spawnSync(process.execPath, [entry, '--profile', 'web', '--dump-config'], {
  cwd: 'D:\\dsh-test', env: { ...process.env, DSH_HOME: dshHome },
  windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'], timeout: 30000,
});
if (preflight.status !== 0) {
  console.error('[launcher] profile composition preflight failed; inspect configuration before startup');
  process.exit(1);
}

function portFree(port) {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.once('error', () => resolve(false));
    srv.once('listening', () => srv.close(() => resolve(true)));
    srv.listen(port, '127.0.0.1');
  });
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 实测 :port 是否真的在接受 TCP 连接（出现 URL 不等于已在监听）。 */
function canConnect(port) {
  return new Promise((resolve) => {
    const sock = net.connect({ host: '127.0.0.1', port });
    const done = (v) => { try { sock.destroy(); } catch (e) {} resolve(v); };
    sock.setTimeout(2000);
    sock.once('connect', () => done(true));
    sock.once('error', () => done(false));
    sock.once('timeout', () => done(false));
  });
}

/** 只在 offset 之后查找该端口的 URL。 */
function urlAfter(offset, port) {
  try {
    const fd = fs.openSync(logFile, 'r');
    const size = fs.fstatSync(fd).size;
    if (size <= offset) { fs.closeSync(fd); return null; }
    const buf = Buffer.alloc(size - offset);
    fs.readSync(fd, buf, 0, buf.length, offset);
    fs.closeSync(fd);
    const re = new RegExp('http://127\\.0\\.0\\.1:' + port + '/\\?token=[A-Za-z0-9_\\-]+', 'g');
    const m = buf.toString('utf8').match(re);
    return m && m.length ? m[m.length - 1] : null;
  } catch (e) { return null; }
}

async function tryStart(port) {
  const marker = '\n=== DSH attempt port ' + port + ' @ ' + new Date().toISOString() + ' ===\n';
  try { fs.appendFileSync(logFile, marker); } catch (e) {}
  try { fs.rmSync(path.join(dshHome, 'compatibility-health.json'), { force: true }); } catch (e) {}
  const startOffset = (() => { try { return fs.statSync(logFile).size; } catch (e) { return 0; } })();

  const out = fs.openSync(logFile, 'a');
  // --max-old-space-size=12288: Node's default heap cap is ~4GB; long DSH runs have hit 8GB.
  // on long runs (logs/dsh-test.log has 9 such events, heap at 4090MB). Host RAM is 31.6GB.
  const child = spawn(process.execPath, ['--max-old-space-size=12288', entry, '--profile', 'web', '--no-open', '--port', String(port)], {
    cwd: 'D:\\dsh-test',
    env: { ...process.env, DSH_HOME: dshHome },
    stdio: ['ignore', out, out],
    // windowsHide -> CREATE_NO_WINDOW：子进程不分配控制台窗口（不弹窗）。
    // detached  -> DETACHED_PROCESS：脱离父进程生命周期，父进程退出后服务仍活着。
    // 两者组合是 Node 在 Windows 上起后台服务的标准做法：既无窗口又能存活。
    windowsHide: true,
    detached: true,
  });
  fs.closeSync(out);

  let exited = null;
  child.on('exit', (code) => { exited = code === null ? -1 : code; });

  for (let i = 0; i < 240; i++) {
    await sleep(500);
    const url = urlAfter(startOffset, port);
    if (url) {
      try {
        const health = JSON.parse(fs.readFileSync(path.join(dshHome, 'compatibility-health.json'), 'utf8'));
        if (health.pid === child.pid && health.ready === true) return { ok: true, child, url, port };
      } catch {}
    }
    if (exited !== null) {
      let reason = 'exited code ' + exited;
      try {
        const fd = fs.openSync(logFile, 'r');
        const size = fs.fstatSync(fd).size;
        const buf = Buffer.alloc(Math.min(size, 65536));
        fs.readSync(fd, buf, 0, buf.length, Math.max(0, size - buf.length));
        fs.closeSync(fd);
        if (buf.toString('utf8').includes('EADDRINUSE')) reason = 'EADDRINUSE';
      } catch (e) {}
      return { ok: false, reason };
    }
  }
  try { child.kill(); } catch (e) {}
  return { ok: false, reason: 'timeout waiting for URL and required-plugin health' };
}

(async () => {
  let lastReason = null;
  for (let i = 0; i < maxTries; i++) {
    const port = startPort + i;
    if (port > 65535) break;
    if (!(await portFree(port))) { console.error('[launcher] port ' + port + ' busy, skipping'); continue; }
    const res = await tryStart(port);
    if (res.ok) {
      // 日志里出现 URL 不等于端口已在监听，再实测一次 TCP 连接确认真的可用。
      let healthy = false;
      for (let k = 0; k < 20; k++) {
        if (await canConnect(port)) { healthy = true; break; }
        await sleep(500);
      }
      if (!healthy) {
        console.error('[launcher] port ' + port + ' printed a URL but is not accepting connections');
        try { res.child.kill(); } catch (e) {}
        lastReason = 'not accepting connections';
        continue;
      }
      fs.writeFileSync(path.join(LOGDIR, 'current-port.txt'), String(port));
      fs.writeFileSync(path.join(LOGDIR, 'current-pid.txt'), String(res.child.pid));
      res.child.unref();
      process.stdout.write(res.url);
      process.exit(0);
    }
    console.error('[launcher] port ' + port + ' failed: ' + res.reason);
    lastReason = res.reason;
    if (res.reason !== 'EADDRINUSE') break; // 非端口冲突，换端口也没用
  }
  console.error('[launcher] giving up: ' + (lastReason || 'no usable port'));
  process.exit(1);
})();
