/**
 * action-fusion — Agent Team v13
 *
 * Fuses a file mutation with its follow-up validation command so the model sees
 * "edit ok" and "tree still builds" in one observation. Adapted from SoL-Pi's
 * Action Fusion mechanism (https://github.com/NVlabs/SoL-Pi).
 *
 * v2 differences from the Phase 2a implementation:
 *  - project roots are language-aware (Cargo.toml / tsconfig.json / pyproject.toml / go.mod)
 *  - Rust rules can target a crate with {crate} and run from the workspace root
 *  - {file}, {dir}, {project} and {crate} placeholders are substituted
 *  - identical file content is never validated twice in one plugin lifetime
 *  - a rule whose command needs {crate} is skipped when no crate can be resolved
 *
 * Hook
 * ----
 * tools/post-execute is a real waterfall:
 *   (exec: ToolExecution, result: Readonly<ToolExecutionResult>, next) => PostToolDecision
 * Returning { kind: 'accept', content: [...result.content, validationBlock] }
 * appends to the model-facing projection without losing the canonical value.
 *
 * Config
 * ------
 *   rules:
 *     - match: '/[.](rs)$/'
 *       command: 'cargo check --message-format short -p {crate}'
 *       timeoutMs: 180000
 *       shell: 'none'
 *     - match: '/[.](js|mjs|cjs)$/'
 *       command: 'node --check "{file}"'
 *       timeoutMs: 20000
 *       shell: 'none'
 *   cwd: 'D:\\proj'            # fallback only when no project root is found
 *   keepOutputChars: 4000
 *
 * A failing validation command never turns the tool call into an error: the
 * point is to show the agent the evidence, not to punish it. The command comes
 * from operator config, never from model input.
 *
 * @module action-fusion
 */

import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, mkdirSync, openSync, closeSync, unlinkSync, statSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { createTelemetry } from './team-v13-mechanism-telemetry.mjs'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'action-fusion'
/** No injected services: it spawns a configured command directly. */
export const inject = []

const MUTATING = new Set(['edit', 'write'])
const MAX_DEDUP_ENTRIES = 512

/** Project markers by file extension. The first match wins. */
const LANGUAGE_MARKERS = Object.freeze({
  rs: ['Cargo.toml'],
  ts: ['tsconfig.json', 'package.json', '.git'],
  tsx: ['tsconfig.json', 'package.json', '.git'],
  js: ['package.json', '.git'],
  mjs: ['package.json', '.git'],
  cjs: ['package.json', '.git'],
  py: ['pyproject.toml', 'setup.py', 'setup.cfg', '.git'],
  go: ['go.mod', '.git'],
})

/** Lowercase extension without the dot, or ''. */
function extensionOf(filePath) {
  const match = /\.([A-Za-z0-9]+)$/.exec(String(filePath ?? ''))
  return match === null ? '' : match[1].toLowerCase()
}

/** Read a text file, returning '' when it is unreadable. */
function readText(path) {
  try {
    return readFileSync(path, 'utf8')
  } catch {
    return ''
  }
}

/** Walk up from a file to the nearest directory containing one of the markers. */
function nearestMarkerDir(filePath, markers) {
  if (typeof filePath !== 'string' || filePath.length === 0) return undefined
  let dir
  try {
    dir = dirname(filePath)
  } catch {
    return undefined
  }
  for (let depth = 0; depth < 16; depth += 1) {
    for (const marker of markers) {
      try {
        if (existsSync(join(dir, marker))) return dir
      } catch {
        /* unreadable marker: keep walking */
      }
    }
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return undefined
}

/**
 * The project the edited file belongs to. Kept exported for the existing tests
 * and callers; v2 adds language-aware markers when none are supplied.
 */
export function projectRoot(filePath, markers) {
  const list = Array.isArray(markers) && markers.length > 0
    ? markers
    : LANGUAGE_MARKERS[extensionOf(filePath)] ?? ['package.json', '.git']
  return nearestMarkerDir(filePath, list)
}

/** The [package].name from a Cargo.toml, falling back to its directory name. */
function cargoPackageName(manifestPath) {
  const text = readText(manifestPath)
  const section = /\[package\]([\s\S]*?)(?=\n\s*\[|$)/.exec(text)
  const name = section === null ? null : /^\s*name\s*=\s*["']([^"']+)["']/m.exec(section[1])
  return name === null ? basename(dirname(manifestPath)) : name[1]
}

/** Walk up from a crate directory to the enclosing [workspace] Cargo.toml. */
function cargoWorkspaceRoot(crateDir) {
  let dir = crateDir
  for (let depth = 0; depth < 16; depth += 1) {
    const manifest = join(dir, 'Cargo.toml')
    if (existsSync(manifest) && /^\s*\[workspace\]/m.test(readText(manifest))) return dir
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return crateDir
}

/**
 * Resolve the working directory and template values for one rule.
 * @returns {{ cwd: string, project: string, crate: string }}
 */
export function resolveCommandContext(rule, filePath, fallbackCwd) {
  const markers = Array.isArray(rule?.projectMarkers) && rule.projectMarkers.length > 0
    ? rule.projectMarkers
    : undefined
  const project = projectRoot(filePath, markers)
  const extension = extensionOf(filePath)
  let cwd = project ?? fallbackCwd
  let crate = ''

  if (extension === 'rs') {
    const crateDir = nearestMarkerDir(filePath, ['Cargo.toml'])
    if (crateDir !== undefined) {
      crate = cargoPackageName(join(crateDir, 'Cargo.toml'))
      cwd = cargoWorkspaceRoot(crateDir)
    }
  }

  return { cwd, project: project ?? cwd, crate }
}

/** First rule whose matcher accepts the path, with its index. */
function matchRule(rules, path) {
  if (typeof path !== 'string' || path.length === 0) return undefined
  // Rules are written with '/' separators; Windows paths arrive with '\'.
  const slashPath = path.replace(/\\/g, '/')
  for (let index = 0; index < rules.length; index += 1) {
    const rule = rules[index]
    if (!rule || typeof rule.match !== 'string') continue
    const spec = rule.match
    if (spec.startsWith('/') && spec.lastIndexOf('/') > 0) {
      const end = spec.lastIndexOf('/')
      try {
        const re = new RegExp(spec.slice(1, end), spec.slice(end + 1))
        if (re.test(path) || re.test(slashPath)) return { rule, index }
      } catch {
        /* a malformed pattern never blocks the pipeline */
      }
      continue
    }
    if (path.includes(spec) || slashPath.includes(spec)) return { rule, index }
  }
  return undefined
}

/** Substitute every supported placeholder in one configured command. */
export function substituteCommand(command, context, file) {
  return String(command)
    .split('{file}').join(typeof file === 'string' ? file : '')
    .split('{dir}').join(typeof file === 'string' && file.length > 0 ? dirname(file) : '')
    .split('{project}').join(context.project ?? '')
    .split('{crate}').join(context.crate ?? '')
}

/** Run one command and resolve its combined output; never rejects. */
function runCommand(rule, cwd, shell, defaultTimeoutMs, command) {
  return new Promise((resolvePromise) => {
    const timeoutMs = Number.isFinite(rule.timeoutMs) ? rule.timeoutMs : defaultTimeoutMs
    const started = Date.now()
    let child
    try {
      if (shell === 'none') {
        const parts = command.match(/(?:[^\s"]+|"[^"]*")+/g) || []
        child = spawn(parts[0], parts.slice(1).map((part) => part.replace(/^"|"$/g, '')), {
          cwd,
          windowsHide: true,
        })
      } else if (process.platform === 'win32') {
        const flag = shell === 'pwsh' ? '-Command' : '/d /s /c'
        const exe = shell === 'pwsh' ? 'pwsh' : 'cmd'
        child = spawn(exe, shell === 'pwsh' ? [flag, command] : ['/d', '/s', '/c', command], {
          cwd,
          windowsHide: true,
        })
      } else {
        child = spawn(shell === 'bash' ? 'bash' : 'sh', ['-c', command], { cwd, windowsHide: true })
      }
    } catch (error) {
      resolvePromise({
        command,
        code: null,
        output: 'failed to spawn: ' + String(error?.message),
        ms: Date.now() - started,
      })
      return
    }

    let output = ''
    let settled = false
    const cap = 500000
    const collect = (chunk) => {
      if (output.length < cap) output += String(chunk)
    }
    child.stdout?.on('data', collect)
    child.stderr?.on('data', collect)
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      try {
        child.kill()
      } catch {
        /* already gone */
      }
      resolvePromise({
        command,
        code: null,
        output: output + '\n[action-fusion] timed out after ' + timeoutMs + 'ms',
        ms: Date.now() - started,
        timedOut: true,
      })
    }, timeoutMs)
    child.on('error', (error) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolvePromise({
        command,
        code: null,
        output: output + '\n[action-fusion] ' + String(error?.message),
        ms: Date.now() - started,
      })
    })
    child.on('close', (code) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolvePromise({ command, code, output, ms: Date.now() - started })
    })
  })
}

/** Render one validation run as a model-facing text block. */
function render(outcome, keepChars) {
  const body = outcome.output.length > keepChars
    ? '[… head truncated]\n' + outcome.output.slice(-keepChars)
    : outcome.output
  const status = outcome.timedOut === true
    ? 'TIMEOUT'
    : outcome.code === 0
      ? 'PASS'
      : 'FAIL(exit ' + String(outcome.code) + ')'
  const text = '[action-fusion] ' + status + ' :: ' + outcome.command + ' (' + outcome.ms + 'ms)\n'
    + (body.trim().length > 0 ? body : '(no output)')
  return { type: 'text', text }
}

/** Content hash used to avoid validating identical bytes twice. */
function contentHash(filePath) {
  try {
    return createHash('sha256').update(readFileSync(filePath)).digest('hex')
  } catch {
    return ''
  }
}

/** Remember one dedup key with a bounded FIFO. */
function remember(dedup, key) {
  if (dedup.size >= MAX_DEDUP_ENTRIES) {
    const oldest = dedup.keys().next().value
    dedup.delete(oldest)
  }
  dedup.set(key, Date.now())
}

function lockFileName(key) {
  return createHash('sha256').update(key).digest('hex').slice(0, 32) + '.lock'
}

/** Acquire a bounded cross-process lock. Returns a release callback or undefined. */
export async function acquireWorkspaceLock(lockDir, key, ttlMs, waitMs, pollMs, onQueued) {
  try { mkdirSync(lockDir, { recursive: true }) } catch { return undefined }
  const file = join(lockDir, lockFileName(key))
  const started = Date.now()
  let queued = false
  while (Date.now() - started <= waitMs) {
    try {
      const fd = openSync(file, 'wx')
      writeFileSync(fd, JSON.stringify({ pid: process.pid, key, createdAt: Date.now() }), 'utf8')
      closeSync(fd)
      return () => { try { unlinkSync(file) } catch {} }
    } catch {
      try {
        const age = Date.now() - statSync(file).mtimeMs
        if (age > ttlMs) { unlinkSync(file); continue }
      } catch {}
      if (!queued) { queued = true; onQueued?.() }
      await new Promise(resolvePromise => setTimeout(resolvePromise, Math.max(10, pollMs)))
    }
  }
  return undefined
}

/**
 * Register the fusion listener.
 * @param ctx - cordis plugin context.
 * @param config - this plugin row's config.
 */
export function apply(ctx, config = {}) {
  const rules = Array.isArray(config.rules) ? config.rules : []
  const fallbackCwd = typeof config.cwd === 'string' && config.cwd.length > 0 ? config.cwd : process.cwd()
  const defaultShell = typeof config.shell === 'string'
    ? config.shell
    : process.platform === 'win32'
      ? 'cmd'
      : 'bash'
  const defaultTimeoutMs = Number.isFinite(config.timeoutMs) ? config.timeoutMs : 120000
  const keepChars = Number.isFinite(config.keepOutputChars) ? config.keepOutputChars : 4000
  const dedup = new Map()
  const crateChecks = new Map()
  const crateCooldownMs = Number.isFinite(config.crateCooldownMs) ? Math.max(0, config.crateCooldownMs) : 60_000
  const workspaceLockDir = typeof config.workspaceLockDir === 'string' && config.workspaceLockDir.length > 0
    ? config.workspaceLockDir
    : join(process.env.TEMP || process.env.TMPDIR || '.', 'dsh-action-fusion-locks')
  const lockTtlMs = Number.isFinite(config.lockTtlMs) ? Math.max(1000, config.lockTtlMs) : 5 * 60 * 1000
  const lockWaitMs = Number.isFinite(config.lockWaitMs) ? Math.max(0, config.lockWaitMs) : 5000
  const lockPollMs = Number.isFinite(config.lockPollMs) ? Math.max(10, config.lockPollMs) : 50
  const telemetry = createTelemetry('action-fusion', { dir: config.telemetryDir, enabled: true })
  const sessionIdOf = (exec) => exec?.agent?.session?.id ?? exec?.agent?.id

  if (rules.length === 0) {
    try {
      ctx.logger?.warn?.('[action-fusion] active but no rules configured: every call passes through')
    } catch {
      /* logging must never break the pipeline */
    }
  }

  ctx.on('tools/post-execute', async (exec, result, next) => {
    const downstream = await next()
    if (rules.length === 0) return downstream
    if (!exec || !MUTATING.has(exec.name)) return downstream
    if (!result || result.isError === true) return downstream

    const args = exec.arguments
    const path = args && typeof args === 'object' ? args.file_path : undefined
    const matched = matchRule(rules, path)
    if (matched === undefined) {
      telemetry.skipped('no-rule-match', { tool: exec.name, sessionId: sessionIdOf(exec) })
      return downstream
    }

    const { rule, index } = matched
    const context = resolveCommandContext(rule, path, fallbackCwd)
    if (typeof rule.requireFile === 'string' && !existsSync(join(context.cwd, rule.requireFile))) {
      telemetry.skipped('require-file-missing', { rule: index, file: rule.requireFile, sessionId: sessionIdOf(exec) })
      return downstream
    }
    if (String(rule.command).includes('{crate}') && context.crate.length === 0) {
      telemetry.skipped('crate-unresolved', { sessionId: sessionIdOf(exec) })
      return downstream
    }
    const command = substituteCommand(rule.command, context, path)

    const crateKey = context.crate.length > 0 ? resolve(context.cwd) + '|' + context.crate : ''
    if (crateKey.length > 0 && crateCooldownMs > 0) {
      const prior = crateChecks.get(crateKey)
      if (prior !== undefined && prior.ok === true && Date.now() - prior.at < crateCooldownMs) {
        telemetry.skipped('crate-cooldown', {
          crate: context.crate,
          sessionId: sessionIdOf(exec),
        })
        return downstream
      }
    }

    const hash = contentHash(path)
    if (hash.length > 0) {
      const key = index + '|' + resolve(path) + '|' + hash
      if (dedup.has(key)) {
        telemetry.skipped('duplicate-content', { sessionId: sessionIdOf(exec) })
        return downstream
      }
      remember(dedup, key)
    }

    const shell = typeof rule.shell === 'string' ? rule.shell : defaultShell
    const lockKey = crateKey.length > 0 ? 'crate:' + crateKey : 'workspace:' + resolve(context.project || context.cwd)
    const release = await acquireWorkspaceLock(workspaceLockDir, lockKey, lockTtlMs, lockWaitMs, lockPollMs, () => {
      telemetry.event('queued', { lockKey, sessionId: sessionIdOf(exec) }, { toolCalls: 1 })
    })
    if (release === undefined) {
      telemetry.skipped('lock-timeout', { lockKey, sessionId: sessionIdOf(exec) })
      return downstream
    }
    let outcome
    try {
      outcome = await runCommand(rule, context.cwd, shell, defaultTimeoutMs, command)
    } finally {
      release()
    }
    const base = Array.isArray(result.content) ? result.content : []
    const decision = { ...downstream }
    if (decision.kind === 'block') {
      telemetry.skipped('downstream-block', { sessionId: sessionIdOf(exec) })
      return decision
    }
    telemetry.event('fired', {
      command,
      code: outcome.code,
      ms: outcome.ms,
      timedOut: outcome.timedOut === true,
      crate: context.crate || null,
      sessionId: sessionIdOf(exec),
    }, {
      toolMs: outcome.ms,
      toolCalls: 1,
      passed: outcome.code === 0 && outcome.timedOut !== true ? 1 : 0,
      failed: outcome.code !== 0 || outcome.timedOut === true ? 1 : 0,
      timeout: outcome.timedOut === true ? 1 : 0,
      lockKey,
    })
    if (crateKey.length > 0) {
      if (outcome.code === 0 && outcome.timedOut !== true) {
        if (crateChecks.size >= 128) crateChecks.delete(crateChecks.keys().next().value)
        crateChecks.set(crateKey, { at: Date.now(), ok: true })
      } else {
        crateChecks.delete(crateKey)
      }
    }
    return { ...decision, content: [...base, render(outcome, keepChars)] }
  })
}
