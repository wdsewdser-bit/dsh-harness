#!/usr/bin/env node
/** Phase 6: the whole-Team usage projection the composer pill reads. */
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { zstdCompressSync } from 'node:zlib'
import { apply, computeUsage, usageView } from '../home/profiles/web/plugins/team-usage-projection.mjs'

let failed = 0
function check(name, ok, detail) {
  if (!ok) failed += 1
  console.log((ok ? 'PASS ' : 'FAIL ') + name + (ok || detail === undefined ? '' : '  ' + detail))
}
const settle = () => new Promise((resolve) => setTimeout(resolve, 20))

const writeSession = (root, id, parent, tokens) => {
  const dir = join(root, 'ws', id)
  mkdirSync(dir, { recursive: true })
  const body = JSON.stringify({ type: 'session', version: 3, id, parentSession: parent }) + '\n'
    + JSON.stringify({ type: 'assistant/message', data: { usage: { inputTokens: tokens, outputTokens: 0, cacheReadTokens: 0, totalTokens: tokens } } }) + '\n'
  writeFileSync(join(dir, 'session.v3.jsonl.zstd'), zstdCompressSync(Buffer.from(body)))
}

// ---- the view shape ----
{
  const view = usageView({ agents: 3, total: 300, leadTotal: 100, otherTotal: 200, cached: 50 }, 7)
  check('the view carries the whole-Team numbers and the Lead share', view.total === 300 && view.agents === 3 && view.leadTotal === 100 && view.otherTotal === 200 && view.cached === 50 && view.at === 7, JSON.stringify(view))
}

// ---- summing a real store layout ----
{
  const base = mkdtempSync(join(tmpdir(), 'useproj-'))
  writeSession(base, 'root', '', 100)
  writeSession(base, 'child', 'root', 200)
  writeSession(base, 'stranger', '', 9999)
  const view = computeUsage(base, 'root', 1)
  check('the projection sums the Team, not the session', view.total === 300 && view.agents === 2, JSON.stringify(view))
  check('the Lead share is separated from the rest', view.leadTotal === 100 && view.otherTotal === 200)
  check('an unrelated session is excluded', view.total !== 300 + 9999)
  check('an unknown root yields null rather than a zero total', computeUsage(base, 'ghost', 1) === null)
}

// ---- the plugin appends the view on the Lead's idle edge ----
{
  const base = mkdtempSync(join(tmpdir(), 'useproj2-'))
  writeSession(base, 'root', '', 100)
  writeSession(base, 'child', 'root', 200)
  const handlers = new Map()
  const registrations = []
  const appended = []
  const ctx = {
    sessionProjections: { register: (spec) => registrations.push(spec) },
    on: (name, handler) => { handlers.set(name, handler); return () => handlers.delete(name) },
    agentTeams: { tryMembership: (agent) => agent.membership },
  }
  apply(ctx, { sessionsDir: base })
  check('a teamUsage projection unit is registered', registrations.length === 1 && registrations[0].key === 'teamUsage', JSON.stringify(registrations.map((r) => r.key)))
  const spec = registrations[0]
  check('an empty session starts with no total', spec.init() === null)
  check('an unrelated event leaves the total alone', spec.apply(null, { type: 'turn/start' }) === null)
  const view = { agents: 2, total: 300, leadTotal: 100, otherTotal: 200, cached: 0, at: 1 }
  check('a team/usage event becomes the view', spec.apply(null, { type: 'team/usage', data: view }) === view)

  const lead = { session: { append: (type, data) => appended.push({ type, data }) }, membership: { name: 'lead', id: 'root', role: 'lead' } }
  const member = { session: { append: () => appended.push({ type: 'should-not-happen' }) }, membership: { name: 'a1', id: 'child', role: 'teammate' } }
  handlers.get('agent/status')({ agent: lead, status: 'running' })
  await settle()
  check('a running Lead is not summed', appended.length === 0)
  handlers.get('agent/status')({ agent: member, status: 'idle' })
  await settle()
  check('a teammate going idle is not summed', appended.length === 0)
  handlers.get('agent/status')({ agent: lead, status: 'idle' })
  await settle()
  check('the Lead going idle appends the whole-Team view', appended.length === 1 && appended[0].type === 'team/usage' && appended[0].data.total === 300, JSON.stringify(appended))
  check('the appended view is what the projection exposes', appended[0].data.agents === 2 && appended[0].data.leadTotal === 100)
}

// ---- an unusable store must not break the agent ----
{
  const ctx = {
    sessionProjections: { register: () => {} },
    on: (name, handler) => { handlers = handler; return () => {} },
    agentTeams: { tryMembership: () => ({ name: 'lead', id: 'root', role: 'lead' }) },
  }
  var handlers
  apply(ctx, { sessionsDir: join(tmpdir(), 'missing-' + Date.now()) })
  let threw = false
  try { handlers({ agent: { session: { append: () => { throw new Error('nope') } } }, status: 'idle' }) } catch { threw = true }
  check('a store or append failure is contained', threw === false)
}

console.log('checks=all failed=' + failed)
process.exit(failed === 0 ? 0 : 1)
