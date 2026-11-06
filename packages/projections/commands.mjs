import { authorize, confirmStopped, escalateThread, handleTool, intentProtocol, reduceCommand, submitMailbox } from '../core/index.mjs';
import { id } from '../contracts/index.mjs';

/**
 * P5 (§3.2): the UI→domain translation for resource threads.
 *
 * These names are the same commands the model's team_thread branches reach; the translation picks the domain type and
 * the trusted metadata, never a reducer of its own. The authority checks here are the gateway's half: the domain
 * reducer still checks the actor's subscription, ownership, generation and epoch inside the transaction.
 */
const RESOURCE_COMMANDS = Object.freeze(new Set(['threads.openResource', 'threads.subscribe',
  'threads.unsubscribe', 'threads.publish', 'threads.closeResource']));

function submitThreadResource(core, actor, command, operationId) {
  const args = command.args ?? {};
  const member = core.store.read(actor);
  const root = member?.role === 'root';
  // Browser principals must resolve to active members. An operator must be bound to the actual root member,
  // never promoted by a magic actor string. No execution tool, lease or privileged adapter port is exposed here.
  if (!actor?.startsWith('member:') || !member || member.desired !== 'active' ||
      !['root', 'worker', 'verifier', 'subCoordinator'].includes(member.role)) throw Error('ROLE_DENIED');
  if (!Number.isSafeInteger(command.expectedRevision) || command.expectedRevision < 0) throw Error('CAS_CONFLICT');
  const dispatch = (type, payload, cas = null) => {
    const config = core.configuration;
    const now = config.now?.() ?? Date.now();
    // execute owns replay and the completion fence. Authorization and creation CAS run in its transaction;
    // the command type is part of the operation identity, so another operation cannot reuse this receipt.
    return core.execute('thread-op:' + operationId, actor, { type, payload }, tx => {
      const currentActor = tx.read(actor);
      if (currentActor?.desired !== 'active' || !['root', 'worker', 'verifier', 'subCoordinator'].includes(currentActor?.role)) throw Error('ROLE_DENIED');
      if (type === 'thread.open-resource' &&
          (command.expectedRevision !== 0 || tx.read(payload.issueId))) throw Error('CAS_CONFLICT');
      for (const ref of [payload.taskRef, payload.bodyRef].filter(value => value != null)) {
        if (!tx.read(ref)) throw Error('MISSING_REFERENCE:' + ref);
        authorize(core, actor, ref);
      }
      // Description refs may name external documents; an existing private entity still needs reference authority.
      if (payload.descriptionRef && tx.read(payload.descriptionRef)) authorize(core, actor, payload.descriptionRef);
      return reduceCommand(tx, { type, payload, cas, actor, operationId, now,
        intentProtocol: intentProtocol(core), repositories: config.repositories ?? [], threadEventLimit: config.threadEventLimit });
    }, { operationId, now });
  };
  if (command.name === 'threads.openResource') {
    const owner = args.owner ?? actor;
    if (owner !== actor && !root) throw Error('ROLE_DENIED');
    const issueId = typeof command.target === 'string' && command.target.startsWith('thread:')
      ? command.target : 'thread:' + operationId;
    const payload = { issueId, resource: args.resource, descriptionRef: args.descriptionRef,
      owner: args.owner ?? null, taskRef: args.taskRef ?? null };
    const receipt = dispatch('thread.open-resource', payload);
    return { operationId, status: 'accepted', revision: receipt.result?.revision ?? null,
      entityId: receipt.result?.entityId ?? issueId };
  }
  const current = core.store.read(command.target);
  if (!current) throw Error('UNKNOWN_THREAD');
  if (current.kind !== 'resource') throw Error('WRONG_THREAD_KIND');
  if (!Number.isSafeInteger(command.expectedRevision) || command.expectedRevision < 0) throw Error('CAS_CONFLICT');
  // A member may act for itself only; a principal bound to the actual root may name another member. The reducer rechecks this, and a member
  // cannot borrow root by putting a memberId in the request body.
  if (args.memberId !== undefined && args.memberId !== actor && !root) throw Error('ROLE_DENIED');
  const cas = { ref: command.target, revision: command.expectedRevision, message: 'CAS_CONFLICT' };
  let type, payload;
  if (command.name === 'threads.subscribe') {
    type = 'thread.subscribe'; payload = { issueId: command.target, memberId: args.memberId ?? null,
      replayFrom: args.replayFrom ?? null };
  } else if (command.name === 'threads.unsubscribe') {
    type = 'thread.unsubscribe'; payload = { issueId: command.target, memberId: args.memberId ?? null,
      reason: args.reason };
  } else if (command.name === 'threads.publish') {
    type = 'thread.publish'; payload = { issueId: command.target, eventType: args.eventType,
      summary: args.summary, bodyRef: args.bodyRef === '' ? null : args.bodyRef ?? null, operationId: operationId };
  } else if (command.name === 'threads.closeResource') {
    type = 'thread.close-resource'; payload = { issueId: command.target, reason: args.reason };
  } else {
    throw Error('UNSUPPORTED_COMMAND');
  }
  dispatch(type, payload, cas);
  // The CAS target is the thread, not the operation entity: report the revision the browser should use next.
  return { operationId, status: 'accepted', revision: core.store.read(command.target)?.revision ?? null,
    entityId: command.target };
}

/** Translate UI intent into existing authorized role commands; 08 §1.2, §4.10. */
/**
 * Translate a browser request into the existing authorized entry.
 *
 * `ports.reconcile` is the delivery write half (host's submitDeliveryReconciliation). It arrives as a port because
 * projections may read core and store but never depend on delivery (§2.2 matrix); a command that needs it without a
 * port is refused instead of silently reaching across the graph.
 */
export function submit(core, actor, command, ports = {}) {
  const operationId = command.operationId ?? id('operation');
  try {
    if (RESOURCE_COMMANDS.has(command.name)) return submitThreadResource(core, actor, command, operationId);
    // Operator-only stop confirmation (13 §1: the gateway had no entry for it at all). Refused before any row is read,
    // so a member can learn nothing from the CAS answer, and the browser never holds this authority (§6 #12).
    if (command.name === 'organization.confirmStopped' && actor !== 'operator') throw Error('ROLE_DENIED');
    const current = core.store.read(command.target);
    authorize(core, actor, command.target);
    if (!current || !Number.isSafeInteger(command.expectedRevision) || command.expectedRevision < 0) throw Error('CAS_CONFLICT');
    // CAS belongs inside commit: durable operation replay must precede checking an old revision.
    command = { ...command, operationId };
    const common = { operationId, expectedRevision: command.expectedRevision };
    let name; let args;
    if (command.name === 'organization.requestFreeze' || command.name === 'organization.requestResume' || command.name === 'organization.retire') {
      name = 'team_member'; args = { ...common, op: command.name === 'organization.retire' ? 'retire' : command.name.endsWith('Freeze') ? 'freeze' : 'resume', memberRef: command.target, reason: command.args.reason ?? 'UI request' };
    } else if (command.name === 'threads.decide') {
      name = 'team_thread'; args = { ...common, op: 'decide', issueId: command.target, proposalRevision: command.args.proposalRevision, conclusionRef: command.args.conclusionRef };
    } else if (command.name === 'mailbox.send') {
      if (command.target !== command.args.recipient) throw Error('TARGET_RECIPIENT_MISMATCH');
      name = 'team_message'; args = { ...common, op: 'send', to: command.args.recipient, kind: command.args.kind, summary: command.args.summary ?? command.args.body,
        ...(command.args.kind !== 'info' ? { deadline: new Date(Date.now() + command.args.deadlineMin * 60000).toISOString(), expectedOutcome: command.args.expectedOutcome } : {}) };
    } else if (command.name === 'scheduler.approveContract') {
      // UI approval is root/operator only, not a delegated coordinator approval.
      if (!['operator', 'root'].includes(actor) && core.store.read(actor)?.role !== 'root') throw Error('ROLE_DENIED');
      name = 'team_plan'; args = { ...common, op: 'approve', taskRef: command.target, contractRevision: command.args.contractRevision };
    } else if (command.name === 'organization.confirmStopped') {
      // The core keeps both channels unchanged: the operator closes on any non-empty evidence reference, the adapter on
      // a verified stop-proof row (core/effects.mjs). Only the operator channel is reachable here, and the browser
      // authenticates as a member, so no logged-in viewer can submit it. (§6 #12)
      const evidenceRef = command.args?.evidenceRef;
      if (typeof evidenceRef !== 'string' || !evidenceRef.trim()) throw Error('EVIDENCE_REQUIRED');
      // Pass both request metadata fields into the existing transaction. Its receipt replay precedes request CAS
      // and lease-state admission, so an old revision retries the same durable operation rather than closing again.
      const receipt = confirmStopped(core, command.target, evidenceRef, actor, common);
      return { operationId, status: 'accepted', revision: receipt.revision,
        entityId: command.target };
    } else if (command.name === 'delivery.reconcile') {
      if (typeof ports.reconcile !== 'function') throw Object.assign(Error('RECONCILE_PORT_MISSING'), { code: 'RECONCILE_PORT_MISSING' });
      const result = ports.reconcile(core, actor, command);
      return { operationId, status: 'accepted', revision: result.revision, entityId: command.target };
    } else if (command.name === 'mailbox.cancelMessage' || command.name === 'mailbox.rebind' || command.name === 'mailbox.resolveUnknown' || command.name === 'threads.escalate') {
      const result = command.name === 'threads.escalate' ? escalateThread(core, actor, command) : submitMailbox(core, actor, command);
      return { operationId, status: 'accepted', revision: result.revision, entityId: command.target };
    } else throw Error('UNSUPPORTED_COMMAND');
    // The revision the browser read travels with the command and is checked by the shared reducer inside the same
    // transaction: no commit wrapper, and a stale revision rolls back the whole write.
    const result = handleTool(core, { actor }, name, args,
      // The browser-facing conflict message stays the bare code HEAD's commit proxy threw; the model tool path keeps
      // the ref-suffixed code it always had (docs/decisions/M2a-shared-reducer.md §7-9).
      { cas: { ref: command.target, revision: command.expectedRevision, message: 'CAS_CONFLICT' } });
    return { operationId, status: 'accepted', revision: result.result?.entityId === command.target ? result.result.revision : command.expectedRevision, entityId: command.target };
  } catch (error) { return { operationId, status: error.code === 'RECEIPT_COMPACTED' ? 'compacted' : error.message.includes('CAS_CONFLICT') ? 'conflict' : 'rejected', revision: null, entityId: command.target, message: error.message }; }
}
