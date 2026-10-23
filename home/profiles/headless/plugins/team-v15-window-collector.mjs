import { createHash, randomUUID } from 'node:crypto'
import { mkdirSync, realpathSync, lstatSync, readFileSync } from 'node:fs'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import { controlPlaneForMember } from './team-control-plane.mjs'
import { verifyRegisteredPlanSource } from './team-v15-plan-registry.mjs'
import { publishedWindowPlan } from './team-v15-window-plan.mjs'
import { readRuntimeDeliveryMilestones, deliveryPendingInput } from './team-v15-delivery-debt.mjs'
import { readDurableJson, updateDurableJsonSync } from './team-v14-durable-store.mjs'
import { createWindowCheckpointAuthority, freezeWindow, windowHash as hash, windowMessageBytes } from './team-v15-window-checkpoint.mjs'
import { nativeHostBinding } from './team-v15-window-participation.mjs'
import { policyFor } from './team-policy.mjs'
import { nativeSessionBridge } from '../../../../app/node_modules/@deepseek-ai/dsh-session/lib/index.js'

export const name = 'team-v15-window-collector'
export const inject = ['agents', 'agentTeams', 'sessions', 'sessionQuery', 'teamIdentityRuntime', 'requestMessageProjection']
export const provide = ['windowCheckpointRuntime']
const fail = code => { throw Object.assign(new Error(code), { code }) }
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value)
// The conversation message an event carries, if any. Other events have a data.message too (team/message/queued is
// the record of a Team mail entering a queue: an id, a sender and a target, no role); those are not conversation.
const rawMessage = event => { const message = event.type === 'user/message' ? event.data : event.data?.message; return typeof message?.role === 'string' ? message : undefined }
const terminalTasks = new Set(['completed', 'resolved', 'cancelled', 'failed'])
const moduleHash = createHash('sha256').update(readFileSync(new URL(import.meta.url))).digest('hex')
export const windowBoundaryTypes = Object.freeze(['turn/start', 'turn/end', 'step/start', 'step/end', 'tool/call', 'tool/result',
  'native/input-accepted', 'agent/inbox/spliced', 'native/tool-effect', 'native/sampling-interrupted',
  'native/window-intent', 'native/window-aborted', 'model/selection', 'permission/preset', 'approval/policy', 'sandbox/mode'])
const boundaryTypes=new Set(windowBoundaryTypes)
function map(value, label) {
  if (!object(value)) fail('WINDOW_DOMAIN_UNAVAILABLE:' + label)
  return value
}
function inside(root, candidate) {
  const delta = relative(root, candidate)
  return delta === '' || (!isAbsolute(delta) && delta !== '..' && !delta.startsWith('..' + sep))
}
function plain(value) { return structuredClone(value) }

/** Closed root-only server collector. No tool accepts authority, successful
 * completion, retention receipts or an arbitrary request body from the model. */
export function createServerWindowCollector(ctx, config) {
  const settings = freezeWindow(plain(config))
  if (!settings || settings.isolated !== true || !object(settings.planBindings)
    || !Array.isArray(settings.sessionIds) || !settings.sessionIds.length
    || !Array.isArray(settings.allowedRoots) || !settings.allowedRoots.length
    || typeof settings.recoveryDirectory !== 'string') fail('WINDOW_COLLECTOR_ISOLATED_CONFIG_REQUIRED')
  const maxRecoveryBytes = settings.maxRecoveryBytes ?? 4194304
  const maxArtifacts = settings.maxArtifacts ?? 64
  const recentMessages = settings.recentMessages ?? 6
  const spanMode = settings.spanMode ?? 'single'
  if (!['single', 'multiple'].includes(spanMode)) fail('WINDOW_COLLECTOR_SPAN_MODE_INVALID')
  const maxCheckpointBytes = settings.maxCheckpointBytes ?? 262144
  if (![maxRecoveryBytes, maxArtifacts, recentMessages].every(n => Number.isSafeInteger(n) && n > 0)
    // One retained copy per completed turn, for the whole life of the session: 64 made a window fold impossible on
    // exactly the long sessions it exists for. The default stays 64; a production install asks for more.
    // One retained copy is one whole turn. A root's working turn runs for hundreds of steps and is tens of MB; the
    // first bound (16MB, default 4MB) refused every fold of such a session.
    || maxRecoveryBytes > 268435456 || maxArtifacts > 4096 || recentMessages > 64
    || !Number.isSafeInteger(maxCheckpointBytes) || maxCheckpointBytes < 1 || maxCheckpointBytes > 1048576) fail('WINDOW_COLLECTOR_LIMIT_INVALID')
  const allowed = new Set(settings.sessionIds), roots = settings.allowedRoots.map(root => realpathSync(resolve(root)))
  const directory = resolve(settings.recoveryDirectory)
  if (!roots.some(root => inside(root, directory))) fail('WINDOW_RECOVERY_DIRECTORY_DENIED')
  if (![undefined, 'block', 'report'].includes(settings.peerCompactionDebt) || ![undefined, true, false].includes(settings.planProjection)
    || ![undefined, 'full', 'live'].includes(settings.authorityDetail)) fail('WINDOW_COLLECTOR_ISOLATED_CONFIG_REQUIRED')
  const configFingerprint = hash(settings)
  const instanceId = randomUUID()
  const audits = []
  const snapshots = new Map()
  function safeDirectory() {
    let cursor = directory
    while (true) {
      try {
        if (lstatSync(cursor).isSymbolicLink() || realpathSync(cursor).toLowerCase() !== cursor.toLowerCase()) fail('WINDOW_RECOVERY_SYMLINK_DENIED')
      } catch (error) { if (error.code !== 'ENOENT') throw error }
      const parent = resolve(cursor, '..')
      if (parent === cursor) break
      cursor = parent
    }
  }
  function actor(sessionId) {
    const matches = ctx.agents.list().filter(agent => agent.session?.id === sessionId)
    if (!allowed.has(sessionId) || matches.length !== 1) fail('WINDOW_COLLECTOR_SESSION_DENIED')
    const agent = matches[0], member = ctx.agentTeams.tryMembership(agent)
    const record = member?.id && member.name ? policyFor(member.id).get?.(member.name) : undefined
    const tier = Number(record?.tier ?? member?.tier ?? member?.level ?? (member?.role === 'lead' ? 0 : 2))
    if (!member?.id || !member.name || tier !== 0 || member.root !== agent || agent.id !== sessionId) fail('WINDOW_COLLECTOR_ROOT_ONLY')
    const control = controlPlaneForMember(ctx, agent, { directory: settings.controlDirectory })
    if (!control || control.rootId !== member.id) fail('WINDOW_COLLECTOR_CONTROL_UNAVAILABLE')
    return { agent, member, control, acl: { sessionId, rootTeamId: member.id, memberName: member.name, tier } }
  }
  const artifactPath = id => {
    if (!/^[a-f0-9]{64}$/.test(id)) fail('WINDOW_RECOVERY_RECEIPT_INVALID')
    safeDirectory()
    return join(directory, id + '.json')
  }
  const indexPath = a => { safeDirectory(); return join(directory, hash(a.acl) + '.index.json') }
  function index(a) {
    const path = indexPath(a)
    try {
      if (lstatSync(path).isSymbolicLink() || !roots.some(root => inside(root, realpathSync(path)))) fail('WINDOW_RECOVERY_SYMLINK_DENIED')
    } catch (error) { if (error.code !== 'ENOENT') throw error }
    const result = readDurableJson(path, { fallback: { kind: 'window-recovery-index-v1', acl: a.acl, receipts: {} } })
    if (result.kind !== 'window-recovery-index-v1' || hash(result.acl) !== hash(a.acl) || !object(result.receipts)
      || Object.keys(result.receipts).length > maxArtifacts) fail('WINDOW_RECOVERY_INDEX_INVALID')
    return result
  }
  function readRecovery(a, receipt) {
    if (!receipt || receipt.kind !== 'window-event-retention-v1' || hash(receipt.acl) !== hash(a.acl)
      || receipt.retention !== 'durable-copy-no-expiry-no-gc' || receipt.id !== hash({ acl: receipt.acl, eventRefs: receipt.eventRefs })) fail('WINDOW_RECOVERY_RECEIPT_INVALID')
    const stored = index(a).receipts[receipt.id]
    if (hash(stored) !== hash(receipt)) fail('WINDOW_RECOVERY_RECEIPT_UNAVAILABLE')
    const path = artifactPath(receipt.id)
    if (lstatSync(path).isSymbolicLink() || !roots.some(root => inside(root, realpathSync(path)))) fail('WINDOW_RECOVERY_SYMLINK_DENIED')
    const artifact = readDurableJson(path)
    if (artifact?.kind !== 'window-recovery-artifact-v1' || hash(artifact.receipt) !== hash(receipt)
      || !Array.isArray(artifact.events) || hash(artifact.events) !== receipt.eventsHash
      || Buffer.byteLength(JSON.stringify(artifact.events)) > maxRecoveryBytes
      || hash(artifact.events.map(event => ({ seq: event.seq, sha256: hash(event) }))) !== hash(receipt.eventRefs)) fail('WINDOW_RECOVERY_ARTIFACT_INVALID')
    return plain(artifact.events)
  }
  // Every turn that has ended, with whether it ended normally. A turn that ended in an error or was interrupted is
  // never a whole-turn candidate, but the steps it did finish are as finished as any other.
  function endedTurns(events) {
    const turns = [], used = new Set()
    let start
    for (const event of events) {
      if (event.type === 'turn/start') { start = event; continue }
      if (event.type !== 'turn/end') continue
      if (start && start.data?.turn === event.data?.turn && typeof event.data?.reason?.kind === 'string'
        && !used.has(event.data.turn)) {
        turns.push({ completed: event.data.reason.kind === 'completed', events: events.filter(row => row.seq >= start.seq && row.seq <= event.seq) })
        used.add(event.data.turn)
      }
      start = undefined
    }
    return turns
  }
  // What may not be folded: the recent tail, system and developer messages, and everything of a turn that is still
  // open. A turn that has completed is no longer protected as a whole (only through the recent tail): a root's
  // conversation is mostly its last long working turn, and protecting that whole turn left nothing to fold.
  function protection(agent, events, messages) {
    const lastStart = events.filter(event => event.type === 'turn/start').at(-1), currentStart = lastStart?.seq ?? 0
    const closed = lastStart !== undefined && events.some(event => event.type === 'turn/end' && event.seq > lastStart.seq
      && event.data?.turn === lastStart.data?.turn && event.data?.reason?.kind === 'completed')
    const canonical = new Map(events.filter(event => rawMessage(event)?.id).map(event => [rawMessage(event).id, event]))
    const open = message => { const event = canonical.get(message.id); return event === undefined || (!closed && event.seq >= currentStart) }
    const protectedIds = new Set([...messages.slice(-recentMessages).map(message => message.id),
      ...messages.filter(message => ['system', 'developer'].includes(message.role) || open(message)).map(message => message.id)])
    const pendingIds = new Set([...agent.inbox.nextStep, ...agent.inbox.nextTurn].map(message => message.id))
    return { protectedIds, pendingIds }
  }
  // The stretches of the conversation a window may replace. A completed turn whose every message is still in the
  // conversation and unprotected is one candidate, as it always was. Otherwise the turn, and any turn that ended
  // without completing (an error, an interrupt; the last turn of the conversation stays protected as open until it
  // completes), is searched for completed
  // steps: an assistant message with tool calls together with every one of its tool results. The longest unbroken
  // run of such steps (by bytes) is the candidate; the user's own input, the final answer, anything pending or in
  // the recent tail, and any step whose results are incomplete stay where they are.
  // On a Team root the runtime puts a state message between most steps (the context manifest, the activity digest,
  // the idle reminder, a milestone snapshot, a dead-letter notice). Those restate what the control plane holds and
  // are sent again when they matter, so they ride along inside a run instead of ending it. What a teammate or the
  // person wrote still ends a run.
  function foldCandidates(events, messages, { protectedIds, pendingIds }) {
    const at = new Map(messages.map((message, index) => [message.id, index]))
    const blocked = id => protectedIds.has(id) || pendingIds.has(id)
    const intact = event => { const message = rawMessage(event), index = at.get(message.id); return index !== undefined && !blocked(message.id) && hash(message) === hash(messages[index]) }
    const consecutive = list => list.every((event, i) => i === 0 || at.get(rawMessage(event).id) === at.get(rawMessage(list[i - 1]).id) + 1)
    const bytes = list => windowMessageBytes(list.map(rawMessage))
    const runtimeState = message => message.role === 'user' && message.source?.senderSessionId === undefined
      && message.source?.senderId === undefined && message.source?.teamId === undefined
      && (['team-v12-runtime', 'team-activity-digest', 'team-idle-watch', 'step-compaction'].includes(message.source?.plugin)
        || (message.source?.plugin === 'tool-agent-team-v2' && (message.source.form === 'snapshot' || message.source.kind === 'team-plugin-message')))
    const candidates = []
    for (const { completed, events: eventsInTurn } of endedTurns(events)) {
      const group = eventsInTurn.filter(event => rawMessage(event)?.id && !['system', 'developer'].includes(rawMessage(event).role))
      if (!group.length) continue
      const turn = eventsInTurn[0].data.turn
      if (completed && spanMode === 'single' && rawMessage(group[0]).role === 'user' && rawMessage(group.at(-1)).role === 'assistant' && group.every(intact) && consecutive(group)) {
        candidates.push({ scope: 'turn', turn, group, all: eventsInTurn }); continue
      }
      const runs = []
      let best = [], run = [], trail = []
      const close = () => {
        if (run.length > 1) { runs.push(run); if (bytes(run) > bytes(best)) best = run }
        run = []; trail = []
      }
      for (let i = 0; i < group.length;) {
        const message = rawMessage(group[i])
        const calls = message.role === 'assistant' && Array.isArray(message.content) ? message.content.filter(block => block.type === 'tool-call').map(block => block.id) : []
        if (!calls.length) {
          // A run ends on a tool result, so a state message joins only once a later step follows it.
          if (run.length && runtimeState(message) && intact(group[i])) trail.push(group[i]); else close()
          i++; continue
        }
        const step = [group[i]], answered = new Set()
        let j = i + 1
        while (j < group.length && rawMessage(group[j]).role === 'tool') { step.push(group[j]); answered.add(rawMessage(group[j]).toolCallId); j++ }
        if (!calls.every(id => answered.has(id)) || !step.every(intact) || !consecutive(step)) close()
        else if (run.length && consecutive([run.at(-1), ...trail, ...step])) { run.push(...trail, ...step); trail = [] }
        else { close(); run.push(...step) }
        i = j
      }
      close()
      for (const chosen of spanMode === 'multiple' ? runs : (best.length > 1 ? [best] : [])) {
        const first = chosen[0].seq, last = chosen.at(-1).seq
        candidates.push({ scope: 'steps', turn, group: chosen, all: eventsInTurn.filter(event => event.seq >= first && event.seq <= last) })
      }
    }
    return candidates
  }
  async function retainCompletedTurns(sessionId) {
    const a = actor(sessionId), before = a.agent.session.snapshotEvents()
    if (!await ctx.sessions.flush(a.agent.session)) fail('WINDOW_RECOVERY_FLUSH_FAILED')
    const receipts = []
    // Only what a fold could take is copied: a whole working turn is tens of MB, and copying every completed turn
    // "in case" was most of the cost of a fold.
    const retainMessages = plain(a.agent.session.deriveMessages())
    for (const { all: events } of foldCandidates(before, retainMessages, protection(a.agent, before, retainMessages))) {
      const eventRefs = events.map(event => ({ seq: event.seq, sha256: hash(event) }))
      const id = hash({ acl: a.acl, eventRefs }), existing = index(a).receipts[id]
      if (existing) { readRecovery(a, existing); receipts.push(existing); continue }
      if (Object.keys(index(a).receipts).length >= maxArtifacts) fail('WINDOW_RECOVERY_ARTIFACT_LIMIT')
      if (Buffer.byteLength(JSON.stringify(events)) > maxRecoveryBytes) fail('WINDOW_RECOVERY_ARTIFACT_BUDGET')
      const disk = []
      for (const event of events) {
        const observation = await ctx.sessionQuery.readEvent({ sessionId, seq: event.seq, before: 0, after: 0 }, new AbortController().signal)
        if (observation.session?.id !== sessionId || hash(observation.target) !== hash(event)) fail('WINDOW_RECOVERY_SOURCE_CHANGED')
        disk.push(observation.target)
      }
      const current = actor(sessionId)
      if (hash(current.acl) !== hash(a.acl) || eventRefs.some(ref => hash(current.agent.session.eventAt(ref.seq)) !== ref.sha256)) fail('WINDOW_RECOVERY_SOURCE_CHANGED')
      const receipt = { kind: 'window-event-retention-v1', id, acl: a.acl, eventRefs, eventsHash: hash(disk), retention: 'durable-copy-no-expiry-no-gc' }
      safeDirectory(); mkdirSync(directory, { recursive: true }); safeDirectory()
      updateDurableJsonSync(artifactPath(id), doc => {
        if (doc.kind && (doc.kind !== 'window-recovery-artifact-v1' || hash(doc.receipt) !== hash(receipt) || hash(doc.events) !== receipt.eventsHash)) fail('WINDOW_RECOVERY_ARTIFACT_CONFLICT')
        Object.assign(doc, { kind: 'window-recovery-artifact-v1', receipt, events: disk })
      }, { fallback: {} })
      const stored = readDurableJson(artifactPath(id))
      if (hash(stored.receipt) !== hash(receipt) || hash(stored.events) !== receipt.eventsHash) fail('WINDOW_RECOVERY_DURABLE_READBACK_FAILED')
      updateDurableJsonSync(indexPath(current), doc => {
        if (doc.kind !== 'window-recovery-index-v1' || hash(doc.acl) !== hash(current.acl)
          || Object.keys(doc.receipts).length >= maxArtifacts && !doc.receipts[id]) fail('WINDOW_RECOVERY_INDEX_INVALID')
        doc.receipts[id] = receipt
      }, { fallback: { kind: 'window-recovery-index-v1', acl: a.acl, receipts: {} } })
      readRecovery(current, receipt)
      receipts.push(receipt)
    }
    const workspace = ctx.get?.('contextWorkspace')
    const prepared = sourceFor(actor(sessionId), plain(a.agent.session.deriveMessages()))
    const locators = prepared.recovery.memoryDebt.filter(row => row.kind === 'context-retention-required').map(row => row.locator)
    const memoReceipts = locators.length && workspace ? [workspace.retainRecovery(a.agent, {
      ownerId: memoOwner(a, locators), locators,
    })] : workspace ? (prepared.recovery.memoRetentionReceipts ?? []).map(receipt => workspace.renewRecovery(a.agent, receipt)) : []
    const retiredMemoReceiptIds = retireMemoRetention(sessionId, memoReceipts)
    return freezeWindow({ sessionId, receipts, memoReceipts, retiredMemoReceiptIds,
      scope: 'exact-completed-turn-events-and-required-memos', modelUnderstanding: 'unknown' })
  }
  // The plan a session's window cites. A session bound to a registered delivery contract uses that contract; a
  // Team that never registered one can cite the published projection of its approved task plans instead, which
  // has no file of its own (its content lives in the control plane and is hash-checked on every read).
  function planFor(state, sessionId) {
    const bound = settings.planBindings[sessionId]
    if (bound !== undefined && bound !== null) {
      const plan = state.v15PlanDelivery?.plans?.[bound]
      if (!plan) fail('WINDOW_COLLECTOR_PLAN_UNAVAILABLE')
      verifyRegisteredPlanSource(plan, { allowedRoots: settings.allowedRoots })
      return plan
    }
    const plan = settings.planProjection === true ? publishedWindowPlan(state) : undefined
    if (!plan) fail('WINDOW_COLLECTOR_PLAN_UNAVAILABLE')
    return plan
  }
  function source(options) {
    // The brand may live in another dsh-llm module instance than the one the runtime came from (see
    // request-message-projection.mjs); a real host's agent loop is exactly that case.
    const projection = ctx.requestMessageProjection
    if ((projection.isAgentLoopRequestInAnyCopy?.(options) ?? projection.isAgentLoopRequest(options)) !== true) fail('WINDOW_COLLECTOR_REQUEST_BRAND_REQUIRED')
    return sourceFor(actor(options.sessionId),plain(options.messages))
  }
  const memoOwner = (a, locators) => 'window:' + hash({ acl: a.acl, locators: [...locators].sort() })
  function retireMemoRetention(sessionId, currentReceipts) {
    const a = actor(sessionId), workspace = ctx.get?.('contextWorkspace')
    if (!workspace) return []
    const keep = new Set(currentReceipts.map(receipt => receipt.id))
    const keepCheckpoint = checkpoint => {
      for (const receipt of checkpoint?.recovery?.memoRetentionReceipts ?? []) keep.add(receipt.id)
    }
    keepCheckpoint(snapshots.get(sessionId)?.checkpoint)
    const events = a.agent.session.snapshotEvents()
    const committed = events.filter(event => event.type === 'user/message' && event.data?.source?.windowCommit)
    const latestCommitted = committed.at(-1)?.data.source.windowCommit.transitionId
    for (const event of events.filter(event => event.type === 'native/window-intent')) {
      const id = event.data.transitionId
      const resolved = events.some(row => row.type === 'native/window-aborted' && row.data.transitionId === id
        || row.type === 'user/message' && row.data?.source?.windowCommit?.transitionId === id)
      if (!resolved || id === latestCommitted) keepCheckpoint(event.data.proposal?.checkpoint)
    }
    for (const message of a.agent.session.deriveMessages()) keepCheckpoint(message.source?.nativeWindowCheckpoint)
    const retired = []
    // Current projections, the latest committed window and unresolved intents
    // own their pins. Older unreferenced preparations are safe to retire.
    for (const receipt of workspace.listRecovery(a.agent)) {
      if (!receipt.ownerId.startsWith('window:') || keep.has(receipt.id)) continue
      workspace.releaseRecovery(a.agent, receipt)
      retired.push(receipt.id)
    }
    return retired
  }
  function sourceFor(a,messages,writerSurface) {
    const state = a.control.windowSnapshot()
    const session = a.agent.session, events = session.snapshotEvents()
    if (!Array.isArray(messages) || !messages.length || messages.some(message => !message?.id)) fail('WINDOW_COLLECTOR_REQUEST_INVALID')
    const plan = planFor(state, session.id)
    const identity = ctx.teamIdentityRuntime.status(a.agent)
    if (identity.status !== 'active' || identity.epoch !== state.identityEpoch
      || identity.contentHash !== state.activeIdentity?.bundle?.contentHash) fail('WINDOW_COLLECTOR_IDENTITY_UNAVAILABLE')
    const tasks = Object.fromEntries(Object.entries(map(state.boards, 'boards')).flatMap(([boardId, board]) =>
      Object.entries(map(board.tasks, 'tasks')).map(([taskId, task]) => [boardId + ':' + taskId, plain(task)])))
    const requirements = map(state.v12Requirements, 'requirements'), wake = map(state.v12RoomWake, 'wake')
    const debt = [], rereads = [], peerDebt = []
    const requireDomain = (value, label) => {
      // The control plane was read (the snapshot above would have thrown otherwise). A domain that is not in it has
      // not been written yet: a Team that recorded no evidence has no evidence, which is a fact, not a gap. Only a
      // host that asks for the strict reading (the isolated trials) treats absence as unavailable.
      if (value === undefined && settings.authorityDetail === 'live') return {}
      if (value === undefined) { debt.push({ kind: 'unavailable-domain', source: label }); rereads.push({ kind: 'server-domain', source: label }); return { unavailable: true } }
      return plain(map(value, label))
    }
    const input = deliveryPendingInput(a.agent), inbox = { nextStep: plain(a.agent.inbox.nextStep), nextTurn: plain(a.agent.inbox.nextTurn) }
    const jobs = requireDomain(state.v12Compaction?.jobs, 'compaction-jobs')
    const milestone = ctx.get?.('stepCompactionRuntime')
    if (milestone) {
      const facts = milestone.runtimeFacts()
      const current = readRuntimeDeliveryMilestones(facts.configuredPath, milestone, { allowedRoots: settings.allowedRoots })
      for (const [memberName, row] of Object.entries(current.doc.teams[state.rootId]?.compactions ?? {})) {
        if (row.memoryDebt == null && ['compacted', 'no_compactable_range'].includes(row.status)) continue
        // A window folds this session's own completed turns. Another member's lossy fold says nothing about them,
        // so an install may ask for it to be reported in the checkpoint instead of blocking every fold of the root
        // for as long as any member of a busy Team carries a debt. The session's own rows always block.
        const own = memberName === a.member.name || memberName === 'engine:' + a.member.name
        // On a real Team nearly every summary fold is recorded with a memory debt (the summary did not restate every
        // anchor), the root's own included. That debt is about what a summary dropped; a window drops nothing, and
        // the authority it carries restates exactly those anchors. A host that reports debts reports this one too;
        // only a fold of this session that is still running or failed keeps blocking.
        const settled = ['compacted', 'no_compactable_range', 'completed_with_debt', 'consumed', 'skipped-below-floor'].includes(row.status)
        if (settings.peerCompactionDebt === 'report' && (!own || settled)) peerDebt.push({ memberName, status: row.status ?? null, memoryDebt: row.memoryDebt == null ? null : hash(row.memoryDebt) })
        else debt.push({ kind: 'compaction-memory', memberName, row: plain(row) })
      }
    } else { debt.push({ kind: 'unavailable-domain', source: 'compaction-milestones' }); rereads.push({ kind: 'server-domain', source: 'compaction-milestones' }) }
    for (const row of Object.values(state.v15HistoryRecall?.debts ?? {})) {
      if (['required', 'returned-awaiting-dispatch'].includes(row.status)) debt.push({ kind: 'history-recall', row: plain(row) })
    }
    for (const row of Object.values(state.v15PlanReadReceipts ?? {})) if (row.requiredFetch === true) rereads.push(plain(row))
    const retained = index(a), spans = [], retentionPending = []
    const { protectedIds, pendingIds } = protection(a.agent, events, messages)
    for (const { scope, turn, group, all } of foldCandidates(events, messages, { protectedIds, pendingIds })) {
      const ids = group.map(event => rawMessage(event).id)
      const allRefs = all.map(event => ({ seq: event.seq, sha256: hash(event) }))
      const receipt = retained.receipts[hash({ acl: a.acl, eventRefs: allRefs })]
      if (!receipt) { retentionPending.push({ kind: 'completed-turn-retention-required', turn }); continue }
      readRecovery(a, receipt)
      if (debt.length || rereads.length) continue
      spans.push({ status: 'completed', ...(scope === 'steps' ? { scope: 'steps' } : {}), messageIds: ids,
        eventRefs: group.map(event => ({ seq: event.seq, sha256: hash(event) })), retentionReceipt: plain(receipt), memoryDebtCovered: true })
    }
    const authority = {
      activeTaskIds: Object.keys(tasks).filter(id => !terminalTasks.has(tasks[id].status)),
      taskRevisions: Object.fromEntries(Object.entries(tasks).map(([id, task]) => [id, { revision: task.revision ?? null, sha256: hash(task) }])),
      contractRevisions: Object.fromEntries(Object.entries(tasks).map(([id, task]) => [id, { revision: task.contract?.contractRevision ?? null, sha256: hash(task.contract ?? null) }])),
      requirementRefs: plain(map(requirements.requirements, 'requirement-refs')), decisionRefs: plain(map(requirements.decisions, 'decision-refs')),
      ownerScopeLeaseRefs: { tasks, leases: Object.fromEntries(Object.entries(map(state.leases, 'leases')).map(([id, lease]) =>
        [id, { record: plain(lease), currentlyActive: lease.status === 'active' && Number.isFinite(lease.expiresAt) && lease.expiresAt > Date.now() }])) },
      phaseRefs: Object.fromEntries(Object.entries(tasks).map(([id, task]) => [id, { phase: task.phase ?? null, status: task.status ?? null }])),
      pendingAcceptanceRefs: { input, inbox }, waitingRefs: requireDomain(state.v14Waiting?.tickets, 'waiting'),
      wakeInboxRefs: { inbox: plain(map(wake.inbox, 'wake-inbox')), wakes: plain(map(wake.wakes, 'wakes')) },
      planCoverageStates: { planId: plan.planId, items: plain(plan.items), ...(plan.projection === true ? { coverage: plain(plan.coverage) } : {}),
        taskPlanBindings: plain(state.v15PlanDelivery?.taskPlanBindings ?? {}),
        deliveryAuthorityReceipts: plain(state.deliveryAuthorityReceipts ?? {}), runtimeReceipts: plain(state.runtimeReceipts ?? {}),
        deploymentReceipts: plain(state.deploymentReceipts ?? {}), acceptedReceipts: plain(state.v15PlanDelivery?.receipts ?? {}) },
      evidenceRefs: { native: requireDomain(state.v12Evidence, 'evidence'), legacy: plain(map(state.evidence, 'legacy-evidence')) },
    }
    // 'live' authority carries the text of what is still in force (open tasks and their contracts, active leases,
    // open waiting tickets, unhandled wakes, requirements, pending input) and cites everything settled by count and
    // hash. The hash binds the checkpoint to that history exactly as its text did; the text itself stays where it
    // already is, in the control plane and the journal, and grows with every hour a Team runs.
    if (settings.authorityDetail === 'live') {
      const digest = rows => { const entries = Object.entries(rows ?? {}).map(([id, row]) => [id, hash(row)]).sort((x, y) => x[0] < y[0] ? -1 : x[0] > y[0] ? 1 : 0)
        return { count: entries.length, sha256: hash(entries) } }
      const part = (rows, isLive) => { const live = {}, settled = {}
        for (const [id, row] of Object.entries(rows ?? {})) (isLive(row, id) ? live : settled)[id] = row
        return [live, digest(settled)] }
      const openTask = (_row, id) => !terminalTasks.has(tasks[id]?.status)
      const [liveTasks, settledTasks] = part(tasks, openTask)
      const [liveLeases, settledLeases] = part(authority.ownerScopeLeaseRefs.leases, row => row.currentlyActive === true)
      const waitingAvailable = authority.waitingRefs?.unavailable !== true
      const [liveWaiting, settledWaiting] = waitingAvailable
        ? part(authority.waitingRefs, row => row?.closedAt == null && row?.resolvedAt == null && !['resolved', 'closed', 'cancelled', 'expired'].includes(row?.status))
        : [authority.waitingRefs, digest({})]
      const [liveInbox, settledInbox] = part(authority.wakeInboxRefs.inbox, row => row?.status !== 'handled')
      const [liveWakes, settledWakes] = part(authority.wakeInboxRefs.wakes, row => !['handled', 'rejected'].includes(row?.status))
      const nativeEvidence = authority.evidenceRefs.native
      // Open is not small: a busy Team has dozens of open tasks and unhandled wakes, and their text alone is several
      // times what a request may carry here. A record this session owns stays whole (up to a bound); any other open
      // record becomes a brief row that names it, says where it stands and binds its full text by hash. The reader is
      // told so by `brief: true` and has the Team tools for the rest.
      const mine = a.member.name
      const briefRow = row => {
        const out = { brief: true }
        for (const [key, value] of Object.entries(row ?? {})) {
          if (value === null || typeof value === 'number' || typeof value === 'boolean') out[key] = value
          else if (typeof value === 'string') out[key] = value.length > 200 ? value.slice(0, 200) + '...' : value
          else out[key] = Array.isArray(value) ? { items: value.length } : { entries: Object.keys(value).length }
        }
        out.sha256 = hash(row)
        return out
      }
      const briefUnlessOwn = (rows, owns) => Object.fromEntries(Object.entries(rows).map(([id, row]) =>
        [id, owns(row) && Buffer.byteLength(JSON.stringify(row)) <= 8192 ? row : briefRow(row)]))
      const briefTask = task => ({ ...briefRow(task), ...(task?.contract ? { contract: { contractRevision: task.contract.contractRevision ?? null,
        writeScopes: Array.isArray(task.contract.writeScopes) ? task.contract.writeScopes.slice(0, 16) : [] } } : {}) })
      for (const [id, task] of Object.entries(liveTasks)) {
        if (!([task?.ownerName, task?.owner, task?.assignee].includes(mine) && Buffer.byteLength(JSON.stringify(task)) <= 8192)) liveTasks[id] = briefTask(task)
      }
      const targetsMe = row => [row?.target, row?.owner, row?.waiter, row?.responsible].includes(mine)
      const briefLeases = briefUnlessOwn(liveLeases, row => [row?.record?.owner, row?.record?.ownerName, row?.record?.holder].includes(mine))
      const briefWaiting = waitingAvailable ? briefUnlessOwn(liveWaiting, targetsMe) : liveWaiting
      // Wakes and inbox rows are always brief, this session's own included: their text reaches the session through
      // its inbox, they change state with every delivery, and in full they were 150KB of a 250KB authority on the
      // first real Team this ran on.
      const fields = (row, keys) => Object.fromEntries(keys.filter(key => row?.[key] !== undefined).map(key => [key, row[key]]))
      const briefInbox = Object.fromEntries(Object.entries(liveInbox).map(([id, row]) => [id, {
        brief: true, ...fields(row, ['messageId', 'target', 'sender', 'taskId', 'priority', 'status', 'wakeIds', 'injectionReceipt', 'handledAt']),
        messageId: row?.messageId ?? id,
        summary: String(row?.originalText ?? row?.text ?? '').slice(0, 200), sha256: hash(row),
        retrieve: { tool: 'team_v12', action: 'inbox_list', member: row?.target ?? mine, input: { inbox_id: row?.messageId ?? id, include_handled: true, text_offset: 0 } },
      }]))
      const briefWakes = Object.fromEntries(Object.entries(liveWakes).map(([id, row]) => [id, {
        brief: true, ...fields(row, ['wakeId', 'target', 'sender', 'taskId', 'priority', 'status', 'messageIds', 'injectionReceipt', 'handledAt']),
        wakeId: row?.wakeId ?? id, sha256: hash(row),
        retrieve: { tool: 'team_v12', action: 'inbox_list', member: row?.target ?? mine, input: { wake_id: row?.wakeId ?? id, include_handled: true } },
      }]))
      // Requirements and decisions are the constraints a reader must not lose, so they stay in full while they are
      // small. A long-running Team accumulates dozens of them with their whole edit history; past the bound each
      // one is carried as its current statement (clipped) and the hash of the full record.
      const withinBound = (rows, bound) => Buffer.byteLength(JSON.stringify(rows ?? {})) <= bound
      const statement = row => { const out = { brief: true }
        for (const key of ['requirementId', 'decisionId', 'status', 'revision']) if (row?.[key] !== undefined) out[key] = row[key]
        for (const key of ['text', 'choice']) if (typeof row?.[key] === 'string') out[key] = row[key].length > 400 ? row[key].slice(0, 400) + '...' : row[key]
        out.sha256 = hash(row); return out }
      const boundedRows = (rows, bound) => withinBound(rows, bound) ? rows : Object.fromEntries(Object.entries(rows ?? {}).map(([id, row]) => [id, statement(row)]))
      // What is waiting in this session's own inbox is delivered with its next step; here it only has to be named.
      const namedMessages = messages => (Array.isArray(messages) ? messages : []).map(message => ({ id: message?.id ?? null, role: message?.role ?? null,
        source: message?.source?.kind ?? null, bytes: Buffer.byteLength(JSON.stringify(message ?? null)), sha256: hash(message ?? null) }))
      const pendingInbox = authority.pendingAcceptanceRefs.inbox
      Object.assign(authority, {
        requirementRefs: boundedRows(authority.requirementRefs, 32768), decisionRefs: boundedRows(authority.decisionRefs, 16384),
        pendingAcceptanceRefs: { input: authority.pendingAcceptanceRefs.input,
          inbox: withinBound(pendingInbox, 8192) ? pendingInbox : { nextStep: namedMessages(pendingInbox?.nextStep), nextTurn: namedMessages(pendingInbox?.nextTurn) } },
        taskRevisions: part(authority.taskRevisions, openTask)[0], contractRevisions: part(authority.contractRevisions, openTask)[0],
        phaseRefs: part(authority.phaseRefs, openTask)[0],
        ownerScopeLeaseRefs: { tasks: liveTasks, leases: briefLeases },
        waitingRefs: briefWaiting, wakeInboxRefs: { inbox: briefInbox, wakes: briefWakes },
        planCoverageStates: { ...authority.planCoverageStates,
          deliveryAuthorityReceipts: digest(authority.planCoverageStates.deliveryAuthorityReceipts), runtimeReceipts: digest(authority.planCoverageStates.runtimeReceipts),
          deploymentReceipts: digest(authority.planCoverageStates.deploymentReceipts), acceptedReceipts: digest(authority.planCoverageStates.acceptedReceipts) },
        evidenceRefs: { native: nativeEvidence?.unavailable === true ? nativeEvidence : { version: nativeEvidence?.version ?? null, records: digest(nativeEvidence?.records) },
          legacy: digest(authority.evidenceRefs.legacy) },
        settledRefs: { detail: 'count-and-hash-only: the text is on the Team board, in the evidence store and in the journal',
          tasks: settledTasks, leases: settledLeases, waiting: settledWaiting, wakeInbox: settledInbox, wakes: settledWakes },
      })
    }
    const identityHashes = { bundle: identity.contentHash, epoch: identity.epoch }
    const surfaceRevision = events.filter(event => event.surfaceOp !== undefined).length
    const surfaceNodes = writerSurface ? [...writerSurface.nodes] : [...session.surface.nodes]
    // A window replaces one unbroken stretch of the conversation. A turn that cannot be folded (it ended in an error or
    // a refusal, or is still protected) splits the foldable turns into runs; offering all of them at once made every
    // fold fail as soon as one such turn lay in the middle. The largest run is offered, the others wait their turn.
    if (spanMode === 'single' && spans.length > 1) {
      const folded = new Set(spans.flatMap(span => span.eventRefs.map(ref => ref.seq)))
      const runs = [[spans[0]]]
      for (let at = 1; at < spans.length; at++) {
        const last = spans[at - 1].eventRefs.at(-1).seq, first = spans[at].eventRefs[0].seq
        if (surfaceNodes.some(seq => seq > last && seq < first && !folded.has(seq))) runs.push([spans[at]])
        else runs.at(-1).push(spans[at])
      }
      // The run worth folding is the one that frees the most, which is bytes, not message count: one working turn
      // outweighs a dozen one-line exchanges.
      const weight = new Map(messages.map(message => [message.id, windowMessageBytes([message])]))
      const size = run => run.reduce((sum, span) => sum + span.messageIds.reduce((bytes, id) => bytes + (weight.get(id) ?? 0), 0), 0)
      const best = runs.reduce((kept, run) => size(run) > size(kept) ? run : kept)
      spans.splice(0, spans.length, ...best)
    }
    // A newly eligible but unretained candidate stays raw. It is not a recovery
    // dependency of another, fully retained selected span.
    const deferredRetention = spans.length ? retentionPending : []
    if (!spans.length) debt.push(...retentionPending)
    // Only the final retained authority and chosen fold form the dependency closure.
    // Event retention preserves locator text, not the separately expiring memo body.
    const memoRefs = new Set(), memoRetentionReceipts = []
    const recoveryText = JSON.stringify({ authority, messages: spans.flatMap(span => messages.filter(message => span.messageIds.includes(message.id))) })
    for (const match of recoveryText.matchAll(/context:\/\/[a-f0-9]{24}\/[A-Za-z0-9][A-Za-z0-9_.:-]{0,95}@[1-9][0-9]*\/[a-f0-9]{64}/g)) {
      memoRefs.add(match[0])
      if (memoRefs.size > 32) break
    }
    const locators = [...memoRefs].sort()
    if (locators.length) {
      try {
        if (locators.length > 32) fail('RECOVERY_REFS_LIMIT')
        const workspace = ctx.get?.('contextWorkspace')
        if (!workspace) fail('CONTEXT_RECOVERY_SERVICE_UNAVAILABLE')
        const receipt = workspace.findRecovery(a.agent, { ownerId: memoOwner(a, locators), locators })
        workspace.readRecovery(a.agent, receipt)
        memoRetentionReceipts.push(receipt)
      } catch (error) {
        for (const locator of locators) {
          const row = { kind: 'context-retention-required', locator, reason: error.code ?? 'CONTEXT_RECOVERY_UNAVAILABLE' }
          debt.push(row); rereads.push(plain(row))
        }
      }
    }
    const windowId = events.filter(event => event.type === 'user/message' && event.data?.source?.windowCommit).at(-1)?.data.source.windowCommit.toWindowId ?? 0
    if (debt.length || rereads.length) spans.length = 0
    const host = nativeHostBinding(ctx)
    return { sessionId: session.id, actorId: a.agent.id, rootTeamId: state.rootId, windowId, surfaceRevision,
      criticalRevisionVector: { controlRevision: state.revision, authorityHash: hash(authority), identityHashes, planHash: plan.planHash,
        surfaceHash: hash(surfaceNodes), pendingHash: hash(authority.pendingAcceptanceRefs), host,
        nativeBoundaryHash: hash(events.filter(event => boundaryTypes.has(event.type)).map(event => ({ seq: event.seq, type: event.type, sha256: hash(event) }))),
        ...(memoRetentionReceipts.length ? { contextRecoveryModuleHash: ctx.get('contextWorkspace').runtimeFacts().moduleHash } : {}) },
      identityVersion: identity.identityVersion, identityHashes, configFingerprint: hash({ configFingerprint, host }),
      protocolCertificateHash: settings.protocolCertificateHash ?? null,
      planRef: plain(plan.ref), planRevision: plan.planRevision, planHash: plan.planHash, authority,
      working: { kind: 'no-model-observations-collected' }, recovery: { memoryDebt: debt, requiredRereads: rereads,
        memoRetentionReceipts,
        ...(deferredRetention.length ? { deferredCompletedTurnRetention: deferredRetention } : {}),
        ...(peerDebt.length ? { peerCompactionDebt: peerDebt } : {}),
        activeJobs: Object.values(jobs).filter(row => object(row) && row.status !== 'completed'),
        retentionPolicy: 'root-own-session-durable-event-artifacts; ACL rechecked on every read' },
      messages, events, recentTailIds: [...protectedIds], pendingMessageIds: [...pendingIds].filter(id => messages.some(message => message.id === id)), completedSpans: spans }
  }
  function authorityFor(options) {
    return createWindowCheckpointAuthority({ readSource: sessionId => {
      if (sessionId !== options.sessionId) fail('WINDOW_COLLECTOR_SESSION_DENIED')
      return source(options)
    }, verifyRecovery: (s, span) => {
      const a = actor(s.sessionId), stored = readRecovery(a, span.retentionReceipt)
      return span.eventRefs.every(ref => hash(stored.find(event => event.seq === ref.seq)) === ref.sha256)
    } })
  }
  function authorityForSurface(sessionId, { writerToken } = {}) {
    return createWindowCheckpointAuthority({readSource: requested=> {
      if (requested!==sessionId) fail('WINDOW_COLLECTOR_SESSION_DENIED')
      const a=actor(sessionId)
      const surface=writerToken===undefined ? undefined : nativeSessionBridge(a.agent.session)?.readWindowSurface(writerToken)
      if (writerToken!==undefined && !surface) fail('WINDOW_NATIVE_WRITER_REQUIRED')
      return sourceFor(a,plain(surface?.messages ?? a.agent.session.deriveMessages()),surface)
    },verifyRecovery:(s,span)=> {
      const stored=readRecovery(actor(s.sessionId),span.retentionReceipt)
      return span.eventRefs.every(ref=>hash(stored.find(event=>event.seq===ref.seq))===ref.sha256)
    }})
  }
  function capture(options) {
    const captured = authorityFor(options).capture(options.sessionId)
    if (Buffer.byteLength(JSON.stringify(captured.checkpoint)) > maxCheckpointBytes) fail('WINDOW_COLLECTOR_CHECKPOINT_BUDGET')
    return captured
  }
  const project = options => {
    try {
      const captured = capture(options)
      return { messages: options.messages, collectorStatus: 'shadow', checkpoint: captured.checkpoint,
        completedSpanCount: captured.source.completedSpans.length, recoveryDebtCount: captured.checkpoint.recovery.memoryDebt.length }
    }
    catch (error) { return { messages: options.messages, collectorStatus: 'blocked', blockedReason: error.code ?? 'WINDOW_COLLECTOR_SOURCE_UNAVAILABLE' } }
  }
  return Object.freeze({ capture, authorityFor, authorityForSurface, retainCompletedTurns,
    protectionFiles(sessionId,protection) {
      const a=actor(sessionId),state=a.control.windowSnapshot()
      const plan=planFor(state,sessionId)
      const milestone=ctx.get?.('stepCompactionRuntime')
      if(!milestone) fail('WINDOW_RECOVERY_UNAVAILABLE')
      // A projected plan is part of the control-plane file, which the fence itself already holds.
      const workspace=ctx.get?.('contextWorkspace')
      const bases=[...(plan.projection===true?[]:[plan.ref.path]),milestone.runtimeFacts().configuredPath,indexPath(a),
        ...(workspace?.retentionFiles(a.agent) ?? [])]
      // This callback executes inside the actual CP fence. Lock the index
      // before reading its artifact reference closure, never a pre-lock list.
      if(protection)protection.add(bases)
      const retained=index(a)
      for(const receipt of Object.values(retained.receipts))readRecovery(a,receipt)
      return freezeWindow([...bases,...Object.keys(retained.receipts).map(artifactPath)])
    }, readRecovery(sessionId, receipt) { return readRecovery(actor(sessionId), receipt) },
    project, audit: () => freezeWindow(plain(audits)), runtimeFacts: () => freezeWindow({ loaded: true, pid: process.pid, instanceId,
      moduleHash, configFingerprint, mode: 'W0', scope: 'isolated-root-own-session', enabledSessionIds: [...allowed], transformations: false }),
    readSnapshot(sessionId) { actor(sessionId); return freezeWindow(plain(snapshots.get(sessionId) ?? null)) },
    onDispatch({ result, receipt }) {
      if (result.collectorStatus === 'shadow' && receipt.handedToAdapter === true) snapshots.set(receipt.sessionId, freezeWindow({
        checkpoint: result.checkpoint, completedSpanCount: result.completedSpanCount, recoveryDebtCount: result.recoveryDebtCount,
        actual: plain(receipt), verificationScope: 'captured-for-dispatched-request-not-current-state' }))
      audits.push(freezeWindow({ status: result.collectorStatus, blockedReason: result.blockedReason ?? null,
        checkpointId: result.checkpoint?.checkpointId ?? null, checkpointHash: result.checkpoint?.checkpointIntegrityHash ?? null,
        completedSpanCount: result.completedSpanCount ?? 0, recoveryDebtCount: result.recoveryDebtCount ?? null,
        scope: 'isolated-root-own-session', mode: 'W0', actual: plain(receipt), changedMessages: false }))
      if (audits.length > 64) audits.shift()
    } })
}

export function apply(ctx, config = {}) {
  if (config.enabled !== true) return () => {}
  const service = createServerWindowCollector(ctx, config)
  const stop = ctx.requestMessageProjection.register(name, service.project, { order: 4, preview: service.project, onDispatch: service.onDispatch })
  const unprovide = ctx.provide('windowCheckpointRuntime', service)
  let disposed = false
  const dispose = () => { if (!disposed) { disposed = true; stop(); unprovide() } }
  ctx.effect?.(() => dispose)
  return dispose
}

// The loaded-code certificate reads this module's own source hash from here (see team-v15-window-loaded.mjs).
import { registerLoadedModule } from './team-v15-window-loaded.mjs'
registerLoadedModule(import.meta.url)
