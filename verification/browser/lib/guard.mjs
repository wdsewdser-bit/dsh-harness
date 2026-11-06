// M6 WP-6 (22 §WP-6, 22 §5-4): the single place that refuses an entry point able to reach a real provider.
// Every entry (serve.fixture.mjs / capture.mjs / acceptance.mjs) calls assertSafeEntry before doing any work, so the
// "--authorize-provider" flag and the metered <gateway-port> port fail loudly instead of being silently ignored by an option
// parser that does not know them.
export const FORBIDDEN_PORT = Number(process.env.DSH_METERED_PROVIDER_PORT ?? 0);
export const FORBIDDEN_FLAG = '--authorize-provider';

const RULES = [
  { why: FORBIDDEN_FLAG + '（会授权真实 provider，产生计费）', test: value => value.includes(FORBIDDEN_FLAG) },
  { why: FORBIDDEN_PORT + ' 端口（真实 provider 入口）',
    test: value => FORBIDDEN_PORT > 0 && String(value).split(/[^0-9]+/).includes(String(FORBIDDEN_PORT)) },
];

export class UnsafeEntryPoint extends Error {
  constructor(message) {
    super('UNSAFE_ENTRYPOINT: ' + message);
    this.name = 'UnsafeEntryPoint';
    this.code = 'UNSAFE_ENTRYPOINT';
  }
}

function assertValue(value, source) {
  for (const rule of RULES) if (rule.test(value)) throw new UnsafeEntryPoint(rule.why + '（出现在 ' + source + '）');
}
/**
 * Refuse the two entry points the project forbids for browser work. Arguments are checked verbatim; environment
 * variables only where a port or a provider switch could plausibly be smuggled in (a random <gateway-port> inside an unrelated
 * path or pid must not fail the run).
 */
export function assertSafeEntry(argv = process.argv.slice(2), env = process.env) {
  for (const arg of argv) assertValue(String(arg), '命令行参数');
  for (const [key, value] of Object.entries(env)) {
    if (typeof value !== 'string' || !value) continue;
    if (!/(PORT|PROVIDER|AUTHORIZE|DSH_BROWSER|NPM_CONFIG)/i.test(key)) continue;
    assertValue(value, '环境变量 ' + key);
  }
}

/** Ports the harness may bind: never the metered one, never a caller-named one. */
export function assertAllowedPort(port, source = '端口') {
  const number = Number(port);
  if (!Number.isSafeInteger(number) || number <= 0 || number > 65535) throw new UnsafeEntryPoint(source + ' 不合法：' + port);
  if (number === FORBIDDEN_PORT) throw new UnsafeEntryPoint(source + ' 是真实 provider 入口 ' + FORBIDDEN_PORT);
  return number;
}
