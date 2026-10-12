/**
 * Structured Agent Team/profile health.
 *
 * This is intentionally a small profile-level observer rather than another
 * source of task truth. It validates the critical plugin/config boundary at
 * startup, writes a durable report for the operator panel, and mirrors the
 * result into each Team's control-plane health record when a Team appears.
 */
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { createHash } from 'node:crypto'
import { dirname, join } from 'node:path'
import { controlPlaneFor, teamRootIdCandidates } from './team-control-plane.mjs'
import { dormantVerdict, readTelemetry } from './team-v13-mechanism-telemetry.mjs'

export const name = 'team-health'
export const inject = ['agents', 'agentTeams']
console.log('[team-health] HMR inactive-context-timer-guard+perf49-time-plugin-disabled loaded 2026-09-28')

const DEFAULT_REQUIRED = [
  'team-control-plane.mjs',
  'team-policy.mjs',
  'team-tools-v2-r10.mjs',
  'step-compaction-v4.mjs',
  'write-scope-guard.mjs',
]
const DEFAULT_CRITICAL = new Set([
  'team-control-plane.mjs',
  'team-policy.mjs',
  'team-tools-v2-r10.mjs',
  'step-compaction-v4.mjs',
  'write-scope-guard.mjs',
])
const DEFAULT_SHARED = [
  'team-health.mjs',
  'team-control-plane.mjs',
  'team-policy.mjs',
  'team-tools-v2-r10.mjs',
  'step-compaction-v4.mjs',
  'write-scope-guard.mjs',
  'team-runtime-guard.mjs',
  'team-v12-runtime.mjs',
  'team-v14-context-delivery.mjs',
  'team-v14-waiting.mjs',
  'team-v12-evidence-scheduler.mjs',
  'team-v14-event-continuation.mjs',
  'team-idle-watch-v6.mjs',
  'team-milestone-v2.mjs',
  'team-message-time.mjs',
]

function hashFile(file) {
  return createHash('sha256').update(readFileSync(file)).digest('hex')
}

function exportMarkers(source) {
  const markers = []
  const patterns = [
    /export\s+const\s+([A-Za-z_$][\w$]*)/g,
    /export\s+function\s+([A-Za-z_$][\w$]*)/g,
    /export\s+class\s+([A-Za-z_$][\w$]*)/g,
    /export\s*\{\s*([^}]+)\}/g,
  ]
  for (const pattern of patterns) {
    let match
    while ((match = pattern.exec(source)) !== null) {
      for (const name of String(match[1] ?? '').split(',')) {
        const clean = name.trim().split(/\s+as\s+/).pop()?.trim()
        if (clean) markers.push(clean)
      }
    }
  }
  return [...new Set(markers)].sort()
}

function profilePluginDirs(config, baseDir) {
  if (Array.isArray(config.profileDirs) && config.profileDirs.length > 0) {
    return config.profileDirs.map(String)
  }
  const profilesRoot = dirname(dirname(baseDir))
  return ['desktop', 'web', 'headless'].map((profile) => join(profilesRoot, profile, 'plugins'))
}

export function inspectProfileParity(config = {}, baseDir) {
  const dirs = profilePluginDirs(config, baseDir)
  const shared = Array.isArray(config.sharedPluginFiles) && config.sharedPluginFiles.length > 0
    ? config.sharedPluginFiles.map(String)
    : DEFAULT_SHARED
  const rows = []
  const reasons = []
  for (const name of shared) {
    const copies = []
    for (const dir of dirs) {
      const path = join(dir, name)
      try {
        const source = readFileSync(path, 'utf8')
        copies.push({
          dir,
          path,
          exists: true,
          size: statSync(path).size,
          hash: hashFile(path),
          exports: exportMarkers(source),
        })
      } catch {
        copies.push({ dir, path, exists: false, size: null, hash: null, exports: [] })
      }
    }
    const present = copies.filter((row) => row.exists)
    const baseline = present[0]
    const mismatch = present.some((row) => baseline === undefined
      || row.hash !== baseline.hash
      || row.size !== baseline.size
      || JSON.stringify(row.exports) !== JSON.stringify(baseline.exports))
    const missing = copies.filter((row) => !row.exists)
    if (mismatch || missing.length > 0 || present.length !== dirs.length) {
      reasons.push('profile parity failed for ' + name)
    }
    rows.push({ name, status: mismatch || missing.length > 0 ? 'disabled' : 'healthy', copies })
  }
  return { status: reasons.length === 0 ? 'healthy' : 'disabled', reasons, rows }
}

function reportPath(config) {
  return typeof config.healthFile === 'string' && config.healthFile.length > 0
    ? config.healthFile
    : join(process.env.DSH_HOME ?? process.cwd(), 'team-health.json')
}

// hot-reload marker: v14 performance parity refresh final 2026-09-27

function atomicWrite(file, value) {
  mkdirSync(dirname(file), { recursive: true })
  const temp = file + '.tmp-' + process.pid
  writeFileSync(temp, JSON.stringify(value, null, 2), 'utf8')
  renameSync(temp, file)
}

function readScopeConfig(file) {
  if (typeof file !== 'string' || file.length === 0) return { status: 'degraded', reason: 'scope file is not configured' }
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8'))
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('scope root must be an object')
    if (parsed.byName !== undefined && (parsed.byName === null || typeof parsed.byName !== 'object' || Array.isArray(parsed.byName))) throw new Error('byName must be an object')
    if (parsed.bySession !== undefined && (parsed.bySession === null || typeof parsed.bySession !== 'object' || Array.isArray(parsed.bySession))) throw new Error('bySession must be an object')
    if (parsed.defaultDeny !== true) return { status: 'degraded', reason: 'scope defaultDeny is not true' }
    return { status: 'healthy' }
  } catch (error) {
    return { status: 'disabled', reason: 'scope file is missing or invalid: ' + String(error?.message ?? error) }
  }
}

function readRoleConfig(config) {
  if (config.requireRoleFiles !== true) return { status: 'healthy', files: {}, reasons: [] }
  const dir = typeof config.rolesDir === 'string' && config.rolesDir.length > 0
    ? config.rolesDir
    : join(process.env.DSH_HOME ?? process.cwd(), 'team-roles')
  const required = Array.isArray(config.roleFiles) && config.roleFiles.length > 0
    ? config.roleFiles.map(String)
    : ['lead.md', 'verifier.md', 'member.md']
  const files = {}
  let status = 'healthy'
  const reasons = []
  for (const name of required) {
    const path = name.includes('\\') || name.includes('/') ? name : join(dir, name)
    let valid = false
    try { valid = statSync(path).isFile() && readFileSync(path, 'utf8').trim().length > 0 } catch {}
    files[name] = { path, valid }
    if (!valid) {
      status = 'disabled'
      reasons.push('required role identity missing or empty: ' + path)
    }
  }
  return { status, files, reasons }
}

export function inspectHealth(config = {}) {
  const baseDir = typeof config.pluginDir === 'string' && config.pluginDir.length > 0
    ? config.pluginDir
    : join(process.env.DSH_HOME ?? process.cwd(), 'profiles', 'web', 'plugins')
  const required = Array.isArray(config.requiredFiles) && config.requiredFiles.length > 0
    ? config.requiredFiles.map(String)
    : DEFAULT_REQUIRED
  const criticalNames = new Set(Array.isArray(config.criticalFiles) && config.criticalFiles.length > 0
    ? config.criticalFiles.map(String)
    : [...DEFAULT_CRITICAL])
  const files = {}
  const reasons = []
  let status = 'healthy'
  for (const name of required) {
    const path = name.includes('\\') || name.includes('/') ? name : join(baseDir, name)
    let exists = false
    try { statSync(path); exists = true } catch {}
    const critical = criticalNames.has(name) || criticalNames.has(path)
    files[name] = { path, exists, critical, status: exists ? 'enabled' : critical ? 'disabled' : 'degraded' }
    if (!exists) {
      reasons.push((critical ? 'critical plugin missing: ' : 'optional plugin missing: ') + path)
      if (critical) status = 'disabled'
      else if (status === 'healthy') status = 'degraded'
    }
  }
  const scope = readScopeConfig(config.scopesFile)
  if (scope.status === 'disabled') status = 'disabled'
  else if (scope.status === 'degraded' && status === 'healthy') status = 'degraded'
  if (scope.reason) reasons.push(scope.reason)
  const roles = readRoleConfig(config)
  if (roles.status === 'disabled') status = 'disabled'
  if (roles.reasons.length > 0) reasons.push(...roles.reasons)
  const parity = inspectProfileParity(config, baseDir)
  if (parity.status === 'disabled') status = 'disabled'
  if (parity.reasons.length > 0) reasons.push(...parity.reasons)
  const numeric = [
    ['windowTokens', config.windowTokens],
    ['reservedOutputTokens', config.reservedOutputTokens],
    ['safetyMarginTokens', config.safetyMarginTokens],
  ]
  for (const [key, value] of numeric) {
    if (value !== undefined && (!Number.isFinite(value) || value <= 0)) {
      reasons.push('invalid ' + key)
      status = 'disabled'
    }
  }
  const plugins = config.plugins && typeof config.plugins === 'object' ? structuredClone(config.plugins) : {}
  for (const [plugin, state] of Object.entries(plugins)) {
    if (!['enabled', 'disabled', 'degraded'].includes(state)) {
      reasons.push('invalid plugin state: ' + plugin)
      status = 'disabled'
    }
    if (state === 'degraded' && status === 'healthy') status = 'degraded'
  }
  const telemetryDir = typeof config.telemetryDir === 'string' && config.telemetryDir.length > 0
    ? config.telemetryDir
    : config.controlDir
      ? String(config.controlDir)
      : join(process.env.DSH_HOME ?? process.cwd(), 'team-control-plane')
  const mechanisms = readTelemetry(telemetryDir).map((row) => ({
    name: row.name,
    enabled: row.enabled,
    fired: Number(row.fired ?? 0),
    events: Number(row.events ?? 0),
    lastFiredAt: row.lastFiredAt ?? null,
    skipped: row.skipped ?? {},
    metrics: row.metrics ?? {},
    dormant: dormantVerdict(row, { threshold: config.dormantSessions ?? 5 }),
  }))
  return {
    version: 1,
    profile: String(config.profile ?? 'web'),
    status,
    reasons,
    files,
    roles: roles.files,
    profileParity: parity,
    plugins,
    mechanisms,
    controlDir: config.controlDir ?? null,
    checkedAt: Date.now(),
  }
}

export function apply(ctx, config = {}) {
  const file = reportPath(config)
  const configuredRefreshMs = Number(config.healthRefreshMs ?? 30000)
  const refreshMs = Number.isFinite(configuredRefreshMs) && configuredRefreshMs > 0
    ? Math.max(10, configuredRefreshMs)
    : 30000
  let report
  let lastLogKey = ''

  const publish = (nextReport) => {
    report = nextReport
    try {
      atomicWrite(file, report)
    } catch (error) {
      report.status = 'disabled'
      report.reasons.push('health report write failed: ' + String(error?.message ?? error))
    }
    const logKey = report.status + '\u0000' + report.reasons.join('\u0000')
    if (logKey !== lastLogKey) {
      const log = report.status === 'healthy' ? 'info' : 'warn'
      ctx.logger?.[log]?.('[team-health] ' + report.status + ' ' + report.reasons.join('; '))
      lastLogKey = logKey
    }
    return report
  }
  publish(inspectHealth(config))

  const mirror = (agent) => {
    try {
      if (typeof config.controlDir !== 'string') return
      const stale = Date.now() - Number(report?.checkedAt ?? 0) >= refreshMs
      const currentReport = report?.status === 'disabled' || stale
        ? publish(inspectHealth(config))
        : report
      const keys = teamRootIdCandidates(ctx, agent)
      for (const key of keys.slice(0, 1)) {
        const control = controlPlaneFor(key, { directory: config.controlDir })
        const current = typeof control.healthStatus === 'function'
          ? control.healthStatus()
          : control.health()
        const providerBlocked = control.providerState?.().status === 'blocked'
          || current.reasons?.some((reason) => String(reason).startsWith('provider failure'))
        if (providerBlocked && currentReport.status === 'healthy') return
        void control.healthSet({ status: currentReport.status, reasons: currentReport.reasons }).catch(() => {})
      }
    } catch {}
  }
  const disposers = []
  if (typeof ctx.on === 'function') {
    disposers.push(ctx.on('agent/created', ({ agent }) => mirror(agent)))
    disposers.push(ctx.on('agent/status', ({ agent }) => mirror(agent)))
  }
  const listAgents = () => {
    try {
      return ctx.agents?.list?.() ?? []
    } catch {
      // HMR may dispose this context while its unref'ed timer is still queued.
      return []
    }
  }
  const refreshTimer = setInterval(() => {
    try {
      publish(inspectHealth(config))
      for (const agent of listAgents()) mirror(agent)
    } catch (error) {
      ctx.logger?.warn?.('[team-health] periodic refresh failed: ' + String(error?.message ?? error))
    }
  }, refreshMs)
  refreshTimer.unref?.()
  try {
    for (const agent of listAgents()) {
      mirror(agent)
    }
  } catch (error) {
    ctx.logger?.warn?.('[team-health] initial mirror failed: ' + String(error?.message ?? error))
  }
  return () => {
    clearInterval(refreshTimer)
    for (const dispose of disposers) {
      try { dispose?.() } catch {}
    }
  }
}
