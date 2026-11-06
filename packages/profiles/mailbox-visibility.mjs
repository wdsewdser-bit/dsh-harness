/** Terminal work cannot enter another snapshot. Closing its notice must not buy a wake or invent visibility. */
export function mailboxInvalidation(core, messageId, recipient, generation, now) {
  const row = core.store.read(messageId);
  if (!row) return 'missing responsibility';
  if (['resolved', 'cancelled', 'expired', 'escalated', 'dead-letter', 'unknown'].includes(row.status)) return row.status;
  if (row.entityId?.startsWith('thread-delivery:') && row.state === 'superseded') return 'superseded';
  if (row.kind === 'intent' && row.status !== 'open') return row.status ?? 'closed intent';
  const targetGeneration = row.kind === 'intent' ? row.generations?.[recipient] : row.generation;
  if (targetGeneration !== generation) return 'stale recipient generation';
  const deadline = row.kind === 'intent' ? row.closesAt : Date.parse(row.deadline);
  if (Number.isFinite(deadline) && deadline <= now) return 'expired';
  return null;
}

/** A wake is scheduling, not delivery. Only a committed request source can prove the input was carried. */
export function mailboxVisibility(core, messageId, recipient, generation) {
  const row = core.store.read(messageId);
  const evidence = row?.entityId?.startsWith('thread-delivery:') ? row.visibility
    : row?.kind === 'intent' ? row.visibility?.[recipient] : row?.observation;
  if (!evidence?.requestId || !evidence.manifestHash) return false;
  const manifest = core.store.read('manifest:' + evidence.manifestHash);
  if (!manifest || manifest.withdrawn || manifest.memberId !== recipient || manifest.generation !== generation) return false;
  const binding = manifest.messageBindings?.find(item => item.messageId === messageId && item.recipient === recipient);
  if (binding) return binding.generation === generation && binding.bindingGeneration === (row.kind === 'intent'
    ? row.bindingGenerations?.[recipient] ?? 0 : row.bindingGeneration ?? 0);
  return manifest.inputBindings?.some(item => item.ref === messageId && item.memberId === recipient &&
    item.generation === generation) ?? false;
}
