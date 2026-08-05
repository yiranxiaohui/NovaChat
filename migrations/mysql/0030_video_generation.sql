-- Video generation: jobs + rule-based pricing
-- See: docs/superpowers/specs/2026-08-05-video-generation-design.md

CREATE TABLE video_jobs (
    id                BIGINT AUTO_INCREMENT PRIMARY KEY,
    token             VARCHAR(64) NOT NULL UNIQUE,
    user_id           BIGINT NOT NULL,
    model             VARCHAR(191) NOT NULL,
    prompt            LONGTEXT NOT NULL,
    seconds           INT NOT NULL,
    size              VARCHAR(32) NOT NULL,
    input_image_path  VARCHAR(255),
    upstream_video_id VARCHAR(191),
    channel_id        BIGINT,
    cost_credits      BIGINT NOT NULL DEFAULT 0,
    status            VARCHAR(16) NOT NULL DEFAULT 'pending',
    progress          INT NOT NULL DEFAULT 0,
    video_path        VARCHAR(255),
    error             TEXT,
    refunded          TINYINT(1) NOT NULL DEFAULT 0,
    download_retries  INT NOT NULL DEFAULT 0,
    polling           TINYINT(1) NOT NULL DEFAULT 0,
    last_polled_at    DATETIME(3),
    created_at        DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    started_at        DATETIME(3),
    finished_at       DATETIME(3),
    CONSTRAINT fk_video_jobs_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    INDEX idx_video_jobs_user   (user_id, created_at DESC),
    INDEX idx_video_jobs_status (status, last_polled_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE video_pricing (
    id              BIGINT AUTO_INCREMENT PRIMARY KEY,
    model           VARCHAR(191) NOT NULL UNIQUE,
    display_name    VARCHAR(191),
    enabled         TINYINT(1) NOT NULL DEFAULT 1,
    base_credits    BIGINT NOT NULL DEFAULT 0,
    per_second      BIGINT NOT NULL DEFAULT 0,
    allowed_seconds LONGTEXT NOT NULL,
    size_rules      LONGTEXT NOT NULL,
    created_at      DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    updated_at      DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
