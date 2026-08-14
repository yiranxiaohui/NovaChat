CREATE TABLE video_editor_projects (
    id            BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
    user_id       BIGINT NOT NULL,
    name          VARCHAR(160) NOT NULL,
    timeline_json LONGTEXT NOT NULL,
    created_at    DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    updated_at    DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    CONSTRAINT fk_video_editor_projects_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    INDEX idx_video_editor_projects_user_updated (user_id, updated_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE video_editor_exports (
    id            BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
    token         VARCHAR(96) NOT NULL UNIQUE,
    project_id    BIGINT,
    user_id       BIGINT NOT NULL,
    snapshot_json LONGTEXT NOT NULL,
    status        VARCHAR(32) NOT NULL DEFAULT 'pending',
    progress      INT NOT NULL DEFAULT 0,
    video_path    TEXT,
    error         TEXT,
    created_at    DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    started_at    DATETIME(3),
    finished_at   DATETIME(3),
    CONSTRAINT fk_video_editor_exports_project FOREIGN KEY (project_id) REFERENCES video_editor_projects(id) ON DELETE SET NULL,
    CONSTRAINT fk_video_editor_exports_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    INDEX idx_video_editor_exports_user_created (user_id, created_at),
    INDEX idx_video_editor_exports_status (status, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE media_library_assets (
    id            BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
    user_id       BIGINT NOT NULL,
    title         VARCHAR(240) NOT NULL,
    kind          VARCHAR(24) NOT NULL,
    path          TEXT NOT NULL,
    metadata_json LONGTEXT,
    source        VARCHAR(32) NOT NULL DEFAULT 'upload',
    is_public     BOOLEAN NOT NULL DEFAULT FALSE,
    created_at    DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    updated_at    DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    CONSTRAINT fk_media_library_assets_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    INDEX idx_media_library_assets_user_created (user_id, created_at),
    INDEX idx_media_library_assets_public_created (is_public, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
