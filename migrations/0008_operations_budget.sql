-- Fixed categories and twelve reusable month slots keep aggregate keys bounded.
CREATE TABLE budget_months (
  kind TEXT NOT NULL CHECK(kind IN ('games','email','analysis')),
  slot INTEGER NOT NULL CHECK(slot BETWEEN 0 AND 11),
  period INTEGER NOT NULL,
  used INTEGER NOT NULL DEFAULT 0 CHECK(used>=0),
  denied INTEGER NOT NULL DEFAULT 0 CHECK(denied BETWEEN 0 AND 1000000000),
  first_denied_at INTEGER,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY(kind,slot)
);

-- Stable private work IDs prevent retries from spending the allowance twice.
-- Game receipts remain permanent. Expired email/analysis receipts are pruned in
-- bounded batches, and their separate row ceilings fail closed if cleanup stops.
CREATE TABLE budget_receipts (
  kind TEXT NOT NULL CHECK(kind IN ('games','email','analysis')),
  id TEXT NOT NULL CHECK(length(id) BETWEEN 1 AND 200),
  period INTEGER NOT NULL,
  units INTEGER NOT NULL CHECK(units BETWEEN 1 AND 6),
  created_at INTEGER NOT NULL,
  PRIMARY KEY(kind,id)
);
CREATE INDEX budget_receipt_cleanup ON budget_receipts(kind,created_at,id);

CREATE TABLE budget_receipt_counts (
  kind TEXT PRIMARY KEY CHECK(kind IN ('games','email','analysis')),
  count INTEGER NOT NULL DEFAULT 0 CHECK(count>=0)
);
INSERT INTO budget_receipt_counts(kind) VALUES('games'),('email'),('analysis');

CREATE TRIGGER budget_charge AFTER INSERT ON budget_receipts BEGIN
  UPDATE budget_months SET used=used+NEW.units,updated_at=NEW.created_at
    WHERE kind=NEW.kind AND period=NEW.period;
  UPDATE budget_receipt_counts SET count=count+1 WHERE kind=NEW.kind;
END;
CREATE TRIGGER budget_receipt_removed AFTER DELETE ON budget_receipts BEGIN
  UPDATE budget_receipt_counts SET count=count-1 WHERE kind=OLD.kind;
END;

CREATE TABLE operations_control (
  id TEXT PRIMARY KEY CHECK(id='product'),
  version INTEGER NOT NULL DEFAULT 0 CHECK(version>=0),
  games_stopped INTEGER NOT NULL DEFAULT 0 CHECK(games_stopped IN (0,1)),
  email_stopped INTEGER NOT NULL DEFAULT 0 CHECK(email_stopped IN (0,1)),
  analysis_stopped INTEGER NOT NULL DEFAULT 0 CHECK(analysis_stopped IN (0,1)),
  changed_at INTEGER,
  changed_by TEXT,
  reason TEXT CHECK(reason IS NULL OR length(reason) BETWEEN 10 AND 240)
);
INSERT INTO operations_control(id) VALUES('product');

-- Keep the latest 64 operator changes without an unbounded audit queue.
CREATE TABLE operations_changes (
  slot INTEGER PRIMARY KEY CHECK(slot BETWEEN 0 AND 63),
  version INTEGER NOT NULL UNIQUE,
  games_stopped INTEGER NOT NULL,
  email_stopped INTEGER NOT NULL,
  analysis_stopped INTEGER NOT NULL,
  changed_at INTEGER NOT NULL,
  changed_by TEXT NOT NULL,
  reason TEXT NOT NULL
);
