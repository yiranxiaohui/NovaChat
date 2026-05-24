-- Add structured metadata to credit_ledger so the cost stats dashboard can
-- aggregate by model / protocol / kind without parsing the free-form `reason`
-- string. Historical rows leave these columns NULL — only the dashboard's
-- "since this column existed" data is broken down per-model.
ALTER TABLE credit_ledger ADD COLUMN kind     TEXT;
ALTER TABLE credit_ledger ADD COLUMN protocol TEXT;
ALTER TABLE credit_ledger ADD COLUMN model    TEXT;

CREATE INDEX idx_credit_ledger_kind_created
    ON credit_ledger(kind, created_at DESC);
CREATE INDEX idx_credit_ledger_model_created
    ON credit_ledger(model, created_at DESC);
