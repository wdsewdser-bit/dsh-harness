import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
const base = 'D:\\dsh-test\\home\\profiles\\web\\plugins\\'
const policyMod = await import(pathToFileURL(base + 'team-policy.mjs').href)
const toolsMod = await import(pathToFileURL(base + 'team-tools-v2.mjs').href)

let failed = 0
const check = (label, cond, detail) => { if (!cond) failed++; console.log((cond ? 'PASS ' : 'FAIL ') + label + (detail !== undefined ? '  ' + detail : '')) }

// ---- fake cordis context -------------------------------------------------
const registrations = []
const members = []
const taskRows = []
const spawnCalls = []
const frozenByName = new Map()
const routeWrites = []
const messages = []
const interrupts = []

const mkAgent = (name, role) => {
  const agent = { name, ctx: { systemPrompt: { section: () => () => {}, getSectionOrder: () => 0 }, tools: { register: (d) => { registrations.push({ owner: name, def: d }); return () => {} } } } }
  // The Domain always reports the live root Lead alongside the role, and spawn
  // authority is resolved from it; a fixture without it would not be faithful.
  // The Domain reports the TEAM id here, not the agent id: every member of one Team
  // resolves to the same membership.id (TeamId(root.id)), which is what makes a Team
  // addressable as a unit. A per-agent id made two Teams in one process share (or split)
  // state depending on the id, which is exactly the bug the isolation test pins down.
  agent.membership = { role, name, id: 'team-1', root: undefined }
  return agent
}

const lead = mkAgent('lead', 'lead')
const leadA = mkAgent('lead-a', 'teammate')
const a1 = mkAgent('a1', 'teammate')
const verifier = mkAgent('verifier', 'teammate')
const b1 = mkAgent('b1', 'teammate')
const allAgents = [lead, leadA, a1, b1, verifier]
for (const agent of allAgents) if (agent !== lead) agent.membership.root = lead
lead.membership.root = lead
const byAgent = new Map(allAgents.map((a) => [a, a.membership]))

const taskResults = []
const ctx = {
  agents: { list: () => allAgents },
  agentTeams: {
    tryMembership: (agent) => byAgent.get(agent),
    membership: (agent) => byAgent.get(agent),
    // The real roster REPORTS frozen (the domain snapshot carries it), which is what makes the
    // policy registry a faithful projection: freeze has to survive the next rebuild, and a
    // restore has to clear it there too. A double that omitted it silently unfroze members.
    listMembers: () => allAgents.map((a) => Object.assign(
      { id: a.membership.id, name: a.membership.name, role: a.membership.role, status: 'running', diagnostics: [] },
      frozenByName.has(a.membership.name) ? { frozen: frozenByName.get(a.membership.name) } : {},
    )),
    spawnTeammate: async (caller, request) => { spawnCalls.push({ caller: caller.name, request }); const m = { id: 'id-' + request.name, name: request.name, role: 'teammate', status: 'provisioning', diagnostics: [] }; members.push(m); return { member: m } },
    sendMessage: async (caller, request) => { messages.push({ from: caller.membership.name, to: request.target }); return { messageId: 'm1', status: 'accepted' } },
    interrupt: (caller, target) => { interrupts.push({ from: caller.membership.name, to: target }); return { previousStatus: 'running' } },
    setMemberFrozen: async (caller, name, frozen) => {
      const member = allAgents.find((agent) => agent.membership.name === name)
      frozenByName.set(name, frozen === true)
      return { id: member?.membership.id ?? 'id-' + name, name, role: 'teammate', status: frozen === true ? 'frozen' : 'running', frozen: frozen === true, diagnostics: [] }
    },
    setMemberRoute: async (caller, name, route) => { routeWrites.push({ by: caller.membership.name, name, route }); return { name, route } },
    createTask: async (caller, request) => { taskResults.push({ board: 'global', by: caller.membership.name, request }); return { id: 'gt1', revision: 1, subject: request.subject, description: request.description, status: 'pending', blockedBy: [], writeScopes: [], ready: true, writeScopeWarnings: [] } },
    listTasks: () => taskRows,
    getTask: () => ({}),
    updateTask: async () => ({}),
    waitForChange: async () => ({ timedOut: true }),
  },
  set: (k, v) => { ctx[k] = v },
  logger: { warn: () => {} },
  on: () => {},
  effect: () => {},
}

policyMod.apply(ctx, {})
// Seed the SAME Team the tools resolve: policy is per Team now, and this fixture runs
// one Team whose members all report the shared Team id.
const P = policyMod.policyFor(policyMod.teamKeyOf(ctx, lead))
// Build the tier tree by hand, matching what spawn would produce. The Lead is
// deliberately NOT pre-seeded: in production nothing seeds it either, and the
// tools must do it themselves, or the first task call is refused as a non-member.
check('the Lead is unregistered before its first call', P.get('lead') === undefined)
P.put({ name: 'lead-a', tier: 1, group: 'lead-a', parent: 'lead' })
P.put({ name: 'a1', tier: 2, group: 'lead-a', parent: 'lead-a' })
P.put({ name: 'b1', tier: 2, group: 'lead-b', parent: 'lead-b' })
P.put({ name: 'verifier', tier: 1, group: 'verifier', parent: 'lead' })

// install tools into every scope
writeFileSync('D:\\dsh-test\\phase3-tests\\_milestones.json', JSON.stringify({
  version: 2,
  teams: { 'team-1': { members: { a1: { owner: 'a1', stage: 'S', doneWhen: 'W', setAt: 1, done: true } }, bands: {}, compactions: {} } },
  members: {}, bands: {}, compactions: {},
}), 'utf8')
toolsMod.apply(ctx, { scopesFile: 'D:\\dsh-test\\phase3-tests\\_scopes.json', reportDir: 'D:\\dsh-test\\phase3-tests\\reports', milestonePath: 'D:\\dsh-test\\phase3-tests\\_milestones.json' })

const toolOf = (owner, name) => {
  const row = registrations.find((r) => r.owner === owner && r.def.name === name)
  return row ? row.def : undefined
}
const call = async (owner, toolName, args) => {
  const agent = allAgents.find((a) => a.name === owner)
  const def = toolOf(owner, toolName)
  if (def === undefined) throw new Error('tool ' + toolName + ' not installed for ' + owner)
  try {
    const value = await def.execute(args, { agent, signal: undefined })
    return { ok: true, value }
  } catch (error) {
    return { ok: false, message: String(error && error.message) }
  }
}

check('nine tools installed per scope', ['spawn_teammate','send_message','list_agents','wait_agent','interrupt_agent','freeze_member','set_member_route','team_task_create','team_task_list','team_task_get','team_task_update'].every((n) => toolOf('lead', n) !== undefined))

const r1 = await call('a1', 'spawn_teammate', { name: 'x', description: 'd', prompt: 'p' })
check('tier 2 cannot spawn (code refusal)', r1.ok === false && /tier-cap/.test(r1.message), r1.message)

const r2 = await call('lead-a', 'spawn_teammate', { name: 'a2', description: 'd', prompt: 'p', tier: 2 })
check('tier 1 may spawn its own member', r2.ok === true, JSON.stringify(r2.message))
check('spawn is authorized by the ROOT lead identity', spawnCalls.length === 1 && spawnCalls[0].caller === 'lead', JSON.stringify(spawnCalls.map((s) => s.caller)))
check('new member is recorded under its real parent', (P.get('a2') || {}).parent === 'lead-a' && (P.get('a2') || {}).tier === 2)

const r3 = await call('lead-a', 'spawn_teammate', { name: 'a3', description: 'd', prompt: 'p', tier: 2 })
const r4 = await call('lead-a', 'spawn_teammate', { name: 'a4', description: 'd', prompt: 'p', tier: 2 })
check('group lead may spawn a fourth member', r4.ok === true, r4.message)
for (const name of ['a5','a6','a7','a8']) {
  const spawned = await call('lead-a', 'spawn_teammate', { name, description: 'd', prompt: 'p', tier: 2 })
  check('group lead may spawn member ' + name, spawned.ok === true, spawned.message)
}
const capResult = await call('lead-a', 'spawn_teammate', { name: 'a9', description: 'd', prompt: 'p', tier: 2 })
check('group lead stops at eight members', capResult.ok === false && /capped at 8/.test(capResult.message), capResult.message)

const r5 = await call('a1', 'send_message', { target: 'lead', message: 'hi', delivery: 'info' })
check('tier 2 cannot message the Lead', r5.ok === false && /message-scope/.test(r5.message), r5.message)
const r6 = await call('a1', 'send_message', { target: 'a2', message: 'hi', delivery: 'info' })
check('tier 2 may message same-group peer', r6.ok === true)
check('ordinary send_message does not wake native recipient', messages.length === 0)
check('ordinary send_message records a non-waking dispatch',
  r6.ok === true && typeof r6.value.dispatchId === 'string'
    && P.control.dispatchGet(r6.value.dispatchId)?.wakeup === false
    && P.control.dispatchGet(r6.value.dispatchId)?.status === 'completed')
const r7 = await call('a1', 'send_message', { target: 'b1', message: 'hi', delivery: 'info' })
check('tier 2 cannot message another group', r7.ok === false, r7.message)

const r8 = await call('a1', 'interrupt_agent', { target: 'a2' })
check('same-level interrupt refused', r8.ok === false && /interrupt-scope/.test(r8.message), r8.message)
const r9 = await call('lead-a', 'interrupt_agent', { target: 'a2' })
check('lead may interrupt its own member', r9.ok === true)
const r10 = await call('lead-a', 'interrupt_agent', { target: 'b1' })
check('lead cannot interrupt another group', r10.ok === false, r10.message)

const r11 = await call('a1', 'list_agents', {})
check('roster hides other groups from a member', r11.ok === true && !r11.value.some((m) => m.name === 'b1'), JSON.stringify((r11.value || []).map((m) => m.name)))
const r12 = await call('lead-a', 'list_agents', {})
check('roster hides other groups from a lead', r12.ok === true && !r12.value.some((m) => m.name === 'b1'), JSON.stringify((r12.value || []).map((m) => m.name)))
const r13 = await call('lead', 'list_agents', {})
// CHANGED DELIBERATELY. This used to assert that tier 0 could NOT see tier 2. A real run
// proved that rule makes tier 0's own powers unusable: the Lead is the only member that can
// freeze, restore or route anyone, yet it had to guess tier-2 names (c1, c-forge, c-artist...)
// and every guess was refused. Tier 0 now gets the whole roster as a MANAGEMENT view.
// Message scope is unchanged and is asserted below.
check('tier 0 sees the whole roster, including tier 2', r13.ok === true && ['lead', 'lead-a', 'verifier', 'a1'].every((n) => r13.value.some((m) => m.name === n)))

// regression: the registry rejects a tool result that is not lossless JSON,
// which an `undefined` field silently produces (real failure seen end-to-end).
const lossless = (v) => JSON.stringify(JSON.parse(JSON.stringify(v))) === JSON.stringify(v)
const rl1 = await call('lead', 'list_agents', {})
check('list_agents output is lossless JSON', rl1.ok === true && lossless(rl1.value), rl1.message)
const rl2 = await call('lead', 'spawn_teammate', { name: 'gamma', description: 'd', prompt: 'p', tier: 1, group: 'gamma' })
check('spawn result is lossless JSON', rl2.ok === true && lossless(rl2.value), rl2.message)
check('spawn result echoes tier and group', rl2.ok === true && rl2.value.member.tier === 1 && rl2.value.member.group === 'gamma', JSON.stringify(rl2.value))

const r14 = await call('lead-a', 'team_task_create', { subject: 's', description: 'd', kind: 'discussion' })
check('global board write refused for tier 1', r14.ok === false && /global-board-write/.test(r14.message), r14.message)
const r15 = await call('lead', 'team_task_create', { subject: 's', description: 'd', kind: 'discussion' })
check('global board write allowed for tier 0', r15.ok === true)
check('task output includes createdAt so the declared schema is valid',
  r15.ok === true && Number.isInteger(r15.value.createdAt), JSON.stringify(r15.value))
check('task creation does not silently open a task round',
  r15.ok === true && P.control.snapshot().rooms['task:' + r15.value.id] === undefined)
const rRoot = await call('lead-a', 'send_message', { target: 'root', message: 'root alias probe', delivery: 'info' })
check('root is resolved to the actual tier-0 member',
  rRoot.ok === true && rRoot.value.roomId === 'root', JSON.stringify(rRoot))
check('quiet upward traffic completes instead of staying delivered',
  rRoot.ok === true && P.control.dispatchGet(rRoot.value.dispatchId)?.status === 'completed')
const r16 = await call('lead-a', 'team_task_create', { subject: 's', description: 'd', kind: 'discussion', board: 'group' })
check('group board write allowed for the group lead', r16.ok === true && /lead-a/.test((r16.value || {}).board || ''), JSON.stringify(r16.value && r16.value.board))
const r17 = await call('a1', 'team_task_list', { board: 'group' })
check('member reads its own group board', r17.ok === true && r17.value.tasks.length === 1, JSON.stringify((r17.value || {}).tasks))

// A room round hands control to the next speaker automatically, once per
// transition, and finally wakes the host to close it. These wakes are control
// deliveries, not ordinary model-to-model messages.
const roomOpen = await call('lead-a', 'team_room_open', {
  room_id: 'group:lead-a:tier-2', kind: 'group', title: 'handoff probe', members: ['a1'],
})
const roomNext = await call('lead-a', 'team_room_next', {
  room_id: 'group:lead-a:tier-2', topic: 'handoff', members: ['a1', 'lead-a'],
})
check('starting a room round wakes the first speaker',
  roomOpen.ok === true && roomNext.ok === true && roomNext.value.wakeTarget === 'a1'
    && roomNext.value.wakeStatus === 'delivered', JSON.stringify(roomNext))
const firstTurn = await call('a1', 'team_room_post', {
  room_id: 'group:lead-a:tier-2', round_id: roomNext.value.roundId,
  kind: 'proposal', content: 'first speaker proposal',
})
check('advancing a round wakes only the next speaker',
  firstTurn.ok === true && firstTurn.value.wakeTarget === 'lead-a'
    && messages.filter((row) => row.to === 'lead-a').length === 1, JSON.stringify(firstTurn))
const hostTurn = await call('lead-a', 'team_room_post', {
  room_id: 'group:lead-a:tier-2', round_id: roomNext.value.roundId,
  kind: 'proposal', content: 'host closes the speaking order',
})
check('a host speaking last does not wake itself to close',
  hostTurn.ok === true && hostTurn.value.wakeTarget === undefined, JSON.stringify(hostTurn))
const clarificationTurn = await call('a1', 'team_room_post', {
  room_id: 'group:lead-a:tier-2', round_id: roomNext.value.roundId,
  kind: 'clarification', content: 'one clarification',
})
check('a clarification does not re-wake a completed handoff',
  clarificationTurn.ok === true && clarificationTurn.value.wakeTarget === undefined
    && messages.filter((row) => row.to === 'lead-a').length === 1, JSON.stringify(clarificationTurn))
const closedRoom = await call('lead-a', 'team_room_close', {
  room_id: 'group:lead-a:tier-2', round_id: roomNext.value.roundId, summary: 'round one complete', unresolved: [],
})
const finalRound = await call('lead-a', 'team_room_next', {
  room_id: 'group:lead-a:tier-2', topic: 'final handoff', members: ['lead-a', 'a1'],
})
check('a host-first round does not wake the host',
  closedRoom.ok === true && finalRound.ok === true && finalRound.value.wakeTarget === undefined, JSON.stringify(finalRound))
const hostFirst = await call('lead-a', 'team_room_post', {
  room_id: 'group:lead-a:tier-2', round_id: finalRound.value.roundId,
  kind: 'proposal', content: 'host opens the order',
})
check('the host turn wakes the remaining speaker',
  hostFirst.ok === true && hostFirst.value.wakeTarget === 'a1', JSON.stringify(hostFirst))
const finalSpoken = await call('a1', 'team_room_post', {
  room_id: 'group:lead-a:tier-2', round_id: finalRound.value.roundId,
  kind: 'proposal', content: 'last speaker proposal',
})
check('the final speaker wakes the host to close the round',
  finalSpoken.ok === true && finalSpoken.value.wakeTarget === 'lead-a'
    && messages.filter((row) => row.to === 'lead-a').length === 2, JSON.stringify(finalSpoken))

const r18 = await call('lead-a', 'freeze_member', { target: 'a1', frozen: true })
check('freeze is tier-0 only', r18.ok === false && /operator-only/.test(r18.message), r18.message)
const r19 = await call('lead', 'freeze_member', { target: 'a1', frozen: true })
check('tier 0 may freeze', r19.ok === true && r19.value.frozen === true)
const r20 = await call('a1', 'send_message', { target: 'a2', message: 'hi', delivery: 'info' })
check('frozen member cannot send', r20.ok === false, r20.message)
const r21 = await call('b1', 'send_message', { target: 'a1', message: 'hi', delivery: 'info' })
check('frozen member cannot receive', r21.ok === false && /message-scope/.test(r21.message), r21.message)
const r22 = await call('lead', 'interrupt_agent', { target: 'a1' })
check('frozen member cannot be interrupted', r22.ok === false, r22.message)
// regression: a teammate is NOT a permanently live agent. The domain lets it go
// inactive between turns and cold-resumes it, so a route change must be accepted
// from the recorded member even when ctx.agents.list() has no agent for it.
// (Real end-to-end run returned applied:false for exactly that case.)
const inactive = P.all().find((m) => m.tier === 1 && !allAgents.some((a) => a.name === m.name))
check('harness has an inactive but registered member', inactive !== undefined, JSON.stringify(P.all().map((m) => m.name)))
const rRoute = await call('lead', 'set_member_route', { target: inactive.name, provider: 'deepseek-official', model: 'deepseek-flash', reasoning_effort: 'low' })
check('route change accepted for an inactive member', rRoute.ok === true && rRoute.value.applied === true, JSON.stringify(rRoute.value))
const rRouteBad = await call('lead', 'set_member_route', { target: 'ghost', provider: 'p', model: 'm' })
check('route change refused for an unknown member', rRouteBad.ok === false && /unknown-member/.test(rRouteBad.message), rRouteBad.message)

const r23 = await call('lead', 'freeze_member', { target: 'a1', frozen: false })
check('restore works', r23.ok === true && r23.value.previous === true)

// ---- per-level boards ----
const rB1 = await call('lead-a', 'team_task_create', { subject: 'lvl1', description: 'd', kind: 'discussion', board: 'level' })
check('tier 1 writes its own level board', rB1.ok === true && rB1.value.board === 'level-1', JSON.stringify(rB1.value))
const rB2 = await call('a1', 'team_task_create', { subject: 'lvl2', description: 'd', kind: 'discussion', board: 'level' })
check('tier 2 writes its own level board', rB2.ok === true && rB2.value.board === 'level-2', JSON.stringify(rB2.value))
const rB3 = await call('lead-a', 'team_task_list', { board: 'level' })
check('level boards are separate per tier', rB3.ok === true && rB3.value.tasks.length === 1 && rB3.value.tasks[0].subject === 'lvl1', JSON.stringify(rB3.value && rB3.value.tasks.map((x) => x.subject)))
const rB4 = await call('b1', 'team_task_create', { subject: 'x', description: 'd', kind: 'discussion', board: 'group' })
check('a tier-2 member writes only its own group board', rB4.ok === true && rB4.value.board === 'group-lead-b', JSON.stringify(rB4.value))

// ---- verifier workflow ----
const rV1 = await call('lead-a', 'verifier_report', { name: 'x', summary: 's', issues: [{ severity: 'major', title: 't', evidence: 'e' }] })
check('verifier_report is verifier-only', rV1.ok === false && /verifier-only/.test(rV1.message), rV1.message)
const rV2 = await call('verifier', 'verifier_report', { name: 'x', summary: 's', issues: [] })
check('empty verdict is refused', rV2.ok === false && /empty-report/.test(rV2.message), rV2.message)
const rV3 = await call('verifier', 'verifier_report', { name: 'x', summary: 's', issues: [{ severity: 'blocker', title: 'no evidence here', evidence: '   ' }] })
check('an issue without evidence is refused', rV3.ok === false && /missing-evidence/.test(rV3.message), rV3.message)
const rV4 = await call('verifier', 'verifier_report', { name: 'x', summary: 's', issues: [{ severity: 'nope', title: 't', evidence: 'e' }] })
// The argument schema rejects an out-of-enum severity before the handler runs;
// the handler check remains as defense in depth if the schema is ever relaxed.
check('an unknown severity is refused', rV4.ok === false && /severity/.test(rV4.message), rV4.message)
const rV5 = await call('verifier', 'verifier_report', {
  name: 'Round 1',
  summary: 'two defects',
  issues: [
    { severity: 'minor', title: 'tyle', evidence: 'npm run lint -> 1 warning', location: 'a.ts:3' },
    { severity: 'blocker', title: 'crash', evidence: 'npm test -> TypeError at a.ts:9', location: 'a.ts:9' },
  ],
})
check('verifier publishes a report', rV5.ok === true && rV5.value.issues === 2, rV5.message)
check('report sorts worst first and counts severities', rV5.ok === true && rV5.value.bySeverity.blocker === 1 && rV5.value.bySeverity.minor === 1, JSON.stringify(rV5.value && rV5.value.bySeverity))
check('report notifies every group lead', rV5.ok === true && rV5.value.notified.includes('lead-a'), JSON.stringify(rV5.value && rV5.value.notified))
const reportPath = rV5.ok ? rV5.value.path : ''
check('report file is written with a severity table', reportPath.length > 0 && existsSync(reportPath) && /\| severity \| issue \|/.test(readFileSync(reportPath, 'utf8')), reportPath)
check('report path stays inside the configured directory', reportPath.includes('phase3-tests\\reports'), reportPath)

console.log('---')
// ---- standing identities ----
// A built-in role must pin tier and group and prepend the identity file, so the
// Lead only writes a brief.
const rl = await call('lead', 'spawn_teammate', { name: 'lead-c', role: 'lead', prompt: 'own the renderer group' })
check('role lead pins tier 1 and takes the name as its group', rl.ok && rl.value.member.tier === 1 && rl.value.member.group === 'lead-c', JSON.stringify(rl).slice(0, 160))
const lastRequest = spawnCalls[spawnCalls.length - 1].request
check('role lead prepends the standing identity', lastRequest.prompt[0].text.includes('组长身份') && lastRequest.prompt[0].text.includes('own the renderer group'), lastRequest.prompt[0].text.slice(0, 120))
check('a built-in role defaults its own description', lastRequest.description === '组长', String(lastRequest.description))
// lead-a is already at its group cap, so free one slot the way a real rework would.
P.registry.members.delete('a2')
const rm = await call('lead-a', 'spawn_teammate', { name: 'a5', role: 'member', prompt: 'implement water' })
check('role member pins tier 2 and inherits the caller group', rm.ok && rm.value.member.tier === 2 && rm.value.member.group === 'lead-a', JSON.stringify(rm).slice(0, 160))
const rc = await call('lead', 'spawn_teammate', { name: 'x9', role: 'custom' })
check('role custom without a prompt is refused', !rc.ok, String(rc.message))

// ---- §7.2.4 a claim must stay inside the claimer's declared write scope ----
// The scope file is written only here, so every earlier claim read a missing file
// and skipped the check exactly as an undeclared member does in production.
writeFileSync('D:\\dsh-test\\phase3-tests\\_scopes.json', JSON.stringify({ byName: { a1: ['src/ui'] } }))
const inScope = await call('lead-a', 'team_task_create', { subject: 'in scope', description: 'd', kind: 'edit', write_scopes: ['src/ui/hud.js'], board: 'group' })
const outScope = await call('lead-a', 'team_task_create', { subject: 'out of scope', description: 'd', kind: 'edit', write_scopes: ['src/engine/mesh.js'], board: 'group' })
const claimIn = await call('a1', 'team_task_update', { task_id: inScope.value.id, expected_revision: 1, action: 'claim', board: 'group' })
const claimOut = await call('a1', 'team_task_update', { task_id: outScope.value.id, expected_revision: 1, action: 'claim', board: 'group' })
check('a member claims a task inside its declared scope', claimIn.ok, JSON.stringify(claimIn).slice(0, 160))
check('a member cannot claim a task outside its declared scope', !claimOut.ok && String(claimOut.message).includes('outside the declared scope'), String(claimOut.message))

// ---- freeze is durable in the Team control plane, not the shipped Domain ----
const fr = await call('lead', 'freeze_member', { target: 'a1', frozen: true })
const frozenRows = P.control.frozenMembers()
check('freezing a member writes the durable control-plane record', fr.ok && frozenRows.some((row) => row.member === 'a1' && row.frozen === true), JSON.stringify(frozenRows))
const rt = await call('lead', 'set_member_route', { target: 'a1', provider: 'p', model: 'm', reasoning_effort: 'high' })
const lastRt = routeWrites[routeWrites.length - 1]
check('re-routing a member persists provider, model and effort', rt.ok && lastRt.route.model === 'm' && lastRt.route.reasoningEffort === 'high', JSON.stringify(routeWrites))
check('a non-lead cannot persist a route change', (await call('a1', 'set_member_route', { target: 'a1', provider: 'p', model: 'm' })).ok === false, 'tier gate')

// ---- delivery is a fact about the board, not an impression ----
taskRows.push({ id: 'task-9', subject: 'A: engine', status: 'in_progress', ownerName: 'a1' })
await call('a1', 'team_milestone', { action: 'set', stage: 'finish task-9', done_when: 'board complete' })
const milestoneDone = await call('a1', 'team_milestone', { action: 'done' })
check('ticking a milestone warns about still-open owned board tasks',
  milestoneDone.ok === true && milestoneDone.value.openTasks?.length > 0
    && String(milestoneDone.value.notice).includes(milestoneDone.value.openTasks[0]),
  JSON.stringify(milestoneDone))
const dc = await call('lead', 'team_delivery_check', {})
check('an open task makes the work undeliverable', dc.ok && dc.value.deliverable === false && dc.value.open.some((row) => row.id === 'task-9'), JSON.stringify(dc).slice(0, 200))
check('a ticked owner milestone reads as a bookkeeping miss', dc.value.open.find((row) => row.id === 'task-9')?.verdict === 'owner-forgot-to-mark-it', JSON.stringify(dc.value.open))
taskRows.length = 0
// The delivery gate now counts every durable board task, not only planned ones.
// Earlier policy subtests left scratch tasks on the group/level boards; retire them
// so this assertion still means 'a clean board is deliverable'.
for (const board of Object.values(P.control.snapshot().boards ?? {})) {
  for (const task of Object.values(board.tasks ?? {})) {
    if (task.status === 'deleted') continue
    await P.control.boardUpdate({ boardId: board.boardId, taskId: task.id, expectedRevision: task.revision, action: 'delete', actorName: 'lead' })
  }
}
const dc2 = await call('lead', 'team_delivery_check', {})
check('a clear board is deliverable', dc2.ok && dc2.value.deliverable === true && dc2.value.openCount === 0)
check('only tier 0 may declare delivery', (await call('a1', 'team_delivery_check', {})).ok === false)
taskRows.push({ id: 'task-8', subject: 'orphan', status: 'pending' })
const dc3 = await call('lead', 'team_delivery_check', {})
check('a task with no owner is reported as such', dc3.value.open[0].verdict === 'no-owner', JSON.stringify(dc3.value.open))

// ---- the registry must be rebuilt FROM the roster, not only from hand-written puts ----
// The regression that made freeze_member answer unknown-member in a real session: policy()
// passed the service object where reconcileRegistry wants the registry, so the rebuild threw
// on every call and an empty catch hid it. Every older assertion still passed, because the
// fixture put() every member by hand and so never needed the rebuild at all.
{
  const base = ctx.agentTeams.listMembers
  ctx.agentTeams.listMembers = () => [...base(), { id: 'id-roster-only', name: 'roster-only', role: 'teammate', status: 'running', diagnostics: [], level: 2, groupId: 'lead-a', parentName: 'lead-a' }]
  const frozen = await call('lead', 'freeze_member', { target: 'roster-only', frozen: true })
  check('a member known only to the roster becomes addressable and freezable', frozen.ok && frozen.value.previous === false, JSON.stringify(frozen))
  check('and it landed in the registry with its tier', P.get('roster-only') !== undefined && P.get('roster-only').tier === 2, JSON.stringify(P.get('roster-only')))
}

console.log('checks=all failed=' + failed)
process.exit(failed === 0 ? 0 : 1)
