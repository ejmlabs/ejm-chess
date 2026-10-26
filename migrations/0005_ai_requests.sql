-- Provider quotas contain no prompt, response, account, or credential data.
CREATE TABLE ai_requests (
  request_id TEXT PRIMARY KEY,
  day_key INTEGER NOT NULL,
  minute_key INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX ai_requests_day ON ai_requests(day_key);
CREATE INDEX ai_requests_minute ON ai_requests(minute_key);
CREATE TABLE ai_model_catalog (
  id INTEGER PRIMARY KEY CHECK(id=1),
  models_json TEXT NOT NULL,
  checked_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  refresh_id TEXT,
  refresh_until INTEGER NOT NULL DEFAULT 0
);
