import { id, fail } from '../../contracts/index.mjs';
import { assumptionId } from '../collab.mjs';

/**
 * Mechanism 2 as reducers: raising writes the assumption row and one ordinary durable message to the owner it names,
 * so confirmation arrives through the mailbox that owner already reads and the raiser is never blocked. Answering is
 * the owner's action, refused to everyone else, allowed once, and a correction must say what is true instead.
 *
 * This file only reads and writes the tx it is given: the message id is minted here because it is part of the fact
 * being written, and the outbox row is the durable wake, not an external call.
 */

function assumptionOwner(tx, about) {
  const row = tx.read(about);
  if (row && typeof row.owner === 'string') return row.owner;
  if (typeof about !== 'string') return null;
  if (about.startsWith('member:')) return tx.read(about) ? about : null;
  const parts = about.split(':');
  if (about.startsWith('artifact:') && parts.length >= 3) {
    const owner = 'member:' + parts[2];
    return tx.read(owner) ? owner : null;
  }
  return null;
}

function raiseAssumption(tx, command) {
  const actor = command.actor;
  const p = command.payload;
  const owner = assumptionOwner(tx, p.about);
  if (!owner) fail('UNKNOWN_ASSUMPTION_OWNER:' + p.about);
  if (owner === actor) fail('ASSUMPTION_NEEDS_ANOTHER_OWNER');
  // Named assumptionRef, not id: the module-level id() mints every other entity id in this layer.
  const assumptionRef = assumptionId(p.operationId);
  if (tx.read(assumptionRef)) fail('ID_CONFLICT:' + assumptionRef);
  const messageId = 'message:' + id('message');
  const deadline = p.deadline ?? null;
  tx.put(messageId, { sender: actor, recipient: owner, kind: 'action', summary: 'ASSUMPTION ' + assumptionRef + ': ' +
    p.claim + (p.impact ? ' | if wrong: ' + p.impact : ''), bodyRef: assumptionRef,
    generation: tx.read(owner).generation, taskRef: null, threadRef: null,
    expectedOutcome: 'confirm or correct assumption ' + assumptionRef + ' with team_assume',
    deadline, status: 'stored', stored: true, visible: false, accepted: false });
  tx.outbox(messageId, { kind: 'message', messageId });
  return tx.put(assumptionRef, { raiser: actor, owner, about: p.about, claim: p.claim, impact: p.impact ?? null,
    messageId, deadline, status: 'open', raisedAt: Date.now(), verdict: null, correction: null });
}

function answerAssumption(tx, command) {
  const actor = command.actor;
  const p = command.payload;
  const current = tx.read(p.assumptionId);
  if (!current) fail('UNKNOWN_ASSUMPTION:' + p.assumptionId);
  if (current.owner !== actor) fail('ASSUMPTION_NOT_YOURS:' + p.assumptionId);
  if (current.status !== 'open') fail('ASSUMPTION_ALREADY_ANSWERED:' + p.assumptionId);
  if (p.verdict === 'correct' && !p.correction) fail('CORRECTION_REQUIRED');
  return tx.put(p.assumptionId, { ...current, status: p.verdict === 'confirm' ? 'confirmed' : 'corrected',
    verdict: p.verdict, correction: p.correction ?? null, answeredAt: Date.now(), answeredBy: actor });
}

export const assumptionCommands = {
  'assumption.raise': raiseAssumption,
  'assumption.answer': answerAssumption,
};
