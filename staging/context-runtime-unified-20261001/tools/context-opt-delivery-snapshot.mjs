import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { readFile, realpath, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { rpc } from './usage-runtime-rpc.mjs'

const base = 'D:/dsh-test'
const output = `${base}/docs/context-opt-20261001/delivery-manifest.json`
const require = createRequire(`${base}/app/node_modules/@deepseek-ai/dsh/package.json`)
const yaml = require('yaml')
const parse = text => yaml.parse(text, { customTags: [{ tag: 'tag:yaml.org,2002:js', resolve: value => value }] })
const hash = bytes => createHash('sha256').update(bytes).digest('hex')
const modules = ['request-message-projection.mjs', 'ptc-sdk-retention.mjs', 'observation-pack-v2.mjs',
  'request-usage-ledger.mjs', 'team-tools-v2-r10.mjs', 'team-worktree.mjs']
const added = new Set(['request-message-projection', 'ptc-sdk-retention'])
const profiles = []
for (const profile of ['web', 'headless', 'desktop', 'teamtest']) {
  const directory = `${base}/home/profiles/${profile}`
  const patchPath = `${directory}/cordis.patch.yml`
  const patchBytes = await readFile(patchPath)
  const current = parse(patchBytes.toString())
  const previous = parse(await readFile(`${base.replace('dsh-test', 'dsh-backups')}/context-opt-20261001/${profile}-cordis.patch.before-context-opt.yml`, 'utf8'))
  const mounts = current.flatMap(row => row.insert ?? [])
  assert(!mounts.some(row => row.id === 'context-opt-runtime-probe-once'))
  for (const id of [...added, 'request-usage-ledger', 'observation-pack', 'tool-agent-team-v2']) {
    assert.equal(mounts.filter(row => row.id === id).length, 1, `${profile}:${id} mount count`)
  }
  const sdk = mounts.find(row => row.id === 'ptc-sdk-retention')
  assert.equal(sdk.config.mode, 'apply')
  assert.equal(sdk.config.policy, 'latest')
  assert.equal(mounts.find(row => row.id === 'observation-pack').name, './plugins/observation-pack-v2.mjs')
  assert.equal(mounts.find(row => row.id === 'tool-agent-team-v2').name, './plugins/team-tools-v2-r10.mjs')
  if (profile === 'teamtest') {
    for (const row of previous.flatMap(row => row.insert ?? [])) {
      if (row.id === 'tool-agent-team-v2') row.name = './plugins/team-tools-v2-r10.mjs'
      if (row.id === 'observation-pack') {
        row.name = './plugins/observation-pack-v2.mjs'
        row.config = { maxInlineBytes: 10240, fullSends: 2, previewBytes: 1024, evidenceChars: 1500, spillDir: 'D:\\dsh-test\\home\\evidence-archive' }
      }
    }
  }
  const withoutAdded = current.map(row => row.insert ? { ...row, insert: row.insert.filter(item => !added.has(item.id)) } : row)
    .filter(row => !row.insert || row.insert.length)
  assert.deepEqual(withoutAdded, previous, `${profile}: unrelated configuration changed`)
  const sources = []
  for (const module of modules) {
    const path = `${directory}/plugins/${module}`
    const bytes = await readFile(path)
    sources.push({ module, path, realPath: await realpath(path), sha256: hash(bytes) })
  }
  profiles.push({ profile, realDirectory: await realpath(directory), patchPath, patchSha256: hash(patchBytes),
    relevantMounts: mounts.filter(row => added.has(row.id) || ['request-usage-ledger', 'observation-pack', 'tool-agent-team-v2'].includes(row.id)), sources })
}
for (const module of modules) {
  assert.equal(new Set(profiles.map(row => row.sources.find(source => source.module === module).sha256)).size, 1, `${module}: parity mismatch`)
}
const syntaxPaths = [...new Set(profiles.flatMap(row => row.sources.map(source => source.realPath))),
  `${base}/tools/context-opt-runtime-probe.mjs`, `${base}/usage-tests/ptc-sdk-retention-real.test.mjs`]
for (const path of syntaxPaths) execFileSync(process.execPath, ['--check', path], { windowsHide: true, stdio: 'pipe', timeout: 30000 })
const canaryPath = `${base}/docs/context-opt-20261001/runtime-canary.json`
const canaryBytes = await readFile(canaryPath)
const canary = JSON.parse(canaryBytes)
assert.equal(canary.status, 'passed')
assert.equal(canary.environment, 'injected-dsh-runtime')
assert.equal(canary.externalHttpRequests, 0)
assert.equal(canary.mockProviderUnregistered, true)
assert.equal(canary.usageLedger.verified, true)
assert.equal(canary.mockAdapterDispatches, 3)
assert.equal(canary.bridge.moduleHash, profiles[0].sources.find(row => row.module === 'request-message-projection.mjs').sha256)
const liveProcess = JSON.parse(execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
  `$p = Get-Process -Id ${canary.pid}; [pscustomobject]@{Id=$p.Id;StartTime=$p.StartTime.ToString('o')} | ConvertTo-Json -Compress`],
{ windowsHide: true, encoding: 'utf8', timeout: 30000 }))
assert.equal(liveProcess.Id, 16440)
// Win32 creation time and Get-Process differ in their sub-millisecond rounding.
assert.equal(Date.parse(liveProcess.StartTime), Date.parse('2026-09-30T16:37:18.1485790+08:00'))
const namespaces = await rpc('settings/describe')
const settings = namespaces.namespaces ?? namespaces
const reducer = settings.find(row => row.ns === 'evidence-reducer')
const provider = settings.find(row => row.ns === 'llm-pi-ai')?.value?.providers?.opencodego
const artifacts = []
for (const relative of ['docs/context-opt-20261001/README.md', 'docs/context-opt-20261001/sdk-compatibility-manifest.json',
  'docs/context-opt-20261001/runtime-canary.json', 'docs/context-opt-20261001/bridge-tests.txt',
  'docs/context-opt-20261001/dsh-root-notice.md', 'docs/context-opt-20261001/dsh-root-notice-receipt.json',
  'docs/context-opt-20261001/focused-tests-correct-resolver.txt', 'docs/context-opt-20261001/regression.txt',
  'workspaces/context-sdk-01/report.json', 'workspaces/context-sdk-01/calls.jsonl',
  'workspaces/context-sdk-01/post-repair-report.json', 'workspaces/context-sdk-01/post-repair-calls.jsonl',
  'workspaces/context-sdk-01/combined-post-repair-report.json',
  'workspaces/usage-lab-20261001/obs-line-01/report.json', 'workspaces/usage-lab-20261001/obs-line-01/calls.jsonl',
  'workspaces/usage-lab-20261001/obs-line-01/source-update.json',
  'usage-tests/request-message-projection.test.mjs', 'usage-tests/ptc-sdk-retention.test.mjs',
  'usage-tests/ptc-sdk-retention-real.test.mjs', 'usage-tests/observation-pack-lineage.test.mjs',
  'usage-tests/request-usage-ledger.test.mjs', 'usage-tests/team-milestone-surface-dedup.test.mjs',
  'phase7-tests/delivery-process-windows-hide.test.mjs', 'phase10-tests/observation-pack-v2.test.mjs',
  'tools/context-opt-runtime-probe.mjs', 'tools/context-opt-delivery-snapshot.mjs', 'tools/context-opt-root-notice.mjs']) {
  const path = `${base}/${relative}`
  const bytes = await readFile(path)
  artifacts.push({ path, bytes: bytes.length, sha256: hash(bytes) })
}
const report = { version: 1, at: new Date().toISOString(), profiles, artifacts,
  verification: { profileParity: true, syntaxPassed: syntaxPaths.length, unrelatedProfileConfigPreserved: true,
    focused: { tests: 56, passed: 56, note: '11 bridge tests without resolver; 45 remaining with resolver; latest runner additionally 2/2' },
    fullRegression: { tests: 562, passed: 559, failed: 2, skipped: 1, green: false,
      residual: ['B96 isolated DSH_HOME assertion', 'legacy standing GROUP LEAD identity assertion', 'health script prints 3 FAIL but exits 0'] },
    realSDKPairs: 2, retainedHTTP403: true, failedUsageUnknown: true, realOPCalls: 4,
    windowAcceptance: { userConfirmedActualTeamUseWithoutPopup: true, independentVisualObservation: false,
      furtherWindowChecksStoppedAtUserRequest: true } },
  runtime: { liveProcess, canaryPath, canarySha256: hash(canaryBytes), bridgeHash: canary.bridge.moduleHash,
    sdkCopies: canary.requests.map(row => row.after.sdkCopies), sdkApplied: true, opAppliedOnThirdSend: true,
    actualUsageLedgerObservedProjection: true, mockProviderUnregistered: true, externalCanaryHttpRequests: 0,
    scope: 'existing DSH process wiring; mock adapter, not model task quality or production billing' },
  settings: { reducer: { revision: reducer?.revision, enabled: reducer?.value?.enabled,
    routeMode: reducer?.value?.routeMode, remoteAllowed: reducer?.value?.remoteAllowed, localProviders: reducer?.value?.localProviders },
    opencodego: { api: provider?.api ?? null, baseURL: provider?.baseURL ?? null } },
  boundaries: { noDshRestart: true, noActiveTeamCancellation: true, noOriginalJournalRewrite: true,
    noDataCleanup: true, noReducerRouteChange: true, noProtocolSwitch: true, noGlobalThinkingChange: true },
  residualRisks: ['SDK certificate applies only to five known versions', 'Small fixtures do not establish all-task quality',
    'Raw token reductions do not establish money saved; cache heat and prices differ',
    'Window behavior accepted by user; not independently observed here'] }
await writeFile(output, JSON.stringify(report, null, 2) + '\n')
console.log(JSON.stringify({ output, sha256: hash(await readFile(output)), parity: true, syntaxPassed: syntaxPaths.length,
  runtime: report.runtime, settings: report.settings }))
