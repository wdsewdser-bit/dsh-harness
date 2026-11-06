import fs from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { digest } from '../contracts/index.mjs';
import { recordReadModel } from '../core/index.mjs';
import { GATE_RATIO } from '../context/index.mjs';
/** Observe committed context policy records; never use live token-meter caches. */
export function refreshContext(core, file) {
  if (!file) return;
  let db, records = new Map(), reason = 'No committed policy record';
  try {
    if (fs.existsSync(file)) {
      db = new DatabaseSync(file, { readOnly: true });
      records = new Map(db.prepare('SELECT id, source, reason FROM policy_decisions').all().map(r => [r.id, r]));
    } else reason = 'Context database unavailable';
  } catch { reason = 'Context database unreadable'; }
  finally { db?.close(); }
  for (const member of core.store.list('member:')) {
    if (!member.nativeRef) continue;
    let source = null, decision = null;
    try { const row = records.get(member.nativeRef); if (row) { source = JSON.parse(row.source); decision = JSON.parse(row.reason); } } catch { /* malformed record is unknown, not zero */ }
    const wire = source?.wire;
    const known = Number.isFinite(wire?.I) && wire.I >= 0 && Number.isFinite(wire?.W) && wire.W > 0;
    const facts = { owner: member.entityId, sessionId: member.nativeRef, source, decision,
      status: known ? 'known' : 'unknown', reason: known ? null : source ? 'Committed policy lacks numeric input bound/window' : reason,
      context: known ? { inputTokens: wire.I, window: wire.W, limitRatio: GATE_RATIO, limitTokens: wire.W * GATE_RATIO, pct: wire.I / (wire.W * GATE_RATIO) * 100, logRevision: source.logRevision ?? null } : null };
    const key = 'context:' + member.entityId;
    const prior = core.store.read('read-model:' + key);
    if (!prior || digest(Object.fromEntries(Object.keys(facts).map(k => [k, prior[k]]))) !== digest(facts)) recordReadModel(core, key, facts);
  }
}
