-- Video generation: jobs + rule-based pricing
-- See: docs/superpowers/specs/2026-08-05-video-generation-design.md

CREATE TABLE video_jobs (
    id                BIGSERIAL PRIMARY KEY,
    token             TEXT NOT NULL UNIQUE,
    user_id           BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    model             TEXT NOT NULL,
    prompt            TEXT NOT NULL,
    seconds           INTEGER NOT NULL,
    size              TEXT NOT NULL,
    input_image_path  TEXT,
    upstream_video_id TEXT,
    channel_id        BIGINT,
    cost_credits      BIGINT NOT NULL DEFAULT 0,
    status            TEXT NOT NULL DEFAULT 'pending',
    progress          INTEGER NOT NULL DEFAULT 0,
    video_path        TEXT,
    error             TEXT,
    refunded          BOOLEAN NOT NULL DEFAULT FALSE,
    download_retries  INTEGER NOT NULL DEFAULT 0,
    polling           BOOLEAN NOT NULL DEFAULT FALSE,
    last_polled_at    TIMESTAMPTZ,
    created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    started_at        TIMESTAMPTZ,
    finished_at       TIMESTAMPTZ
);
CREATE INDEX idx_video_jobs_user   ON video_jobs(user_id, created_at DESC);
CREATE INDEX idx_video_jobs_status ON video_jobs(status, last_polled_at);

CREATE TABLE video_pricing (
    id              BIGSERIAL PRIMARY KEY,
    model           TEXT NOT NULL UNIQUE,
    display_name    TEXT,
    enabled         BOOLEAN NOT NULL DEFAULT TRUE,
    base_credits    BIGINT NOT NULL DEFAULT 0,
    per_second      BIGINT NOT NULL DEFAULT 0,
    allowed_seconds TEXT NOT NULL,
    size_rules      TEXT NOT NULL,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
