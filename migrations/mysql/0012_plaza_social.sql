ALTER TABLE plaza_images ADD COLUMN like_count    BIGINT NOT NULL DEFAULT 0;
ALTER TABLE plaza_images ADD COLUMN comment_count BIGINT NOT NULL DEFAULT 0;

CREATE TABLE plaza_image_likes (
    image_id   BIGINT NOT NULL,
    user_id    BIGINT NOT NULL,
    created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    PRIMARY KEY (image_id, user_id),
    CONSTRAINT fk_pil_image FOREIGN KEY (image_id) REFERENCES plaza_images(id) ON DELETE CASCADE,
    CONSTRAINT fk_pil_user  FOREIGN KEY (user_id)  REFERENCES users(id)        ON DELETE CASCADE,
    INDEX idx_plaza_image_likes_user (user_id, created_at DESC)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE plaza_image_comments (
    id         BIGINT AUTO_INCREMENT PRIMARY KEY,
    image_id   BIGINT NOT NULL,
    user_id    BIGINT NOT NULL,
    content    MEDIUMTEXT NOT NULL,
    created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    CONSTRAINT fk_pic_image FOREIGN KEY (image_id) REFERENCES plaza_images(id) ON DELETE CASCADE,
    CONSTRAINT fk_pic_user  FOREIGN KEY (user_id)  REFERENCES users(id)        ON DELETE CASCADE,
    INDEX idx_plaza_image_comments_image (image_id, created_at DESC)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
