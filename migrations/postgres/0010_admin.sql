ALTER TABLE users ADD COLUMN is_admin BOOLEAN NOT NULL DEFAULT FALSE;
UPDATE users SET is_admin = TRUE WHERE id = (SELECT MIN(id) FROM users);
CREATE INDEX idx_users_is_admin ON users(is_admin) WHERE is_admin;
