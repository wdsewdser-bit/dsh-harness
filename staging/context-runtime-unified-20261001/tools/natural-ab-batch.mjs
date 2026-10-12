// Sequential batch runner for the natural A/B labs: runs each case/arm the requested number of times (round-robin so
// arms interleave), cold-verifies every run, and writes one summary with request counts, usage and failure reasons.
// It never retries a failed run and stops at the request cap or after three consecutive provider/environment errors.
// Usage: node tools/natural-ab-batch.mjs --label b2 --plan s1-treat:4,s1-base:4,w1-treat:5 [--max-requests 600]
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const stage = resolve(fileURLToPath(new URL('..', import.meta.url)))
const arg = name => { const i = process.argv.indexOf(name); return i < 0 ? undefined : process.argv[i + 1] }
const label = arg('--label'), maxRequests = Number(arg('--max-requests') ?? 600)
if (!/^[a-z0-9-]{1,24}$/.test(label ?? '') || !Number.isSafeInteger(maxRequests) || maxRequests < 1) throw new Error('BATCH_ARGUMENTS_INVALID')
const unified = (scenario, extra = []) => ({ lab: 'unified-natural-lab.mjs', run: dir => ['--scenario', scenario, ...extra, '--output', dir, '--run'],
  verify: dir => ['--scenario', scenario, '--output', dir, '--verify'] })
const withOutput = (lab, extra = []) => ({ lab, run: dir => [...extra, '--output', dir, '--run'], verify: dir => ['--verify', dir] })
const cases = {
  's1-treat': { ...withOutput('native-compaction-natural-lab.mjs'), what: 'native compaction x3 + recovery' },
  's1-base': { ...withOutput('native-compaction-natural-lab.mjs', ['--baseline']), what: 'same task, no compaction' },
  'w1-treat': { ...unified('window-recall', ['--quality-oracle']), what: 'W1 request projection + exact recall' },
  'w1-base': { ...unified('window-recall', ['--quality-oracle', '--baseline']), what: 'same task, full request' },
  'w2-treat': { ...unified('window-native'), what: 'W2 native surface commit + exact recall' },
  'team': { ...withOutput('team-family-natural-lab.mjs'), what: 'four-role Team next-turn' },
  'inst': { lab: 'instant-natural-lab.mjs', launcher: true, run: () => ['--run'], verify: dir => ['--verify', dir], what: 'Instant steer' },
}
// Plan items accept an optional context size on the two native A/B cases that support it: `s1-treat@300000:2` runs
// that case twice with `--context-tokens 300000`. Without `@` the item behaves exactly as before; any other case
// carrying `@` is an argument error.
const contextCases = new Set(['s1-treat', 's1-base', 'w2-treat'])
const plan = (arg('--plan') ?? '').split(',').filter(Boolean).map(item => {
  const [head, count] = item.split(':'), at = head.indexOf('@')
  const name = at < 0 ? head : head.slice(0, at)
  return { name, count: Number(count), contextTokens: at < 0 ? undefined : Number(head.slice(at + 1)) }
})
if (!plan.length || plan.some(item => !cases[item.name] || !Number.isSafeInteger(item.count) || item.count < 1 || item.count > 20
  || (item.contextTokens !== undefined && (!contextCases.has(item.name) || !Number.isSafeInteger(item.contextTokens)
    || item.contextTokens < 50000 || item.contextTokens > 800000)))) throw new Error('BATCH_PLAN_INVALID')
const stamp = new Date().toISOString().replace(/[-:]/g, '').slice(0, 13)
const logs = resolve(stage, '../../output'), summaryFile = join(logs, `context-runtime-ab-batch-${label}-${stamp}.json`)
const sha = file => createHash('sha256').update(readFileSync(file)).digest('hex')
const json = file => { try { return JSON.parse(readFileSync(file, 'utf8')) } catch { return undefined } }
const lastJson = text => { for (const line of (text ?? '').trim().split('\n').reverse()) { try { return JSON.parse(line) } catch { /* not JSON */ } } }

function node(spec, args, timeoutMs = 330000) {
  const script = join(stage, 'tools', spec.lab)
  // Labs with their own parent mode still import the canonical native modules at load, so they need the lab loader
  // and home too; they read the provider key themselves. Only the launcher path injects it on their behalf.
  const argv = spec.launcher ? [join(stage, 'tools/natural-lab-launch.mjs'), script, ...args]
    : ['--preserve-symlinks', '--preserve-symlinks-main', '--import', new URL('./prepare-unified-lab-host.mjs', import.meta.url).href, script, ...args]
  const env = { ...process.env, DSH_HOME: join(stage, 'lab-host-home'), DSH_LAB_CANONICAL_MODULES: '1' }
  return spawnSync(process.execPath, argv, { cwd: stage, env, encoding: 'utf8', windowsHide: true, timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024 })
}
function usageOf(dir) {
  const totals = { inputTokens: 0, cacheReadTokens: 0, outputTokens: 0 }, bySession = {}
  const terminals = json(join(dir, 'request-terminals.json'))
  if (Array.isArray(terminals)) {
    for (const row of terminals) {
      const session = bySession[row.sessionId] ??= { requests: 0, inputTokens: 0, cacheReadTokens: 0, outputTokens: 0 }
      session.requests++
      for (const key of Object.keys(totals)) {
        const value = row.usage?.[key] ?? row.reportedUsage?.[key]
        if (typeof value === 'number') { totals[key] += value; session[key] += value }
      }
    }
    return { source: 'request-terminals.json (summed here)', requests: terminals.length, totals, sessions: Object.keys(bySession).length, bySession }
  }
  const root = json(join(dir, 'usage-root-only.json')), usage = root?.usage ?? root?.economics?.usage
  if (!usage) return { source: 'unknown', requests: null }
  const value = key => { const cell = usage.tokens?.[key]; return typeof cell === 'number' ? cell : cell?.value ?? cell?.knownSubtotal ?? null }
  return { source: 'usage-root-only.json', requests: usage.activity?.requests ?? null, sessions: 1,
    totals: { inputTokens: value('inputTokens'), cacheReadTokens: value('cacheReadTokens'), outputTokens: value('outputTokens') } }
}
function abnormalTurns(dir) {
  const raw = json(join(dir, 'canonical-journal.json')), events = Array.isArray(raw) ? raw : raw?.events ?? raw?.journal ?? []
  return events.filter(event => event?.type === 'turn/end' && event.data?.reason?.kind !== 'completed')
    .map(event => event.data.reason.kind + (event.data.reason.error?.message ? ':' + event.data.reason.error.message : ''))
}

const runs = [], queue = []
for (let round = 0; queue.length < plan.reduce((sum, item) => sum + item.count, 0); round++) for (const item of plan) if (round < item.count) queue.push({ name: item.name, rep: round + 1, contextTokens: item.contextTokens })
let total = 0, consecutiveEnvironment = 0, stopped = null
const flush = () => writeFileSync(summaryFile, JSON.stringify({ label, stamp, plan, maxRequests, totalRequests: total, stopped, runs }, null, 1) + '\n')
for (const item of queue) {
  if (total >= maxRequests) { stopped = 'request-cap'; break }
  if (consecutiveEnvironment >= 3) { stopped = 'three-consecutive-provider-or-environment-errors'; break }
  const spec = cases[item.name]
  // Size the child budget to match the lab's own scaled process timeout, leaving room for shutdown and verification.
  const timeoutMs = item.contextTokens ? 115000 + Math.max(215000, item.contextTokens * 2 + 35000) : 330000
  const id = `ab-${label}-${item.name}${item.contextTokens ? '-' + item.contextTokens : ''}-r${item.rep}-${stamp}`
  const dir = join(stage, 'lab-runs', id), log = join(logs, `context-runtime-${id}.log`)
  const before = spec.launcher ? new Set(readdirSync(join(stage, 'lab-runs'))) : null
  const startedAt = Date.now()
  const result = node(spec, spec.run(dir).concat(item.contextTokens ? ['--context-tokens', String(item.contextTokens)] : []), timeoutMs)
  let output = dir
  if (spec.launcher) output = join(stage, 'lab-runs', readdirSync(join(stage, 'lab-runs')).find(name => !before.has(name) && name.startsWith('natural-instant-')) ?? id)
  const verified = existsSync(output) ? node(spec, spec.verify(output), timeoutMs) : null
  mkdirSync(logs, { recursive: true })
  writeFileSync(log, `## run exit=${result.status}\n${result.stdout ?? ''}\n## run stderr\n${(result.stderr ?? '').slice(-6000)}\n## verify exit=${verified?.status}\n${verified?.stdout ?? ''}\n${(verified?.stderr ?? '').slice(-3000)}\n`)
  const verification = json(join(output, 'offline-verification.json')), receipt = json(join(output, 'result.json'))
  const usage = existsSync(output) ? usageOf(output) : { source: 'unknown', requests: null }
  const requests = usage.requests ?? receipt?.requests ?? receipt?.admission?.admittedRequests ?? 0
  const failure = lastJson(result.stderr)?.code ?? receipt?.error?.code ?? null
  const turns = existsSync(output) ? abnormalTurns(output) : []
  const accepted = result.status === 0 && verified?.status === 0 && verification?.accepted === true
  const environment = !accepted && (requests === 0 || /CREDENTIAL|ECONN|ETIMEDOUT|403|401|PROVIDER/i.test(String(failure) + turns.join(' ')))
  consecutiveEnvironment = environment ? consecutiveEnvironment + 1 : 0
  total += requests
  runs.push({ case: item.name, rep: item.rep, what: spec.what, output, log, logSha256: sha(log), wallMs: Date.now() - startedAt,
    ...(item.contextTokens ? { contextTokens: item.contextTokens } : {}),
    runExit: result.status, verifyExit: verified?.status ?? null, accepted, requests, failure, abnormalTurns: turns,
    failedChecks: verification ? Object.entries(verification).filter(([, value]) => value === false).map(([key]) => key) : ['no-verification-file'],
    usage })
  flush()
  console.log(`${id} accepted=${accepted} requests=${requests} total=${total}${failure ? ' failure=' + failure : ''}${turns.length ? ' turns=' + turns.join('|') : ''}`)
}
flush()
console.log('SUMMARY ' + summaryFile)
