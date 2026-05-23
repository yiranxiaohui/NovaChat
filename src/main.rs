mod admin;
mod auth;
mod channels;
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
mod studio;

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
    /// Longer-timeout reqwest client for image generation upstreams.
    /// Image endpoints frequently take 1–5 minutes, and upstream relays add
    /// their own variability on top. Jobs run on a background tokio task so
    /// this doesn't tie up the user's HTTP connection.
    pub image_http: reqwest::Client,
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

/// Whether to set the `Secure` attribute on session cookies. Default ON —
/// the browser then only sends the cookie over HTTPS, blocking session-token
/// theft on plain-HTTP downgrades. Set `NOVACHAT_INSECURE_COOKIE=1` only for
/// local dev when serving plain HTTP without a TLS-terminating proxy.
fn cookies_secure() -> bool {
    !matches!(
        std::env::var("NOVACHAT_INSECURE_COOKIE").as_deref(),
        Ok("1") | Ok("true") | Ok("yes")
    )
}

fn session_cookie(token: String, max_age_days: i64) -> Cookie<'static> {
    let mut c = Cookie::new(auth::SESSION_COOKIE, token);
    c.set_http_only(true);
    c.set_secure(cookies_secure());
    c.set_same_site(SameSite::Lax);
    c.set_path("/");
    c.set_max_age(time::Duration::days(max_age_days));
    c
}

fn clear_cookie() -> Cookie<'static> {
    let mut c = Cookie::new(auth::SESSION_COOKIE, "");
    c.set_http_only(true);
    c.set_secure(cookies_secure());
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
            let claimed =
                invites::set_invited_by(&installed.pool, installed.kind, user_id, inviter_id)
                    .await
                    .unwrap_or(false);
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
            if claimed && inviter_grant > 0 {
                let _ = credits::grant(
                    &installed.pool,
                    installed.kind,
                    inviter_id,
                    inviter_grant,
                    &format!("invite_reward_inviter:{username}"),
                )
                .await;
            }
            if claimed && invitee_grant > 0 {
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
        Protocol::OpenAi => format!("{base}/v1/responses"),
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

/// Rewrite the `model` field of a JSON body, returning the new bytes.
/// OpenAI and Claude chat bodies have `{"model": "...", ...}`; Gemini does
/// not (model lives in URL). Image generations (`/v1/images/generations`)
/// also have `{"model": "..."}`. Image edits are multipart — don't rewrite.

pub fn header_str(headers: &HeaderMap, name: &str) -> Option<String> {
    headers
        .get(name)
        .and_then(|v| v.to_str().ok())
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(|s| s.to_string())
}

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

    // Extract the requested model (used for channel lookup + body rewrite).
    let req_model = channels::extract_chat_model(&body, headers).unwrap_or_default();

    // Resolve route: BYOK (client headers) or server channel chain.
    let route = match channels::resolve_route(
        &installed.pool,
        installed.kind,
        headers,
        "chat",
        &req_model,
    )
    .await
    {
        Ok(r) => r,
        Err(resp) => return resp,
    };

    match route {
        channels::Route::Byok(byok) => {
            // BYOK: single shot, no credits, no fallback.
            let client = match net_guard::client_for_upstream(&state.http, &byok.base_url, false).await {
                Ok(c) => c,
                Err(r) => return r,
            };
            send_chat_once(client, &byok.base_url, &byok.api_key, protocol, &body, headers).await
        }
        channels::Route::Channels { chain, model } => {
            // Deduct based on per-model pricing (whitelist gate).
            // Refund on hard failure.
            let cost = match channels::try_deduct_for_model(
                &installed.pool,
                installed.kind,
                user.id,
                &model,
                "chat",
                &format!("chat_{}", protocol.name()),
            )
            .await
            {
                // Use the amount actually deducted for any later refund — never
                // re-read the price (an admin price change mid-request would
                // otherwise refund a different amount than was charged).
                Ok((_new_bal, deducted)) => deducted,
                Err(channels::DeductError::NotWhitelisted) => {
                    return (
                        StatusCode::FORBIDDEN,
                        format!("模型 {model} 未启用：管理员尚未在「模型计费」中开放此模型，或请在设置里使用自己的 API Key"),
                    )
                        .into_response();
                }
                Err(channels::DeductError::Insufficient { balance, cost }) => {
                    return (
                        StatusCode::PAYMENT_REQUIRED,
                        format!("积分不足：当前 {balance}，本次请求需要 {cost}；请在设置里填入自己的 API Key，或联系管理员充值"),
                    )
                        .into_response();
                }
            };


            // Iterate chain. Fall back on:
            //   * connect error
            //   * non-success status BEFORE we start streaming (pre-stream 5xx/429)
            // First success is streamed back. After streaming starts we can't
            // recover, so any mid-stream error surfaces to the client as-is.
            let mut last_err: Option<(StatusCode, String)> = None;
            for choice in chain {
                let endpoint = chat_endpoint(&choice.channel.base_url, protocol, &choice.upstream_model);
                let client = match net_guard::client_for_upstream(&state.http, &endpoint, true).await {
                    Ok(c) => c,
                    Err(_) => continue,
                };
                // Rewrite model in body for protocols that embed it.
                let attempt_body = match protocol {
                    Protocol::OpenAi | Protocol::Claude if !choice.upstream_model.is_empty() => {
                        override_json_model(&body, &choice.upstream_model)
                    }
                    _ => axum::body::Bytes::copy_from_slice(&body),
                };

                let mut req = client
                    .post(&endpoint)
                    .header(header::CONTENT_TYPE, "application/json")
                    .header(header::ACCEPT, "text/event-stream")
                    .body(attempt_body);
                req = match protocol {
                    Protocol::OpenAi => req.bearer_auth(&choice.channel.api_key),
                    Protocol::Claude => req
                        .header("x-api-key", choice.channel.api_key.as_str())
                        .header("anthropic-version", "2023-06-01"),
                    Protocol::Gemini => req.header("x-goog-api-key", choice.channel.api_key.as_str()),
                };

                let resp = match req.send().await {
                    Ok(r) => r,
                    Err(e) => {
                        eprintln!("[chat] channel {} connect failed: {e} — trying next", choice.channel.name);
                        // Don't surface reqwest's error to the client — it can
                        // include the admin-configured upstream URL.
                        last_err = Some((StatusCode::BAD_GATEWAY, "上游服务暂时不可用".to_string()));
                        continue;
                    }
                };
                let status = resp.status();
                if !status.is_success() {
                    // Drain and discard the upstream body — for shared channels
                    // it's generated against the admin's API key and many
                    // providers echo request headers (including Authorization)
                    // back in error responses. Logging or forwarding it would
                    // leak that key.
                    let _ = resp.bytes().await;
                    eprintln!("[chat] channel {} status {status} — trying next", choice.channel.name);
                    last_err = Some((StatusCode::BAD_GATEWAY, format!("上游服务返回 {status}")));
                    continue;
                }

                // Wrap the upstream stream so that if the channel returned 200
                // but then died before sending any bytes, the deducted cost is
                // refunded — otherwise the user pays full price for nothing.
                let guarded = GuardedStream {
                    inner: Box::pin(resp.bytes_stream()),
                    guard: StreamRefundGuard {
                        pool: installed.pool.clone(),
                        kind: installed.kind,
                        user_id: user.id,
                        cost,
                        model: model.to_string(),
                        streamed: false,
                    },
                };
                return Response::builder()
                    .header(header::CONTENT_TYPE, "text/event-stream")
                    .header(header::CACHE_CONTROL, "no-cache")
                    .header("x-accel-buffering", "no")
                    .body(Body::from_stream(guarded))
                    .unwrap();
            }

            // All channels failed — refund.
            if cost > 0 {
                let _ = credits::grant(
                    &installed.pool,
                    installed.kind,
                    user.id,
                    cost,
                    &format!("refund_chat_{model}_all_failed"),
                )
                .await;
            }
            let (status, msg) = last_err
                .unwrap_or((StatusCode::BAD_GATEWAY, format!("模型 {model} 所有渠道均不可用")));
            (status, msg).into_response()
        }
    }
}

/// Refunds the chat cost on drop if the upstream stream never produced bytes —
/// covers a channel that returned HTTP 200 then died before sending anything.
struct StreamRefundGuard {
    pool: db::Pool,
    kind: db::DbKind,
    user_id: i64,
    cost: i64,
    model: String,
    streamed: bool,
}

impl Drop for StreamRefundGuard {
    fn drop(&mut self) {
        if self.streamed || self.cost <= 0 {
            return;
        }
        let pool = self.pool.clone();
        let kind = self.kind;
        let user_id = self.user_id;
        let cost = self.cost;
        let reason = format!("refund_chat_{}_stream_empty", self.model);
        tokio::spawn(async move {
            let _ = credits::grant(&pool, kind, user_id, cost, &reason).await;
        });
    }
}

/// Byte-stream wrapper that marks its guard as soon as one non-empty chunk
/// passes through; the guard refunds on drop if nothing ever did.
struct GuardedStream {
    inner: std::pin::Pin<
        Box<dyn futures_util::stream::Stream<Item = reqwest::Result<axum::body::Bytes>> + Send>,
    >,
    guard: StreamRefundGuard,
}

impl futures_util::stream::Stream for GuardedStream {
    type Item = reqwest::Result<axum::body::Bytes>;
    fn poll_next(
        self: std::pin::Pin<&mut Self>,
        cx: &mut std::task::Context<'_>,
    ) -> std::task::Poll<Option<Self::Item>> {
        let this = self.get_mut();
        let polled = this.inner.as_mut().poll_next(cx);
        if let std::task::Poll::Ready(Some(Ok(chunk))) = &polled {
            if !chunk.is_empty() {
                this.guard.streamed = true;
            }
        }
        polled
    }
}

/// Send one chat request (BYOK path — no fallback, no credits).
async fn send_chat_once(
    client: reqwest::Client,
    base_url: &str,
    api_key: &str,
    protocol: Protocol,
    body: &axum::body::Bytes,
    _headers: &HeaderMap,
) -> Response {
    // BYOK clients supply the full URL already (it points at /v1/chat/...).
    let url = base_url.to_string();
    let mut req = client
        .post(&url)
        .header(header::CONTENT_TYPE, "application/json")
        .header(header::ACCEPT, "text/event-stream")
        .body(body.clone());
    req = match protocol {
        Protocol::OpenAi => req.bearer_auth(api_key),
        Protocol::Claude => req
            .header("x-api-key", api_key)
            .header("anthropic-version", "2023-06-01"),
        Protocol::Gemini => req.header("x-goog-api-key", api_key),
    };
    let resp = match req.send().await {
        Ok(r) => r,
        Err(e) => {
            eprintln!("[chat byok] upstream connect failed: {e}");
            return (StatusCode::BAD_GATEWAY, "上游服务暂时不可用".to_string())
                .into_response();
        }
    };
    if !resp.status().is_success() {
        let status = resp.status();
        // Don't forward the upstream body — even on BYOK, providers can echo
        // the caller's own Authorization header back into error responses.
        let _ = resp.bytes().await;
        return (StatusCode::BAD_GATEWAY, format!("上游服务返回 {status}"))
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
    // Otherwise — when the client sent empty X-Upstream-Url/Key headers —
    // fall back to any admin-configured channel for this protocol+flavor.
    let hdr_url = headers.get("x-upstream-url").and_then(|v| v.to_str().ok());
    let hdr_key = headers.get("x-upstream-key").and_then(|v| v.to_str().ok());

    let use_client_headers =
        matches!((hdr_url, hdr_key), (Some(u), Some(k)) if !u.is_empty() && !k.is_empty());

    let flavor = match headers
        .get("x-upstream-flavor")
        .and_then(|v| v.to_str().ok())
        .map(str::trim)
    {
        Some("image") => "image",
        _ => "chat",
    };

    let (url, key, used_shared) = if use_client_headers {
        (
            hdr_url.unwrap().to_string(),
            hdr_key.unwrap().to_string(),
            false,
        )
    } else {
        match channels::any_enabled_channel(
            &installed.pool,
            installed.kind,
            protocol.name(),
            flavor,
        )
        .await
        .ok()
        .flatten()
        {
            Some(ch) => (models_endpoint(&ch.base_url, protocol), ch.api_key, true),
            None => {
                return (
                    StatusCode::BAD_REQUEST,
                    "未配置任何启用的上游渠道",
                )
                    .into_response();
            }
        }
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
            eprintln!("[models] upstream connect failed: {e}");
            return (StatusCode::BAD_GATEWAY, "上游服务暂时不可用".to_string())
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
        // Don't forward the upstream body — for shared channels it was made
        // with the admin's API key and providers often echo headers back.
        return (StatusCode::BAD_GATEWAY, format!("上游服务返回 {status}"))
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
        .merge(channels::admin_routes())
        .merge(channels::user_routes())
        .merge(payments::user_routes())
        .merge(payments::admin_routes())
        .merge(studio::routes())
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
        .layer(DefaultBodyLimit::max(1024 * 1024 * 1024))
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
            .timeout(std::time::Duration::from_secs(600))
            .build()
            .expect("reqwest client"),
        image_http: reqwest::Client::builder()
            .timeout(std::time::Duration::from_secs(600))
            .build()
            .expect("image reqwest client"),
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
                images::cleanup_stale_jobs(&s.pool, s.kind).await;
                studio::cleanup_stale_jobs(&s.pool, s.kind).await;
                *state.installed.write().await = Some(s.clone());
                println!("  database: {} ({})", s.kind.as_str(), url);
            }
            Err(e) => {
                // A database is already configured. Refuse to start rather than
                // fall back to the setup wizard, which could be hijacked to
                // repoint the app at an attacker-controlled database.
                eprintln!("FATAL: configured database is unreachable ({e}); refusing to start");
                std::process::exit(1);
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
