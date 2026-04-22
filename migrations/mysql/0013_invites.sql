ALTER TABLE users ADD COLUMN invite_code VARCHAR(16) NULL;
ALTER TABLE users ADD COLUMN invited_by BIGINT NULL;
ALTER TABLE users ADD CONSTRAINT fk_users_invited_by
    FOREIGN KEY (invited_by) REFERENCES users(id) ON DELETE SET NULL;
CREATE UNIQUE INDEX idx_users_invite_code ON users(invite_code);
CREATE INDEX idx_users_invited_by ON users(invited_by);

INSERT INTO app_settings (`k`, `v`) VALUES ('invite_grant_inviter', '100');
INSERT INTO app_settings (`k`, `v`) VALUES ('invite_grant_invitee', '100');
