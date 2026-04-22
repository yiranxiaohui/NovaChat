ALTER TABLE users ADD COLUMN email VARCHAR(255) NULL;
CREATE UNIQUE INDEX idx_users_email ON users(email);

CREATE TABLE email_codes (
    id         BIGINT AUTO_INCREMENT PRIMARY KEY,
    email      VARCHAR(255) NOT NULL,
    code_hash  VARCHAR(128) NOT NULL,
    purpose    VARCHAR(32) NOT NULL,
    expires_at DATETIME(3) NOT NULL,
    used       TINYINT NOT NULL DEFAULT 0,
    attempts   INT NOT NULL DEFAULT 0,
    created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    INDEX idx_email_codes_email_purpose (email, purpose, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

INSERT INTO app_settings (`k`, `v`) VALUES ('email_verification_required', 'false');
INSERT INTO app_settings (`k`, `v`) VALUES ('smtp_host', '');
INSERT INTO app_settings (`k`, `v`) VALUES ('smtp_port', '587');
INSERT INTO app_settings (`k`, `v`) VALUES ('smtp_username', '');
INSERT INTO app_settings (`k`, `v`) VALUES ('smtp_password', '');
INSERT INTO app_settings (`k`, `v`) VALUES ('smtp_from_email', '');
INSERT INTO app_settings (`k`, `v`) VALUES ('smtp_from_name', 'NovaChat');
INSERT INTO app_settings (`k`, `v`) VALUES ('smtp_security', 'starttls');
