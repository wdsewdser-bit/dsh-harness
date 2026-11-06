// Protect only a successful durable settlement of this agent's current stream attempt, never a finish hint.
const responses = new WeakMap();
export function noteAssistantFrame(agent, frame) {
  if (!agent || !frame) return;
  if (frame.type === 'start') {
    responses.set(agent, { attemptId: frame.attemptId, turn: frame.turn, step: frame.step,
      failed: false, ended: false, complete: false });
    return;
  }
  const current = responses.get(agent);
  if (!current || current.attemptId !== frame.attemptId || current.ended) return;
  if (frame.type === 'chunk' && frame.chunk?.type === 'finish' && ['error', 'aborted'].includes(frame.chunk.reason?.kind)) {
    current.failed = true;
  }
  if (frame.type !== 'end') return;
  current.ended = true;
  const outcome = frame.outcome;
  if (current.failed || outcome?.kind !== 'committed' || outcome.eventType !== 'assistant/message' || !Number.isInteger(outcome.seq)) return;
  // End is published AFTER this exact append commits. Check the referenced row: interrupted prefixes can also commit
  // assistant/message, and a message from an earlier attempt in the same turn/step is not this attempt's settlement.
  const event = agent.session?.snapshotEvents?.().findLast(row => row.seq === outcome.seq);
  current.complete = event?.type === 'assistant/message' && event.data?.turn === current.turn &&
    event.data?.step === current.step && !event.data?.interrupted;
}
export function hasCompletedResponse(agent) {
  const phase = agent.phase, response = responses.get(agent);
  return phase?.kind === 'running' && !!response && response.turn === phase.turn && response.step === phase.step && response.complete === true;
}
