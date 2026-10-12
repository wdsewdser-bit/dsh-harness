// Shared non-provider fixtures for v14 focused tests.
export function makeTask(overrides = {}) {
  return {
    id: 'task-v14-fixture', revision: 1, subject: 'fixture task', status: 'pending',
    phase: 'execution', ownerName: 'member', lifecycle: 'execution',
    writeScopes: ['reports/v14'], blockedBy: [], ...overrides,
  }
}

export function makeRoomState(overrides = {}) {
  return {
    version: 1, revision: 1, rooms: {}, transcripts: {}, cursors: {},
    roundSummaries: {}, unresolved: {}, decisions: {}, inbox: {}, wakes: {},
    stopEpisodes: {}, sequence: {}, events: [], ...overrides,
  }
}
