/**
 * write-scope-guard — Agent Team v2 / Phase 1
 *
 * Enforces a per-member write scope on the filesystem mutation surface, so
 * "don't write outside your area" stops being a prompt-level convention and
 * becomes a hard, deterministic refusal.
 *
 * Why this hook
 * -------------
 * @deepseek-ai/dsh-fs declares two single-slot decisions:
 *   fs/write-intent(target, actor, next)
 *   fs/edit-intent(target, actor, next)
 * "the first listener that returns an intent owns the decision rather than
 * composing with peers". The shipped @deepseek-ai/dsh-fs-observation-policy
 * registers on both and *returns* an intent, so it short-circuits every later
 * listener. This guard therefore registers with { prepend: true } so it always
 * sees the event first:
 *   - inside scope  -> return undefined, so the observation policy still owns
 *                      the read-before-write / stale-version decision
 *   - outside scope -> throw FsError, which aborts the write outright
 *
 * The acting member is derived exactly as the shipped policy does it:
 *   actor?.agent?.session   (see dsh-fs-observation-policy/lib/index.js:29)
 *
 * Scope source (Phase 1)
 * ----------------------
 * A JSON file, re-read when its mtime changes. Phase 3 replaces this source
 * with the Team domain membership record without changing the enforcement
 * code below.
 *
 *   {
 *     "rootDir": "D:\\dsh-test\\workspaces\\test",
 *     "defaultDeny": false,
 *     "bySession": { "<sessionId>": ["src/ui", "assets/mat"] },
 *     "byName":    { "ui-lead": ["src/ui"] }
 *   }
 *
 * "*" as a scope value disables the check for that member. A member with no
 * entry passes through unless defaultDeny is true.
 *
 * Scope: ctx.fs only. Shell writes do not pass through this seam; they are the
 * sandbox layer's job (dsh-bash-sandbox + dsh-sandbox-policy).
 *
 * @module write-scope-guard
 */

import { readFileSync, statSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { spawnSync } from 'node:child_process'
import { basename, dirname, isAbsolute, join, resolve, normalize, sep } from 'node:path'
import { FsError } from '@deepseek-ai/dsh-fs'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { controlPlaneForMember } from './team-control-plane.mjs'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'write-scope-guard'
/** Reads no services: it only inspects the opaque fs event actor. */
export const inject = ['agentTeams', 'agents']

const EMPTY = { valid: false, error: 'scope file is not configured', bySession: {}, byName: {}, rootDir: undefined, defaultDeny: false, version: 0 }
let cachedPath = null
let cachedMtime = -1
let cached = EMPTY

/** Read and validate the scope file. Invalid state is never served from an old cache. */
function readScopes(file) {
  if (!file) return EMPTY
  try {
    const stamp = statSync(file).mtimeMs
    if (file === cachedPath && stamp === cachedMtime) return cached
    const parsed = JSON.parse(readFileSync(file, 'utf8'))
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('root must be an object')
    if (parsed.bySession !== undefined && (typeof parsed.bySession !== 'object' || parsed.bySession === null || Array.isArray(parsed.bySession))) throw new Error('bySession must be an object')
    if (parsed.byName !== undefined && (typeof parsed.byName !== 'object' || parsed.byName === null || Array.isArray(parsed.byName))) throw new Error('byName must be an object')
    for (const table of [parsed.bySession ?? {}, parsed.byName ?? {}]) {
      for (const [name, value] of Object.entries(table)) {
        if (!(value === '*' || Array.isArray(value))) throw new Error(name + ' scope must be "*" or an array')
        if (Array.isArray(value) && value.some((entry) => typeof entry !== 'string')) throw new Error(name + ' scope entries must be strings')
      }
    }
    if (parsed.rootDir !== undefined && typeof parsed.rootDir !== 'string') throw new Error('rootDir must be a string')
    if (parsed.defaultDeny !== undefined && typeof parsed.defaultDeny !== 'boolean') throw new Error('defaultDeny must be boolean')
    cachedPath = file
    cachedMtime = stamp
    cached = {
      valid: true,
      error: undefined,
      bySession: parsed && typeof parsed.bySession === 'object' && parsed.bySession !== null ? parsed.bySession : {},
      byName: parsed && typeof parsed.byName === 'object' && parsed.byName !== null ? parsed.byName : {},
      rootDir: parsed && typeof parsed.rootDir === 'string' ? parsed.rootDir : undefined,
      defaultDeny: parsed ? parsed.defaultDeny === true : false,
      version: Number.isSafeInteger(parsed.version) ? parsed.version : 1,
    }
    return cached
  } catch {
    cachedPath = file
    cachedMtime = -1
    cached = { ...EMPTY, error: 'scope file is missing or invalid: ' + file }
    return cached
  }
}

/** Canonicalize a path the way the target key already is (realpath where it exists). */
function canonical(path) {
  try {
    return realpathSync.native(path)
  } catch {
    return normalize(resolve(path))
  }
}

/** Containment with a path-separator boundary, case-insensitive on Windows. */
function isUnder(child, root) {
  const c = canonical(child).toLowerCase()
  const r = canonical(root).replace(/[\\/]+$/, '').toLowerCase()
  if (c === r) return true
  const s = sep.toLowerCase()
  return c.startsWith(r + s) || c.startsWith(r + '/')
}

function isTemporaryPath(value) {
  const candidate = canonical(value)
  const roots = [tmpdir(), process.env.TEMP, process.env.TMP].filter((root) => typeof root === 'string' && root.length > 0)
  return roots.some((root) => isUnder(candidate, root))
}

function evidenceCheckoutRoots(env = process.env) {
  const roots = []
  if (typeof env.DSH_EVIDENCE_TEMP_ROOT === 'string' && env.DSH_EVIDENCE_TEMP_ROOT.trim().length > 0) {
    roots.push(env.DSH_EVIDENCE_TEMP_ROOT)
  }
  if (typeof env.DSH_HOME === 'string' && env.DSH_HOME.trim().length > 0) {
    roots.push(join(dirname(env.DSH_HOME), 'tmp'))
  }
  return [...new Set(roots)]
}

export function verifierScratchRoot(env = process.env, configuredRoot) {
  if (typeof configuredRoot === 'string' && configuredRoot.trim().length > 0) {
    return resolve(configuredRoot)
  }
  if (typeof env.DSH_HOME === 'string' && env.DSH_HOME.trim().length > 0) {
    return resolve(join(env.DSH_HOME, 'verifier-scratch'))
  }
  return undefined
}

export function isVerifierScratchPath(value, membership, env = process.env, configuredRoot) {
  if (String(membership?.group ?? '').toLowerCase() !== 'verifier') return false
  const root = verifierScratchRoot(env, configuredRoot)
  return root !== undefined && isUnder(canonical(value), root)
}

export function isEvidenceCheckoutPath(value, membership, env = process.env) {
  const tier = Number(membership?.tier)
  if (tier !== 0 && tier !== 1) return false
  const candidate = canonical(value)
  return evidenceCheckoutRoots(env).some((root) => isUnder(candidate, root))
}

function resolvePathExpression(value, variables = new Map()) {
  let resolved = String(value ?? '').trim().replace(/^['"]|['"]$/g, '')
  if (variables.has(resolved)) resolved = variables.get(resolved)
  const temp = process.env.TEMP ?? process.env.TMP ?? tmpdir()
  resolved = resolved
    .replace(/\$(?:env:)?TEMP\b/gi, temp)
    .replace(/\$(?:env:)?TMP\b/gi, temp)
    .replace(/%TEMP%/gi, temp)
    .replace(/%TMP%/gi, temp)
  const join = resolved.match(/^\(?\s*Join-Path\s+(?:"([^"]+)"|'([^']+)'|([^\s)]+))\s+(?:"([^"]+)"|'([^']+)'|([^\s)]+))\s*\)?$/i)
  if (join !== null) {
    const left = resolvePathExpression(join[1] ?? join[2] ?? join[3] ?? '', variables)
    const right = resolvePathExpression(join[4] ?? join[5] ?? join[6] ?? '', variables)
    if (!/[$`]/.test(left) && !/[$`]/.test(right)) return joinPathValue(left, right)
  }
  return resolved
}

function joinPathValue(left, right) {
  return isAbsolute(left) ? resolve(left, right) : normalize(join(left, right))
}

function knownPathVariables(source, initial = new Map()) {
  const variables = new Map(initial)
  const joinAssignment = /\$([A-Za-z_][A-Za-z0-9_]*)\s*=\s*Join-Path\s+(?:"([^"]+)"|'([^']+)'|([^\s;|]+))\s+(?:"([^"]+)"|'([^']+)'|([^\s;|]+))/gi
  let joinMatch
  while ((joinMatch = joinAssignment.exec(String(source ?? ''))) !== null) {
    const left = resolvePathExpression(joinMatch[2] ?? joinMatch[3] ?? joinMatch[4] ?? '', variables)
    const right = resolvePathExpression(joinMatch[5] ?? joinMatch[6] ?? joinMatch[7] ?? '', variables)
    if (!/[$`]/.test(left) && !/[$`]/.test(right)) {
      variables.set('$' + joinMatch[1], joinPathValue(left, right))
    }
  }
  // Only persist values that are provably paths. A generic "first token after ="
  // rule stored command names such as Join-Path and (Get-Process) as paths, so a
  // later write through that variable was checked against the wrong target.
  const assignment = /\$([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(?:"([^"]+)"|'([^']+)'|((?:[A-Za-z]:[\\/]|\.{1,2}[\\/]|[\\/])[^\s;|]*))/g
  let match
  while ((match = assignment.exec(String(source ?? ''))) !== null) {
    const name = '$' + match[1]
    if (variables.has(name)) continue
    const value = resolvePathExpression(match[2] ?? match[3] ?? match[4] ?? '', variables)
    if (!/[$`]/.test(value)) variables.set(name, value)
  }
  return variables
}

function looksLikeDynamicPathExpression(raw, variables) {
  const value = String(raw ?? '').trim()
  if (value.length === 0 || variables.has(value) || /^'[\s\S]*'$/.test(value)) return false
  if (/\$\(|`/.test(value)) return true
  if (/\s[+*\/-]\s/.test(value)) return true
  if (/[+*]/.test(value) && /[$%`]/.test(value)) return true
  const resolved = resolvePathExpression(value, variables)
  if (/\$\(|`/.test(resolved)) return true
  if (/[$`]/.test(resolved)) return true
  if (/\([A-Za-z]+-[A-Za-z]/.test(resolved)) return true
  if (/^\(.*\)$/.test(resolved) && /[+$]/.test(resolved)) return true
  return false
}

/** Resolve the acting member's declared scope, or undefined when none is declared. */
function scopeOf(ctx, scopes, actor) {
  const agent = actor ? actor.agent : undefined
  const session = agent ? agent.session : undefined
  const sid = session ? session.id : undefined
  if (sid !== undefined && Object.prototype.hasOwnProperty.call(scopes.bySession, sid)) return scopes.bySession[sid]
  const label = memberName(ctx, agent)
  if (label !== undefined && Object.prototype.hasOwnProperty.call(scopes.byName, label)) return scopes.byName[label]
  return undefined
}

/**
 * Resolve the Team-facing member name from the live agent. The root Agent often
 * has no `agent.name`; its stable member name is the Team membership name
 * (`lead`). Falling back to `agent.id` there made plan leases recorded under
 * `lead` invisible to this guard, so a valid tier-0 lease looked like no scope.
 */
function membershipOf(ctx, agent) {
  if (agent === undefined || agent === null) return undefined
  try {
    const fromCtx = ctx?.agentTeams?.tryMembership?.(agent)
    if (fromCtx !== undefined) return fromCtx
  } catch {
    /* fall through to the agent-local service used by standalone fixtures */
  }
  try {
    return agent.ctx?.agentTeams?.tryMembership?.(agent)
  } catch {
    return undefined
  }
}

function memberName(ctx, agent) {
  if (agent === undefined || agent === null) return undefined
  const membership = membershipOf(ctx, agent)
  if (membership?.name !== undefined && membership.name !== null && String(membership.name).length > 0) {
    return String(membership.name)
  }
  if (agent.name !== undefined && agent.name !== null && String(agent.name).length > 0) return String(agent.name)
  return agent.id === undefined || agent.id === null ? undefined : String(agent.id)
}

function verifierScratchPathForActor(ctx, value, agent, configuredRoot) {
  const root = verifierScratchRoot(process.env, configuredRoot)
  if (root === undefined || !isUnder(value, root)) return false
  const membership = membershipOf(ctx, agent)
  if (membership === undefined) return false
  if (membership.group !== undefined) return isVerifierScratchPath(value, membership, process.env, configuredRoot)
  // Native membership omits structural fields; only the caller's exact roster
  // row may supply the durable group, never a name-only or cross-Team lookup.
  let rows
  try { rows = ctx?.agentTeams?.listMembers?.(agent) } catch {}
  if (!Array.isArray(rows)) {
    try { rows = agent?.ctx?.agentTeams?.listMembers?.(agent) } catch {}
  }
  if (!Array.isArray(rows)) return false
  const member = rows.find(row => row?.id === agent?.id && row?.name === membership.name)
  return isVerifierScratchPath(value, { group: member?.groupId }, process.env, configuredRoot)
}

const SESSION_SCRATCH_DIRECTORY = '.dsh-verifier-scratch'
const GIT_ROUTING_ENV = new Set(('GIT_DIR GIT_WORK_TREE GIT_COMMON_DIR GIT_INDEX_FILE GIT_OBJECT_DIRECTORY '
  + 'GIT_ALTERNATE_OBJECT_DIRECTORIES GIT_CEILING_DIRECTORIES GIT_DISCOVERY_ACROSS_FILESYSTEM '
  + 'GIT_PREFIX GIT_NAMESPACE GIT_SHALLOW_FILE GIT_GRAFT_FILE GIT_REPLACE_REF_BASE GIT_QUARANTINE_PATH').split(' '))

// Resolve missing leaves through their nearest existing ancestor, like native fs
// target identities. Lexical resolution alone misses junctions above a new file.
function scratchTargetIdentity(value) {
  if (typeof value !== 'string' || !isAbsolute(value)) return undefined
  let ancestor = resolve(value)
  const missing = []
  for (;;) {
    try { return join(realpathSync.native(ancestor), ...missing) } catch (error) {
      if (error?.code !== 'ENOENT') return undefined
      const parent = dirname(ancestor)
      if (parent === ancestor) return undefined
      missing.unshift(basename(ancestor))
      ancestor = parent
    }
  }
}

function sessionScratchCandidateForActor(ctx, agent) {
  const membership = membershipOf(ctx, agent)
  if (membership === undefined) return undefined
  let rows
  try { rows = ctx?.agentTeams?.listMembers?.(agent) } catch {}
  if (!Array.isArray(rows)) {
    try { rows = agent?.ctx?.agentTeams?.listMembers?.(agent) } catch {}
  }
  const row = Array.isArray(rows) ? rows.find(row => row?.id === agent?.id && row?.name === membership.name) : undefined
  if (String(row?.groupId ?? '').toLowerCase() !== 'verifier') return undefined
  const sessionId = agent?.session?.id
  const cwd = agent?.session?.header?.cwd
  if (typeof sessionId !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(sessionId)
    || typeof cwd !== 'string' || !isAbsolute(cwd)) return undefined
  try {
    const workspace = realpathSync.native(cwd)
    if (!statSync(workspace).isDirectory()) return undefined
    const root = join(workspace, SESSION_SCRATCH_DIRECTORY, sessionId)
    // Keep the namespace's physical spelling stable even when Git ignore rules
    // are case-sensitive on a case-insensitive Windows filesystem.
    if (scratchTargetIdentity(root) !== root) return undefined
    return root
  } catch { return undefined }
}

function readOnlyGit(workspace, args) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !GIT_ROUTING_ENV.has(key.toUpperCase()) && !/^GIT_TRACE/i.test(key)))
  env.GIT_OPTIONAL_LOCKS = '0'
  env.GIT_NO_LAZY_FETCH = '1'
  env.GIT_TERMINAL_PROMPT = '0'
  env.GIT_ASKPASS = ''
  return spawnSync('git', ['--no-optional-locks', '-c', 'core.fsmonitor=false', '-C', workspace, ...args],
    { encoding: 'utf8', windowsHide: true, timeout: 3000, maxBuffer: 65536, env })
}

function scratchRepositoryIsolated(workspace) {
  let repository
  for (let cursor = workspace; ; cursor = dirname(cursor)) {
    try {
      statSync(join(cursor, '.git'))
      repository = cursor
      break
    } catch (error) {
      if (error?.code !== 'ENOENT') return false
      if (dirname(cursor) === cursor) return true
    }
  }
  const git = args => readOnlyGit(workspace, args)
  const top = git(['rev-parse', '--show-toplevel'])
  if (top.error || top.status !== 0 || scratchTargetIdentity(top.stdout.trim())?.toLowerCase() !== repository.toLowerCase()) return false
  const head = git(['rev-parse', '--verify', '--quiet', 'HEAD'])
  if (head.error || ![0, 1].includes(head.status)) return false
  const tracked = git(['ls-files', '-z', '--cached', ...(head.status === 0 ? ['--with-tree=HEAD'] : []), '--', SESSION_SCRATCH_DIRECTORY + '/'])
  if (tracked.error || tracked.status !== 0 || tracked.stdout.length !== 0) return false
  const ignored = git(['check-ignore', '--quiet', '--no-index', '--', SESSION_SCRATCH_DIRECTORY + '/'])
  return !ignored.error && ignored.status === 0
}

function sessionScratchPathForActor(ctx, value, agent) {
  const root = sessionScratchCandidateForActor(ctx, agent)
  const identity = scratchTargetIdentity(value)
  if (!root || !identity) return false
  const r = root.toLowerCase(), path = identity.toLowerCase()
  if (!(path === r || path.startsWith(r + sep) || path.startsWith(r + '/'))) return false
  try {
    const stat = statSync(value)
    if (stat.isFile() && stat.nlink > 1) return false
  } catch (error) { if (error?.code !== 'ENOENT') return false }
  return scratchRepositoryIsolated(dirname(dirname(root)))
}

function isReservedSessionScratchPath(value) {
  return typeof value === 'string' && /(?:^|[\\/])\.dsh-verifier-scratch(?:[\\/]|$)/i.test(value)
}

/** A one-turn privilege grant for this member, if one is active. */
function activePrivilege(ctx, config, actor) {
  const agent = actor?.agent
  if (agent === undefined || typeof config.controlDir !== 'string' || config.controlDir.length === 0) return undefined
  try {
    const membership = membershipOf(ctx, agent)
    const name = memberName(ctx, agent)
    if (name === undefined) return undefined
    const control = config.controlPlane ?? controlPlaneForMember(ctx, agent, { directory: config.controlDir })
    return control?.privilegeActive?.(name) ?? undefined
  } catch {
    return undefined
  }
}

/** A plan scope is usable only while its owner holds an active run lease. */
function activePlanScope(ctx, config, actor) {
  const agent = actor?.agent
  if (agent === undefined || typeof config.controlDir !== 'string' || config.controlDir.length === 0) return undefined
  try {
    const membership = membershipOf(ctx, agent)
    const name = memberName(ctx, agent)
    if (name === undefined) return undefined
    const control = config.controlPlane ?? controlPlaneForMember(ctx, agent, { directory: config.controlDir })
    if (control === undefined) return undefined
    const now = Date.now()
    const lease = control.leaseList().find((row) => row.member === name
      && row.status === 'active'
      && row.taskId
      && (!Number(row.expiresAt) || Number(row.expiresAt) > now))
    if (lease === undefined) return undefined
    const plan = control.planState(lease.taskId)
    if (plan === undefined || plan.state !== 'plan-approved' || !Array.isArray(plan.writeScopes)) return undefined
    let worktreePath
    try {
      const boards = control.boardSnapshot?.() ?? {}
      const task = Object.values(boards)
        .flatMap((board) => Object.values(board?.tasks ?? {}))
        .find((row) => String(row?.id ?? '') === String(lease.taskId))
      if (typeof task?.worktreePath === 'string' && isAbsolute(task.worktreePath)) worktreePath = task.worktreePath
    } catch {
      /* worktree metadata is optional; the session cwd remains the fallback */
    }
    return {
      scopes: plan.writeScopes,
      member: name,
      taskId: String(lease.taskId),
      worktreePath,
      tier: Number(membership?.tier ?? -1),
      group: membership?.group === undefined || membership?.group === null ? null : String(membership.group),
    }
  } catch {
    return undefined
  }
}

function leaseDiagnostic(ctx, config, actor) {
  const agent = actor?.agent
  if (agent === undefined || typeof config.controlDir !== 'string' || config.controlDir.length === 0) {
    return 'active lease: unknown'
  }
  try {
    const name = memberName(ctx, agent)
    if (name === undefined) return 'active lease: unknown'
    const control = config.controlPlane ?? controlPlaneForMember(ctx, agent, { directory: config.controlDir })
    if (control === undefined) return 'active lease: unknown'
    const now = Date.now()
    const leases = control.leaseList().filter((row) => String(row?.member ?? '') === String(name))
    const active = leases.find((row) => String(row?.status ?? '').toLowerCase() === 'active'
      && (!Number(row.expiresAt) || Number(row.expiresAt) > now))
    if (active !== undefined) {
      const expiresAt = Number(active.expiresAt)
      return 'active lease: "' + String(active.runId ?? active.leaseId ?? '') + '"'
        + (Number.isFinite(expiresAt) && expiresAt > 0 ? ' until ' + new Date(expiresAt).toISOString() : '')
    }
    const expired = leases
      .filter((row) => String(row?.status ?? '').toLowerCase() === 'expired'
        || (String(row?.status ?? '').toLowerCase() === 'active'
          && Number(row.expiresAt) > 0
          && Number(row.expiresAt) <= now))
      .sort((left, right) => Number(right.expiresAt) - Number(left.expiresAt))[0]
    if (expired !== undefined) {
      const expiresAt = Number(expired.expiresAt)
      return 'active lease: expired at '
        + (Number.isFinite(expiresAt) && expiresAt > 0 ? new Date(expiresAt).toISOString() : 'an unknown time')
        + ' (run "' + String(expired.runId ?? expired.leaseId ?? '') + '")'
    }
    return 'active lease: none'
  } catch {
    return 'active lease: unavailable'
  }
}

function matchesAny(key, prefixes, root) {
  if (prefixes === '*') return true
  if (!Array.isArray(prefixes) || prefixes.length === 0) return false
  for (const prefix of prefixes) {
    if (typeof prefix !== 'string' || prefix.length === 0) continue
    const abs = root ? resolve(root, prefix) : resolve(prefix)
    if (isUnder(key, abs)) return true
  }
  return false
}

/**
 * Candidate roots for one plan scope. The configured root is the deployment
 * fallback; the acting session cwd is the repository/worktree identity DSH
 * actually gives the child. Both are checked because team worktrees live below
 * the repository while the configured root may be the parent workspace.
 */
function scopeRoots(scopes, configuredRoot, actor, executionRoot, activePlan) {
  const roots = []
  const add = (value) => {
    if (typeof value !== 'string' || value.length === 0) return
    const absolute = resolve(value)
    if (!roots.some((candidate) => candidate.toLowerCase() === absolute.toLowerCase())) roots.push(absolute)
  }
  add(scopes.rootDir || configuredRoot)
  add(actor?.agent?.session?.header?.cwd)
  add(executionRoot)
  add(activePlan?.worktreePath)
  return roots
}

function groupDocumentRoots(ctx, actor, roots) {
  const membership = membershipOf(ctx, actor?.agent)
  if (Number(membership?.tier) !== 1 || typeof membership?.group !== 'string' || membership.group.length === 0) return []
  return roots.map((root) => resolve(root, 'docs', 'groups', membership.group))
}

function matchesAnyRoots(key, prefixes, roots) {
  return roots.some((root) => matchesAny(key, prefixes, root))
}

/**
 * Remove Java classpath options before shell mutation scanning. They are
 * read-only inputs, but the short form `-cp` is lexically identical to the
 * Unix copy command and was being reported as a write target.
 */
function stripJavaClasspathOptions(command) {
  return String(command || '').replace(
    /(^|[\s;&|])(?:-cp|-classpath|--class-path)(?:\s+|=)(?:"[^"]*"|'[^']*'|[^\s;&|]+)/gi,
    '$1',
  )
}

/**
 * PowerShell here-strings are data, not shell syntax. Mask their bodies before
 * extracting paths so words in commit messages or other prose are not treated
 * as positional file arguments.
 */
function maskPowerShellHereStrings(command) {
  const source = String(command || '')
  return source.replace(
    /(^|[\r\n])([ \t]*)@(['"])(?:\r?\n)([\s\S]*?)(?:\r?\n)\2\3@/g,
    (match) => match.replace(/[^\r\n]/g, ' '),
  )
}

/**
 * PowerShell comments are not command syntax. Mask them before tokenization
 * so prose after a closing quote is not mistaken for a positional path.
 */
function maskPowerShellComments(command) {
  const source = String(command || '')
  const output = source.split('')
  const blank = (start, end) => {
    for (let index = start; index < end; index += 1) {
      if (output[index] !== '\r' && output[index] !== '\n') output[index] = ' '
    }
  }
  const startsLineComment = (index) => {
    if (source[index] !== '#') return false
    if (index === 0) return true
    const previous = source[index - 1]
    return /[\s;|&(){}]/.test(previous)
  }
  let quote = null
  for (let index = 0; index < source.length;) {
    const char = source[index]
    if (quote !== null) {
      if (quote === "'" && char === "'" && source[index + 1] === "'") {
        index += 2
        continue
      }
      if (quote === '"' && char === '`' && index + 1 < source.length) {
        index += 2
        continue
      }
      if (char === quote) quote = null
      index += 1
      continue
    }
    if (char === '`' && index + 1 < source.length) {
      index += 2
      continue
    }
    if (char === "'" || char === '"') {
      quote = char
      index += 1
      continue
    }
    if (char === '<' && source[index + 1] === '#') {
      const close = source.indexOf('#>', index + 2)
      const end = close < 0 ? source.length : close + 2
      blank(index, end)
      index = end
      continue
    }
    if (startsLineComment(index)) {
      let end = index
      while (end < source.length && source[end] !== '\r' && source[end] !== '\n') end += 1
      blank(index, end)
      index = end
      continue
    }
    index += 1
  }
  return output.join('')
}

function looksLikeWorktreeCheckoutPath(value) {
  const normalized = String(value || '').replace(/\\/g, '/')
  return /(?:^|\/)\.dsh-worktrees\//i.test(normalized)
    || /(?:^|\/)(?:team|grp|level)__[^/]+\//i.test(normalized)
}

/**
 * A missing worktree binding is a different failure from a real scope
 * mismatch. Name it explicitly for tier-1 edit cards that target a managed
 * worktree, so the caller asks for the missing binding instead of trying to
 * widen an already-correct relative scope.
 */
export function worktreeBindingMissingVerdict({ activePlan, targetPath, tier } = {}) {
  if (Number(tier) !== 1) return { missing: false }
  if (typeof activePlan?.worktreePath === 'string' && activePlan.worktreePath.trim().length > 0) {
    return { missing: false }
  }
  if (!looksLikeWorktreeCheckoutPath(targetPath)) return { missing: false }
  return {
    missing: true,
    code: 'worktree-binding-missing',
    detail: 'task "' + String(activePlan?.taskId ?? 'unknown')
      + '" has no bound worktree for member "' + String(activePlan?.member ?? 'unknown')
      + '"; run team_worktree_setup for this task before writing through the managed checkout',
  }
}

/**
 * Tier-1 and tier-2 members must execute inside the worktree bound to their
 * active task. A path prefix alone is not enough: the shared checkout and a
 * member worktree can expose the same relative scope while resolving to
 * different Git HEADs.
 */
export function worktreeCarrierVerdict({ activePlan, tier, carrierPath, requireBinding = false } = {}) {
  const normalizedTier = Number(tier)
  if (!requireBinding && ((normalizedTier !== 1 && normalizedTier !== 2) || activePlan === undefined)) {
    return { ok: true, enforced: false, code: null, detail: null }
  }
  const worktreePath = typeof activePlan?.worktreePath === 'string'
    ? activePlan.worktreePath.trim()
    : ''
  if (worktreePath.length === 0) {
    return {
      ok: false,
      enforced: true,
      code: 'worktree-binding-missing',
      detail: 'task "' + String(activePlan?.taskId ?? 'unknown')
        + '" has no bound worktree for member "' + String(activePlan?.member ?? 'unknown')
        + '"; run team_worktree_setup for this task before writing',
    }
  }
  if (typeof carrierPath !== 'string' || carrierPath.trim().length === 0) {
    return {
      ok: false,
      enforced: true,
      code: 'worktree-carrier-unknown',
      detail: 'the write carrier for tier-' + String(normalizedTier)
        + ' member "' + String(activePlan?.member ?? 'unknown')
        + '" could not be resolved',
    }
  }
  if (!isUnder(carrierPath, worktreePath)) {
    return {
      ok: false,
      enforced: true,
      code: 'worktree-carrier-mismatch',
      detail: 'tier-' + String(normalizedTier)
        + ' member "' + String(activePlan?.member ?? 'unknown')
        + '" is bound to worktree "' + worktreePath
        + '" but the write carrier resolves to "' + carrierPath
        + '"; it is not its own bound worktree',
    }
  }
  return {
    ok: true,
    enforced: true,
    code: null,
    detail: null,
    worktreePath,
    carrierPath,
  }
}

/**
 * Split a PowerShell-like command into tokens without treating quoted text as
 * shell syntax. The old regex parser read `>` inside `git commit -m 'id>=1'`
 * as a redirection and read `-ItemType` as a path. Both mistakes were real
 * fail-open/fail-closed defects, so the parser keeps quote state explicitly.
 */
function tokenizeShellCommand(command) {
  const source = String(command || '')
  const tokens = []
  let current = ''
  let quoted = false
  let quote = null
  const flush = () => {
    if (current.length > 0 || quoted) tokens.push({ value: current, quoted })
    current = ''
    quoted = false
  }
  const readTarget = (start) => {
    let index = start
    let value = ''
    let targetQuoted = false
    let targetQuote = null
    while (index < source.length) {
      const char = source[index]
      if (targetQuote !== null) {
        if (targetQuote === "'" && char === "'" && source[index + 1] === "'") {
          value += "'"
          index += 2
          continue
        }
        if (targetQuote === '"' && char === '`' && index + 1 < source.length) {
          value += source[index + 1]
          index += 2
          continue
        }
        if (char === targetQuote) {
          targetQuote = null
          index += 1
          continue
        }
        value += char
        index += 1
        continue
      }
      if (char === "'" || char === '"') {
        targetQuote = char
        targetQuoted = true
        index += 1
        continue
      }
      if (/\s/.test(char) || char === ';' || char === '|') break
      value += char
      index += 1
    }
    return { value, quoted: targetQuoted, end: index }
  }

  for (let index = 0; index < source.length;) {
    const char = source[index]
    if (quote !== null) {
      if (quote === "'" && char === "'" && source[index + 1] === "'") {
        current += "'"
        index += 2
        continue
      }
      if (quote === '"' && char === '`' && index + 1 < source.length) {
        current += source[index + 1]
        index += 2
        continue
      }
      if (char === quote) {
        quote = null
        index += 1
        continue
      }
      current += char
      index += 1
      continue
    }
    if (char === "'" || char === '"') {
      quote = char
      quoted = true
      index += 1
      continue
    }
    if (char === '(') {
      flush()
      let depth = 1
      let groupQuote = null
      let group = '('
      index += 1
      while (index < source.length && depth > 0) {
        const inner = source[index]
        if (groupQuote !== null) {
          group += inner
          if (groupQuote === '"' && inner === '`' && index + 1 < source.length) {
            group += source[index + 1]
            index += 2
            continue
          }
          if (inner === groupQuote) groupQuote = null
          index += 1
          continue
        }
        if (inner === "'" || inner === '"') {
          groupQuote = inner
          group += inner
          index += 1
          continue
        }
        if (inner === '(') depth += 1
        if (inner === ')') depth -= 1
        group += inner
        index += 1
      }
      tokens.push({ value: group, quoted: false })
      continue
    }
    if (/\s/.test(char)) {
      flush()
      index += 1
      continue
    }
    if (char === ';' || char === '|' || char === '&') {
      flush()
      tokens.push({ separator: true, value: char })
      index += 1
      continue
    }
    if (char === '\r' || char === '\n') {
      flush()
      tokens.push({ separator: true, value: char })
      index += char === '\r' && source[index + 1] === '\n' ? 2 : 1
      continue
    }
    if (char === '>' && source[index + 1] !== '=') {
      flush()
      const operator = source[index + 1] === '>' ? '>>' : '>'
      index += operator.length
      while (index < source.length && /\s/.test(source[index])) index += 1
      const target = readTarget(index)
      tokens.push({ redirect: operator, value: target.value, quoted: target.quoted })
      index = target.end
      continue
    }
    current += char
    index += 1
  }
  flush()
  return tokens
}

function commandletName(value) {
  const name = String(value || '').split(/[\\/]/).pop()?.toLowerCase() ?? ''
  if (name === 'ni') return 'new-item'
  return [
    'set-content', 'add-content', 'out-file', 'new-item', 'remove-item',
    'move-item', 'copy-item', 'rename-item', 'set-item', 'tee-object',
    'export-csv', 'export-clixml',
  ].includes(name) ? name : null
}

const POWERSHELL_READONLY_COMMANDS = new Set([
  'compare-object', 'convertfrom-json', 'convertto-json', 'foreach-object',
  'get-alias', 'get-childitem', 'get-ciminstance', 'get-command', 'get-content',
  'get-date', 'get-filehash', 'get-help', 'get-item', 'get-itemproperty',
  'get-location', 'get-member', 'get-module', 'get-nettcpconnection',
  'get-process', 'get-psdrive', 'get-service', 'get-variable', 'get-volume',
  'join-path', 'measure-object', 'out-string', 'read-host', 'resolve-dnsname',
  'resolve-path', 'select-object', 'select-string', 'sort-object', 'split-path',
  'start-sleep', 'test-connection', 'test-json', 'test-netconnection',
  'test-path', 'wait-process', 'where-object',
])

const POWERSHELL_VERB_NAMES = new Set([
  'write-output', 'write-host', 'write-error', 'write-warning', 'write-verbose',
  'write-debug', 'write-information', 'write-progress',
])

const WRITE_SHAPED_SWITCHES = new Set([
  '-path', '-literalpath', '-filepath', '-destination', '-newname',
])

function unknownCommandletName(value) {
  const name = String(value || '').split(/[\\/]/).pop()?.toLowerCase() ?? ''
  if (!/^[a-z]+-[a-z][a-z0-9]*$/.test(name)) return null
  if (POWERSHELL_READONLY_COMMANDS.has(name) || POWERSHELL_VERB_NAMES.has(name)) return null
  return name
}

function switchName(value) {
  const raw = String(value || '').toLowerCase()
  const separatorAt = raw.search(/[:=]/)
  return separatorAt < 0 ? raw : raw.slice(0, separatorAt)
}

const VALUE_SWITCHES = new Set([
  '-path', '-literalpath', '-filepath', '-destination', '-newname', '-name',
  '-value', '-inputobject', '-encoding', '-stream', '-filter', '-include',
  '-exclude', '-credential', '-itemtype', '-type', '-delimiter', '-variable',
  '-depth', '-quotefields', '-useculture',
])

const BOOLEAN_SWITCHES = new Set([
  '-force', '-recurse', '-append', '-nonewline', '-passthru', '-whatif',
  '-confirm', '-container', '-notypeinformation', '-includetypeinformation',
  '-noclobber', '-asbytestream', '-useculture', '-usetransaction',
])

function splitCallArguments(source) {
  const values = []
  let current = ''
  let quote = null
  let depth = 0
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index]
    if (quote !== null) {
      current += char
      if (quote === '"' && char === '\\' && index + 1 < source.length) {
        current += source[++index]
        continue
      }
      if (char === quote) quote = null
      continue
    }
    if (char === "'" || char === '"') {
      quote = char
      current += char
      continue
    }
    if (char === '(' || char === '[' || char === '{') depth += 1
    if (char === ')' || char === ']' || char === '}') depth -= 1
    if (char === ',' && depth === 0) {
      values.push(current.trim())
      current = ''
      continue
    }
    current += char
  }
  if (current.trim().length > 0) values.push(current.trim())
  return values
}

/**
 * Remove JavaScript/Python string literals and comments before looking for
 * mutation APIs. A report or test fixture may contain the literal text
 * "writeFile" without executing it; that text must not become a denial.
 */
function stripCodeLiteralsAndComments(value) {
  const source = String(value ?? '')
  let output = ''
  let quote = null
  let escaped = false
  let lineComment = false
  let blockComment = false
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index]
    const next = source[index + 1]
    if (lineComment) {
      if (char === '\n') {
        lineComment = false
        output += '\n'
      }
      continue
    }
    if (blockComment) {
      if (char === '*' && next === '/') {
        blockComment = false
        output += ' '
        index += 1
      }
      continue
    }
    if (quote !== null) {
      if (escaped) {
        escaped = false
        continue
      }
      if (char === '\\') {
        escaped = true
        continue
      }
      if (char === quote) quote = null
      continue
    }
    if (char === '/' && next === '/') {
      lineComment = true
      index += 1
      continue
    }
    if (char === '/' && next === '*') {
      blockComment = true
      index += 1
      continue
    }
    if (char === "'" || char === '"' || char === '`') {
      quote = char
      output += ' '
      continue
    }
    output += char
  }
  return output
}

function literalArgument(value) {
  const raw = String(value || '').trim()
  if (raw.length === 0) return null
  if ((raw.startsWith('"') && raw.endsWith('"')) || (raw.startsWith("'") && raw.endsWith("'"))) {
    const quote = raw[0]
    const body = raw.slice(1, -1)
    const knownTemp = /\$(?:env:)?(?:TEMP|TMP)\b|%(?:TEMP|TMP)%/i.test(body)
    if (body.includes('$(') || body.includes('`') || (body.includes('$') && !knownTemp)) return null
    return quote === "'" ? body.replace(/''/g, "'") : body.replace(/\\"/g, '"')
  }
  const knownTemp = /\$(?:env:)?(?:TEMP|TMP)\b|%(?:TEMP|TMP)%/i.test(raw)
  if (raw.includes('`') || raw.includes('(') || (raw.includes('$') && !knownTemp)) return null
  return raw
}

function dotNetWriteTargets(text, cwd, add, markOpaque) {
  const pattern = /\[System\.IO\.(File|Directory)\]::([A-Za-z0-9_]+)\s*\(/gi
  let match
  while ((match = pattern.exec(text)) !== null) {
    let quoteState = null
    let quotedMatch = false
    for (let index = 0; index < match.index; index += 1) {
      const char = text[index]
      if (quoteState !== null) {
        if (quoteState === '"' && char === '\\') {
          index += 1
          continue
        }
        if (char === quoteState) quoteState = null
      } else if (char === "'" || char === '"') {
        quoteState = char
      }
    }
    if (quoteState !== null) quotedMatch = true
    if (quotedMatch) continue
    const open = match.index + match[0].length
    let depth = 1
    let quote = null
    let close = -1
    for (let index = open; index < text.length; index += 1) {
      const char = text[index]
      if (quote !== null) {
        if (quote === '"' && char === '\\' && index + 1 < text.length) {
          index += 1
          continue
        }
        if (char === quote) quote = null
        continue
      }
      if (char === "'" || char === '"') {
        quote = char
        continue
      }
      if (char === '(') depth += 1
      if (char === ')') {
        depth -= 1
        if (depth === 0) {
          close = index
          break
        }
      }
    }
    if (close < 0) {
      markOpaque()
      continue
    }
    const args = splitCallArguments(text.slice(open, close))
    const method = String(match[2] || '').toLowerCase()
    const indexes = method === 'copy'
      ? [1]
      : method === 'replace'
        ? [1, 2]
        : method === 'move'
          ? [0, 1]
          : [0]
    for (const index of indexes) {
      const literal = literalArgument(args[index])
      if (literal === null) {
        markOpaque()
        continue
      }
      add(literal)
    }
    pattern.lastIndex = close + 1
  }
}

function zipWriteTargets(text, cwd, add, markOpaque) {
  const pattern = /\[System\.IO\.Compression\.(?:ZipFile|ZipFileExtensions)\]::([A-Za-z0-9_]+)\s*\(/gi
  let match
  while ((match = pattern.exec(text)) !== null) {
    const open = match.index + match[0].length
    let depth = 1
    let quote = null
    let close = -1
    for (let index = open; index < text.length; index += 1) {
      const char = text[index]
      if (quote !== null) {
        if (quote === '"' && char === '\\' && index + 1 < text.length) {
          index += 1
          continue
        }
        if (char === quote) quote = null
        continue
      }
      if (char === "'" || char === '"') {
        quote = char
        continue
      }
      if (char === '(') depth += 1
      if (char === ')') {
        depth -= 1
        if (depth === 0) {
          close = index
          break
        }
      }
    }
    if (close < 0) {
      markOpaque()
      continue
    }
    const method = String(match[1] || '').toLowerCase()
    const indexes = method === 'extracttofile'
      ? [1]
      : method === 'extracttodirectory'
        ? [1]
        : method === 'createfromdirectory'
          ? [1]
          : [0]
    const args = splitCallArguments(text.slice(open, close))
    for (const index of indexes) {
      const literal = literalArgument(args[index])
      if (literal === null) {
        markOpaque()
        continue
      }
      add(literal)
    }
    pattern.lastIndex = close + 1
  }
}

function interpreterCode(command) {
  const source = String(command || '')
  const match = source.match(/(?:^|[;&|]\s*)(?:python|python3|py|node|ruby|perl)\b[^\r\n]*?(?:\s-[A-Za-z]*[ce]\b|--eval\b|--command\b)\s+(?:"([\s\S]*?)"|'([\s\S]*?)'|([^\r\n]+))/i)
  if (!match) return null
  return match[1] ?? match[2] ?? match[3] ?? ''
}

function processOutputTargets(tokens, cwd, add) {
  const outputFlags = new Set([
    '--out', '--output', '--output-dir', '--out-dir', '--artifact', '--artifact-dir',
    '--write', '--write-to', '--log', '--log-file', '--cache-dir', '--target-dir',
    '--gen-fixtures', '--emit-fixture-manifest',
    '-o', '-w',
  ])
  let commandName = ''
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index]
    if (token.separator === true) {
      commandName = ''
      continue
    }
    if (token.redirect !== undefined) continue
    const value = String(token.value || '')
    const lowerValue = value.toLowerCase()
    if (commandName.length === 0 && !value.startsWith('-')) {
      commandName = value.split(/[\\/]/).pop()?.replace(/\.exe$/i, '').toLowerCase() ?? ''
      continue
    }
    if (outputFlags.has(lowerValue)) {
      // `git ls-files -o` and `git grep -w` are read-only flags, not
      // process output paths. Short output flags are too ambiguous to apply
      // outside the compiler/tool family they were intended for.
      if (commandName === 'git' && (lowerValue === '-o' || lowerValue === '-w')) continue
      const next = tokens[index + 1]
      if (next !== undefined && next.separator !== true && next.redirect === undefined) {
        add(next.value)
        index += 1
      }
      continue
    }
    for (const flag of outputFlags) {
      if (lowerValue.startsWith(flag + '=')) {
        add(value.slice(flag.length + 1))
        break
      }
    }
  }
}

export function gitWriteCommand(command) {
  return gitWriteCarriers(command, process.cwd()).length > 0
}

// Keep each invocation's carrier; checking only the first -C misses later
// commands and resolving a scratch prefix misses the repository's real HEAD.
function gitWriteCarriers(command, cwd) {
  const tokens = tokenizeShellCommand(command)
  const carriers = []
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index]
    if (token.separator || token.redirect !== undefined) continue
    if (index > 0 && tokens[index - 1]?.separator !== true) continue
    if (!/^git(?:\.exe)?$/i.test(basename(String(token.value)))) continue
    let carrier = resolve(cwd || process.cwd()), known = true
    for (let cursor = index + 1; cursor < tokens.length && !tokens[cursor].separator; cursor += 1) {
      const value = String(tokens[cursor].value)
      if (value === '-C' || value === '-c') {
        const next = tokens[++cursor]
        if (!next || next.separator || next.redirect !== undefined) { known = false; break }
        if (value === '-C') {
          if (looksLikeDynamicPathExpression(next.value, new Map())) known = false
          else carrier = resolve(carrier, String(next.value))
        } else known = false // Command-local config can change repository routing.
        continue
      }
      if (['--no-optional-locks', '--no-pager', '--literal-pathspecs'].includes(value)) continue
      if (value.startsWith('-')) { known = false; continue }
      if (/^(add|commit)$/i.test(value)) carriers.push(known ? carrier : null)
      break
    }
  }
  return carriers
}

/** Resolve the effective checkout for a supported git write command. */
export function gitCommandWorkdir(command, cwd) {
  const segments = String(command || '').split(/[;&|\r\n]+/)
  for (const segment of segments) {
    const normalized = segment.trim().replace(/^(?:&\s*)+/, '')
    const match = normalized.match(
      /^git(?:\.exe)?\s+-C\s+(?:"([^"]+)"|'([^']+)'|(\S+))\s+(?:add|commit)\b/i,
    )
    if (match === null) continue
    const value = match[1] ?? match[2] ?? match[3]
    if (value !== undefined) return resolve(cwd || process.cwd(), value)
  }
  return null
}

const MAX_SCRIPT_FILE_BYTES = 1024 * 1024
const MAX_SCRIPT_FILE_DEPTH = 8

function powershellExecutable(value) {
  const name = basename(String(value || '')).toLowerCase()
  return name === 'pwsh' || name === 'pwsh.exe' || name === 'powershell' || name === 'powershell.exe'
}

function inlineShellCode(command) {
  const text = maskPowerShellHereStrings(stripJavaClasspathOptions(command)).trim()
  if (text.length === 0) return false
  const tokens = tokenizeShellCommand(text)
  const first = tokens.find((token) => token.separator !== true && token.redirect === undefined)
  if (first === undefined) return false
  const executable = basename(String(first.value || '')).toLowerCase()
  if (powershellExecutable(executable)) {
    return tokens.some((token) => {
      if (token.separator === true || token.redirect !== undefined) return false
      const value = String(token.value || '').toLowerCase()
      return value === '-command'
        || value === '-c'
        || value.startsWith('-command:')
        || value.startsWith('-command=')
        || value === '-encodedcommand'
        || value.startsWith('-encodedcommand:')
        || value.startsWith('-encodedcommand=')
    })
  }
  if (!['bash', 'bash.exe', 'sh', 'sh.exe', 'zsh', 'zsh.exe'].includes(executable)) return false
  return tokens.some((token) => {
    if (token.separator === true || token.redirect !== undefined) return false
    const value = String(token.value || '').toLowerCase()
    return value === '-c' || /^-[a-z]*c[a-z]*$/.test(value)
  })
}

function explicitPowerShellFileScript(command, cwd) {
  const text = maskPowerShellHereStrings(stripJavaClasspathOptions(command)).trim()
  if (text.length === 0 || /[\r\n]/.test(text)) return null
  const tokens = tokenizeShellCommand(text)
  if (tokens.length === 0) return null
  if (tokens.some((token) => token.separator === true || token.redirect !== undefined)) return null
  const first = tokens.find((token) => token.separator !== true && token.redirect === undefined)
  if (first === undefined || !powershellExecutable(first.value)) return null
  let script = null
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index]
    if (token.separator === true || token.redirect !== undefined) continue
    const value = String(token.value || '')
    const lower = value.toLowerCase()
    if (lower === '-command' || lower === '-c'
      || lower.startsWith('-command:') || lower.startsWith('-command=')
      || lower === '-encodedcommand'
      || lower.startsWith('-encodedcommand:') || lower.startsWith('-encodedcommand=')) return null
    let rawScript
    if (lower === '-file' || lower === '-f') {
      const next = tokens[index + 1]
      if (next === undefined || next.separator === true || next.redirect !== undefined) return null
      rawScript = String(next.value || '')
      index += 1
    } else if (lower.startsWith('-file:') || lower.startsWith('-file=')) {
      rawScript = value.slice(value.indexOf(':') >= 0 ? value.indexOf(':') + 1 : value.indexOf('=') + 1)
    }
    if (rawScript === undefined) continue
    if (script !== null || looksLikeDynamicPathExpression(rawScript, new Map())) return null
    script = resolve(cwd || process.cwd(), rawScript)
  }
  return script
}

/**
 * A top-level `pwsh -File <tracked script>` is a sanctioned execution
 * carrier when the script itself is covered by the active plan. Runtime path
 * construction inside the approved script cannot be fully reduced statically;
 * trusting the approved script file is narrower than allowing arbitrary
 * inline interpreters, and all shell-level redirection/composition remains
 * denied by explicitPowerShellFileScript().
 */
export function scopedPowerShellFileVerdict({ command, cwd, activePlan, roots } = {}) {
  if (activePlan === undefined || !Array.isArray(activePlan.scopes)) {
    return { ok: false, code: 'active-plan-required', detail: 'an active approved plan is required' }
  }
  if (inlineShellCode(command)) {
    return { ok: false, code: 'inline-shell-code', detail: 'inline shell code is not a scoped -File script' }
  }
  const script = explicitPowerShellFileScript(command, cwd)
  if (script === null) {
    return { ok: false, code: 'explicit-file-required', detail: 'the command is not a single explicit pwsh -File invocation' }
  }
  let stat
  let realPath
  try {
    stat = statSync(script)
    if (!stat.isFile() || stat.size > MAX_SCRIPT_FILE_BYTES) {
      return { ok: false, code: 'script-invalid', detail: 'the script is not a bounded regular file' }
    }
    realPath = realpathSync(script)
    const scriptBytes = readFileSync(realPath)
    if (scriptBytes.includes(0)) {
      return { ok: false, code: 'script-invalid', detail: 'the script is not UTF-8 text' }
    }
    new TextDecoder('utf-8', { fatal: true }).decode(scriptBytes)
  } catch {
    return { ok: false, code: 'script-invalid', detail: 'the script cannot be read' }
  }
  if (!matchesAnyRoots(realPath, activePlan.scopes, Array.isArray(roots) ? roots : [])) {
    return { ok: false, code: 'script-outside-plan-scope', detail: 'the script is outside the active plan write scope' }
  }
  return { ok: true, code: 'scoped-script', scriptPath: realPath }
}

function resolveScriptReference(raw, variables) {
  let resolved = resolvePathExpression(raw, variables)
  for (const [name, value] of variables) {
    if (resolved.includes(name)) resolved = resolved.split(name).join(value)
  }
  return resolved
}

function scriptFileReferences(tokens, variables) {
  const references = []
  let opaque = false
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index]
    if (token.separator === true) continue
    const previous = tokens[index - 1]
    if (!(index === 0 || previous?.separator === true)) continue
    const invoked = String(token.value || '')
    if (!powershellExecutable(invoked)) {
      const resolved = resolveScriptReference(invoked, variables)
      if (/\.ps1(?:$|[\s?])/i.test(resolved)) {
        if (/[$`]/.test(resolved)) opaque = true
        else references.push(resolved)
      }
      continue
    }
    let end = index + 1
    while (end < tokens.length && tokens[end].separator !== true) end += 1
    for (let cursor = index + 1; cursor < end; cursor += 1) {
      const raw = String(tokens[cursor]?.value || '')
      const lower = raw.toLowerCase()
      if (lower === '-file' || lower === '-f') {
        const next = tokens[cursor + 1]
        if (next !== undefined && next.separator !== true && next.redirect === undefined) {
          references.push(String(next.value || ''))
          cursor += 1
        }
        continue
      }
      if (lower.startsWith('-file:') || lower.startsWith('-file=')) {
        references.push(raw.slice(raw.indexOf(':') >= 0 ? raw.indexOf(':') + 1 : raw.indexOf('=') + 1))
      }
    }
  }
  return { references, opaque }
}

function scriptFileWriteTargets(tokens, cwd, options = {}) {
  const depth = Number(options.depth ?? 0)
  const visited = options.visited instanceof Set ? options.visited : new Set()
  const inheritedVariables = options.variables instanceof Map ? options.variables : new Map()
  const result = { targets: [], opaque: false, gitWrite: false, gitCarriers: [], blockedMutation: false, directoryChange: false }
  if (depth >= MAX_SCRIPT_FILE_DEPTH) return { ...result, opaque: true }
  const references = scriptFileReferences(tokens, inheritedVariables)
  result.opaque = references.opaque
  for (const reference of references.references) {
    const scriptPath = resolve(cwd || process.cwd(), reference)
    let stat
    try {
      stat = statSync(scriptPath)
    } catch {
      result.opaque = true
      continue
    }
    if (!stat.isFile() || stat.size > MAX_SCRIPT_FILE_BYTES) {
      result.opaque = true
      continue
    }
    let realPath
    try {
      realPath = realpathSync(scriptPath)
    } catch {
      result.opaque = true
      continue
    }
    if (visited.has(realPath)) {
      result.opaque = true
      continue
    }
    let source
    try {
      const bytes = readFileSync(realPath)
      if (bytes.includes(0)) {
        result.opaque = true
        continue
      }
      source = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
    } catch {
      result.opaque = true
      continue
    }
    const variables = new Map(inheritedVariables)
    variables.set('$PSScriptRoot', dirname(realPath))
    variables.set('$PSCommandPath', realPath)
    const parsed = shellWriteTargets(source, dirname(realPath), {
      scriptDepth: depth + 1,
      visitedScripts: new Set([...visited, realPath]),
      pathVariables: variables,
      strictScratch: options.strictScratch,
    })
    result.targets.push(...parsed.targets)
    result.opaque = result.opaque || parsed.opaque
    result.gitWrite = result.gitWrite || parsed.gitWrite
    result.gitCarriers.push(...parsed.gitCarriers)
    result.blockedMutation = result.blockedMutation || parsed.blockedMutation
    result.directoryChange = result.directoryChange || parsed.directoryChange
  }
  return result
}

/** Extract likely write targets from a shell command. Conservative by design:
 * only explicit mutation syntax is considered, so read-only commands stay free.
 */
export function shellWriteTargets(command, cwd, options = {}) {
  const text = maskPowerShellComments(maskPowerShellHereStrings(stripJavaClasspathOptions(command)))
  const found = new Set()
  let opaque = false
  let gitWrite = false
  const variables = knownPathVariables(text, options.pathVariables)
  const add = (raw) => {
    if (looksLikeDynamicPathExpression(raw, variables)) {
      opaque = true
      return
    }
    const value = resolvePathExpression(raw, variables)
    if (value.length === 0 || value === '-') return
    const bare = String(value).split(/[\\/]/).pop()?.toLowerCase() ?? ''
    if (POWERSHELL_VERB_NAMES.has(bare)) return
    if (value.includes('$(') || value.includes('`') || /[$`]/.test(value)) {
      opaque = true
      return
    }
    if (value.startsWith('$') || value.startsWith('%')) {
      opaque = true
      return
    }
    if (/^[A-Za-z]+:\/\//.test(value)) return
    if (value === '/dev/null' || value.toLowerCase() === 'nul') return
    found.add(resolve(cwd || process.cwd(), value))
  }
  const inlineCode = interpreterCode(text)
  if (inlineCode !== null && runCodeWriteRisk(inlineCode).opaque) opaque = true
  if (inlineShellCode(text)) opaque = true

  const tokens = tokenizeShellCommand(text)
  const directoryChange = tokens.some((token, index) =>
    (!token.quoted || index === 0 || tokens[index - 1]?.separator === true)
    && /^(cd|chdir|sl|set-location|pushd|popd|push-location|pop-location)$/i.test(basename(String(token.value ?? ''))))
  const scriptWrites = scriptFileWriteTargets(tokens, cwd, {
    depth: Number(options.scriptDepth ?? 0),
    visited: options.visitedScripts,
    variables,
    strictScratch: options.strictScratch,
  })
  for (const target of scriptWrites.targets) found.add(target)
  opaque = opaque || scriptWrites.opaque
  gitWrite = gitWrite || scriptWrites.gitWrite
  let blockedMutation = scriptWrites.blockedMutation
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index]
    if (token.separator !== true || token.value !== '&') continue
    const next = tokens[index + 1]
    if (next === undefined || next.separator === true) continue
    const invoked = String(next.value || '').trim()
    if (invoked.startsWith('$') || invoked.startsWith('(') || invoked.startsWith('[')) {
      const resolvedInvoked = resolveScriptReference(invoked, variables)
      if (!(/\.ps1(?:$|[\s?])/i.test(resolvedInvoked) && !/[$`]/.test(resolvedInvoked))) {
        opaque = true
      }
    }
  }
  for (const token of tokens) {
    if (token.redirect !== undefined) {
      const target = String(token.value || '').trim()
      if (target === '&1' || target === '&2' || target === '$null') continue
      add(target)
    }
  }

  dotNetWriteTargets(text, cwd, add, () => { opaque = true })
  zipWriteTargets(text, cwd, add, () => { opaque = true })
  processOutputTargets(tokens, cwd, add)

  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index]
    const name = commandletName(token?.value)
    if (name === null) {
      const previous = tokens[index - 1]
      const commandStart = index === 0 || previous?.separator === true
      if (commandStart && unknownCommandletName(token?.value) !== null) {
        let end = index + 1
        while (end < tokens.length && tokens[end].separator !== true) end += 1
        for (let cursor = index + 1; cursor < end; cursor += 1) {
          const value = String(tokens[cursor]?.value || '')
          if (value.startsWith('-') && WRITE_SHAPED_SWITCHES.has(switchName(value))) {
            opaque = true
            break
          }
        }
      }
      continue
    }
    let end = index + 1
    while (end < tokens.length && tokens[end].separator !== true) end += 1
    const values = new Map()
    const positional = []
    for (let cursor = index + 1; cursor < end; cursor += 1) {
      const token = tokens[cursor]
      if (token.redirect !== undefined) continue
      const value = String(token.value || '')
      if (value.startsWith('-') && value.length > 1) {
        const rawFlag = value.toLowerCase()
        const separatorAt = rawFlag.search(/[:=]/)
        const flag = separatorAt < 0 ? rawFlag : rawFlag.slice(0, separatorAt)
        const inlineValue = separatorAt < 0 ? undefined : value.slice(separatorAt + 1)
        const next = tokens[cursor + 1]
        if (inlineValue !== undefined) {
          values.set(flag, inlineValue)
        } else if (VALUE_SWITCHES.has(flag)
          && next !== undefined
          && next.separator !== true
          && !String(next.value || '').startsWith('-')) {
          values.set(flag, next.value)
          cursor += 1
        } else {
          values.set(flag, true)
        }
      } else {
        positional.push(value)
      }
    }
    const path = values.get('-path') ?? values.get('-literalpath') ?? values.get('-filepath')
    const destination = values.get('-destination')
    const newName = values.get('-newname')
    const nameValue = values.get('-name')
    if (options.strictScratch && name === 'new-item') {
      const type = values.get('-itemtype') ?? values.get('-type')
      const unknown = [...values.keys()].some(flag => !VALUE_SWITCHES.has(flag) && !BOOLEAN_SWITCHES.has(flag))
      if (unknown || (type !== undefined && !/^(file|directory)$/i.test(String(type)))) blockedMutation = true
    }
    if (name === 'new-item' && path !== undefined && nameValue !== undefined && nameValue !== true) {
      add(join(resolve(cwd || process.cwd(), String(path)), String(nameValue)))
    } else if (name === 'rename-item') {
      const original = path ?? positional[0]
      const renamed = newName ?? positional[1]
      if (original !== undefined) {
        const source = resolve(cwd || process.cwd(), String(original))
        add(String(original))
        if (renamed !== undefined && renamed !== true) add(resolve(dirname(source), String(renamed)))
      }
    } else {
      if (name === 'copy-item' || name === 'move-item') {
        if (name === 'move-item') {
          const source = path ?? positional[0]
          if (source !== undefined) add(String(source))
        }
        const target = destination ?? positional[1] ?? positional[0]
        if (target !== undefined) add(String(target))
      } else {
        const primary = path ?? positional[0]
        if (primary !== undefined) add(String(primary))
        if (destination !== undefined) add(String(destination))
      }
    }
    index = end - 1
  }
  gitWrite = gitWrite || gitWriteCommand(text)
  return { targets: [...found], opaque, gitWrite,
    gitCarriers: [...scriptWrites.gitCarriers, ...gitWriteCarriers(text, cwd)], blockedMutation,
    directoryChange: directoryChange || scriptWrites.directoryChange }
}

/**
 * `run_code` is an outer JavaScript execution surface. Nested controlled
 * tools are safe because each child dispatch runs the same pre-execute/fs
 * intent hooks; only recursive `run_code` is refused as an opaque escape.
 * Direct filesystem/process access is still rejected because it bypasses those
 * hooks.
 */
export function runCodeWriteRisk(code) {
  const source = stripCodeLiteralsAndComments(code)
  const checks = [
    [/\b(?:writeFile|writeFileSync|appendFile|appendFileSync|createWriteStream|mkdir|mkdirSync|rm|rmSync|rmdir|rmdirSync|unlink|unlinkSync|rename|renameSync|copyFile|copyFileSync|chmod|chmodSync|truncate|truncateSync|openSync|writeSync)\s*\(/i, 'direct filesystem mutation API'],
    [/\btools\s*\.\s*run_code\s*\(/i, 'nested run_code dispatch'],
    [/(?<!\.)\b(?:spawn|exec|execSync|execFile|fork)\s*\(/i, 'process execution'],
    [/\bprocess\.(?:getBuiltinModule|binding)\s*\(/i, 'runtime module escape'],
    [/\b(?:Deno|Bun)\.(?:write|writeTextFile|remove|mkdir|rename|copyFile)\b/i, 'runtime filesystem mutation API'],
    [/\b(?:open|fopen)\s*\([^)]*['"](?:w|a|x|wb|ab|xb)['"]/i, 'low-level write mode'],
  ]
  const found = checks.find(([pattern]) => pattern.test(source))
  return found ? { opaque: true, reason: found[1] } : { opaque: false, reason: null }
}

/**
 * Register the two mutation guards.
 * @param ctx - cordis plugin context.
 * @param config - this plugin row's config.
 */
export function apply(ctx, config = {}) {
  const scopesFile = typeof config.scopesFile === 'string' ? config.scopesFile : null
  const enforce = config.enforce !== false
  const configuredRoot = typeof config.rootDir === 'string' ? config.rootDir : undefined
  const controlPlane = config.controlPlane
  const scratchMode = config.verifierScratchMode ?? 'legacy'
  if (!['legacy', 'session-workspace'].includes(scratchMode)) throw new Error('INVALID_VERIFIER_SCRATCH_MODE')
  const actorScratch = (value, agent) => scratchMode === 'session-workspace'
    ? sessionScratchPathForActor(ctx, value, agent)
    : verifierScratchPathForActor(ctx, value, agent, config.verifierScratchRoot)

  if (scratchMode === 'session-workspace') {
    const installed = new Map()
    const install = agent => {
      if (installed.has(agent) || typeof agent?.ctx?.tools?.register !== 'function') return
      installed.set(agent, agent.ctx.tools.register(defineTool({
        name: 'verifier_scratch',
        description: 'Return the authenticated verifier session scratch directory inside its current workspace. A Git workspace must already ignore .dsh-verifier-scratch/ with no scratch files in its index or HEAD. Read-only; does not create files, edit Git configuration, grant scopes, or change sandbox mode. Use controlled read/write/edit tools for artifacts, not product files.',
        parameters: {},
        output: { schema: { type: 'object', additionalProperties: true }, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] },
        execute: (_args, exec) => {
          const root = exec?.agent === agent ? sessionScratchCandidateForActor(ctx, agent) : undefined
          if (root === undefined) return { ok: false, code: 'verifier-scratch-unavailable' }
          if (!scratchRepositoryIsolated(dirname(dirname(root)))) return { ok: false, code: 'verifier-scratch-repository-isolation-required' }
          return { ok: true, root, ownerSessionId: agent.session.id }
        },
      })))
    }
    for (const agent of ctx.agents?.list?.() ?? []) install(agent)
    ctx.on('agent/created', ({ agent }) => install(agent))
    ctx.on('agent/disposed', ({ agent }) => { installed.get(agent)?.(); installed.delete(agent) })
    ctx.effect?.(() => () => { for (const stop of installed.values()) stop?.(); installed.clear() })
  }

  const note = (message) => {
    try {
      if (ctx.logger && typeof ctx.logger.warn === 'function') ctx.logger.warn('[write-scope-guard] ' + message)
    } catch {
      /* logging must never break the guard */
    }
  }

  const deny = (message) => {
    if (enforce) throw new FsError(message, 'FS_WRITE_OUT_OF_SCOPE')
    note(message)
    return undefined
  }

  const commandVerificationMessage = (name, agent, verdict) => {
    const code = String(verdict?.code ?? 'unverifiable')
    const detail = String(verdict?.detail ?? 'the command target cannot be derived safely')
    const suffix = '; use a single explicit pwsh -File script covered by an active approved plan, or the controlled write/edit tools for file changes'
    if (code === 'active-plan-required') {
      return name + ' denied: command verification failed [' + code + ']: ' + detail
        + '; member "' + String(memberName(ctx, agent) ?? 'unknown')
        + '" has no declared static scope or active approved plan lease for this command; '
        + leaseDiagnostic(ctx, config, { agent }) + suffix
    }
    if (code === 'inline-shell-code') {
      return name + ' denied: the command can write through an inline interpreter or opaque expression, so its target cannot be verified against the write scope' + suffix
    }
    return name + ' denied: command verification failed [' + code + ']: ' + detail
      + '; the target cannot be verified against the write scope' + suffix
  }

  const check = (target, actor, verb, executionRoot) => {
    const scopes = readScopes(scopesFile)
    if (enforce && !scopes.valid) throw new FsError('write scope configuration is invalid: ' + scopes.error, 'FS_WRITE_SCOPE_CONFIG_INVALID')
    const display = target.displayPath || target.targetKey
    const privilege = activePrivilege(ctx, config, actor)
    if (privilege !== undefined && privilege !== null) return undefined
    const staticAllow = scopeOf(ctx, scopes, actor)
    // "*" is the documented operator override and must not be narrowed by a
    // task lease. This keeps tier-0 root usable while members still inherit
    // their approved-plan scopes.
    if (staticAllow === '*') return undefined
    if (scratchMode === 'session-workspace'
      && (isReservedSessionScratchPath(display) || isReservedSessionScratchPath(target.targetKey))) {
      if (actorScratch(display, actor?.agent) && actorScratch(target.targetKey || display, actor?.agent)) return undefined
      return deny(verb + ' denied: verifier-session-scratch-owner-or-path-mismatch; target="' + display + '"')
    }
    const activePlan = activePlanScope(ctx, config, actor)
    const planAllow = activePlan?.scopes
    const allow = staticAllow === undefined ? planAllow : staticAllow
    const roots = scopeRoots(scopes, configuredRoot, actor, executionRoot, activePlan)
    // TEMP is a convenience exception only for artifacts outside the actual
    // workspace. A checkout under TEMP is still a workspace: treating it as a
    // blanket allow would make every file in that checkout writable.
    const key = target.targetKey || display
    const membership = membershipOf(ctx, actor?.agent)
    if (isTemporaryPath(key) && !roots.some((root) => isUnder(key, root))) return undefined
    if (isEvidenceCheckoutPath(key, membership) && !roots.some((root) => isUnder(key, root))) return undefined
    if (actorScratch(key, actor?.agent)) return undefined

    const missingBinding = worktreeBindingMissingVerdict({
      activePlan,
      targetPath: key,
      tier: membership?.tier,
    })
    if (missingBinding.missing === true) {
      return deny(verb + ' denied: worktree-binding-missing: ' + missingBinding.detail
        + '; target="' + display + '"')
    }

    // Tier-2 members must execute in their own git worktree. Falling back to
    // the shared checkout lets them commit directly to the integration branch
    // and bypasses the member-branch -> lead-merge workflow.
    if (Number(membership?.tier) === 2) {
      if (typeof activePlan?.worktreePath !== 'string' || activePlan.worktreePath.length === 0) {
        return deny(verb + ' denied: tier-2 member "' + String(membership.name ?? 'unknown')
          + '" has no active worktree binding for this write; acquire the task lease (which creates/synchronizes the member worktree) or run team_worktree_setup before writing')
      }
      const expectedWorktree = membership.group && membership.name
        ? 'team__' + String(membership.group) + '__' + String(membership.name)
        : null
      if (expectedWorktree !== null
        && basename(normalize(activePlan.worktreePath)).toLowerCase() !== expectedWorktree.toLowerCase()) {
        return deny(verb + ' denied: tier-2 member "' + String(membership.name)
          + '" is bound to worktree "' + activePlan.worktreePath
          + '" which is not its own "' + expectedWorktree + '" checkout')
      }
      roots.splice(0, roots.length, resolve(activePlan.worktreePath))
    }

    const carrierVerdict = worktreeCarrierVerdict({
      activePlan,
      tier: membership?.tier,
      carrierPath: key,
    })
    if (carrierVerdict.ok !== true) {
      return deny(verb + ' denied: ' + carrierVerdict.code + ': ' + carrierVerdict.detail
        + '; target="' + display + '"')
    }

    const groupRoots = groupDocumentRoots(ctx, actor, roots)
    if (groupRoots.some((root) => isUnder(key, root))) return undefined

    // A live approved task narrows the static grant to its declared writeScopes.
    // This is the only path by which a default-deny member receives execution
    // access; the lease binds the scope to one task and one member.
    if (planAllow !== undefined && !matchesAnyRoots(key, planAllow, roots)) {
      return deny(verb + ' denied: "' + display + '" is outside the active plan write scope ['
        + planAllow.join(', ') + '] for member "' + activePlan.member + '" task "' + activePlan.taskId + '"')
        + '. Do not retry or bypass the guard; if the approved plan is stale, stop and ask the owning lead to replace it with team_plan_propose(replace_approved:true, replace_reason:...) after the active lease ends, or request a one-turn team_privilege_request with evidence.'
    }

    if (allow === undefined) {
      if (!(scopes.defaultDeny || config.defaultDeny === true)) return undefined
      return deny(verb + ' denied: member "' + String(memberName(ctx, actor?.agent) ?? 'unknown')
        + '" has no declared static scope or active approved plan lease for (' + display + '); '
        + leaseDiagnostic(ctx, config, actor))
    }
    if (!Array.isArray(allow) || allow.length === 0) {
      return deny(verb + ' denied: this member has an empty write scope (' + display + '); '
        + leaseDiagnostic(ctx, config, actor)
        + '. Ask the owning lead to create/replace the task plan with explicit write_scopes after the active lease ends, or request one-turn team_privilege_request with evidence.' )
    }

    if (matchesAnyRoots(key, allow, roots)) return undefined
    return deny(verb + ' denied: "' + display + '" is outside this member write scope [' + allow.join(', ') + ']')
  }

  const initial = readScopes(scopesFile)
  if (enforce && !initial.valid) note('degraded: invalid scope configuration (' + String(initial.error) + ')')
  note('active: scopesFile=' + String(scopesFile) + ' enforce=' + String(enforce) + ' defaultDeny=' + String(initial.defaultDeny || config.defaultDeny === true))

  ctx.on('fs/write-intent', (target, actor) => check(target, actor, 'write'), { prepend: true })
  ctx.on('fs/edit-intent', (target, actor) => check(target, actor, 'edit'), { prepend: true })
  ctx.on('tools/pre-execute', async (exec, next) => {
    const name = String(exec?.tool?.name ?? exec?.name ?? '')
    if (!['bash', 'pwsh', 'run_code'].includes(name)) return typeof next === 'function' ? next() : { kind: 'allow' }
    const args = exec?.arguments ?? {}
    if (name === 'run_code') {
      const risk = runCodeWriteRisk(args.code ?? args.script ?? args.source ?? '')
      if (risk.opaque) {
        deny('run_code denied: ' + risk.reason + ' can bypass the write-scope guard; use the controlled write/edit tools instead')
      }
      return typeof next === 'function' ? next() : { kind: 'allow' }
    }
    const command = String(args.command ?? '')
    const cwd = exec?.arguments?.workdir
      ?? exec?.arguments?.cwd
      ?? exec?.agent?.session?.header?.cwd
    const scopes = readScopes(scopesFile)
    const staticAllow = scopeOf(ctx, scopes, { agent: exec.agent })
    const privilege = activePrivilege(ctx, config, { agent: exec.agent })
    const operator = staticAllow === '*' || (privilege !== undefined && privilege !== null)
    const strictScratch = scratchMode === 'session-workspace' && !operator
    const parsed = shellWriteTargets(command, cwd, { strictScratch })
    if (parsed.blockedMutation) deny(name + ' denied: link creation or unverified New-Item type is not allowed in session-workspace mode')
    const activePlan = activePlanScope(ctx, config, { agent: exec.agent })
    const roots = scopeRoots(scopes, configuredRoot, { agent: exec.agent }, cwd, activePlan)
    const scopedScript = parsed.opaque
      ? scopedPowerShellFileVerdict({ command, cwd, activePlan, roots })
      : { ok: false }
    const targets = scopedScript.ok === true && !strictScratch ? [] : parsed.targets
    const requiresLease = gitWriteCommand(command) || parsed.gitWrite === true
    if (strictScratch && requiresLease && parsed.directoryChange) {
      deny(name + ' write denied: worktree-carrier-unknown: directory-changing Git composition cannot be verified; use a single explicit git -C invocation')
    }
    if (requiresLease && staticAllow !== '*' && activePlan === undefined && activePrivilege(ctx, config, { agent: exec.agent }) === undefined) {
      deny('git write denied: git add/commit requires an active approved plan lease for the current member; acquire the task lease first')
    }
    if (parsed.opaque && scopedScript.ok !== true) {
      if (['script-invalid', 'script-outside-plan-scope'].includes(scopedScript.code)) {
        deny(name + ' denied: PowerShell -File probe rejected [' + scopedScript.code + ']: '
          + scopedScript.detail + '; use the controlled write/edit tools for file changes')
      }
      deny(commandVerificationMessage(name, exec.agent, scopedScript))
    }
    if ((requiresLease || targets.length > 0 || scopedScript.ok === true) && activePlan !== undefined) {
      if (requiresLease && strictScratch) {
        for (const candidate of parsed.gitCarriers) {
          const top = candidate ? readOnlyGit(candidate, ['rev-parse', '--show-toplevel']) : null
          const carrierPath = top && !top.error && top.status === 0 ? scratchTargetIdentity(top.stdout.trim()) : undefined
          const verdict = worktreeCarrierVerdict({ activePlan, carrierPath, requireBinding: true })
          const binding = scratchTargetIdentity(activePlan.worktreePath)
          if (!verdict.ok || !binding || !carrierPath || binding.toLowerCase() !== carrierPath.toLowerCase()) {
            deny(name + ' write denied: ' + (verdict.code ?? 'worktree-carrier-mismatch') + ': Git repository must equal the active task bound worktree')
          }
        }
      }
      const carrierPath = gitCommandWorkdir(command, cwd) ?? cwd
      const membership = membershipOf(ctx, exec.agent)
      const workspaceRoot = scopes.rootDir || configuredRoot
      const scratchCarrier = typeof carrierPath === 'string'
        && (actorScratch(carrierPath, exec.agent)
          || (isTemporaryPath(carrierPath)
            && !(typeof workspaceRoot === 'string'
              && workspaceRoot.length > 0
              && isUnder(carrierPath, workspaceRoot))))
      if (!scratchCarrier || requiresLease) {
        const carrierVerdict = worktreeCarrierVerdict({
          activePlan,
          tier: membership?.tier,
          carrierPath,
        })
        if (carrierVerdict.ok !== true) {
          deny(name + ' write denied: ' + carrierVerdict.code + ': ' + carrierVerdict.detail)
        }
      }
    }
    for (const target of targets) {
      check({ displayPath: target, targetKey: target }, { agent: exec.agent }, name + ' write', cwd)
    }
    return typeof next === 'function' ? next() : { kind: 'allow' }
  }, { prepend: true })
}
