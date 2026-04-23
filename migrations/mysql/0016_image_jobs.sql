CREATE TABLE image_jobs (
    id           BIGINT AUTO_INCREMENT PRIMARY KEY,
    token        VARCHAR(64) NOT NULL UNIQUE,
    user_id      BIGINT NOT NULL,
    protocol     VARCHAR(16) NOT NULL,
    kind         VARCHAR(16) NOT NULL,
    used_shared  TINYINT NOT NULL DEFAULT 0,
    status       VARCHAR(16) NOT NULL DEFAULT 'pending',
    result_json  MEDIUMTEXT NULL,
    error        TEXT NULL,
    created_at   DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    started_at   DATETIME(3) NULL,
    finished_at  DATETIME(3) NULL,
    CONSTRAINT fk_image_jobs_user
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    INDEX idx_image_jobs_user (user_id, created_at DESC),
    INDEX idx_image_jobs_status (status, created_at DESC)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
