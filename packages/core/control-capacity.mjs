import { fail, hash } from '../contracts/index.mjs';
import { providerCapacity, providerWait } from './provider-capacity.mjs';

// All allocation decisions are made on the deciding transaction, never on a status snapshot.
export const borrowCapacityOn = core => core.configuration?.superagentBorrow === 'v1';
const live = row => ['held', 'unknown'].includes(row.state);
const attempts = tx => tx.list('attempt:').filter(a => ['active', 'unknown'].includes(a.lease));
export const controlSlotId = (teamId, holderRef) => 'control-slot:' + teamId + ':' + holderRef;
export function capacityUsage(tx) {
  const runs = attempts(tx), slots = tx.list('control-slot:').filter(live);
  // A mailbox slot is an index, not a second occupancy.
  const owners = slots.filter(s => s.holderKind === 'owner-request');
  const normal = runs.filter(a => a.capacityLane !== 'human').length + owners.filter(s => s.lane === 'normal').length;
  const human = runs.filter(a => a.capacityLane === 'human').length + owners.filter(s => s.lane === 'human').length;
  const unknown = owners.filter(s => s.state === 'unknown').length + runs.filter(a=>a.lease==='unknown').length + tx.list('effect-io:').filter(s => s.state === 'unknown').length;
  return { normal, human, unknown, runs, slots };
}
export function assertCapacity(tx, lane, maxRuns) {
  const used = capacityUsage(tx);
  if (used.unknown) fail('CAPACITY_UNKNOWN');
  if (used[lane] >= (lane === 'human' ? 1 : maxRuns)) fail('CAPACITY');
}
export function humanOrigin(tx, ref, recipient) {
  const row = typeof ref === 'string' && ref.startsWith('human-input:') ? tx.read(ref) : null;
  return ['owner-user-input','authenticated-viewer'].includes(row?.authenticatedEntry) && row.recipient === recipient &&
    ['message','status','decision'].includes(row.purpose) && row.ownerSessionId ? row : null;
}
export function messageHumanOrigin(tx, message) {
  if(!message?.humanOriginRef || !tx)return null;
  const origin = humanOrigin(tx, message.humanOriginRef, message.recipient);
  return origin && [origin.messageRef,origin.forwardedMessageRef].includes(message?.entityId) && origin.generation === message.generation ? origin : null;
}
// Only the authenticated host entry calls this reducer. No public/model command mints human-input rows.
export function mintHumanInput(tx, { teamId, authenticatedEntry, ownerSessionId, recipient, operationId, purpose, bodyRef, now }) {
  if (!teamId || !authenticatedEntry || !ownerSessionId || !operationId || !['message','status','decision'].includes(purpose)) fail('DENIED');
  const member = tx.read(recipient);
  if (member?.desired !== 'active' || ['unknown','cancel-pending','dispose-pending'].includes(member.status)) fail('NOT_READY');
  const ref = 'human-input:' + hash(JSON.stringify({teamId, operationId}));
  const prior = tx.read(ref);
  if (prior) fail('ID_CONFLICT');
  return tx.put(ref, { teamId, authenticatedEntry, ownerSessionId, recipient, operationId, purpose, bodyRef:bodyRef ?? ref,
    generation:member.generation, createdAt:now, queuedAt:tx.latestEventSeq()+1, state:'pending', messageRef:null });
}
export function queuedHumans(tx) {
  return tx.list('human-input:').filter(o => o.state === 'pending' && tx.read(o.recipient)?.desired === 'active' &&
    tx.read(o.recipient)?.generation === o.generation && !['create-pending','resume-pending','cancel-pending','dispose-pending','unknown'].includes(tx.read(o.recipient)?.status) &&
    !attempts(tx).some(a => a.owner === o.recipient) &&
    (() => { const m=tx.read(o.messageRef); return m && !m.visible && !['resolved','cancelled','expired','unknown'].includes(m.status); })())
    .sort((a,b) => a.queuedAt-b.queuedAt || a.entityId.localeCompare(b.entityId));
}
export function mailboxOrigin(tx, task) {
  return queuedHumans(tx).find(o=>o.recipient===task.owner) ?? null;
}
export function allocateMailbox(tx, { teamId, attemptId, origin, hostEpoch = null }) {
  if (queuedHumans(tx)[0]?.entityId !== origin.entityId) fail('CAPACITY');
  tx.put(controlSlotId(teamId,attemptId), {lane:'human',holderKind:'mailbox-attempt',holderRef:attemptId,hostEpoch,
    state:'held',originRef:origin.entityId});
  tx.put(origin.entityId,{...origin,state:'allocated',holderRef:attemptId});
}
export function acquireOwnerControl(tx, { teamId, binding, holderRef, originRef, now }) {
  if (!binding || binding.teamId !== teamId || binding.kind !== 'owner' || binding.memberId !== 'member:root' ||
      !binding.routed || binding.ownerSessionId!==binding.sessionId || !binding.ownerSessionId || !binding.epoch ||
      tx.read('member:root')?.role!=='root' || tx.read('member:root')?.desired!=='active' || tx.read('member:root')?.generation !== binding.generation) fail('DENIED');
  const key=controlSlotId(teamId,holderRef), prior=tx.read(key);
  if(prior) fail('CAPACITY');
  const human=humanOrigin(tx,originRef,'member:root'), decision=tx.read(originRef);
  if (human) {
    if (human.state !== 'pending' || queuedHumans(tx)[0]?.entityId !== originRef) fail('CAPACITY');
  } else {
    if (decision?.kind !== 'coordination' || decision.state !== 'open' || decision.openedFor !== 'member:root') fail('DENIED');
    if (queuedHumans(tx).length) fail('CAPACITY');
    const pending=tx.list('decision:').filter(d=>d.kind==='coordination'&&d.state==='open'&&d.openedFor==='member:root'&&
      !tx.read(d.subject?.id)?.visibility?.['member:root']).sort((a,b)=>(a.binding?.requestSeq??0)-(b.binding?.requestSeq??0));
    if(pending[0]?.entityId!==originRef)fail('CAPACITY');
  }
  assertCapacity(tx,'human',0);
  const row=tx.put(key,{lane:'human',holderKind:'owner-request',holderRef,hostEpoch:binding.epoch,state:'held',originRef,
    binding,callIdentity:holderRef,startedAt:now});
  if(human)tx.put(originRef,{...human,state:'allocated',holderRef});
  tx.put('execution-outcome:'+holderRef,{kind:'owner-control',controlSlotRef:key,callIdentity:holderRef,hostEpoch:binding.epoch,
    state:'applying',originRef,at:now});
  return row;
}
export function settleOwnerControl(tx, { slotRef, callIdentity, hostEpoch, terminal = false, evidenceRef = null, reason = null, now, requireLive = false }) {
  const slot=tx.read(slotRef);
  if(slot?.holderKind !== 'owner-request' || slot.callIdentity !== callIdentity || slot.hostEpoch !== hostEpoch)fail('DENIED');
  if(slot.state === 'released'){if(requireLive)fail('ALREADY_RELEASED');return slot;}
  const row=tx.put(slotRef,{...slot,state:terminal?'released':'unknown',evidenceRef,reason,settledAt:now});
  tx.put('execution-outcome:'+callIdentity,{kind:'owner-control',controlSlotRef:slotRef,callIdentity,hostEpoch,
    state:terminal?'terminated':'unknown',evidenceRef,reason,at:now});
  return row;
}
export function recoverControlCapacity(tx, now) {
  let count=0;
  for(const s of tx.list('control-slot:'))if(live(s)&&s.holderKind==='owner-request'){
    settleOwnerControl(tx,{slotRef:s.entityId,callIdentity:s.callIdentity,hostEpoch:s.hostEpoch,now,reason:'host recovery; transport termination unproven'});count++;
  }
  for(const s of tx.list('effect-io:'))if(live(s))tx.put(s.entityId,{...s,state:'unknown',reason:'host recovery; external IO unproven'});
  return count;
}
export function capacityStatus(core, now=Date.now()) {
  const used=capacityUsage(core.store), q=queuedHumans(core.store);
  const decisions=core.store.list('decision:').filter(d=>d.kind==='coordination'&&d.state==='open'&&!core.store.read(d.subject?.id)?.visibility?.['member:root']);
  const normalQueue=core.store.list('task:').filter(t=>t.status==='ready');
  const blocked=core.store.list('human-input:').filter(o=>o.state==='pending'&&!q.some(h=>h.entityId===o.entityId)&&
    !used.runs.some(a=>a.owner===o.recipient)&&!core.store.read(o.messageRef)?.visible).map(o=>({originRef:o.entityId,recipient:o.recipient,
      reason:core.store.read(o.recipient)?.generation!==o.generation?'generation-changed':'recipient-unavailable'}));
  const age=rows=>rows.length?Math.max(0,now-Math.min(...rows.map(r=>r.createdAt??now))):null;
  // Gap 3: the provider classification is read from its own durable observation; the queue counts below stay local.
  const provider=providerCapacity(core.store,now);
  return {normal:{current:used.normal,limit:core.configuration.maxRuns,unknown:used.runs.filter(a=>a.capacityLane!=='human'&&a.lease==='unknown').length,queued:normalQueue.length,oldestAge:age(normalQueue)},
    human:{current:used.human,limit:1,unknown:used.slots.filter(s=>s.lane==='human'&&s.state==='unknown').length,queued:q.length+decisions.length,oldestAge:age([...q,...decisions])},
    unknown:used.unknown,admissionClosed:used.unknown>0,queued:q.length,blocked,
    oldestAge:q.length?Math.max(0,now-q[0].createdAt):null,occupants:used.slots.map(s=>({ref:s.entityId,originRef:s.originRef,
      holderRef:s.holderRef,state:s.state,lane:s.lane})),providerCapacity:provider.state,
    providerWait:providerWait(provider,normalQueue.length+q.length+decisions.length>0),
    providerRetryAfterMs:provider.retryAfterMs,providerRecoveryAt:provider.recoveryAt};
}
// Only message/wake ports with a durable, target-bound minted origin can use I. A label on start/delivery is inert.
export function effectTrafficClass(store, effect) {
  const p=effect.payload??{};
  if(!['message','wake'].includes(p.kind)||p.trafficClass!=='human')return 'normal';
  const m=store.read(p.messageId), origin=messageHumanOrigin(store,m);
  return origin && origin.entityId===p.originRef && (!p.recipient||p.recipient===m.recipient) &&
    (!p.targetKind || (p.targetKind==='owner' && m.recipient==='member:root')) ? 'human':'normal';
}
