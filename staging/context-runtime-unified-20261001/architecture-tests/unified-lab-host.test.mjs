import test from 'node:test'
import assert from 'node:assert/strict'
import { remap, assertIsolated, assertGoalTarget, isolatedProfilePatch, labHome } from '../tools/prepare-unified-lab-host.mjs'
import * as lab from '../tools/prepare-unified-lab-host.mjs'
import { pathToFileURL } from 'node:url'
import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'

test('isolated host maps every native participant to its exact physical staged alias', () => {
  assert.equal(typeof lab.canonicalNativeTarget, 'function')
  for (const name of ['cordis', 'cordis-plugin-loader', 'dsh-system-prompt', 'dsh-scope', 'dsh-tool-goal']) {
    const target = new URL('../app/node_modules/@deepseek-ai/' + name + '-v15/lib/index.js', import.meta.url).href
    assert.equal(lab.canonicalNativeTarget('@deepseek-ai/' + name), target)
    lab.assertNativeTarget('@deepseek-ai/' + name, target)
    assert.throws(() => lab.assertNativeTarget('@deepseek-ai/' + name,
      new URL('../app/node_modules/@deepseek-ai/' + name + '/lib/index.js', import.meta.url).href), /FOREIGN_NATIVE_IMPLEMENTATION/)
  }
  assert.equal(lab.canonicalNativeTarget('@deepseek-ai/dsh-session'), undefined)
  assert.equal(lab.canonicalNativeTarget('node:fs'), undefined)
})
test('changed native files must physically remain in staging, not production junctions', () => {
  const workspace = 'D:/dsh-test/staging/isolated'
  const staged = workspace + '/app/lib/client.js'
  const locate = value => value
  lab.assertNativeFileIsolation([{path: staged}], workspace, locate)
  for (const target of ['D:/dsh-test/app/lib/client.js', workspace + '-other/app/lib/client.js', workspace]) {
    assert.throws(() => lab.assertNativeFileIsolation([{path: staged}], workspace,
      value => value === staged ? target : value), /PRODUCTION_SHARED_NATIVE_FILE/)
  }
  lab.assertNativeFileIsolation(JSON.parse(readFileSync(new URL('../native-change-manifest.json', import.meta.url), 'utf8')))
})

test('only isolated Team runtime enables server hypothesis intent; production input stays unchanged', () => {
  const source = [{ insert: [{ id: 'team-v12-runtime', name: './plugins/team-v12-runtime.mjs', config: { profile: 'headless-test' } }] }]
  const patch = isolatedProfilePatch(source)
  assert.equal(source[0].insert[0].config.hypothesis, undefined)
  assert.equal(patch[1].insert[0].config.hypothesis.enabled, true)
  assert.equal(source[0].insert[0].config.activeIdentity, undefined)
  assert.equal(patch[1].insert[0].config.activeIdentity.enabled, true)
  assert.deepEqual(patch[1].insert[0].config.activeIdentity.allowedRoots, [join(labHome, 'team-roles')])
  assert.equal(patch[1].insert[0].config.windowHostParticipation, true)
  assertIsolated(patch)
})

test('isolated profile mounts the actual economics observer without enabling window actions', () => {
  const input = [{ id: 'window-manager', config: { enabled: true } }]
  const patch = isolatedProfilePatch(input)
  assert.equal(input[0].config.enabled, true, 'source configuration is not mutated')
  const entry = patch[0].insert[0]
  assert.equal(entry.id, 'unified-economics-shadow')
  assert.equal(entry.name, new URL('../home/profiles/web/plugins/team-v15-window-economics-runtime.mjs', import.meta.url).href)
  assert.deepEqual(entry.config, { maxBufferRecords: 4096 })
  assert.equal(patch[1].disabled, true)
  assert.equal(patch[1].config.enabled, false)
  assertIsolated(patch)
})
test('recursive state remapping and feature isolation reject production writes', () => {
  const x = remap([{ id: 'evidence-reducer', config: { enabled: true, settingsFile: 'D:/dsh-test/home/evidence-reducer.json', archiveDir: 'D:/dsh-test/docs/reports' } }, { id: 'context-workspace', config: { mode: 'apply', appliedSessionIds: ['old'] } }])
  assertIsolated(x)
  assert.equal(x[0].disabled, true)
  assert.equal(x[0].config.enabled, false)
  assert.ok(x[0].config.settingsFile.startsWith(labHome.replaceAll('\\', '/')))
  assert.deepEqual(x[1].config.appliedSessionIds, [])
  assert.equal(x[1].config.mode, 'shadow')
  assert.throws(() => assertIsolated({ config: { telemetryDir: 'D:/dsh-test/home/team-control-plane' } }), /PRODUCTION_WRITABLE_PATH/)
})

test('lab copies only the exact Responses route and excludes credential writes and automatic requests', () => {
  const provider = { apiKeyEnv: 'OPENCODEGO_API_KEY', api: 'openai-responses', baseURL: 'http://127.0.0.1:8788/v1',
    sessionHeader: 'x-opencode-session', headers: { 'x-opencode-session': 'fixture' },
    models: [{ id: 'deepseek-v4.1-flash', contextWindow: 1000000, maxTokens: 128000 }, { id: 'foreign' }] }
  const source = [{ id: 'llm-pi-ai', config: { providers: { opencodego: provider, foreign: { apiKey: 'never-copy' } } } }]
  const before = structuredClone(source)
  const patch = lab.isolatedRoutePatch(source)
  assert.deepEqual(source, before)
  assert.deepEqual(Object.keys(patch[0].config.providers), ['opencodego'])
  assert.deepEqual(patch[0].config.providers.opencodego.models.map(model => model.id), ['deepseek-v4.1-flash'])
  assert.equal(patch.find(row => row.id === 'session-title-llm').disabled, true)
  assert.equal(patch.find(row => row.id === 'llm-retry').disabled, true)
  assert.doesNotMatch(JSON.stringify(patch), /never-copy/)
  for (const change of [p => { p.api = 'openai-completions' }, p => { p.baseURL = 'https://foreign/v1' },
    p => { p.apiKey = 'secret' }, p => { p.headers.Authorization = 'secret' }, p => { p.models = [] }]) {
    const changed = structuredClone(source); change(changed[0].config.providers.opencodego)
    assert.throws(() => lab.isolatedRoutePatch(changed), /LAB_ROUTE_/)
  }
  assert.throws(() => lab.isolatedRoutePatch([...source, ...source]), /LAB_ROUTE_SOURCE_REQUIRED/)
})
test('old goal alias and arbitrary readonly manifest paths are rejected', () => {
  assert.throws(() => assertGoalTarget(new URL('../app/node_modules/@deepseek-ai/dsh-tool-goal/lib/index.js', import.meta.url).href), /FOREIGN_GOAL_IMPLEMENTATION/)
  assertGoalTarget(new URL('../app/node_modules/@deepseek-ai/dsh-tool-goal-v15/lib/index.js', import.meta.url).href)
  const rootPatch = [{ id: 'settings', config: { settingsFile: 'D:/dsh-test/home/settings.yaml' } }]
  assert.throws(() => assertIsolated(rootPatch), /PRODUCTION_WRITABLE_PATH/)
  assertIsolated(remap(rootPatch))
  assert.throws(() => assertIsolated({ arbitraryManifestPath: 'D:/dsh-test/home/old.json' }), /PRODUCTION_WRITABLE_PATH/)
  assert.throws(() => assertIsolated({ compatibilityManifestPath: 'D:/dsh-test/docs/foreign.json' }), /PRODUCTION_WRITABLE_PATH/)
  assertIsolated({ credentialsFile: 'D:/dsh-test/home/.credentials.yaml' })
})

test('canonical preload resolves real CJS requires to all five exact native aliases', () => {
  const script = `import { createRequire } from 'node:module';
    import { pathToFileURL } from 'node:url';
    import assert from 'node:assert/strict';
    const require = createRequire(${JSON.stringify(new URL('../app/package.json', import.meta.url).href)});
    const profileRequire = createRequire(${JSON.stringify(new URL('../home/profiles/web/package.json', import.meta.url).href)});
    const esm = await import('@deepseek-ai/dsh-llm');
    const required = await import(pathToFileURL(profileRequire.resolve('@deepseek-ai/dsh-llm')));
    assert.equal(esm.LlmRuntime, required.LlmRuntime, 'profile CJS and canonical ESM must share the actual native brand');
    console.log(JSON.stringify(['cordis','cordis-plugin-loader','dsh-system-prompt','dsh-scope','dsh-tool-goal']
      .map(name => [name,require.resolve('@deepseek-ai/'+name)])));`
  const result = spawnSync(process.execPath, ['--import', new URL('../tools/prepare-unified-lab-host.mjs', import.meta.url).href,
    '--input-type=module', '-e', script], { encoding: 'utf8', windowsHide: true, timeout: 15000,
      env: { ...process.env, DSH_LAB_CANONICAL_MODULES: '1' } })
  assert.equal(result.status, 0, result.stderr)
  for (const [name, path] of JSON.parse(result.stdout)) {
    lab.assertNativeTarget('@deepseek-ai/' + name, pathToFileURL(path).href)
  }
})
test('prepared role files match stage identity manifest and actual goal target evidence', () => {
  const evidence = JSON.parse(readFileSync(labHome + '/preparation-evidence.json', 'utf8'))
  const identity = JSON.parse(readFileSync(new URL('../home/team-roles/identity-version.json', import.meta.url), 'utf8'))
  assert.equal(evidence.roleIdentity.identityVersion, identity.identityVersion)
  for (const file of ['AGENTS.md', 'root.md', 'lead.md', 'member.md', 'verifier.md']) {
    const actual = createHash('sha256').update(readFileSync(labHome + '/team-roles/' + file)).digest('hex')
    assert.equal(actual, identity.files[file].toLowerCase())
    assert.equal(actual, evidence.roleIdentity.hashes[file])
  }
  assertGoalTarget(evidence.loadedGoal.target)
  assert.ok(/^[a-f0-9]{64}$/.test(evidence.loadedGoal.functionHashes.apply))
})
