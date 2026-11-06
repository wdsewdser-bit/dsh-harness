import { fail, failWith } from '../../contracts/index.mjs';
import { resolveAuthority } from '../authority.mjs';

/**
 * P3 of the team-autonomy design (docs/decisions/team-autonomy-design.md §5, §10): the team-level goal record.
 *
 * The chain root used to be an after-the-fact fact: `rows[0].base` of the first accepted delivery (§5.1). This file
 * is the before-the-fact one -- one row per team, written before the first task, with one initial base per
 * (directory, target) queue, because the queue key IS that pair (§5.2.1). Nothing here reads git: the host reads the
 * base back (`GoalGate.openGoal`) and the reducer validates and stores what the trusted entry proved.
 *
 * There is no `team.goal.rebase` and no reducer that rewrites `bases[].commit/tree` (§5.2.2, §9.2 rule 1). A base is
 * written once, by `open` or `addTarget`, and both refuse when the fact they would overwrite already exists.
 */

/** The goal gate's switches (§12 U5): adopt-tail is the compatibility stance, strict is the target state before M6. */
export function goalGateSettings(core) {
  const configured = core?.configuration?.goalGate ?? {};
  return Object.freeze({ strict: configured.strict === true, legacy: 'adopt-tail' });
}

/** The one team-goal entity id (§5.2.1: a single row per team). */
export const goalIdOf = core => 'team-goal:' + (core?.configuration?.teamId ?? 'team');

/** The goal row as a reducer sees it: one row per team, so the prefix is the lookup (§5.2.1). */
export const teamGoalIn = tx => tx.list('team-goal:')[0] ?? null;

/**
 * The queue key of §5.1, shared by the goal record and the chain check so both look at the same fact.
 *
 * The realpath is normalised exactly as GoalGate.evidence normalises it (lower case on win32), so a base recorded here
 * is found again by a delivery accepted later.
 */
export const queueKeyOf = (realCommonDir, target) => JSON.stringify([realCommonDir, target]);

const isHex = value => typeof value === 'string' && /^[0-9a-f]{7,64}$/i.test(value);

/**
 * Validate one base the host read back. The entry owns the readback (git rev-parse, §5.2.2: "base 由宿主读回，不接受
 * root 自报"); the reducer owns the shape, so a malformed proof is refused before it becomes a permanent row.
 */
function requireBase(entry, index) {
  const where = 'bases[' + index + ']';
  if (!entry || typeof entry !== 'object') failWith('INVALID_CONFIG', where + ' must be an object read back by the host');
  if (!entry.key || typeof entry.key.realCommonDir !== 'string' || !entry.key.realCommonDir) {
    failWith('INVALID_CONFIG', where + '.key.realCommonDir is the queue key and must be the realpath the host resolved');
  }
  if (typeof entry.key.target !== 'string' || !entry.key.target) failWith('INVALID_CONFIG', where + '.key.target is required');
  if (typeof entry.directory !== 'string' || !entry.directory) failWith('INVALID_CONFIG', where + '.directory is required');
  if (!isHex(entry.commit) || !isHex(entry.tree)) {
    failWith('INVALID_CONFIG', where + ' needs the commit and tree the host read back; a base nobody proved is not a base');
  }
  return Object.freeze({ key: Object.freeze({ realCommonDir: entry.key.realCommonDir, target: entry.key.target }),
    directory: entry.directory, target: entry.key.target, commit: entry.commit, tree: entry.tree,
    recordedAt: Number.isFinite(entry.recordedAt) ? entry.recordedAt : Date.now(), recordedBy: 'adapter',
    evidence: entry.evidence ?? null });
}

const sameBase = (left, right) => left.key.realCommonDir === right.key.realCommonDir && left.key.target === right.key.target;

/** The owner channel: the row decides, never the name (§3.2.2). */
function requireOwner(tx, command) {
  const authority = resolveAuthority(tx, command);
  if (authority.kind !== 'owner') {
    failWith('DENIED', 'the team goal is opened by the team owner; ' + String(command.actor) + ' is not it');
  }
  return authority;
}

/**
 * Open the team goal (§5.2.2). Only before the first task, and only once.
 *
 * "Before the first task" is not a convenience: a base recorded after work started is an after-the-fact chain root
 * again, which is exactly the F2 defect (§5.1) this record exists to remove. A late open is refused with
 * TEAM_GOAL_TOO_LATE and there is no path to repair it -- reopening would rewrite the basis of every existing chain.
 */
function openGoal(tx, command) {
  if (command.autonomy !== 'on') {
    failWith('DENIED', 'the team goal record is part of the autonomy package and the switch is off');
  }
  const p = command.payload ?? {};
  requireOwner(tx, command);
  if (tx.read(p.goalId)) {
    failWith('TEAM_GOAL_TOO_LATE', 'team ' + p.goalId + ' already has a goal record; an initial base is written once ' +
      '(there is no team.goal.rebase)');
  }
  const tasks = tx.list('task:').length;
  if (tasks) {
    failWith('TEAM_GOAL_TOO_LATE', 'a team goal must be opened before the first task; ' + tasks + ' task row(s) already ' +
      'exist, and a base recorded now would be an after-the-fact chain root');
  }
  // A store that already produced work cannot get a fresh root: its root is the chain that exists, and adopting it is
  // a different act with a different proof (team.goal.adopt, §5.2.4).
  const produced = tx.list('delivery:').filter(row => row.status === 'accepted').length;
  if (produced) {
    failWith('TEAM_GOAL_TOO_LATE', 'this store already has ' + produced + ' accepted delivery(ies); their chain root is ' +
      'the first of them, and adopting it is team.goal.adopt with the chains the host read back');
  }
  const bases = goalBases(p);
  return tx.put(p.goalId, { id: p.goalId, objective: p.objective, openedBy: command.actor,
    openedAt: command.now ?? Date.now(), state: 'open', bases, completionTokenRef: null });
}

const goalBases = p => {
  if (typeof p.objective !== 'string' || !p.objective.trim()) failWith('INVALID_CONFIG', 'a team goal needs an objective');
  if (!Array.isArray(p.bases) || !p.bases.length) failWith('INVALID_CONFIG', 'a team goal needs at least one initial base');
  const bases = p.bases.map(requireBase);
  for (let i = 0; i < bases.length; i++) {
    if (bases.slice(0, i).some(base => sameBase(base, bases[i]))) {
      failWith('INVALID_CONFIG', 'bases[' + i + '] repeats the queue key ' + bases[i].key.target);
    }
  }
  return bases;
};

/**
 * Adopt the chains an existing library already has (§5.2.4, §12 U5: adopt-tail).
 *
 * This is the ONLY way a base is recorded after the first task, and it is not a way for the owner to choose one: the
 * recorded base of each target must be the tail of a chain the host proved (the whole legacy chain, validated with
 * HEAD's own rule, closing exactly at the current head). A payload whose bases are not those tails, or whose chains
 * name deliveries this store does not hold as accepted, is UNVERIFIED_LEGACY_BASE -- the migration either proves
 * itself or does not happen.
 */
function adoptGoal(tx, command) {
  if (command.autonomy !== 'on') {
    failWith('DENIED', 'the team goal record is part of the autonomy package and the switch is off');
  }
  const p = command.payload ?? {};
  requireOwner(tx, command);
  if (tx.read(p.goalId)) {
    failWith('TEAM_GOAL_TOO_LATE', 'team ' + p.goalId + ' already has a goal record; an initial base is written once');
  }
  const bases = goalBases(p);
  const legacy = p.legacy;
  if (!legacy || legacy.mode !== 'adopt-tail' || !Array.isArray(legacy.chains) || !legacy.chains.length) {
    failWith('UNVERIFIED_LEGACY_BASE', 'adoption needs the chains the host read back; without them there is no tail to ' +
      'adopt and no base may be recorded');
  }
  const acceptedRows = tx.list('delivery:').filter(row => row.status === 'accepted');
  const accepted = new Set(acceptedRows.map(row => row.entityId));
  let adopted = 0;
  for (const base of bases) {
    const chain = legacy.chains.find(entry => entry.key?.realCommonDir === base.key.realCommonDir &&
      entry.key?.target === base.key.target);
    if (!chain) {
      // §5.2.4: a queue with no history is REGISTERED, not adopted. Its initial base is where the repository was when the
      // host read it back, and the one thing that can make it an after-the-fact root is a delivery accepted between that
      // readback and this commit -- which is why the check runs here, inside the transaction, and not before it.
      const produced = acceptedRows.filter(row => row.target === base.key.target &&
        String(row.directory).toLowerCase() === String(base.directory).toLowerCase());
      if (produced.length) {
        failWith('TARGET_ALREADY_HAS_DELIVERIES', base.key.target + ' accepted ' + produced.length + ' delivery(ies) ' +
          'between the base readback and this commit; a base recorded now would be an after-the-fact chain root');
      }
      continue;
    }
    adopted += 1;
    if (chain.tail?.commit !== base.commit || chain.tail?.tree !== base.tree) {
      failWith('UNVERIFIED_LEGACY_BASE', 'the recorded base of ' + base.key.target + ' is not the tail of the chain that ' +
        'was proved');
    }
    for (const row of chain.deliveries ?? []) {
      if (!accepted.has(row.deliveryId)) {
        failWith('UNVERIFIED_LEGACY_BASE', String(row.deliveryId) + ' is not an accepted delivery of this store');
      }
      if (row.chainEpoch !== 1) failWith('UNVERIFIED_LEGACY_BASE', 'an adopted delivery is chainEpoch 1');
    }
  }
  // Adoption is the act of taking over a chain that exists. With nothing to adopt -- every target is an empty queue --
  // there is no migration to record, and the empty store opens a goal instead (§5.2.4).
  if (adopted === 0) {
    failWith('TEAM_GOAL_TOO_LATE', 'adoption needs at least one accepted delivery; an empty store opens a goal instead');
  }
  return tx.put(p.goalId, { id: p.goalId, objective: p.objective, openedBy: command.actor,
    openedAt: command.now ?? Date.now(), state: 'open', bases, legacy, completionTokenRef: null });
}

/**
 * Record the initial base of one more (directory, target) queue (§5.2.2).
 *
 * Only before that key has an accepted delivery: the base of a queue that already produced is the first delivery's
 * base, and writing one now would be the same "after the fact" root the record exists to prevent.
 */
function addTarget(tx, command) {
  if (command.autonomy !== 'on') {
    failWith('DENIED', 'the team goal record is part of the autonomy package and the switch is off');
  }
  const p = command.payload ?? {};
  requireOwner(tx, command);
  const goal = tx.read(p.goalId);
  if (!goal) fail('MISSING_REFERENCE');
  if (goal.state !== 'open') failWith('TEAM_GOAL_TOO_LATE', 'the team goal is ' + goal.state + '; no base may be added');
  const base = requireBase(p.base, 0);
  if ((goal.bases ?? []).some(existing => sameBase(existing, base))) {
    failWith('TEAM_GOAL_TOO_LATE', 'this (directory, target) already has an initial base and it is never rewritten');
  }
  // The key comparison here is the row's own (directory, target): the host's readback already proved the realpath, and
  // a transaction may not stat the filesystem. A delivery accepted under another spelling of the same repository is
  // refused by the readback in GoalGate.addTarget before this reducer runs.
  const matching = tx.list('delivery:').filter(row => row.status === 'accepted' && row.target === base.key.target &&
    String(row.directory).toLowerCase() === String(base.directory).toLowerCase());
  if (matching.length) {
    failWith('TARGET_ALREADY_HAS_DELIVERIES', base.key.target + ' already has ' + matching.length + ' accepted ' +
      'delivery(ies); its chain root was the first of them, not a base recorded now');
  }
  return tx.put(goal.entityId, { ...goal, bases: [...(goal.bases ?? []), base] });
}

/**
 * Close the goal on a consumed completion (§5.2.2: the one driver).
 *
 * It is a helper as well as a command because both completion exits reach it in their own transaction (the operator
 * route in GoalGate.resolveCompletion, the decision route in commands/decisions.mjs). Idempotent: a goal already
 * closed, or one with a completion token, is left alone.
 */
export function closeGoalOnCompletion(tx, { goalId, tokenId, at = Date.now() }) {
  if (!goalId || !tokenId) return null;
  const goal = tx.read(goalId);
  if (!goal || goal.state !== 'open' || goal.completionTokenRef) return null;
  return tx.put(goalId, { ...goal, state: 'completed', completionTokenRef: tokenId, completedAt: at });
}

function closeGoal(tx, command) {
  const p = command.payload ?? {};
  const goal = tx.read(p.goalId);
  if (!goal) fail('MISSING_REFERENCE');
  const token = tx.read(p.tokenId);
  // "由 completion 收口驱动" is the whole rule: a goal is not closed by a command that says so, but by a token that
  // really reached consumed.
  if (!token || token.status !== 'consumed') {
    failWith('INVALID_ADJUDICATION', 'a team goal closes on a consumed completion token; ' + String(p.tokenId) + ' is ' +
      (token ? token.status : 'missing'));
  }
  if (goal.completionTokenRef && goal.completionTokenRef !== p.tokenId) {
    failWith('INVALID_ADJUDICATION', 'the goal was closed by ' + goal.completionTokenRef);
  }
  return closeGoalOnCompletion(tx, { goalId: goal.entityId, tokenId: p.tokenId, at: command.now ?? Date.now() });
}

export const goalCommands = {
  'team.goal.open': openGoal,
  'team.goal.adopt': adoptGoal,
  'team.goal.addTarget': addTarget,
  'team.goal.close': closeGoal,
};
