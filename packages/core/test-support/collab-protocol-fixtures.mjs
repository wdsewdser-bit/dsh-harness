// Offline protocol tests for M2b: the intent window (silence is consent) and the visibility facts it freezes.
//
// Every case runs against a real control store with no provider and no host: only the shared reducer, the clock and the
// published tool surface. The normative sentences are docs/host-protocol.md §4.2–§4.5 and invariant 8; the decision
// record is docs/decisions/M2b-collab-protocol.md.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ControlStore } from '../../store/index.mjs';
import { TeamCore } from '../index.mjs';
import { handleTool } from '../tools.mjs';
import { snapshot } from '../snapshot.mjs';
import { recordInjection, requestBoundary } from '../provenance.mjs';
import { hash } from '../../contracts/index.mjs';
import { intentRowAudit } from '../commands/intents.mjs';
import { cancelMessage, rebindMessage } from '../mailbox.mjs';
import { collabSettings, intentState } from '../collab.mjs';


export const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../runs');
export const future = ms => new Date(Date.now() + ms).toISOString();

/**
 * A team on the collab arm with three admitted members.
 *
 * The intent window is large on purpose: every case here closes a window by moving the server clock past closesAt
 * (tick(closesAt + 1)), never by waiting for wall time. A one-second window made the reply/observe calls that are
 * supposed to happen *inside* the window race the clock under load — the reply then landed after closesAt and was
 * recorded as a late audit instead of an objection. The interval is a fixture constant, not a behaviour: the window
 * itself is still the server's, which the case below pins against this very constant.
 */
/**
 * 30s: far longer than any call in these cases, and shorter than the 60s attempt lease. Both halves matter: the
 * window must not close under load before a reply that is supposed to be inside it, and the tick(closesAt + 1) that
 * closes it must not jump past the attempt lease of the member that then decides or produces.
 */
export const INTENT_WINDOW_MS = 30000;

export function team(label) {
  fs.mkdirSync(root, { recursive: true });
  const dir = fs.mkdtempSync(path.join(root, 'm2b-protocol-' + label + '-'));
  const store = new ControlStore(dir);
  const core = new TeamCore(store, { enabled: true }, { enabled: true, intentWindowMs: INTENT_WINDOW_MS, collab: 'on' });
  core.member('member:fe', 'worker', 'A');
  core.member('member:be', 'worker', 'A');
  core.member('member:qa', 'verifier', 'V');
  for (const [member, role] of [['member:fe', 'fe'], ['member:be', 'be'], ['member:qa', 'qa']]) {
    core.task('task:' + role, member, []);
  }
  const attempt = {};
  for (const role of ['fe', 'be', 'qa']) attempt[role] = core.schedule('admit-' + role, 'task:' + role).result;
  core.mutate('delivery:1:fe', 'root', {}, tx => tx.put('delivery:1:fe', { taskId: 'task:fe', owner: 'member:fe' }));
  const t = { dir, store, core, attempt, operations: 0,
    fe: { actor: 'member:fe', ...pick(attempt.fe) }, be: { actor: 'member:be', ...pick(attempt.be) },
    qa: { actor: 'member:qa', ...pick(attempt.qa) },
    close() { core.store.close?.(); fs.rmSync(dir, { recursive: true, force: true }); } };
  t.op = name => 'v1:operation:m2b-' + name + '-' + String(++t.operations).padStart(3, '0');
  return t;
}
export const pick = binding => ({ attemptId: binding.attemptId, fence: binding.fence });

/** Open an intent from member:fe over a recipient set. */
export const openIntent = (t, to, { taskRef = 'task:fe', contractRevision = 1, summary = 'GET /todos returns {id,title,done}',
  outcome = 'confirm the shape or object' } = {}) => handleTool(t.core, t.fe, 'team_message',
  { operationId: t.op('intent'), op: 'send', to, kind: 'intent', summary, taskRef, contractRevision,
    expectedOutcome: outcome });

/**
 * Record that a message really was in one of this member's requests: build the snapshot page, record the injection
 * (the manifest the request carried), then write the evidence. requestedAt is when the request started.
 */
export const carry = (t, memberId, messageId, { page = 0, requestId = 'request-1' } = {}) => {
  const candidate = snapshot(t.core, memberId, null, page);
  assert(candidate.manifest.messageIds.includes(messageId), 'the injected page must carry the message');
  recordInjection(t.core, candidate, 'native:' + requestId, ['seq:' + requestId]);
  return candidate.manifest;
};

export const observe = (t, memberId, messageId, options = {}) => {
  const { requestId = 'request-1', requestedAt = Date.now() } = options;
  const manifest = carry(t, memberId, messageId, { ...options, requestId });
  return t.core.visible(messageId, { requestId, manifestHash: manifest.hash, sessionSeq: (options.page ?? 0) + 1,
    requestedAt }, memberId);
};

export const reply = (t, who, messageId, verdict, reason = null) => handleTool(t.core, t[who], 'team_message',
  { operationId: t.op('reply'), op: 'reply', messageId, verdict, ...(reason ? { reason } : {}) });

export const ledger = t => JSON.stringify({ rows: t.store.list(), events: t.store.events(), effects: t.store.effects(),
  cursors: ['scheduler', 'dispatch'].map(id => [id, t.store.cursor(id)]) });

