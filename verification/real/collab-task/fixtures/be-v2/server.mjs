import http from 'node:http';
import { pathToFileURL } from 'node:url';

export const DEFAULT_TAG_COLOR = '#cccccc';

// Requirement change: a tag carries a colour. A tag posted without one still comes back with the default colour,
// so the response shape never depends on what the caller happened to send.
export function normalizeTags(tags) {
  if (!Array.isArray(tags)) return [];
  return tags.map(tag => {
    const name = typeof tag === 'string' ? tag : String(tag && tag.name ? tag.name : '');
    const color = tag && typeof tag === 'object' && tag.color ? String(tag.color) : '';
    return { name, color: /^#[0-9a-fA-F]{6}$/.test(color) ? color.toLowerCase() : DEFAULT_TAG_COLOR };
  }).filter(tag => tag.name);
}

export function createStore() {
  let serial = 0;
  const rows = new Map();
  return {
    create(input) { const id = 'todo-' + (++serial);
      const row = { id, title: String(input && input.title ? input.title : ''), done: false, tags: normalizeTags(input && input.tags) };
      rows.set(id, row); return row; },
    list() { return [...rows.values()]; },
    get(id) { return rows.get(id) || null; },
    update(id, patch) { const row = rows.get(id); if (!row) return null;
      if (typeof patch?.done === 'boolean') row.done = patch.done;
      if (typeof patch?.title === 'string') row.title = patch.title;
      if (patch && patch.tags !== undefined) row.tags = normalizeTags(patch.tags);
      return row; },
    remove(id) { return rows.delete(id); },
  };
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('error', reject);
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8');
      if (!text) return resolve({});
      try { resolve(JSON.parse(text)); } catch (error) { reject(error); }
    });
  });
}

function send(res, status, value) {
  const body = value === undefined ? '' : JSON.stringify(value);
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(body);
}

export function createServer(store = createStore()) {
  return http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url || '/', 'http://localhost');
      const parts = url.pathname.split('/').filter(Boolean);
      if (parts[0] !== 'api' || parts[1] !== 'todos') return send(res, 404, { error: 'not found' });
      if (parts.length === 2 && req.method === 'POST') return send(res, 201, store.create(await readBody(req)));
      if (parts.length === 2 && req.method === 'GET') return send(res, 200, store.list());
      if (parts.length === 3) {
        const id = decodeURIComponent(parts[2]);
        if (req.method === 'GET') { const row = store.get(id); return row ? send(res, 200, row) : send(res, 404, { error: 'unknown todo' }); }
        if (req.method === 'PATCH') { const row = store.update(id, await readBody(req)); return row ? send(res, 200, row) : send(res, 404, { error:
          'unknown todo' });
          }
        if (req.method === 'DELETE') { if (!store.remove(id)) return send(res, 404, { error: 'unknown todo' }); res.writeHead(204); return res.end(); }
      }
      return send(res, 405, { error: 'method not allowed' });
    } catch (error) {
      send(res, 400, { error: String(error?.message ?? error) });
    }
  });
}

export function start(options = {}) {
  const server = createServer();
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.port ?? 0, '127.0.0.1', () => resolve({ server, url: 'http://127.0.0.1:' + server.address().port }));
  });
}

const isMain = process.argv[1] ? import.meta.url === pathToFileURL(process.argv[1]).href : false;
if (isMain) { const started = await start({ port: Number(process.env.PORT || 0) }); console.log(started.url); }
