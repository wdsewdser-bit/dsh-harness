/** Durable observational mirror only: never participates in admission or authorization. */
export function recordReadModel(core, key, facts) {
  const entityId = 'read-model:' + key;
  return core.store.commit(core.command(entityId, 'adapter', facts), tx => tx.put(entityId, facts));
}
