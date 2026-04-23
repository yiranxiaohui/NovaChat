mod admin;
mod auth;
mod conversations;
mod credits;
mod db;
mod email;
mod image_plaza;
mod images;
mod invites;
mod net_guard;
mod payments;
mod profile;
mod prompts;
mod settings;
mod setup;
mod skills;

use axum::{
    Json, Router,
    body::Body,
    extract::{DefaultBodyLimit, State},
    http::{HeaderMap, StatusCode, Uri, header},
    middleware::{self, Next},
    response::{IntoResponse, Response},
    routing::{get, post},
};
use axum_extra::extract::cookie::{Cookie, CookieJar, SameSite};
use chrono::Utc;
use rust_embed::RustEmbed;
use serde::{Deserialize, Serialize};
use std::sync::Arc;
use tokio::sync::RwLock;

#[derive(RustEmbed)]
#[folder = "web/dist/"]
struct Assets;

// ---------------------------------------------------------------------------
// state + config
// ---------------------------------------------------------------------------

#[derive(Clone)]
pub struct AppState {
    pub installed: Arc<RwLock<Option<InstalledState>>>,
    pub http: reqwest::Client,
    pub config_path: std::path::PathBuf,
    pub data_dir: std::path::PathBuf,
}

#[derive(Clone)]
pub struct InstalledState {
    pub pool: db::Pool,
    pub kind: db::DbKind,
}

impl AppState {
    pub async fn require_installed(&self) -> Result<InstalledState, axum::response::Response> {
        use axum::http::StatusCode;
        use axum::response::IntoResponse;
        match self.installed.read().await.clone() {
            Some(s) => Ok(s),
            None => Err((StatusCode::SERVICE_UNAVAILABLE, "system not installed").into_response()),
        }
    }
}

#[derive(Clone, Copy, Debug)]
pub struct CurrentUser {
    pub id: i64,
}

// ---------------------------------------------------------------------------
// auth endpoints
// ---------------------------------------------------------------------------

#[derive(Deserialize)]
struct Credentials {
    username: String,
    password: String,
    #[serde(default)]
    invite_code: Option<String>,
    #[serde(default)]
    email: Option<String>,
    #[serde(default)]
    email_code: Option<String>,
}

#[derive(Serialize)]
pub struct UserDto {
    pub id: i64,
    pub username: String,
    pub display_name: Option<String>,
    pub avatar_url: Option<String>,
    pub is_admin: bool,
}

fn validate_credentials(c: &Credentials) -> Result<(), &'static str> {
    let u = c.username.trim();
    if u.len() < 3 || u.len() > 32 {
        return Err("username must be 3-32 characters");
    }
    if !u.chars().all(|ch| ch.is_ascii_alphanumeric() || ch == '_' || ch == '-') {
        return Err("username: letters, digits, _ or - only");
    }
    if c.password.len() < 6 || c.password.len() > 256 {
        return Err("password must be 6-256 characters");
    }
    Ok(())
}

fn session_cookie(token: String, max_age_days: i64) -> Cookie<'static> {
    let mut c = Cookie::new(auth::SESSION_COOKIE, token);
    c.set_http_only(true);
    c.set_same_site(SameSite::Lax);
    c.set_path("/");
    c.set_max_age(time::Duration::days(max_age_days));
    c
}

fn clear_cookie() -> Cookie<'static> {
    let mut c = Cookie::new(auth::SESSION_COOKIE, "");
    c.set_http_only(true);
    c.set_same_site(SameSite::Lax);
    c.set_path("/");
    c.set_max_age(time::Duration::ZERO);
    c
}

async fn register(
    State(state): State<AppState>,
    jar: CookieJar,
    Json(creds): Json<Credentials>,
) -> Response {
    let installed = match state.require_installed().await {
        Ok(s) => s,
        Err(r) => return r,
    };
    let registration_enabled = credits::get_setting_bool(
        &installed.pool,
        installed.kind,
        "registration_enabled",
        true,
    )
    .await;
    if !registration_enabled {
        return (StatusCode::FORBIDDEN, "当前站点已关闭注册").into_response();
    }
    if let Err(msg) = validate_credentials(&creds) {
        return (StatusCode::BAD_REQUEST, msg).into_response();
    }

    // Email verification gate. When the admin has turned it on, registration
    // requires a previously-issued code that matches the supplied address.
    let require_email = credits::get_setting_bool(
        &installed.pool,
        installed.kind,
        "email_verification_required",
        false,
    )
    .await;
    let normalized_email: Option<String> = creds
        .email
        .as_deref()
        .map(email::normalize_email)
        .filter(|e| !e.is_empty());
    if require_email {
        let Some(e) = normalized_email.as_deref() else {
            return (StatusCode::BAD_REQUEST, "需要邮箱验证码").into_response();
        };
        if !email::valid_email(e) {
            return (StatusCode::BAD_REQUEST, "邮箱格式不正确").into_response();
        }
        let Some(code) = creds.email_code.as_deref().map(str::trim).filter(|s| !s.is_empty()) else {
            return (StatusCode::BAD_REQUEST, "需要邮箱验证码").into_response();
        };
        let ok = email::consume_code(&installed.pool, installed.kind, e, code, "register").await;
        if !ok {
            return (StatusCode::BAD_REQUEST, "验证码无效或已过期").into_response();
        }
    } else if let Some(e) = normalized_email.as_deref() {
        // Optional email: accept, but still validate format.
        if !email::valid_email(e) {
            return (StatusCode::BAD_REQUEST, "邮箱格式不正确").into_response();
        }
    }

    let phc = match auth::hash_password(&creds.password) {
        Ok(h) => h,
        Err(e) => return (StatusCode::INTERNAL_SERVER_ERROR, e).into_response(),
    };
    let username = creds.username.trim().to_string();

    let base_insert = db::q(
        installed.kind,
        "INSERT INTO users (username, password_hash, email) VALUES (?, ?, ?)",
    );
    let user_id = match installed.kind {
        db::DbKind::Sqlite | db::DbKind::Postgres => {
            let row: Result<(i64,), _> = sqlx::query_as(&format!("{base_insert} RETURNING id"))
                .bind(&username)
                .bind(&phc)
                .bind(&normalized_email)
                .fetch_one(&installed.pool)
                .await;
            match row {
                Ok((id,)) => id,
                Err(sqlx::Error::Database(d)) if d.is_unique_violation() => {
                    let msg = if d.message().contains("email") {
                        "该邮箱已注册"
                    } else {
                        "username already taken"
                    };
                    return (StatusCode::CONFLICT, msg).into_response();
                }
                Err(e) => return (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()).into_response(),
            }
        }
        db::DbKind::Mysql => {
            let mut tx = match installed.pool.begin().await {
                Ok(t) => t,
                Err(e) => return (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()).into_response(),
            };
            if let Err(e) = sqlx::query(&base_insert)
                .bind(&username)
                .bind(&phc)
                .bind(&normalized_email)
                .execute(&mut *tx)
                .await
            {
                if let sqlx::Error::Database(d) = &e {
                    if d.is_unique_violation() {
                        let msg = if d.message().contains("email") {
                            "该邮箱已注册"
                        } else {
                            "username already taken"
                        };
                        return (StatusCode::CONFLICT, msg).into_response();
                    }
                }
                return (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()).into_response();
            }
            let row: Result<(i64,), _> = sqlx::query_as("SELECT LAST_INSERT_ID()")
                .fetch_one(&mut *tx)
                .await;
            let id = match row {
                Ok((v,)) => v,
                Err(e) => return (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()).into_response(),
            };
            if let Err(e) = tx.commit().await {
                return (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()).into_response();
            }
            id
        }
    };

    let is_admin = admin::is_admin(&installed.pool, installed.kind, user_id).await;
    let _ = credits::ensure_account(&installed.pool, installed.kind, user_id).await;
    let _ = invites::ensure_code(&installed.pool, installed.kind, user_id).await;

    if let Some(raw) = creds.invite_code.as_deref() {
        if let Some(inviter_id) =
            invites::resolve_inviter(&installed.pool, installed.kind, raw, user_id).await
        {
            let _ =
                invites::set_invited_by(&installed.pool, installed.kind, user_id, inviter_id).await;
            let inviter_grant = credits::get_setting_i64(
                &installed.pool,
                installed.kind,
                "invite_grant_inviter",
                100,
            )
            .await;
            let invitee_grant = credits::get_setting_i64(
                &installed.pool,
                installed.kind,
                "invite_grant_invitee",
                100,
            )
            .await;
            if inviter_grant > 0 {
                let _ = credits::grant(
                    &installed.pool,
                    installed.kind,
                    inviter_id,
                    inviter_grant,
                    &format!("invite_reward_inviter:{username}"),
                )
                .await;
            }
            if invitee_grant > 0 {
                let _ = credits::grant(
                    &installed.pool,
                    installed.kind,
                    user_id,
                    invitee_grant,
                    "invite_reward_invitee",
                )
                .await;
            }
        }
    }

    match auth::create_session(&installed.pool, installed.kind, user_id).await {
        Ok((token, _)) => {
            let jar = jar.add(session_cookie(token, auth::SESSION_TTL_DAYS));
            (
                jar,
                Json(UserDto {
                    id: user_id,
                    username,
                    display_name: None,
                    avatar_url: None,
                    is_admin,
                }),
            )
                .into_response()
        }
        Err(e) => (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()).into_response(),
    }
}

async fn login(
    State(state): State<AppState>,
    jar: CookieJar,
    Json(creds): Json<Credentials>,
) -> Response {
    let installed = match state.require_installed().await {
        Ok(s) => s,
        Err(r) => return r,
    };
    let username = creds.username.trim();
    let admin_col = db::bool_as_int(installed.kind, "is_admin");
    let sel = db::q(
        installed.kind,
        &format!(
            "SELECT id, username, password_hash, display_name, avatar_url, {admin_col}
             FROM users WHERE {}",
            db::ci_eq(installed.kind, "username")
        ),
    );
    let row: Option<(i64, String, String, Option<String>, Option<String>, i64)> =
        sqlx::query_as(&sel)
            .bind(username)
            .fetch_optional(&installed.pool)
            .await
            .unwrap_or(None);

    let Some((id, username, phc, display_name, avatar_url, is_admin)) = row else {
        return (StatusCode::UNAUTHORIZED, "invalid credentials").into_response();
    };
    if !auth::verify_password(&creds.password, &phc) {
        return (StatusCode::UNAUTHORIZED, "invalid credentials").into_response();
    }

    match auth::create_session(&installed.pool, installed.kind, id).await {
        Ok((token, _)) => {
            let jar = jar.add(session_cookie(token, auth::SESSION_TTL_DAYS));
            (
                jar,
                Json(UserDto {
                    id,
                    username,
                    display_name,
                    avatar_url,
                    is_admin: is_admin != 0,
                }),
            )
                .into_response()
        }
        Err(e) => (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()).into_response(),
    }
}

#[derive(Serialize)]
struct AuthConfig {
    email_verification_required: bool,
}

async fn auth_config(State(state): State<AppState>) -> Response {
    let installed = match state.require_installed().await {
        Ok(s) => s,
        Err(_) => {
            return Json(AuthConfig {
                email_verification_required: false,
            })
            .into_response();
        }
    };
    let email_verification_required = credits::get_setting_bool(
        &installed.pool,
        installed.kind,
        "email_verification_required",
        false,
    )
    .await;
    Json(AuthConfig {
        email_verification_required,
    })
    .into_response()
}

async fn logout(State(state): State<AppState>, jar: CookieJar) -> Response {
    if let Ok(installed) = state.require_installed().await {
        if let Some(c) = jar.get(auth::SESSION_COOKIE) {
            let _ = auth::delete_session(&installed.pool, installed.kind, c.value()).await;
        }
    }
    let jar = jar.add(clear_cookie());
    (jar, StatusCode::NO_CONTENT).into_response()
}

async fn me(State(state): State<AppState>, jar: CookieJar) -> Response {
    let installed = match state.require_installed().await {
        Ok(s) => s,
        Err(r) => return r,
    };
    let Some(c) = jar.get(auth::SESSION_COOKIE) else {
        return (StatusCode::UNAUTHORIZED, "not logged in").into_response();
    };
    let Some((id, _)) =
        auth::user_for_token(&installed.pool, installed.kind, c.value()).await
    else {
        return (StatusCode::UNAUTHORIZED, "session expired").into_response();
    };
    let admin_col = db::bool_as_int(installed.kind, "is_admin");
    let sql = db::q(
        installed.kind,
        &format!(
            "SELECT id, username, display_name, avatar_url, {admin_col}
             FROM users WHERE id = ?"
        ),
    );
    let row: Option<(i64, String, Option<String>, Option<String>, i64)> = sqlx::query_as(&sql)
        .bind(id)
        .fetch_optional(&installed.pool)
        .await
        .unwrap_or(None);
    match row {
        Some((id, username, display_name, avatar_url, is_admin)) => Json(UserDto {
            id,
            username,
            display_name,
            avatar_url,
            is_admin: is_admin != 0,
        })
        .into_response(),
        None => (StatusCode::UNAUTHORIZED, "user not found").into_response(),
    }
}

// ---------------------------------------------------------------------------
// auth middleware (for protected routes)
// ---------------------------------------------------------------------------

async fn require_auth(
    State(state): State<AppState>,
    jar: CookieJar,
    mut req: axum::extract::Request,
    next: Next,
) -> Response {
    let installed = match state.require_installed().await {
        Ok(s) => s,
        Err(r) => return r,
    };
    let Some(c) = jar.get(auth::SESSION_COOKIE) else {
        return (StatusCode::UNAUTHORIZED, "login required").into_response();
    };
    let Some((id, _)) = auth::user_for_token(&installed.pool, installed.kind, c.value()).await
    else {
        return (StatusCode::UNAUTHORIZED, "session expired").into_response();
    };
    req.extensions_mut().insert(CurrentUser { id });
    req.extensions_mut().insert(installed);
    next.run(req).await
}

// ---------------------------------------------------------------------------
// chat proxy (optional, for upstreams without CORS)
// ---------------------------------------------------------------------------

#[derive(Clone, Copy)]
pub enum Protocol {
    OpenAi,
    Claude,
    Gemini,
}

impl Protocol {
    fn name(self) -> &'static str {
        match self {
            Protocol::OpenAi => "openai",
            Protocol::Claude => "claude",
            Protocol::Gemini => "gemini",
        }
    }
}

fn trim_slash(s: &str) -> &str {
    s.trim_end_matches('/')
}

pub fn chat_endpoint(host: &str, protocol: Protocol, model: &str) -> String {
    let base = trim_slash(host);
    match protocol {
        Protocol::OpenAi => format!("{base}/v1/chat/completions"),
        Protocol::Claude => format!("{base}/v1/messages"),
        Protocol::Gemini => format!("{base}/v1beta/models/{model}:streamGenerateContent"),
    }
}

pub fn models_endpoint(host: &str, protocol: Protocol) -> String {
    let base = trim_slash(host);
    match protocol {
        Protocol::OpenAi | Protocol::Claude => format!("{base}/v1/models"),
        Protocol::Gemini => format!("{base}/v1beta/models?pageSize=200"),
    }
}

/// Resolve the upstream for a chat request. Prefers client-supplied headers;
/// falls back to admin-configured shared upstream (host-only, model stored
/// separately) when enabled.
///
/// Returned URL is always the fully-qualified endpoint.
/// When `used_shared=true`, `shared_model` carries the admin's configured
/// model — it always wins over any client hint so users can't switch models
/// on shared credits.
async fn resolve_chat_upstream(
    installed: &InstalledState,
    protocol: Protocol,
    headers: &HeaderMap,
) -> Result<(String, String, bool, Option<String>), Response> {
    let want_shared = header_truthy(headers, "x-use-shared");
    if !want_shared {
        let hdr_url = headers.get("x-upstream-url").and_then(|v| v.to_str().ok());
        let hdr_key = headers.get("x-upstream-key").and_then(|v| v.to_str().ok());
        if let (Some(u), Some(k)) = (hdr_url, hdr_key) {
            if !u.is_empty() && !k.is_empty() {
                return Ok((u.to_string(), k.to_string(), false, None));
            }
        }
    }
    match credits::read_shared(
        &installed.pool,
        installed.kind,
        protocol.name(),
        credits::SharedFlavor::Chat,
    )
    .await
    {
        Some(s) => {
            let admin_model = s.model.clone().unwrap_or_default();
            if admin_model.is_empty() {
                return Err((
                    StatusCode::SERVICE_UNAVAILABLE,
                    "shared upstream has no configured model — ask the admin to set one",
                )
                    .into_response());
            }
            let url = chat_endpoint(&s.url, protocol, &admin_model);
            Ok((url, s.key, true, Some(admin_model)))
        }
        None => Err((
            StatusCode::BAD_REQUEST,
            "missing X-Upstream-Url/Key header (and no shared backend configured)",
        )
            .into_response()),
    }
}

pub fn header_str(headers: &HeaderMap, name: &str) -> Option<String> {
    headers
        .get(name)
        .and_then(|v| v.to_str().ok())
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(|s| s.to_string())
}

pub fn header_truthy(headers: &HeaderMap, name: &str) -> bool {
    headers
        .get(name)
        .and_then(|v| v.to_str().ok())
        .map(|s| matches!(s.trim(), "1" | "true" | "TRUE" | "True"))
        .unwrap_or(false)
}

/// Rewrite the `model` field of a JSON body, returning the new bytes.
/// OpenAI and Claude chat bodies have `{"model": "...", ...}`; Gemini does
/// not (model lives in URL). Image generations (`/v1/images/generations`)
/// also have `{"model": "..."}`. Image edits are multipart — don't rewrite.
fn override_json_model(body: &[u8], new_model: &str) -> axum::body::Bytes {
    let Ok(mut v) = serde_json::from_slice::<serde_json::Value>(body) else {
        return axum::body::Bytes::copy_from_slice(body);
    };
    if let Some(map) = v.as_object_mut() {
        if map.contains_key("model") {
            map.insert("model".into(), serde_json::Value::String(new_model.into()));
        }
    }
    match serde_json::to_vec(&v) {
        Ok(b) => axum::body::Bytes::from(b),
        Err(_) => axum::body::Bytes::copy_from_slice(body),
    }
}

async fn proxy_forward(
    state: &AppState,
    user: CurrentUser,
    protocol: Protocol,
    headers: &HeaderMap,
    body: axum::body::Bytes,
) -> Response {
    let installed = match state.require_installed().await {
        Ok(s) => s,
        Err(r) => return r,
    };

    let (url, key, used_shared, shared_model) =
        match resolve_chat_upstream(&installed, protocol, headers).await {
            Ok(v) => v,
            Err(r) => return r,
        };

    let client = match net_guard::client_for_upstream(&state.http, &url, used_shared).await {
        Ok(c) => c,
        Err(r) => return r,
    };

    // When falling back to shared upstream, override the model in the body
    // (OpenAI / Claude embed it in the JSON payload; Gemini only in URL).
    let body = if used_shared {
        match (protocol, shared_model.as_deref()) {
            (Protocol::OpenAi | Protocol::Claude, Some(m)) if !m.is_empty() => {
                override_json_model(&body, m)
            }
            _ => body,
        }
    } else {
        body
    };

    if used_shared {
        let cost = credits::get_setting_i64(&installed.pool, installed.kind, "cost_chat", 1).await;
        match credits::try_deduct(
            &installed.pool,
            installed.kind,
            user.id,
            cost,
            &format!("chat_{}", protocol.name()),
        )
        .await
        {
            Ok(_) => {}
            Err(bal) => {
                return (
                    StatusCode::PAYMENT_REQUIRED,
                    format!("积分不足：当前 {bal}，每次请求需要 {cost}；请在设置里填入自己的 API Key，或联系管理员充值"),
                )
                    .into_response();
            }
        }
    }

    let mut req = client
        .post(&url)
        .header(header::CONTENT_TYPE, "application/json")
        .header(header::ACCEPT, "text/event-stream")
        .body(body);

    req = match protocol {
        Protocol::OpenAi => req.bearer_auth(&key),
        Protocol::Claude => req
            .header("x-api-key", key.as_str())
            .header("anthropic-version", "2023-06-01"),
        Protocol::Gemini => req.header("x-goog-api-key", key.as_str()),
    };

    let resp = match req.send().await {
        Ok(r) => r,
        Err(e) => {
            if used_shared {
                // refund on connect failure
                let cost =
                    credits::get_setting_i64(&installed.pool, installed.kind, "cost_chat", 1).await;
                let _ = credits::grant(
                    &installed.pool,
                    installed.kind,
                    user.id,
                    cost,
                    "refund_connect_error",
                )
                .await;
            }
            return (
                StatusCode::BAD_GATEWAY,
                format!("upstream connect error: {e}"),
            )
                .into_response();
        }
    };

    if !resp.status().is_success() {
        let status = resp.status();
        let text = resp.text().await.unwrap_or_default();
        if used_shared {
            let cost =
                credits::get_setting_i64(&installed.pool, installed.kind, "cost_chat", 1).await;
            let _ = credits::grant(
                &installed.pool,
                installed.kind,
                user.id,
                cost,
                "refund_upstream_error",
            )
            .await;
        }
        return (StatusCode::BAD_GATEWAY, format!("upstream {status}: {text}"))
            .into_response();
    }

    let stream = resp.bytes_stream();
    Response::builder()
        .header(header::CONTENT_TYPE, "text/event-stream")
        .header(header::CACHE_CONTROL, "no-cache")
        .header("x-accel-buffering", "no")
        .body(Body::from_stream(stream))
        .unwrap()
}

async fn proxy_openai(
    State(state): State<AppState>,
    axum::Extension(user): axum::Extension<CurrentUser>,
    headers: HeaderMap,
    body: axum::body::Bytes,
) -> Response {
    proxy_forward(&state, user, Protocol::OpenAi, &headers, body).await
}

async fn proxy_claude(
    State(state): State<AppState>,
    axum::Extension(user): axum::Extension<CurrentUser>,
    headers: HeaderMap,
    body: axum::body::Bytes,
) -> Response {
    proxy_forward(&state, user, Protocol::Claude, &headers, body).await
}

async fn proxy_gemini(
    State(state): State<AppState>,
    axum::Extension(user): axum::Extension<CurrentUser>,
    headers: HeaderMap,
    body: axum::body::Bytes,
) -> Response {
    proxy_forward(&state, user, Protocol::Gemini, &headers, body).await
}

async fn proxy_get_forward(
    state: &AppState,
    protocol: Protocol,
    headers: &HeaderMap,
) -> Response {
    let installed = match state.require_installed().await {
        Ok(s) => s,
        Err(r) => return r,
    };

    // Client-supplied URL wins (it already points at /v1/models etc.).
    // Otherwise fall back to shared host + construct the models endpoint.
    let hdr_url = headers.get("x-upstream-url").and_then(|v| v.to_str().ok());
    let hdr_key = headers.get("x-upstream-key").and_then(|v| v.to_str().ok());
    let (url, key, used_shared) = if let (Some(u), Some(k)) = (hdr_url, hdr_key) {
        if !u.is_empty() && !k.is_empty() {
            (u.to_string(), k.to_string(), false)
        } else {
            match credits::read_shared(
                &installed.pool,
                installed.kind,
                protocol.name(),
                credits::SharedFlavor::Chat,
            )
            .await
            {
                Some(s) => (models_endpoint(&s.url, protocol), s.key, true),
                None => {
                    return (
                        StatusCode::BAD_REQUEST,
                        "missing X-Upstream-Url/Key header (and no shared backend configured)",
                    )
                        .into_response();
                }
            }
        }
    } else {
        return (
            StatusCode::BAD_REQUEST,
            "missing X-Upstream-Url/Key header",
        )
            .into_response();
    };

    let client = match net_guard::client_for_upstream(&state.http, &url, used_shared).await {
        Ok(c) => c,
        Err(r) => return r,
    };

    let mut req = client
        .get(&url)
        .header(header::ACCEPT, "application/json");
    req = match protocol {
        Protocol::OpenAi => req.bearer_auth(&key),
        Protocol::Claude => req
            .header("x-api-key", key.as_str())
            .header("anthropic-version", "2023-06-01"),
        Protocol::Gemini => req.header("x-goog-api-key", key.as_str()),
    };

    let resp = match req.send().await {
        Ok(r) => r,
        Err(e) => {
            return (
                StatusCode::BAD_GATEWAY,
                format!("upstream connect error: {e}"),
            )
                .into_response();
        }
    };

    let status = resp.status();
    let content_type = resp
        .headers()
        .get(header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("application/json")
        .to_string();
    let bytes = resp.bytes().await.unwrap_or_default();

    if !status.is_success() {
        let text = String::from_utf8_lossy(&bytes).to_string();
        return (StatusCode::BAD_GATEWAY, format!("upstream {status}: {text}"))
            .into_response();
    }

    Response::builder()
        .header(header::CONTENT_TYPE, content_type)
        .body(Body::from(bytes))
        .unwrap()
}

async fn proxy_openai_models(
    State(state): State<AppState>,
    axum::Extension(_user): axum::Extension<CurrentUser>,
    headers: HeaderMap,
) -> Response {
    proxy_get_forward(&state, Protocol::OpenAi, &headers).await
}

async fn proxy_claude_models(
    State(state): State<AppState>,
    axum::Extension(_user): axum::Extension<CurrentUser>,
    headers: HeaderMap,
) -> Response {
    proxy_get_forward(&state, Protocol::Claude, &headers).await
}

async fn proxy_gemini_models(
    State(state): State<AppState>,
    axum::Extension(_user): axum::Extension<CurrentUser>,
    headers: HeaderMap,
) -> Response {
    proxy_get_forward(&state, Protocol::Gemini, &headers).await
}

// ---------------------------------------------------------------------------
// static + health
// ---------------------------------------------------------------------------

#[derive(Serialize)]
struct Health {
    status: &'static str,
    version: &'static str,
    time: String,
}

async fn health() -> Json<Health> {
    Json(Health {
        status: "ok",
        version: env!("CARGO_PKG_VERSION"),
        time: Utc::now().to_rfc3339(),
    })
}

async fn static_handler(uri: Uri) -> Response {
    let path = uri.path().trim_start_matches('/');
    let path = if path.is_empty() { "index.html" } else { path };
    if let Some(res) = serve(path) {
        return res;
    }
    if let Some(res) = serve("index.html") {
        return res;
    }
    (StatusCode::NOT_FOUND, "404 Not Found").into_response()
}

fn serve(path: &str) -> Option<Response> {
    let file = Assets::get(path)?;
    let mime = mime_guess::from_path(path).first_or_octet_stream();
    Some(
        Response::builder()
            .header(header::CONTENT_TYPE, mime.as_ref())
            .body(Body::from(file.data.into_owned()))
            .unwrap(),
    )
}

// ---------------------------------------------------------------------------
// router
// ---------------------------------------------------------------------------

fn build_router(state: AppState) -> Router {
    let protected = Router::new()
        .route("/proxy/openai", post(proxy_openai))
        .route("/proxy/claude", post(proxy_claude))
        .route("/proxy/gemini", post(proxy_gemini))
        .route("/proxy/openai/models", get(proxy_openai_models))
        .route("/proxy/claude/models", get(proxy_claude_models))
        .route("/proxy/gemini/models", get(proxy_gemini_models))
        .merge(conversations::routes())
        .merge(prompts::routes())
        .merge(skills::routes())
        .merge(images::routes())
        .merge(image_plaza::routes())
        .merge(settings::routes())
        .merge(profile::routes())
        .merge(admin::routes())
        .merge(credits::user_routes())
        .merge(credits::admin_routes())
        .merge(payments::user_routes())
        .merge(payments::admin_routes())
        .merge(invites::routes())
        .route_layer(middleware::from_fn_with_state(state.clone(), require_auth));

    let public = Router::new()
        .route("/health", get(health))
        .route("/auth/config", get(auth_config))
        .route("/auth/register", post(register))
        .route("/auth/login", post(login))
        .route("/auth/logout", post(logout))
        .route("/auth/me", get(me))
        .merge(email::public_routes())
        .merge(payments::public_routes())
        .merge(setup::routes());

    Router::new()
        .nest("/api", public.merge(protected))
        .layer(DefaultBodyLimit::max(64 * 1024 * 1024))
        .with_state(state)
        .fallback(static_handler)
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

#[tokio::main]
async fn main() {
    db::install_drivers();

    let data_dir = std::path::PathBuf::from(
        std::env::var("NOVACHAT_DATA_DIR").unwrap_or_else(|_| "data".into()),
    );
    if let Err(e) = std::fs::create_dir_all(&data_dir) {
        eprintln!("WARNING: failed to create data dir {}: {e}", data_dir.display());
    }
    let config_path = std::env::var("NOVACHAT_CONFIG")
        .map(std::path::PathBuf::from)
        .unwrap_or_else(|_| data_dir.join("novachat.toml"));

    // priority: env DATABASE_URL -> config file -> install wizard
    let env_url = std::env::var("NOVACHAT_DATABASE_URL")
        .ok()
        .or_else(|| std::env::var("DATABASE_URL").ok());

    let installed = Arc::new(RwLock::new(None));
    let state = AppState {
        installed: installed.clone(),
        http: reqwest::Client::builder()
            .timeout(std::time::Duration::from_secs(180))
            .build()
            .expect("reqwest client"),
        config_path: config_path.clone(),
        data_dir: data_dir.clone(),
    };

    let effective_url = match env_url {
        Some(u) => {
            // env wins and also persists to config for cross-restart consistency
            let _ = setup::save_config(&config_path, &setup::StoredConfig { database_url: u.clone() });
            Some(u)
        }
        None => setup::load_config(&config_path).ok().map(|c| c.database_url),
    };

    if let Some(url) = effective_url.as_deref() {
        match setup::boot_installed(url).await {
            Ok(s) => {
                *state.installed.write().await = Some(s.clone());
                println!("  database: {} ({})", s.kind.as_str(), url);
            }
            Err(e) => {
                eprintln!("WARNING: failed to connect to configured database ({e}); falling back to setup wizard");
            }
        }
    }

    let addr = std::env::var("NOVACHAT_BIND").unwrap_or_else(|_| "127.0.0.1:3000".into());
    let listener = tokio::net::TcpListener::bind(&addr).await.expect("bind");
    println!("NovaChat listening on http://{addr}");
    if state.installed.read().await.is_none() {
        println!("  (not yet installed — open http://{addr}/setup to configure)");
    }
    axum::serve(listener, build_router(state))
        .await
        .expect("server error");
}
