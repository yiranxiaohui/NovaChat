CREATE TABLE app_settings (
    k          TEXT PRIMARY KEY,
    v          TEXT NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

INSERT INTO app_settings (k, v) VALUES ('shared_enabled', 'false');
INSERT INTO app_settings (k, v) VALUES ('signup_grant', '200');
INSERT INTO app_settings (k, v) VALUES ('cost_chat', '1');
INSERT INTO app_settings (k, v) VALUES ('cost_image', '5');

CREATE TABLE user_credits (
    user_id       BIGINT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    balance       BIGINT NOT NULL DEFAULT 0,
    lifetime_used BIGINT NOT NULL DEFAULT 0,
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE credit_ledger (
    id         BIGSERIAL PRIMARY KEY,
    user_id    BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    delta      BIGINT NOT NULL,
    reason     TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_credit_ledger_user ON credit_ledger(user_id, created_at DESC);
