CREATE TABLE app_settings (
    `k`        VARCHAR(64) NOT NULL PRIMARY KEY,
    `v`        TEXT NOT NULL,
    updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

INSERT INTO app_settings (`k`, `v`) VALUES ('shared_enabled', 'false');
INSERT INTO app_settings (`k`, `v`) VALUES ('signup_grant', '200');
INSERT INTO app_settings (`k`, `v`) VALUES ('cost_chat', '1');
INSERT INTO app_settings (`k`, `v`) VALUES ('cost_image', '5');

CREATE TABLE user_credits (
    user_id       BIGINT NOT NULL PRIMARY KEY,
    balance       BIGINT NOT NULL DEFAULT 0,
    lifetime_used BIGINT NOT NULL DEFAULT 0,
    updated_at    DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    CONSTRAINT fk_user_credits_user
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE credit_ledger (
    id         BIGINT AUTO_INCREMENT PRIMARY KEY,
    user_id    BIGINT NOT NULL,
    delta      BIGINT NOT NULL,
    reason     VARCHAR(80) NOT NULL,
    created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    CONSTRAINT fk_credit_ledger_user
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    INDEX idx_credit_ledger_user (user_id, created_at DESC)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
