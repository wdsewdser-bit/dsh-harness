// P5 (§3.2, §5, §6, §9, §10 P5): the v1 projection surface, SSE deltas, retention and command authorization.
//
// Every case runs offline against the real control store and the real shared reducers. The projection is built the way
// the composition root builds it (a read-only event reader plus the protocol/capacity facts), and commands go through
// the same UI gateway the browser uses. No provider, no host turn and no second turn driver are involved.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { ControlStore } from '../../packages/store/index.mjs';
import { TeamCore, batchCandidate, recordBatchInjection } from '../../packages/core/index.mjs';
import { Projection } from '../../packages/projections/index.mjs';
import { submit } from '../../packages/projections/commands.mjs';
import { retain } from '../../packages/projections/retention.mjs';
import { serve } from '../../packages/projections/http.mjs';
import { capacityStatusSchema, inputBatchSchema, resourceThreadSchema, roleGuardStatusSchema } from '../../packages/projections/schema.mjs';

export const REPOSITORIES = Object.freeze([{ repositoryKey: 'repo:acme/app', root: process.cwd() }]);
export const future = ms => new Date(Date.now() + ms).toISOString();

/** A v1 team with the four roles the design uses; the composition root would refuse v1 today, which this suite does not
 * overcome: it builds the same core the profile will build once activation is approved. */
export function team(label, overrides = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 's5-borrow-' + label + '-'));
  const store = new ControlStore(dir);
  const core = new TeamCore(store, { enabled: true }, { enabled: true, attach: true, teamId: 'team:s5',
    collab: 'on', autonomy: 'on', superagentBorrow: 'v1', intentSemantics: 'root-decision-v1',
    decisionTtlMs: 600000, maxRuns: 2, repositories: REPOSITORIES, ...overrides });
  core.member('member:root', 'root');
  core.member('member:fe', 'worker', 'A');
  core.member('member:be', 'worker', 'A');
  core.member('member:qa', 'verifier', 'V');
  let operations = 0;
  return { dir, store, core,
    op: name => 'v1:operation:s5-' + label + '-' + name + '-' + String(++operations).padStart(3, '0'),
    close() { try { core.store.close?.(); } catch { /* already closed */ }
      fs.rmSync(dir, { recursive: true, force: true }); } };
}
export const projection = (t, options = {}) => new Projection(
  { events: seq => t.store.events(seq), scanEvents: seq => t.store.scanEvents(seq) },
  { recentLimit: 256, protocol: 'v1', maxRuns: t.core.configuration.maxRuns, ...options });

export const openResource = (t, actor, resource, extra = {}) => {
  const issueId = 'thread:' + t.op('resource');
  const receipt = submit(t.core, actor, { name: 'threads.openResource', target: issueId, expectedRevision: 0,
    operationId: t.op('open'), args: { resource, descriptionRef: 'artifact:desc:1', ...extra } });
  assert.equal(receipt.status, 'accepted', JSON.stringify(receipt));
  return receipt.entityId;
};
export const subscribe = (t, actor, threadRef, extra = {}) => {
  const receipt = submit(t.core, actor, { name: 'threads.subscribe', target: threadRef,
    expectedRevision: t.store.read(threadRef).revision, operationId: t.op('subscribe'), args: extra });
  assert.equal(receipt.status, 'accepted', JSON.stringify(receipt));
  return receipt;
};
export const publish = (t, actor, threadRef, summary, extra = {}) => {
  const receipt = submit(t.core, actor, { name: 'threads.publish', target: threadRef,
    expectedRevision: t.store.read(threadRef).revision, operationId: t.op('publish'),
    args: { eventType: 'change-reported', summary, ...extra } });
  assert.equal(receipt.status, 'accepted', JSON.stringify(receipt));
  return receipt;
};
export const legacyThread = t => t.core.dispatch('thread:legacy', 'member:fe',
  { question: 'ship it?' }, { type: 'thread.open', payload: { issueId: 'thread:legacy', owner: 'member:fe',
    requiredRespondents: ['member:be'], requiredEvidence: [], question: 'ship it?', deadline: future(600000),
    escalationOwner: 'member:root', taskRef: null } }).result;

// --- T01/T02 read side: the discriminant never leaks a resource into decision fields -------------------------------------
