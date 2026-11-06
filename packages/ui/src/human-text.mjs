// Display-only normalization: confirmed references plus two explicit legacy alias contracts, never arbitrary prefixes.
export function referenceIds(data, event = null) {
  const ids = new Set();
  const add = value => { if (typeof value === 'string' && value) ids.add(value); };
  for (const key of ['members', 'tasks', 'threads', 'messages', 'decisions', 'intents', 'unknownEffects',
    'approvals', 'resourceThreads', 'auditTrail', 'stopProofs']) {
    for (const row of data?.[key] ?? []) add(row.id);
  }
  for (const member of data?.members ?? []) { add(member.taskId); add(member.attempt?.id); add(member.wait?.ref); }
  add(event?.id); add(event?.subject?.id);
  for (const member of event?.members ?? []) add(member);
  return ids;
}
const COMPAT_REF = /^(?:task|int)-[0-9]+$/;
// Paths, filenames and hyphenated words are whole tokens; URLs (including query/fragment) are never rewritten.
const DISPLAY_TOKEN = /[A-Za-z][A-Za-z0-9+.-]*:\/\/\S+|[A-Za-z0-9_./:-]+/g;
export function humanText(value, fallback = '相关对象', references = []) {
  const known = references instanceof Set ? references : new Set(references);
  const text = String(value ?? '').replace(DISPLAY_TOKEN, token => {
    if (/^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(token)) return token;
    if (known.has(token) || COMPAT_REF.test(token)) return '';
    const bare = token.replace(/[.]+$/, '');
    return bare !== token && (known.has(bare) || COMPAT_REF.test(bare)) ? token.slice(bare.length) : token;
  }).replace(/\s+/g, ' ').trim();
  return text || fallback;
}
