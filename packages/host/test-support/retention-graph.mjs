import assert from 'node:assert/strict';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

// Independent oracle: inspect actual committed SQL, not planner metrics/closure.
export function evidenceSnapshot(root) {
  const db = new DatabaseSync(path.join(root, 'state-v2/control.sqlite'), { readOnly: true });
  try {
    return {
      entities: db.prepare('SELECT id, data FROM entities').all().map(r => ({ id: r.id, value: JSON.parse(r.data) })),
      outbox: db.prepare('SELECT id, data FROM outbox').all().map(r => ({ id: r.id, value: JSON.parse(r.data) })),
      operations: db.prepare('SELECT id, receipt FROM operations').all().map(r => ({ id: r.id, value: JSON.parse(r.receipt) })),
      events: db.prepare('SELECT seq, entity, operationId, payload FROM events ORDER BY seq').all()
        .map(r => ({ id: r.seq, entity: r.entity, value: [r.entity, r.operationId, JSON.parse(r.payload)] })),
    };
  } finally { db.close(); }
}
const strings = value => typeof value === 'string' ? [value] : value && typeof value === 'object'
  ? Object.values(value).flatMap(strings) : [];
export function assertEvidenceBatch(before, after) {
  const removed = new Set();
  for (const type of ['entities', 'outbox', 'operations']) {
    const kept = new Set(after[type].map(r => r.id));
    for (const row of before[type]) if (!kept.has(row.id)) removed.add(row.id);
  }
  const oldOps = new Map(before.operations.map(r => [r.id, r.value]));
  const rewritten = new Set(after.operations.filter(r => !oldOps.get(r.id)?.compacted && r.value.compacted).map(r => r.id));
  for (const type of Object.keys(after)) for (const row of after[type]) {
    if (type === 'operations' && row.value.compacted) continue; // replay identity/digest is not a live evidence reference
    for (const ref of strings(row.value)) {
      assert(!removed.has(ref), type + ':' + row.id + ' lost target ' + ref);
      assert(!rewritten.has(ref), type + ':' + row.id + ' names a rewritten receipt ' + ref);
    }
  }
  const latest = new Map(before.events.map(r => [r.entity, r.id]));
  const liveEvents = new Set(after.events.map(r => r.id));
  for (const row of after.entities) if (latest.has(row.id)) {
    assert(liveEvents.has(latest.get(row.id)), 'surviving entity lost newest snapshot: ' + row.id);
  }
}

