-- Every non-exact match outcome (and upstream errors) for later review.
CREATE TABLE IF NOT EXISTS misses (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  source_key TEXT NOT NULL,
  service TEXT NOT NULL,
  outcome TEXT NOT NULL CHECK (outcome IN ('fuzzy', 'search', 'error')),
  source_title TEXT,
  source_artist TEXT,
  source_duration_ms INTEGER,
  candidate_title TEXT,
  candidate_artist TEXT,
  candidate_duration_ms INTEGER,
  score REAL,
  note TEXT
);
CREATE INDEX IF NOT EXISTS misses_created_at ON misses (created_at);
CREATE INDEX IF NOT EXISTS misses_source_key ON misses (source_key);
