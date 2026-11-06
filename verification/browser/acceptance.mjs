// M6 WP-6: the browser acceptance entry. It starts the mock fixture host, drives headless Edge, runs every item of
// 16 §3 / 15 §9 V-01…V-24 that v3 can express, captures the two viewports and writes runs/m6-browser/<ts>/report.json.
//
//   npm run test:browser            # the whole checklist
//   node verification/browser/acceptance.mjs --only V-05,V-06
//
// It is deliberately NOT part of npm test (22 §WP-6): a browser run has its own timeout and must not slow the suites.
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { assertSafeEntry } from './lib/guard.mjs';
import { assertChildBudget, delay } from './lib/process.mjs';
import { findEdge, startEdge } from './lib/edge.mjs';
import { startFixtureServer, repoRoot } from './serve.fixture.mjs';
import { createPageActions, settleShell } from './lib/page-actions.mjs';
import { captureViewports, VIEWPORTS } from './capture.mjs';
import { SCOPE_CHECKS } from './checks/scope.mjs';
import { LANGUAGE_CHECKS } from './checks/language.mjs';
import { PERMISSION_CHECKS } from './checks/permission.mjs';
import { SEMANTICS_CHECKS } from './checks/semantics.mjs';
import { LAYOUT_CHECKS } from './checks/layout.mjs';

/**
 * Team-registered pixel baselines: the acceptance captures exactly two states of the mounted Team UI (default at
 * 1440x900 and the narrow drawer at 480x900). They are compared with the stored baseline on every run, so a layout
 * drift in the registered state fails the gate instead of only producing fresh artifacts.
 * `--update-baselines` rewrites them.
 */
const BASELINE_DIR = path.join(repoRoot, 'verification/browser/baselines');
const sha256File = file => createHash('sha256').update(fs.readFileSync(file)).digest('hex');
function compareBaselines(shots, { update }) {
  const entries = [];
  for (const shot of shots) {
    const name = path.basename(shot);
    const stored = path.join(BASELINE_DIR, name);
    const sha256 = sha256File(shot);
    if (update) {
      fs.mkdirSync(BASELINE_DIR, { recursive: true });
      fs.copyFileSync(shot, stored);
      entries.push({ name, sha256, bytes: fs.statSync(shot).size, status: 'updated' });
      continue;
    }
    const exists = fs.existsSync(stored);
    const match = exists && sha256File(stored) === sha256;
    entries.push({ name, sha256, bytes: fs.statSync(shot).size,
      status: exists ? (match ? 'match' : 'mismatch') : 'missing' });
  }
  if (update) {
    fs.writeFileSync(path.join(BASELINE_DIR, 'manifest.json'),
      JSON.stringify({ capturedAt: new Date().toISOString(), entries }, null, 2) + '\n');
  }
  return entries;
}

export const CHECKS = Object.freeze([...SCOPE_CHECKS, ...LANGUAGE_CHECKS, ...PERMISSION_CHECKS,
  ...SEMANTICS_CHECKS, ...LAYOUT_CHECKS]);
export const CHECK_TIMEOUT_MS = 90000;
export const RUN_TIMEOUT_MS = 20 * 60 * 1000;
export const MIN_PASSED = 12;

const stamp = () => new Date().toISOString().slice(0, 19).replace(/[-:]/g, '');

function withTimeout(promise, ms, label) {
  let timer = null;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(Error('TIMEOUT: ' + label + '（' + ms + 'ms）')), ms);
    timer.unref?.();
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function artifactsReport(dir, files) {
  return files.map(file => ({ path: path.relative(repoRoot, file).replaceAll('\\', '/'),
    bytes: fs.existsSync(file) ? fs.statSync(file).size : 0, exists: fs.existsSync(file) }));
}

async function main(argv) {
  assertSafeEntry();
  const only = (() => {
    const index = argv.indexOf('--only');
    if (index < 0) return null;
    return new Set((argv[index + 1] ?? '').split(',').map(s => s.trim()).filter(Boolean));
  })();
  assertChildBudget(2);
  const selected = CHECKS.filter(check => !only || only.has(check.id));
  if (!selected.length) throw Error('清单为空：零条检查不能算通过');
  const outDir = path.join(repoRoot, 'runs/m6-browser', stamp());
  fs.mkdirSync(outDir, { recursive: true });
  const startedAt = new Date();
  const deadline = Date.now() + RUN_TIMEOUT_MS;
  let host = null, page = null;
  const report = {
    schemaVersion: 1, wp: 'M6 WP-6', startedAt: startedAt.toISOString(),
    entry: { command: 'npm run test:browser', script: 'verification/browser/acceptance.mjs' },
    host: { mode: 'mock', note: 'DSH web host + client-team plugin, browser-side mock source, no provider' },
    browser: { headless: true, viewports: VIEWPORTS.map(v => v.name) },
    summary: { total: selected.length, passed: 0, failed: 0, notApplicable: 0, minPassed: MIN_PASSED },
    checks: [], artifacts: { dir: path.relative(repoRoot, outDir).replaceAll('\\', '/'), screenshots: [], dom: [] },
    consoleErrors: [], verdict: 'fail',
  };
  const cleanup = () => { try { page?.close(); } catch { /* browser already gone */ } try { host?.stop(); } catch {} };
  const onSignal = signal => { cleanup(); console.error('[acceptance] ' + signal + '：已回收浏览器与夹具宿主'); process.exit(130); };
  process.on('SIGINT', () => onSignal('SIGINT'));
  process.on('SIGTERM', () => onSignal('SIGTERM'));
  try {
    host = await startFixtureServer({ home: path.join(outDir, 'host') });
    report.host.origin = host.origin;
    report.host.port = host.port;
    report.browser.path = findEdge();
    page = await startEdge({ workDir: outDir });
    await page.navigate(host.url);
    await page.waitFor('!!window.__dshTeam && !!window.__dshTeam.client', '团队插件挂载', { timeoutMs: 60000 });
    if (!await settleShell(page)) throw Error('宿主首启遮罩无法关闭（inert），浏览器无法执行真实交互');
    const ctx = createPageActions({ page, origin: host.origin });
    for (const check of selected) {
      const started = Date.now();
      if (check.na) {
        report.checks.push({ id: check.id, section: check.section, title: check.title, status: 'not-applicable',
          reason: check.na, durationMs: 0 });
        console.log('[N/A ] ' + check.id + ' ' + check.title);
        continue;
      }
      if (Date.now() > deadline) throw Error('整轮超时：' + RUN_TIMEOUT_MS + 'ms');
      try {
        const outcome = await withTimeout(check.run(ctx), CHECK_TIMEOUT_MS, check.id);
        report.checks.push({ id: check.id, section: check.section, title: check.title,
          status: outcome.pass ? 'pass' : 'fail', detail: outcome.detail, note: outcome.note,
          measured: outcome.measured, durationMs: Date.now() - started });
        console.log('[' + (outcome.pass ? 'PASS' : 'FAIL') + '] ' + check.id + ' ' + check.title + ' — ' + outcome.detail);
      } catch (error) {
        report.checks.push({ id: check.id, section: check.section, title: check.title, status: 'fail',
          detail: String(error?.message ?? error), durationMs: Date.now() - started });
        console.log('[FAIL] ' + check.id + ' ' + check.title + ' — ' + String(error?.message ?? error));
      }
    }
    // Artifacts last, on a clean, known page: default fixture, 现在 page, technical details closed.
    await page.setViewport(1440, 900);
    await ctx.openTeam({ fixture: 'default' });
    await ctx.openPage('now');
    await ctx.setDetails(false);
    const files = await captureViewports(page, { outDir, prefix: 'team' });
    const listed = artifactsReport(outDir, files);
    report.artifacts.screenshots = listed.filter(item => item.path.endsWith('.png'));
    report.artifacts.dom = listed.filter(item => !item.path.endsWith('.png'));
    report.baselines = compareBaselines(report.artifacts.screenshots.map(item => path.join(repoRoot, item.path)),
      { update: argv.includes('--update-baselines') });
    report.consoleErrors = [...page.errors];
  } catch (error) {
    report.error = String(error?.message ?? error);
    console.log('[FAIL] 运行失败：' + report.error);
  } finally {
    cleanup();
    report.finishedAt = new Date().toISOString();
    report.durationMs = Date.now() - startedAt.getTime();
    const counts = report.checks.reduce((acc, check) => {
      acc[check.status] = (acc[check.status] ?? 0) + 1;
      return acc;
    }, {});
    report.summary = { ...report.summary, passed: counts.pass ?? 0, failed: counts.fail ?? 0,
      notApplicable: counts['not-applicable'] ?? 0, executed: report.checks.length - (counts['not-applicable'] ?? 0) };
    const shots = report.artifacts.screenshots;
    const shotsOk = shots.length === 2 && shots.every(item => item.exists && item.bytes > 0);
    const baselines = report.baselines ?? [];
    const updating = argv.includes('--update-baselines');
    // A missing or drifted baseline is a failure, never an exemption: the registered-state pixels are part of the gate.
    const baselineOk = updating || (baselines.length === 2 && baselines.every(entry => entry.status === 'match'));
    const gateOk = report.summary.failed === 0 && report.summary.passed >= MIN_PASSED && shotsOk && baselineOk
      && report.consoleErrors.length === 0 && !report.error;
    report.verdict = gateOk ? 'pass' : 'fail';
    report.gate = { failedZero: report.summary.failed === 0, minPassed: report.summary.passed >= MIN_PASSED,
      screenshots: shotsOk, baselines: baselineOk, consoleClean: report.consoleErrors.length === 0,
      noRunError: !report.error };
    const file = path.join(outDir, 'report.json');
    fs.writeFileSync(file, JSON.stringify(report, null, 2));
    console.log('---');
    console.log('清单：共 ' + report.summary.total + ' 条，pass=' + report.summary.passed + ' fail=' + report.summary.failed
      + ' n/a=' + report.summary.notApplicable + '（门槛 pass>=' + MIN_PASSED + '）');
    console.log('截图：' + shots.map(item => item.path + ' (' + item.bytes + 'B)').join('、'));
    console.log('像素基线：' + (baselines.length ? baselines.map(entry => entry.name + '=' + entry.status).join('、')
      : '未采集（判 fail）'));
    console.log('浏览器 console 错误：' + report.consoleErrors.length);
    console.log('verdict: ' + report.verdict + (report.error ? ' — ' + report.error : ''));
    console.log('report: ' + path.relative(repoRoot, file).replaceAll('\\', '/'));
    process.exitCode = gateOk ? 0 : 1;
  }
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  try {
    await main(process.argv.slice(2));
  } catch (error) {
    // Entry-point refusals and startup failures must read as one line, not as a stack trace.
    console.error('[acceptance] ' + (error?.message ?? error));
    process.exitCode = error?.code === 'UNSAFE_ENTRYPOINT' ? 2 : 1;
  }
  await delay(50);
}
