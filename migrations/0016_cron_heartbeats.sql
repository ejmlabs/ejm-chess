-- One row per cron schedule. A run that dies leaves started_at newer than finished_at,
-- and last_error keeps the failed stage names until a later failure replaces them.
CREATE TABLE cron_heartbeats (
  schedule TEXT PRIMARY KEY CHECK(length(schedule) BETWEEN 1 AND 64),
  started_at INTEGER NOT NULL,
  finished_at INTEGER,
  last_error TEXT CHECK(last_error IS NULL OR length(last_error)<=200),
  last_error_at INTEGER
);

-- Expired seat cleanup runs every minute and deletes by release time. Without this index
-- each pass scans the whole table.
CREATE INDEX active_seats_release_expiry ON active_game_seats(released_at);
