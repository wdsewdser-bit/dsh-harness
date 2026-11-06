/** Poll readiness without hiding a deterministic projection failure behind an old successful snapshot. */
export async function pollProjection({ url, token, deadline, alive, fetcher = fetch,
  now = Date.now, pause = () => new Promise(resolve => setTimeout(resolve, 150)), onPoll = () => {} }) {
  let snapshot = null;
  const last = { httpStatus: null, body: null, error: null, snapshotSeq: null, messageRows: null, retention: null, attempts: 0 };
  while (now() < deadline && alive()) {
    last.attempts += 1;
    try {
      const response = await fetcher(url, { headers: { authorization: 'Bearer ' + token } });
      last.httpStatus = response.status; last.body = await response.text(); last.error = null;
      let parsed;
      try { parsed = JSON.parse(last.body); }
      catch (error) { throw Object.assign(Error('INVALID_PROJECTION_RESPONSE: ' + last.body), { cause: error, fatal: true }); }
      if (!response.ok) {
        const error = Object.assign(Error(parsed.error ?? ('HTTP_' + response.status)), { code: parsed.error, fatal: response.status !== 503 });
        // EVENT_GAP is never startup/not-ready, regardless of the HTTP status a server used.
        if (parsed.error === 'EVENT_GAP' || parsed.error === 'RETENTION_INVARIANT') error.fatal = true;
        throw error;
      }
      snapshot = parsed; last.snapshotSeq = parsed.asOfSeq ?? null; last.messageRows = parsed.data?.messages?.length ?? null; last.retention = parsed
      .retention ?? null;
      onPoll({ ...last });
      if (snapshot.data?.goal?.completionToken === 'prepared') return { snapshot, last };
    } catch (error) {
      last.error = { code: error.code ?? error.cause?.code ?? null, message: error.message };
      onPoll({ ...last });
      const retryable = !error.fatal && (last.httpStatus === 503 || ['ECONNREFUSED', 'ECONNRESET', 'UND_ERR_SOCKET'].includes(last.error.code));
      if (!retryable) throw Object.assign(error, { projectionPoll: { ...last } });
    }
    await pause();
  }
  throw Object.assign(Error('PROJECTION_NOT_READY'), { projectionPoll: { ...last }, lastSnapshot: snapshot });
}
