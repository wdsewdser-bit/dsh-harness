import http from 'node:http';
/** Serve authenticated loopback snapshots/replay and command gateway; 08 §5. */
export async function serve(projection, command, { port = 40292, sessions, origin = 'http://127.0.0.1:40291', origins = null, heartbeatMs = 2000 }) {
  if (port < 40290 || port > 40299) throw Error('PORT_SCOPE');
  // Allowed browser origins. The read-only viewer host talks to this gateway from its own page, so one origin is not
  // enough and a wildcard is not acceptable: the set is exactly what the profile declared. A request without an Origin
  // header is not a browser cross-origin request (curl, a server-side client) and is served exactly as before.
  const allowed = new Set([origin, ...(origins ?? [])]);
  const streams = new Set();
  const failure = error => ({ error: error.code ?? error.message,
    ...(error.code === 'RESYNC_REQUIRED' ? { resync: true, snapshot: '/team/projection/snapshot',
      checkpointEpoch: error.checkpointEpoch, replayAfterSeq: error.replayAfterSeq, asOfSeq: error.asOfSeq } : {}) });
  const server = http.createServer(async (req, res) => {
    const json = (status, value) => { res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(JSON.stringify(value)); };
    try {
      const from = req.headers.origin;
      if (from && !allowed.has(from)) return json(403, { error: 'ORIGIN_DENIED' });
      // Echo only the origin that was actually declared, so a response header can never widen the allowed set.
      if (from) { res.setHeader('access-control-allow-origin', from); res.setHeader('vary', 'origin');
        res.setHeader('access-control-expose-headers', 'x-projection-replay-after-seq'); }
      res.setHeader('access-control-allow-headers', 'authorization, content-type, last-event-id');
      res.setHeader('access-control-allow-methods', 'GET, POST, OPTIONS');
      // A preflight never carries the bearer token (browsers do not send credentials on it), so it is answered before
      // authentication. It grants nothing: the actual request still has to authenticate.
      if (req.method === 'OPTIONS') { res.writeHead(204, { 'access-control-max-age': '600' }); return res.end(); }
      const actor = sessions.get(req.headers.authorization?.replace(/^Bearer /, ''));
      if (!actor) return json(401, { error: 'AUTH_REQUIRED' });
      const url = new URL(req.url, 'http://127.0.0.1');
      if (req.method === 'GET' && url.pathname === '/team/projection/snapshot') {
        const snapshot = projection.snapshot(actor);
        const boundary = projection.replayBoundary?.();
        if (boundary) res.setHeader('x-projection-replay-after-seq', String(boundary.replayAfterSeq));
        return json(200, snapshot);
      }
      if (req.method === 'GET' && url.pathname === '/team/projection/stream') {
        let known = projection.snapshot(actor).data;
        let seq = Number(req.headers['last-event-id'] ?? url.searchParams.get('afterSeq') ?? 0);
        const checkpointEpoch = url.searchParams.has('checkpointEpoch') ? Number(url.searchParams.get('checkpointEpoch')) : null;
        projection.events(actor, seq, {limit:1, checkpointEpoch});
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' });
        res.flushHeaders(); res.write(': connected\n\n');
         let lastWrite = Date.now();
         const pump = () => {
          try {
            if (sessions.get(req.headers.authorization?.replace(/^Bearer /, '')) !== actor) return res.destroy();
            if(res.writableNeedDrain)return;
            const events = projection.events(actor, seq, {limit:projection.recentLimit, checkpointEpoch});
            const current = projection.snapshot(actor).data;
            if (events.length) {
              const last = events.at(-1);
              for (const key of ['members', 'tasks', 'threads', 'messages', 'unknownEffects', 'approvals',
                 ...(known.resourceThreads || current.resourceThreads ? ['resourceThreads'] : [])]) {
                last.removes[key] = [...new Set([...(last.removes[key] ?? []), ...(known[key] ?? []).filter(row => !(current[key] ?? []).some(r => r.id === row.id)).map(r => r.id)])];
              }
            }
            for (const event of events) { res.write('id: ' + event.seq + '\ndata: ' + JSON.stringify(event) + '\n\n'); seq = event.seq; }
            if (events.length) lastWrite = Date.now();
             if (Date.now() - lastWrite >= heartbeatMs) { res.write(': heartbeat ' + Date.now() + '\n\n'); lastWrite = Date.now(); }
             known = current;
          } catch (error) {
            res.write('event: ' + (error.code === 'RESYNC_REQUIRED' ? 'resync' : 'error') + '\ndata: ' + JSON.stringify(failure(error)) + '\n\n');
            res.end();
          }
        };
        const timer = setInterval(pump, 20);
        streams.add(res); res.on('close', () => { clearInterval(timer); streams.delete(res); });
        pump(); return;
      }
      // M6 P2: which team a session belongs to (null = this session has no team). Never a cross-team lookup: the
      // projection only knows its own rows, so another team's session can only answer null here.
      if (req.method === 'GET' && url.pathname === '/team/binding') {
        return json(200, projection.binding(actor, url.searchParams.get('sessionId')));
      }
      // M6 P12: the records timeline (derived rows, bounded by the same retention as the snapshot).
      if (req.method === 'GET' && url.pathname === '/team/projection/activity') {
        const number = key => (url.searchParams.get(key) ? Number(url.searchParams.get(key)) : null);
        return json(200, projection.activity(actor, { kind: url.searchParams.get('kind') || null,
          member: url.searchParams.get('member') || null, from: number('from'), to: number('to'), afterSeq: number('afterSeq'),
          beforeSeq: number('beforeSeq'), limit: number('limit') }));
      }
      if (req.method === 'POST' && url.pathname === '/team/commands') {
        let body = ''; for await (const part of req) { body += part; if (body.length > 16384) return json(413, { error: 'TOO_LARGE' }); }
        return json(200, await command(actor, JSON.parse(body)));
      }
      json(404, { error: 'NOT_FOUND' });
    } catch (error) { if (!res.headersSent) json(error.code === 'RESYNC_REQUIRED' ? 409 : error.message === 'EVENT_GAP' ? 500 : 400, failure(error)); else res.destroy(); }
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); });
  // A projection gateway is a read surface, never the reason a process stays alive: the host that owns the team may end
  // its run without tearing the gateway down (the collaboration worker does exactly that), and it must still exit.
  server.unref?.();
  return { server, close: async () => { if (!server.listening) return; for (const stream of streams) stream.destroy(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); } };
}
