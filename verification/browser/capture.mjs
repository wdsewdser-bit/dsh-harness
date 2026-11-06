// M6 WP-6: two viewports (1440x900, 480x900) of the Team page plus the DOM behind them, through headless Edge.
// The PNG is the pixel evidence; the DOM dump is what the acceptance checks read instead of re-guessing the page.
//
// Standalone: node verification/browser/capture.mjs [--fixture default] [--tab now] [--out DIR]
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertSafeEntry } from './lib/guard.mjs';
import { startEdge } from './lib/edge.mjs';
import { startFixtureServer, repoRoot } from './serve.fixture.mjs';
import { settleShell } from './lib/page-actions.mjs';
import { delay } from './lib/process.mjs';

export const VIEWPORTS = Object.freeze([
  Object.freeze({ name: '1440x900', width: 1440, height: 900 }),
  Object.freeze({ name: '480x900', width: 480, height: 900 }),
]);

/** Normalized page HTML: React render ids must not make a diff read as a layout change. */
export const normalizeHtml = html => html.replace(/:r[0-9a-z]+:/g, ':rX:').replace(/«r[0-9a-z]+»/g, '«rX»');

/** Runs inside the page; kept as a real function so the extractor is readable and lintable here. */
function domSnapshot() {
  const root = document.querySelector('.tm-page');
  const text = el => (el ? el.innerText : '');
  const attr = (el, name) => (el ? el.getAttribute(name) : null);
  const tabs = [...document.querySelectorAll('[data-tab]')];
  const rows = [...document.querySelectorAll('[data-page] [data-member]')];
  const records = [...document.querySelectorAll('[data-record]')];
  const escalations = [...document.querySelectorAll('[data-escalation]')];
  return {
    url: location.href,
    title: document.title,
    viewport: { width: innerWidth, height: innerHeight },
    mode: attr(root, 'data-mode'),
    page: attr(document.querySelector('[data-page]'), 'data-page'),
    header: {
      team: text(document.querySelector('.tm-v3-team')),
      tabs: tabs.map(t => ({ key: attr(t, 'data-tab'), text: text(t), selected: t.getAttribute('aria-selected') })),
      badges: [...document.querySelectorAll('.tm-v3-top [data-readonly], .tm-v3-top [data-fresh]')]
        .map(b => ({ kind: attr(b, 'data-readonly') ?? attr(b, 'data-fresh'), text: text(b) })),
    },
    counts: { members: rows.length, records: records.length, escalations: escalations.length,
      buttons: document.querySelectorAll('.tm-page button').length, writes: document.querySelectorAll('.tm-page [data-team-write]').length },
    statuses: [...document.querySelectorAll('[data-status]')].map(s => ({ key: attr(s, 'data-status'), text: text(s) })),
    text: text(root || document.body),
  };
}
export const DOM_EXTRACT = '(' + domSnapshot.toString() + ')()';

export async function extractDom(page) {
  const data = await page.evaluate(DOM_EXTRACT);
  const html = normalizeHtml(await page.evaluate('document.documentElement.outerHTML'));
  return { ...data, html };
}

/**
 * Capture both viewports. Returns the written files; the caller asserts they exist — an empty capture directory is a
 * failed run, not an empty success.
 */
export async function captureViewports(page, { outDir, prefix = 'team' } = {}) {
  fs.mkdirSync(outDir, { recursive: true });
  const files = [];
  for (const viewport of VIEWPORTS) {
    await page.setViewport(viewport.width, viewport.height);
    await delay(250);
    const png = await page.screenshot();
    const image = path.join(outDir, prefix + '-' + viewport.name + '.png');
    fs.writeFileSync(image, png);
    files.push(image);
    const dom = await extractDom(page);
    const jsonFile = path.join(outDir, prefix + '-' + viewport.name + '.dom.json');
    fs.writeFileSync(jsonFile, JSON.stringify({ ...dom, html: undefined }, null, 2));
    fs.writeFileSync(path.join(outDir, prefix + '-' + viewport.name + '.dom.html'), dom.html);
    files.push(jsonFile);
  }
  return files;
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  try { assertSafeEntry(); } catch (error) { console.error('[capture] ' + error.message); process.exit(2); }
  const argv = process.argv.slice(2);
  const value = flag => { const index = argv.indexOf(flag); return index >= 0 ? argv[index + 1] : null; };
  const fixture = value('--fixture') ?? 'default';
  const tab = value('--tab') ?? 'now';
  const outDir = path.resolve(value('--out') ?? path.join(repoRoot, 'runs/m6-browser/capture-' + Date.now()));
  const home = path.join(outDir, '.home');
  let host = null, page = null;
  const shutdown = () => { try { page?.close(); } catch { /* already closed */ } try { host?.stop(); } catch {} };
  process.on('SIGINT', () => { shutdown(); process.exit(130); });
  process.on('exit', shutdown);
  try {
    host = await startFixtureServer({ home });
    page = await startEdge({ workDir: outDir });
    await page.navigate(host.url);
    await page.waitFor('!!window.__dshTeam?.client', 'Team 插件挂载', { timeoutMs: 60000 });
    if (!await settleShell(page)) throw Error('宿主首启遮罩无法关闭（inert）');
    await page.navigate(host.origin + '/?teamFixture=' + encodeURIComponent(fixture));
    await page.waitFor('!!window.__dshTeam.client.getSnapshot().data', '投影快照', { timeoutMs: 45000 });
    await page.evaluate('window.__dshTeam.nav.showTeam()');
    await page.waitFor('!!document.querySelector(".tm-page")', 'Team 页面', { timeoutMs: 30000 });
    if (tab !== 'now') {
      await page.evaluate('document.querySelector(' + JSON.stringify('[data-tab="' + tab + '"]') + ')?.click()');
      await page.waitFor('!!document.querySelector(' + JSON.stringify('[data-page="' + tab + '"]') + ')', tab + ' 子页');
    }
    const files = await captureViewports(page, { outDir });
    console.log(JSON.stringify({ outDir, fixture, tab, files, consoleErrors: page.errors }, null, 2));
  } finally {
    shutdown();
  }
}
