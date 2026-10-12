import { pathToFileURL } from 'node:url'
const base = 'D:\\dsh-test\\home\\profiles\\web\\plugins\\'
const policyMod = await import(pathToFileURL(base + 'team-policy.mjs').href)
const toolsMod = await import(pathToFileURL(base + 'team-tools-v2-r7.mjs').href)
const operatorMod = await import(pathToFileURL(base + 'team-operator-v2.mjs').href)

let failed = 0
const check = (label, cond, detail) => { if (!cond) failed++; console.log((cond ? 'PASS ' : 'FAIL ') + label + (detail !== undefined ? '  ' + detail : '')) }

const commands = []
const spawnCalls = []
const interrupts = []
const frozenWrites = []
const routeWrites = []
const mkAgent = (name) => ({
  name,
  // Team id, not agent id: this is what the Domain reports, and what the operator
  // resolves its per-Team registry from.
  membership: { role: 'lead', name, id: 'team-1' },
  ctx: { systemPrompt: { section: () => () => {}, getSectionOrder: () => 0 }, tools: { register: () => () => {} } },
})
const lead = mkAgent('lead')
const outsider = mkAgent('outsider')
const byAgent = new Map([[lead, lead.membership]])

const ctx = {
  agents: { list: () => [lead] },
  agentTeams: {
    tryMembership: (agent) => byAgent.get(agent),
    membership: (agent) => byAgent.get(agent),
    listMembers: () => [
      { id: 'id-lead', name: 'lead', role: 'lead', status: 'running', diagnostics: [] },
      { id: 'id-omega', name: 'omega', role: 'teammate', status: 'running', diagnostics: [] },
    ],
    spawnTeammate: async (caller, request) => { spawnCalls.push({ caller: caller.name, request }); return { member: { id: 'id-' + request.name, name: request.name, role: 'teammate', status: 'provisioning', diagnostics: [] } } },
    interrupt: (caller, target) => { interrupts.push(target); return { previousStatus: 'running' } },
    setMemberFrozen: async (caller, name, frozen) => { frozenWrites.push({ name, frozen }); return { name, frozen } },
    setMemberRoute: async (caller, name, route) => { routeWrites.push({ name, route }); return { name, route } },
    listTasks: () => [{ id: 'task-1', revision: 1, subject: 'g', description: 'd', status: 'pending', blockedBy: [], writeScopes: [], ready: true }],
    sendMessage: async () => ({ messageId: 'm', status: 'accepted' }),
  },
  commands: { register: (definition) => { commands.push(definition); return () => {} } },
  logger: { warn: () => {} },
  on: () => {},
  effect: () => {},
}

policyMod.apply(ctx, {})
const P = policyMod.policyFor(policyMod.teamKeyOf(ctx, lead))
P.seedRoot(lead)
P.put({ name: 'omega', tier: 1, group: 'omega', parent: 'lead' })
toolsMod.apply(ctx, { reportDir: 'D:\\dsh-test\\phase4-tests\\reports' })
operatorMod.apply(ctx, {})

const team = commands.find((c) => c.name === 'team')
check('the operator registers one team command', team !== undefined)
check('the operator command does not record model input', team.recordInput === false)

const run = (rawInput, agent) => team.handler({ agent: agent ?? lead, rawInput })
const runLine = async (rawInput) => {
  const out = await run(rawInput)
  return out.kind + ': ' + String(out.text).split('\n')[0]
}

// Reads must work even when identity cannot resolve: the panel depends on meta,
// and gating it made every member render as "unregistered".
check('an unrelated session can still list', (await run('list', outsider)).kind === 'success')
check('an unrelated session can still read meta', JSON.parse(String((await run('meta', outsider)).text)) !== null)
check('an unrelated session cannot control a Team', (await run('freeze omega', outsider)).kind === 'error')
check('bare /team prints usage', /list/.test(String((await run('')).text)))

const listed = await run('list')
check('/team list renders the roster', listed.kind === 'success' && /omega/.test(String(listed.text)) && /tier=1/.test(String(listed.text)), String(listed.text).split('\n')[1])

check('/team freeze freezes', (await run('freeze omega')).kind === 'success' && P.get('omega').frozen === true)
const secondFreeze = await run('freeze omega')
check('/team freeze reports the previous value', /was true/.test(String(secondFreeze.text)), String(secondFreeze.text))
const frozenList = await run('list --frozen')
check('a frozen member is shown in the frozen roster tab', /status=frozen/.test(String(frozenList.text)), String(frozenList.text))
check('/team restore restores', (await run('restore omega')).kind === 'success' && P.get('omega').frozen === false)
check('/team freeze rejects an unknown member', (await run('freeze ghost')).kind === 'error')

await run('interrupt omega')
check('/team interrupt reaches the domain', interrupts.includes('omega'))
await run('abort omega')
check('/team abort interrupts and freezes', interrupts.filter((t) => t === 'omega').length === 2 && P.get('omega').frozen === true)
await run('restore omega')

const routed = await run('route omega deepseek-official deepseek-flash low')
check('/team route applies a model change', routed.kind === 'success' && /deepseek-flash @low/.test(String(routed.text)), String(routed.text))
check('/team route needs all three arguments', (await run('route omega deepseek-official')).kind === 'error')
check('/team route rejects an unknown member', (await run('route ghost p m')).kind === 'error')

const spawnBad = await run('spawn child 2 group-a')
check('/team spawn still obeys the tier rule', spawnBad.kind === 'error' && /spawn-denied/.test(String(spawnBad.text)), String(spawnBad.text))
const spawnOk = await run('spawn group-a 1 group-a lead the group')
// regression: the domain spawn result nests the member under `member`; reading
// `.name` off the envelope registered every operator-spawned member as
// "undefined", which silently broke its tier lookup.
check('/team spawn creates a lead and registers it', spawnOk.kind === 'success' && P.get('group-a') !== undefined && P.get('group-a').tier === 1 && P.get('group-a').parent === 'lead', String(spawnOk.text))
check('/team spawn registers under the real name', P.get('undefined') === undefined && P.all().every((m) => typeof m.name === 'string' && m.name.length > 0))
check('/team spawn validates the tier argument', (await run('spawn x 3 g')).kind === 'error')

check('an unknown subcommand is refused', (await run('frobnicate')).kind === 'error')

// /team meta feeds the shipped panel: the domain roster is flat, so level and
// group reach the browser only through this command's JSON.
const metaOut = await run('meta')
const parsed = metaOut.kind === 'success' ? JSON.parse(String(metaOut.text)) : null
check('/team meta returns parseable JSON', parsed !== null, String(metaOut.text).slice(0, 80))
check('meta carries everyone with level and group',
  parsed !== null && parsed.members.some((m) => m.name === 'omega' && m.tier === 1 && m.group === 'omega'),
  parsed === null ? '-' : JSON.stringify(parsed.members.find((m) => m.name === 'omega')))
await run('freeze omega')
const frozenMeta = JSON.parse(String((await run('meta')).text))
const frozenRow = frozenMeta.members.find((m) => m.name === 'omega')
await run('restore omega')
check('meta marks frozen members', frozenRow !== undefined && frozenRow.frozen === true, JSON.stringify(frozenRow))
check('meta reports a tier for every member', frozenMeta.members.every((m) => typeof m.tier === 'number'), JSON.stringify(frozenMeta.members))
check('tier 0 has no group board of its own', !parsed.boards.some((b) => b.id === 'group-root'), parsed.boards.map((b) => b.id).join(','))
check('meta lists the global board with its tasks', parsed !== null && parsed.boards.some((b) => b.id === 'global' && b.tasks.length === 1), parsed === null ? '-' : JSON.stringify(parsed.boards.map((b) => b.id + ':' + b.tasks.length)))
check('meta lists a level board per used tier', parsed !== null && parsed.boards.some((b) => b.id === 'level-1' && b.tier === 1), parsed === null ? '-' : JSON.stringify(parsed.boards.map((b) => b.id)))
check('meta lists group boards', parsed !== null && parsed.boards.some((b) => b.id === 'group-omega' && b.group === 'omega'), parsed === null ? '-' : JSON.stringify(parsed.boards.map((b) => b.id)))

// The operator channel must persist control actions in the journal, not just in memory.
check('/team freeze persists the durable member record', frozenWrites.some((w) => w.name === 'omega' && w.frozen === true), JSON.stringify(frozenWrites))
check('/team route persists the pinned route', routeWrites.length > 0 && routeWrites[routeWrites.length - 1].route.model !== undefined, JSON.stringify(routeWrites))

console.log('---')
console.log('checks=all failed=' + failed)
process.exit(failed === 0 ? 0 : 1)
