import { failWith, stopProofCovers } from '../../contracts/index.mjs';
/** An operator is authenticated by the caller, never inferred from evidence. */
export function requireOperator(actor, evidenceRef) {
 if (actor !== 'operator' || typeof evidenceRef !== 'string' || !evidenceRef) failWith('DENIED', 'operator stop evidence is required');
}
/**
 * §7.2.4: the evidence half, beside the principal half. A principal without proof is still nobody.
 *
 * `reader` is anything with `read(id)` — the control store or a transaction — so the same predicate is asked before a
 * write and inside it, and a row that does not name this exact subject (or was not written by the adapter) is refused.
 */
export function requireStopProof(reader, evidenceRef, subject) {
  const row = reader && typeof reader.read === 'function' && typeof evidenceRef === 'string' ? reader.read(evidenceRef) : null;
  if (!stopProofCovers(row, subject)) {
    failWith('DENIED', 'stop evidence ' + JSON.stringify(evidenceRef ?? null) + ' does not prove ' + JSON.stringify(subject ?? null));
  }
  return row;
}
