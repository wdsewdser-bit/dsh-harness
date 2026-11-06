/**
 * Host half of the Team client plugin (08 §1.2): it never touches server stores.
 *
 * Runtime source injection. With no config (or `source: 'mock'`) it is inert and the browser half
 * uses the mock source. With `source: 'http'` it publishes the real-source config into the index page
 * as `globalThis.__DSH_TEAM__` via the web server's structured `webserver/index-inject` table:
 *   { source: 'http', base: 'http://127.0.0.1:40292', token: <projection bearer>, viewer: 'member:root' }
 * The index page is only served after native web login (unauthenticated requests get 401), so the
 * projection token is handed over behind the native authentication instead of being baked into the
 * public bundle or typed into sessionStorage. `viewer` is the principal the token maps to in the
 * projection session registry (the envelope has no viewer field yet).
 *
 * Loaded only by the team web profile; the default profile does not list this entry.
 */
export const name = 'dsh-v2-client-team';
const GLOBAL = '__DSH_TEAM__';

export function apply(ctx, config = {}) {
  if (!config || config.source !== 'http') return;
  const base = String(config.base ?? '');
  if (!/^http:\/\/127\.0\.0\.1:\d+$/.test(base)) throw Error('client-team: http source must be a loopback origin');
  if (typeof config.token !== 'string' || config.token.length < 16) throw Error('client-team: projection token missing');
  if (config.viewer != null && !(typeof config.viewer === 'object' && typeof config.viewer.teamId === 'string' && /^member:\S+$/.test(config.viewer.memberId)) && !/^member:\S+$/.test(config.viewer)) throw Error('client-team: viewer must be a bound composite identity');
  const value = { source: 'http', base, token: config.token, viewer: config.viewer ?? null };
  ctx.on('webserver/index-inject', table => { table.push({ kind: 'global', name: GLOBAL, value }); });
}
