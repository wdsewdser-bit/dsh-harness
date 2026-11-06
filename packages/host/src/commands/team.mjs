import { failWith } from '../../../contracts/index.mjs';

/**
 * Team envelope commands; M1b design §4.1.
 *
 * The team envelope is the only place a team's identity and its directory aliases live. External callers always use
 * (teamId, memberId); member:root is a local field of the envelope, never a standalone writable identity.
 *
 * team.alias is how the "one canonical directory, many spellings" rule reaches durable state: an alias key can belong
 * to exactly one team, and the reducer refuses a second claim instead of silently re-pointing it.
 */
const TEAM_PREFIX = 'team:';

const aliasKey = dir => (typeof dir === 'string' ? dir.replace(/[\\/]+$/, '').toLowerCase() : '');

export const teamCommands = Object.freeze({
  'team.create': {
    kind: 'business',
    reduce(tx, current, payload) {
      if (typeof payload.teamId !== 'string' || !payload.teamId) failWith('INVALID_TEAM', 'team.create needs a teamId');
      if (current && current.status === 'ready') {
        // Idempotent by construction: the same team id cannot be created twice with a different owner.
        if (current.ownerSessionId !== payload.ownerSessionId) failWith('TEAM_ALREADY_OWNED', 'team ' + payload.teamId + ' is owned by ' + current.ownerSessionId);
        return current;
      }
      const alias = aliasKey(payload.dir);
      return tx.put(payload.entityId, {
        teamId: payload.teamId,
        ownerSessionId: payload.ownerSessionId ?? null,
        ownerMemberId: payload.ownerMemberId ?? 'root',
        status: 'ready',
        aliases: alias ? [alias] : [],
      });
    },
  },
  'team.alias': {
    kind: 'business',
    reduce(tx, current, payload) {
      if (!current) failWith('UNKNOWN_TEAM', 'team.alias needs an existing team envelope');
      const key = aliasKey(payload.dir);
      if (!key) failWith('INVALID_ROOT', 'team.alias needs a non-empty directory');
      if (current.aliases.includes(key)) return current;
      const clash = tx.list(TEAM_PREFIX).find(team => team.entityId !== current.entityId && (team.aliases ?? []).includes(key));
      if (clash) failWith('TEAM_ALIAS_TAKEN', 'directory ' + key + ' is already an alias of ' + clash.teamId);
      return tx.put(current.entityId, { ...current, aliases: [...current.aliases, key] });
    },
  },
  'team.member.bind': {
    kind: 'business',
    reduce(tx, current, payload) {
      if (!current) failWith('UNKNOWN_TEAM', 'team.member.bind needs an existing team envelope');
      if (typeof payload.memberId !== 'string' || !payload.memberId) failWith('INVALID_MEMBER', 'team.member.bind needs a memberId');
      const members = { ...(current.members ?? {}) };
      const generation = (members[payload.memberId]?.generation ?? 0) + 1;
      members[payload.memberId] = { generation, executionSessionId: payload.executionSessionId ?? null };
      return tx.put(current.entityId, { ...current, members });
    },
  },
  'team.archive': {
    kind: 'business',
    reduce(tx, current, payload) {
      if (!current) failWith('UNKNOWN_TEAM', 'team.archive needs an existing team envelope');
      return tx.put(current.entityId, { ...current, status: 'archived', reason: payload.reason ?? null });
    },
  },
});
