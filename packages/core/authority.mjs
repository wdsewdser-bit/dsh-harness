import { fail, failWith } from '../contracts/index.mjs';
import { leaseOf } from './commands/lease.mjs';

/**
 * P1 of the team-autonomy design (docs/decisions/team-autonomy-design.md §3.2.2, §9.2): who may say what.
 *
 * The product's permission test has been "the principal is the string operator" in five places. This file is the one
 * replacement for the two entries P1 opens -- the owner path (§3) and the decision row (§2) -- and it is a predicate
 * over committed rows, never a name: an owner is a member row whose role is root and whose lifecycle state is active.
 * An execution authority is still exactly leaseOf(): attempt, fence, generation, active member. Nothing here is
 * inferred from a request.
 *
 * The selector (`command.policy.authority`) is written by the trusted entry beside the payload, exactly like
 * `payload.policy` in commands/messages.mjs and mailbox.mjs, so a request body can never name a stronger authority
 * than the entry it came through selected (§2.2.5, §3.2.5: "请求体伪造 policy" must not work).
 */

const DEFAULT_DECISION_TTL_MS = 900000;

/** The effective autonomy switch and its tunables, read off the core the profile built (§10 P0). */
export function autonomySettings(core) {
  const configuration = core?.configuration ?? {};
  const ttl = configuration.decisionTtlMs;
  return { autonomy: configuration.autonomy === 'on' ? 'on' : 'off',
    decisionTtlMs: Number.isSafeInteger(ttl) && ttl >= 60000 && ttl <= 86400000 ? ttl : DEFAULT_DECISION_TTL_MS };
}
export const autonomyOn = core => autonomySettings(core).autonomy === 'on';

/**
 * The owner binding (§3.2.1), resolved from the row that is the team's owner.
 *
 * No attempt is invented for it: fence, lease and expiry are execution facts, and a fabricated attempt would put the
 * generation and the revocation of a lease under the owner's control. The generation compared against a message row is
 * the member row's own, which is what sendMessage bound the responsibility to in the first place.
 */
export function ownerBindingOf(tx, actor) {
  const member = tx.read(actor);
  if (!member || member.role !== 'root' || member.desired !== 'active') return null;
  return Object.freeze({ kind: 'owner', principal: 'owner', memberId: actor, generation: member.generation ?? 1 });
}

/**
 * The operator principal: the one actor authenticated by the caller that has no member row (§2.2.5, §12 U7).
 *
 * This is not a second way to spell "root": a member row that happens to be named operator is refused here (the row
 * check), so the operator channel is exactly the principal the host authenticated, and it stays open beside the owner
 * path -- the decision channel keeps the human exit even when root adjudicates (§12 U7).
 */
export function operatorBindingOf(tx, actor) {
  if (actor !== 'operator' || tx.read(actor)) return null;
  return Object.freeze({ kind: 'operator', principal: 'operator', memberId: 'operator', generation: null });
}

/** The live execution binding: the same lease rule every leased write has always used (commands/lease.mjs). */
export function executionBindingOf(tx, payload) {
  const attempt = leaseOf(tx, payload.attemptId, payload.fence);
  return Object.freeze({ kind: 'execution', principal: 'execution', memberId: attempt.owner, attemptId: attempt.entityId,
    generation: attempt.generation, fence: attempt.fence });
}

/**
 * Resolve the authority a command selected. A command with no selection is not an authority question this file
 * answers: it is DENIED, and the callers below keep their legacy default for exactly that reason.
 */
export function resolveAuthority(tx, command, { operator = false } = {}) {
  const selected = command?.policy?.authority;
  if (selected === 'owner') {
    const owner = ownerBindingOf(tx, command.actor);
    if (!owner) {
      failWith('DENIED', 'the owner authority is the team owner member row (role root, active); ' +
        String(command.actor) + ' is not it');
    }
    return owner;
  }
  if (selected === 'execution') return executionBindingOf(tx, command.payload ?? {});
  if (selected === 'operator' && operator) {
    const principal = operatorBindingOf(tx, command.actor);
    if (!principal) {
      failWith('DENIED', 'the operator channel is the caller-authenticated operator principal; ' +
        String(command.actor) + ' is a team member, not the operator');
    }
    return principal;
  }
  fail('DENIED');
}

/**
 * The authority a message write runs under.
 *
 * With no selection the call is the execution path it has always been -- leaseOf with the payload's attempt and
 * fence -- so every existing caller (the tool translator, TeamCore.accept, a host adapter) keeps its exact refusals
 * and its exact writes. Only the owner path is new, and it is selected by the trusted entry alone.
 */
export function messageAuthority(tx, command) {
  const selected = command?.policy?.authority;
  if (selected === 'owner') {
    // §10 P1 constraint: the owner path is a new behaviour, so it exists only while the package is switched on. With
    // the switch off this file answers exactly what it answered before it existed: nothing.
    if (command.autonomy !== 'on') {
      failWith('DENIED', 'the owner authority is part of the autonomy package and the switch is off');
    }
    return resolveAuthority(tx, command);
  }
  if (selected !== undefined && selected !== 'execution') fail('DENIED');
  return executionBindingOf(tx, command.payload ?? {});
}

/** The authority a decision verdict runs under: the owner path, or the operator channel kept beside it (§12 U7). */
export function decisionAuthority(tx, command) {
  const selected = command?.policy?.authority;
  if (command.autonomy !== 'on') {
    failWith('DENIED', 'the decision channel is part of the autonomy package and the switch is off');
  }
  if (selected !== 'owner' && selected !== 'operator') {
    failWith('DENIED', 'decision.decide needs an owner or operator authority selected by the trusted entry; got ' +
      JSON.stringify(selected ?? null));
  }
  return resolveAuthority(tx, command, { operator: true });
}
