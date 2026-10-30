CREATE TABLE analysis_jobs (
  id TEXT PRIMARY KEY,
  game_id TEXT NOT NULL,
  result_version INTEGER NOT NULL,
  rules_version TEXT NOT NULL,
  engine_version TEXT NOT NULL,
  profile_version TEXT NOT NULL,
  priority TEXT NOT NULL CHECK(priority IN ('report','sample')),
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','running','done','dead')),
  attempts INTEGER NOT NULL DEFAULT 0 CHECK(attempts BETWEEN 0 AND 3),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  next_attempt_at INTEGER NOT NULL,
  lease_until INTEGER NOT NULL DEFAULT 0,
  summary_json TEXT CHECK(summary_json IS NULL OR (length(summary_json)<=4096 AND json_valid(summary_json))),
  last_error TEXT CHECK(last_error IS NULL OR length(last_error)<=80)
);
CREATE INDEX analysis_work ON analysis_jobs(status,next_attempt_at,priority,created_at);
CREATE INDEX analysis_game ON analysis_jobs(game_id,result_version);

CREATE TABLE analysis_daily (
  day TEXT PRIMARY KEY,
  attempts INTEGER NOT NULL CHECK(attempts BETWEEN 0 AND 100)
);

CREATE TABLE analysis_lease (
  id TEXT PRIMARY KEY CHECK(id='worker'),
  token TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);

CREATE TABLE analysis_dead_letters (
  id TEXT PRIMARY KEY,
  game_id TEXT,
  reason TEXT NOT NULL CHECK(length(reason)<=80),
  created_at INTEGER NOT NULL,
  notified_at INTEGER
);
CREATE INDEX analysis_dead_letter_delivery ON analysis_dead_letters(notified_at,created_at);
