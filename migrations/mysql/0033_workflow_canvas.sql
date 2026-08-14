CREATE TABLE workflows (
    id          BIGINT AUTO_INCREMENT PRIMARY KEY,
    user_id     BIGINT NOT NULL,
    name        VARCHAR(255) NOT NULL,
    graph_json  MEDIUMTEXT NOT NULL,
    created_at  DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    updated_at  DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    CONSTRAINT fk_workflows_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    INDEX idx_workflows_user_updated (user_id, updated_at DESC)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE workflow_runs (
    id           BIGINT AUTO_INCREMENT PRIMARY KEY,
    token        VARCHAR(64) NOT NULL UNIQUE,
    workflow_id  BIGINT NULL,
    user_id      BIGINT NOT NULL,
    name         VARCHAR(255) NOT NULL,
    graph_json   MEDIUMTEXT NOT NULL,
    status       VARCHAR(24) NOT NULL DEFAULT 'running',
    error        TEXT NULL,
    created_at   DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    finished_at  DATETIME(3) NULL,
    CONSTRAINT fk_workflow_runs_workflow FOREIGN KEY (workflow_id) REFERENCES workflows(id) ON DELETE SET NULL,
    CONSTRAINT fk_workflow_runs_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    INDEX idx_workflow_runs_user_created (user_id, created_at DESC),
    INDEX idx_workflow_runs_status (status, created_at DESC)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE workflow_node_runs (
    id            BIGINT AUTO_INCREMENT PRIMARY KEY,
    run_id        BIGINT NOT NULL,
    node_key      VARCHAR(96) NOT NULL,
    node_type     VARCHAR(32) NOT NULL,
    status        VARCHAR(24) NOT NULL DEFAULT 'waiting',
    job_token     VARCHAR(64) NULL,
    output_paths  MEDIUMTEXT NULL,
    error         TEXT NULL,
    created_at    DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    started_at    DATETIME(3) NULL,
    finished_at   DATETIME(3) NULL,
    CONSTRAINT fk_workflow_node_runs_run FOREIGN KEY (run_id) REFERENCES workflow_runs(id) ON DELETE CASCADE,
    UNIQUE KEY uq_workflow_node_run (run_id, node_key),
    INDEX idx_workflow_node_runs_run (run_id, id),
    INDEX idx_workflow_node_runs_status (status, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE media_assets (
    id                   BIGINT AUTO_INCREMENT PRIMARY KEY,
    user_id              BIGINT NOT NULL,
    workflow_run_id      BIGINT NULL,
    workflow_node_run_id BIGINT NULL,
    kind                 VARCHAR(16) NOT NULL,
    path                 VARCHAR(512) NOT NULL,
    metadata_json        MEDIUMTEXT NULL,
    created_at           DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    CONSTRAINT fk_media_assets_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    CONSTRAINT fk_media_assets_run FOREIGN KEY (workflow_run_id) REFERENCES workflow_runs(id) ON DELETE SET NULL,
    CONSTRAINT fk_media_assets_node FOREIGN KEY (workflow_node_run_id) REFERENCES workflow_node_runs(id) ON DELETE SET NULL,
    INDEX idx_media_assets_user_created (user_id, created_at DESC),
    INDEX idx_media_assets_node (workflow_node_run_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
