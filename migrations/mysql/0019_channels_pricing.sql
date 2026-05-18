-- Multi-channel + per-model pricing
-- See: docs/plans/2026-05-18-multi-channel-pricing.md

CREATE TABLE upstream_channels (
    id          BIGINT       AUTO_INCREMENT PRIMARY KEY,
    name        VARCHAR(120) NOT NULL UNIQUE,
    protocol    VARCHAR(16)  NOT NULL,
    kind        VARCHAR(16)  NOT NULL,
    base_url    VARCHAR(512) NOT NULL,
    api_key     VARCHAR(512) NOT NULL,
    enabled     TINYINT(1)   NOT NULL DEFAULT 1,
    priority    INT          NOT NULL DEFAULT 100,
    created_at  DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    updated_at  DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    INDEX idx_upstream_channels_enabled (enabled, priority)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE model_pricing (
    id           BIGINT       AUTO_INCREMENT PRIMARY KEY,
    model        VARCHAR(120) NOT NULL UNIQUE,
    kind         VARCHAR(16)  NOT NULL,
    cost_credits BIGINT       NOT NULL,
    display_name VARCHAR(160),
    enabled      TINYINT(1)   NOT NULL DEFAULT 1,
    created_at   DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    updated_at   DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    INDEX idx_model_pricing_enabled (enabled, kind)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE channel_models (
    channel_id  BIGINT       NOT NULL,
    model       VARCHAR(120) NOT NULL,
    upstream_id VARCHAR(160),
    PRIMARY KEY (channel_id, model),
    CONSTRAINT fk_channel_models_channel
        FOREIGN KEY (channel_id) REFERENCES upstream_channels(id) ON DELETE CASCADE,
    INDEX idx_channel_models_model (model)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
