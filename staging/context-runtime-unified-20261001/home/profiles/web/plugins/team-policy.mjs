/**
 * HMR activation marker: 2026-09-27T10:25+08:00 perf52-incremental-board-hydration.
 *
 * team-policy — Agent Team v2 / Phase 3 core
 *
 * The shipped Team domain has a FLAT roster: \`spawnTeammate(caller, ...)\` is
 * documented as "one named, continuable direct child of the Team Lead", and its
 * only role split is lead | teammate. Tiers, groups, group isolation and the
 * freeze state therefore cannot come from the domain — this module models them
 * and hands the tool layer a deterministic decision for every operation.
 *
 * Numbering (current configurable defaults are 8 tier-1 leads, 8 members per
 * group lead, and 30 active non-frozen members total; the Lead is a pseudo-row
 * and is not counted by the domain's maxMembers):
 *
 *   tier 0  the session Lead                     not counted
 *   tier 1  1 verifier + up to 8 group leads      configurable
 *   tier 2  up to 8 members under each group lead configurable
 *   active member cap                             30 by default
 *
 * Every rule below is a pure function so it can be tested without a live Team,
 * and the tool layer must call it BEFORE touching the domain. A rule that only
 * lives in a prompt is a rule that gets forgotten; these are enforced in code.
 *
 * @module team-policy
 */

import { join } from 'node:path'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'team-policy'
/** Needs the roster to seed tier 0 and to enumerate live members. */
export const inject = ['agents', 'agentTeams']

/**
 * There is no durable registry file any more. The forked domain persists
 * level/groupId/parentName on every member snapshot in the Lead journal, so the
 * registry below is a pure projection of that journal: it is rebuilt from the
 * roster on every access and has nothing of its own to lose, stale, or corrupt.
 * The old side file is what made a restart show every member as "unregistered".
 */
/**
 * The active policy service. Cordis refuses ctx.set() for an undeclared service,
 * and these two plugins are loaded from the same profile by the same loader, so
 * they share one ESM module instance instead of threading a service key.
 */
let ACTIVE = undefined

import { allowedTaskPhaseTransitions, canAdvanceTaskPhase, controlPlaneFor, dependencySatisfied, mergeEvidenceIds, TASK_PHASES, taskPhaseRecoveryActions } from './team-control-plane.mjs'

/**
 * One policy service per Team, keyed by the Team's root session id.
 *
 * This used to be a single process-wide registry. That was invisible while one session
 * ran a Team and became a correctness bug the moment two ran at once: the second Team's
 * panel showed the first Team's roster and boards, and its spawns were refused against
 * the first Team's caps. A registry is a projection of ONE roster, so it must be keyed by
 * the roster it projects, and the boards must live beside it for the same reason.
 */
const TEAMS = new Map()
/** Keep the service cache bounded while retaining the most recently used Teams. */
const MAX_TEAM_SERVICES = 16
/** Membership id is stable for one live agent object; avoid repeated roster folds. */
const TEAM_KEYS = new WeakMap()
/** Limits captured from this plugin row's config, applied to every Team it creates. */
let LIMITS = {}

/** The active policy service (the most recently resolved Team), or undefined before apply. */
export function activePolicy() {
  return ACTIVE
}

export const ROOT_TIER = 0
export const LEAD_TIER = 1
export const MEMBER_TIER = 2

/** The verifier's group id: a level-1 group with no children, isolated from the leads. */
export const VERIFIER_GROUP = 'verifier'

/**
 * Build an empty registry.
 * @returns the registry state.
 */
export function createRegistry() {
  return {
    members: new Map(),
    parentOverrides: {},
    maxTier1Leads: 8,
    maxVerifiers: 1,
    maxMembersPerLead: 8,
    maxMembers: 30,
  }
}

function parentOverrideFor(registry, name) {
  const override = registry.parentOverrides?.[name]
  return typeof override === 'string' && override.length > 0 ? override : undefined
}

/** Register or replace one member record. */
export function putMember(registry, record) {
  // No side file: the forked domain carries level/groupId/parentName on the member
  // snapshot, so the registry is a pure projection of the Lead journal and is
  // rebuilt from the roster on every access.
  const parent = parentOverrideFor(registry, record.name)
  registry.members.set(record.name, {
    frozen: false,
    ...record,
    ...(parent === undefined ? {} : { parent }),
  })
  return registry.members.get(record.name)
}

/** Look up one member record. */
export function getMember(registry, name) {
  return registry.members.get(name)
}

/**
 * Persist one effective parent override for the current Team projection.
 * The override is intentionally separate from the domain roster: a replacement
 * lead must be able to take authority without rewriting another member's
 * session lineage.
 */
export function setMemberParentOverride(registry, name, parent) {
  const member = registry.members.get(name)
  if (member === undefined) return { ok: false, reason: 'unknown member "' + name + '"' }
  const next = String(parent ?? '').trim()
  if (next.length === 0) return { ok: false, reason: 'parent is required' }
  registry.parentOverrides ??= {}
  const previous = parentOverrideFor(registry, name) ?? member.parent
  registry.parentOverrides[name] = next
  member.parent = next
  return { ok: true, member, previous, parent: next }
}

/**
 * The durable provenance stamp appended to a Domain member description.
 *
 * The Domain's Team state is persisted with the Session, but this registry only
 * ever lived in memory: after a restart the Domain still owned every name while
 * no policy predicate could see a single member, so spawning failed with
 * "already used", send_message said "unknown member", and list_agents printed
 * nothing but the Lead. The description is the one Domain field that both
 * survives a restart and is ours to write, so the tier/group/parent triple rides
 * there and the registry rebuilds itself from it.
 */
const STAMP_RE = /\s*\[v2 tier=(\d+) group=([^\s\]]+) parent=([^\s\]]+)\]\s*$/

/** Append the provenance stamp to one description. */
export function stampDescription(description, record) {
  const base = stripStamp(description)
  return base + ' [v2 tier=' + record.tier + ' group=' + record.group + ' parent=' + record.parent + ']'
}

/** Read the provenance stamp back off one description, or undefined. */
export function parseStamp(description) {
  if (typeof description !== 'string') return undefined
  const found = STAMP_RE.exec(description)
  if (found === null) return undefined
  return { tier: Number(found[1]), group: found[2], parent: found[3] }
}

/** The description without its provenance stamp, for display. */
export function stripStamp(description) {
  if (typeof description !== 'string') return description
  return description.replace(STAMP_RE, '')
}

const nativeSpawnReceipts = new WeakMap()
const parkedSpawnReceipts = new WeakMap()
function recordedSpawns(session) {
  const events = session.log ?? session.snapshotEvents?.()
  if (!Array.isArray(events)) return []
  const inherited = Number.isSafeInteger(session.inheritedEventCount) ? session.inheritedEventCount : 0
  let cache = nativeSpawnReceipts.get(session)
  if (!cache || cache.index > events.length || cache.inherited !== inherited) {
    cache = { index: inherited, inherited, starts: new Map(), members: [] }
    nativeSpawnReceipts.set(session, cache)
  }
  for (; cache.index < events.length; cache.index++) {
    const event = events[cache.index], data = event?.data
    if (data?.name !== 'spawn_teammate' || typeof data.subCallId !== 'string') continue
    if (event.type === 'tool/ptc-dispatch-start') {
      cache.starts.set(data.subCallId, { rootCallId: data.rootCallId, parentCallId: data.parentCallId, name: data.arguments?.name })
      continue
    }
    if (event.type !== 'tool/ptc-dispatch' || data.isError !== false) continue
    const start = cache.starts.get(data.subCallId)
    if (!start || typeof start.name !== 'string' || start.name !== data.arguments?.name
      || start.rootCallId !== data.rootCallId || start.parentCallId !== data.parentCallId) continue
    if (!Array.isArray(data.content) || data.content.length !== 1 || data.content[0]?.type !== 'text'
      || typeof data.content[0].text !== 'string' || data.content[0].text.length > 32768) continue
    try {
      const member = JSON.parse(data.content[0].text)?.member
      if (member?.role === 'teammate' && member.name === start.name && typeof member.id === 'string'
        && [LEAD_TIER, MEMBER_TIER].includes(member.tier)
        && typeof member.group === 'string' && /^[^\s\]]+$/.test(member.group)
        && typeof member.parent === 'string' && member.parent.length > 0) {
        cache.members.push({ id: member.id, name: member.name, tier: member.tier, group: member.group, parent: member.parent })
      }
    } catch { /* A malformed result cannot confer policy authority. */ }
  }
  return cache.members
}

/** Recover legacy metadata only from this Team's matched server-side spawn receipts. */
export function recoverRosterProvenance(ctx, agent, rows) {
  if (!Array.isArray(rows)) return rows
  const identity = row => {
    if (row === null || typeof row !== 'object') return undefined
    const stamp = parseStamp(row.description)
    const tier = row.level ?? stamp?.tier, group = row.groupId ?? stamp?.group, parent = row.parentName ?? stamp?.parent
    return [LEAD_TIER, MEMBER_TIER].includes(tier) && typeof group === 'string' && typeof parent === 'string'
      ? { id: row.id, name: row.name, tier, group, parent } : undefined
  }
  const unresolved = rows.filter(row => row?.role !== 'lead' && row?.status !== 'failed' && !identity(row))
  if (!unresolved.length) return rows
  const membership = ctx.agentTeams.tryMembership(agent), root = membership?.root
  const rootRow = rows.find(row => row?.role === 'lead' && row.id === root?.id)
  if (!rootRow || root.session?.id !== root.id || String(membership.id) !== root.id) return rows
  const roster = new Map(rows.filter(row => row && typeof row === 'object').map(row => [row.id, row]))
  const known = new Map([[root.id, { id: root.id, name: rootRow.name, tier: ROOT_TIER, group: 'root' }]])
  for (const row of rows) {
    const value = identity(row)
    if (value) known.set(row.id, value)
  }
  const sources = new Map([[root.id, root.session]])
  const parked = parkedSpawnReceipts.get(root.session)?.sources
  if (parked) for (const [id, source] of parked) {
    if (roster.has(id) && source.parentSession === root.id) sources.set(id, source)
  }
  for (const row of rows) {
    if (!row || row.id === root.id || row.status === 'failed') continue
    try {
      const session = ctx.agents.get(row.id)?.session ?? ctx.sessions?.get(row.id)
      if (session?.id === row.id && session.header?.parentSession === root.id) sources.set(row.id, session)
    } catch { /* Unloaded sessions remain unresolved until their authorized wake. */ }
  }
  // The policy has exactly two subordinate tiers. Resolve leads before members,
  // and never use model text, caller arguments, or a foreign/inherited journal.
  const recovered = new Map()
  for (let depth = LEAD_TIER; depth <= MEMBER_TIER; depth++) {
    const candidates = new Map(), conflicts = new Set()
    for (const [id, session] of sources) {
      const owner = known.get(id)
      if (!owner || owner.tier !== depth - 1 || owner.group === VERIFIER_GROUP) continue
      for (const member of session.receipts ?? recordedSpawns(session)) {
        const target = roster.get(member.id)
        if (!target || target.role !== 'teammate' || target.status === 'failed' || target.name !== member.name
          || identity(target) || member.tier !== depth || member.parent !== owner.name
          || (depth === MEMBER_TIER && member.group !== owner.group)) continue
        const previous = candidates.get(member.id)
        if (previous && JSON.stringify(previous) !== JSON.stringify(member)) conflicts.add(member.id)
        candidates.set(member.id, member)
      }
    }
    for (const [id, member] of candidates) if (!conflicts.has(id)) {
      known.set(id, member); recovered.set(id, member)
    }
  }
  return rows.map(row => {
    const member = recovered.get(row?.id)
    return member ? { ...row, level: member.tier, groupId: member.group, parentName: member.parent } : row
  })
}

/** Read only the known legacy group leads; native idle eviction is not loss of provenance. */
export async function prepareRosterProvenance(ctx, agent) {
  const membership = ctx.agentTeams.tryMembership(agent), root = membership?.root
  if (!root || root.session?.id !== root.id) return
  const rows = ctx.agentTeams.listMembers(agent)
  const recovered = recoverRosterProvenance(ctx, agent, rows)
  if (!rows.some(row => row?.role === 'teammate' && row.status !== 'failed'
    && row.level === undefined && !parseStamp(row.description))) return
  const persistence = ctx.get('sessionPersistence')
  if (typeof persistence?.open !== 'function' || typeof persistence.stat !== 'function') return
  let cache = parkedSpawnReceipts.get(root.session)
  if (!cache) {
    cache = { sources: new Map(), pending: undefined }
    parkedSpawnReceipts.set(root.session, cache)
  }
  if (cache.pending) return cache.pending
  const rootName = rows.find(row => row?.id === root.id)?.name
  const leads = recovered.filter(row => row?.level === LEAD_TIER && row.parentName === rootName
    && row.groupId !== VERIFIER_GROUP && row.status !== 'failed')
  const ids = new Set(leads.map(row => row.id))
  for (const id of cache.sources.keys()) if (!ids.has(id)) cache.sources.delete(id)
  const load = async () => {
    for (const lead of leads) {
      const signal = AbortSignal.timeout(5000)
      let handle
      try {
        const stat = await persistence.stat(lead.id, { signal })
        if (stat === undefined) { cache.sources.delete(lead.id); continue }
        const previous = cache.sources.get(lead.id)
        if (previous && previous.revision === stat.revision) continue
        handle = await persistence.open(lead.id, 'read', { signal })
        const { events } = await handle.read(0, undefined, { signal })
        const header = handle.header, inherited = handle.inheritedEventCount
        if (header?.id !== lead.id || header.parentSession !== root.id || !Array.isArray(events)
          || !Number.isSafeInteger(inherited) || inherited < 0 || inherited > events.length
          || (!header.isSeeded && inherited !== 0)) {
          cache.sources.delete(lead.id); continue
        }
        const receipts = recordedSpawns({ log: events, inheritedEventCount: inherited })
        cache.sources.set(lead.id, { parentSession: root.id, revision: stat.revision, receipts })
      } catch {
        // Unavailable or invalid storage never supplies new authority.
        cache.sources.delete(lead.id)
      } finally {
        try { await handle?.close() } catch { cache.sources.delete(lead.id) }
      }
    }
  }
  const pending = load()
  cache.pending = pending
  try { await pending } finally { if (cache.pending === pending) cache.pending = undefined }
}

/**
 * Adopt Domain members this registry has never seen.
 *
 * The registry is rebuilt lazily from the authoritative roster, so it may only
 * ever ADD: a caller's roster is a single Domain Team, and tier-1 leads share
 * that Team with their own children, so an absent name proves nothing about
 * another group. Over-counting a cap is the safe direction; forgetting a live
 * member is not.
 *
 * @param registry - the policy registry to repair.
 * @param rows - one Domain roster, as @@ctx.agentTeams.listMembers@@ returns it.
 * @returns the same registry.
 */
export function reconcileRegistry(registry, rows) {
  if (!Array.isArray(rows)) return registry
  const frozenNames = new Set(registry.frozenNames ?? [])
  for (const row of rows) {
    if (row === null || typeof row !== 'object') continue
    if (typeof row.name !== 'string' || row.name.length === 0) continue
    if (row.frozen === true) frozenNames.add(row.name)
    else if (row.frozen === false) frozenNames.delete(row.name)
    if (row.status === 'failed') {
      const existing = registry.members.get(row.name)
      if (existing === undefined || existing.id === row.id) registry.members.delete(row.name)
      continue
    }
    // The Lead journal is now the source of truth: the forked domain carries
    // level/groupId/parentName on every member snapshot, so a restart or another
    // process recovers the whole policy tree from the roster alone. The legacy
    // description stamp is still read for Teams created before the fork.
    const stamp = parseStamp(row.description)
    const tier = typeof row.level === 'number' ? row.level : stamp === undefined ? undefined : stamp.tier
    const group = typeof row.groupId === 'string' ? row.groupId : stamp === undefined ? undefined : stamp.group
    const parent = typeof row.parentName === 'string' ? row.parentName : stamp === undefined ? undefined : stamp.parent
    // The domain's flag is the TRUTH for frozen, in BOTH directions: freezing has to free a
    // slot the moment it lands, and restoring has to give it back. Modern forked snapshots
    // carry the structural fields (level/groupId/parentName) and explicitly report `false`.
    // Older flat snapshots omit all of those fields as well as `frozen`; retain the local
    // projection for that legacy shape until the domain can emit an explicit value.
    const existing = registry.members.get(row.name)
    const frozen = row.frozen === true || (row.frozen === undefined && (existing?.frozen === true || frozenNames.has(row.name)))
    if (existing !== undefined) {
      existing.frozen = frozen
      existing.status = row.status
      if (tier !== undefined) {
        existing.tier = tier
        existing.group = group
        existing.parent = parentOverrideFor(registry, row.name) ?? parent
      }
      continue
    }
    if (row.role === 'lead') {
      putMember(registry, { id: row.id, name: row.name, tier: ROOT_TIER, group: group ?? 'root', frozen, status: row.status })
      continue
    }
    // A member the domain knows nothing about: adopt it the same conservative way
    // callerRecord always has, as a tier-1 peer, rather than leave it invisible.
    putMember(registry, tier === undefined
      ? { id: row.id, name: row.name, tier: LEAD_TIER, group: row.name, parent: 'lead', frozen, status: row.status }
      : { id: row.id, name: row.name, tier, group, parent, frozen, status: row.status })
  }
  registry.frozenNames = [...frozenNames]
  return registry
}

/** Every registered member, root first. */
export function allMembers(registry) {
  return [...registry.members.values()].sort((a, b) => a.tier - b.tier)
}

/** Members of one group, excluding the group's own lead. */
export function groupMembers(registry, group) {
  return allMembers(registry).filter((m) => m.tier === MEMBER_TIER && m.group === group)
}

/** How many leads one actor already owns. */
function ownedLeads(registry, actorName) {
  return allMembers(registry).filter((m) => m.tier === LEAD_TIER && m.parent === actorName && m.group !== VERIFIER_GROUP)
}

/** Whether a member exists, is the root, and is not frozen. */
function usable(registry, name) {
  const m = getMember(registry, name)
  return m !== undefined && m.frozen !== true
}

/**
 * Whether \`actor\` may see \`target\` in a roster listing.
 * tier 0 sees everyone; tier 1 sees the root, its own group, and its own children;
 * tier 2 sees the root and its own group only.
 */
export function canSee(registry, actorName, targetName) {
  const actor = getMember(registry, actorName)
  const target = getMember(registry, targetName)
  if (!actor || !target) return false
  // §6: the Lead sees the tier-1 leads and itself. A tier-2 member is visible to
  // its own group lead and to the operator, not to the Lead.
  if (actor.tier === ROOT_TIER) return target.tier === LEAD_TIER || target.name === actorName
  if (target.tier === ROOT_TIER) return true
  if (actor.tier === LEAD_TIER) {
    if (target.tier === LEAD_TIER) return true
    return target.parent === actorName || target.group === actor.group
  }
  if (target.tier === LEAD_TIER) return target.name === actor.parent
  return target.group === actor.group
}

/**
 * Whether \`actor\` may send a message to \`target\`.
 * tier 0 may message anyone. tier 1 may message the root, level-1 peers and its own
 * children. tier 2 may message only its own group and may NOT message the root
 * (it may still SEE the root). A frozen member neither sends nor receives.
 */
export function canMessage(registry, actorName, targetName) {
  const actor = getMember(registry, actorName)
  const target = getMember(registry, targetName)
  if (!actor || !target) return false
  if (actor.frozen === true || target.frozen === true) return false
  // §5/§6: tier 0 talks to tier 1 only. A tier-2 member is read-only to the Lead,
  // so work is always routed through the group lead that owns it.
  if (actor.tier === ROOT_TIER) return target.tier === LEAD_TIER
  if (target.tier === ROOT_TIER) return actor.tier === LEAD_TIER
  if (actor.tier === LEAD_TIER) {
    if (target.tier === LEAD_TIER) return true
    return target.parent === actorName || target.group === actor.group
  }
  if (target.tier === LEAD_TIER) return target.name === actor.parent
  return target.group === actor.group
}

/**
 * Whether \`actor\` may interrupt \`target\`.
 * Only tier 0 may interrupt anyone; a level-1 lead may interrupt its OWN children.
 * Same-level peers can talk and view but never interrupt each other, and a member
 * is never controlled by a lead that did not spawn it.
 */
export function canInterrupt(registry, actorName, targetName) {
  const actor = getMember(registry, actorName)
  const target = getMember(registry, targetName)
  if (!actor || !target || target.frozen === true) return false
  if (actor.tier === ROOT_TIER) return true
  return actor.tier === LEAD_TIER && (target.parent === actorName || target.group === actor.group)
}

/**
 * Check one spawn request. Returns { ok: true, tier, group } or
 * { ok: false, reason } — never throws, so callers can render a useful refusal.
 */
export function canSpawn(registry, actorName, requestedTier, group, options) {
  const actor = getMember(registry, actorName)
  if (!actor) return { ok: false, reason: 'unknown member "' + actorName + '"' }
  if (actor.frozen === true) return { ok: false, reason: 'member "' + actorName + '" is frozen and cannot spawn' }
  const activeMembers = allMembers(registry)
    .filter((member) => member.tier > ROOT_TIER && member.frozen !== true && member.status !== 'failed')
  if (activeMembers.length >= registry.maxMembers) {
    return { ok: false, reason: 'the Team has ' + activeMembers.length + ' active members; the current capacity is ' + registry.maxMembers + '. Freeze a finished member before creating another.' }
  }
  if (actor.tier === MEMBER_TIER) {
    return { ok: false, reason: 'tier 2 members cannot spawn: only the Lead (tier 0) and group leads (tier 1) may' }
  }
  if (actor.tier === ROOT_TIER) {
    if (requestedTier === LEAD_TIER) {
      const isVerifier = group === VERIFIER_GROUP
      if (isVerifier && allMembers(registry).filter((m) => m.group === VERIFIER_GROUP && m.frozen !== true && m.status !== 'failed').length >= registry.maxVerifiers) {
        return { ok: false, reason: 'the verifier slot is already taken' }
      }
      if (!isVerifier && ownedLeads(registry, actorName).filter((m) => m.frozen !== true && m.status !== 'failed').length >= registry.maxTier1Leads) {
        return { ok: false, reason: 'tier 1 is capped at ' + registry.maxTier1Leads + ' group leads' }
      }
      if (isVerifier && ownedLeads(registry, actorName).filter((m) => m.group === VERIFIER_GROUP && m.frozen !== true && m.status !== 'failed').length >= registry.maxVerifiers) {
        return { ok: false, reason: 'the verifier slot is already taken' }
      }
      return { ok: true, tier: LEAD_TIER, group: group || actorName }
    }
    if (requestedTier === ROOT_TIER) return { ok: false, reason: 'a second tier 0 lead cannot be spawned' }
    return { ok: false, reason: 'tier 0 spawns tier 1 only' }
  }
  // actor.tier === LEAD_TIER
  if (requestedTier !== MEMBER_TIER) {
    return { ok: false, reason: 'a group lead may only spawn tier 2 members (never tier 0 or another tier 1)' }
  }
  if (actor.group === VERIFIER_GROUP) {
    return { ok: false, reason: 'the verifier group is independent and must not own members' }
  }
  if (group !== undefined && group !== actor.group) {
    return { ok: false, reason: 'a group lead may only spawn into its own group "' + actor.group + '"' }
  }
  if (groupMembers(registry, actor.group).filter((m) => m.frozen !== true && m.status !== 'failed').length >= registry.maxMembersPerLead) {
    return { ok: false, reason: 'group "' + actor.group + '" is capped at ' + registry.maxMembersPerLead + ' members' }
  }
  return { ok: true, tier: MEMBER_TIER, group: actor.group }
}

/** Whether \`actor\` may write the global board. Only tier 0 may; everyone may read. */
/**
 * Why one message is refused, or undefined when it is permitted.
 * A refusal that names the wrong cause actively misleads the model: a real run
 * reported "may not message (tier 0)" for a FROZEN target and the model then
 * reasoned about tier rules instead of the freeze. The reason is therefore
 * derived from the same predicate, never hand-written at the call site.
 */
export function whyCannotMessage(registry, actorName, targetName) {
  const actor = getMember(registry, actorName)
  const target = getMember(registry, targetName)
  if (!actor) return 'unknown member "' + actorName + '"'
  if (!target) return 'unknown member "' + targetName + '"'
  if (actor.frozen === true) return 'member "' + actorName + '" is frozen: it cannot send until it is restored'
  if (target.frozen === true) return 'member "' + targetName + '" is frozen: the message is not queued and will not cold-resume it (restore it first)'
  if (canMessage(registry, actorName, targetName)) return undefined
  if (actor.tier === ROOT_TIER && target.tier === MEMBER_TIER) return 'tier 0 talks to tier 1 only: "' + targetName + '" is tier 2, so route this through "' + String(target.parent) + '"'
  if (target.tier === ROOT_TIER) return 'tier ' + actor.tier + ' may see the Lead but may not message it'
  if (actor.tier === LEAD_TIER && target.tier === MEMBER_TIER) return '"' + targetName + '" belongs to group "' + target.group + '", not to "' + actorName + '"'
  return 'tier ' + actor.tier + ' may not message a member of group "' + target.group + '"'
}

/** Why one interrupt is refused, or undefined when it is permitted. */
export function whyCannotInterrupt(registry, actorName, targetName) {
  const actor = getMember(registry, actorName)
  const target = getMember(registry, targetName)
  if (!actor) return 'unknown member "' + actorName + '"'
  if (!target) return 'unknown member "' + targetName + '"'
  if (target.frozen === true) return 'member "' + targetName + '" is frozen: restoring it is the only available control'
  if (canInterrupt(registry, actorName, targetName)) return undefined
  if (actor.tier === LEAD_TIER) return '"' + targetName + '" was spawned by "' + String(target.parent) + '", not by "' + actorName + '"'
  return 'tier ' + actor.tier + ' cannot interrupt anyone; only tier 0 and the spawning group lead can'
}

export function canWriteGlobalBoard(registry, actorName) {
  const actor = getMember(registry, actorName)
  return actor !== undefined && actor.tier === ROOT_TIER && actor.frozen !== true
}

/** Which board a task belongs to: 'global', 'level-N', or 'group-<lead>'. */
export function boardOf(registry, actorName, kind) {
  const actor = getMember(registry, actorName)
  if (!actor) return undefined
  if (actor.tier === ROOT_TIER) {
    // §5: tier 0 owns the global board plus its own group board.
    return kind === 'group' ? 'group-' + (actor.group ?? 'root') : 'global'
  }
  if (kind === 'level') return 'level-' + actor.tier
  return 'group-' + actor.group
}

/**
 * Whether one board id exists and who owns it.
 * The global board belongs to tier 0 and is readable by everyone; a level board
 * is the shared board of one tier; a group board belongs to one group.
 */
export function boardTier(registry, board) {
  if (typeof board !== 'string') return undefined
  if (board === 'global') return ROOT_TIER
  const level = /^level-(\d+)$/.exec(board)
  if (level !== null) return Number(level[1])
  return undefined
}

/** Whether \`actor\` may see one board. The global board is readable by everyone. */
export function canReadBoard(registry, actorName, board) {
  const actor = getMember(registry, actorName)
  if (!actor) return false
  if (board === 'global') return true
  if (actor.tier === ROOT_TIER) return true
  // The independent verifier must be able to compare an acceptance packet's
  // card snapshot against the board it claims to describe. This is read-only:
  // canWriteBoard remains unchanged, so verifier review cannot mutate a group
  // board.
  if (actor.group === VERIFIER_GROUP && typeof board === 'string' && board.startsWith('group-')) return true
  const level = boardTier(registry, board)
  if (level !== undefined) return level === actor.tier
  return board === 'group-' + actor.group
}

/**
 * Whether `actor` may mutate one board.
 * The global board is tier-0 only; a level board is written by that tier only;
 * a group board by its own group; a frozen member writes nothing.
 */
export function canWriteBoard(registry, actorName, board) {
  const actor = getMember(registry, actorName)
  if (!actor || actor.frozen === true) return false
  if (board === 'global') return actor.tier === ROOT_TIER
  if (actor.tier === ROOT_TIER) return true
  const level = boardTier(registry, board)
  if (level !== undefined) return level === actor.tier
  return board === 'group-' + actor.group
}

/** Freeze or thaw one member. Returns the previous value, or undefined for an unknown member. */
export function setFrozen(registry, name, frozen) {
  const member = getMember(registry, name)
  if (!member) return undefined
  const previous = member.frozen === true
  member.frozen = frozen === true
  const names = new Set(registry.frozenNames ?? [])
  if (member.frozen) names.add(member.name)
  else names.delete(member.name)
  registry.frozenNames = [...names]
  return previous
}

/** Pin one member's LLM route in the in-memory projection. Unknown member returns undefined. */
export function setRoute(registry, name, route) {
  const member = getMember(registry, name)
  if (!member) return undefined
  member.route = route
  return member.route
}

// ── Board storage ──────────────────────────────────────────────────────────
// The domain owns exactly ONE durable board. The global board IS that board
// (the tool layer routes it there and restricts writes to tier 0); level and
// group boards live here, board-scoped and revisioned with the same CAS
// contract so the tool layer can expose one uniform shape.

/** Create an empty board store. */
export function createBoards() {
  return { boards: new Map(), seq: 0 }
}

/** Internal: one board's task map, created on demand. */
function boardMap(store, boardId) {
  let map = store.boards.get(boardId)
  if (!map) {
    map = new Map()
    store.boards.set(boardId, map)
  }
  return map
}

/** Create one task on a board; returns the revision-one view. */
export function boardCreate(store, boardId, request) {
  const id = boardId + '-t' + String(++store.seq)
  const ownerName = typeof request.ownerName === 'string' && request.ownerName.trim().length > 0
    ? request.ownerName.trim()
    : undefined
  const blockedBy = request.blockedBy ?? []
  const ready = blockedBy.length === 0
  const task = {
    id,
    revision: 1,
    subject: request.subject,
    description: request.description,
    status: ownerName === undefined || !ready ? 'pending' : 'in_progress',
    phase: TASK_PHASES.includes(request.phase) ? request.phase : 'draft',
    blockedBy,
    writeScopes: request.writeScopes ?? [],
    ...(['discussion', 'review', 'edit'].includes(request.workKind) ? { workKind: request.workKind } : {}),
    ready,
    writeScopeWarnings: [],
    board: boardId,
  }
  if (ownerName !== undefined) task.ownerName = ownerName
  boardMap(store, boardId).set(id, task)
  return { ...task }
}

/** List one board's non-deleted tasks in creation order. */
export function boardList(store, boardId) {
  const map = boardMap(store, boardId)
  return [...map.values()].filter((t) => t.status !== 'deleted').map((t) => ({ ...t }))
}

/** Read one task, including a deleted tombstone. */
export function boardGet(store, boardId, taskId) {
  return store.boards.get(boardId)?.get(taskId)
}

/** Compare-and-set one task transition. Throws on a stale revision. */
export function boardUpdate(store, boardId, request, actorName) {
  const map = boardMap(store, boardId)
  const task = map.get(request.taskId)
  if (!task) throw new Error('unknown task "' + request.taskId + '" on board "' + boardId + '"')
  if (task.revision !== request.expectedRevision) {
    throw new Error('stale revision for "' + request.taskId + '": expected ' + request.expectedRevision + ', current ' + task.revision)
  }
  switch (request.action) {
    case 'claim':
      if (task.ownerName !== undefined && task.ownerName !== actorName) {
        throw new Error('"' + request.taskId + '" is already owned by ' + task.ownerName)
      }
      task.ownerName = actorName
      task.status = 'in_progress'
      break
    case 'advance_phase': {
      const currentPhase = TASK_PHASES.includes(task.phase) ? task.phase : 'draft'
      const nextPhase = String(request.phase || '')
      if (!TASK_PHASES.includes(nextPhase)) throw new Error('unsupported task phase "' + nextPhase + '"')
      if (!canAdvanceTaskPhase(currentPhase, nextPhase)) {
        const allowed = allowedTaskPhaseTransitions(currentPhase)
        const recovery = taskPhaseRecoveryActions(currentPhase)
        throw new Error('invalid task phase transition "' + currentPhase + '" -> "' + nextPhase + '"'
          + '; allowed next phases: ' + (allowed.length > 0 ? allowed.join(', ') : '(none)')
          + (recovery.length > 0 ? '; recovery action: ' + recovery.join(', ') : ''))
      }
      task.phase = nextPhase
      break
    }
    case 'release':
      if (task.status === 'deleted') {
        throw new Error('cannot release deleted task "' + request.taskId
          + '"; deletion already releases its write-scope occupancy, and release must not resurrect it')
      }
      if (task.ownerName !== actorName) throw new Error('only the owner may release "' + request.taskId + '"')
      task.ownerName = undefined
      task.status = 'pending'
      break
    case 'complete':
      if (task.ownerName !== undefined && task.ownerName !== actorName) {
        throw new Error('only the owner may complete "' + request.taskId + '"')
      }
      task.ownerName = task.ownerName ?? actorName
      task.status = 'completed'
      if (request.evidenceIds !== undefined) task.evidenceIds = mergeEvidenceIds(task.evidenceIds, request.evidenceIds)
      break
    case 'bind_fix':
      if (task.status !== 'completed') {
        throw new Error('bind_fix requires completed task "' + request.taskId + '"; current status is ' + String(task.status))
      }
      if (String(request.bindFixReason || '').trim().length === 0) {
        throw new Error('bind_fix requires bindFixReason')
      }
      {
        const writeScopes = Array.isArray(task.writeScopes) ? task.writeScopes : []
        const workKind = task.workKind ?? (writeScopes.length > 0 ? 'edit' : 'discussion')
        const commitRequired = workKind === 'edit' || writeScopes.length > 0
        if (commitRequired
          && (request.commitSha === undefined || request.commitSha === null || String(request.commitSha).trim().length === 0)) {
          throw new Error('bind_fix requires commitSha for edit cards')
        }
        task.commitSha = request.commitSha === undefined || request.commitSha === null
          ? null
          : String(request.commitSha)
      }
      if (!Array.isArray(request.evidenceIds) || request.evidenceIds.length === 0) {
        throw new Error('bind_fix requires evidenceIds')
      }
      task.evidenceIds = mergeEvidenceIds(task.evidenceIds, request.evidenceIds)
      break
    case 'reopen':
      task.status = 'pending'
      if (typeof request.reopenReason === 'string' && request.reopenReason.trim().length > 0) {
        task.lastReopenReason = request.reopenReason.trim()
        task.lastReopenAt = Date.now()
      }
      break
    case 'delete':
      task.status = 'deleted'
      break
    case 'edit':
      if (request.writeScopes !== undefined) {
        throw new Error('task "' + request.taskId + '" writeScopes are controlled by its plan; '
          + 'replace the plan instead of editing the task row')
      }
      if (request.subject !== undefined) task.subject = request.subject
      if (request.description !== undefined) task.description = request.description
      break
    case 'set_dependencies':
      task.blockedBy = request.blockedBy ?? []
      if (request.dependencyPhase !== undefined) task.dependencyPhase = String(request.dependencyPhase)
      task.ready = task.blockedBy.every((id) => dependencySatisfied(map.get(id), request.dependencyPhase ?? task.dependencyPhase ?? 'accepted'))
      break
    case 'reassign':
      // An explicit undefined is not lossless JSON and the registry rejects it.
      if (request.owner === undefined) delete task.ownerName
      else task.ownerName = request.owner
      task.worktreePath = null
      task.status = request.owner === undefined || task.ready === false ? 'pending' : 'in_progress'
      break
    default:
      throw new Error('unsupported action "' + String(request.action) + '"')
  }
  task.revision += 1
  return { ...task }
}

/** Seed tier 0 from the live roster: the agent whose Team role is 'lead'. */
export function seedRoot(registry, leadAgent) {
  if (!leadAgent) return undefined
  return putMember(registry, {
    name: 'lead',
    tier: ROOT_TIER,
    group: 'root',
    parent: undefined,
    frozen: false,
  })
}

/** Build the policy service of one Team: its own registry and its own boards. */
function createTeamService(limits, teamKey) {
  const registry = createRegistry()
  if (Number.isFinite(limits.maxTier1Leads)) registry.maxTier1Leads = limits.maxTier1Leads
  if (Number.isFinite(limits.maxVerifiers)) registry.maxVerifiers = limits.maxVerifiers
  if (Number.isFinite(limits.maxMembersPerLead)) registry.maxMembersPerLead = limits.maxMembersPerLead
  if (Number.isFinite(limits.maxMembers)) registry.maxMembers = Math.max(1, Math.floor(limits.maxMembers))
  const boards = createBoards()
  let hydratedBoardsRevision = -1
  let hydratedBoardTasks = new Map()
  // Unconfigured test callers get a process-local durable file so one old
  // probe cannot contaminate a later probe. The real profile supplies a
  // stable controlDir and therefore recovers across process restarts.
  const controlDirectory = typeof limits.controlDir === 'string' && limits.controlDir.length > 0
    ? limits.controlDir
    : join(process.env.DSH_HOME ?? process.cwd(), '.team-control-runtime-' + process.pid)
  const control = controlPlaneFor(teamKey, {
    directory: controlDirectory,
    ...(Number.isFinite(limits.maxRoomRounds) && limits.maxRoomRounds > 0
      ? { maxRoomRounds: Math.floor(limits.maxRoomRounds) }
      : {}),
  })
  const hydrateBoards = (snapshot = control.view({ history: false })) => {
    const nextBoardTasks = new Map()
    boards.boards.clear()
    boards.seq = 0
    for (const [boardId, board] of Object.entries(snapshot.boards ?? {})) {
      const map = new Map()
      const taskCache = new Map()
      const previousTasks = hydratedBoardTasks.get(boardId)
      for (const [taskId, task] of Object.entries(board.tasks ?? {})) {
        const revision = Number(task?.revision)
        const previous = previousTasks?.get(taskId)
        const reusable = previous !== undefined
          && Number.isFinite(revision)
          && previous.source === task
          && previous.revision === revision
        const value = reusable ? previous.value : structuredClone(task)
        map.set(taskId, value)
        taskCache.set(taskId, { source: task, revision, value })
      }
      boards.boards.set(boardId, map)
      nextBoardTasks.set(boardId, taskCache)
      boards.seq = Math.max(boards.seq, Number(board.seq || 0))
    }
    hydratedBoardTasks = nextBoardTasks
    hydratedBoardsRevision = Number(snapshot.revision ?? 0)
  }
  hydrateBoards()
  const hydrateFrozen = () => {
    const names = new Set(control.frozenNames())
    registry.frozenNames = [...names]
    for (const member of registry.members.values()) {
      if (member.name !== 'lead') member.frozen = names.has(member.name)
    }
  }
  hydrateFrozen()
  const hydrateParents = () => {
    registry.parentOverrides = Object.fromEntries(Object.entries(control.memberParents())
      .map(([member, row]) => [member, String(row?.parent ?? '')])
      .filter(([, parent]) => parent.length > 0))
    for (const member of registry.members.values()) {
      const parent = parentOverrideFor(registry, member.name)
      if (parent !== undefined) member.parent = parent
    }
  }
  hydrateParents()

  return {
    registry,
    boards,
    boardCreate: (boardId, request) => {
      const task = boardCreate(boards, boardId, request)
      void control.boardCreate({ boardId, taskId: task.id, ...request }).catch?.(() => {})
      return task
    },
    boardCreateAsync: async (boardId, request, agent) => {
      const task = await control.boardCreate({ boardId, ...request }, agent)
      hydrateBoards()
      return structuredClone(task)
    },
    boardList: (boardId) => boardList(boards, boardId),
    boardGet: (boardId, taskId) => boardGet(boards, boardId, taskId),
    boardUpdate: (boardId, request, actorName) => {
      const task = boardUpdate(boards, boardId, request, actorName)
      void control.boardUpdate({ boardId, ...request, actorName }).catch?.(() => {})
      return task
    },
    boardUpdateAsync: async (boardId, request, actorName, agent) => {
      const task = await control.boardUpdate({ boardId, ...request, actorName }, agent)
      hydrateBoards()
      return structuredClone(task)
    },
    refreshBoards: (snapshot) => {
      const current = snapshot ?? control.reload()
      if (Number(current.revision ?? 0) !== hydratedBoardsRevision) hydrateBoards(current)
      return boards
    },
    controlFlush: () => control.flush(),
    control,
    seedRoot: (agent) => seedRoot(registry, agent),
    put: (record) => {
      const member = putMember(registry, record)
      if (control.frozenNames().includes(member.name)) member.frozen = true
      return member
    },
    get: (n) => getMember(registry, n),
    all: () => allMembers(registry),
    groupMembers: (g) => groupMembers(registry, g),
    canSee: (a, t) => canSee(registry, a, t),
    canMessage: (a, t) => canMessage(registry, a, t),
    canInterrupt: (a, t) => canInterrupt(registry, a, t),
    whyCannotMessage: (a, t) => whyCannotMessage(registry, a, t),
    whyCannotInterrupt: (a, t) => whyCannotInterrupt(registry, a, t),
    canSpawn: (a, tier, group, options) => canSpawn(registry, a, tier, group, options),
    canWriteGlobalBoard: (a) => canWriteGlobalBoard(registry, a),
    canReadBoard: (a, b) => canReadBoard(registry, a, b),
    boardOf: (a, kind) => boardOf(registry, a, kind),
    boardTier: (b) => boardTier(registry, b),
    canWriteBoard: (a, b) => canWriteBoard(registry, a, b),
    setFrozen: (n, f) => {
      const previous = setFrozen(registry, n, f)
      if (previous !== undefined) void control.frozenSet({ member: n, frozen: f === true }).catch?.(() => {})
      return previous
    },
    setFrozenAsync: async (n, f, actor, syncDomain) => {
      const previous = setFrozen(registry, n, f)
      if (previous === undefined) return undefined
      try {
        if (typeof syncDomain === 'function') await syncDomain()
        await control.frozenSet({ member: n, frozen: f === true, updatedBy: actor }, actor)
      } catch (error) {
        setFrozen(registry, n, previous)
        throw error
      }
      return previous
    },
    refreshFrozen: () => {
      control.reload()
      hydrateFrozen()
    },
    frozenNames: () => [...(registry.frozenNames ?? [])],
    setRoute: (n, r) => setRoute(registry, n, r),
    setRouteAsync: async (n, r, actor) => {
      const member = getMember(registry, n)
      if (member === undefined) return undefined
      await control.memberRouteSet({ member: n, route: r, updatedBy: actor }, actor)
      return setRoute(registry, n, r)
    },
    setParent: (n, p) => setMemberParentOverride(registry, n, p),
    setParentAsync: async (n, p, actor, reason) => {
      const member = getMember(registry, n)
      if (member === undefined) return { ok: false, reason: 'unknown member "' + n + '"' }
      const previous = member.parent ?? null
      const previousOverride = registry.parentOverrides?.[n]
      const changed = setMemberParentOverride(registry, n, p)
      if (changed.ok !== true) return changed
      try {
        await control.memberParentSet({ member: n, parent: p, reason, updatedBy: actor }, actor)
      } catch (error) {
        if (previousOverride === undefined) delete registry.parentOverrides[n]
        else registry.parentOverrides[n] = previousOverride
        member.parent = previous
        throw error
      }
      return changed
    },
    refreshParents: () => {
      control.reload()
      hydrateParents()
    },
  }
}

/**
 * The policy service of one Team, created on first use.
 * @param key - the Team's root session id; '' is the default Team (a legacy/unknown key).
 * @returns that Team's service, which also becomes the active one.
 */
export function policyFor(key) {
  const k = typeof key === 'string' && key.length > 0 ? key : ''
  let service = TEAMS.get(k)
  if (service === undefined) {
    service = createTeamService(LIMITS, k)
  }
  TEAMS.delete(k)
  TEAMS.set(k, service)
  while (TEAMS.size > MAX_TEAM_SERVICES) {
    const oldest = TEAMS.keys().next().value
    if (oldest === undefined) break
    TEAMS.delete(oldest)
  }
  ACTIVE = service
  return service
}

/** Number of Team services currently retained by the bounded LRU cache. */
export function policyServiceCount() {
  return TEAMS.size
}

/** Clear the process-local Team service cache. Intended for tests and reset paths. */
export function resetPolicyServices() {
  TEAMS.clear()
  ACTIVE = undefined
}

/**
 * The Team root key behind one live agent: the root session id the Domain reports as the
 * membership id, for a Lead and for a teammate alike. Undefined when it has no Team.
 * @param ctx - host context carrying the Agent Teams service.
 * @param agent - the exact live agent.
 * @returns the key, or undefined.
 */
export function teamKeyOf(ctx, agent) {
  if (agent !== null && (typeof agent === 'object' || typeof agent === 'function')) {
    const cached = TEAM_KEYS.get(agent)
    if (cached !== undefined) return cached
  }
  try {
    const membership = ctx.agentTeams.tryMembership(agent)
    const key = membership === undefined || membership.id === undefined ? undefined : String(membership.id)
    if (key !== undefined && agent !== null && (typeof agent === 'object' || typeof agent === 'function')) {
      TEAM_KEYS.set(agent, key)
    }
    return key
  } catch {
    return undefined
  }
}

/**
 * Publish the policy registry for every other plugin in this process.
 * cordis refuses ctx.set() for an undeclared service and export const provide
 * does not work for a function plugin, so the registry crosses the plugin
 * boundary as a module singleton read through activePolicy()/policyFor().
 * @param ctx - cordis plugin context.
 * @param config - this plugin row's config.
 */
export function apply(ctx, config = {}) {
  LIMITS = config === null || config === undefined ? {} : config
  if (typeof ctx.on === 'function') {
    ctx.on('agent/created', ({ agent }) => prepareRosterProvenance(ctx, agent), { global: true })
    ctx.on('agent/pre-step', async ({ agent }, next) => {
      await prepareRosterProvenance(ctx, agent)
      return next()
    }, { global: true })
  }
  return policyFor('')
}
