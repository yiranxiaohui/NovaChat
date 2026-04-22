use axum::{
    Extension, Json, Router,
    extract::{Path, Query},
    http::StatusCode,
    middleware,
    response::{IntoResponse, Response},
    routing::{get, patch},
};
use serde::{Deserialize, Serialize};

use crate::{
    AppState, CurrentUser, InstalledState, admin,
    db::{self, DbKind, Pool},
};

// ---------------------------------------------------------------------------
// app-wide settings (KV)
// ---------------------------------------------------------------------------

pub async fn get_setting(pool: &Pool, kind: DbKind, key: &str) -> Option<String> {
    let sql = db::q(kind, "SELECT v FROM app_settings WHERE k = ?");
    let row: Option<(String,)> = sqlx::query_as(&sql)
        .bind(key)
        .fetch_optional(pool)
        .await
        .ok()
        .flatten();
    row.map(|(v,)| v)
}

pub async fn get_setting_i64(pool: &Pool, kind: DbKind, key: &str, default: i64) -> i64 {
    get_setting(pool, kind, key)
        .await
        .and_then(|s| s.parse::<i64>().ok())
        .unwrap_or(default)
}

pub async fn get_setting_bool(pool: &Pool, kind: DbKind, key: &str, default: bool) -> bool {
    match get_setting(pool, kind, key).await.as_deref() {
        Some("true" | "1" | "yes") => true,
        Some("false" | "0" | "no") => false,
        _ => default,
    }
}

pub async fn set_setting(
    pool: &Pool,
    kind: DbKind,
    key: &str,
    val: &str,
) -> Result<(), sqlx::Error> {
    let now = db::now_expr(kind);
    let sql = match kind {
        DbKind::Sqlite => {
            format!(
                "INSERT INTO app_settings (k, v, updated_at) VALUES (?, ?, {now})
                 ON CONFLICT(k) DO UPDATE SET v = excluded.v, updated_at = {now}"
            )
        }
        DbKind::Postgres => format!(
            "INSERT INTO app_settings (k, v, updated_at) VALUES (?, ?, {now})
             ON CONFLICT (k) DO UPDATE SET v = EXCLUDED.v, updated_at = {now}"
        ),
        DbKind::Mysql => format!(
            "INSERT INTO app_settings (`k`, `v`, updated_at) VALUES (?, ?, {now})
             ON DUPLICATE KEY UPDATE `v` = VALUES(`v`), updated_at = {now}"
        ),
    };
    let sql = db::q(kind, &sql);
    sqlx::query(&sql)
        .bind(key)
        .bind(val)
        .execute(pool)
        .await
        .map(|_| ())
}

// ---------------------------------------------------------------------------
// credit balance + deduction
// ---------------------------------------------------------------------------

/// Ensures a user_credits row exists. Returns the user's current balance.
pub async fn ensure_account(pool: &Pool, kind: DbKind, user_id: i64) -> Result<i64, sqlx::Error> {
    let sql = db::q(
        kind,
        "SELECT balance FROM user_credits WHERE user_id = ?",
    );
    let existing: Option<(i64,)> = sqlx::query_as(&sql)
        .bind(user_id)
        .fetch_optional(pool)
        .await?;
    if let Some((b,)) = existing {
        return Ok(b);
    }

    let initial = get_setting_i64(pool, kind, "signup_grant", 200).await.max(0);
    let ins = db::q(
        kind,
        "INSERT INTO user_credits (user_id, balance) VALUES (?, ?)",
    );
    // Best-effort; race is harmless (UNIQUE on user_id).
    let _ = sqlx::query(&ins)
        .bind(user_id)
        .bind(initial)
        .execute(pool)
        .await;

    if initial > 0 {
        let led = db::q(
            kind,
            "INSERT INTO credit_ledger (user_id, delta, reason) VALUES (?, ?, ?)",
        );
        let _ = sqlx::query(&led)
            .bind(user_id)
            .bind(initial)
            .bind("signup_grant")
            .execute(pool)
            .await;
    }

    let sql2 = db::q(kind, "SELECT balance FROM user_credits WHERE user_id = ?");
    let (b,): (i64,) = sqlx::query_as(&sql2)
        .bind(user_id)
        .fetch_one(pool)
        .await?;
    Ok(b)
}

/// Atomically deduct `cost` credits if balance is sufficient.
/// Returns `Ok(new_balance)` on success, `Err(current_balance)` on insufficient funds.
pub async fn try_deduct(
    pool: &Pool,
    kind: DbKind,
    user_id: i64,
    cost: i64,
    reason: &str,
) -> Result<i64, i64> {
    if cost <= 0 {
        let b = ensure_account(pool, kind, user_id).await.unwrap_or(0);
        return Ok(b);
    }
    if let Err(_) = ensure_account(pool, kind, user_id).await {
        return Err(0);
    }

    let now = db::now_expr(kind);
    let sql = db::q(
        kind,
        &format!(
            "UPDATE user_credits
             SET balance = balance - ?, lifetime_used = lifetime_used + ?, updated_at = {now}
             WHERE user_id = ? AND balance >= ?"
        ),
    );
    let affected = sqlx::query(&sql)
        .bind(cost)
        .bind(cost)
        .bind(user_id)
        .bind(cost)
        .execute(pool)
        .await
        .map(|r| r.rows_affected())
        .unwrap_or(0);

    if affected == 0 {
        let bal_sql = db::q(kind, "SELECT balance FROM user_credits WHERE user_id = ?");
        let b: Option<(i64,)> = sqlx::query_as(&bal_sql)
            .bind(user_id)
            .fetch_optional(pool)
            .await
            .ok()
            .flatten();
        return Err(b.map(|(v,)| v).unwrap_or(0));
    }

    let led = db::q(
        kind,
        "INSERT INTO credit_ledger (user_id, delta, reason) VALUES (?, ?, ?)",
    );
    let _ = sqlx::query(&led)
        .bind(user_id)
        .bind(-cost)
        .bind(reason)
        .execute(pool)
        .await;

    let bal_sql = db::q(kind, "SELECT balance FROM user_credits WHERE user_id = ?");
    let (b,): (i64,) = sqlx::query_as(&bal_sql)
        .bind(user_id)
        .fetch_one(pool)
        .await
        .unwrap_or((0,));
    Ok(b)
}

pub async fn grant(
    pool: &Pool,
    kind: DbKind,
    user_id: i64,
    delta: i64,
    reason: &str,
) -> Result<i64, sqlx::Error> {
    ensure_account(pool, kind, user_id).await?;
    let now = db::now_expr(kind);
    let sql = db::q(
        kind,
        &format!(
            "UPDATE user_credits
             SET balance = balance + ?, updated_at = {now}
             WHERE user_id = ?"
        ),
    );
    sqlx::query(&sql)
        .bind(delta)
        .bind(user_id)
        .execute(pool)
        .await?;
    let led = db::q(
        kind,
        "INSERT INTO credit_ledger (user_id, delta, reason) VALUES (?, ?, ?)",
    );
    let _ = sqlx::query(&led)
        .bind(user_id)
        .bind(delta)
        .bind(reason)
        .execute(pool)
        .await;
    let bal_sql = db::q(kind, "SELECT balance FROM user_credits WHERE user_id = ?");
    let (b,): (i64,) = sqlx::query_as(&bal_sql)
        .bind(user_id)
        .fetch_one(pool)
        .await?;
    Ok(b)
}

/// Overwrite balance to an exact value (admin action).
pub async fn set_balance(
    pool: &Pool,
    kind: DbKind,
    user_id: i64,
    new_balance: i64,
    reason: &str,
) -> Result<i64, sqlx::Error> {
    let before = ensure_account(pool, kind, user_id).await?;
    let delta = new_balance - before;
    let now = db::now_expr(kind);
    let sql = db::q(
        kind,
        &format!(
            "UPDATE user_credits
             SET balance = ?, updated_at = {now}
             WHERE user_id = ?"
        ),
    );
    sqlx::query(&sql)
        .bind(new_balance)
        .bind(user_id)
        .execute(pool)
        .await?;
    if delta != 0 {
        let led = db::q(
            kind,
            "INSERT INTO credit_ledger (user_id, delta, reason) VALUES (?, ?, ?)",
        );
        let _ = sqlx::query(&led)
            .bind(user_id)
            .bind(delta)
            .bind(reason)
            .execute(pool)
            .await;
    }
    Ok(new_balance)
}

// ---------------------------------------------------------------------------
// user-facing endpoints
// ---------------------------------------------------------------------------

#[derive(Serialize)]
struct CreditsMe {
    balance: i64,
    lifetime_used: i64,
    cost_chat: i64,
    cost_image: i64,
}

async fn get_my_credits(
    Extension(installed): Extension<InstalledState>,
    Extension(user): Extension<CurrentUser>,
) -> Response {
    let _ = ensure_account(&installed.pool, installed.kind, user.id).await;
    let sql = db::q(
        installed.kind,
        "SELECT balance, lifetime_used FROM user_credits WHERE user_id = ?",
    );
    let row: (i64, i64) = sqlx::query_as(&sql)
        .bind(user.id)
        .fetch_one(&installed.pool)
        .await
        .unwrap_or((0, 0));
    let cost_chat = get_setting_i64(&installed.pool, installed.kind, "cost_chat", 1).await;
    let cost_image = get_setting_i64(&installed.pool, installed.kind, "cost_image", 5).await;
    Json(CreditsMe {
        balance: row.0,
        lifetime_used: row.1,
        cost_chat,
        cost_image,
    })
    .into_response()
}

#[derive(Serialize)]
struct LedgerEntry {
    id: i64,
    delta: i64,
    reason: String,
    created_at: String,
}

#[derive(Deserialize)]
struct LedgerQuery {
    page: Option<i64>,
}

async fn get_my_ledger(
    Extension(installed): Extension<InstalledState>,
    Extension(user): Extension<CurrentUser>,
    Query(q): Query<LedgerQuery>,
) -> Response {
    let page = q.page.unwrap_or(1).max(1);
    let per_page: i64 = 30;
    let offset = (page - 1) * per_page;
    let sql = db::q(
        installed.kind,
        "SELECT id, delta, reason, created_at FROM credit_ledger
         WHERE user_id = ?
         ORDER BY created_at DESC, id DESC
         LIMIT ? OFFSET ?",
    );
    let rows: Result<Vec<(i64, i64, String, String)>, _> = sqlx::query_as(&sql)
        .bind(user.id)
        .bind(per_page)
        .bind(offset)
        .fetch_all(&installed.pool)
        .await;
    match rows {
        Ok(rs) => {
            let out: Vec<LedgerEntry> = rs
                .into_iter()
                .map(|(id, delta, reason, created_at)| LedgerEntry {
                    id,
                    delta,
                    reason,
                    created_at,
                })
                .collect();
            Json(out).into_response()
        }
        Err(e) => (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()).into_response(),
    }
}

// ---------------------------------------------------------------------------
// shared-backend status (client-visible, safe)
// ---------------------------------------------------------------------------

#[derive(Serialize)]
struct SharedStatus {
    enabled: bool,
    openai_available: bool,
    claude_available: bool,
    gemini_available: bool,
    image_openai_available: bool,
    image_gemini_available: bool,
    // Admin-configured default models (empty string when not set). The client
    // renders these as read-only when shared mode is on — users can't pick a
    // different model on shared credits.
    chat_openai_model: String,
    chat_claude_model: String,
    chat_gemini_model: String,
    image_openai_model: String,
    image_gemini_model: String,
    cost_chat: i64,
    cost_image: i64,
    balance: i64,
}

pub async fn read_shared(
    pool: &Pool,
    kind: DbKind,
    protocol: &str,
    flavor: SharedFlavor,
) -> Option<SharedUpstream> {
    let enabled = get_setting_bool(pool, kind, "shared_enabled", false).await;
    if !enabled {
        return None;
    }
    let prefix = match flavor {
        SharedFlavor::Chat => "shared_chat_",
        SharedFlavor::Image => "shared_image_",
    };
    let url = get_setting(pool, kind, &format!("{prefix}{protocol}_url")).await;
    let key = get_setting(pool, kind, &format!("{prefix}{protocol}_key")).await;
    let model = get_setting(pool, kind, &format!("{prefix}{protocol}_model")).await;
    match (url, key) {
        (Some(u), Some(k)) if !u.is_empty() && !k.is_empty() => Some(SharedUpstream {
            url: u,
            key: k,
            model: model.filter(|s| !s.is_empty()),
        }),
        _ => None,
    }
}

#[derive(Clone, Copy)]
pub enum SharedFlavor {
    Chat,
    Image,
}

pub struct SharedUpstream {
    pub url: String,
    pub key: String,
    pub model: Option<String>,
}

async fn get_shared_status(
    Extension(installed): Extension<InstalledState>,
    Extension(user): Extension<CurrentUser>,
) -> Response {
    let enabled =
        get_setting_bool(&installed.pool, installed.kind, "shared_enabled", false).await;
    let openai_available =
        read_shared(&installed.pool, installed.kind, "openai", SharedFlavor::Chat)
            .await
            .is_some();
    let claude_available =
        read_shared(&installed.pool, installed.kind, "claude", SharedFlavor::Chat)
            .await
            .is_some();
    let gemini_available =
        read_shared(&installed.pool, installed.kind, "gemini", SharedFlavor::Chat)
            .await
            .is_some();
    let image_openai_available =
        read_shared(&installed.pool, installed.kind, "openai", SharedFlavor::Image)
            .await
            .is_some();
    let image_gemini_available =
        read_shared(&installed.pool, installed.kind, "gemini", SharedFlavor::Image)
            .await
            .is_some();
    let cost_chat = get_setting_i64(&installed.pool, installed.kind, "cost_chat", 1).await;
    let cost_image = get_setting_i64(&installed.pool, installed.kind, "cost_image", 5).await;
    let _ = ensure_account(&installed.pool, installed.kind, user.id).await;
    let bal_sql = db::q(
        installed.kind,
        "SELECT balance FROM user_credits WHERE user_id = ?",
    );
    let (balance,): (i64,) = sqlx::query_as(&bal_sql)
        .bind(user.id)
        .fetch_one(&installed.pool)
        .await
        .unwrap_or((0,));

    let chat_openai_model =
        get_setting(&installed.pool, installed.kind, "shared_chat_openai_model")
            .await
            .unwrap_or_default();
    let chat_claude_model =
        get_setting(&installed.pool, installed.kind, "shared_chat_claude_model")
            .await
            .unwrap_or_default();
    let chat_gemini_model =
        get_setting(&installed.pool, installed.kind, "shared_chat_gemini_model")
            .await
            .unwrap_or_default();
    let image_openai_model =
        get_setting(&installed.pool, installed.kind, "shared_image_openai_model")
            .await
            .unwrap_or_default();
    let image_gemini_model =
        get_setting(&installed.pool, installed.kind, "shared_image_gemini_model")
            .await
            .unwrap_or_default();

    Json(SharedStatus {
        enabled,
        openai_available,
        claude_available,
        gemini_available,
        image_openai_available,
        image_gemini_available,
        chat_openai_model,
        chat_claude_model,
        chat_gemini_model,
        image_openai_model,
        image_gemini_model,
        cost_chat,
        cost_image,
        balance,
    })
    .into_response()
}

// ---------------------------------------------------------------------------
// admin endpoints
// ---------------------------------------------------------------------------

#[derive(Serialize)]
struct AdminSettingsView {
    shared_enabled: bool,
    signup_grant: i64,
    cost_chat: i64,
    cost_image: i64,
    invite_grant_inviter: i64,
    invite_grant_invitee: i64,
    // upstream URLs (returned as-is)
    shared_chat_openai_url: String,
    shared_chat_claude_url: String,
    shared_chat_gemini_url: String,
    shared_image_openai_url: String,
    shared_image_gemini_url: String,
    // default model hints
    shared_chat_openai_model: String,
    shared_chat_claude_model: String,
    shared_chat_gemini_model: String,
    shared_image_openai_model: String,
    shared_image_gemini_model: String,
    // keys are never returned — show presence only
    shared_chat_openai_key_set: bool,
    shared_chat_claude_key_set: bool,
    shared_chat_gemini_key_set: bool,
    shared_image_openai_key_set: bool,
    shared_image_gemini_key_set: bool,
    // email verification + SMTP
    email_verification_required: bool,
    smtp_host: String,
    smtp_port: i64,
    smtp_username: String,
    smtp_from_email: String,
    smtp_from_name: String,
    smtp_security: String,
    smtp_password_set: bool,
}

async fn admin_get_settings(Extension(installed): Extension<InstalledState>) -> Response {
    let pool = &installed.pool;
    let kind = installed.kind;

    async fn s(pool: &Pool, kind: DbKind, key: &str) -> String {
        get_setting(pool, kind, key).await.unwrap_or_default()
    }
    async fn has(pool: &Pool, kind: DbKind, key: &str) -> bool {
        get_setting(pool, kind, key)
            .await
            .map(|v| !v.is_empty())
            .unwrap_or(false)
    }

    let view = AdminSettingsView {
        shared_enabled: get_setting_bool(pool, kind, "shared_enabled", false).await,
        signup_grant: get_setting_i64(pool, kind, "signup_grant", 200).await,
        cost_chat: get_setting_i64(pool, kind, "cost_chat", 1).await,
        cost_image: get_setting_i64(pool, kind, "cost_image", 5).await,
        invite_grant_inviter: get_setting_i64(pool, kind, "invite_grant_inviter", 100).await,
        invite_grant_invitee: get_setting_i64(pool, kind, "invite_grant_invitee", 100).await,
        shared_chat_openai_url: s(pool, kind, "shared_chat_openai_url").await,
        shared_chat_claude_url: s(pool, kind, "shared_chat_claude_url").await,
        shared_chat_gemini_url: s(pool, kind, "shared_chat_gemini_url").await,
        shared_image_openai_url: s(pool, kind, "shared_image_openai_url").await,
        shared_image_gemini_url: s(pool, kind, "shared_image_gemini_url").await,
        shared_chat_openai_model: s(pool, kind, "shared_chat_openai_model").await,
        shared_chat_claude_model: s(pool, kind, "shared_chat_claude_model").await,
        shared_chat_gemini_model: s(pool, kind, "shared_chat_gemini_model").await,
        shared_image_openai_model: s(pool, kind, "shared_image_openai_model").await,
        shared_image_gemini_model: s(pool, kind, "shared_image_gemini_model").await,
        shared_chat_openai_key_set: has(pool, kind, "shared_chat_openai_key").await,
        shared_chat_claude_key_set: has(pool, kind, "shared_chat_claude_key").await,
        shared_chat_gemini_key_set: has(pool, kind, "shared_chat_gemini_key").await,
        shared_image_openai_key_set: has(pool, kind, "shared_image_openai_key").await,
        shared_image_gemini_key_set: has(pool, kind, "shared_image_gemini_key").await,
        email_verification_required: get_setting_bool(pool, kind, "email_verification_required", false).await,
        smtp_host: s(pool, kind, "smtp_host").await,
        smtp_port: get_setting_i64(pool, kind, "smtp_port", 587).await,
        smtp_username: s(pool, kind, "smtp_username").await,
        smtp_from_email: s(pool, kind, "smtp_from_email").await,
        smtp_from_name: s(pool, kind, "smtp_from_name").await,
        smtp_security: {
            let raw = s(pool, kind, "smtp_security").await;
            if raw.is_empty() { "starttls".into() } else { raw }
        },
        smtp_password_set: has(pool, kind, "smtp_password").await,
    };
    Json(view).into_response()
}

#[derive(Deserialize)]
struct AdminSettingsUpdate {
    shared_enabled: Option<bool>,
    signup_grant: Option<i64>,
    cost_chat: Option<i64>,
    cost_image: Option<i64>,
    invite_grant_inviter: Option<i64>,
    invite_grant_invitee: Option<i64>,
    shared_chat_openai_url: Option<String>,
    shared_chat_claude_url: Option<String>,
    shared_chat_gemini_url: Option<String>,
    shared_image_openai_url: Option<String>,
    shared_image_gemini_url: Option<String>,
    shared_chat_openai_model: Option<String>,
    shared_chat_claude_model: Option<String>,
    shared_chat_gemini_model: Option<String>,
    shared_image_openai_model: Option<String>,
    shared_image_gemini_model: Option<String>,
    // keys: absent = unchanged, "" = clear, non-empty = set
    shared_chat_openai_key: Option<String>,
    shared_chat_claude_key: Option<String>,
    shared_chat_gemini_key: Option<String>,
    shared_image_openai_key: Option<String>,
    shared_image_gemini_key: Option<String>,
    // email verification + SMTP
    email_verification_required: Option<bool>,
    smtp_host: Option<String>,
    smtp_port: Option<i64>,
    smtp_username: Option<String>,
    smtp_password: Option<String>,
    smtp_from_email: Option<String>,
    smtp_from_name: Option<String>,
    smtp_security: Option<String>,
}

async fn admin_patch_settings(
    Extension(installed): Extension<InstalledState>,
    Json(body): Json<AdminSettingsUpdate>,
) -> Response {
    let pool = &installed.pool;
    let kind = installed.kind;

    async fn maybe_set(
        pool: &Pool,
        kind: DbKind,
        key: &str,
        val: Option<&str>,
    ) -> Result<(), sqlx::Error> {
        if let Some(v) = val {
            set_setting(pool, kind, key, v).await?;
        }
        Ok(())
    }

    let ops: Vec<(&str, Option<String>)> = vec![
        ("shared_enabled", body.shared_enabled.map(|b| b.to_string())),
        ("signup_grant", body.signup_grant.map(|v| v.max(0).to_string())),
        ("cost_chat", body.cost_chat.map(|v| v.max(0).to_string())),
        ("cost_image", body.cost_image.map(|v| v.max(0).to_string())),
        ("invite_grant_inviter", body.invite_grant_inviter.map(|v| v.max(0).to_string())),
        ("invite_grant_invitee", body.invite_grant_invitee.map(|v| v.max(0).to_string())),
        ("shared_chat_openai_url", body.shared_chat_openai_url.map(|s| s.trim().to_string())),
        ("shared_chat_claude_url", body.shared_chat_claude_url.map(|s| s.trim().to_string())),
        ("shared_chat_gemini_url", body.shared_chat_gemini_url.map(|s| s.trim().to_string())),
        ("shared_image_openai_url", body.shared_image_openai_url.map(|s| s.trim().to_string())),
        ("shared_image_gemini_url", body.shared_image_gemini_url.map(|s| s.trim().to_string())),
        ("shared_chat_openai_model", body.shared_chat_openai_model.map(|s| s.trim().to_string())),
        ("shared_chat_claude_model", body.shared_chat_claude_model.map(|s| s.trim().to_string())),
        ("shared_chat_gemini_model", body.shared_chat_gemini_model.map(|s| s.trim().to_string())),
        ("shared_image_openai_model", body.shared_image_openai_model.map(|s| s.trim().to_string())),
        ("shared_image_gemini_model", body.shared_image_gemini_model.map(|s| s.trim().to_string())),
        ("shared_chat_openai_key", body.shared_chat_openai_key),
        ("shared_chat_claude_key", body.shared_chat_claude_key),
        ("shared_chat_gemini_key", body.shared_chat_gemini_key),
        ("shared_image_openai_key", body.shared_image_openai_key),
        ("shared_image_gemini_key", body.shared_image_gemini_key),
        ("email_verification_required", body.email_verification_required.map(|b| b.to_string())),
        ("smtp_host", body.smtp_host.map(|s| s.trim().to_string())),
        ("smtp_port", body.smtp_port.map(|v| v.clamp(1, 65535).to_string())),
        ("smtp_username", body.smtp_username.map(|s| s.trim().to_string())),
        ("smtp_password", body.smtp_password),
        ("smtp_from_email", body.smtp_from_email.map(|s| s.trim().to_string())),
        ("smtp_from_name", body.smtp_from_name.map(|s| s.trim().to_string())),
        ("smtp_security", body.smtp_security.map(|s| s.trim().to_lowercase())),
    ];
    for (k, v) in ops {
        if let Err(e) = maybe_set(pool, kind, k, v.as_deref()).await {
            return (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()).into_response();
        }
    }
    StatusCode::NO_CONTENT.into_response()
}

#[derive(Serialize)]
struct AdminUserCredits {
    user_id: i64,
    username: String,
    balance: i64,
    lifetime_used: i64,
}

async fn admin_list_user_credits(Extension(installed): Extension<InstalledState>) -> Response {
    let sql = db::q(
        installed.kind,
        "SELECT u.id, u.username,
                COALESCE(c.balance, 0) AS balance,
                COALESCE(c.lifetime_used, 0) AS lifetime_used
         FROM users u
         LEFT JOIN user_credits c ON c.user_id = u.id
         ORDER BY u.id ASC",
    );
    let rows: Result<Vec<(i64, String, i64, i64)>, _> =
        sqlx::query_as(&sql).fetch_all(&installed.pool).await;
    match rows {
        Ok(rs) => {
            let out: Vec<AdminUserCredits> = rs
                .into_iter()
                .map(|(user_id, username, balance, lifetime_used)| AdminUserCredits {
                    user_id,
                    username,
                    balance,
                    lifetime_used,
                })
                .collect();
            Json(out).into_response()
        }
        Err(e) => (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()).into_response(),
    }
}

#[derive(Deserialize)]
struct AdjustCredits {
    // either set absolute balance OR add delta
    balance: Option<i64>,
    delta: Option<i64>,
    reason: Option<String>,
}

async fn admin_adjust_credits(
    Extension(installed): Extension<InstalledState>,
    Path(user_id): Path<i64>,
    Json(body): Json<AdjustCredits>,
) -> Response {
    let reason = body.reason.unwrap_or_else(|| "admin_adjust".into());
    if let Some(b) = body.balance {
        if b < 0 {
            return (StatusCode::BAD_REQUEST, "balance must be >= 0").into_response();
        }
        match set_balance(&installed.pool, installed.kind, user_id, b, &reason).await {
            Ok(new) => return Json(serde_json::json!({ "balance": new })).into_response(),
            Err(e) => return (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()).into_response(),
        }
    }
    if let Some(d) = body.delta {
        match grant(&installed.pool, installed.kind, user_id, d, &reason).await {
            Ok(new) => return Json(serde_json::json!({ "balance": new })).into_response(),
            Err(e) => return (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()).into_response(),
        }
    }
    (StatusCode::BAD_REQUEST, "provide balance or delta").into_response()
}

// ---------------------------------------------------------------------------
// routes
// ---------------------------------------------------------------------------

pub fn user_routes() -> Router<AppState> {
    Router::new()
        .route("/credits/me", get(get_my_credits))
        .route("/credits/ledger", get(get_my_ledger))
        .route("/shared/status", get(get_shared_status))
}

#[derive(Deserialize)]
struct ModelsQuery {
    which: String,
}

#[derive(Serialize)]
struct ModelsList {
    models: Vec<String>,
}

/// Admin-facing: list models available on a configured shared upstream.
/// `which` is one of: chat_openai, chat_claude, chat_gemini,
/// image_openai, image_gemini.
async fn admin_list_upstream_models(
    axum::extract::State(state): axum::extract::State<AppState>,
    Extension(installed): Extension<InstalledState>,
    axum::extract::Query(q): axum::extract::Query<ModelsQuery>,
) -> Response {
    let (flavor, protocol) = match q.which.as_str() {
        "chat_openai" => (SharedFlavor::Chat, "openai"),
        "chat_claude" => (SharedFlavor::Chat, "claude"),
        "chat_gemini" => (SharedFlavor::Chat, "gemini"),
        "image_openai" => (SharedFlavor::Image, "openai"),
        "image_gemini" => (SharedFlavor::Image, "gemini"),
        _ => return (StatusCode::BAD_REQUEST, "unknown which").into_response(),
    };
    let Some(shared) = read_shared(&installed.pool, installed.kind, protocol, flavor).await
    else {
        return (
            StatusCode::BAD_REQUEST,
            "upstream not configured — save URL and API key first",
        )
            .into_response();
    };

    let base = shared.url.trim_end_matches('/');
    let url = match protocol {
        "openai" | "claude" => format!("{base}/v1/models"),
        "gemini" => format!("{base}/v1beta/models?pageSize=200"),
        _ => unreachable!(),
    };

    let mut req = state.http.get(&url).header("accept", "application/json");
    req = match protocol {
        "openai" => req.bearer_auth(&shared.key),
        "claude" => req
            .header("x-api-key", shared.key.as_str())
            .header("anthropic-version", "2023-06-01"),
        "gemini" => req.header("x-goog-api-key", shared.key.as_str()),
        _ => unreachable!(),
    };

    let resp = match req.send().await {
        Ok(r) => r,
        Err(e) => return (StatusCode::BAD_GATEWAY, format!("upstream: {e}")).into_response(),
    };
    if !resp.status().is_success() {
        let s = resp.status();
        let body = resp.text().await.unwrap_or_default();
        return (StatusCode::BAD_GATEWAY, format!("upstream {s}: {body}")).into_response();
    }
    let v: serde_json::Value = match resp.json().await {
        Ok(j) => j,
        Err(e) => return (StatusCode::BAD_GATEWAY, format!("parse: {e}")).into_response(),
    };

    let mut models: Vec<String> = match protocol {
        "openai" | "claude" => v
            .get("data")
            .and_then(|d| d.as_array())
            .map(|arr| {
                arr.iter()
                    .filter_map(|m| m.get("id").and_then(|x| x.as_str()).map(String::from))
                    .collect()
            })
            .unwrap_or_default(),
        "gemini" => v
            .get("models")
            .and_then(|d| d.as_array())
            .map(|arr| {
                arr.iter()
                    .filter(|m| {
                        m.get("supportedGenerationMethods")
                            .and_then(|s| s.as_array())
                            .map(|methods| {
                                methods
                                    .iter()
                                    .any(|x| x.as_str() == Some("generateContent"))
                            })
                            .unwrap_or(true)
                    })
                    .filter_map(|m| {
                        m.get("name").and_then(|x| x.as_str()).map(|s| {
                            s.strip_prefix("models/").unwrap_or(s).to_string()
                        })
                    })
                    .collect()
            })
            .unwrap_or_default(),
        _ => Vec::new(),
    };
    models.sort();
    models.dedup();
    Json(ModelsList { models }).into_response()
}

pub fn admin_routes() -> Router<AppState> {
    Router::new()
        .route("/admin/app-settings", get(admin_get_settings).patch(admin_patch_settings))
        .route("/admin/app-settings/models", get(admin_list_upstream_models))
        .route("/admin/credits", get(admin_list_user_credits))
        .route("/admin/credits/{id}", patch(admin_adjust_credits).post(admin_adjust_credits))
        .route(
            "/admin/email/test",
            axum::routing::post(crate::email::admin_send_test),
        )
        .route_layer(middleware::from_fn(admin::require_admin))
}
