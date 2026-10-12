// Semantic contracts for three behaviours that have each broken in production once.
// Run this file after every upstream package upgrade and after re-applying native patches:
//   node tools/run-regression.mjs --files architecture-tests/upstream-compat-contract.test.mjs
// Each test names the design-doc section (docs/agent-team-v2-design.md) that records the original failure.
import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const stage = fileURLToPath(new URL('..', import.meta.url))
const plugins = join(stage, 'home/profiles/web/plugins')
const load = name => import(pathToFileURL(join(plugins, name)).href)

// ---------------------------------------------------------------------------------------------
// §65 (and §56): a Team member's child settling must not start a new parent turn.
// The 0.1.6 upgrade overwrote this patch once; root was then woken 9 turns, 7 of them empty.
// The class that owns notifySettlement is not exported, so the method is lifted out of the
// installed package source and run against doubles. If upstream renames or removes the method
// this fails loudly, which is the point: the patch has to be re-examined, not assumed.
// ---------------------------------------------------------------------------------------------
function liftMethod(source, signature) {
  const start = source.indexOf(signature)
  assert.notEqual(start, -1, 'method not found in installed package: ' + signature)
  assert.equal(source.indexOf(signature, start + 1), -1, 'method signature is not unique: ' + signature)
  let depth = 0, index = source.indexOf('{', start + signature.length - 1)
  for (; index < source.length; index++) {
    if (source[index] === '{') depth++
    else if (source[index] === '}' && --depth === 0) break
  }
  return source.slice(start, index + 1)
}

// Two physical copies matter: the staged canonical build the lab and regression hosts load (-v15), and the
// plain package directory, which in the staging root is a junction to the production install. Both are
// only read here. Never edit through the plain path in staging: that writes the production file.
const subagentBuilds = ['dsh-subagent-v15', 'dsh-subagent'].map(name => join(stage, 'app/node_modules/@deepseek-ai', name, 'lib/index.js')).filter(existsSync)

function settlementHarness(file) {
  const method = liftMethod(readFileSync(file, 'utf8'), 'async notifySettlement(activation, terminal) {')
  const build = new Function('createSettlementMessage', 'errorChain', `return ({ ${method} }).notifySettlement`)
  const notify = build((childId, terminal) => ({ childId, terminal, source: { kind: 'subagent-settled' } }), error => String(error?.message ?? error))
  return ({ member, closing = false, status = 'idle' }) => {
    const calls = { inject: [], waking: [], warn: [] }
    const parent = { status, inject: async message => { calls.inject.push(message) } }
    const self = {
      ctx: {
        agents: { get: () => parent },
        get: name => name === 'agentTeams' ? { tryMembership: () => { if (member === 'throws') throw new Error('not a member'); return member } } : undefined,
        logger: { warn: text => calls.warn.push(text) },
      },
      closingTeardownFor: () => closing ? {} : undefined,
      sendWaking: async (target, message, mode) => { calls.waking.push({ target, message, mode }) },
    }
    return notify.call(self, { announced: true, parentSession: 'parent', childId: 'child-1' }, { stopReason: 'end', output: [] }).then(() => calls)
  }
}

test('§65 at least one dsh-subagent build is present to check', () => assert.ok(subagentBuilds.length > 0))

for (const file of subagentBuilds) {
const label = file.includes('-v15') ? 'staged canonical' : 'installed'
test('§65 a Team member parent receives the settlement notice without a new turn (' + label + ')', async () => {
  const run = settlementHarness(file)
  const calls = await run({ member: { name: 'lead-a', role: 'teammate' } })
  assert.equal(calls.inject.length, 1)
  assert.equal(calls.waking.length, 0, 'Team member settlement must not wake the parent')
  assert.deepEqual(calls.warn, [])
})

test('§65 a non-Team parent is still woken, so the patch stays scoped to Teams (' + label + ')', async () => {
  const run = settlementHarness(file)
  for (const member of [undefined, 'throws']) {
    const calls = await run({ member })
    assert.equal(calls.waking.length, 1)
    assert.equal(calls.waking[0].mode, 'queue')
    assert.equal(calls.inject.length, 0)
  }
  const busy = await run({ member: undefined, status: 'running' })
  assert.equal(busy.waking[0].mode, 'steer')
})
}

// ---------------------------------------------------------------------------------------------
// Shared Team fixture for §58 and §59: the real policy and tool plugins over a Domain double.
// ---------------------------------------------------------------------------------------------
async function teamFixture() {
  const policyMod = await load('team-policy.mjs'), toolsMod = await load('team-tools-v2-r10.mjs')
  const directory = mkdtempSync(join(tmpdir(), 'dsh-compat-contract-'))
  const sections = new Map(), tools = new Map(), warnings = []
  const agents = []
  const mkAgent = (name, role) => {
    const agent = { name, id: 'session-' + name, status: 'idle', ctx: {
      systemPrompt: { section: definition => { sections.set(name, [...(sections.get(name) ?? []), definition]); return () => {} }, getSectionOrder: () => 0 },
      tools: { register: definition => { tools.set(name + '/' + definition.name, definition); return () => {} } },
      on: () => () => {},
    } }
    agent.membership = { role, name, id: 'team-contract', root: undefined }
    agents.push(agent)
    return agent
  }
  const lead = mkAgent('lead', 'lead'), leadA = mkAgent('lead-a', 'teammate')
  for (const agent of agents) agent.membership.root = lead
  const roster = { rows: () => agents.map(agent => ({ id: agent.membership.id, name: agent.name, role: agent.membership.role, status: 'running', diagnostics: [] })) }
  const frozen = new Map()
  const ctx = {
    agents: { list: () => agents, get: id => agents.find(agent => agent.id === id) },
    agentTeams: {
      tryMembership: agent => agent.membership, membership: agent => agent.membership,
      listMembers: () => roster.rows(),
      setMemberFrozen: async (caller, name, value) => { frozen.set(name, value === true); return { id: 'id-' + name, name, role: 'teammate', status: value ? 'frozen' : 'running', frozen: value === true, diagnostics: [] } },
      listTasks: () => [], getTask: () => ({}), updateTask: async () => ({}), waitForChange: async () => ({ timedOut: true }),
      sendMessage: async () => ({ messageId: 'm1', status: 'accepted' }), interrupt: () => ({ previousStatus: 'running' }),
    },
    subagents: {},
    set: (key, value) => { ctx[key] = value },
    logger: { warn: text => warnings.push(String(text)), info: () => {}, debug: () => {}, error: () => {} },
    on: () => () => {}, effect: () => () => {},
  }
  policyMod.apply(ctx, {})
  const policy = policyMod.policyFor(policyMod.teamKeyOf(ctx, lead))
  policy.put({ name: 'lead-a', tier: 1, group: 'lead-a', parent: 'lead' })
  const milestonePath = join(directory, 'milestones.json')
  writeFileSync(milestonePath, JSON.stringify({ version: 2, teams: {}, members: {}, bands: {}, compactions: {} }))
  toolsMod.apply(ctx, { rolesDir: join(directory, 'roles'), scopesFile: join(directory, 'scopes.json'), reportDir: join(directory, 'reports'),
    clearanceFile: join(directory, 'clearances.json'), milestonePath })
  const call = async (owner, name, args) => {
    const definition = tools.get(owner + '/' + name)
    assert.ok(definition, `tool ${name} is not installed for ${owner}`)
    return definition.execute(args, { agent: agents.find(agent => agent.name === owner), signal: new AbortController().signal })
  }
  return { ctx, policy, roster, sections, warnings, call, milestonePath, lead, leadA }
}

// ---------------------------------------------------------------------------------------------
// §58: the policy registry is rebuilt from the Domain roster on every step, and a failed rebuild
// is reported. The original bug threw on every call inside an empty catch, so freeze and every
// other registry lookup answered unknown-member for members the roster plainly listed.
// ---------------------------------------------------------------------------------------------
test('§58 a failed registry rebuild is logged, and a roster-only member becomes addressable', async () => {
  const f = await teamFixture()
  const rows = f.roster.rows
  f.roster.rows = () => { throw new Error('domain roster unavailable') }
  // Installation already rebuilt once and the result is cached for 500ms; step past that window.
  await new Promise(done => setTimeout(done, 650))
  const attempt = await f.call('lead', 'freeze_member', { target: 'lead-a', frozen: true }).then(() => 'ok', error => String(error?.message ?? error))
  assert.ok(f.warnings.some(text => text.includes('registry rebuild skipped') && text.includes('domain roster unavailable')),
    'a rebuild failure must reach the logger; got ' + JSON.stringify(f.warnings) + ' call=' + attempt)

  // Never put() by hand: it exists only in the Domain roster, as every member does after a restart.
  f.roster.rows = () => [...rows(), { id: 'id-roster-only', name: 'roster-only', role: 'teammate', status: 'running', diagnostics: [], level: 2, groupId: 'lead-a', parentName: 'lead-a' }]
  assert.equal(f.policy.get('roster-only'), undefined)
  const result = await f.call('lead', 'freeze_member', { target: 'roster-only', frozen: true })
  assert.equal(result.previous, false)
  assert.equal(f.policy.get('roster-only')?.tier, 2)
})

// ---------------------------------------------------------------------------------------------
// §59: the system prompt is the cache prefix, so the Team section must be byte-stable across
// turns. Putting live progress there once dropped cache hits from about 99% to 36%.
// Scope: this pins the Team plugin's own contribution. It does not assemble the whole native
// prompt, so a dynamic section added by another package is not caught here.
// ---------------------------------------------------------------------------------------------
test('§59 the Team system-prompt section does not change while Team state changes', async t => {
  const f = await teamFixture()
  const render = () => Object.fromEntries([...f.sections].map(([name, list]) => [name, list.map(section => section.name + '\n' + section.text()).join('\n---\n')]))
  const before = render()
  assert.ok(before.lead.includes('team:policy') && before['lead-a'].includes('lead-a'), 'the fixture must exercise the real section')

  // Everything §59 names as per-turn data: other members' state, roster size, milestones, the clock.
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() })
  t.mock.timers.setTime(Date.now() + 6 * 60 * 60 * 1000)
  f.policy.put({ name: 'a1', tier: 2, group: 'lead-a', parent: 'lead-a' })
  f.policy.put({ name: 'a2', tier: 2, group: 'lead-a', parent: 'lead-a' })
  const rows = f.roster.rows
  f.roster.rows = () => rows().map(row => ({ ...row, status: 'failed', contextRatio: 0.42 }))
  await f.call('lead', 'freeze_member', { target: 'lead-a', frozen: true })
  writeFileSync(f.milestonePath, JSON.stringify({ version: 2, teams: { 'team-contract': { members: { 'lead-a': { owner: 'lead-a', stage: 'S2', doneWhen: 'W', setAt: Date.now(), done: false } }, bands: { 'lead-a': 0.6 }, compactions: {} } }, members: {}, bands: {}, compactions: {} }))

  assert.deepEqual(render(), before)
  for (const text of Object.values(before)) assert.doesNotMatch(text, /\bcontext \d+%|\d{4}-\d{2}-\d{2}T\d{2}:/, 'no live ratio or timestamp in the prompt prefix')
})
