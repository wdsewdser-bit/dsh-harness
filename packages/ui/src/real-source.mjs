import { createTransport } from './transport.mjs';
/** SSE comment frame (`: connected`, `: heartbeat <ms>`): liveness only, no id/data, never a business event. */
export function commentKind(frame) {
  const lines = frame.split('\n').filter(Boolean);
  if (!lines.length || !lines.every(line => line.startsWith(':'))) return null;
  return lines[0].slice(1).trim().split(/\s+/)[0] || 'comment';
}
/**
 * Real source implements the existing ProjectionSource/CommandGateway seam; 08 §5.
 * The viewer is read from the envelope/events (server-authenticated principal); `viewer` here is only an
 * optional pre-snapshot hint. Known/unknown of goal, context and approvals is read from the data itself.
 * The gateway never invents results: HTTP 4xx means the server refused before executing (rejected);
 * a transport failure is reported as unknown.
 */
export function createRealSource({ base = 'http://127.0.0.1:40292', token, viewer = null, retryMs = 100, teamId = null } = {}) {
  const { read, gateway: transportGateway } = createTransport(base, token);
  let authenticatedTeam = teamId;
  let checkpointEpoch = null;
  const gateway = {
    async submit(command) {
      try { return await transportGateway.submit(command); } catch (error) {
        const message = String(error?.message ?? error);
        const status = /HTTP 4\d\d/.test(message) ? 'rejected' : 'unknown';
        return { operationId: command.operationId ?? '—', status, revision: null, entityId: command.target, message };
      }
    },
  };
  return { source: {
    describe: () => ({ kind: 'http', label: base.replace(/^https?:\/\//, ''), viewer, heartbeat: true }),
    snapshot: async view => { const snapshot = await (await read('/team/projection/snapshot?view=' + encodeURIComponent(view))).json();
      if (snapshot.teamId) { if (snapshot.viewer?.teamId !== snapshot.teamId || (authenticatedTeam && authenticatedTeam !== snapshot.teamId)) throw Error('TEAM_IDENTITY_MISMATCH'); authenticatedTeam = snapshot.teamId; }
      checkpointEpoch = snapshot.retention?.checkpointEpoch ?? null;
      return snapshot; },
    // These endpoints return plain objects (binding may be null), not snapshot envelopes.
    binding: async sessionId => {
      if (!sessionId) return null;
      const body = await (await read('/team/binding?sessionId=' + encodeURIComponent(sessionId))).json();
      if (body !== null && (typeof body !== 'object' || typeof body.teamId !== 'string' || typeof body.memberId !== 'string')) {
        throw Error('INVALID_BINDING');
      }
      return body;
    },
    activity: async (query = {}) => {
      const params = new URLSearchParams();
      for (const key of ['kind', 'member', 'from', 'to', 'afterSeq', 'beforeSeq', 'limit']) {
        if (query[key] !== undefined && query[key] !== null) params.set(key, String(query[key]));
      }
      const body = await (await read('/team/projection/activity?' + params.toString())).json();
      if (!body || !Array.isArray(body.events) || !Number.isSafeInteger(body.asOfSeq)) throw Error('INVALID_ACTIVITY');
      return body;
    },
    subscribe(afterSeq, onEvent, onStatus, onActivity = () => {}) {
      const epoch = checkpointEpoch;
      let stopped = false; let cursor = afterSeq; let controller; let timer; let failures = 0;
      const connect = async () => {
        controller = new AbortController();
        try {
          const response = await read('/team/projection/stream?afterSeq=' + cursor + (epoch === null ? '' : '&checkpointEpoch=' + epoch), { signal: controller.signal });
          if (stopped) return; failures = 0; onStatus('open');
          const reader = response.body.getReader(); const decoder = new TextDecoder(); let buffer = '';
          while (!stopped) {
            const { value, done } = await reader.read(); if (done) break;
            buffer += decoder.decode(value, { stream: true });
            let boundary;
            while ((boundary = buffer.indexOf('\n\n')) >= 0) {
              const frame = buffer.slice(0, boundary); buffer = buffer.slice(boundary + 2);
              const comment = commentKind(frame);
              if (comment) { onActivity(comment); continue; }
              const data = frame.split('\n').find(line => line.startsWith('data: '));
              if (!data) continue;
              const event = JSON.parse(data.slice(6));
              if (event.error === 'RESYNC_REQUIRED') { onStatus('resync'); return; }
              if (authenticatedTeam && event.teamId !== authenticatedTeam) throw Error('TEAM_IDENTITY_MISMATCH');
              if (event.seq <= cursor) continue;
              if (event.seq !== cursor + 1) throw Error('STREAM_GAP');
              cursor = event.seq; onEvent(event);
            }
          }
        } catch (error) { if (stopped) return; if (error.code === 'RESYNC_REQUIRED') { onStatus('resync'); return; } }
        // Bounded backoff so a down projection service is not polled in a tight loop.
        if (!stopped) { onStatus('closed'); timer = setTimeout(connect, Math.min(5000, retryMs * 2 ** failures++)); }
      };
      connect(); return () => { stopped = true; clearTimeout(timer); controller?.abort(); };
    },
  }, gateway, control: null };
}
