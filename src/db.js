import { Database as CoreDatabase } from '@atc-web/atc-service-core/db';

/** SQLite connection with schema migrations applied on open. */
export class Database extends CoreDatabase {
  static MIGRATIONS = [
    `
    CREATE TABLE queues (
      name             TEXT PRIMARY KEY,
      description      TEXT NOT NULL DEFAULT '',
      visibility_sec   INTEGER NOT NULL,
      max_attempts     INTEGER NOT NULL,
      backoff_base_sec INTEGER NOT NULL,
      backoff_max_sec  INTEGER NOT NULL,
      paused           INTEGER NOT NULL DEFAULT 0,
      created_by       TEXT NOT NULL,
      created_at       INTEGER NOT NULL,
      updated_at       INTEGER NOT NULL
    );

    -- An acked message is deleted; dead letters stay (state 'dead') until redriven, purged or expired.
    CREATE TABLE messages (
      seq          INTEGER PRIMARY KEY AUTOINCREMENT,
      id           TEXT NOT NULL UNIQUE,
      queue        TEXT NOT NULL REFERENCES queues(name) ON DELETE CASCADE,
      body         TEXT NOT NULL,
      priority     INTEGER NOT NULL DEFAULT 0,
      dedupe_key   TEXT,
      state        TEXT NOT NULL CHECK (state IN ('ready', 'leased', 'dead')),
      attempts     INTEGER NOT NULL DEFAULT 0,
      available_at INTEGER NOT NULL,
      lease_token  TEXT,
      lease_until  INTEGER,
      last_error   TEXT,
      enqueued_by  TEXT NOT NULL,
      enqueued_at  INTEGER NOT NULL,
      dead_at      INTEGER
    );
    CREATE INDEX messages_ready ON messages (queue, state, priority DESC, available_at, seq);
    CREATE INDEX messages_lease ON messages (state, lease_until);
    CREATE UNIQUE INDEX messages_dedupe ON messages (queue, dedupe_key) WHERE dedupe_key IS NOT NULL;

    -- Lifetime counters per queue (enqueued, acked, nacked, dead-lettered, redriven).
    CREATE TABLE counters (
      queue TEXT NOT NULL REFERENCES queues(name) ON DELETE CASCADE,
      name  TEXT NOT NULL,
      value INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (queue, name)
    );
    `,
  ];
}
