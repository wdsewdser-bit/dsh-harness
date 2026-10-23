import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { resolve, join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
const stage = fileURLToPath(new URL('..', import.meta.url))
const output = resolve(stage, '../../output/agent-team-complete-20261021/capabilities')
mkdirSync(output, { recursive: true })
const files = ['team-v16-capability-common.mjs', 'team-v16-tool-references.mjs', 'team-v16-sdk-catalog.mjs', 'team-v16-context-episodes.mjs']
  .map(name => join(stage, 'home/profiles/web/plugins', name))
files.push(join(stage, 'native-tests/v16-capabilities-fixture.mjs'), join(stage, 'native-tests/v16-capabilities.test.mjs'), fileURLToPath(import.meta.url))
const sha = bytes => createHash('sha256').update(bytes).digest('hex')
const commands = []
function run(args, logName) {
  const result = spawnSync(process.execPath, args, { cwd: stage, encoding: 'utf8', windowsHide: true, timeout: 45000 })
  const log = (result.stdout ?? '') + (result.stderr ?? '')
  const logPath = join(output, logName)
  writeFileSync(logPath, log)
  const evidence = { command: [process.execPath, ...args], cwd: stage, exitCode: result.status, signal: result.signal, error: result.error?.message ?? null,
    logPath, logSha256: sha(readFileSync(logPath)) }
  commands.push(evidence)
  return { evidence, log }
}
for (let i = 0; i < files.length; i++) run(['--check', files[i]], 'syntax-' + i + '.log')
const tests = run(['--test', '--test-reporter=tap', join(stage, 'native-tests/v16-capabilities.test.mjs')], 'native-tests.tap.log')
const count = key => Number(new RegExp('^# ' + key + ' (\\d+)$', 'm').exec(tests.log)?.[1] ?? 0)
const summary = { kind: 'v16-capabilities-validation-v1', at: new Date().toISOString(), scope: 'staging-new-modules-only; native-Cordis-ToolRuntime-and-window-retention; no-real-provider',
  counts: { tests: count('tests'), passed: count('pass'), failed: count('fail'), skipped: count('skipped') },
  passed: commands.every(row => row.exitCode === 0) && count('tests') === 7 && count('fail') === 0,
  changedPaths: files, files: files.map(path => ({ path, sha256: sha(readFileSync(path)) })), commands,
  integration: { toolReferences: 'installToolReferences(ctx, { resolveActor, authorizeShare? }) or apply(ctx, config)',
    catalog: 'installSdkCatalog(ctx, { isolated: true, projectCore: true, coreNames? }) or apply(ctx, config)',
    episodes: 'createContextEpisodes(ctx, { collector: verifiedCollector, resolveActor }); server calls collect(agent); apply exposes read tools' },
  limitations: ['Not mounted into runtime/manifests; root integration pending.', 'Actor resolver must read current trusted task/plan/role/workspace authority; absent resolver denies.',
    'Native generic pre/guard/around/post/result and cancellation tested; existing v12 lease/writeguard and interactive approval integration not mounted in this focused test.',
    'Code references are single-start: reuse after launch fails TOOL_REF_CODE_ALREADY_STARTED; create a new reference for an intentional new execution.',
    'References and episode indices are bounded in-memory services; restart discards these indices, while original collector retention remains authoritative.',
    'No arbitrary filesystem path import, model-authored completion, external service, real provider, or full repository regression.'] }
writeFileSync(join(output, 'validation-summary.json'), JSON.stringify(summary, null, 2))
console.log(JSON.stringify({ passed: summary.passed, counts: summary.counts, summary: join(output, 'validation-summary.json') }))
if (!summary.passed) process.exitCode = 1
