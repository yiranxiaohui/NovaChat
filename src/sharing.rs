use axum::{
    Extension, Json, Router,
    extract::{Path, State},
    http::StatusCode,
    response::{IntoResponse, Response},
    routing::{get, post},
};
use rand::RngCore;
use serde::{Deserialize, Serialize};

use crate::{
    AppState, CurrentUser, InstalledState,
    db,
};

// ---------------------------------------------------------------------------
// snapshot shape stored as JSON in shared_conversations.snapshot_json
// ---------------------------------------------------------------------------

#[derive(Serialize, Deserialize)]
struct SnapshotMessage {
    role: String,
    content: String,
    created_at: String,
}

#[derive(Serialize, Deserialize)]
struct Snapshot {
    system_prompt: String,
    messages: Vec<SnapshotMessage>,
}

// ---------------------------------------------------------------------------
// random token — 16 bytes hex (32 chars). Same generator the image module
// uses for unguessable file names.
// ---------------------------------------------------------------------------

fn random_token() -> String {
    let mut bytes = [0u8; 16];
    rand::rngs::OsRng.fill_bytes(&mut bytes);
    hex::encode(bytes)
}

fn err(status: StatusCode, msg: impl Into<String>) -> Response {
    (status, msg.into()).into_response()
}

// ---------------------------------------------------------------------------
// create — POST /api/conversations/{id}/share
// ---------------------------------------------------------------------------

#[derive(Deserialize)]
struct ShareCreateBody {
    /// Days until expiry. None / 0 = never.
    #[serde(default)]
    expires_in_days: Option<i64>,
}

#[derive(Serialize)]
struct ShareCreated {
    token: String,
    path: String,
    title: String,
    created_at: String,
}

async fn create_share(
    Extension(installed): Extension<InstalledState>,
    Extension(user): Extension<CurrentUser>,
    Path(conv_id): Path<i64>,
    Json(body): Json<ShareCreateBody>,
) -> Response {
    let pool = &installed.pool;
    let kind = installed.kind;

    // Verify ownership and grab the live conversation title + system_prompt.
    let conv_sql = db::q(
        kind,
        "SELECT title, system_prompt FROM conversations WHERE id = ? AND user_id = ?",
    );
    let conv_row: Option<(String, String)> = sqlx::query_as(&conv_sql)
        .bind(conv_id)
        .bind(user.id)
        .fetch_optional(pool)
        .await
        .unwrap_or(None);
    let Some((title, system_prompt)) = conv_row else {
        return err(StatusCode::NOT_FOUND, "conversation not found");
    };

    // Pull messages for the snapshot. system role is stored separately in
    // conversations.system_prompt, so messages here are just user/assistant.
    let msg_sql = db::q(
        kind,
        "SELECT role, content, created_at FROM messages
         WHERE conversation_id = ?
         ORDER BY id ASC",
    );
    let msg_rows: Vec<(String, String, String)> = sqlx::query_as(&msg_sql)
        .bind(conv_id)
        .fetch_all(pool)
        .await
        .unwrap_or_default();
    let messages: Vec<SnapshotMessage> = msg_rows
        .into_iter()
        .map(|(role, content, created_at)| SnapshotMessage { role, content, created_at })
        .collect();

    if messages.is_empty() {
        return err(StatusCode::BAD_REQUEST, "对话还没有消息，不能分享");
    }

    let snapshot = Snapshot { system_prompt, messages };
    let snapshot_json = match serde_json::to_string(&snapshot) {
        Ok(s) => s,
        Err(e) => return err(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()),
    };

    // Creator name snapshot — display_name preferred, fall back to username.
    let name_sql = db::q(
        kind,
        "SELECT COALESCE(NULLIF(display_name, ''), username) FROM users WHERE id = ?",
    );
    let creator_name: Option<String> = sqlx::query_as::<_, (String,)>(&name_sql)
        .bind(user.id)
        .fetch_optional(pool)
        .await
        .ok()
        .flatten()
        .map(|(n,)| n);

    let token = random_token();

    // Expiry: a few days from now if requested; NULL otherwise.
    let expires_at: Option<String> = body
        .expires_in_days
        .filter(|d| *d > 0)
        .map(|d| {
            (chrono::Utc::now() + chrono::Duration::days(d))
                .format("%Y-%m-%d %H:%M:%S")
                .to_string()
        });

    let insert_sql = db::q(
        kind,
        "INSERT INTO shared_conversations
            (token, user_id, conversation_id, title, creator_name, snapshot_json, expires_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)",
    );
    if let Err(e) = sqlx::query(&insert_sql)
        .bind(&token)
        .bind(user.id)
        .bind(conv_id)
        .bind(&title)
        .bind(&creator_name)
        .bind(&snapshot_json)
        .bind(&expires_at)
        .execute(pool)
        .await
    {
        return err(StatusCode::INTERNAL_SERVER_ERROR, e.to_string());
    }

    // Pull the created_at back. SQLite/PG fill it with default; we do a SELECT
    // rather than guessing the format. Falls back to a client-side stamp on
    // (unlikely) failure.
    let select_sql = db::q(
        kind,
        "SELECT created_at FROM shared_conversations WHERE token = ?",
    );
    let created_at: String = sqlx::query_as::<_, (String,)>(&select_sql)
        .bind(&token)
        .fetch_one(pool)
        .await
        .map(|(c,)| c)
        .unwrap_or_else(|_| {
            chrono::Utc::now()
                .format("%Y-%m-%d %H:%M:%S")
                .to_string()
        });

    Json(ShareCreated {
        path: format!("/s/{token}"),
        token,
        title,
        created_at,
    })
    .into_response()
}

// ---------------------------------------------------------------------------
// list — GET /api/conversations/{id}/shares + GET /api/my-shares
// ---------------------------------------------------------------------------

#[derive(Serialize)]
struct ShareListRow {
    token: String,
    conversation_id: i64,
    title: String,
    view_count: i64,
    created_at: String,
    expires_at: Option<String>,
}

async fn list_shares_for_conversation(
    Extension(installed): Extension<InstalledState>,
    Extension(user): Extension<CurrentUser>,
    Path(conv_id): Path<i64>,
) -> Response {
    let sql = db::q(
        installed.kind,
        "SELECT token, conversation_id, title, view_count, created_at, expires_at
         FROM shared_conversations
         WHERE user_id = ? AND conversation_id = ?
         ORDER BY created_at DESC",
    );
    let rows: Vec<(String, i64, String, i64, String, Option<String>)> = sqlx::query_as(&sql)
        .bind(user.id)
        .bind(conv_id)
        .fetch_all(&installed.pool)
        .await
        .unwrap_or_default();
    let out: Vec<ShareListRow> = rows
        .into_iter()
        .map(|(token, conversation_id, title, view_count, created_at, expires_at)| ShareListRow {
            token,
            conversation_id,
            title,
            view_count,
            created_at,
            expires_at,
        })
        .collect();
    Json(out).into_response()
}

async fn list_my_shares(
    Extension(installed): Extension<InstalledState>,
    Extension(user): Extension<CurrentUser>,
) -> Response {
    let sql = db::q(
        installed.kind,
        "SELECT token, conversation_id, title, view_count, created_at, expires_at
         FROM shared_conversations
         WHERE user_id = ?
         ORDER BY created_at DESC
         LIMIT 200",
    );
    let rows: Vec<(String, i64, String, i64, String, Option<String>)> = sqlx::query_as(&sql)
        .bind(user.id)
        .fetch_all(&installed.pool)
        .await
        .unwrap_or_default();
    let out: Vec<ShareListRow> = rows
        .into_iter()
        .map(|(token, conversation_id, title, view_count, created_at, expires_at)| ShareListRow {
            token,
            conversation_id,
            title,
            view_count,
            created_at,
            expires_at,
        })
        .collect();
    Json(out).into_response()
}

// ---------------------------------------------------------------------------
// revoke — DELETE /api/shares/{token}
// ---------------------------------------------------------------------------

async fn delete_share(
    Extension(installed): Extension<InstalledState>,
    Extension(user): Extension<CurrentUser>,
    Path(token): Path<String>,
) -> Response {
    let sql = db::q(
        installed.kind,
        "DELETE FROM shared_conversations WHERE token = ? AND user_id = ?",
    );
    let r = sqlx::query(&sql)
        .bind(&token)
        .bind(user.id)
        .execute(&installed.pool)
        .await;
    match r {
        Ok(out) if out.rows_affected() > 0 => StatusCode::NO_CONTENT.into_response(),
        Ok(_) => err(StatusCode::NOT_FOUND, "share not found"),
        Err(e) => err(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()),
    }
}

// ---------------------------------------------------------------------------
// public read — GET /api/shared/{token}
// ---------------------------------------------------------------------------

#[derive(Serialize)]
struct PublicSnapshot {
    token: String,
    title: String,
    creator_name: Option<String>,
    created_at: String,
    system_prompt: String,
    messages: Vec<SnapshotMessage>,
    view_count: i64,
}

async fn get_public_snapshot(
    State(state): State<AppState>,
    Path(token): Path<String>,
) -> Response {
    let installed = match state.require_installed().await {
        Ok(s) => s,
        Err(r) => return r,
    };
    let pool = &installed.pool;
    let kind = installed.kind;

    // Token is hex; reject anything else early so a misbehaving client doesn't
    // hammer the DB with garbage keys.
    if token.len() != 32 || !token.chars().all(|c| c.is_ascii_hexdigit()) {
        return err(StatusCode::NOT_FOUND, "share not found");
    }

    let sql = db::q(
        kind,
        "SELECT title, creator_name, snapshot_json, created_at, view_count, expires_at
         FROM shared_conversations WHERE token = ?",
    );
    let row: Option<(String, Option<String>, String, String, i64, Option<String>)> =
        sqlx::query_as(&sql)
            .bind(&token)
            .fetch_optional(pool)
            .await
            .unwrap_or(None);
    let Some((title, creator_name, snapshot_json, created_at, view_count, expires_at)) = row
    else {
        return err(StatusCode::NOT_FOUND, "share not found");
    };

    // Lazy expiry check — we don't run a sweeper; a viewer's hit is what
    // notices the expiry. Expired rows are returned as 410 Gone so the UI can
    // distinguish "never existed" from "was here but is gone".
    if let Some(exp) = expires_at.as_deref() {
        let now = chrono::Utc::now().format("%Y-%m-%d %H:%M:%S").to_string();
        if exp < now.as_str() {
            return err(StatusCode::GONE, "分享链接已过期");
        }
    }

    let snap: Snapshot = match serde_json::from_str(&snapshot_json) {
        Ok(s) => s,
        Err(_) => {
            // Corrupted snapshot — treat as 404 from the viewer's perspective.
            return err(StatusCode::NOT_FOUND, "share not found");
        }
    };

    // Bump view_count. Best-effort: any failure here doesn't change the
    // response. Skipped for the owner-of-the-share so they can preview
    // without inflating the counter — but the public endpoint has no auth
    // context, so we just always bump.
    let bump_sql = db::q(
        kind,
        "UPDATE shared_conversations SET view_count = view_count + 1 WHERE token = ?",
    );
    let _ = sqlx::query(&bump_sql).bind(&token).execute(pool).await;

    Json(PublicSnapshot {
        token,
        title,
        creator_name,
        created_at,
        system_prompt: snap.system_prompt,
        messages: snap.messages,
        view_count: view_count + 1,
    })
    .into_response()
}

// ---------------------------------------------------------------------------
// routes
// ---------------------------------------------------------------------------

pub fn user_routes() -> Router<AppState> {
    Router::new()
        .route("/conversations/{id}/share", post(create_share))
        .route("/conversations/{id}/shares", get(list_shares_for_conversation))
        .route("/my-shares", get(list_my_shares))
        .route("/shares/{token}", axum::routing::delete(delete_share))
}

pub fn public_routes() -> Router<AppState> {
    Router::new().route("/shared/{token}", get(get_public_snapshot))
}
