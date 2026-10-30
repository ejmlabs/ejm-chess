-- A reservation lasts through all rounds. Only the Competition authority releases it.
CREATE TABLE tournament_account_locks (
  user_id TEXT PRIMARY KEY REFERENCES user(id) ON DELETE RESTRICT,
  tournament_id TEXT NOT NULL,
  acquired_at INTEGER NOT NULL
);
CREATE INDEX tournament_locks_by_event ON tournament_account_locks(tournament_id,user_id);

-- IDs remain permanent after the corresponding Game payload is retired.
CREATE TABLE tournament_game_admissions (
  game_id TEXT PRIMARY KEY,
  tournament_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  storage_state TEXT NOT NULL DEFAULT 'retained' CHECK(storage_state IN ('retained','archived')),
  archived_at INTEGER,
  terminal_version INTEGER,
  terminal_digest TEXT,
  archive_retry_at INTEGER NOT NULL DEFAULT 0,
  archive_error TEXT CHECK(archive_error IS NULL OR length(archive_error)<=80)
);
CREATE INDEX tournament_archive_work ON tournament_game_admissions(storage_state,archive_retry_at,game_id);
CREATE INDEX tournament_admissions_by_event ON tournament_game_admissions(tournament_id,storage_state);
