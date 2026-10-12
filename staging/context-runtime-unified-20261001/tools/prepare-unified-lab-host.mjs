import { createRequire, registerHooks, isBuiltin } from 'node:module'
import { readFileSync, writeFileSync, mkdirSync, existsSync, symlinkSync, realpathSync } from 'node:fs'
import { resolve, join, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
const stage = resolve(fileURLToPath(new URL('..', import.meta.url)))
const nativeAliases = new Set(['cordis', 'cordis-plugin-loader', 'dsh-system-prompt', 'dsh-scope', 'dsh-tool-goal', 'dsh-agent', 'dsh-subagent'])
export function canonicalNativeTarget(specifier) {
  const name = specifier.startsWith('@deepseek-ai/') ? specifier.slice(13) : ''
  return nativeAliases.has(name) ? new URL('../app/node_modules/@deepseek-ai/' + name + '-v15/lib/index.js', import.meta.url).href : undefined
}
export function assertNativeTarget(specifier, url) {
  const target = canonicalNativeTarget(specifier)
  if (!target || target !== url) throw new Error('FOREIGN_NATIVE_IMPLEMENTATION:' + specifier)
}
// Normalize bare imports across CLI, profile junctions and plugin directories.
if (process.env.DSH_LAB_CANONICAL_MODULES === '1') registerHooks({ resolve(specifier, context, nextResolve) {
  if (!isBuiltin(specifier) && !specifier.startsWith('.') && !specifier.startsWith('/') && !/^[a-z]+:/i.test(specifier)) {
    const parent = context.parentURL
    const alias = canonicalNativeTarget(specifier)
    const target = new Set(context.conditions).has('require')
      ? alias ? fileURLToPath(alias) : join(stage, 'app/node_modules', specifier)
      : alias ?? specifier
    const result = nextResolve(target, { ...context, parentURL: new URL('../app/package.json', import.meta.url).href })
    if (canonicalNativeTarget(specifier) || /^@deepseek-ai\/dsh-(tools|session|llm)$/.test(specifier)) {
      (globalThis.labModuleResolutions ??= []).push({ specifier, parent, url: result.url })
    }
    return result
  }
  return nextResolve(specifier, context)
} })
const require = createRequire(new URL('../app/package.json', import.meta.url))
const yaml = require('js-yaml')
const dumpSchema = yaml.DEFAULT_SCHEMA.extend([new yaml.Type('tag:yaml.org,2002:js', { kind: 'scalar', construct: value => value })])
const hash = text => createHash('sha256').update(text).digest('hex')
export const labHome = join(stage, 'lab-host-home')
const normalized = x => x.replaceAll('\\', '/').replace(/^file:\/\//, '').replace(/^\/(D:)/i, '$1')
const readonlyPaths = new Map([
  ['compatibilityManifestPath', 'D:/dsh-test/docs/context-opt-20261001/sdk-compatibility-manifest.json'],
  ['credentialsFile', 'D:/dsh-test/home/.credentials.yaml'],
])
const readonly = (key, value) => readonlyPaths.get(key)?.toLowerCase() === normalized(value).toLowerCase()
export function assertGoalTarget(url) {
  if (url !== new URL('../app/node_modules/@deepseek-ai/dsh-tool-goal-v15/lib/index.js', import.meta.url).href) throw new Error('FOREIGN_GOAL_IMPLEMENTATION')
}
export function assertNativeFileIsolation(entries, workspace = stage, locate = realpathSync) {
  const root = resolve(locate(workspace)).toLowerCase()
  for (const row of entries) {
    const actual = resolve(locate(row.path)).toLowerCase()
    if (!actual.startsWith(root + sep)) {
      throw new Error('PRODUCTION_SHARED_NATIVE_FILE:' + row.path)
    }
  }
}
export function remap(value, key = '') {
  if (Array.isArray(value)) return value.map(x => remap(x, key))
  if (value && typeof value === 'object') {
    const row = Object.fromEntries(Object.entries(value).map(([k, v]) => [k, remap(v, k)]))
    if (typeof row.id === 'string' && /window|instant|reducer/i.test(row.id)) { row.disabled = true; if (row.config) row.config.enabled = false }
    if (row.id === 'context-workspace' && row.config) { row.config.mode = 'shadow'; row.config.appliedSessionIds = [] }
    if (row.id === 'team-v12-runtime') row.config = { ...(row.config ?? {}),
      hypothesis: { ...(row.config?.hypothesis ?? {}), enabled: true },
      activeIdentity: { enabled: true, allowedRoots: [join(labHome, 'team-roles')] },
      windowHostParticipation: true }
    return row
  }
  if (typeof value !== 'string') return value
  if (key === 'name' && value.startsWith('./plugins/')) return pathToFileURL(join(stage, 'home/profiles/web', value)).href
  const path = normalized(value)
  if (readonly(key, value)) return value
  if (/^D:\/dsh-test\/home\/profiles\/web\/plugins/i.test(path)) return path.replace(/^D:\/dsh-test\/home\/profiles\/web\/plugins/i, normalized(join(stage, 'home/profiles/web/plugins')))
  if (/^D:\/dsh-test\/home/i.test(path)) return path.replace(/^D:\/dsh-test\/home/i, normalized(labHome))
  if (/^D:\/dsh-test\/docs/i.test(path)) return path.replace(/^D:\/dsh-test\/docs/i, normalized(join(labHome, 'reports')))
  return value
}
export function assertIsolated(value, key = '') {
  if (Array.isArray(value)) return value.forEach(x => assertIsolated(x, key))
  if (value && typeof value === 'object') return Object.entries(value).forEach(([k, v]) => assertIsolated(v, k))
  if (typeof value === 'string' && !readonly(key, value) && /^D:\/dsh-test\/(home|docs)(?:\/|$)/i.test(normalized(value))) throw new Error('PRODUCTION_WRITABLE_PATH:' + key)
}
export function isolatedProfilePatch(source) {
  if (!Array.isArray(source)) throw new Error('INVALID_PROFILE_PATCH')
  const patch = remap(source)
  patch.unshift({ insert: [{
    id: 'unified-economics-shadow',
    name: pathToFileURL(join(stage, 'home/profiles/web/plugins/team-v15-window-economics-runtime.mjs')).href,
    config: { maxBufferRecords: 4096 },
  }] })
  assertIsolated(patch)
  return patch
}
export function isolatedRoutePatch(source) {
  const matches = []
  const visit = value => {
    if (Array.isArray(value)) return value.forEach(visit)
    if (!value || typeof value !== 'object') return
    if (value.id === 'llm-pi-ai' && value.config?.providers?.opencodego) matches.push(value.config.providers.opencodego)
    for (const child of Object.values(value)) visit(child)
  }
  visit(source)
  if (matches.length !== 1) throw new Error('LAB_ROUTE_SOURCE_REQUIRED')
  const provider = structuredClone(matches[0])
  const keys = ['apiKeyEnv', 'api', 'baseURL', 'sessionHeader', 'headers', 'models']
  if (Object.keys(provider).some(key => !keys.includes(key)) || provider.apiKeyEnv !== 'OPENCODEGO_API_KEY'
    || provider.api !== 'openai-responses' || provider.baseURL !== 'http://127.0.0.1:8788/v1'
    || provider.sessionHeader !== 'x-opencode-session'
    || !provider.headers || Object.keys(provider.headers).some(key => key !== 'x-opencode-session')
    || typeof provider.headers['x-opencode-session'] !== 'string'
    || !Array.isArray(provider.models)) throw new Error('LAB_ROUTE_SOURCE_INVALID')
  provider.models = provider.models.filter(model => model.id === 'deepseek-v4.1-flash')
  if (provider.models.length !== 1) throw new Error('LAB_ROUTE_MODEL_REQUIRED')
  return [{ id: 'llm-pi-ai', config: { providers: { opencodego: provider } } },
    { id: 'agent-default-model', config: { provider: 'opencodego', model: 'deepseek-v4.1-flash' } },
    { id: 'session-title-llm', disabled: true }, { id: 'llm-retry', disabled: true }]
}
export function prepare() {
  assertNativeFileIsolation(JSON.parse(readFileSync(join(stage, 'native-change-manifest.json'), 'utf8')))
  const profile = join(labHome, 'profiles/web')
  mkdirSync(profile, { recursive: true })
  const save = (file, data) => writeFileSync(file, typeof data === 'string' ? data : JSON.stringify(data, null, 2) + '\n')
  const pkg = JSON.parse(readFileSync('D:/dsh-test/home/profiles/web/package.json', 'utf8'))
  pkg.dsh.profile.patchReload = 'startup'
  save(join(profile, 'package.json'), pkg)
  save(join(profile, 'cordis.yml'), '[]\n')
  const patch = isolatedProfilePatch(yaml.load(readFileSync('D:/dsh-test/home/profiles/headless/cordis.patch.yml', 'utf8')))
  const routeSource = yaml.load(readFileSync('D:/dsh-test/home/profiles/web/cordis.patch.yml', 'utf8'), { schema: dumpSchema })
  const routePatch = isolatedRoutePatch(routeSource)
  patch.push(...routePatch)
  assertIsolated(patch)
  save(join(profile, 'cordis.patch.yml'), yaml.dump(patch))
  const rootPatch = remap(yaml.load(readFileSync('D:/dsh-test/home/cordis.patch.yml', 'utf8')))
  assertIsolated(rootPatch)
  save(join(labHome, 'cordis.patch.yml'), yaml.dump(rootPatch))
  const rolesDir = join(labHome, 'team-roles')
  mkdirSync(rolesDir, { recursive: true })
  const identity = JSON.parse(readFileSync(join(stage, 'home/team-roles/identity-version.json'), 'utf8'))
  const roleHashes = {}
  for (const file of ['AGENTS.md', 'root.md', 'lead.md', 'member.md', 'verifier.md']) {
    const contents = readFileSync(join(stage, 'home/team-roles', file))
    const sha256 = hash(contents)
    if (identity.files[file]?.toLowerCase() !== sha256) throw new Error('STAGE_ROLE_IDENTITY_DRIFT:' + file)
    writeFileSync(join(rolesDir, file), contents)
    roleHashes[file] = sha256
  }
  save(join(rolesDir, 'identity-version.json'), identity)
  save(join(labHome, 'write-scopes.json'), { version: 1, scopes: [] })
  save(join(labHome, 'evidence-reducer.json'), { enabled: false })
  const modules = join(profile, 'node_modules')
  if (!existsSync(modules)) symlinkSync(join(stage, 'app/node_modules'), modules, 'junction')
  const cli = join(stage, 'app/node_modules/@deepseek-ai/dsh/lib/bin.js')
  const flags = ['--preserve-symlinks', '--preserve-symlinks-main', '--import', import.meta.url]
  const env = { ...process.env, DSH_HOME: labHome, DSH_LAB_CANONICAL_MODULES: '1' }
  const result = spawnSync(process.execPath, [...flags, cli, '--profile', 'web', '--dump-config'], { cwd: stage, env, encoding: 'utf8', windowsHide: true, timeout: 30000 })
  save(join(labHome, 'dump-config.stderr.log'), result.stderr ?? '')
  if (result.status !== 0) throw new Error('DUMP_CONFIG_FAILED: ' + (result.stderr ?? '').slice(-1000))
  const dumped = yaml.load(result.stdout, { schema: dumpSchema })
  assertIsolated(dumped)
  save(join(labHome, 'dump-config.yaml'), result.stdout)
  const probe = `
    import {createRequire} from 'node:module';
    import {pathToFileURL} from 'node:url';
    import {createHash} from 'node:crypto';
    const r=createRequire(${JSON.stringify(join(stage, 'app/package.json'))});
    const functionHashes=m=>Object.fromEntries(Object.entries(m).filter(([k,v])=>typeof v==='function')
      .map(([k,v])=>[k,createHash('sha256').update(Function.prototype.toString.call(v)).digest('hex')]));
    const out={};
    for(const p of ['dsh-tools','dsh-session','dsh-llm']) {
      const file=r.resolve('@deepseek-ai/'+p), m=await import(pathToFileURL(file));
      out[p]={file,exports:Object.keys(m).filter(k=>/Runtime|Session|agentLoop|markAgentLoop/i.test(k))};
    }
    const goal=await import('@deepseek-ai/dsh-tool-goal');
    const goalImplementation={exports:Object.keys(goal),functionHashes:functionHashes(goal)};
    const nativeImplementations={};
    for(const name of ${JSON.stringify([...nativeAliases])}) {
      const m=await import('@deepseek-ai/'+name);
      nativeImplementations[name]={exports:Object.keys(m),functionHashes:functionHashes(m)};
    }
    await import('@deepseek-ai/dsh-web-app');
    await import(${JSON.stringify(pathToFileURL(join(stage, 'home/profiles/web/plugins/context-workspace.mjs')).href)});
    console.log(JSON.stringify({loaded:out,goalImplementation,nativeImplementations,graph:globalThis.labModuleResolutions}));
  `
  const graph = spawnSync(process.execPath, [...flags, '--input-type=module', '-e', probe], { cwd: stage, env, encoding: 'utf8', windowsHide: true, timeout: 30000 })
  save(join(labHome, 'module-graph.stderr.log'), graph.stderr ?? '')
  if (graph.status !== 0) throw new Error('MODULE_GRAPH_FAILED')
  const graphResult = JSON.parse(graph.stdout.trim().split('\n').at(-1)), loaded = graphResult.loaded
  const goals = graphResult.graph.filter(row => row.specifier === '@deepseek-ai/dsh-tool-goal')
  if (goals.length === 0) throw new Error('LOADED_GOAL_REQUIRED')
  goals.forEach(row => assertGoalTarget(row.url))
  for (const row of graphResult.graph) if (!row.url.startsWith(pathToFileURL(join(stage, 'app/node_modules')).href + '/')) throw new Error('FOREIGN_LOADED_GRAPH')
  const loadedNativeAliases = {}
  for (const name of nativeAliases) {
    const specifier = '@deepseek-ai/' + name
    const resolutions = graphResult.graph.filter(row => row.specifier === specifier)
    if (resolutions.length === 0) throw new Error('NATIVE_PARTICIPANT_NOT_LOADED:' + name)
    resolutions.forEach(row => assertNativeTarget(specifier, row.url))
    loadedNativeAliases[name] = resolutions[0].url
  }
  save(join(labHome, 'module-graph.json'), graphResult)
  for (const fact of Object.values(loaded)) if (!normalized(fact.file).startsWith(normalized(stage + '/app/node_modules/'))) throw new Error('FOREIGN_MODULE_GRAPH')
  const evidence = { prepared: true, started: false, providerRequests: 0, labHome, cli, flags, loaded, dumpSha256: hash(result.stdout), patchSha256: hash(yaml.dump(patch)), readonlyProductionExceptions: [...readonlyPaths.keys()], credentialPolicy: 'No credential file copied; root must supply existing route authentication read-only.', startCommand: `$env:DSH_HOME='${labHome}'; $env:DSH_LAB_CANONICAL_MODULES='1'; & '${process.execPath}' --preserve-symlinks --preserve-symlinks-main --import '${import.meta.url}' '${cli}' --profile web` }
  evidence.roleIdentity = { identityVersion: identity.identityVersion, hashes: roleHashes, manifestSha256: hash(readFileSync(join(rolesDir, 'identity-version.json'))) }
  evidence.loadedGoal = { target: goals[0].url, ...graphResult.goalImplementation }
  evidence.loadedNativeAliases = loadedNativeAliases
  evidence.loadedNativeImplementations = graphResult.nativeImplementations
  evidence.readonlyProductionExceptions = [...readonlyPaths.entries()].map(([key, path]) => ({ key, path }))
  evidence.route = { provider: 'opencodego', model: 'deepseek-v4.1-flash',
    api: routePatch[0].config.providers.opencodego.api, baseURL: routePatch[0].config.providers.opencodego.baseURL,
    configSha256: hash(JSON.stringify(routePatch[0].config.providers.opencodego)),
    credentialPolicy: 'OPENCODEGO_API_KEY must be inherited read-only; never point the writable provider at production credentials.',
    automaticTitles: false, transportRetries: false }
  save(join(labHome, 'preparation-evidence.json'), evidence)
  return evidence
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { const e = prepare(); console.log(JSON.stringify({ prepared: e.prepared, started: e.started, labHome, dumpSha256: e.dumpSha256, loaded: e.loaded })) } catch (error) { console.error(error.message); process.exitCode = 1 }
}
