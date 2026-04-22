CREATE TABLE app_settings (
    k          TEXT PRIMARY KEY,
    v          TEXT NOT NULL,
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

INSERT INTO app_settings (k, v) VALUES ('shared_enabled', 'false');
INSERT INTO app_settings (k, v) VALUES ('signup_grant', '200');
INSERT INTO app_settings (k, v) VALUES ('cost_chat', '1');
INSERT INTO app_settings (k, v) VALUES ('cost_image', '5');

CREATE TABLE user_credits (
    user_id       INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    balance       INTEGER NOT NULL DEFAULT 0,
    lifetime_used INTEGER NOT NULL DEFAULT 0,
    updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE credit_ledger (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    delta      INTEGER NOT NULL,
    reason     TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_credit_ledger_user ON credit_ledger(user_id, created_at DESC);
