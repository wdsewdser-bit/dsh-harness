/**
 * The dead-loop detector: one actor issuing the same call over and over.
 *
 * The per-turn request ceiling stops a run that never ends; this stops a run that ends every request but does the
 * same thing in each of them. Both are harness safety nets and not workload policy. A healthy turn reads, writes and
 * runs commands, so it never emits the same tool name with the same arguments six times in a row; a member that does
 * is either retrying a refusal that will never change or re-deriving an answer it already has, and every further
 * request costs tokens without buying progress. Identity is the complete argument object compared after a stable key
 * order, so two calls that differ in one character are two calls.
 */
export const loopCode = 'REPEATED_TOOL_CALL_LOOP';

const stable = value => Array.isArray(value) ? '[' + value.map(stable).join(',') + ']'
  : value && typeof value === 'object'
    ? '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + stable(value[key])).join(',') + '}'
    : JSON.stringify(value) ?? String(value);

export const callKey = (name, args) => name + '|' + stable(args ?? {});

/**
 * Count the new call against the run already open on this member's turn state, and report whether the limit is
 * reached. The state belongs to the member's current turn, so a new turn starts a new run and a loop can never be
 * assembled out of calls that a different prompt asked for.
 */
export function noteToolCall(state, name, args, limit) {
  const key = callKey(name, args);
  state.repeat = state.lastCall?.key === key ? state.lastCall.count + 1 : 1;
  state.lastCall = { key, count: state.repeat };
  return { count: state.repeat, looped: state.repeat >= limit };
}
