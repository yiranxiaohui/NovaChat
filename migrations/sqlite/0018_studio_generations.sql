CREATE TABLE studio_generations (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    token           TEXT NOT NULL UNIQUE,
    user_id         INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    status          TEXT NOT NULL DEFAULT 'pending',
    error           TEXT,
    prompt          TEXT NOT NULL,
    revised_prompt  TEXT,
    model           TEXT,
    size            TEXT,
    quality         TEXT,
    style           TEXT,
    n               INTEGER NOT NULL DEFAULT 1,
    image_path      TEXT,
    source_path     TEXT,
    used_shared     INTEGER NOT NULL DEFAULT 0,
    created_at      TEXT NOT NULL DEFAULT (datetime('now')),
    finished_at     TEXT
);
CREATE INDEX idx_studio_gen_user ON studio_generations(user_id, created_at DESC);
CREATE INDEX idx_studio_gen_status ON studio_generations(status, created_at DESC);
