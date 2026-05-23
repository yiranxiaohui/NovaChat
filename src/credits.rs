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
        if cost == 0 {
            // Write a zero-delta ledger row so a "free" call (cost_credits=0)
            // is still recorded — keeps the audit trail complete and the
            // ledger reconcilable against balance.
            let led = db::q(
                kind,
                "INSERT INTO credit_ledger (user_id, delta, reason) VALUES (?, ?, ?)",
            );
            let _ = sqlx::query(&led)
                .bind(user_id)
                .bind(0_i64)
                .bind(reason)
                .execute(pool)
                .await;
        }
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
// admin endpoints
// ---------------------------------------------------------------------------

#[derive(Serialize)]
struct AdminSettingsView {
    registration_enabled: bool,
    signup_grant: i64,
    cost_chat: i64,
    cost_image: i64,
    invite_grant_inviter: i64,
    invite_grant_invitee: i64,
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
        registration_enabled: get_setting_bool(pool, kind, "registration_enabled", true).await,
        signup_grant: get_setting_i64(pool, kind, "signup_grant", 200).await,
        cost_chat: get_setting_i64(pool, kind, "cost_chat", 1).await,
        cost_image: get_setting_i64(pool, kind, "cost_image", 5).await,
        invite_grant_inviter: get_setting_i64(pool, kind, "invite_grant_inviter", 100).await,
        invite_grant_invitee: get_setting_i64(pool, kind, "invite_grant_invitee", 100).await,
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
    registration_enabled: Option<bool>,
    signup_grant: Option<i64>,
    cost_chat: Option<i64>,
    cost_image: Option<i64>,
    invite_grant_inviter: Option<i64>,
    invite_grant_invitee: Option<i64>,
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
        ("registration_enabled", body.registration_enabled.map(|b| b.to_string())),
        ("signup_grant", body.signup_grant.map(|v| v.max(0).to_string())),
        ("cost_chat", body.cost_chat.map(|v| v.max(0).to_string())),
        ("cost_image", body.cost_image.map(|v| v.max(0).to_string())),
        ("invite_grant_inviter", body.invite_grant_inviter.map(|v| v.max(0).to_string())),
        ("invite_grant_invitee", body.invite_grant_invitee.map(|v| v.max(0).to_string())),
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
}

pub fn admin_routes() -> Router<AppState> {
    Router::new()
        .route("/admin/app-settings", get(admin_get_settings).patch(admin_patch_settings))
        .route("/admin/credits", get(admin_list_user_credits))
        .route("/admin/credits/{id}", patch(admin_adjust_credits).post(admin_adjust_credits))
        .route(
            "/admin/email/test",
            axum::routing::post(crate::email::admin_send_test),
        )
        .route_layer(middleware::from_fn(admin::require_admin))
}
