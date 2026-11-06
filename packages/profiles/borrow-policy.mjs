import { randomUUID } from 'node:crypto';
import { ControlStore, BORROW_STORE_VERSION } from '../store/index.mjs';
import { acquireOwnership, canonicalTeamDir } from '../host/index.mjs';
import { digest, canonical, assertProtocolSupported, assertPolicyCompatible, teamPolicyRow, failWith } from '../contracts/index.mjs';

const refuse = detail => failWith('MIGRATION_REQUIRED', detail);
const policyId = teamId => 'team-policy:' + teamId;
const summaryKeys = ['version','from','to','reason','cutoffSeq','externalStopProof','archived','hostStopped','admissionStopped'];
const summaryValue = row => Object.fromEntries(summaryKeys.map(key => [key, row[key]]));
const command = (store, teamId, operationId, payload) => ({ entityId: policyId(teamId), teamId,
  actor: 'adapter', expectedRevision: store.read(policyId(teamId))?.revision ?? 0,
  operationId, payload, payloadHash: digest(payload) });

function validateHistory(store, teamId, policy) {
  if (store.list('team-policy:').some(row => row.entityId !== policyId(teamId) || row.teamId !== teamId)) {
    failWith('POLICY_MISMATCH', 'policy belongs to another team');
  }
  if (!policy) {
    if (canonical(store.version()) === canonical(BORROW_STORE_VERSION)) failWith('POLICY_MISMATCH', 'borrow reader floor without policy');
    return;
  }
  if (canonical(store.version()) !== canonical(BORROW_STORE_VERSION)) failWith('POLICY_MISMATCH', 'missing permanent borrow reader floor');
  if (policy.migrationRef !== null) {
    const summary = store.read(policy.migrationRef);
    if (!summary || summary.teamId !== teamId || summary.version !== 1 || summary.to !== policy.superagentBorrow ||
        summary.hostStopped !== true || summary.admissionStopped !== true ||
        typeof summary.externalStopProof !== 'string' || !summary.externalStopProof.trim() ||
        !['off','v1'].includes(summary.from) || summary.from === summary.to || !Array.isArray(summary.archived) ||
        typeof summary.reason !== 'string' || !summary.reason.trim() ||
        !Number.isSafeInteger(summary.cutoffSeq) || summary.cutoffSeq < 0 || summary.cutoffSeq > store.latestEventSeq()) failWith('POLICY_MISMATCH', 'missing/invalid migration summary');
    // A plausible row is not evidence: authenticate the exact summary against its atomic operation receipt.
    const operationId = policy.migrationRef.startsWith('borrow-migration:') ? policy.migrationRef.slice('borrow-migration:'.length) : '';
    const receipt = store.receiptOf(command(store, teamId, operationId, { to: summary.to, reason: summary.reason }))?.receipt;
    if (!receipt || receipt.result?.migrationRef !== policy.migrationRef || receipt.result.from !== summary.from ||
        receipt.result.to !== summary.to || receipt.result.summaryDigest !== digest(summaryValue(summary))) {
      failWith('POLICY_MISMATCH', 'migration summary does not match its committed receipt');
    }
  } else {
    // Null is earned only by the first commit in a pristine database, never by rewriting an old policy.
    let initial;
    for (const event of store.scanEvents()) { initial = event; break; }
    if (policy.superagentBorrow !== 'v1' || policy.revision !== 1 || initial?.entity !== policyId(teamId) ||
        !initial.operationId.startsWith('v1:operation:initial-policy-') || canonical(initial.payload) !== canonical(policy)) {
      failWith('POLICY_MISMATCH', 'initial policy has no pristine creation evidence');
    }
  }
}

/** Under host ownership, before recovery/listeners/admission. Absence is not emptiness. */
export function initializeBorrowPolicy(store, teamId, protocol) {
  const policy = store.read(policyId(teamId));
  assertPolicyCompatible(policy, protocol);
  validateHistory(store, teamId, policy);
  if (policy || protocol === 'off') return policy;
  const c = command(store, teamId, 'v1:operation:initial-policy-' + randomUUID(), { protocol });
  return store.commit(c, tx => {
    if (!tx.isPristine()) refuse('legacy history requires a saved quiescent migration');
    tx.requireBorrowReader();
    return tx.put(policyId(teamId), teamPolicyRow(teamId, { superagentBorrow: protocol,
      activatedAt: new Date().toISOString(), migrationRef: null }));
  }).result;
}

function inspect(tx, teamId) {
  const rows = tx.list(), blocked = [];
  const check = (name, list) => { if (list.length) blocked.push(name + ':' + list.length); };
  check('foreign-team', rows.filter(r => r.teamId && r.teamId !== teamId));
  check('execution', rows.filter(r => r.entityId.startsWith('attempt:') && !['released','revoked'].includes(r.lease)));
  check('run-slots', tx.runSlots());
  check('effect', tx.effects().filter(r => !['confirmed','cancelled','dead-letter'].includes(r.status)));
  check('control', rows.filter(r => r.entityId.startsWith('control-slot:') && r.state !== 'released'));
  check('io', rows.filter(r => r.entityId.startsWith('effect-io:') && r.state !== 'released'));
  // M2b and v1 intents are MESSAGE rows, never intent:<id>. Do not force-close windows or approve objections.
  check('intent', rows.filter(r => r.entityId.startsWith('message:') && r.kind === 'intent' &&
    (r.protocol === 'root-decision-v1'
      ? !['approved','rejected','revision-requested'].includes(r.status)
      : r.status !== r.decision || !['passed','objected'].includes(r.decision) ||
        (r.decision === 'objected' && !(r.waivers ?? []).some(w => w.contractRevision === r.contractRevision && tx.read(w.decisionRef)?.state === 'decided' && tx.read(w.decisionRef)?.verdict?.option === 'waive')))));
  check('member-unknown', rows.filter(r => r.entityId.startsWith('member:') && (r.status === 'unknown' || r.observed === 'unknown')));
  check('decision', rows.filter(r => r.entityId.startsWith('decision:') && !['decided','superseded'].includes(r.state ?? r.status)));
  check('completion', rows.filter(r => r.entityId.startsWith('completion:') && ['prepared','authorized','unknown'].includes(r.status)));
  check('lifecycle', rows.filter(r => r.entityId.startsWith('member-intent:') && !['confirmed','cancelled'].includes(r.status)));
  if (blocked.length) refuse('drain under the old protocol first: ' + blocked.join('; '));
  return { rows, head: tx.latestEventSeq() };
}

/** Offline deployment API, not a model/UI command. OS ownership stops admission, NOT external IO.
 * The trusted verifier must independently prove termination for this exact journal head, in either direction.
 * No backups, TTL releases, caller booleans or implicit protocol changes. Same operationId replays after COMMIT crash.
 */
export async function migrateBorrowPolicy({ root, teamId, to, operationId, reason, verifyQuiescence, hooks = {} }) {
  if (!['off','v1'].includes(to) || typeof teamId !== 'string' || !teamId || typeof reason !== 'string' || !reason.trim()) refuse('name team, target protocol and reason');
  if (to === 'v1') assertProtocolSupported({ superagentBorrow: 'v1', intentSemantics: 'root-decision-v1' });
  root = canonicalTeamDir(root);
  ControlStore.preflight(root);
  const ownership = await acquireOwnership({ root });
  let store, primaryError;
  try {
    store = new ControlStore(root, hooks);
    const payload = { to, reason }, c = command(store, teamId, operationId, payload);
    const replay = store.receiptOf(c);
    if (replay?.conflict) failWith('ID_CONFLICT', 'migration retry differs');
    if (replay?.receipt) return replay.receipt;
    const before = store.read(policyId(teamId));
    assertPolicyCompatible(before, before?.superagentBorrow ?? 'off');
    validateHistory(store, teamId, before);
    if ((before?.superagentBorrow ?? 'off') === to) refuse('not a protocol transition');
    const first = inspect(store, teamId);
    if (!first.rows.some(r => r.teamId === teamId)) refuse('team identity has no durable history');
    if (typeof verifyQuiescence !== 'function') refuse('independent external termination verifier required');
    const proof = await verifyQuiescence(Object.freeze({ root, teamId, cutoffSeq: first.head, from: before?.superagentBorrow ?? 'off', to }));
    if (proof?.terminated !== true || proof.root !== root || proof.teamId !== teamId || proof.cutoffSeq !== first.head ||
        proof.from !== (before?.superagentBorrow ?? 'off') || proof.to !== to ||
        typeof proof.evidenceRef !== 'string' || !proof.evidenceRef.trim()) refuse('missing/stale external stop proof');
    return store.commit(c, tx => {
      if (!ownership.verify().ok) refuse('ownership lost');
      const facts = inspect(tx, teamId);
      if (facts.head !== first.head) refuse('history changed while verifying termination');
      const migrationRef = 'borrow-migration:' + operationId, archived = [];
      if (to === 'off') for (const row of facts.rows) {
        const resource = row.entityId.startsWith('thread:') && row.kind === 'resource';
        const sub = row.entityId.startsWith('thread-subscription:');
        const delivery = row.entityId.startsWith('thread-delivery:') && ['pending','unknown'].includes(row.state);
        if (resource || sub || delivery) {
          tx.put(row.entityId, { ...row, ...(resource ? { status: 'closed' } : { state: delivery ? 'superseded' : 'closed' }), archivedBy: migrationRef });
          archived.push(row.entityId);
        }
      }
      const summary = { version: 1, from: before?.superagentBorrow ?? 'off', to, reason,
        cutoffSeq: facts.head, externalStopProof: proof.evidenceRef, archived, hostStopped: true, admissionStopped: true };
      tx.put(migrationRef, summary);
      tx.requireBorrowReader();
      tx.put(policyId(teamId), teamPolicyRow(teamId, { superagentBorrow: to, activatedAt: new Date().toISOString(), migrationRef }));
      return { migrationRef, from: before?.superagentBorrow ?? 'off', to, archived: archived.length, summaryDigest: digest(summary) };
    });
  } catch (error) {
    primaryError = error;
    throw error;
  } finally {
    const cleanupErrors = [];
    for (const close of [() => store?.close(), () => ownership.release()]) {
      try { await close(); } catch (error) { cleanupErrors.push(error); }
    }
    if (cleanupErrors.length) {
      if (primaryError) primaryError.cleanupErrors = cleanupErrors;
      else throw cleanupErrors[0];
    }
  }
}
