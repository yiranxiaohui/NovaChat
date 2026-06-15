CREATE TABLE worker_sessions (
  id BIGSERIAL PRIMARY KEY,
  user_id BIGINT NOT NULL,
  worker_id BIGINT NOT NULL,
  title TEXT NOT NULL DEFAULT '新会话',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_worker_sessions_user ON worker_sessions(user_id);
