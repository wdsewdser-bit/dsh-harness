/**
 * action-fusion — Agent Team v2 / Phase 2a
 *
 * Fuses the *validation* of a change into the same tool result that made the
 * change, so an agent can never see "edit ok" without also seeing whether the
 * tree still builds. Adapted from SoL-Pi's Action Fusion mechanism
 * (https://github.com/NVlabs/SoL-Pi): an action and its verification are one
 * observation, which removes the "I'll check it later" turn entirely.
 *
 * Hook
 * ----
 * tools/post-execute is a real waterfall:
 *   (exec: ToolExecution, result: Readonly<ToolExecutionResult>, next) => PostToolDecision
 * The registry's default later listener resolves { kind: 'accept' } with
 * neither content nor value, and the registry then keeps the original
 * result.value and only swaps content when the decision owns 'content'
 * (dsh-tools/lib/index.js:3377-3400). So returning
 *   { kind: 'accept', content: [...result.content, validationBlock] }
 * appends to the model-facing projection *without* losing the canonical value
 * that a run_code sub-dispatch would otherwise return to the program.
 *
 * Config
 * ------
 *   rules:
 *     - match: "src/"          # substring or /regex/ tested against file_path
 *       command: "npm run typecheck"
 *       timeoutMs: 120000
 *   cwd: "D:\\proj"            # default working directory
 *   keepOutputChars: 4000
 *   shell: "cmd" | "pwsh" | "bash" | "none"   # "none" = raw executable + args
 *
 * A rule with no match simply lets the downstream decision through. A failing
 * validation command never turns the tool call into an error: the point is to
 * show the agent the evidence, not to punish it. The command comes from
 * operator config, never from model input.
 *
 * @module action-fusion
 */

import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'action-fusion'
/** No injected services: it spawns a configured command directly. */
export const inject = []

const MUTATING = new Set(['edit', 'write'])

/**
 * The project the edited file belongs to, found by walking up to the nearest
 * package.json or .git. Without this the validation command runs in whatever directory
 * the harness happened to start in, which is how a correctly configured rule silently
 * checks the wrong tree — or nothing at all.
 * @returns the project directory, or undefined when the file belongs to no project.
 */
export function projectRoot(filePath) {
  if (typeof filePath !== 'string' || filePath.length === 0) return undefined
  let dir
  try { dir = dirname(filePath) } catch { return undefined }
  for (let depth = 0; depth < 12; depth += 1) {
    for (const marker of ['package.json', '.git']) {
      try { if (existsSync(join(dir, marker))) return dir } catch { /* unreadable: keep walking */ }
    }
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return undefined
}

/** First rule whose matcher accepts the path, or undefined. */
function matchRule(rules, path) {
  if (typeof path !== 'string' || path.length === 0) return undefined
  // Rules are written with '/' separators; Windows paths arrive with '\'.
  const slashPath = path.replace(/\\/g, '/')
  for (const rule of rules) {
    if (!rule || typeof rule.match !== 'string') continue
    const spec = rule.match
    if (spec.startsWith('/') && spec.lastIndexOf('/') > 0) {
      const end = spec.lastIndexOf('/')
      try {
        const re = new RegExp(spec.slice(1, end), spec.slice(end + 1))
        if (re.test(path) || re.test(slashPath)) return rule
      } catch {
        /* a malformed pattern never blocks the pipeline */
      }
      continue
    }
    if (path.includes(spec) || slashPath.includes(spec)) return rule
  }
  return undefined
}

/** Run one command and resolve its combined output; never rejects. */
function runCommand(rule, cwd, shell, defaultTimeoutMs, file) {
  return new Promise((resolve) => {
    // {file} is substituted with the edited path, so a rule can validate exactly what
    // changed instead of re-checking the whole tree on every edit.
    const raw = String(rule.command)
    const command = typeof file === 'string' && file.length > 0 ? raw.split('{file}').join(file) : raw
    const timeoutMs = Number.isFinite(rule.timeoutMs) ? rule.timeoutMs : defaultTimeoutMs
    const started = Date.now()
    let child
    try {
      if (shell === 'none') {
        const parts = command.match(/(?:[^\s"]+|"[^"]*")+/g) || []
        child = spawn(parts[0], parts.slice(1).map((p) => p.replace(/^"|"$/g, '')), { cwd, windowsHide: true })
      } else if (process.platform === 'win32') {
        const flag = shell === 'pwsh' ? '-Command' : '/d /s /c'
        const exe = shell === 'pwsh' ? 'pwsh' : 'cmd'
        child = spawn(exe, shell === 'pwsh' ? [flag, command] : ['/d', '/s', '/c', command], { cwd, windowsHide: true })
      } else {
        child = spawn(shell === 'bash' ? 'bash' : 'sh', ['-c', command], { cwd, windowsHide: true })
      }
    } catch (error) {
      resolve({ command, code: null, output: 'failed to spawn: ' + String(error && error.message), ms: Date.now() - started })
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
      resolve({ command, code: null, output: output + '\n[action-fusion] timed out after ' + timeoutMs + 'ms', ms: Date.now() - started, timedOut: true })
    }, timeoutMs)
    child.on('error', (error) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve({ command, code: null, output: output + '\n[action-fusion] ' + String(error && error.message), ms: Date.now() - started })
    })
    child.on('close', (code) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve({ command, code, output, ms: Date.now() - started })
    })
  })
}

/** Render one validation run as a model-facing text block. */
function render(outcome, keepChars) {
  const body = outcome.output.length > keepChars ? '[… head truncated]\n' + outcome.output.slice(-keepChars) : outcome.output
  const status = outcome.timedOut ? 'TIMEOUT' : outcome.code === 0 ? 'PASS' : 'FAIL(exit ' + String(outcome.code) + ')'
  const text = '[action-fusion] ' + status + ' :: ' + outcome.command + ' (' + outcome.ms + 'ms)\n' + (body.trim().length > 0 ? body : '(no output)')
  return { type: 'text', text }
}

/**
 * Register the fusion listener.
 * @param ctx - cordis plugin context.
 * @param config - this plugin row's config.
 */
export function apply(ctx, config = {}) {
  const rules = Array.isArray(config.rules) ? config.rules : []
  const cwd = typeof config.cwd === 'string' ? config.cwd : process.cwd()
  const shell = typeof config.shell === 'string' ? config.shell : process.platform === 'win32' ? 'cmd' : 'bash'
  const defaultTimeoutMs = Number.isFinite(config.timeoutMs) ? config.timeoutMs : 120000
  const keepChars = Number.isFinite(config.keepOutputChars) ? config.keepOutputChars : 4000

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
    const rule = matchRule(rules, path)
    if (!rule) return downstream

    const effectiveCwd = typeof config.cwd === 'string' && config.cwd.length > 0
      ? config.cwd
      : (typeof path === 'string' ? projectRoot(path) : undefined) ?? cwd
    const outcome = await runCommand(rule, effectiveCwd, shell, defaultTimeoutMs, path)
    const base = Array.isArray(result.content) ? result.content : []
    const decision = { ...downstream }
    if (decision.kind === 'block') return decision
    return { ...decision, content: [...base, render(outcome, keepChars)] }
  })
}
