ALTER TABLE games ADD COLUMN terminal_digest TEXT;
CREATE INDEX games_archive_candidates ON games(status,settlement,ended_at,id);

ALTER TABLE casual_game_admissions ADD COLUMN storage_state TEXT NOT NULL DEFAULT 'retained' CHECK(storage_state IN ('retained','archived'));
ALTER TABLE casual_game_admissions ADD COLUMN archived_at INTEGER;
ALTER TABLE casual_game_admissions ADD COLUMN terminal_version INTEGER;
ALTER TABLE casual_game_admissions ADD COLUMN terminal_digest TEXT;
ALTER TABLE casual_game_admissions ADD COLUMN archive_retry_at INTEGER NOT NULL DEFAULT 0;
ALTER TABLE casual_game_admissions ADD COLUMN archive_error TEXT CHECK(archive_error IS NULL OR length(archive_error)<=80);
CREATE INDEX casual_archive_work ON casual_game_admissions(storage_state,archive_retry_at,game_id);

-- A policy expiry is not a human decision or a finding about the player.
ALTER TABLE fairplay_appeals ADD COLUMN automatic_closed_at INTEGER;
ALTER TABLE fairplay_appeals ADD COLUMN automatic_outcome TEXT CHECK(automatic_outcome IS NULL OR automatic_outcome='expired-unreviewed');
CREATE INDEX appeals_automatic_expiry ON fairplay_appeals(status,automatic_closed_at,created_at);

-- One rolling row per bounded maintenance path, not one row per invocation.
CREATE TABLE maintenance_budgets (
  kind TEXT PRIMARY KEY CHECK(kind IN ('game-retirement','game-recovery')),
  window_start INTEGER NOT NULL,
  attempts INTEGER NOT NULL CHECK(attempts BETWEEN 1 AND 4)
);
