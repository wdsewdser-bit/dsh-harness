// Context-owned metadata and CAS evidence; 08 §2.2, §3.3.
export const CONTEXT_SCHEMA = `
  PRAGMA journal_mode=WAL;
  PRAGMA synchronous=FULL;
  PRAGMA foreign_keys=ON;
  PRAGMA busy_timeout=5000;

  CREATE TABLE IF NOT EXISTS manifests (
    ref TEXT PRIMARY KEY,
    sha TEXT,
    bytes INTEGER,
    callId TEXT,
    revision INTEGER DEFAULT 0,
    terminalAt INTEGER,
    retainUntil INTEGER,
    pinned INTEGER DEFAULT 1,
    state TEXT DEFAULT 'published'
  );

  CREATE TABLE IF NOT EXISTS grants (
    ref TEXT,
    session TEXT,
    agent TEXT,
    PRIMARY KEY(ref, session, agent)
  );

  CREATE TABLE IF NOT EXISTS operations (
    id TEXT PRIMARY KEY,
    payloadHash TEXT,
    revision INTEGER
  );

  CREATE TABLE IF NOT EXISTS policy_decisions (
    id TEXT PRIMARY KEY,
    source TEXT,
    reason TEXT
  );

  CREATE TABLE IF NOT EXISTS events (
    seq INTEGER PRIMARY KEY AUTOINCREMENT,
    entity TEXT,
    revision INTEGER,
    operationId TEXT UNIQUE,
    schemaVersion INTEGER,
    payloadHash TEXT
  );

  CREATE TABLE IF NOT EXISTS acl (
    ref TEXT PRIMARY KEY,
    ownerSession TEXT,
    ownerAgent TEXT
  );

  CREATE TABLE IF NOT EXISTS pins (
    ref TEXT,
    kind TEXT,
    sourceId TEXT,
    PRIMARY KEY(ref, kind, sourceId)
  );
`;
