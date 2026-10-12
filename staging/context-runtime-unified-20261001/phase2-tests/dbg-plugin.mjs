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

/** Cordis plugin name used by loader diagnostics. */
export const name = 'action-fusion'
/** No injected services: it spawns a configured command directly. */
export const inject = []

const MUTATING = new Set(['edit', 'write'])

/** First rule whose matcher accepts the path, or undefined. */
function matchRule(rules, path) {
  if (typeof path !== 'string' || path.length === 0) return undefined
  for (const rule of rules) {
    if (!rule || typeof rule.match !== 'string') continue
    const spec = rule.match
    if (spec.startsWith('/') && spec.lastIndexOf('/') > 0) {
      const end = spec.lastIndexOf('/')
      try {
        if (new RegExp(spec.slice(1, end), spec.slice(end + 1)).test(path)) return rule
      } catch {
        /* a malformed pattern never blocks the pipeline */
      }
      continue
    }
    if (path.includes(spec)) return rule
  }
  return undefined
}

/** Run one command and resolve its combined output; never rejects. */
function runCommand(rule, cwd, shell, defaultTimeoutMs) {
  return new Promise((resolve) => {
    const command = String(rule.command)
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
    console.log('DBG rules', rules.length); if (rules.length === 0) return downstream
    console.log('DBG name', exec && exec.name, exec && Object.keys(exec.arguments||{}), exec && exec.arguments && exec.arguments.file_path); if (!exec || !MUTATING.has(exec.name)) return downstream
    console.log('DBG result', result && result.isError); if (!result || result.isError === true) return downstream

    const args = exec.arguments
    const path = args && typeof args === 'object' ? args.file_path : undefined
    const rule = matchRule(rules, path)
    console.log('DBG rule', rule && rule.command); if (!rule) return downstream

    console.log('DBG running', JSON.stringify({cwd, shell, defaultTimeoutMs})); const outcome = await runCommand(rule, cwd, shell, defaultTimeoutMs); console.log('DBG outcome', JSON.stringify(outcome).slice(0,200))
    const base = Array.isArray(result.content) ? result.content : []
    const decision = { ...downstream }
    if (decision.kind === 'block') return decision
    return { ...decision, content: [...base, render(outcome, keepChars)] }
  })
}
