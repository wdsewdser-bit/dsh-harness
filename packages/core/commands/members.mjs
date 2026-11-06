import { fail, failWith } from '../../contracts/index.mjs';

/**
 * Member facts: the roster row a team is built from, the group and the workspace root assigns, and the lifecycle intent
 * the model asks for.
 *
 * These are different facts, not one implementation: member.create writes the roster row directly (root provisioning and
 * test fixtures), member.intent records a request that the lifecycle driver turns into a native effect. P2 (§4.2.1) adds
 * the two things root could not say before -- a group and a workspace -- to the intent, and keeps them out of member.create
 * except as the place the roster row finally reads them.
 *
 * The workspace rules live here, once: shape (§4.2.2), one assignment per member, no sharing and no nesting (§4.2.3
 * rule 3 / appendix 7), and the lock (§4.2.4). The host side mirrors the shape and nesting rules for its own command
 * entry, because profiles/ may not import this module (check-deps rule b); the realpath fence itself exists only on the
 * host side, which is the only side that knows the team root.
 */

/** §4.2.2: a workspace is a relative path; the same shape the published schema carries. */
const WORKSPACE_SHAPE = /^(?!.*\.\.)[A-Za-z0-9._/-]{1,200}$/;
/** §4.2.2: a group name is one token, so it can never look like a path or an entity id. */
const GROUP_SHAPE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
/**
 * The member states in which a member is doing work. §4.2.4 makes a group change a new-generation act, and §4.3 lets root
 * re-assign a workspace after a create failed; both ask the same question, so both read this one list.
 */
const LIVE = Object.freeze(['create-pending', 'resume-pending', 'cancel-pending', 'dispose-pending', 'running', 'active', 'frozen']);

/** The row a workspace assignment is recorded on: durable, one per member, its own revision (§4.2.2). */
export function workspaceId(memberId) { return 'member.workspace:' + memberId; }

/**
 * §4.2.2: normalize and validate the relative path root asked for.
 *
 * Everything absolute is refused by name rather than resolved and clamped: a drive letter, a leading separator (which is
 * also how a UNC path starts once it is not backslash-escaped), a backslash, and any ".." anywhere. The team root itself
 * is not assignable -- root must not hand a member the root, and §4.2.3 makes the root immutable.
 */
export function normalizeWorkspaceRel(value) {
  if (typeof value !== 'string' || value.length === 0 || value.length > 200) {
    failWith('INVALID_WORKSPACE', 'a workspace is a relative path under the team root of at most 200 characters; got ' + JSON.stringify(value ?? null));
  }
  if (!WORKSPACE_SHAPE.test(value)) {
    failWith('INVALID_WORKSPACE', 'a workspace must be a relative path of A-Z a-z 0-9 . _ - and /; absolute paths, drive letters, UNC paths, backslashes and ".." are refused: ' + JSON.stringify(value));
  }
  const segments = value.split('/').filter(segment => segment !== '' && segment !== '.');
  if (segments.length === 0) failWith('INVALID_WORKSPACE', 'the team root is not assignable: ' + JSON.stringify(value) + ' names it');
  return segments.join('/');
}

/** §4.2.2: one token, at most 64 characters, starting with a letter or a digit. */
export function assertGroupName(value, label = 'group') {
  if (typeof value !== 'string' || !GROUP_SHAPE.test(value)) {
    failWith('INVALID_GROUP', label + ' must be one token of A-Z a-z 0-9 . _ - starting with a letter or digit, at most 64 characters; got ' + JSON.stringify(value ?? null));
  }
  return value;
}

/**
 * §4.2.3 rule 3 / appendix 7: two members never share a workspace and never nest inside each other's.
 *
 * The comparison is case-insensitive on purpose: on Windows two spellings are one directory, and refusing a pair the host
 * would resolve to the same place is cheaper than discovering it after both sessions exist.
 */
export function assertWorkspaceFree(readable, memberId, relPath) {
  const candidate = relPath.toLowerCase();
  for (const row of readable.list('member.workspace:')) {
    if (row.memberId === memberId) continue;
    const other = String(row.relPath ?? '').toLowerCase();
    if (!other) continue;
    if (other === candidate || other.startsWith(candidate + '/') || candidate.startsWith(other + '/')) {
      failWith('INVALID_WORKSPACE', 'workspace ' + relPath + ' overlaps ' + row.relPath + ', already assigned to ' +
        row.memberId + ': two members never share or nest workspaces (appendix 7)');
    }
  }
}

/**
 * §4.2.4: an assignment is locked once the member exists, and re-opened only for a binding that is dead.
 *
 * A member that never got past a failed create is exactly the case §4.3 sends back to root, so it stays assignable; a
 * member that is live, or that never started and therefore still holds its slot, does not.
 */
function assertAssignable(tx, memberId) {
  const record = tx.read(workspaceId(memberId));
  if (!record || !record.lockedAt) return record ?? null;
  const member = tx.read(memberId);
  if (!member || member.status === 'retired' || member.status === 'unknown' || member.status === 'cancelled' ||
    member.status === 'create-failed') return record;
  failWith('WORKSPACE_LOCKED', 'the workspace of ' + memberId + ' was locked when the member was created (' +
    (member.status ?? 'created') + '); assign a new one only after the member is retired or its create failed (§4.2.4)');
}

/**
 * The pending assignment this member is being created with, if any (§4.2.1: the intent is root's one write).
 *
 * The row's `op` stays 'request' for a provision, because the lifecycle consumer creates a member only for that op
 * (packages/host/src/core-access.mjs:308, outside this package's allowlist); what makes it a provision is the group it
 * carries, which is what this looks for.
 */
function pendingAssignment(tx, memberId) {
  return tx.list('member-intent:').filter(row => row.status === 'intent' && typeof row.group === 'string' &&
    (row.memberRef === memberId || (!row.memberRef && 'member:' + row.operationId === memberId))).at(-1) ?? null;
}

/**
 * §4.2.1/§4.2.2: root writes role + group + workspace into ONE member-intent, and the workspace record with it.
 *
 * The fenced answer is required, not optional: a path nobody resolved against the team root is never recorded, because
 * the reducer cannot tell whether it lands inside the root. The host asks the same fence again before it creates a
 * directory (appendix 7: the second check is the one that closes the TOCTOU window; this one is the one that keeps a
 * bad assignment out of the journal at all).
 */
function provisionIntent(tx, command, args) {
  if (command.actor !== 'member:root') failWith('ROLE_DENIED', 'only the team root provisions members, groups and workspaces (§4.2.3 rule 1)');
  if (!['worker', 'verifier', 'subCoordinator'].includes(args.role)) fail('INVALID_MEMBER_INTENT');
  const memberId = args.memberRef ?? 'member:' + command.payload.operationId;
  const existing = args.memberRef ? tx.read(memberId) : null;
  if (args.memberRef && !existing) fail('UNKNOWN_MEMBER:' + args.memberRef);
  const group = args.group === undefined ? 'default' : assertGroupName(args.group);
  const record = assertAssignable(tx, memberId);
  const relPath = args.workspace === undefined ? null : normalizeWorkspaceRel(args.workspace);
  if (relPath) {
    const fenced = command.payload.workspace ?? null;
    if (!fenced || fenced.relPath !== relPath || typeof fenced.resolved !== 'string') {
      failWith('INVALID_WORKSPACE', 'the workspace ' + relPath + ' reached the reducer without a host fence; a relative path nobody resolved against the team root is never recorded');
    }
    assertWorkspaceFree(tx, memberId, relPath);
    tx.put(workspaceId(memberId), { memberId, relPath, base: fenced.base ?? null, resolved: fenced.resolved,
      recordedAt: command.now ?? null, by: command.actor, lockedAt: record?.lockedAt ?? null });
  }
  // §4.2.2: a group is a row, and provisioning into a group that does not exist creates it in the same transaction --
  // root plans with one call, and the explicit group branch is only for a group that has to exist before its members.
  if (!tx.read('group:' + group)) tx.put('group:' + group, { name: group, lead: null, createdAt: command.now ?? null, by: command.actor });
  // A re-assignment of a member that already exists is not a lifecycle request: writing a member-intent would send the
  // consumer a create for a member that already has (or had) a session. The assignment and the group are the whole
  // effect, and the member's own row is the one that changes.
  if (existing) return tx.put(memberId, { ...existing, group });
  const intentRef = 'member-intent:' + command.payload.operationId;
  // op stays 'request': see pendingAssignment. group/workspaceRel are what this intent adds.
  const row = tx.put(intentRef, { op: 'request', provision: true, role: args.role, group, workspaceRel: relPath,
    operationId: command.payload.operationId, status: 'intent', actor: command.actor });
  tx.outbox(intentRef, { kind: 'member-lifecycle', intentRef });
  return row;
}

/**
 * §4.2.1/§4.2.4: groups are rows; a member's group changes only when the member is not live.
 *
 * 'create' is idempotent for the same lead: a replay of the same plan is not a conflict. 'assign' refuses a live member
 * with GROUP_LOCKED rather than silently moving work between groups that already hold leases.
 */
function groupIntent(tx, command, args) {
  if (command.actor !== 'member:root') failWith('ROLE_DENIED', 'only the team root creates groups or moves a member between them');
  const name = assertGroupName(args.group);
  const groupId = 'group:' + name;
  const mode = args.mode ?? 'create';
  if (mode === 'create') {
    const lead = args.lead ?? null;
    if (lead !== null && !tx.read(lead)) fail('UNKNOWN_MEMBER:' + lead);
    const current = tx.read(groupId);
    if (current) {
      if ((current.lead ?? null) !== lead) {
        failWith('INVALID_GROUP', 'group ' + name + ' already exists with lead ' + (current.lead ?? 'none') +
          '; a different lead is a different plan, not a replay');
      }
      return current;
    }
    return tx.put(groupId, { name, lead, createdAt: command.now ?? null, by: command.actor });
  }
  if (mode !== 'assign') failWith('INVALID_GROUP', 'group takes mode create|assign, got ' + JSON.stringify(mode));
  const member = tx.read(args.memberRef);
  if (!member) fail('UNKNOWN_MEMBER:' + String(args.memberRef));
  if (!tx.read(groupId)) failWith('INVALID_GROUP', 'group ' + name + ' does not exist; create it before moving a member into it');
  if (LIVE.includes(member.status)) {
    failWith('GROUP_LOCKED', 'member ' + member.entityId + ' is ' + member.status + '; a group change is a new-generation act (§4.2.4)');
  }
  return tx.put(member.entityId, { ...member, group: name });
}

function createMember(tx, command) {
  const { memberId, role, group, limits } = command.payload;
  // §4.2.1 / appendix 7: the intent is root's assignment, and the roster row is created by whoever consumes that intent
  // (the lifecycle driver calls member.create with the role only). So the group root named is read from the pending
  // assignment; a fixture or a direct call with no pending intent keeps its own argument exactly as before.
  const assignment = pendingAssignment(tx, memberId);
  const assignedGroup = assignment?.group ?? group;
  const members = tx.list('member:');
  if (members.length >= limits.maxMembers || (role === 'subCoordinator' &&
    (members.filter(m => m.role === 'worker').length < limits.subCoordinatorMinWorkers ||
    members.filter(m => m.role === role).length >= limits.maxSubCoordinators))) fail('CAPACITY');
  if (role === 'worker' && members.filter(m => m.role === role && m.group === assignedGroup).length >= limits.maxPerGroup) {
    fail('CAPACITY');
  }
  const row = tx.put(memberId, { role, group: assignedGroup, desired: 'active', observed: 'offline', generation: 1 });
  // §4.2.4: the assignment is locked the moment the member exists.
  const workspace = tx.read(workspaceId(memberId));
  if (workspace && !workspace.lockedAt) tx.put(workspaceId(memberId), { ...workspace, lockedAt: command.now ?? null });
  return row;
}

function memberIntent(tx, command) {
  const p = command.payload;
  const args = p?.args ?? {};
  const op = typeof args.op === 'string' ? args.op : 'request';
  // §10 P0: provision and group are the autonomy package's branches, not the product's. With the switch off they are not
  // published either, and this check is what makes that true for a caller that reached the reducer by another entry: a
  // request that names one is refused here, before any row is written.
  if ((op === 'provision' || op === 'group') && command.autonomy !== 'on') {
    failWith('DENIED', 'member ' + op + ' is part of the autonomy package and the switch is off');
  }
  if (op === 'provision') return provisionIntent(tx, command, args);
  if (op === 'group') return groupIntent(tx, command, args);
  // request / freeze / resume / retire: unchanged, including the argument spread (a request may now carry a group).
  const intentRef = 'member-intent:' + p.operationId;
  const result = tx.put(intentRef, { ...args, status: 'intent', actor: command.actor });
  tx.outbox(intentRef, { kind: 'member-lifecycle', intentRef });
  return result;
}

export const memberCommands = {
  'member.create': createMember,
  'member.intent': memberIntent,
};
