-- Seen-dedup state, moved from KV to D1 (KV free tier = 1000 put/day).
-- Retention: rows older than 30 days are deleted by a daily cleanup in service.ts.
CREATE TABLE IF NOT EXISTS seen (
  id INTEGER PRIMARY KEY,
  source TEXT NOT NULL,
  status TEXT NOT NULL,
  reason TEXT,
  ts INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_seen_ts ON seen (ts);
