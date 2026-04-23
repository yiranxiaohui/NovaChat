CREATE TABLE studio_conversations (
    id          BIGINT AUTO_INCREMENT PRIMARY KEY,
    user_id     BIGINT NOT NULL,
    title       VARCHAR(200) NOT NULL DEFAULT '新建工作台',
    model       VARCHAR(64) NULL,
    created_at  DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    updated_at  DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    CONSTRAINT fk_studio_conv_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    INDEX idx_studio_conv_user (user_id, updated_at DESC)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE studio_messages (
    id              BIGINT AUTO_INCREMENT PRIMARY KEY,
    conversation_id BIGINT NOT NULL,
    role            VARCHAR(16) NOT NULL,
    text            MEDIUMTEXT NULL,
    images_json     MEDIUMTEXT NULL,
    created_at      DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    CONSTRAINT fk_studio_msg_conv FOREIGN KEY (conversation_id) REFERENCES studio_conversations(id) ON DELETE CASCADE,
    INDEX idx_studio_msg_conv (conversation_id, id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE studio_jobs (
    id              BIGINT AUTO_INCREMENT PRIMARY KEY,
    token           VARCHAR(64) NOT NULL UNIQUE,
    user_id         BIGINT NOT NULL,
    conversation_id BIGINT NOT NULL,
    status          VARCHAR(16) NOT NULL DEFAULT 'pending',
    error           TEXT NULL,
    created_at      DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    finished_at     DATETIME(3) NULL,
    CONSTRAINT fk_studio_jobs_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    CONSTRAINT fk_studio_jobs_conv FOREIGN KEY (conversation_id) REFERENCES studio_conversations(id) ON DELETE CASCADE,
    INDEX idx_studio_jobs_user (user_id, created_at DESC)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
