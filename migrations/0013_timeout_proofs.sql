-- Independent proof credits stay inside the existing chess budget. Stable
-- receipts are permanent and bounded by the retained ranked-game ceiling.
CREATE TABLE timeout_proof_months (
  slot INTEGER PRIMARY KEY CHECK(slot BETWEEN 0 AND 11),
  period INTEGER NOT NULL,
  used INTEGER NOT NULL DEFAULT 0 CHECK(used BETWEEN 0 AND 1000)
);
CREATE TABLE timeout_proof_admissions (
  game_id TEXT PRIMARY KEY CHECK(length(game_id) BETWEEN 8 AND 100),
  rules_version TEXT NOT NULL CHECK(rules_version='online-2026-10-v3-proof'),
  profile_version TEXT NOT NULL CHECK(profile_version='cha-native-3484c7e6-v1'),
  credits INTEGER NOT NULL CHECK(credits=2),
  period INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE TRIGGER timeout_proof_charge AFTER INSERT ON timeout_proof_admissions BEGIN
  UPDATE timeout_proof_months SET used=used+1 WHERE period=NEW.period;
END;
