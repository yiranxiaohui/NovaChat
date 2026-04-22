ALTER TABLE users ADD COLUMN is_admin TINYINT(1) NOT NULL DEFAULT 0;
UPDATE users SET is_admin = 1 WHERE id = (SELECT min_id FROM (SELECT MIN(id) AS min_id FROM users) AS t);
CREATE INDEX idx_users_is_admin ON users(is_admin);
