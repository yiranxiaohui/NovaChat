CREATE TABLE worker_sessions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  worker_id INTEGER NOT NULL,
  title TEXT NOT NULL DEFAULT '新会话',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_worker_sessions_user ON worker_sessions(user_id);
