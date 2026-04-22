ALTER TABLE users ADD COLUMN invite_code TEXT;
ALTER TABLE users ADD COLUMN invited_by BIGINT REFERENCES users(id) ON DELETE SET NULL;
CREATE UNIQUE INDEX idx_users_invite_code ON users(invite_code) WHERE invite_code IS NOT NULL;
CREATE INDEX idx_users_invited_by ON users(invited_by);

INSERT INTO app_settings (k, v) VALUES ('invite_grant_inviter', '100');
INSERT INTO app_settings (k, v) VALUES ('invite_grant_invitee', '100');
