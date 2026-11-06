// §3 of the super-agent borrow design (P1): resource threads, thread events and the root-decision intent.
//
// Every case runs offline against a real control store: the shared reducer, the clock, the core entries and the read
// model, with no provider and no host. The core is configured v1 (superagentBorrow 'v1' + intentSemantics
// 'root-decision-v1') so the S1 reducers are exercised as they will run once the protocol can boot; the composition
// root still refuses to activate v1, which the first case pins. The legacy arm keeps its own tests (collab-protocol)
// and this file only asserts that it is still the one a default team runs.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ControlStore } from '../../store/index.mjs';
import { TeamCore } from '../index.mjs';
import { handleTool } from '../tools.mjs';
import { unresolvedDecisionThreads } from '../goal-gate.mjs';
import { readThreadEvents, resourceThreadView, threadRetention } from '../thread-events.mjs';
import { coordinationBlock } from '../commands/intents.mjs';
import { implementGateSummary, intentProtocol, intentState } from '../collab.mjs';
import { snapshot } from '../snapshot.mjs';
import { toolCommand } from '../tool-reducer.mjs';
import { cancelMessage } from '../mailbox.mjs';
import { BORROW_IMPLEMENTATION_STAGES, ROOT_DECISION_SEMANTICS, assertProtocolSupported, borrowReadiness,
  superagentBorrowConfig } from '../../contracts/index.mjs';


export const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../runs');
export const REPOSITORIES = ['repo:acme/app', 'repo:acme/other'];
export const future = ms => new Date(Date.now() + ms).toISOString();
export const codeOf = fn => { try { fn(); return null; } catch (error) { return error.code ?? String(error.message); } };

/** A v1 team: collab + autonomy on (the v1 preconditions), one owner, two workers and a verifier. */
export function team(label, overrides = {}) {
  fs.mkdirSync(root, { recursive: true });
  const dir = fs.mkdtempSync(path.join(root, 's1-borrow-' + label + '-'));
  const store = new ControlStore(dir);
  const core = new TeamCore(store, { enabled: true }, { enabled: true, collab: 'on', autonomy: 'on',
    superagentBorrow: 'v1', intentSemantics: ROOT_DECISION_SEMANTICS, intentWindowMs: 1000, decisionTtlMs: 600000,
    repositories: REPOSITORIES.map(repositoryKey => ({repositoryKey, root})), ...overrides });
  core.member('member:root', 'root');
  core.member('member:fe', 'worker', 'A');
  core.member('member:be', 'worker', 'A');
  core.member('member:qa', 'verifier', 'V');
  let operations = 0;
  return { dir, store, core,
    op: name => 'v1:operation:s1-' + label + '-' + name + '-' + String(++operations).padStart(3, '0'),
    close() { try { core.store.close?.(); } catch { /* already closed by a restart case */ }
      fs.rmSync(dir, { recursive: true, force: true }); } };
}

export const openResource = (t, actor, resource, extra = {}) => {
  const issueId = 'thread:' + t.op('resource');
  return t.core.dispatch(issueId, actor, { issueId, resource, ...extra },
    { type: 'thread.open-resource', payload: { issueId, resource, descriptionRef: 'artifact:desc:1', ...extra } }).result;
};
export const subscribe = (t, actor, issueId, extra = {}) => t.core.dispatch('thread-op:' + t.op('subscribe'), actor,
  { issueId, ...extra }, { type: 'thread.subscribe', payload: { issueId, ...extra } }).result;
export const unsubscribe = (t, actor, issueId, extra = {}) => t.core.dispatch('thread-op:' + t.op('unsubscribe'), actor,
  { issueId, ...extra }, { type: 'thread.unsubscribe', payload: { issueId, ...extra } }).result;
/** One publish. payload.operationId is the report identity the reducer allocates a sequence for. */
export const publishWith = (t, actor, { issueId, summary, operationId, source = null, hostEvidence = false, eventType = 'change-reported' }) =>
  t.core.dispatch('thread-op:' + operationId + ':' + t.op('meta'), actor, { issueId, summary, source },
    { type: 'thread.publish', hostEvidence, payload: { issueId, eventType, summary, operationId, source } });
export const publish = (t, actor, issueId, summary, extra = {}) => publishWith(t, actor,
  { issueId, summary, operationId: t.op('publish'), ...extra });
export const deliveries = (t, threadRef) => t.store.list('thread-delivery:' + threadRef + ':');
export const events = (t, threadRef) => t.store.list('thread-event:' + threadRef + ':');
export const forMember = (t, threadRef, memberId) => deliveries(t, threadRef).filter(row => row.memberId === memberId);

// --- §2/§10: S1 landed, and naming v1 still fails closed ---------------------------------------------------------------

export const requestCoordination = (t, actor, { taskRef, contractRevision = 1, evidenceRef = null, summary = null,
  previousDecisionId = null }) => {
  const messageId = 'message:' + t.op('intent');
  const payload = { messageId, to: 'member:root', kind: 'intent',
    summary: summary ?? 'please rule on the contract of ' + taskRef, taskRef, contractRevision,
    expectedOutcome: 'root approves, rejects or asks for a new revision',
    reason: 'the commitment this revision binds has to change', evidenceRefs: [evidenceRef ?? taskRef],
    bodyRef: 'artifact:body:1', ...(previousDecisionId ? { previousDecisionId } : {}) };
  const receipt = t.core.dispatch(messageId, actor, payload, { type: 'message.send', payload });
  return { receipt, messageId, intent: receipt.result, decisionId: receipt.result.decisionRef };
};
export const verdict = (t, decisionId, option, { actor = 'member:root', entry = 'owner' } = {}) =>
  t.core.decideDecision(decisionId, actor, { decision: option, reason: 'ruled by ' + actor, evidenceRef: null }, entry);
export const resultEffects = (t, messageId) => t.store.effects().filter(effect => effect.payload.kind === 'intent-result' &&
  effect.payload.messageId === messageId);

// --- T05 ----------------------------------------------------------------------------------------------------------------

