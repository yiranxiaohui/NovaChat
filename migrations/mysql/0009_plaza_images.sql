CREATE TABLE plaza_images (
    id             BIGINT AUTO_INCREMENT PRIMARY KEY,
    user_id        BIGINT NOT NULL,
    filename       VARCHAR(255) NOT NULL,
    prompt         MEDIUMTEXT NOT NULL,
    revised_prompt MEDIUMTEXT,
    clone_count    BIGINT NOT NULL DEFAULT 0,
    created_at     DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    CONSTRAINT fk_plaza_images_user
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    UNIQUE KEY uq_plaza_images_filename (filename),
    INDEX idx_plaza_images_user (user_id, created_at DESC),
    INDEX idx_plaza_images_hot  (clone_count DESC, created_at DESC)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
