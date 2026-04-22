use axum::{
    Json, Router,
    extract::State,
    http::StatusCode,
    response::{IntoResponse, Response},
    routing::{get, post},
};
use serde::{Deserialize, Serialize};
use std::path::Path;

use crate::{AppState, InstalledState, auth, db};

// ---------------------------------------------------------------------------
// persisted config
// ---------------------------------------------------------------------------

#[derive(Serialize, Deserialize)]
pub struct StoredConfig {
    pub database_url: String,
}

pub fn load_config(path: &Path) -> Result<StoredConfig, String> {
    let text = std::fs::read_to_string(path).map_err(|e| e.to_string())?;
    toml::from_str(&text).map_err(|e| e.to_string())
}

pub fn save_config(path: &Path, cfg: &StoredConfig) -> Result<(), String> {
    let body = toml::to_string_pretty(cfg).map_err(|e| e.to_string())?;
    if let Some(dir) = path.parent() {
        if !dir.as_os_str().is_empty() {
            std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
        }
    }
    std::fs::write(path, body).map_err(|e| e.to_string())
}

// ---------------------------------------------------------------------------
// boot helpers
// ---------------------------------------------------------------------------

pub async fn boot_installed(url: &str) -> Result<InstalledState, String> {
    let kind = db::DbKind::from_url(url)
        .ok_or_else(|| "unsupported database url scheme".to_string())?;
    let pool = db::connect(url).await.map_err(|e| e.to_string())?;
    db::migrate(&pool, kind).await.map_err(|e| e.to_string())?;
    Ok(InstalledState { pool, kind })
}

// ---------------------------------------------------------------------------
// request / response shapes
// ---------------------------------------------------------------------------

#[derive(Serialize)]
pub struct StatusResponse {
    pub installed: bool,
    pub supported: Vec<&'static str>,
}

#[derive(Deserialize)]
pub struct ConnectionForm {
    pub kind: String,
    // for sqlite: relative file path (e.g. "novachat.db")
    // for mysql/postgres: host, port, user, password, database, with tls optional
    pub sqlite_path: Option<String>,

    pub host: Option<String>,
    pub port: Option<u16>,
    pub user: Option<String>,
    pub password: Option<String>,
    pub database: Option<String>,
    pub tls: Option<bool>,
}

#[derive(Deserialize)]
pub struct InstallRequest {
    pub connection: ConnectionForm,
    pub admin_username: String,
    pub admin_password: String,
}

#[derive(Serialize)]
pub struct InstallResponse {
    pub ok: bool,
    pub admin_id: i64,
}

fn err(s: StatusCode, m: impl Into<String>) -> Response {
    (s, m.into()).into_response()
}

// ---------------------------------------------------------------------------
// url builder
// ---------------------------------------------------------------------------

fn build_url(form: &ConnectionForm, data_dir: &Path) -> Result<(db::DbKind, String), String> {
    match form.kind.as_str() {
        "sqlite" => {
            let raw = form
                .sqlite_path
                .as_deref()
                .unwrap_or("novachat.db")
                .trim();
            if raw.is_empty() {
                return Err("sqlite_path is empty".into());
            }
            if raw.contains("..") {
                return Err("invalid sqlite path".into());
            }
            let candidate = std::path::Path::new(raw);
            // absolute paths are used as-is; relative paths resolve under data_dir
            let full = if candidate.is_absolute() {
                candidate.to_path_buf()
            } else {
                data_dir.join(candidate)
            };
            if let Some(parent) = full.parent() {
                if !parent.as_os_str().is_empty() {
                    std::fs::create_dir_all(parent)
                        .map_err(|e| format!("create sqlite dir: {e}"))?;
                }
            }
            let path_str = full
                .to_str()
                .ok_or_else(|| "sqlite path is not valid UTF-8".to_string())?
                .replace('\\', "/");
            Ok((db::DbKind::Sqlite, format!("sqlite://{path_str}")))
        }
        "mysql" | "postgres" => {
            let host = form.host.as_deref().unwrap_or("localhost");
            let default_port = if form.kind == "mysql" { 3306 } else { 5432 };
            let port = form.port.unwrap_or(default_port);
            let user = form.user.as_deref().unwrap_or("");
            let password = form.password.as_deref().unwrap_or("");
            let database = form.database.as_deref().unwrap_or("");
            if database.is_empty() {
                return Err("database name is required".into());
            }
            let scheme = if form.kind == "mysql" { "mysql" } else { "postgres" };
            let user_enc = percent_encode(user);
            let pass_enc = percent_encode(password);
            let auth = if user.is_empty() {
                String::new()
            } else if password.is_empty() {
                format!("{user_enc}@")
            } else {
                format!("{user_enc}:{pass_enc}@")
            };
            let mut query = String::new();
            if form.tls.unwrap_or(false) {
                if form.kind == "postgres" {
                    query.push_str("?sslmode=require");
                } else {
                    query.push_str("?ssl-mode=REQUIRED");
                }
            }
            let url = format!("{scheme}://{auth}{host}:{port}/{database}{query}");
            let kind = db::DbKind::from_url(&url).unwrap();
            Ok((kind, url))
        }
        other => Err(format!("unsupported db kind: {other}")),
    }
}

fn percent_encode(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for b in s.bytes() {
        if matches!(b, b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~') {
            out.push(b as char);
        } else {
            out.push_str(&format!("%{b:02X}"));
        }
    }
    out
}

// ---------------------------------------------------------------------------
// handlers
// ---------------------------------------------------------------------------

async fn status(State(state): State<AppState>) -> Json<StatusResponse> {
    Json(StatusResponse {
        installed: state.installed.read().await.is_some(),
        supported: vec!["sqlite", "mysql", "postgres"],
    })
}

async fn test_connection(
    State(state): State<AppState>,
    Json(form): Json<ConnectionForm>,
) -> Response {
    if state.installed.read().await.is_some() {
        return err(StatusCode::FORBIDDEN, "already installed");
    }
    let (_kind, url) = match build_url(&form, &state.data_dir) {
        Ok(v) => v,
        Err(e) => return err(StatusCode::BAD_REQUEST, e),
    };
    match db::connect(&url).await {
        Ok(pool) => {
            let _ = pool.close().await;
            (StatusCode::OK, "ok").into_response()
        }
        Err(e) => err(StatusCode::BAD_GATEWAY, e.to_string()),
    }
}

async fn install(
    State(state): State<AppState>,
    Json(req): Json<InstallRequest>,
) -> Response {
    if state.installed.read().await.is_some() {
        return err(StatusCode::FORBIDDEN, "already installed");
    }

    let username = req.admin_username.trim();
    if username.len() < 3 || username.len() > 32 {
        return err(StatusCode::BAD_REQUEST, "admin_username must be 3-32 chars");
    }
    if !username
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
    {
        return err(
            StatusCode::BAD_REQUEST,
            "admin_username: letters, digits, _ or - only",
        );
    }
    if req.admin_password.len() < 6 {
        return err(
            StatusCode::BAD_REQUEST,
            "admin_password must be at least 6 characters",
        );
    }

    let (kind, url) = match build_url(&req.connection, &state.data_dir) {
        Ok(v) => v,
        Err(e) => return err(StatusCode::BAD_REQUEST, e),
    };

    let pool = match db::connect(&url).await {
        Ok(p) => p,
        Err(e) => return err(StatusCode::BAD_GATEWAY, format!("connect: {e}")),
    };

    if let Err(e) = db::migrate(&pool, kind).await {
        return err(StatusCode::BAD_GATEWAY, format!("migrate: {e}"));
    }

    // refuse if any user already exists (safety against re-running install against a used db)
    let count: (i64,) = match sqlx::query_as("SELECT COUNT(*) FROM users")
        .fetch_one(&pool)
        .await
    {
        Ok(v) => v,
        Err(e) => return err(StatusCode::BAD_GATEWAY, e.to_string()),
    };
    if count.0 > 0 {
        return err(
            StatusCode::CONFLICT,
            "this database already has users; refusing to re-install",
        );
    }

    let phc = match auth::hash_password(&req.admin_password) {
        Ok(h) => h,
        Err(e) => return err(StatusCode::INTERNAL_SERVER_ERROR, e),
    };

    let base_insert = db::q(
        kind,
        "INSERT INTO users (username, password_hash) VALUES (?, ?)",
    );
    let admin_id = match kind {
        db::DbKind::Sqlite | db::DbKind::Postgres => {
            let row: Result<(i64,), _> =
                sqlx::query_as(&format!("{base_insert} RETURNING id"))
                    .bind(username)
                    .bind(&phc)
                    .fetch_one(&pool)
                    .await;
            match row {
                Ok((id,)) => id,
                Err(e) => return err(StatusCode::BAD_GATEWAY, e.to_string()),
            }
        }
        db::DbKind::Mysql => {
            let mut tx = match pool.begin().await {
                Ok(t) => t,
                Err(e) => return err(StatusCode::BAD_GATEWAY, e.to_string()),
            };
            if let Err(e) = sqlx::query(&base_insert)
                .bind(username)
                .bind(&phc)
                .execute(&mut *tx)
                .await
            {
                return err(StatusCode::BAD_GATEWAY, e.to_string());
            }
            let row: Result<(i64,), _> = sqlx::query_as("SELECT LAST_INSERT_ID()")
                .fetch_one(&mut *tx)
                .await;
            let id = match row {
                Ok((v,)) => v,
                Err(e) => return err(StatusCode::BAD_GATEWAY, e.to_string()),
            };
            if let Err(e) = tx.commit().await {
                return err(StatusCode::BAD_GATEWAY, e.to_string());
            }
            id
        }
    };

    if let Err(e) = save_config(&state.config_path, &StoredConfig { database_url: url.clone() }) {
        return err(StatusCode::INTERNAL_SERVER_ERROR, format!("write config: {e}"));
    }

    *state.installed.write().await = Some(InstalledState { pool, kind });
    Json(InstallResponse { ok: true, admin_id }).into_response()
}

// ---------------------------------------------------------------------------
// routes
// ---------------------------------------------------------------------------

pub fn routes() -> Router<AppState> {
    Router::new()
        .route("/setup/status", get(status))
        .route("/setup/test", post(test_connection))
        .route("/setup/install", post(install))
}
