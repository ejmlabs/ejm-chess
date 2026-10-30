-- Product lifecycle gap: Better Auth hard deletion cannot retain chess identity.
-- Keep only an opaque receipt. This also fences auth writes already in flight.
CREATE TABLE account_closure_receipts (
  request_id TEXT PRIMARY KEY CHECK(length(request_id) BETWEEN 8 AND 100),
  user_id TEXT NOT NULL UNIQUE REFERENCES user(id) ON DELETE RESTRICT,
  policy_version TEXT NOT NULL CHECK(policy_version='account-2026-10-v1'),
  completed_at INTEGER NOT NULL
);
CREATE INDEX account_closure_time ON account_closure_receipts(completed_at,user_id);

CREATE TRIGGER closed_account_insert BEFORE INSERT ON account
WHEN EXISTS(SELECT 1 FROM account_closure_receipts WHERE user_id=NEW.userId)
BEGIN SELECT RAISE(ABORT,'account_closed'); END;
CREATE TRIGGER closed_account_update BEFORE UPDATE ON account
WHEN EXISTS(SELECT 1 FROM account_closure_receipts WHERE user_id=NEW.userId)
BEGIN SELECT RAISE(ABORT,'account_closed'); END;
CREATE TRIGGER closed_session_insert BEFORE INSERT ON session
WHEN EXISTS(SELECT 1 FROM account_closure_receipts WHERE user_id=NEW.userId)
BEGIN SELECT RAISE(ABORT,'account_closed'); END;
CREATE TRIGGER closed_session_update BEFORE UPDATE ON session
WHEN EXISTS(SELECT 1 FROM account_closure_receipts WHERE user_id=NEW.userId)
BEGIN SELECT RAISE(ABORT,'account_closed'); END;
CREATE TRIGGER closed_reset_insert BEFORE INSERT ON verification
WHEN EXISTS(SELECT 1 FROM account_closure_receipts WHERE user_id=NEW.value)
BEGIN SELECT RAISE(ABORT,'account_closed'); END;
CREATE TRIGGER closed_reset_update BEFORE UPDATE ON verification
WHEN EXISTS(SELECT 1 FROM account_closure_receipts WHERE user_id=NEW.value)
BEGIN SELECT RAISE(ABORT,'account_closed'); END;
CREATE TRIGGER closed_profile_update BEFORE UPDATE ON user
WHEN EXISTS(SELECT 1 FROM account_closure_receipts WHERE user_id=NEW.id)
  AND (NEW.name<>'Closed account' OR NEW.username IS NOT NULL OR NEW.image IS NOT NULL
    OR NEW.emailVerified<>0 OR COALESCE(NEW.isAnonymous,0)<>0
    OR NEW.email<>(NEW.id || '@closed-chess.placeholder.invalid'))
BEGIN SELECT RAISE(ABORT,'account_closed'); END;
