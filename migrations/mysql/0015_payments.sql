CREATE TABLE payment_orders (
    id             BIGINT AUTO_INCREMENT PRIMARY KEY,
    user_id        BIGINT NOT NULL,
    out_trade_no   VARCHAR(64) NOT NULL UNIQUE,
    provider       VARCHAR(16) NOT NULL DEFAULT 'epay',
    payway         VARCHAR(16) NOT NULL,
    amount_cents   BIGINT NOT NULL,
    credits        BIGINT NOT NULL,
    status         VARCHAR(16) NOT NULL DEFAULT 'pending',
    trade_no       VARCHAR(128) NULL,
    client_ip      VARCHAR(64) NULL,
    created_at     DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    paid_at        DATETIME(3) NULL,
    updated_at     DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    CONSTRAINT fk_payment_orders_user
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    INDEX idx_payment_orders_user (user_id, created_at DESC),
    INDEX idx_payment_orders_status (status, created_at DESC)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

INSERT INTO app_settings (`k`, `v`) VALUES ('epay_enabled', 'false');
INSERT INTO app_settings (`k`, `v`) VALUES ('epay_api_url', '');
INSERT INTO app_settings (`k`, `v`) VALUES ('epay_pid', '');
INSERT INTO app_settings (`k`, `v`) VALUES ('epay_key', '');
INSERT INTO app_settings (`k`, `v`) VALUES ('epay_sign_type', 'MD5');
INSERT INTO app_settings (`k`, `v`) VALUES ('epay_credits_per_yuan', '100');
INSERT INTO app_settings (`k`, `v`) VALUES ('epay_product_name', 'NovaChat 积分充值');
INSERT INTO app_settings (`k`, `v`) VALUES ('epay_min_yuan', '1');
INSERT INTO app_settings (`k`, `v`) VALUES ('epay_max_yuan', '5000');
INSERT INTO app_settings (`k`, `v`) VALUES ('epay_return_url', '');
INSERT INTO app_settings (`k`, `v`) VALUES ('epay_notify_url', '');
