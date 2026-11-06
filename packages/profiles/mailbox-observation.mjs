/** One execution's turn observer. Every in-flight merge owns its own tentative event window. */
export function observeMailboxTurn({ listen, valid, openTurn, turnOf, tokenOf = () => null, onDone, onRelease }) {
  const windows = new Set();
  let detach, armed = false, bound = null, sawStart = false, closed = false, token = null;
  const done = () => {
    if (closed) return;
    closed = true;
    windows.clear();
    detach?.();
    onDone();
  };
  const release = () => { if (!closed) { done(); onRelease(token); } };
  const accept = event => {
    if (closed) return;
    if (event.type === 'turn/start') {
      if (bound !== null || sawStart) return;
      const turn = turnOf(event);
      token = tokenOf(event);
      if (turn !== null) bound = turn; else sawStart = true;
    } else if (event.type === 'turn/end') {
      const turn = turnOf(event);
      if (turn !== null ? turn === bound : sawStart) release();
    }
  };
  const watcher = {
    done,
    revalidate() { if (!valid()) done(); },
    begin() { if (closed) return null; const window = []; windows.add(window); return window; },
    cancel(window, uncertain = false) {
      windows.delete(window);
      // No event from the old session is needed to revoke an invalid binding.
      if (!valid() || (uncertain && !armed && windows.size === 0)) done();
    },
    arm(merge) {
      if (closed || armed) return;
      if (!valid()) { done(); return; }
      armed = true;
      token = merge.token ?? null;
      if (merge.turn !== null) bound = merge.turn;
      for (const event of merge.window ?? []) accept(event);
      windows.clear();
      if (merge.kind === 'live' && merge.turn !== null && openTurn() !== merge.turn) release();
    },
  };
  detach = listen(event => {
    if (closed) return;
    if (!valid()) { done(); return; }
    if (!['turn/start', 'turn/end'].includes(event?.type)) return;
    if (armed) accept(event);
    else for (const window of windows) window.push({ type: event.type, data: { turn: turnOf(event) }, observationToken: tokenOf(event) });
  });
  return watcher;
}
