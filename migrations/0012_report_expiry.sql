-- Closure records the absence of review, never a finding about the player.
ALTER TABLE fairplay_cases ADD COLUMN automatic_closed_at INTEGER;
ALTER TABLE fairplay_cases ADD COLUMN automatic_outcome TEXT CHECK(automatic_outcome IS NULL OR automatic_outcome='expired-unreviewed');
CREATE INDEX cases_automatic_expiry ON fairplay_cases(status,automatic_closed_at,created_at,id);
