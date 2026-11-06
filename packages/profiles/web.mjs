import fs from 'node:fs';
/**
 * Use the official authenticated-page injection; no generated client package.
 *
 * Three knobs exist so one description covers both hosts the acceptance run needs, and each default keeps the
 * published patch byte-identical to the single-token profile it has always produced:
 *   port     projection service port (the default 40292).
 *   sessions projection token -> principal. Omitted, the single root token is the only principal.
 *   client   whether this host injects the browser half. It defaults to `team`, so the default (non-team) profile
 *            still gets an empty insert; passing `team:false, client:true` yields a read-only viewer host that
 *            points at another host's projection service instead of starting one of its own.
 *   origins  extra browser origins the projection gateway accepts besides this host's own page. The gateway answers
 *            CORS for exactly the declared set (never "*"), so a second host that reads this projection has to be named
 *            here or the browser refuses its preflight.
 *   pricing  the price table this host's projection may price a delegation with (P9). Omitted, the entry carries no
 *            pricing key at all and the projection answers exactly what it answered before the option existed.
 */
export function webOverlay(root, { token, team = true, port = 40292, sessions = null, viewer = null, client = team, origins = null, pricing = null } = {}) {
  fs.mkdirSync(root, { recursive: true });
  const entries = [];
  if (team) {
    entries.push({ id: 'team-runtime', name: new URL('./team-plugin.mjs', import.meta.url).href, config: { root } },
      { id: 'projections', name: new URL('./projections-plugin.mjs', import.meta.url).href,
        config: { port, sessions: sessions ?? { [token]: 'member:root' }, ...(origins ? { origins } : {}),
          ...(pricing ? { pricing } : {}) } });
  }
  if (client) entries.push({ id: 'client-team', name: new URL('../ui/index.mjs', import.meta.url).href,
    config: { source: 'http', base: 'http://127.0.0.1:' + port, token, ...(viewer ? { viewer } : {}) } });
  const file = root + '/team.patch.json'; fs.writeFileSync(file, JSON.stringify([{ insert: entries }])); return file;
}
