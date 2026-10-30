-- Keep ready work indexed independently of permanent game/replay ledgers.
-- Proof, evidence holds, and the archive receipt remain authoritative at use.
CREATE TABLE game_retirement_work (
  game_id TEXT PRIMARY KEY,
  ledger TEXT NOT NULL CHECK(ledger IN ('casual_game_admissions','tournament_game_admissions')),
  ready_at INTEGER NOT NULL
);
CREATE INDEX game_retirement_due ON game_retirement_work(ready_at,game_id);
CREATE INDEX retirement_evidence_by_game ON fairplay_evidence(game_id,case_id,expires_at,hold_until);
CREATE INDEX retirement_cases_by_game ON fairplay_cases(game_id,id);
CREATE INDEX retirement_appeals_by_case ON fairplay_appeals(case_id,status,automatic_closed_at);

-- One persisted token bucket, shared by every scaled invocation and restart.
-- Millitokens keep the 32/sec refill exact without floating point state.
CREATE TABLE game_retirement_budget (
  id INTEGER PRIMARY KEY CHECK(id=1),
  tokens_milli INTEGER NOT NULL CHECK(tokens_milli BETWEEN 0 AND 32000),
  refilled_at INTEGER NOT NULL
);
INSERT INTO game_retirement_budget VALUES(1,32000,0);

INSERT INTO game_retirement_work(game_id,ledger,ready_at)
  SELECT g.id,'casual_game_admissions',MAX(g.ended_at+3600000,a.archive_retry_at)
  FROM games g JOIN casual_game_admissions a ON a.game_id=g.id
  WHERE a.storage_state='retained' AND g.status='finished' AND g.rated=0
    AND g.settlement<>'pending' AND g.ended_at IS NOT NULL AND g.terminal_digest IS NOT NULL;
INSERT INTO game_retirement_work(game_id,ledger,ready_at)
  SELECT g.id,'tournament_game_admissions',MAX(g.ended_at+3600000,a.archive_retry_at)
  FROM games g JOIN tournament_game_admissions a ON a.game_id=g.id
  WHERE a.storage_state='retained' AND g.status='finished' AND g.rated=0
    AND g.settlement<>'pending' AND g.ended_at IS NOT NULL AND g.terminal_digest IS NOT NULL;

CREATE TRIGGER retirement_game_added AFTER INSERT ON games
WHEN NEW.status='finished' AND NEW.rated=0 AND NEW.settlement<>'pending'
  AND NEW.ended_at IS NOT NULL AND NEW.terminal_digest IS NOT NULL BEGIN
  INSERT INTO game_retirement_work(game_id,ledger,ready_at)
    SELECT NEW.id,'casual_game_admissions',MAX(NEW.ended_at+3600000,archive_retry_at)
    FROM casual_game_admissions WHERE game_id=NEW.id AND storage_state='retained'
    ON CONFLICT(game_id) DO UPDATE SET ready_at=MAX(ready_at,excluded.ready_at);
  INSERT INTO game_retirement_work(game_id,ledger,ready_at)
    SELECT NEW.id,'tournament_game_admissions',MAX(NEW.ended_at+3600000,archive_retry_at)
    FROM tournament_game_admissions WHERE game_id=NEW.id AND storage_state='retained'
    ON CONFLICT(game_id) DO UPDATE SET ready_at=MAX(ready_at,excluded.ready_at);
END;
CREATE TRIGGER retirement_game_updated AFTER UPDATE OF status,rated,settlement,ended_at,terminal_digest ON games BEGIN
  DELETE FROM game_retirement_work WHERE game_id=NEW.id AND (NEW.status<>'finished' OR NEW.rated<>0
    OR NEW.settlement='pending' OR NEW.ended_at IS NULL OR NEW.terminal_digest IS NULL);
  INSERT INTO game_retirement_work(game_id,ledger,ready_at)
    SELECT NEW.id,'casual_game_admissions',MAX(NEW.ended_at+3600000,archive_retry_at)
    FROM casual_game_admissions WHERE game_id=NEW.id AND storage_state='retained'
      AND NEW.status='finished' AND NEW.rated=0 AND NEW.settlement<>'pending'
      AND NEW.ended_at IS NOT NULL AND NEW.terminal_digest IS NOT NULL
    ON CONFLICT(game_id) DO UPDATE SET ready_at=MAX(ready_at,excluded.ready_at);
  INSERT INTO game_retirement_work(game_id,ledger,ready_at)
    SELECT NEW.id,'tournament_game_admissions',MAX(NEW.ended_at+3600000,archive_retry_at)
    FROM tournament_game_admissions WHERE game_id=NEW.id AND storage_state='retained'
      AND NEW.status='finished' AND NEW.rated=0 AND NEW.settlement<>'pending'
      AND NEW.ended_at IS NOT NULL AND NEW.terminal_digest IS NOT NULL
    ON CONFLICT(game_id) DO UPDATE SET ready_at=MAX(ready_at,excluded.ready_at);
END;

CREATE TRIGGER retirement_casual_added AFTER INSERT ON casual_game_admissions BEGIN
  INSERT INTO game_retirement_work(game_id,ledger,ready_at)
    SELECT NEW.game_id,'casual_game_admissions',MAX(ended_at+3600000,NEW.archive_retry_at)
    FROM games WHERE id=NEW.game_id AND status='finished' AND rated=0 AND settlement<>'pending'
      AND ended_at IS NOT NULL AND terminal_digest IS NOT NULL AND NEW.storage_state='retained'
    ON CONFLICT(game_id) DO UPDATE SET ready_at=MAX(ready_at,excluded.ready_at);
END;
CREATE TRIGGER retirement_tournament_added AFTER INSERT ON tournament_game_admissions BEGIN
  INSERT INTO game_retirement_work(game_id,ledger,ready_at)
    SELECT NEW.game_id,'tournament_game_admissions',MAX(ended_at+3600000,NEW.archive_retry_at)
    FROM games WHERE id=NEW.game_id AND status='finished' AND rated=0 AND settlement<>'pending'
      AND ended_at IS NOT NULL AND terminal_digest IS NOT NULL AND NEW.storage_state='retained'
    ON CONFLICT(game_id) DO UPDATE SET ready_at=MAX(ready_at,excluded.ready_at);
END;
CREATE TRIGGER retirement_casual_progress AFTER UPDATE OF storage_state,archive_retry_at ON casual_game_admissions BEGIN
  DELETE FROM game_retirement_work WHERE game_id=NEW.game_id AND NEW.storage_state='archived';
  UPDATE game_retirement_work SET ready_at=MAX(ready_at,NEW.archive_retry_at) WHERE game_id=NEW.game_id;
END;
CREATE TRIGGER retirement_tournament_progress AFTER UPDATE OF storage_state,archive_retry_at ON tournament_game_admissions BEGIN
  DELETE FROM game_retirement_work WHERE game_id=NEW.game_id AND NEW.storage_state='archived';
  UPDATE game_retirement_work SET ready_at=MAX(ready_at,NEW.archive_retry_at) WHERE game_id=NEW.game_id;
END;
