// M6 WP-6: the browser fixture host. It starts the DSH web host with exactly one extra plugin — the Team UI in
// MOCK mode (no config → createMockSource inside the browser) — and nothing that can reach a provider: no projection
// service port, no provider credentials, no chat turn.
//
// Standalone:  node verification/browser/serve.fixture.mjs [--port N] [--home DIR]
// In-process:  const host = await startFixtureServer({ home });  host.url; await host.stop();
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { assertSafeEntry, assertAllowedPort } from './lib/guard.mjs';
import { freePort, killTree, until } from './lib/process.mjs';
import { buildTarget } from '../../packages/adapter-dsh/build-target.mjs';

export const repoRoot = path.resolve(fileURLToPath(new URL('../..', import.meta.url)));
const LOGIN = /http:\/\/127\.0\.0\.1:\d+\/\?token=[A-Za-z0-9_-]+/;
/** Environment keys that could turn this host into a real provider client: none of them may leak into the fixture. */
const PROVIDER_ENV = /TOKEN|API_KEY|PROXY|DSH_HOST_NODE|DSH_RUNTIME_DIR|SECRET|PASSWORD|CREDENTIAL/i;

export function fixtureEnv(base = process.env, home) {
  const env = { ...base, DSH_HOME: home, DSH_TELEMETRY_DISABLED: '1' };
  for (const key of Object.keys(env)) if (PROVIDER_ENV.test(key)) delete env[key];
  return env;
}

/** The patch names only the browser half; a missing config is what makes it use the mock source. */
export function writeFixturePatch(home) {
  fs.mkdirSync(home, { recursive: true });
  const file = path.join(home, 'team.patch.json');
  const name = pathToFileURL(path.join(repoRoot, 'packages/ui/index.mjs')).href;
  fs.writeFileSync(file, JSON.stringify([{ insert: [{ id: 'client-team', name }] }]));
  return file;
}

/**
 * Start the fixture host and wait for its one-time login URL. The URL carries the native web token; the acceptance
 * script navigates to it once to authenticate, then re-enters the app with ?teamFixture=… .
 */
export async function startFixtureServer({ home, port = null, timeoutMs = 90000 } = {}) {
  assertSafeEntry();
  const chosen = port == null ? await freePort() : assertAllowedPort(port, '夹具端口');
  const root = path.resolve(home);
  const patch = writeFixturePatch(root);
  const logFile = path.join(root, 'web.log');
  fs.writeFileSync(logFile, '');
  const { base } = buildTarget();
  const child = spawn(process.execPath, [base + 'dsh/lib/bin.js', '--profile', 'web', '--patch', patch,
    '--no-open', '--host', '127.0.0.1', '--port', String(chosen)],
  { env: fixtureEnv(process.env, root), cwd: root, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  const output = [];
  let login = null;
  const capture = chunk => {
    const text = chunk.toString();
    output.push(text);
    fs.appendFileSync(logFile, text);
    if (!login) login = text.match(LOGIN)?.[0] ?? null;
  };
  child.stdout.on('data', capture);
  child.stderr.on('data', capture);
  let exitCode = null;
  child.on('exit', code => { exitCode = code; fs.appendFileSync(logFile, '\n[exit ' + code + ']\n'); });
  const failed = () => exitCode !== null;
  try {
    await until(() => login || failed(), '夹具宿主登录地址', { timeoutMs, intervalMs: 150 });
  } catch (error) {
    killTree(child);
    const tail = output.join('').split('\n').slice(-20).join('\n');
    throw Error('夹具宿主启动失败：' + error.message + '；日志 ' + logFile + '\n' + tail);
  }
  if (!login) {
    killTree(child);
    throw Error('夹具宿主提前退出（exit ' + exitCode + '）；日志 ' + logFile);
  }
  const origin = new URL(login).origin;
  const stop = () => { killTree(child); };
  return { url: login, origin, port: chosen, home: root, logFile, child, stop,
    get exitCode() { return exitCode; } };
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  try { assertSafeEntry(); } catch (error) { console.error('[serve.fixture] ' + error.message); process.exit(2); }
  const argv = process.argv.slice(2);
  const value = flag => { const index = argv.indexOf(flag); return index >= 0 ? argv[index + 1] : null; };
  const home = value('--home') ?? path.join(repoRoot, 'runs/m6-browser/serve-' + Date.now());
  const port = value('--port') ? Number(value('--port')) : null;
  const host = await startFixtureServer({ home, port });
  console.log(JSON.stringify({ url: host.url, origin: host.origin, port: host.port, home: host.home }, null, 2));
  const shutdown = () => { host.stop(); process.exit(0); };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  process.on('exit', () => host.stop());
}
