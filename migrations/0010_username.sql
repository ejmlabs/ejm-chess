-- Additive schema for Better Auth's username plugin with displayUsername=false.
-- Legacy users keep their IDs, anonymous status, sessions, and owned records.
ALTER TABLE user ADD COLUMN username TEXT;
CREATE UNIQUE INDEX user_username_unique ON user(username);
