CREATE TABLE worker_messages (
  id BIGSERIAL PRIMARY KEY,
  session_id BIGINT NOT NULL,
  role TEXT NOT NULL,
  content TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_worker_messages_session ON worker_messages(session_id);
