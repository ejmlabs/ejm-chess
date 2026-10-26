-- One fixed row bounds signup hashing and identity growth without retaining
-- submitted usernames, email addresses, passwords or per-attempt receipts.
CREATE TABLE signup_budget (
  id TEXT PRIMARY KEY CHECK(id='product'),
  period INTEGER NOT NULL DEFAULT 0 CHECK(period>=0),
  monthly_attempts INTEGER NOT NULL DEFAULT 0 CHECK(monthly_attempts>=0),
  lifetime_attempts INTEGER NOT NULL DEFAULT 0 CHECK(lifetime_attempts>=monthly_attempts)
);

-- Existing identities consume the lifetime allowance. Later failed or
-- uncertain signup attempts stay charged, and account closure refunds none.
INSERT INTO signup_budget(id,lifetime_attempts)
  SELECT 'product',COUNT(*) FROM user;
