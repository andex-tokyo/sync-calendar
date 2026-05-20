CREATE TABLE IF NOT EXISTS oauth_tokens (
  id TEXT PRIMARY KEY,
  access_token TEXT NOT NULL,
  refresh_token TEXT,
  expires_at INTEGER NOT NULL,
  scope TEXT,
  token_type TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE IF NOT EXISTS sync_state (
  calendar_id TEXT PRIMARY KEY,
  sync_token TEXT,
  last_full_sync_at TEXT,
  last_incremental_sync_at TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE IF NOT EXISTS event_pairs (
  pair_id TEXT PRIMARY KEY,
  calendar_a_event_id TEXT,
  calendar_b_event_id TEXT,
  last_synced_hash_a TEXT,
  last_synced_hash_b TEXT,
  last_synced_updated_a TEXT,
  last_synced_updated_b TEXT,
  status TEXT NOT NULL DEFAULT 'active',
  deleted_a_at TEXT,
  deleted_b_at TEXT,
  last_seen_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_event_pairs_a
ON event_pairs(calendar_a_event_id)
WHERE calendar_a_event_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_event_pairs_b
ON event_pairs(calendar_b_event_id)
WHERE calendar_b_event_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_event_pairs_status ON event_pairs(status);
CREATE INDEX IF NOT EXISTS idx_event_pairs_last_seen ON event_pairs(last_seen_at);

CREATE TABLE IF NOT EXISTS sync_locks (
  name TEXT PRIMARY KEY,
  owner TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE IF NOT EXISTS sync_runs (
  id TEXT PRIMARY KEY,
  trigger_type TEXT NOT NULL,
  status TEXT NOT NULL,
  started_at TEXT NOT NULL,
  finished_at TEXT,
  message TEXT,
  stats_json TEXT NOT NULL DEFAULT '{}'
);
