import path from 'node:path';
import { intentRowAudit } from '../../packages/core/commands/intents.mjs';

/**
 * Plan 11 section 4, counted from committed state and from disk, never from model text.
 *
 * Every number below is derived from one of three sources: the control store (messages, assumptions, decision rows),
 * the harness facts (tool calls with timestamps and results), or the files the members actually wrote. None of them
 * asks the model what it did, which is the property the plan insists on.
 */
export const collabMetricNames = ['proactiveRatio', 'helpSeekingRatio', 'assumptionsConfirmedBeforeIntegration',
  'assumptionsRaised', 'integrationFailures', 'reworkRate', 'changePropagationLatency', 'hiddenTestPass',
  'tokenCost', 'wallClock', 'snapshot'];

/** Which message kinds count as proactive collaboration, and which are help-seeking instead. */
const proactiveKinds = new Set(['intent']);
const helpKinds = new Set(['action']);

export function collabMetrics(engine) {
  const core = engine.core;
  const facts = engine.facts;
  const messages = core.store.list('message:');
  const toolCalls = facts.toolActions.filter(row => row.source === 'native-model-tool');
  const sent = messages.filter(row => row.kind !== 'info');
  // An intent is proactive by construction; an action a member sends because it is stuck is help-seeking. The
  // distinction is the kind the sender chose, which is committed state, plus whether the message answers a request
  // the member itself received (a reply to a question is not proactive).
  const intents = messages.filter(row => proactiveKinds.has(row.kind));
  const help = messages.filter(row => helpKinds.has(row.kind) && !messages.some(parent => parent.sender === row.recipient &&
    parent.recipient === row.sender));
  // The intent conclusions of host-protocol 4.4/4.5, read from the closed rows and never from "is it visible now":
  // silence is consent, so a window ends passed or objected and never escalates, and what each recipient had really
  // seen is frozen per recipient at the close. seen* counts come from seenSummary, which the close itself wrote.
  const closedIntents = intents.filter(row => row.decision);
  const withSummary = summary => intents.filter(row => row.seenSummary === summary).length;
  const intentConclusions = {
    sent: intents.length,
    open: intents.filter(row => !row.decision).length,
    passed: intents.filter(row => row.decision === 'passed').length,
    passedUnseen: intents.filter(row => row.decision === 'passed' && row.seenSummary !== 'seenAll').length,
    objected: intents.filter(row => row.decision === 'objected').length,
    escalated: intents.filter(row => row.status === 'escalated').length,
    seenAll: withSummary('seenAll'), seenPartial: withSummary('seenPartial'), seenNone: withSummary('seenNone'),
    // One frozen fact per recipient, including the ones that never saw it: a single boolean over the set is exactly
    // what 4.2 rule 7 forbids, and a missing seenAtClose entry is a defect (4.5 rule 4), not a "none".
    recipientsRecorded: closedIntents.every(row => Number.isFinite(row.closedAt) &&
      (row.recipients ?? []).every(recipient => Object.hasOwn(row.seenAtClose ?? {}, recipient))),
    // ...and the row is audited, not trusted: the summary must agree with the per-recipient flags, a "saw it" must
    // carry the evidence of a request that started inside the window, and passedUnseen must be what the frozen flags
    // say rather than what the summary happens to be.
    rowsConsistent: closedIntents.every(row => {
      const audit = intentRowAudit(row);
      return audit.summaryMatches && audit.everyRecipientFrozen && audit.evidenceMatches;
    }),
    passedUnseenConsistent: closedIntents.every(row => intentRowAudit(row).passedUnseenMatches),
  };
  const assumptions = core.store.list('assumption:');
  const integrationAt = (facts.collab.integrations ?? [])[0]?.at ?? Infinity;
  const confirmedBefore = assumptions.filter(row => ['confirmed', 'corrected'].includes(row.status) &&
    row.answeredAt !== null && row.answeredAt !== undefined && row.answeredAt <= integrationAt);
  const decisions = core.store.list('decision-log:');
  // Section 4 lists proactive messages as intent, assumption, decision and review, with help-seeking counted apart.
  // The four are all committed state: an intent is a message row, a raise is an assumption row that also stored one
  // message, a decision is a ledger row that sent nothing, and a review is a reply on a thread. The denominator is
  // therefore the messages plus the decisions, because a decision log entry is a proactive act that produced no
  // message and leaving it out of the denominator would credit it as free.
  const reviews = core.store.list('thread:').flatMap(thread => thread.replies ?? []);
  const proactiveActs = intents.length + assumptions.length + decisions.length + reviews.length;
  const catalogue = sent.length + decisions.length;
  // Rework: a member's file that was written more than once. Both writes are real files on disk, so the count is
  // about the artifact and not about a plan.
  const writes = new Map();
  for (const call of toolCalls) {
    if (!['write', 'edit'].includes(call.name)) continue;
    const rel = String(call.args?.file_path ?? '');
    const key = call.actor + ':' + path.basename(rel);
    writes.set(key, (writes.get(key) ?? 0) + 1);
  }
  const touched = [...writes.values()];
  const reworked = touched.filter(count => count > 1).length;
  const injectedAt = facts.collab.injectedAt;
  const propagation = {};
  if (injectedAt) {
    for (const ref of facts.collab.change?.affected ?? []) {
      const actor = ref.replace('member:', '');
      const first = toolCalls.filter(call => call.actor === actor && ['write', 'edit', 'bash'].includes(call.name) &&
        call.at >= injectedAt).sort((a, b) => a.at - b.at)[0];
      propagation[actor] = first ? { at: first.at, ms: first.at - injectedAt, name: first.name } : null;
    }
  }
  const tokens = (facts.requests ?? []).reduce((sum, row) => sum + (row.usage?.input ?? 0) + (row.usage?.output ?? 0), 0);
  const snapshotRows = (facts.requests ?? []).filter(row => row.snapshotTokens > 0);
  const integration = facts.collab.integrations ?? [];
  return {
    proactiveRatio: catalogue ? proactiveActs / catalogue : null,
    helpSeekingRatio: sent.length ? help.length / sent.length : null,
    proactive: { intents: intents.length, decisions: decisions.length, assumptions: assumptions.length,
      reviews: reviews.length, acts: proactiveActs, messages: sent.length, denominator: catalogue,
      helpSeeking: help.length },
    intentConclusions,
    assumptionsRaised: assumptions.length,
    assumptionsConfirmedBeforeIntegration: assumptions.length ? confirmedBefore.length / assumptions.length : null,
    assumptionsUnconfirmed: assumptions.filter(row => row.status === 'open').map(row => ({ assumptionId: row.entityId,
      about: row.about, claim: row.claim, impact: row.impact })),
    integrationFailures: integration[0]?.fail ?? null,
    integration: integration.map(row => ({ label: row.label, pass: row.pass, fail: row.fail, total: row.total,
      exitCode: row.exitCode, copied: row.copied.length, failures: row.failures })),
    reworkRate: touched.length ? reworked / touched.length : null,
    rework: { files: touched.length, reworked },
    changePropagationLatency: propagation,
    hiddenTestPass: facts.collab.hiddenTestPass ?? null,
    tokenCost: tokens, wallClock: facts.collab.wallClock ?? facts.elapsedMs ?? null,
    snapshot: snapshotRows.length ? { requests: snapshotRows.length,
      mean: snapshotRows.reduce((sum, row) => sum + row.snapshotTokens, 0) / snapshotRows.length,
      max: Math.max(...snapshotRows.map(row => row.snapshotTokens)) } : null,
    guardRefusals: (facts.guardDenials ?? []).map(row => ({ actor: row.actor, name: row.name, reason: String(row.reason).split(':')[0] })),
  };
}

/** The token and snapshot delta between the two arms, which is what the experiment is asked to report. */
export function collabDelta(off, on) {
  const note = 'B minus A, from the same scripted workload; positive means the collaboration arm cost more.';
  const delta = (a, b) => (a === null || a === undefined || b === null || b === undefined) ? null : b - a;
  return { note,
    tokenCost: delta(off?.tokenCost, on?.tokenCost),
    wallClock: delta(off?.wallClock, on?.wallClock),
    snapshotMean: delta(off?.snapshot?.mean, on?.snapshot?.mean),
    snapshotMax: delta(off?.snapshot?.max, on?.snapshot?.max),
    integrationFailures: delta(off?.integrationFailures, on?.integrationFailures),
    reworkRate: delta(off?.reworkRate, on?.reworkRate),
    hiddenTestPass: delta(off?.hiddenTestPass, on?.hiddenTestPass) };
}
