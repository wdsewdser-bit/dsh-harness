#!/usr/bin/env node
/** Phase 5 (v3): the fold fires on the idle transition, not on a tool call. */
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apply, compactOnIdle, DEFAULTS } from '../home/profiles/web/plugins/step-compaction.mjs'
import { createMilestoneDoc } from '../home/profiles/web/plugins/team-milestone.mjs'

let failed = 0
function check(name, ok, detail) {
  if (!ok) failed += 1
  console.log((ok ? 'PASS ' : 'FAIL ') + name + (ok || detail === undefined ? '' : '  ' + detail))
}
const settle = () => new Promise((resolve) => setTimeout(resolve, 15))

function setup(options = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'milestone-'))
  const path = join(dir, 'team-milestones.json')
  const doc = createMilestoneDoc()
  doc.members.a1 = { owner: 'a1', stage: 'S', doneWhen: 'W', setAt: 1, done: options.done === true }
  if (options.done === true && options.compacted !== true) {
    doc.compactions.a1 = { kind: 'milestone', status: 'pending-idle', reason: 'milestone', milestoneSetAt: 1, requestedAt: 1 }
  }
  if (options.compacted === true) doc.members.a1.compactedAt = 5
  if (options.noDoc !== true) writeFileSync(path, JSON.stringify(doc), 'utf8')
  const handlers = new Map()
  const folds = []
  const ctx = {
    // Services are resolved through ctx.get, not property access: reading an undeclared
    // property off a cordis context THROWS, which is exactly the regression this guards.
    on: (name, handler) => { handlers.set(name, handler); return () => handlers.delete(name) },
    agentTeams: { tryMembership: (agent) => agent.membership },
    tokenMeter: { measure: () => ({ totalTokens: options.tokens ?? 500000 }) },
    compaction: {
      compactNow: async () => {
        folds.push(1)
        if (options.throwOnFold) throw new Error('manual compaction requires an idle agent with no waking queued work')
        return { ok: true }
      },
    },
    logger: { info: () => {} },
  }
  if (options.noMeter === true) ctx.tokenMeter = undefined
  ctx.get = (name) => (name === 'tokenMeter' ? ctx.tokenMeter : undefined)
  if (options.noEngine === true) ctx.compaction = undefined
  apply(ctx, { milestonePath: path, windowTokens: options.window ?? 1000000 })
  const agent = options.nonMember === true ? { session: { id: 's1' } } : { session: { id: 's1' }, membership: { name: 'a1' } }
  const emit = (status) => handlers.get('agent/status')({ agent, status })
  return { ctx, emit, folds, path, cfg: { milestonePath: path, windowTokens: options.window ?? 1000000 } }
}

// 1. the ticked milestone folds the context on the next idle
{
  const h = setup({ done: true, tokens: 500000 })
  h.emit('running')
  h.emit('idle')
  await settle()
  check('a ticked milestone folds the context at the idle transition', h.folds.length === 1, JSON.stringify(h.folds.length))
}

// 2. an untickled milestone well under pressure does nothing
{
  const h = setup({ done: false, tokens: 300000 })
  h.emit('idle')
  await settle()
  check('an unticked milestone below the hard threshold does not fold', h.folds.length === 0, JSON.stringify(h.folds.length))
}

// 3. the hard threshold fires with no tick at all
{
  const h = setup({ done: false, tokens: 800000 })
  h.emit('idle')
  await settle()
  check('pressure folds an unticked milestone as a safety action', h.folds.length === 1, JSON.stringify(h.folds.length))
}

// 4. running is not idle: the engine would only refuse
{
  const h = setup({ done: true, tokens: 500000 })
  h.emit('running')
  await settle()
  check('a running agent is never folded', h.folds.length === 0, JSON.stringify(h.folds.length))
}

// 5. the same milestone never folds twice
{
  const h = setup({ done: true, compacted: true, tokens: 500000 })
  h.emit('idle')
  await settle()
  check('an already folded milestone does not fold again', h.folds.length === 0, JSON.stringify(h.folds.length))
}

// 6. a fold marks the document, so the next process does not repeat it
{
  const h = setup({ done: true, tokens: 500000 })
  h.emit('idle')
  await settle()
  const saved = JSON.parse(readFileSync(h.path, 'utf8'))
  check('folding records compactedAt in the document', typeof saved.members.a1.compactedAt === 'number', JSON.stringify(saved.members.a1))
}

// 7-10. the failure paths stay quiet
{
  const h = setup({ done: true, tokens: 500000, nonMember: true })
  h.emit('idle')
  await settle()
  check('a non Team member is ignored', h.folds.length === 0)
}
{
  const h = setup({ done: true, tokens: 500000, noEngine: true })
  h.emit('idle')
  await settle()
  check('a profile with no compaction engine is ignored, not fatal', h.folds.length === 0)
}
{
  const h = setup({ done: true, tokens: 500000, noMeter: true })
  h.emit('idle')
  await settle()
  check('a missing token meter is ignored', h.folds.length === 0)
}
{
  const h = setup({ done: true, tokens: 500000, noDoc: true })
  h.emit('idle')
  await settle()
  check('an unwritten milestone document is ignored', h.folds.length === 0)
}

// 11. busy must be skipped, never queued behind the summarization
{
  const h = setup({ done: true, tokens: 500000, throwOnFold: true })
  const outcome = await compactOnIdle(h.ctx, h.cfg, { session: { id: 's1' }, membership: { name: 'a1' } }, new AbortController().signal)
  check('a busy engine is skipped rather than retried', outcome.startsWith('skipped'), outcome)
  const retry = await compactOnIdle(h.ctx, h.cfg, { session: { id: 's1' }, membership: { name: 'a1' } }, new AbortController().signal)
  check('a failed fold backs off instead of looping', retry === 'pressure-cooldown', retry)
}

// 12. with no configured path it still listens, against the DSH_HOME default: both
// plugins must independently agree on the file, or a tick arms a document nobody reads
{
  const folds = []
  const ctx = { on: () => { folds.push('listened'); return () => {} } }
  apply(ctx, { windowTokens: 1000000 })
  check('an unconfigured plugin still listens, on the DSH_HOME default', folds.length === 1)
}

// 13. explicit human input must not be swallowed by the milestone pre-step gate
{
  const dir = mkdtempSync(join(tmpdir(), 'milestone-gate-'))
  const path = join(dir, 'team-milestones.json')
  writeFileSync(path, JSON.stringify(createMilestoneDoc()), 'utf8')
  const handlers = new Map()
  const ctx = {
    on: (name, handler) => { handlers.set(name, handler); return () => handlers.delete(name) },
    agentTeams: { tryMembership: () => ({ name: 'lead', id: 'team-1', tier: 0 }) },
    tokenMeter: { measure: () => ({ totalTokens: 800000 }) },
    logger: { info: () => {}, warn: () => {} },
  }
  apply(ctx, { milestonePath: path, windowTokens: 1000000, rejectRatio: 0.75, enablePreStep: true })
  const run = (messages) => handlers.get('agent/pre-step')({ agent: { session: { id: 's1' } }, messages }, async () => ({ kind: 'enter', messages }))
  const human = await run([{ role: 'user', source: { kind: 'user', rpcId: 'rpc-1' }, content: [] }])
  const automatic = await run([{ role: 'user', source: { kind: 'plugin' }, content: [] }])
  check('a user step is not rejected at the auto-compaction threshold', human.kind === 'enter', JSON.stringify(human))
  check('an automatic step is also allowed; idle handles the safety fold', automatic.kind === 'enter', JSON.stringify(automatic))
}

console.log('checks=all failed=' + failed)
process.exit(failed === 0 ? 0 : 1)
