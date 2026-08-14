CREATE TABLE video_editor_projects (
    id            BIGSERIAL PRIMARY KEY,
    user_id       BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name          TEXT NOT NULL,
    timeline_json TEXT NOT NULL,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_video_editor_projects_user_updated
    ON video_editor_projects(user_id, updated_at DESC);

CREATE TABLE video_editor_exports (
    id            BIGSERIAL PRIMARY KEY,
    token         TEXT NOT NULL UNIQUE,
    project_id    BIGINT REFERENCES video_editor_projects(id) ON DELETE SET NULL,
    user_id       BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    snapshot_json TEXT NOT NULL,
    status        TEXT NOT NULL DEFAULT 'pending',
    progress      INTEGER NOT NULL DEFAULT 0,
    video_path    TEXT,
    error         TEXT,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    started_at    TIMESTAMPTZ,
    finished_at   TIMESTAMPTZ
);
CREATE INDEX idx_video_editor_exports_user_created
    ON video_editor_exports(user_id, created_at DESC);
CREATE INDEX idx_video_editor_exports_status
    ON video_editor_exports(status, created_at);

CREATE TABLE media_library_assets (
    id            BIGSERIAL PRIMARY KEY,
    user_id       BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    title         TEXT NOT NULL,
    kind          TEXT NOT NULL,
    path          TEXT NOT NULL,
    metadata_json TEXT,
    source        TEXT NOT NULL DEFAULT 'upload',
    is_public     BOOLEAN NOT NULL DEFAULT FALSE,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_media_library_assets_user_created
    ON media_library_assets(user_id, created_at DESC);
CREATE INDEX idx_media_library_assets_public_created
    ON media_library_assets(is_public, created_at DESC);
