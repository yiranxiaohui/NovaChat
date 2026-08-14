CREATE TABLE workflow_run_logs (
    id          BIGINT AUTO_INCREMENT PRIMARY KEY,
    run_id      BIGINT NOT NULL,
    node_key    VARCHAR(96) NULL,
    level       VARCHAR(16) NOT NULL DEFAULT 'info',
    message     TEXT NOT NULL,
    created_at  DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    CONSTRAINT fk_workflow_run_logs_run FOREIGN KEY (run_id) REFERENCES workflow_runs(id) ON DELETE CASCADE,
    INDEX idx_workflow_run_logs_run (run_id, id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
