ALTER TABLE skills ADD COLUMN is_public   TINYINT NOT NULL DEFAULT 0;
ALTER TABLE skills ADD COLUMN clone_count BIGINT NOT NULL DEFAULT 0;
CREATE INDEX idx_skills_public_clones ON skills(is_public, clone_count DESC, created_at DESC);
