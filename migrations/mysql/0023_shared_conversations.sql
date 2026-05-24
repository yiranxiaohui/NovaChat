-- Public-shared snapshots of conversations. See sqlite/0023 for the contract.
CREATE TABLE shared_conversations (
    token            VARCHAR(64) NOT NULL PRIMARY KEY,
    user_id          BIGINT NOT NULL,
    conversation_id  BIGINT NOT NULL,
    title            VARCHAR(255) NOT NULL,
    creator_name     VARCHAR(128) NULL,
    snapshot_json    MEDIUMTEXT NOT NULL,
    view_count       BIGINT NOT NULL DEFAULT 0,
    created_at       DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    expires_at       DATETIME(3) NULL,
    CONSTRAINT fk_shared_conv_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    INDEX idx_shared_user_created (user_id, created_at DESC),
    INDEX idx_shared_conv (conversation_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
