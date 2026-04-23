CREATE TABLE studio_conversations (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    title       TEXT NOT NULL DEFAULT '新建工作台',
    model       TEXT,
    created_at  TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_studio_conv_user ON studio_conversations(user_id, updated_at DESC);

CREATE TABLE studio_messages (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    conversation_id INTEGER NOT NULL REFERENCES studio_conversations(id) ON DELETE CASCADE,
    role            TEXT NOT NULL,
    text            TEXT,
    images_json     TEXT,
    created_at      TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_studio_msg_conv ON studio_messages(conversation_id, id);

CREATE TABLE studio_jobs (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    token           TEXT NOT NULL UNIQUE,
    user_id         INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    conversation_id INTEGER NOT NULL REFERENCES studio_conversations(id) ON DELETE CASCADE,
    status          TEXT NOT NULL DEFAULT 'pending',
    error           TEXT,
    created_at      TEXT NOT NULL DEFAULT (datetime('now')),
    finished_at     TEXT
);
CREATE INDEX idx_studio_jobs_user ON studio_jobs(user_id, created_at DESC);
