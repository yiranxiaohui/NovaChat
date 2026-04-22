use axum::{
    Extension, Json, Router,
    extract::{Path, State},
    http::StatusCode,
    middleware::{self, Next},
    response::{IntoResponse, Response},
    routing::{get, patch, post},
};
use serde::{Deserialize, Serialize};

use crate::{
    AppState, CurrentUser, InstalledState, auth,
    db::{self, DbKind, Pool},
};

#[derive(Serialize)]
pub struct AdminUser {
    pub id: i64,
    pub username: String,
    pub display_name: Option<String>,
    pub avatar_url: Option<String>,
    pub is_admin: bool,
    pub created_at: String,
    pub conversations: i64,
    pub messages: i64,
    pub skills: i64,
}

#[derive(Serialize)]
pub struct AdminStats {
    pub users: i64,
    pub admins: i64,
    pub conversations: i64,
    pub messages: i64,
    pub skills: i64,
    pub public_skills: i64,
    pub prompts: i64,
    pub public_prompts: i64,
    pub plaza_images: i64,
    pub sessions: i64,
}

#[derive(Serialize)]
pub struct AdminInviteRow {
    pub inviter_id: i64,
    pub inviter_username: String,
    pub inviter_code: Option<String>,
    pub invitee_id: i64,
    pub invitee_username: String,
    pub invitee_created_at: String,
}

#[derive(Serialize)]
pub struct AdminSystemInfo {
    pub version: &'static str,
    pub db_kind: &'static str,
    pub data_dir: String,
    pub config_path: String,
    pub bind_addr: String,
    pub images_dir_bytes: u64,
}

#[derive(Deserialize)]
pub struct UpdateUser {
    pub is_admin: Option<bool>,
    pub display_name: Option<String>,
    pub password: Option<String>,
}

fn err(status: StatusCode, msg: impl Into<String>) -> Response {
    (status, msg.into()).into_response()
}

pub async fn is_admin(pool: &Pool, kind: DbKind, user_id: i64) -> bool {
    let sql = db::q(kind, "SELECT is_admin FROM users WHERE id = ?");
    let row: Option<(i64,)> = sqlx::query_as(&sql)
        .bind(user_id)
        .fetch_optional(pool)
        .await
        .ok()
        .flatten();
    matches!(row, Some((v,)) if v != 0)
}

pub async fn require_admin(
    Extension(installed): Extension<InstalledState>,
    Extension(user): Extension<CurrentUser>,
    req: axum::extract::Request,
    next: Next,
) -> Response {
    if !is_admin(&installed.pool, installed.kind, user.id).await {
        return (StatusCode::FORBIDDEN, "admin only").into_response();
    }
    next.run(req).await
}

async fn scalar_i64(pool: &Pool, kind: DbKind, sql: &str) -> i64 {
    let q = db::q(kind, sql);
    let row: Option<(i64,)> = sqlx::query_as(&q).fetch_optional(pool).await.ok().flatten();
    row.map(|(v,)| v).unwrap_or(0)
}

async fn get_stats(Extension(installed): Extension<InstalledState>) -> Response {
    let true_lit = db::bool_true(installed.kind);
    let stats = AdminStats {
        users: scalar_i64(&installed.pool, installed.kind, "SELECT COUNT(*) FROM users").await,
        admins: scalar_i64(
            &installed.pool,
            installed.kind,
            &format!("SELECT COUNT(*) FROM users WHERE is_admin = {true_lit}"),
        )
        .await,
        conversations: scalar_i64(
            &installed.pool,
            installed.kind,
            "SELECT COUNT(*) FROM conversations",
        )
        .await,
        messages: scalar_i64(&installed.pool, installed.kind, "SELECT COUNT(*) FROM messages").await,
        skills: scalar_i64(&installed.pool, installed.kind, "SELECT COUNT(*) FROM skills").await,
        public_skills: scalar_i64(
            &installed.pool,
            installed.kind,
            &format!("SELECT COUNT(*) FROM skills WHERE is_public = {true_lit}"),
        )
        .await,
        prompts: scalar_i64(&installed.pool, installed.kind, "SELECT COUNT(*) FROM prompts").await,
        public_prompts: scalar_i64(
            &installed.pool,
            installed.kind,
            &format!("SELECT COUNT(*) FROM prompts WHERE is_public = {true_lit}"),
        )
        .await,
        plaza_images: scalar_i64(
            &installed.pool,
            installed.kind,
            "SELECT COUNT(*) FROM plaza_images",
        )
        .await,
        sessions: scalar_i64(
            &installed.pool,
            installed.kind,
            "SELECT COUNT(*) FROM sessions",
        )
        .await,
    };
    Json(stats).into_response()
}

async fn list_users(Extension(installed): Extension<InstalledState>) -> Response {
    let admin_col = db::bool_as_int(installed.kind, "u.is_admin");
    let sql = db::q(
        installed.kind,
        &format!(
            "SELECT u.id, u.username, u.display_name, u.avatar_url, {admin_col}, u.created_at,
                    (SELECT COUNT(*) FROM conversations c WHERE c.user_id = u.id) AS convs,
                    (SELECT COUNT(*) FROM messages m
                        JOIN conversations c ON c.id = m.conversation_id
                        WHERE c.user_id = u.id) AS msgs,
                    (SELECT COUNT(*) FROM skills s WHERE s.user_id = u.id) AS skl
             FROM users u
             ORDER BY u.id ASC"
        ),
    );
    let rows: Result<
        Vec<(i64, String, Option<String>, Option<String>, i64, String, i64, i64, i64)>,
        _,
    > = sqlx::query_as(&sql).fetch_all(&installed.pool).await;
    match rows {
        Ok(rs) => {
            let out: Vec<AdminUser> = rs
                .into_iter()
                .map(
                    |(id, username, display_name, avatar_url, is_admin, created_at, c, m, s)| {
                        AdminUser {
                            id,
                            username,
                            display_name,
                            avatar_url,
                            is_admin: is_admin != 0,
                            created_at,
                            conversations: c,
                            messages: m,
                            skills: s,
                        }
                    },
                )
                .collect();
            Json(out).into_response()
        }
        Err(e) => err(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()),
    }
}

async fn count_admins(pool: &Pool, kind: DbKind) -> i64 {
    let true_lit = db::bool_true(kind);
    scalar_i64(
        pool,
        kind,
        &format!("SELECT COUNT(*) FROM users WHERE is_admin = {true_lit}"),
    )
    .await
}

async fn update_user(
    Extension(installed): Extension<InstalledState>,
    Extension(current): Extension<CurrentUser>,
    Path(id): Path<i64>,
    Json(body): Json<UpdateUser>,
) -> Response {
    if body.is_admin.is_none() && body.display_name.is_none() && body.password.is_none() {
        return err(StatusCode::BAD_REQUEST, "nothing to update");
    }

    if let Some(false) = body.is_admin {
        if id == current.id {
            return err(StatusCode::BAD_REQUEST, "cannot demote yourself");
        }
        if count_admins(&installed.pool, installed.kind).await <= 1 {
            return err(StatusCode::BAD_REQUEST, "cannot demote the last admin");
        }
    }

    if let Some(ref pw) = body.password {
        if pw.len() < 6 || pw.len() > 256 {
            return err(StatusCode::BAD_REQUEST, "password must be 6-256 characters");
        }
    }

    if let Some(flag) = body.is_admin {
        let sql = db::q(installed.kind, "UPDATE users SET is_admin = ? WHERE id = ?");
        if let Err(e) = sqlx::query(&sql)
            .bind(flag)
            .bind(id)
            .execute(&installed.pool)
            .await
        {
            return err(StatusCode::INTERNAL_SERVER_ERROR, e.to_string());
        }
    }

    if let Some(name) = body.display_name {
        let trimmed: String = name.chars().filter(|c| !c.is_control()).collect();
        let trimmed = trimmed.trim();
        let value = if trimmed.is_empty() { None } else { Some(trimmed.to_string()) };
        let sql = db::q(
            installed.kind,
            "UPDATE users SET display_name = ? WHERE id = ?",
        );
        if let Err(e) = sqlx::query(&sql)
            .bind(value)
            .bind(id)
            .execute(&installed.pool)
            .await
        {
            return err(StatusCode::INTERNAL_SERVER_ERROR, e.to_string());
        }
    }

    if let Some(pw) = body.password {
        let hash = match auth::hash_password(&pw) {
            Ok(h) => h,
            Err(e) => return err(StatusCode::INTERNAL_SERVER_ERROR, e),
        };
        let sql = db::q(
            installed.kind,
            "UPDATE users SET password_hash = ? WHERE id = ?",
        );
        if let Err(e) = sqlx::query(&sql)
            .bind(&hash)
            .bind(id)
            .execute(&installed.pool)
            .await
        {
            return err(StatusCode::INTERNAL_SERVER_ERROR, e.to_string());
        }
        let del = db::q(installed.kind, "DELETE FROM sessions WHERE user_id = ?");
        let _ = sqlx::query(&del)
            .bind(id)
            .execute(&installed.pool)
            .await;
    }

    StatusCode::NO_CONTENT.into_response()
}

async fn delete_user(
    Extension(installed): Extension<InstalledState>,
    Extension(current): Extension<CurrentUser>,
    Path(id): Path<i64>,
) -> Response {
    if id == current.id {
        return err(StatusCode::BAD_REQUEST, "cannot delete yourself");
    }
    let admin_sql = db::q(installed.kind, "SELECT is_admin FROM users WHERE id = ?");
    let target_admin: Option<(i64,)> = sqlx::query_as(&admin_sql)
        .bind(id)
        .fetch_optional(&installed.pool)
        .await
        .ok()
        .flatten();
    let Some((flag,)) = target_admin else {
        return err(StatusCode::NOT_FOUND, "user not found");
    };
    if flag != 0 && count_admins(&installed.pool, installed.kind).await <= 1 {
        return err(StatusCode::BAD_REQUEST, "cannot delete the last admin");
    }

    let sql = db::q(installed.kind, "DELETE FROM users WHERE id = ?");
    match sqlx::query(&sql)
        .bind(id)
        .execute(&installed.pool)
        .await
    {
        Ok(r) if r.rows_affected() > 0 => StatusCode::NO_CONTENT.into_response(),
        Ok(_) => err(StatusCode::NOT_FOUND, "user not found"),
        Err(e) => err(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()),
    }
}

async fn list_invites(Extension(installed): Extension<InstalledState>) -> Response {
    let sql = db::q(
        installed.kind,
        "SELECT inviter.id, inviter.username, inviter.invite_code,
                invitee.id, invitee.username, invitee.created_at
         FROM users invitee
         JOIN users inviter ON inviter.id = invitee.invited_by
         ORDER BY invitee.created_at DESC, invitee.id DESC
         LIMIT 500",
    );
    let rows: Result<Vec<(i64, String, Option<String>, i64, String, String)>, _> =
        sqlx::query_as(&sql).fetch_all(&installed.pool).await;
    match rows {
        Ok(rs) => {
            let out: Vec<AdminInviteRow> = rs
                .into_iter()
                .map(
                    |(inviter_id, inviter_username, inviter_code, invitee_id, invitee_username, invitee_created_at)| {
                        AdminInviteRow {
                            inviter_id,
                            inviter_username,
                            inviter_code,
                            invitee_id,
                            invitee_username,
                            invitee_created_at,
                        }
                    },
                )
                .collect();
            Json(out).into_response()
        }
        Err(e) => err(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()),
    }
}

async fn get_system_info(
    State(state): State<AppState>,
    Extension(installed): Extension<InstalledState>,
) -> Response {
    let images_dir = state.data_dir.join("images");
    let images_dir_bytes = dir_size_bytes(&images_dir).await;

    let info = AdminSystemInfo {
        version: env!("CARGO_PKG_VERSION"),
        db_kind: installed.kind.as_str(),
        data_dir: state.data_dir.display().to_string(),
        config_path: state.config_path.display().to_string(),
        bind_addr: std::env::var("NOVACHAT_BIND").unwrap_or_else(|_| "127.0.0.1:3000".into()),
        images_dir_bytes,
    };
    Json(info).into_response()
}

async fn dir_size_bytes(path: &std::path::Path) -> u64 {
    let mut total: u64 = 0;
    let mut stack = vec![path.to_path_buf()];
    while let Some(p) = stack.pop() {
        let Ok(mut rd) = tokio::fs::read_dir(&p).await else {
            continue;
        };
        while let Ok(Some(entry)) = rd.next_entry().await {
            let Ok(meta) = entry.metadata().await else {
                continue;
            };
            if meta.is_dir() {
                stack.push(entry.path());
            } else {
                total = total.saturating_add(meta.len());
            }
        }
    }
    total
}

async fn prune_sessions(Extension(installed): Extension<InstalledState>) -> Response {
    let sql = db::q(
        installed.kind,
        "DELETE FROM sessions WHERE expires_at < ?",
    );
    let now = chrono::Utc::now().to_rfc3339();
    match sqlx::query(&sql)
        .bind(&now)
        .execute(&installed.pool)
        .await
    {
        Ok(r) => Json(serde_json::json!({ "removed": r.rows_affected() })).into_response(),
        Err(e) => err(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()),
    }
}

pub fn routes() -> Router<AppState> {
    Router::new()
        .route("/admin/stats", get(get_stats))
        .route("/admin/system", get(get_system_info))
        .route("/admin/users", get(list_users))
        .route("/admin/users/{id}", patch(update_user).delete(delete_user))
        .route("/admin/invites", get(list_invites))
        .route("/admin/sessions/prune", post(prune_sessions))
        .route_layer(middleware::from_fn(require_admin))
}
