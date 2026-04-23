CREATE TABLE image_jobs (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    token        TEXT NOT NULL UNIQUE,
    user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    protocol     TEXT NOT NULL,
    kind         TEXT NOT NULL,
    used_shared  INTEGER NOT NULL DEFAULT 0,
    status       TEXT NOT NULL DEFAULT 'pending',
    result_json  TEXT,
    error        TEXT,
    created_at   TEXT NOT NULL DEFAULT (datetime('now')),
    started_at   TEXT,
    finished_at  TEXT
);
CREATE INDEX idx_image_jobs_user ON image_jobs(user_id, created_at DESC);
CREATE INDEX idx_image_jobs_status ON image_jobs(status, created_at DESC);
