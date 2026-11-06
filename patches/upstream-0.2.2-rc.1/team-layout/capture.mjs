// Headless Edge capture over CDP: lossless PNG + normalized body DOM for A1 default-profile comparison.
// Usage: node capture.mjs <server-log> <out-dir> [states=main,right,settings] [viewports=1440x900,480x900]
import fs from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
const [, , logFile, outDir, statesArg = 'main,right,settings', vpArg = '1440x900,480x900'] = process.argv;
const url = fs.readFileSync(logFile, 'utf8').match(/http:\/\/127\.0\.0\.1:4039\d\/\?token=\S+/)?.[0];
if (!url) throw Error('no startup url in log');
fs.mkdirSync(outDir, { recursive: true });
const CDP = 40398;
const profileDir = '<path-to-dsh-v2>/patches/upstream-0.2.2-rc.1/team-layout/edge-' + Date.now();
const edge = spawn('C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', ['--headless=new', '--remote-debugging-port=' + CDP,
  '--user-data-dir=' + profileDir, '--no-first-run', '--disable-extensions', '--force-device-scale-factor=1', '--hide-scrollbars',
  '--disable-gpu', '--font-render-hinting=none', '--lang=en-US', 'about:blank'], { stdio: 'ignore' });
const wait = ms => new Promise(r => setTimeout(r, ms));
try {
let list;
for (let i = 0; i < 60 && !list; i++) { await wait(250); try { list = await (await fetch(`http://127.0.0.1:${CDP}/json/list`)).json(); } catch {} }
const page = list.find(t => t.type === 'page');
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise(r => ws.addEventListener('open', r));
let seq = 0; const pending = new Map(); const listeners = [];
ws.addEventListener('message', ev => { const m = JSON.parse(ev.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } else listeners.forEach(f => f(m)); });
const send = (method, params = {}) => new Promise((res, rej) => { const id = ++seq; pending.set(id, m => m.error ? rej(Error(method + ': ' + m.error.message)) : res(m.result)); ws.send(JSON.stringify({ id, method, params })); });
const evaluate = async expr => (await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true })).result.value;
const loaded = () => new Promise(r => { const f = m => { if (m.method === 'Page.loadEventFired') { listeners.splice(listeners.indexOf(f), 1); r(); } }; listeners.push(f); });
await send('Page.enable'); await send('Runtime.enable');
const FREEZE = `(() => { if (!document.getElementById('cdp-freeze')) { const s = document.createElement('style'); s.id = 'cdp-freeze';
  s.textContent = '*,*::before,*::after{caret-color:transparent!important;animation:none!important;transition:none!important}'; document.head.appendChild(s); } })()`;
const settle = async () => { await wait(2500); await evaluate(FREEZE); await evaluate(`[...document.querySelectorAll('button')].find(b => b.textContent.trim() === 'Continue')?.click()`); await wait(300); await evaluate(`document.querySelector('[role=dialog][aria-label="Get started"] [aria-label="Close"]')?.click()`); await wait(800); };
const clickLabel = async l => { const found = await evaluate(`(() => { const e=document.querySelector('[aria-label="${l}"]'); if(!e)return false; e.click();return true; })()`); if(!found)throw Error('Missing control '+l+'; available: '+JSON.stringify(await evaluate(`[...document.querySelectorAll('button[aria-label]')].map(e=>e.getAttribute('aria-label'))`))); };
const actions = {
  main: async () => { if(await evaluate(`!!document.querySelector('[aria-label="Collapse right sidebar"]')`)){await clickLabel('Collapse right sidebar');await wait(1200);} },
  right: async () => { if(await evaluate(`!!document.querySelector('[aria-label="Open right sidebar"]')`))await clickLabel('Open right sidebar'); if(!await evaluate(`!!document.querySelector('[aria-label="Collapse right sidebar"]')`))throw Error('Right sidebar did not open'); await wait(1200); },
  settings: async () => { await actions.main();
    // rc.1: below the frame's 768px drawer breakpoint the sidebar is an overlay, and its account menu only renders
    // from the open drawer. Opening it first keeps the same three states on both builds.
    if(await evaluate(`!!document.querySelector('[aria-label="Open sidebar"]')`)){await clickLabel('Open sidebar');await wait(1200);}
    await clickLabel('Account menu'); await wait(500);
    const found = await evaluate(`(() => {const e=[...document.querySelectorAll('[role=menuitem]')].find(e => e.textContent.startsWith('Settings')); if(!e)return false;e.click();return true;})()`); if(!found)throw Error('Settings item missing'); await wait(1500); },
  team: async () => { await evaluate(`[...document.querySelectorAll('button')].find(b => b.getAttribute('aria-label') === 'Team' || b.textContent.trim() === 'Team')?.click()`); await wait(1500); },
};
const normalize = html => html.replace(/:r[0-9a-z]+:/g, ':rX:').replace(/«r[0-9a-z]+»/g, '«rX»');
const result = [];
for (const vp of vpArg.split(',')) {
  const [width, height] = vp.split('x').map(Number);
  await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });
  for (const state of statesArg.split(',')) {
    const done = loaded(); await send('Page.navigate', { url }); await done; await settle();
    await actions[state]();
    await evaluate('document.activeElement?.blur?.()'); await wait(300);
    const png = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
    const name = `${state}-${vp}`;
    fs.writeFileSync(`${outDir}/${name}.png`, Buffer.from(png.data, 'base64'));
    const body = await evaluate(`(() => { const c = document.body.cloneNode(true); return c.outerHTML; })()`);
    fs.writeFileSync(`${outDir}/${name}.html`, normalize(body));
    result.push(name);
  }
}
console.log(JSON.stringify({ outDir, captured: result }));
ws.close(); edge.kill();
await wait(500);
try { fs.rmSync(profileDir, { recursive: true, force: true }); } catch {}
} finally { if (edge.exitCode === null) spawnSync('taskkill', ['/PID', String(edge.pid), '/T', '/F'], {stdio:'ignore'}); }