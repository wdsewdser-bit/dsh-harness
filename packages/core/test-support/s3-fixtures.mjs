// §5 of the super-agent borrow design (P3): one input model, one arbiter, one bounded batch, one wake edge.
//
// The cases run offline against a real control store. The core is configured v1 so the S3 code paths are exercised as
// they will run once the protocol can boot; the composition root still refuses to activate v1 (pinned below). The
// legacy arm keeps its own tests (preempt.test.mjs, wake-contract) and this file asserts it is still what a default
// team runs.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ControlStore } from '../../store/index.mjs';
import { createHumanInputGateway } from '../../host/index.mjs';
import { TeamCore, drain } from '../index.mjs';
import { pendingInputs, orderedInputs, INPUT_KINDS, publicBinding, HUMAN_SLOTS } from '../inputs.mjs';
import { batchCandidate, BATCH_TEXT_LIMIT, renderBatchText, payloadDigest } from '../snapshot.mjs';
import { hash } from '../../contracts/index.mjs';
import { batchPreStep, recordBatchInjection, requestBoundaryBatch, advanceThreadWatermark, verifyInputBinding } from '../provenance.mjs';
import { MemberInputArbiter, PreemptWatcher, inputPolicy } from '../preempt.mjs';
import { BORROW_IMPLEMENTATION_STAGES, ROOT_DECISION_SEMANTICS, assertProtocolSupported } from '../../contracts/index.mjs';


export const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../runs');
export const codeOf = fn => { try { fn(); return null; } catch (error) { return error.code ?? String(error.message); } };
export const bytes = text => Buffer.byteLength(text) * 2;

/** A v1 team: the two roles S3 needs, a task for the attempt-free owner and one member with a bound agent. */
export function team(label, overrides = {}) {
  fs.mkdirSync(root, { recursive: true });
  const dir = fs.mkdtempSync(path.join(root, 's3-borrow-' + label + '-'));
  const store = new ControlStore(dir);
  const core = new TeamCore(store, { enabled: true }, { enabled: true, collab: 'on', autonomy: 'on',
    superagentBorrow: 'v1', intentSemantics: ROOT_DECISION_SEMANTICS, intentWindowMs: 1000,
    repositories: [{ repositoryKey: 'repo:acme/app', root }], ...overrides });
  core.member('member:root', 'root');
  core.member('member:be', 'worker', 'A');
  core.member('member:qa', 'verifier', 'V');
  core.task('task:be', 'member:be', []);
  core.task('task:root', 'member:root', []);
  let operations = 0;
  return { dir, store, core,
    op: name => 'v1:operation:s3-' + label + '-' + name + '-' + String(++operations).padStart(3, '0'),
    close() { try { core.store.close?.(); } catch {} fs.rmSync(dir, { recursive: true, force: true }); } };
}

/** A directed message; an action/decision names the responsibility it asks for, as the reducer requires. */
export const send = (t, sender, recipient, kind, summary, extra = {}) => t.core.send(sender, recipient, kind, summary,
  kind === 'info' ? extra : { expectedOutcome: extra.expectedOutcome ?? 'ack',
    ...(kind === 'intent' ? {} : { deadline: new Date(Date.now() + 60000).toISOString() }), ...extra });

export const humanSend=(t,summary)=>createHumanInputGateway({core:t.core,teamId:'team',ownerSessionId:'owner',
  authenticate:c=>c===humanCredential?{teamId:'team',ownerSessionId:'owner',authenticatedEntry:'owner-user-input'}:null})
  .send({operationId:t.op('human'),recipient:'member:be',purpose:'message',summary},humanCredential);
export const humanCredential=Object.freeze({});
export const openResource = (t, actor, resource) => {
  const issueId = 'thread:' + t.op('resource');
  return t.core.dispatch(issueId, actor, { issueId, resource },
    { type: 'thread.open-resource', payload: { issueId, resource, descriptionRef: 'artifact:desc:1' } }).result;
};
export const subscribe = (t, actor, issueId, extra = {}) => t.core.dispatch('thread-op:' + t.op('subscribe'), actor,
  { issueId, ...extra }, { type: 'thread.subscribe', payload: { issueId, ...extra } }).result;
export const publish = (t, actor, issueId, summary) => t.core.dispatch('thread-op:' + t.op('publish') + ':' + summary, actor,
  { issueId, summary }, { type: 'thread.publish', payload: { issueId, eventType: 'change-reported', summary,
    operationId: t.op('event') } });
export const deliveries = (t, threadRef) => t.store.list('thread-delivery:' + threadRef + ':');

/** A port pair good enough for one pre-step: serial access and a native injection with real evidence. */
export function ports(counter = { n: 0 }) {
  return { serialize: work => work(),
    async inject() { counter.n += 1; return { messageId: 'native:' + counter.n, sourceEventSeqs: ['seq:' + counter.n],
      generation: null }; } };
}

