CREATE INDEX session_expiry_idx ON session(expiresAt);
CREATE INDEX verification_expiry_idx ON verification(expiresAt);
CREATE INDEX rate_limit_expiry_idx ON rateLimit(lastRequest);
CREATE INDEX anonymous_account_age ON user(isAnonymous, createdAt);

-- Retain these entries until the corresponding Durable Object storage is retired.
CREATE TABLE casual_game_admissions (
  game_id TEXT PRIMARY KEY,
  creator_id TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE active_game_seats (
  user_id TEXT NOT NULL REFERENCES user(id) ON DELETE RESTRICT,
  game_id TEXT NOT NULL,
  acquired_at INTEGER NOT NULL,
  released_at INTEGER,
  PRIMARY KEY(user_id, game_id)
);
CREATE INDEX active_seats_by_user ON active_game_seats(user_id, released_at);
CREATE INDEX active_seats_by_game ON active_game_seats(game_id, released_at);

CREATE TABLE identity_change_leases (
  user_id TEXT PRIMARY KEY REFERENCES user(id) ON DELETE CASCADE,
  lease_id TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX identity_lease_expiry ON identity_change_leases(expires_at);

CREATE TABLE fairplay_cases (
  id TEXT PRIMARY KEY,
  subject_id TEXT NOT NULL REFERENCES user(id) ON DELETE RESTRICT,
  game_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open' CHECK(status IN ('open','decided','appeal_open','closed')),
  version INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE(subject_id, game_id)
);
CREATE INDEX cases_by_status ON fairplay_cases(status, updated_at, id);
CREATE INDEX cases_by_subject ON fairplay_cases(subject_id, created_at);

CREATE TABLE fairplay_reports (
  id TEXT PRIMARY KEY,
  case_id TEXT NOT NULL REFERENCES fairplay_cases(id),
  game_id TEXT NOT NULL,
  reporter_id TEXT NOT NULL REFERENCES user(id) ON DELETE RESTRICT,
  reason TEXT NOT NULL CHECK(reason IN ('engine-assistance','rating-manipulation','account-abuse','other')),
  details TEXT NOT NULL CHECK(length(details)<=1000),
  created_at INTEGER NOT NULL,
  analysis_requested_at INTEGER,
  UNIQUE(game_id, reporter_id)
);
CREATE INDEX reports_by_case ON fairplay_reports(case_id, created_at);

CREATE TABLE fairplay_evidence (
  id TEXT PRIMARY KEY,
  case_id TEXT NOT NULL REFERENCES fairplay_cases(id),
  game_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN ('server_game','engine_summary','related_game','farming')),
  source_ref TEXT NOT NULL,
  source_version TEXT NOT NULL,
  analysis_version TEXT,
  summary_json TEXT NOT NULL CHECK(length(summary_json)<=16384 AND json_valid(summary_json)),
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  hold_until INTEGER NOT NULL DEFAULT 0,
  UNIQUE(case_id, source_ref, source_version, kind)
);
CREATE INDEX evidence_by_case ON fairplay_evidence(case_id, created_at);
CREATE INDEX evidence_retention ON fairplay_evidence(expires_at, hold_until);

CREATE TABLE fairplay_decisions (
  id TEXT PRIMARY KEY,
  case_id TEXT NOT NULL REFERENCES fairplay_cases(id),
  subject_id TEXT NOT NULL REFERENCES user(id) ON DELETE RESTRICT,
  reviewer_id TEXT NOT NULL REFERENCES user(id) ON DELETE RESTRICT,
  outcome TEXT NOT NULL CHECK(outcome IN ('restrict','clear','overturn','uphold')),
  reason TEXT NOT NULL CHECK(length(reason) BETWEEN 10 AND 500),
  review_note TEXT NOT NULL CHECK(length(review_note)<=4000),
  corroboration TEXT NOT NULL CHECK(length(corroboration)<=4000),
  evidence_ids TEXT NOT NULL CHECK(json_valid(evidence_ids)),
  affected_game_ids TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(affected_game_ids)),
  request_hash TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  appeal_until INTEGER NOT NULL,
  appeal_id TEXT
);
CREATE INDEX decisions_by_case ON fairplay_decisions(case_id, created_at);
CREATE INDEX decisions_by_subject ON fairplay_decisions(subject_id, created_at);

CREATE TABLE restrictions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES user(id) ON DELETE RESTRICT,
  case_id TEXT NOT NULL REFERENCES fairplay_cases(id),
  decision_id TEXT NOT NULL UNIQUE REFERENCES fairplay_decisions(id),
  reason TEXT NOT NULL,
  starts_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL CHECK(expires_at>starts_at AND expires_at-starts_at<=604800000),
  revoked_at INTEGER,
  revoke_reason TEXT
);
CREATE INDEX restrictions_by_user ON restrictions(user_id, revoked_at, expires_at);
CREATE INDEX restrictions_expiry ON restrictions(revoked_at, expires_at, id);

CREATE TABLE fairplay_appeals (
  id TEXT PRIMARY KEY,
  decision_id TEXT NOT NULL UNIQUE REFERENCES fairplay_decisions(id),
  case_id TEXT NOT NULL REFERENCES fairplay_cases(id),
  user_id TEXT NOT NULL REFERENCES user(id) ON DELETE RESTRICT,
  reason TEXT NOT NULL CHECK(length(reason) BETWEEN 10 AND 2000),
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','overturned','upheld')),
  created_at INTEGER NOT NULL,
  resolved_at INTEGER,
  outcome_decision_id TEXT REFERENCES fairplay_decisions(id)
);
CREATE INDEX appeals_pending ON fairplay_appeals(status, created_at);

CREATE TABLE fairplay_events (
  id TEXT PRIMARY KEY,
  case_id TEXT NOT NULL REFERENCES fairplay_cases(id),
  actor_id TEXT,
  kind TEXT NOT NULL,
  reference_id TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX events_by_case ON fairplay_events(case_id, created_at);

CREATE TABLE rating_correction_outbox (
  decision_id TEXT PRIMARY KEY REFERENCES fairplay_decisions(id),
  subject_id TEXT NOT NULL,
  action TEXT NOT NULL CHECK(action IN ('review_replay','reverse_replay')),
  created_at INTEGER NOT NULL,
  completed_at INTEGER,
  last_error TEXT
);
CREATE INDEX corrections_pending ON rating_correction_outbox(completed_at, created_at);

CREATE TABLE request_limits (
  key TEXT PRIMARY KEY,
  count INTEGER NOT NULL,
  window_start INTEGER NOT NULL
);
CREATE INDEX request_limit_expiry ON request_limits(window_start);
