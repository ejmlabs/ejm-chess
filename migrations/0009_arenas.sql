-- Only complete generations enter the public head. No session or seat data.
CREATE TABLE arena_public_events (
  event_id TEXT PRIMARY KEY,
  starts_at INTEGER NOT NULL,
  finished_at INTEGER,
  status TEXT NOT NULL,
  generation INTEGER NOT NULL,
  previous_generation INTEGER,
  watermark INTEGER NOT NULL,
  generated_at INTEGER NOT NULL,
  page_count INTEGER NOT NULL CHECK(page_count>0),
  summary TEXT NOT NULL CHECK(length(summary)<=4096)
);
CREATE INDEX arena_public_schedule ON arena_public_events(starts_at,event_id);
CREATE INDEX arena_public_history ON arena_public_events(finished_at,event_id);

CREATE TABLE arena_public_pages (
  event_id TEXT NOT NULL,
  generation INTEGER NOT NULL,
  page_number INTEGER NOT NULL CHECK(page_number>=0),
  payload TEXT NOT NULL CHECK(length(CAST(payload AS BLOB))<=32768),
  PRIMARY KEY(event_id,generation,page_number)
);

-- Final standings survive cleanup of temporary Competition event state.
CREATE TABLE arena_final_archives (
  event_id TEXT PRIMARY KEY,
  finished_at INTEGER NOT NULL,
  generation INTEGER NOT NULL,
  watermark INTEGER NOT NULL,
  page_count INTEGER NOT NULL,
  summary TEXT NOT NULL CHECK(length(summary)<=4096)
);
CREATE TABLE arena_final_pages (
  event_id TEXT NOT NULL,
  generation INTEGER NOT NULL,
  page_number INTEGER NOT NULL,
  payload TEXT NOT NULL CHECK(length(CAST(payload AS BLOB))<=32768),
  PRIMARY KEY(event_id,generation,page_number)
);

-- Seed historical counts once. Admission and retirement then touch fixed rows.
ALTER TABLE casual_game_admissions ADD COLUMN reservation_id TEXT;
CREATE TABLE game_admission_counts (
  kind TEXT PRIMARY KEY CHECK(kind IN ('casual','tournament')),
  permanent_ids INTEGER NOT NULL CHECK(permanent_ids>=0),
  retained_payloads INTEGER NOT NULL CHECK(retained_payloads>=0),
  legacy_live INTEGER NOT NULL DEFAULT 0 CHECK(legacy_live>=0)
);
INSERT INTO game_admission_counts(kind,permanent_ids,retained_payloads)
  SELECT 'casual',COUNT(*),COALESCE(SUM(storage_state='retained'),0) FROM casual_game_admissions;
INSERT INTO game_admission_counts(kind,permanent_ids,retained_payloads)
  SELECT 'tournament',COUNT(*),COALESCE(SUM(storage_state='retained'),0) FROM tournament_game_admissions;
CREATE TRIGGER casual_admission_count AFTER INSERT ON casual_game_admissions BEGIN
  UPDATE game_admission_counts SET permanent_ids=permanent_ids+1,
    retained_payloads=retained_payloads+(NEW.storage_state='retained') WHERE kind='casual';
END;
CREATE TRIGGER tournament_admission_count AFTER INSERT ON tournament_game_admissions BEGIN
  UPDATE game_admission_counts SET permanent_ids=permanent_ids+1,
    retained_payloads=retained_payloads+(NEW.storage_state='retained') WHERE kind='tournament';
END;
CREATE TRIGGER casual_retirement_count AFTER UPDATE OF storage_state ON casual_game_admissions BEGIN
  UPDATE game_admission_counts SET retained_payloads=retained_payloads
    +(NEW.storage_state='retained')-(OLD.storage_state='retained') WHERE kind='casual';
END;
CREATE TRIGGER tournament_retirement_count AFTER UPDATE OF storage_state ON tournament_game_admissions BEGIN
  UPDATE game_admission_counts SET retained_payloads=retained_payloads
    +(NEW.storage_state='retained')-(OLD.storage_state='retained') WHERE kind='tournament';
END;

-- Existing casual games may predate Competition-owned admission. Count their
-- active game IDs, rather than scanning old released seats during new work.
CREATE TABLE legacy_casual_seats (
  game_id TEXT PRIMARY KEY,
  seats INTEGER NOT NULL CHECK(seats>=0)
);
CREATE TRIGGER legacy_casual_game_opened AFTER INSERT ON legacy_casual_seats BEGIN
  UPDATE game_admission_counts SET legacy_live=legacy_live+1 WHERE kind='casual';
END;
CREATE TRIGGER legacy_casual_game_closed AFTER DELETE ON legacy_casual_seats BEGIN
  UPDATE game_admission_counts SET legacy_live=legacy_live-1 WHERE kind='casual';
END;
INSERT INTO legacy_casual_seats(game_id,seats)
  SELECT s.game_id,COUNT(*) FROM active_game_seats s JOIN casual_game_admissions g ON g.game_id=s.game_id
  WHERE s.released_at IS NULL AND g.reservation_id IS NULL GROUP BY s.game_id;
CREATE TRIGGER legacy_casual_seat_added AFTER INSERT ON active_game_seats
WHEN NEW.released_at IS NULL AND EXISTS(SELECT 1 FROM casual_game_admissions WHERE game_id=NEW.game_id AND reservation_id IS NULL) BEGIN
  INSERT INTO legacy_casual_seats(game_id,seats) VALUES(NEW.game_id,1)
    ON CONFLICT(game_id) DO UPDATE SET seats=seats+1;
END;
CREATE TRIGGER legacy_casual_seat_reopened AFTER UPDATE OF released_at ON active_game_seats
WHEN OLD.released_at IS NOT NULL AND NEW.released_at IS NULL
  AND EXISTS(SELECT 1 FROM casual_game_admissions WHERE game_id=NEW.game_id AND reservation_id IS NULL) BEGIN
  INSERT INTO legacy_casual_seats(game_id,seats) VALUES(NEW.game_id,1)
    ON CONFLICT(game_id) DO UPDATE SET seats=seats+1;
END;
CREATE TRIGGER legacy_casual_seat_released AFTER UPDATE OF released_at ON active_game_seats
WHEN OLD.released_at IS NULL AND NEW.released_at IS NOT NULL BEGIN
  UPDATE legacy_casual_seats SET seats=seats-1 WHERE game_id=NEW.game_id;
  DELETE FROM legacy_casual_seats WHERE game_id=NEW.game_id AND seats=0;
END;
CREATE TRIGGER legacy_casual_seat_deleted AFTER DELETE ON active_game_seats
WHEN OLD.released_at IS NULL BEGIN
  UPDATE legacy_casual_seats SET seats=seats-1 WHERE game_id=OLD.game_id;
  DELETE FROM legacy_casual_seats WHERE game_id=OLD.game_id AND seats=0;
END;
CREATE TRIGGER legacy_casual_admission AFTER INSERT ON casual_game_admissions
WHEN NEW.reservation_id IS NULL BEGIN
  INSERT INTO legacy_casual_seats(game_id,seats)
    SELECT NEW.game_id,COUNT(*) FROM active_game_seats WHERE game_id=NEW.game_id AND released_at IS NULL HAVING COUNT(*)>0
    ON CONFLICT(game_id) DO UPDATE SET seats=excluded.seats;
END;
CREATE TRIGGER legacy_casual_adopted AFTER UPDATE OF reservation_id ON casual_game_admissions
WHEN OLD.reservation_id IS NULL AND NEW.reservation_id IS NOT NULL BEGIN
  DELETE FROM legacy_casual_seats WHERE game_id=NEW.game_id;
END;
