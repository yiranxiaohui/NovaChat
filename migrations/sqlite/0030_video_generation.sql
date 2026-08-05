-- Video generation: jobs + rule-based pricing
-- See: docs/superpowers/specs/2026-08-05-video-generation-design.md

CREATE TABLE video_jobs (
    id                INTEGER PRIMARY KEY AUTOINCREMENT,
    token             TEXT NOT NULL UNIQUE,
    user_id           INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    model             TEXT NOT NULL,
    prompt            TEXT NOT NULL,
    seconds           INTEGER NOT NULL,
    size              TEXT NOT NULL,
    input_image_path  TEXT,
    upstream_video_id TEXT,
    channel_id        INTEGER,
    cost_credits      INTEGER NOT NULL DEFAULT 0,
    status            TEXT NOT NULL DEFAULT 'pending',
    progress          INTEGER NOT NULL DEFAULT 0,
    video_path        TEXT,
    error             TEXT,
    refunded          INTEGER NOT NULL DEFAULT 0,
    download_retries  INTEGER NOT NULL DEFAULT 0,
    polling           INTEGER NOT NULL DEFAULT 0,
    last_polled_at    TEXT,
    created_at        TEXT NOT NULL DEFAULT (datetime('now')),
    started_at        TEXT,
    finished_at       TEXT
);
CREATE INDEX idx_video_jobs_user   ON video_jobs(user_id, created_at DESC);
CREATE INDEX idx_video_jobs_status ON video_jobs(status, last_polled_at);

CREATE TABLE video_pricing (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    model           TEXT NOT NULL UNIQUE,
    display_name    TEXT,
    enabled         INTEGER NOT NULL DEFAULT 1,
    base_credits    INTEGER NOT NULL DEFAULT 0,
    per_second      INTEGER NOT NULL DEFAULT 0,
    allowed_seconds TEXT NOT NULL,
    size_rules      TEXT NOT NULL,
    created_at      TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at      TEXT NOT NULL DEFAULT (datetime('now'))
);
