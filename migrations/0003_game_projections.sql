-- Read models only. Durable Objects own active games and competitive ratings.
CREATE TABLE games (
  id TEXT PRIMARY KEY,
  pool TEXT NOT NULL CHECK(pool IN ('blitz','rapid')),
  rated INTEGER NOT NULL,
  white_id TEXT NOT NULL,
  black_id TEXT,
  white_name TEXT NOT NULL,
  black_name TEXT,
  status TEXT NOT NULL CHECK(status IN ('finished','pending-adjudication')),
  reason TEXT NOT NULL,
  winner TEXT,
  score REAL,
  started_at INTEGER,
  ended_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  pgn TEXT NOT NULL,
  plies INTEGER NOT NULL,
  rules_version TEXT NOT NULL,
  result_version INTEGER NOT NULL,
  projection_epoch INTEGER NOT NULL,
  projection_version INTEGER NOT NULL,
  projected_at INTEGER NOT NULL,
  settlement TEXT NOT NULL CHECK(settlement IN ('unrated','pending','settled')),
  rating_voided INTEGER NOT NULL DEFAULT 0,
  rating_decision_id TEXT,
  ai_model_id TEXT,
  ai_actual_model TEXT,
  CHECK(ai_model_id IS NULL OR rated=0)
);
CREATE INDEX games_by_white ON games(white_id, ended_at DESC, id);
CREATE INDEX games_by_black ON games(black_id, ended_at DESC, id);

CREATE TABLE leaderboard_entries (
  pool TEXT NOT NULL CHECK(pool IN ('blitz','rapid')),
  user_id TEXT NOT NULL,
  display_name TEXT NOT NULL,
  rating REAL NOT NULL,
  rating_display INTEGER NOT NULL,
  rd REAL NOT NULL,
  vol REAL NOT NULL,
  games INTEGER NOT NULL,
  distinct_opponents INTEGER NOT NULL,
  account_created_at INTEGER NOT NULL,
  last_played_at INTEGER NOT NULL,
  eligible INTEGER NOT NULL,
  epoch INTEGER NOT NULL,
  version INTEGER NOT NULL,
  projected_at INTEGER NOT NULL,
  PRIMARY KEY(pool,user_id)
);
CREATE INDEX leaderboard_order ON leaderboard_entries(pool,eligible,rating_display DESC,user_id);

CREATE TABLE leaderboard_rebuild (
  run_id TEXT NOT NULL,
  pool TEXT NOT NULL,
  user_id TEXT NOT NULL,
  display_name TEXT NOT NULL,
  rating REAL NOT NULL,
  rating_display INTEGER NOT NULL,
  rd REAL NOT NULL,
  vol REAL NOT NULL,
  games INTEGER NOT NULL,
  distinct_opponents INTEGER NOT NULL,
  account_created_at INTEGER NOT NULL,
  last_played_at INTEGER NOT NULL,
  eligible INTEGER NOT NULL,
  epoch INTEGER NOT NULL,
  version INTEGER NOT NULL,
  projected_at INTEGER NOT NULL,
  PRIMARY KEY(run_id,user_id)
);
CREATE TABLE rating_rebuild_games (
  run_id TEXT NOT NULL,
  game_id TEXT NOT NULL,
  decision_id TEXT,
  voided INTEGER NOT NULL,
  PRIMARY KEY(run_id,game_id)
);
CREATE TABLE competition_generations (
  pool TEXT PRIMARY KEY,
  epoch INTEGER NOT NULL,
  watermark INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
