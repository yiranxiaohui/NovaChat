-- Multi-channel + per-model pricing
-- See: docs/plans/2026-05-18-multi-channel-pricing.md

CREATE TABLE upstream_channels (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    name        TEXT    NOT NULL UNIQUE,
    protocol    TEXT    NOT NULL,                            -- 'openai' | 'claude' | 'gemini'
    kind        TEXT    NOT NULL,                            -- 'chat'   | 'image'
    base_url    TEXT    NOT NULL,
    api_key     TEXT    NOT NULL,
    enabled     INTEGER NOT NULL DEFAULT 1,
    priority    INTEGER NOT NULL DEFAULT 100,                -- smaller = higher priority
    created_at  TEXT    NOT NULL DEFAULT (datetime('now')),
    updated_at  TEXT    NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_upstream_channels_enabled ON upstream_channels(enabled, priority);

CREATE TABLE model_pricing (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    model        TEXT    NOT NULL UNIQUE,
    kind         TEXT    NOT NULL,                           -- 'chat' | 'image'
    cost_credits INTEGER NOT NULL,
    display_name TEXT,
    enabled      INTEGER NOT NULL DEFAULT 1,
    created_at   TEXT    NOT NULL DEFAULT (datetime('now')),
    updated_at   TEXT    NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_model_pricing_enabled ON model_pricing(enabled, kind);

CREATE TABLE channel_models (
    channel_id  INTEGER NOT NULL REFERENCES upstream_channels(id) ON DELETE CASCADE,
    model       TEXT    NOT NULL,
    upstream_id TEXT,                                        -- NULL = same as `model`
    PRIMARY KEY (channel_id, model)
);
CREATE INDEX idx_channel_models_model ON channel_models(model);
