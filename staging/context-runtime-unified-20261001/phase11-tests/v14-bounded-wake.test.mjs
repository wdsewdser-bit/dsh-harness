#!/usr/bin/env node
/**
 * A durable Team mailbox send must not hold a PTC tool call open until a slow
 * target or cold session finishes. The caller gets a bounded acknowledgement;
 * the queued delivery continues in the background and records its terminal
 * state on the control plane.
 */
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const base = pathToFileURL('D:/dsh-test/home/profiles/web/plugins/').href
const policyMod = await import(base + 'team-policy.mjs')
const toolsMod = await import(base + 'team-tools-v2-r10.mjs')

let failed = 0
const check = (label, condition, detail) => {
  if (!condition) failed += 1
  console.log((condition ? 'PASS ' : 'FAIL ') + label + (detail === undefined ? '' : '  ' + detail))
}

const root = mkdtempSync(join(tmpdir(), 'dsh-v14-bounded-wake-'))
const registrations = []
const mkAgent = (name) => ({
  name,
  ctx: {
    systemPrompt: { section: () => () => {}, getSectionOrder: () => 0 },
    tools: {
      register: (definition) => {
        registrations.push({ owner: name, definition })
        return () => {}
      },
    },
  },
})

const lead = mkAgent('lead')
const groupLead = mkAgent('lead-a')
const agents = [lead, groupLead]
const memberships = new Map([
  [lead, { id: 'bounded-team', name: 'lead', role: 'lead', root: lead }],
  [groupLead, { id: 'bounded-team', name: 'lead-a', role: 'teammate', root: lead }],
])
const sent = []
let steerPromptCalls = 0

const ctx = {
  agents: { list: () => agents },
  subagents: {
    steerPrompt: async () => {
      steerPromptCalls += 1
      await new Promise((resolve) => setTimeout(resolve, 5_000))
    },
  },
  agentTeams: {
    tryMembership: (agent) => memberships.get(agent),
    membership: (agent) => memberships.get(agent),
    listMembers: () => agents.map((agent) => ({
      id: 'id-' + agent.name,
      name: agent.name,
      role: memberships.get(agent).role,
      status: 'idle',
      diagnostics: [],
      frozen: false,
      ...(agent === lead ? {} : { level: 1, groupId: 'group-a', parentName: 'lead' }),
    })),
    listTasks: () => [],
    getTask: async () => undefined,
    updateTask: async () => { throw new Error('not used') },
    sendMessage: async (caller, request) => {
      sent.push({ caller: caller.name, target: request.target })
      await new Promise((resolve) => setTimeout(resolve, 250))
      return { messageId: 'team-message-' + String(sent.length) }
    },
    waitForChange: async () => ({ timedOut: true }),
  },
  logger: { warn: () => {} },
  on: () => {},
  effect: () => {},
}

try {
  policyMod.apply(ctx, { controlDir: join(root, 'control') })
  const policy = policyMod.policyFor('bounded-team')
  policy.seedRoot(lead)
  policy.put({ name: 'lead-a', tier: 1, group: 'group-a', parent: 'lead' })
  const cp = policy.control
  let roomOpenCalls = 0
  let roomJoinCalls = 0
  const roomOpen = cp.roomOpen.bind(cp)
  const roomJoin = cp.roomJoin.bind(cp)
  cp.roomOpen = (...args) => {
    roomOpenCalls += 1
    return roomOpen(...args)
  }
  cp.roomJoin = (...args) => {
    roomJoinCalls += 1
    return roomJoin(...args)
  }
  toolsMod.apply(ctx, {
    controlDir: join(root, 'control'),
    scopesFile: join(root, 'scopes.json'),
    milestonePath: join(root, 'milestones.json'),
    rolesDir: join(root, 'roles'),
    wakeAckWaitMs: 40,
  })

  const send = registrations.find((row) => row.owner === 'lead' && row.definition.name === 'send_message')?.definition
  check('the bounded send tool is installed', send !== undefined)

  const started = Date.now()
  const result = await send.execute({
    target: 'lead-a',
    message: 'bounded wake regression',
    delivery: 'action',
    reason: 'verify that a slow mailbox does not block the caller',
  }, { agent: lead, signal: new AbortController().signal })
  const elapsed = Date.now() - started

  check('a slow mailbox returns queued instead of blocking the tool call',
    result.status === 'queued' && elapsed < 1500,
    JSON.stringify({ elapsed, status: result.status }))
  const auditPath = join(root, 'control', 'bounded-team.json.audit.jsonl')
  const statusWritesFor = (messageId) => {
    if (!existsSync(auditPath)) return []
    return readFileSync(auditPath, 'utf8')
      .split(/\r?\n/)
      .filter((line) => line.trim().length > 0)
      .map((line) => JSON.parse(line))
      .filter((row) => row.type === 'wake/message-status' && row.data?.messageId === messageId)
  }
  check('caller return does not duplicate the queued pending status write',
    statusWritesFor(result.messageId).length === 0,
    JSON.stringify(statusWritesFor(result.messageId)))
  const firstRoomOpenCalls = roomOpenCalls
  const firstRoomJoinCalls = roomJoinCalls

  const second = await send.execute({
    target: 'lead-a',
    message: 'second distinct actionable message',
    delivery: 'action',
    reason: 'the second message must not be collapsed into the first',
  }, { agent: lead, signal: new AbortController().signal })
  check('a distinct message coalesced onto a pending episode is still delivered',
    second.status === 'queued' && second.coalesced === true && second.distinct === true && second.pendingCount === 2,
    JSON.stringify(second))
  check('an existing room is reused without repeated roomOpen or roomJoin attempts',
    roomOpenCalls === firstRoomOpenCalls && roomJoinCalls === firstRoomJoinCalls,
    JSON.stringify({ firstRoomOpenCalls, roomOpenCalls, firstRoomJoinCalls, roomJoinCalls }))
  check('a cold target does not await the unbounded steerPrompt path',
    steerPromptCalls === 0,
    JSON.stringify({ steerPromptCalls }))
  check('the mailbox send was attempted once per distinct message',
    sent.length === 2 && sent.every((row) => row.caller === 'lead' && row.target === 'lead-a'),
    JSON.stringify(sent))

  await new Promise((resolve) => setTimeout(resolve, 350))
  const episode = Object.values(cp.view({ history: false }).wakeEpisodes ?? {})
    .find((row) => row.episodeId === 'team-wake:lead:lead-a')
  const dispatch = episode === undefined ? undefined : cp.view({ history: false }).dispatches?.[episode.dispatchId]
  check('background delivery acknowledges the wake after the caller returned',
    episode?.status === 'delivered' && dispatch?.status === 'delivered',
    JSON.stringify({ episode: episode?.status, dispatch: dispatch?.status }))
  check('background delivery records exactly one terminal pending status write',
    statusWritesFor(result.messageId).length === 1,
    JSON.stringify(statusWritesFor(result.messageId)))
  check('the episode preserves both pending messages after delivery',
    Array.isArray(episode?.pendingMessages) && episode.pendingMessages.length === 2
      && episode.pendingMessages.every((row) => row.status === 'delivered'),
    JSON.stringify(episode?.pendingMessages))

  const recover = registrations
    .find((row) => row.owner === 'lead' && row.definition.name === 'team_room_timeout_recover')
    ?.definition
  await cp.roomOpen({
    roomId: 'task:close-timeout',
    kind: 'task',
    host: 'lead-a',
    members: ['lead', 'lead-a'],
  }, lead)
  await cp.roomNext({
    roomId: 'task:close-timeout',
    topic: 'close timeout recovery',
    members: ['lead-a', 'lead'],
  }, lead)
  await cp.roomPost({
    roomId: 'task:close-timeout',
    author: 'lead-a',
    content: 'first main speech',
  }, { name: 'lead-a', tier: 1 })
  await cp.roomPost({
    roomId: 'task:close-timeout',
    author: 'lead',
    content: 'second main speech',
  }, { name: 'lead', tier: 0 })
  const recovered = await recover.execute({
    room_id: 'task:close-timeout',
    action: 'wake-host',
    reason: 'round is awaiting host close beyond the test deadline',
  }, { agent: lead, signal: new AbortController().signal })
  check('awaiting-close recovery can re-wake the host without a speaker retry',
    ['queued', 'delivered'].includes(recovered.status) && recovered.host === 'lead-a',
    JSON.stringify(recovered))

  await cp.roomOpen({
    roomId: 'task:replace-timeout',
    kind: 'task',
    host: 'lead-a',
    members: ['lead', 'lead-a'],
  }, lead)
  await cp.roomNext({ roomId: 'task:replace-timeout', topic: 'replace host', members: ['lead-a', 'lead'] }, lead)
  await cp.roomPost({ roomId: 'task:replace-timeout', author: 'lead-a', content: 'first' }, { name: 'lead-a', tier: 1 })
  await cp.roomPost({ roomId: 'task:replace-timeout', author: 'lead', content: 'second' }, { name: 'lead', tier: 0 })
  const replaced = await recover.execute({
    room_id: 'task:replace-timeout',
    action: 'replace-host',
    new_host: 'lead',
    reason: 'the original host is unavailable',
  }, { agent: lead, signal: new AbortController().signal })
  check('awaiting-close recovery can replace an unavailable host',
    replaced.status === 'host-replaced' && cp.snapshot().rooms['task:replace-timeout'].host === 'lead',
    JSON.stringify(replaced))

  await cp.roomOpen({
    roomId: 'task:force-close-timeout',
    kind: 'task',
    host: 'lead-a',
    members: ['lead', 'lead-a'],
  }, lead)
  await cp.roomNext({ roomId: 'task:force-close-timeout', topic: 'force close', members: ['lead-a', 'lead'] }, lead)
  await cp.roomPost({ roomId: 'task:force-close-timeout', author: 'lead-a', content: 'first' }, { name: 'lead-a', tier: 1 })
  await cp.roomPost({ roomId: 'task:force-close-timeout', author: 'lead', content: 'second' }, { name: 'lead', tier: 0 })
  const forced = await recover.execute({
    room_id: 'task:force-close-timeout',
    action: 'force-close',
    reason: 'the bounded close deadline expired',
  }, { agent: lead, signal: new AbortController().signal })
  check('tier 0 can force-close an awaiting-close round with an audit notice',
    forced.status === 'force-closed' && cp.snapshot().rooms['task:force-close-timeout'].currentRoundId === null,
    JSON.stringify(forced))

  await cp.mutateHot('test/kind-mismatch', { roomId: 'root' }, lead, (state) => {
    state.rooms.root.kind = 'task'
  })
  let mismatchError
  try {
    await send.execute({
      target: 'lead-a',
      message: 'kind mismatch must not reuse a different room shape',
      delivery: 'info',
    }, { agent: lead, signal: new AbortController().signal })
  } catch (error) {
    mismatchError = error
  }
  check('an existing room with a different kind is still refused',
    String(mismatchError?.message ?? mismatchError).includes('already exists with kind'),
    String(mismatchError?.message ?? mismatchError))
} catch (error) {
  failed += 1
  console.log('FAIL bounded wake harness: ' + String(error?.stack ?? error))
} finally {
  rmSync(root, { recursive: true, force: true })
}

console.log('checks=all failed=' + failed)
process.exit(failed === 0 ? 0 : 1)
