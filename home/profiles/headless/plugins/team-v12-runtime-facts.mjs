/**
 * v12 runtime facts and cross-profile capability inventory.
 *
 * This module is deliberately side-effect free. It can hash and compare files
 * supplied by a caller, but it never registers a plugin, reloads a profile, or
 * writes runtime state. Missing observations stay unknown instead of being
 * promoted to a positive or negative installation claim.
 */

import { createHash } from 'node:crypto'
import { readFileSync, realpathSync, statSync } from 'node:fs'
import { isAbsolute, resolve } from 'node:path'

export const RUNTIME_FACTS_SCHEMA_VERSION = 1
export const CAPABILITY_MATRIX_SCHEMA_VERSION = 1
export const REDACTED_VALUE = '[REDACTED]'
export const RUNTIME_FACT_LAYERS = Object.freeze(['documented', 'disk', 'runtime', 'session'])

const SECRET_KEY_PATTERN = /(?:password|passwd|secret|token|api[_-]?key|authorization|cookie|credential|private[_-]?key|client[_-]?secret|session[_-]?key|bearer)/i
const NON_SECRET_COUNTER_KEY = /^(?:maxTokens|tokenBudget|tokenLimit|tokenUsage|tokenCount|inputTokens|outputTokens|cachedTokens)$/i
const SECRET_VALUE_PATTERN = /(?:Bearer\s+[A-Za-z0-9._~+/=-]+|sk-[A-Za-z0-9_-]{8,}|-----BEGIN [A-Z ]*PRIVATE KEY-----|eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,})/g

const asArray = (value) => Array.isArray(value) ? value : []
const text = (value) => String(value ?? '').trim()
const uniqueText = (values) => [...new Set(asArray(values).map(text).filter(Boolean))]

function stableJson(value) {
  if (value === undefined) return 'null'
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return '[' + value.map(stableJson).join(',') + ']'
  return '{' + Object.keys(value).sort()
    .map((key) => JSON.stringify(key) + ':' + stableJson(value[key]))
    .join(',') + '}'
}

function deepClone(value) {
  if (value === undefined) return undefined
  return structuredClone(value)
}

function digest(value) {
  return createHash('sha256').update(stableJson(value)).digest('hex')
}

function isoTime(value, fallback) {
  if (value === undefined || value === null || value === '') return fallback
  const date = value instanceof Date ? value : new Date(value)
  return Number.isNaN(date.getTime()) ? fallback : date.toISOString()
}

function isSecretKey(key) {
  const normalized = String(key)
  return SECRET_KEY_PATTERN.test(normalized) && !NON_SECRET_COUNTER_KEY.test(normalized)
}

function redactString(value) {
  return String(value).replace(SECRET_VALUE_PATTERN, REDACTED_VALUE)
}

/**
 * Redact secret-shaped keys and values without mutating the input.
 *
 * @param {unknown} input Value to sanitize.
 * @param {{ maxDepth?: number }} [options] Recursion limit.
 * @returns {unknown} Sanitized clone.
 */
export function redactSecrets(input, options = {}) {
  return redactSecretsDetailed(input, options).value
}

/**
 * Redact secrets and return the JSON paths that were changed.
 *
 * @param {unknown} input Value to sanitize.
 * @param {{ maxDepth?: number }} [options] Recursion limit.
 * @returns {{ value: unknown, redactedPaths: string[] }}
 */
export function redactSecretsDetailed(input, options = {}) {
  const maxDepth = Math.max(1, Number(options.maxDepth ?? 24))
  const redactedPaths = []

  const visit = (value, key, path, depth) => {
    if (key !== null && isSecretKey(key)) {
      redactedPaths.push(path)
      return REDACTED_VALUE
    }
    if (depth >= maxDepth) return '[TRUNCATED:MAX_DEPTH]'
    if (typeof value === 'string') {
      const redacted = redactString(value)
      if (redacted !== value) redactedPaths.push(path)
      return redacted
    }
    if (value === null || typeof value !== 'object') return value
    if (Array.isArray(value)) return value.map((item, index) => visit(item, null, path + '[' + index + ']', depth + 1))
    const output = {}
    for (const childKey of Object.keys(value)) {
      output[childKey] = visit(value[childKey], childKey, path + '.' + childKey, depth + 1)
    }
    return output
  }

  return {
    value: visit(input, null, '$', 0),
    redactedPaths: [...new Set(redactedPaths)].sort(),
  }
}

/**
 * Stable SHA-256 fingerprint for any JSON-compatible value.
 *
 * @param {unknown} value Value to fingerprint.
 * @returns {string} Hex digest.
 */
export function fingerprintValue(value) {
  return digest(value)
}

/**
 * Hash a plugin entry file and return its canonical absolute path.
 *
 * @param {string} entryPath Absolute path or path relative to baseDir.
 * @param {{ baseDir?: string, throwOnError?: boolean }} [options] Path options.
 * @returns {{ path: string, sha256: string|null, size: number|null, mtimeMs: number|null, exists: boolean, error?: string }}
 */
export function hashEntry(entryPath, options = {}) {
  const requested = text(entryPath)
  if (!requested) throw new Error('entry path is required')
  const absolute = isAbsolute(requested)
    ? resolve(requested)
    : resolve(text(options.baseDir) || process.cwd(), requested)
  try {
    const real = realpathSync.native ? realpathSync.native(absolute) : realpathSync(absolute)
    const stat = statSync(real)
    if (!stat.isFile()) throw new Error('entry path is not a file')
    const content = readFileSync(real)
    return {
      path: real,
      sha256: createHash('sha256').update(content).digest('hex'),
      size: stat.size,
      mtimeMs: stat.mtimeMs,
      exists: true,
    }
  } catch (error) {
    if (options.throwOnError === true) throw error
    return {
      path: absolute,
      sha256: null,
      size: null,
      mtimeMs: null,
      exists: false,
      error: String(error?.message ?? error),
    }
  }
}

function pluginArray(value) {
  if (Array.isArray(value)) return value
  if (value === null || typeof value !== 'object') return []
  const source = value.plugins && typeof value.plugins === 'object' ? value.plugins : value
  if (Array.isArray(source)) return source
  return Object.entries(source).map(([id, row]) => (
    row !== null && typeof row === 'object' ? { id, ...row } : { id, value: row }
  ))
}

function entryPathOf(spec) {
  const entry = spec?.entry
  return text(
    spec?.entryPath
      ?? spec?.entry_path
      ?? (typeof entry === 'string' ? entry : entry?.path ?? entry?.entry)
      ?? spec?.path
      ?? spec?.options?.entry
      ?? spec?.options?.entryPath
      ?? spec?.options?.path,
  )
}

function entryInfoOf(spec, layer, baseDir) {
  const declaredPath = entryPathOf(spec)
  const providedHash = text(spec?.entryHash ?? spec?.entry_hash ?? spec?.sha256 ?? spec?.entry?.sha256)
  if (!declaredPath) {
    return {
      path: null,
      sha256: providedHash || null,
      size: null,
      mtimeMs: null,
      exists: false,
      error: 'entry path was not observed',
      source: layer,
      confidence: 'unknown',
    }
  }
  const hashed = hashEntry(declaredPath, { baseDir })
  return {
    ...hashed,
    sha256: hashed.sha256 ?? (providedHash || null),
    source: layer,
    confidence: hashed.exists ? 'observed' : 'degraded',
  }
}

function normalizePluginRecord(spec, layer, options) {
  const id = text(spec?.id ?? spec?.pluginId ?? spec?.plugin_id ?? spec?.name)
  if (!id) return null
  const enabledValue = spec?.enabled ?? spec?.active ?? spec?.loaded
  const enabled = typeof enabledValue === 'boolean'
    ? enabledValue
    : spec?.status === 'enabled' || spec?.state === 'enabled'
      ? true
      : spec?.status === 'disabled' || spec?.state === 'disabled'
        ? false
        : null
  const entry = entryInfoOf(spec, layer, options.baseDir)
  const schemaVersion = spec?.schemaVersion ?? spec?.schema_version ?? spec?.persistenceSchema?.version ?? null
  const stateOwner = spec?.stateOwner ?? spec?.state_owner ?? spec?.owner ?? null
  const patch = spec?.patch ?? spec?.patchId ?? spec?.patch_id ?? spec?.patchSource ?? null
  return {
    id,
    version: text(spec?.version ?? spec?.pluginVersion ?? spec?.plugin_version) || null,
    installed: typeof spec?.installed === 'boolean' ? spec.installed : null,
    enabled,
    entry,
    source: spec?.source ?? spec?.pluginSource ?? null,
    patch: patch === null || patch === '' ? null : deepClone(patch),
    configSource: spec?.configSource ?? spec?.config_source ?? spec?.configPath ?? null,
    config: deepClone(spec?.config ?? spec?.configuration ?? null),
    stateOwner: stateOwner === null || stateOwner === '' ? null : String(stateOwner),
    schemaVersion,
    permissions: spec?.permissions ?? null,
    wake: spec?.wake ?? spec?.wakeSemantics ?? null,
    recovery: spec?.recovery ?? spec?.recoveryMethod ?? null,
    declaredCapabilities: uniqueText(spec?.declaredCapabilities ?? spec?.declared_capabilities ?? spec?.capabilities),
    callableCapabilities: uniqueText(spec?.callableCapabilities ?? spec?.callable_capabilities),
    observation: {
      layer,
      source: String(spec?.observationSource ?? spec?.observation_source ?? layer),
      confidence: spec?.confidence ?? (entry.exists || layer !== 'runtime' ? 'observed' : 'degraded'),
    },
  }
}

function normalizeLayer(raw, layer, options) {
  const complete = raw?.complete === undefined ? raw !== undefined : raw.complete === true
  const reasons = uniqueText(raw?.degradedReasons ?? raw?.reasons)
  if (raw === undefined || raw === null) reasons.push(layer + ' observation was not supplied')
  const records = {}
  for (const spec of pluginArray(raw)) {
    const normalized = normalizePluginRecord(spec, layer, options)
    if (normalized) records[normalized.id] = normalized
  }
  return {
    complete: complete && reasons.length === 0,
    degradedReasons: reasons,
    plugins: records,
    configSources: deepClone(raw?.configSources ?? raw?.config_sources ?? null),
  }
}

function difference(pluginId, code, layers, message, expected, actual) {
  return {
    pluginId,
    code,
    severity: code.includes('unknown') || code === 'evidence-missing' ? 'warning' : 'error',
    layers,
    message,
    expected: expected ?? null,
    actual: actual ?? null,
  }
}

function comparePlugin(id, layers) {
  const records = Object.fromEntries(RUNTIME_FACT_LAYERS.map((layer) => [layer, layers[layer].plugins[id] ?? null]))
  const differences = []
  const runtime = records.runtime
  const disk = records.disk
  const documented = records.documented
  const session = records.session

  if (disk?.enabled === true && runtime === null) {
    differences.push(difference(id, 'configured-but-not-loaded', ['disk', 'runtime'], 'plugin is enabled on disk but was not observed in the runtime', true, null))
  }
  if (runtime && runtime.enabled === false) {
    differences.push(difference(id, 'runtime-disabled', ['runtime'], 'runtime reports the plugin as disabled', true, false))
  }
  if (documented?.version && runtime?.version && documented.version !== runtime.version) {
    differences.push(difference(id, 'runtime-version-mismatch', ['documented', 'runtime'], 'runtime version differs from the documented version', documented.version, runtime.version))
  }
  if (disk?.version && runtime?.version && disk.version !== runtime.version) {
    differences.push(difference(id, 'runtime-version-mismatch', ['disk', 'runtime'], 'runtime version differs from the disk declaration', disk.version, runtime.version))
  }
  if (session?.version && runtime?.version && session.version !== runtime.version) {
    differences.push(difference(id, 'session-version-mismatch', ['runtime', 'session'], 'session snapshot version differs from the runtime version', runtime.version, session.version))
  }

  const paths = uniqueText([documented, disk, runtime, session].map((row) => row?.entry?.path))
  if (paths.length > 1) {
    differences.push(difference(id, 'entry-path-mismatch', ['documented', 'disk', 'runtime', 'session'], 'observed plugin entry paths differ', paths[0], paths.slice(1)))
  }
  const hashes = uniqueText([documented, disk, runtime, session].map((row) => row?.entry?.sha256))
  if (hashes.length > 1) {
    differences.push(difference(id, 'entry-hash-mismatch', ['documented', 'disk', 'runtime', 'session'], 'observed plugin entry hashes differ', hashes[0], hashes.slice(1)))
  }

  const runtimeExpected = disk ?? documented
  if (runtimeExpected?.enabled !== null && runtimeExpected?.enabled !== undefined
    && runtime?.enabled !== null && runtime?.enabled !== undefined
    && runtimeExpected.enabled !== runtime.enabled) {
    differences.push(difference(id, 'runtime-enabled-state-mismatch', ['disk', 'runtime'], 'runtime enabled state differs from the configuration layer', runtimeExpected.enabled, runtime.enabled))
  }
  if (session?.enabled !== null && session?.enabled !== undefined
    && runtime?.enabled !== null && runtime?.enabled !== undefined
    && session.enabled !== runtime.enabled) {
    differences.push(difference(id, 'session-enabled-state-mismatch', ['runtime', 'session'], 'session snapshot enabled state differs from the runtime state', runtime.enabled, session.enabled))
  }
  if (runtime && runtime.patch === null) {
    differences.push(difference(id, 'patch-source-unknown', ['runtime'], 'runtime patch source is unknown', 'observed patch identity', null))
  }
  if (runtime && runtime.stateOwner === null) {
    differences.push(difference(id, 'state-owner-unknown', ['runtime'], 'runtime state ownership is unknown', 'explicit owner', null))
  }
  if (runtime && runtime.schemaVersion === null) {
    differences.push(difference(id, 'schema-unknown', ['runtime'], 'runtime schema version is unknown', 'explicit schema version', null))
  }
  if (RUNTIME_FACT_LAYERS.some((layer) => records[layer] === null)) {
    differences.push(difference(id, 'evidence-missing', RUNTIME_FACT_LAYERS.filter((layer) => records[layer] === null), 'one or more observation layers do not contain this plugin', RUNTIME_FACT_LAYERS, RUNTIME_FACT_LAYERS.filter((layer) => records[layer] !== null)))
  }
  return { records, differences }
}

function normalizeFeature(spec, index) {
  return {
    id: text(spec?.id ?? spec?.featureId ?? spec?.name) || 'feature-' + String(index + 1),
    entry: spec?.entry ?? spec?.entryPath ?? null,
    stateOwner: spec?.stateOwner ?? spec?.owner ?? 'unknown',
    stateStore: spec?.stateStore ?? spec?.store ?? null,
    schemaVersion: spec?.schemaVersion ?? null,
    permissions: spec?.permissions ?? 'unknown',
    wake: spec?.wake ?? spec?.wakeSemantics ?? 'unknown',
    recovery: spec?.recovery ?? 'unknown',
    observation: {
      source: spec?.observationSource ?? 'caller',
      confidence: spec?.confidence ?? (spec?.stateOwner ? 'observed' : 'unknown'),
    },
  }
}

/**
 * Build a layered runtime fact report.
 *
 * @param {{
 *   observedAt?: string|number|Date,
 *   instance?: object,
 *   dsh?: object,
 *   documented?: object|Array,
 *   disk?: object|Array,
 *   runtime?: object|Array,
 *   session?: object|Array,
 *   features?: Array,
 *   baseDir?: string,
 *   changedDuringCollection?: boolean,
 *   collectionReasons?: string[]
 * }} input Observation input.
 * @returns {object} Redacted, read-only report.
 */
export function buildRuntimeFacts(input = {}) {
  const observedAt = isoTime(input.observedAt ?? input.now, 'unknown')
  const options = { baseDir: input.baseDir }
  const layers = Object.fromEntries(RUNTIME_FACT_LAYERS.map((layer) => [layer, normalizeLayer(input[layer], layer, options)]))
  const pluginIds = [...new Set(RUNTIME_FACT_LAYERS.flatMap((layer) => Object.keys(layers[layer].plugins)))].sort()
  const plugins = {}
  const differences = []
  for (const id of pluginIds) {
    const compared = comparePlugin(id, layers)
    plugins[id] = compared.records
    differences.push(...compared.differences)
  }
  const features = asArray(input.features ?? input.stateFacts).map(normalizeFeature)
  const collectionReasons = uniqueText(input.collectionReasons)
  for (const layer of RUNTIME_FACT_LAYERS) {
    if (!layers[layer].complete) collectionReasons.push(...layers[layer].degradedReasons.map((reason) => layer + ': ' + reason))
  }
  if (input.changedDuringCollection === true) collectionReasons.push('runtime instance changed during collection')
  for (const row of Object.values(plugins)) {
    // A plugin with no persistence schema legitimately reports schemaVersion
    // null. That is a schema-unknown warning, not missing runtime evidence; the
    // executable identity and state owner are the completion-critical facts.
    if (row.runtime && (row.runtime.entry.sha256 === null || row.runtime.stateOwner === null)) {
      collectionReasons.push('runtime evidence incomplete for plugin ' + row.runtime.id)
    }
  }
  const report = {
    schemaVersion: RUNTIME_FACTS_SCHEMA_VERSION,
    kind: 'dsh.runtime-facts',
    collectedAt: observedAt,
    instance: deepClone(input.instance ?? null),
    dsh: {
      version: text(input.dsh?.version ?? input.version) || 'unknown',
      profile: text(input.dsh?.profile ?? input.profile) || 'unknown',
    },
    collection: {
      readOnly: true,
      complete: collectionReasons.length === 0,
      degraded: collectionReasons.length > 0,
      reasons: [...new Set(collectionReasons)],
      changedDuringCollection: input.changedDuringCollection === true,
      secretsFiltered: true,
    },
    layers,
    plugins,
    features,
    differences,
    diffSummary: {
      total: differences.length,
      errors: differences.filter((row) => row.severity === 'error').length,
      warnings: differences.filter((row) => row.severity === 'warning').length,
      codes: [...new Set(differences.map((row) => row.code))].sort(),
    },
  }
  const redacted = redactSecretsDetailed(report)
  return {
    ...redacted.value,
    redaction: {
      applied: redacted.redactedPaths.length > 0,
      policy: 'secret-key-and-token-pattern-v1',
      redactedPaths: redacted.redactedPaths,
    },
  }
}

/**
 * Alias with an action-oriented name for runtime callers.
 *
 * @param {object} [options] Same input as buildRuntimeFacts.
 * @returns {object} Runtime facts report.
 */
export function collectRuntimeFacts(options = {}) {
  return buildRuntimeFacts(options)
}

/**
 * Compare two generated runtime fact snapshots without writing either one.
 *
 * @param {object} previous Previous report.
 * @param {object} current Current report.
 * @returns {{ changed: boolean, pluginChanges: Array, collectionChanged: boolean }}
 */
export function compareRuntimeFactSnapshots(previous, current) {
  const pluginIds = [...new Set([
    ...Object.keys(previous?.plugins ?? {}),
    ...Object.keys(current?.plugins ?? {}),
  ])].sort()
  const pluginChanges = pluginIds.filter((id) => digest(previous?.plugins?.[id] ?? null) !== digest(current?.plugins?.[id] ?? null))
    .map((id) => ({ pluginId: id, previous: previous?.plugins?.[id] ?? null, current: current?.plugins?.[id] ?? null }))
  const collectionChanged = digest(previous?.collection ?? null) !== digest(current?.collection ?? null)
  return { changed: pluginChanges.length > 0 || collectionChanged, pluginChanges, collectionChanged }
}

function profileRows(profiles) {
  if (Array.isArray(profiles)) return profiles
  if (profiles === null || typeof profiles !== 'object') return []
  return Object.entries(profiles).map(([id, row]) => ({ id, ...(row ?? {}) }))
}

function capabilityValues(value) {
  if (Array.isArray(value)) return value
  if (value !== null && typeof value === 'object') return Object.keys(value)
  return []
}

function capabilityNames(profile) {
  const plugin = profile.plugin ?? profile
  return uniqueText([
    ...capabilityValues(profile.capabilities),
    ...capabilityValues(profile.declaredCapabilities),
    ...capabilityValues(profile.callableCapabilities),
    ...capabilityValues(plugin.capabilities),
    ...capabilityValues(plugin.declaredCapabilities),
    ...capabilityValues(plugin.callableCapabilities),
    ...Object.keys(profile.persistenceSchemas ?? {}),
    ...Object.keys(plugin.persistenceSchemas ?? {}),
    ...Object.keys(profile.semantics ?? {}),
    ...Object.keys(plugin.semantics ?? {}),
    ...asArray(profile.tools).map((tool) => tool?.capability ?? tool?.name),
  ])
}

function schemaFingerprint(schema) {
  return schema === undefined || schema === null ? null : fingerprintValue(schema)
}

function normalizeProfile(profile) {
  const id = text(profile?.id ?? profile?.profile ?? profile?.name)
  if (!id) throw new Error('profile id is required')
  const plugin = profile.plugin ?? profile
  const entry = profile.entry ?? plugin.entry ?? profile.entryPath ?? plugin.entryPath ?? null
  const entryHash = profile.entryHash ?? plugin.entryHash ?? profile.sha256 ?? plugin.sha256 ?? null
  const tools = asArray(profile.tools ?? plugin.tools).map((tool, index) => ({
    name: text(tool?.name ?? tool?.tool ?? tool?.id) || 'tool-' + String(index + 1),
    capability: text(tool?.capability ?? tool?.capabilityId ?? tool?.name) || null,
    schema: tool?.schema ?? tool?.inputSchema ?? null,
    schemaFingerprint: schemaFingerprint(tool?.schema ?? tool?.inputSchema),
    callable: tool?.callable !== false,
  }))
  return {
    id,
    pluginId: text(profile.pluginId ?? plugin.id ?? plugin.pluginId ?? id),
    pluginVersion: text(profile.pluginVersion ?? plugin.version) || null,
    entry,
    entryHash,
    installed: profile.installed ?? plugin.installed ?? null,
    enabled: profile.enabled ?? plugin.enabled ?? null,
    declaredCapabilities: uniqueText([
      ...capabilityValues(profile.declaredCapabilities),
      ...capabilityValues(profile.capabilities),
      ...capabilityValues(plugin.declaredCapabilities),
      ...capabilityValues(plugin.capabilities),
    ]),
    callableCapabilities: uniqueText([
      ...capabilityValues(profile.callableCapabilities),
      ...capabilityValues(plugin.callableCapabilities),
    ]),
    declaredKnown: profile.declaredCapabilities !== undefined
      || profile.capabilities !== undefined
      || plugin.declaredCapabilities !== undefined
      || plugin.capabilities !== undefined,
    callableKnown: profile.callableCapabilities !== undefined || plugin.callableCapabilities !== undefined,
    tools,
    persistenceSchemas: deepClone(profile.persistenceSchemas ?? plugin.persistenceSchemas ?? {}),
    semantics: deepClone(profile.semantics ?? plugin.semantics ?? {}),
    contractResults: deepClone(profile.contractResults ?? plugin.contractResults ?? {}),
    runtimeReachable: profile.runtimeReachable ?? plugin.runtimeReachable ?? null,
  }
}

function contractPassed(value) {
  return value === true || value?.passed === true || value?.status === 'passed'
}

/**
 * Build a read-only capability matrix across profiles.
 *
 * Installed, enabled, declared and callable remain separate facts. Callability
 * is never inferred from a declaration alone.
 *
 * @param {Array|object} profiles Profile observations.
 * @returns {{ schemaVersion: number, profiles: object, rows: Array, capabilities: string[] }}
 */
export function buildCapabilityMatrix(profiles) {
  const normalized = profileRows(profiles).map(normalizeProfile)
  const capabilities = [...new Set(normalized.flatMap(capabilityNames))].sort()
  const rows = []
  const profileOutput = {}
  for (const profile of normalized) {
    profileOutput[profile.id] = {
      id: profile.id,
      pluginId: profile.pluginId,
      pluginVersion: profile.pluginVersion,
      entry: profile.entry,
      entryHash: profile.entryHash,
      installed: profile.installed,
      enabled: profile.enabled,
      capabilities: {},
    }
    for (const capability of capabilities) {
      const matchingTools = profile.tools.filter((tool) => tool.capability === capability)
      const persistenceSchema = profile.persistenceSchemas?.[capability] ?? null
      const semantics = profile.semantics?.[capability] ?? null
      const declared = profile.declaredCapabilities.includes(capability)
      const callable = profile.callableCapabilities.includes(capability)
        || matchingTools.some((tool) => tool.callable === true)
      const installed = profile.installed === true
      const enabled = profile.enabled === true
      const installedKnown = profile.installed !== null && profile.installed !== undefined
      const enabledKnown = profile.enabled !== null && profile.enabled !== undefined
      const contract = profile.contractResults?.[capability] ?? null
      const reasons = []
      if (!installedKnown) reasons.push('installed-unknown')
      else if (!installed) reasons.push('not-installed')
      if (!enabledKnown) reasons.push('enabled-unknown')
      else if (!enabled) reasons.push('not-enabled')
      if (!profile.declaredKnown) reasons.push('declaration-unknown')
      else if (!declared) reasons.push('not-declared')
      if (!profile.callableKnown && matchingTools.length === 0) reasons.push('callability-unknown')
      else if (!callable) reasons.push('not-callable')
      if (profile.runtimeReachable === false) reasons.push('runtime-unreachable')
      const row = {
        profile: profile.id,
        capability,
        pluginId: profile.pluginId,
        pluginVersion: profile.pluginVersion,
        entry: profile.entry,
        entryHash: profile.entryHash,
        installed,
        enabled,
        declared,
        callable: callable && installed && enabled,
        factState: {
          installed: installedKnown ? String(installed) : 'unknown',
          enabled: enabledKnown ? String(enabled) : 'unknown',
          declared: profile.declaredKnown ? String(declared) : 'unknown',
          callable: profile.callableKnown || matchingTools.length > 0 ? String(callable && installed && enabled) : 'unknown',
        },
        reasons,
        toolSchemas: matchingTools.map((tool) => ({
          name: tool.name,
          fingerprint: tool.schemaFingerprint,
          callable: tool.callable,
        })),
        persistenceSchema: {
          value: deepClone(persistenceSchema),
          fingerprint: schemaFingerprint(persistenceSchema),
        },
        semantics: deepClone(semantics),
        contract: deepClone(contract),
      }
      profileOutput[profile.id].capabilities[capability] = row
      rows.push(row)
    }
  }
  return {
    schemaVersion: CAPABILITY_MATRIX_SCHEMA_VERSION,
    profiles: profileOutput,
    rows,
    capabilities,
  }
}

function matrixOf(value) {
  return value?.schemaVersion === CAPABILITY_MATRIX_SCHEMA_VERSION && value?.rows
    ? value
    : buildCapabilityMatrix(value)
}

function semanticFingerprint(row) {
  return fingerprintValue({
    tools: row.toolSchemas,
    persistence: row.persistenceSchema?.fingerprint,
    semantics: row.semantics,
  })
}

/**
 * Compare two capability matrices and report capability drift.
 *
 * @param {Array|object} baseline Baseline profiles or matrix.
 * @param {Array|object} candidate Candidate profiles or matrix.
 * @returns {{ changed: boolean, rows: Array }}
 */
export function diffCapabilityMatrices(baseline, candidate) {
  const left = matrixOf(baseline)
  const right = matrixOf(candidate)
  const keys = [...new Set([...left.rows, ...right.rows].map((row) => row.profile + '\u0000' + row.capability))].sort()
  const rows = keys.map((key) => {
    const [profile, capability] = key.split('\u0000')
    const before = left.rows.find((row) => row.profile === profile && row.capability === capability) ?? null
    const after = right.rows.find((row) => row.profile === profile && row.capability === capability) ?? null
    const changes = []
    for (const field of ['installed', 'enabled', 'declared', 'callable']) {
      if ((before?.[field] ?? null) !== (after?.[field] ?? null)) changes.push(field)
    }
    if (before && after) {
      if (before.entryHash !== after.entryHash) changes.push('entryHash')
      if (before.pluginVersion !== after.pluginVersion) changes.push('pluginVersion')
      if (before.persistenceSchema?.fingerprint !== after.persistenceSchema?.fingerprint) changes.push('persistenceSchema')
      if (fingerprintValue(before.semantics) !== fingerprintValue(after.semantics)) changes.push('semantics')
      if (fingerprintValue(before.toolSchemas) !== fingerprintValue(after.toolSchemas)) changes.push('toolSchemas')
    } else {
      changes.push(before ? 'removed' : 'added')
    }
    return { profile, capability, before, after, changes, drift: changes.length > 0, semanticFingerprint: after ? semanticFingerprint(after) : null }
  })
  return { changed: rows.some((row) => row.drift), rows }
}

/**
 * Evaluate an upgrade gate for required capabilities and their contract tests.
 *
 * @param {{
 *   baseline?: Array|object,
 *   candidate: Array|object,
 *   requiredCapabilities?: string[],
 *   contracts?: object
 * }} input Gate input.
 * @returns {{ ok: boolean, verdict: string, blockers: Array, warnings: Array, differences: Array }}
 */
export function evaluateUpgradeGate(input = {}) {
  const candidate = matrixOf(input.candidate)
  const differences = input.baseline ? diffCapabilityMatrices(input.baseline, candidate) : { changed: false, rows: [] }
  const required = uniqueText(input.requiredCapabilities)
  const blockers = []
  const warnings = []
  for (const capability of required) {
    const rows = candidate.rows.filter((row) => row.capability === capability)
    if (rows.length === 0) {
      blockers.push({ code: 'capability-missing', capability, message: 'no target profile declares the required capability' })
      continue
    }
    for (const row of rows) {
      const contract = input.contracts?.[row.profile]?.[capability] ?? row.contract
      if (!row.callable) {
        blockers.push({ code: 'capability-not-callable', profile: row.profile, capability, reasons: row.reasons })
      }
      if (!contractPassed(contract)) {
        blockers.push({ code: 'contract-not-passed', profile: row.profile, capability })
      }
      const drift = differences.rows.find((change) => change.profile === row.profile && change.capability === capability && change.drift)
      if (drift && !contractPassed(contract)) {
        blockers.push({ code: 'unverified-capability-drift', profile: row.profile, capability, changes: drift.changes })
      } else if (drift) {
        warnings.push({ code: 'verified-capability-drift', profile: row.profile, capability, changes: drift.changes })
      }
    }
  }
  for (const row of differences.rows.filter((change) => change.drift && !required.includes(change.capability))) {
    warnings.push({ code: 'unrelated-capability-drift', profile: row.profile, capability: row.capability, changes: row.changes })
  }
  return {
    ok: blockers.length === 0,
    verdict: blockers.length === 0 ? 'pass' : 'blocked',
    blockers,
    warnings,
    differences: differences.rows.filter((row) => row.drift),
  }
}

export const upgradeGateVerdict = evaluateUpgradeGate
