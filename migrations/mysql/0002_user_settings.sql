CREATE TABLE user_settings (
    user_id     BIGINT NOT NULL PRIMARY KEY,
    protocol    VARCHAR(32) NOT NULL,
    base_url    VARCHAR(512) NOT NULL,
    api_key     VARCHAR(512) NOT NULL,
    model       VARCHAR(128) NOT NULL,
    use_proxy   TINYINT NOT NULL DEFAULT 1,
    updated_at  DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    CONSTRAINT fk_user_settings_user
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
