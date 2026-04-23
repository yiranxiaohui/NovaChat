use std::time::Duration;

use axum::{
    Extension, Json, Router,
    body::Body,
    extract::{Path, State},
    http::{HeaderMap, StatusCode, header},
    response::{IntoResponse, Response},
    routing::{get, post},
};
use base64::{Engine, engine::general_purpose::STANDARD};
use rand::RngCore;
use serde::{Deserialize, Serialize};

use crate::{
    AppState, CurrentUser, credits, db,
    header_truthy, net_guard,
};

// ---------------------------------------------------------------------------
// upstream resolution (shared with sync + async paths)
// ---------------------------------------------------------------------------

fn trim_slash(s: &str) -> &str {
    s.trim_end_matches('/')
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum ImageKind {
    Generate,
    Edit,
}

impl ImageKind {
    fn as_str(self) -> &'static str {
        match self {
            Self::Generate => "generate",
            Self::Edit => "edit",
        }
    }
}

fn image_endpoint(host: &str, protocol: &str, model: &str, kind: ImageKind) -> String {
    let base = trim_slash(host);
    match (protocol, kind) {
        ("openai", ImageKind::Generate) => format!("{base}/v1/images/generations"),
        ("openai", ImageKind::Edit) => format!("{base}/v1/images/edits"),
        ("gemini", ImageKind::Generate) => format!("{base}/v1beta/models/{model}:predict"),
        ("gemini", ImageKind::Edit) => format!("{base}/v1beta/models/{model}:generateContent"),
        _ => format!("{base}/"),
    }
}

async fn resolve_image_upstream(
    state: &AppState,
    protocol: &str,
    kind: ImageKind,
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
    let installed = state.require_installed().await?;
    match credits::read_shared(
        &installed.pool,
        installed.kind,
        protocol,
        credits::SharedFlavor::Image,
    )
    .await
    {
        Some(s) => {
            // Shared mode: model is client-chosen via X-Upstream-Model.
            let client_model = headers
                .get("x-upstream-model")
                .and_then(|v| v.to_str().ok())
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .unwrap_or_default()
                .to_string();
            if client_model.is_empty() {
                return Err((
                    StatusCode::BAD_REQUEST,
                    "请先在设置里选择模型（X-Upstream-Model 头缺失）",
                )
                    .into_response());
            }
            let url = image_endpoint(&s.url, protocol, &client_model, kind);
            Ok((url, s.key, true, Some(client_model)))
        }
        None => Err((
            StatusCode::BAD_REQUEST,
            "missing X-Upstream-Url/Key header (and no shared image backend configured)",
        )
            .into_response()),
    }
}

fn override_json_model(body: &[u8], new_model: &str) -> Vec<u8> {
    let Ok(mut v) = serde_json::from_slice::<serde_json::Value>(body) else {
        return body.to_vec();
    };
    if let Some(map) = v.as_object_mut() {
        if map.contains_key("model") {
            map.insert("model".into(), serde_json::Value::String(new_model.into()));
        }
    }
    serde_json::to_vec(&v).unwrap_or_else(|_| body.to_vec())
}

async fn deduct_image_credits(state: &AppState, user_id: i64, protocol: &str) -> Result<(), Response> {
    let installed = state.require_installed().await.map_err(|r| r)?;
    let cost = credits::get_setting_i64(&installed.pool, installed.kind, "cost_image", 5).await;
    match credits::try_deduct(
        &installed.pool,
        installed.kind,
        user_id,
        cost,
        &format!("image_{protocol}"),
    )
    .await
    {
        Ok(_) => Ok(()),
        Err(bal) => Err((
            StatusCode::PAYMENT_REQUIRED,
            format!(
                "积分不足：当前 {bal}，每次生图需要 {cost}；请在设置里填入自己的 API Key，或联系管理员充值"
            ),
        )
            .into_response()),
    }
}

async fn refund_image_credits(state: &AppState, user_id: i64, reason: &str) {
    let Ok(installed) = state.require_installed().await else {
        return;
    };
    let cost = credits::get_setting_i64(&installed.pool, installed.kind, "cost_image", 5).await;
    let _ = credits::grant(&installed.pool, installed.kind, user_id, cost, reason).await;
}

// ---------------------------------------------------------------------------
// response decoding → on-disk images
// ---------------------------------------------------------------------------

#[derive(Serialize, Deserialize, Clone)]
pub struct GeneratedImages {
    pub images: Vec<GeneratedImage>,
}

#[derive(Serialize, Deserialize, Clone)]
pub struct GeneratedImage {
    pub path: String,
    pub revised_prompt: Option<String>,
}

fn err(s: StatusCode, m: impl Into<String>) -> Response {
    (s, m.into()).into_response()
}

fn random_hex(n: usize) -> String {
    let mut bytes = vec![0u8; n];
    rand::rngs::OsRng.fill_bytes(&mut bytes);
    hex::encode(bytes)
}

/// Fatal upstream / decoding error. Carries a user-facing message.
#[derive(Debug)]
struct JobError(String);

impl std::fmt::Display for JobError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.0)
    }
}

async fn decode_openai_body(
    state: &AppState,
    raw: &[u8],
) -> Result<GeneratedImages, JobError> {
    let parsed: serde_json::Value =
        serde_json::from_slice(raw).map_err(|e| JobError(format!("parse: {e}")))?;

    let items = parsed
        .get("data")
        .and_then(|d| d.as_array())
        .cloned()
        .unwrap_or_default();

    let images_dir = state.data_dir.join("images");
    tokio::fs::create_dir_all(&images_dir)
        .await
        .map_err(|e| JobError(format!("mkdir: {e}")))?;

    let mut out = Vec::new();
    for item in items {
        let revised = item
            .get("revised_prompt")
            .and_then(|v| v.as_str())
            .map(String::from);

        let bytes: Vec<u8> = if let Some(b64) = item.get("b64_json").and_then(|v| v.as_str()) {
            STANDARD
                .decode(b64)
                .map_err(|e| JobError(format!("b64 decode: {e}")))?
        } else if let Some(remote) = item.get("url").and_then(|v| v.as_str()) {
            let (_parsed, host, addrs) = net_guard::validate_upstream_url(remote)
                .await
                .map_err(|r| JobError(format!("validate remote url: {}", response_to_text(r))))?;
            let client = net_guard::guarded_client_with_timeout(
                &host,
                &addrs,
                Duration::from_secs(120),
            )
            .map_err(|r| JobError(format!("client: {}", response_to_text(r))))?;
            let resp = client
                .get(remote)
                .send()
                .await
                .map_err(|e| JobError(format!("fetch image: {e}")))?;
            resp.bytes()
                .await
                .map_err(|e| JobError(format!("fetch image bytes: {e}")))?
                .to_vec()
        } else {
            continue;
        };

        let name = format!("{}.png", random_hex(16));
        let path = images_dir.join(&name);
        tokio::fs::write(&path, &bytes)
            .await
            .map_err(|e| JobError(format!("write: {e}")))?;
        out.push(GeneratedImage {
            path: format!("/api/images/{name}"),
            revised_prompt: revised,
        });
    }

    if out.is_empty() {
        return Err(JobError("upstream returned no images".into()));
    }
    Ok(GeneratedImages { images: out })
}

async fn decode_gemini_body(
    state: &AppState,
    raw: &[u8],
) -> Result<GeneratedImages, JobError> {
    let parsed: serde_json::Value =
        serde_json::from_slice(raw).map_err(|e| JobError(format!("parse: {e}")))?;

    let mut b64_items: Vec<(String, Option<String>)> = Vec::new();
    if let Some(preds) = parsed.get("predictions").and_then(|d| d.as_array()) {
        for p in preds {
            let data = p
                .get("bytesBase64Encoded")
                .and_then(|v| v.as_str())
                .or_else(|| p.pointer("/image/imageBytes").and_then(|v| v.as_str()));
            if let Some(d) = data {
                let mime = p.get("mimeType").and_then(|v| v.as_str()).map(String::from);
                b64_items.push((d.to_string(), mime));
            }
        }
    } else if let Some(cands) = parsed.get("candidates").and_then(|d| d.as_array()) {
        for c in cands {
            let Some(parts) = c.pointer("/content/parts").and_then(|v| v.as_array()) else {
                continue;
            };
            for part in parts {
                let Some(inline) = part.get("inlineData").or_else(|| part.get("inline_data"))
                else {
                    continue;
                };
                let Some(data) = inline.get("data").and_then(|v| v.as_str()) else {
                    continue;
                };
                let mime = inline
                    .get("mimeType")
                    .or_else(|| inline.get("mime_type"))
                    .and_then(|v| v.as_str())
                    .map(String::from);
                b64_items.push((data.to_string(), mime));
            }
        }
    }

    let images_dir = state.data_dir.join("images");
    tokio::fs::create_dir_all(&images_dir)
        .await
        .map_err(|e| JobError(format!("mkdir: {e}")))?;

    let mut out = Vec::new();
    for (b64, mime) in b64_items {
        let bytes = STANDARD
            .decode(&b64)
            .map_err(|e| JobError(format!("b64 decode: {e}")))?;
        let ext = match mime.as_deref() {
            Some("image/jpeg") => "jpg",
            Some("image/webp") => "webp",
            _ => "png",
        };
        let name = format!("{}.{ext}", random_hex(16));
        let path = images_dir.join(&name);
        tokio::fs::write(&path, &bytes)
            .await
            .map_err(|e| JobError(format!("write: {e}")))?;
        out.push(GeneratedImage {
            path: format!("/api/images/{name}"),
            revised_prompt: None,
        });
    }

    if out.is_empty() {
        return Err(JobError("upstream returned no images".into()));
    }
    Ok(GeneratedImages { images: out })
}

fn response_to_text(_r: Response) -> String {
    "upstream validation failed".into()
}

// ---------------------------------------------------------------------------
// core upstream calls (plain async fns; usable from sync handler or task)
// ---------------------------------------------------------------------------

struct OpenAiJsonReq {
    url: String,
    key: String,
    used_shared: bool,
    body: Vec<u8>,
}

async fn call_openai_json(
    state: &AppState,
    req: OpenAiJsonReq,
) -> Result<GeneratedImages, JobError> {
    let client = net_guard::client_for_upstream_with_timeout(
        &state.image_http,
        &req.url,
        req.used_shared,
        Duration::from_secs(600),
    )
    .await
    .map_err(|_| JobError("failed to build HTTP client".into()))?;

    let resp = client
        .post(&req.url)
        .bearer_auth(&req.key)
        .header(header::CONTENT_TYPE, "application/json")
        .body(req.body)
        .send()
        .await
        .map_err(|e| JobError(format!("upstream: {e}")))?;

    let status = resp.status();
    let raw = resp.bytes().await.unwrap_or_default();
    if !status.is_success() {
        return Err(JobError(format!(
            "upstream {status}: {}",
            String::from_utf8_lossy(&raw)
        )));
    }
    decode_openai_body(state, &raw).await
}

struct OpenAiMultipartReq {
    url: String,
    key: String,
    used_shared: bool,
    content_type: String,
    body: Vec<u8>,
}

async fn call_openai_multipart(
    state: &AppState,
    req: OpenAiMultipartReq,
) -> Result<GeneratedImages, JobError> {
    let client = net_guard::client_for_upstream_with_timeout(
        &state.image_http,
        &req.url,
        req.used_shared,
        Duration::from_secs(600),
    )
    .await
    .map_err(|_| JobError("failed to build HTTP client".into()))?;

    let resp = client
        .post(&req.url)
        .bearer_auth(&req.key)
        .header(header::CONTENT_TYPE, req.content_type)
        .body(req.body)
        .send()
        .await
        .map_err(|e| JobError(format!("upstream: {e}")))?;

    let status = resp.status();
    let raw = resp.bytes().await.unwrap_or_default();
    if !status.is_success() {
        return Err(JobError(format!(
            "upstream {status}: {}",
            String::from_utf8_lossy(&raw)
        )));
    }
    decode_openai_body(state, &raw).await
}

struct GeminiJsonReq {
    url: String,
    key: String,
    used_shared: bool,
    body: Vec<u8>,
}

async fn call_gemini_json(
    state: &AppState,
    req: GeminiJsonReq,
) -> Result<GeneratedImages, JobError> {
    let client = net_guard::client_for_upstream_with_timeout(
        &state.image_http,
        &req.url,
        req.used_shared,
        Duration::from_secs(600),
    )
    .await
    .map_err(|_| JobError("failed to build HTTP client".into()))?;

    let resp = client
        .post(&req.url)
        .header("x-goog-api-key", req.key.as_str())
        .header(header::CONTENT_TYPE, "application/json")
        .body(req.body)
        .send()
        .await
        .map_err(|e| JobError(format!("upstream: {e}")))?;

    let status = resp.status();
    let raw = resp.bytes().await.unwrap_or_default();
    if !status.is_success() {
        return Err(JobError(format!(
            "upstream {status}: {}",
            String::from_utf8_lossy(&raw)
        )));
    }
    decode_gemini_body(state, &raw).await
}

// ---------------------------------------------------------------------------
// legacy sync proxy endpoints (kept for backwards compatibility)
// ---------------------------------------------------------------------------

async fn proxy_openai_images(
    State(state): State<AppState>,
    Extension(user): Extension<CurrentUser>,
    headers: HeaderMap,
    body: axum::body::Bytes,
) -> Response {
    let (url, key, used_shared, shared_model) =
        match resolve_image_upstream(&state, "openai", ImageKind::Generate, &headers).await {
            Ok(v) => v,
            Err(r) => return r,
        };
    let body = match (used_shared, shared_model.as_deref()) {
        (true, Some(m)) if !m.is_empty() => override_json_model(&body, m),
        _ => body.to_vec(),
    };
    if used_shared {
        if let Err(r) = deduct_image_credits(&state, user.id, "openai").await {
            return r;
        }
    }
    match call_openai_json(&state, OpenAiJsonReq { url, key, used_shared, body }).await {
        Ok(r) => Json(r).into_response(),
        Err(e) => {
            if used_shared {
                refund_image_credits(&state, user.id, "refund_upstream_error").await;
            }
            err(StatusCode::BAD_GATEWAY, e.0)
        }
    }
}

async fn proxy_openai_images_edits(
    State(state): State<AppState>,
    Extension(user): Extension<CurrentUser>,
    headers: HeaderMap,
    body: axum::body::Bytes,
) -> Response {
    let (url, key, used_shared, _shared_model) =
        match resolve_image_upstream(&state, "openai", ImageKind::Edit, &headers).await {
            Ok(v) => v,
            Err(r) => return r,
        };
    let content_type = match headers
        .get(header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
    {
        Some(v) if v.starts_with("multipart/form-data") => v.to_string(),
        _ => return err(StatusCode::BAD_REQUEST, "expected multipart/form-data body"),
    };
    if used_shared {
        if let Err(r) = deduct_image_credits(&state, user.id, "openai").await {
            return r;
        }
    }
    match call_openai_multipart(
        &state,
        OpenAiMultipartReq {
            url,
            key,
            used_shared,
            content_type,
            body: body.to_vec(),
        },
    )
    .await
    {
        Ok(r) => Json(r).into_response(),
        Err(e) => {
            if used_shared {
                refund_image_credits(&state, user.id, "refund_upstream_error").await;
            }
            err(StatusCode::BAD_GATEWAY, e.0)
        }
    }
}

async fn proxy_gemini_images(
    State(state): State<AppState>,
    Extension(user): Extension<CurrentUser>,
    headers: HeaderMap,
    body: axum::body::Bytes,
) -> Response {
    let kind = headers
        .get("x-upstream-url")
        .and_then(|v| v.to_str().ok())
        .filter(|u| u.contains(":generateContent"))
        .map(|_| ImageKind::Edit)
        .unwrap_or(ImageKind::Generate);
    let (url, key, used_shared, _shared_model) =
        match resolve_image_upstream(&state, "gemini", kind, &headers).await {
            Ok(v) => v,
            Err(r) => return r,
        };
    if used_shared {
        if let Err(r) = deduct_image_credits(&state, user.id, "gemini").await {
            return r;
        }
    }
    match call_gemini_json(&state, GeminiJsonReq { url, key, used_shared, body: body.to_vec() }).await {
        Ok(r) => Json(r).into_response(),
        Err(e) => {
            if used_shared {
                refund_image_credits(&state, user.id, "refund_upstream_error").await;
            }
            err(StatusCode::BAD_GATEWAY, e.0)
        }
    }
}

// ---------------------------------------------------------------------------
// async job endpoints
// ---------------------------------------------------------------------------

#[derive(Serialize)]
struct JobCreated {
    token: String,
}

#[derive(Serialize)]
struct JobStatus {
    token: String,
    status: String,
    protocol: String,
    kind: String,
    error: Option<String>,
    images: Option<Vec<GeneratedImage>>,
    created_at: String,
    finished_at: Option<String>,
}

fn new_token() -> String {
    random_hex(16)
}

async fn insert_job(
    state: &AppState,
    user_id: i64,
    protocol: &str,
    kind: ImageKind,
    used_shared: bool,
) -> Result<String, Response> {
    let installed = state.require_installed().await?;
    let token = new_token();
    let sql = db::q(
        installed.kind,
        "INSERT INTO image_jobs (token, user_id, protocol, kind, used_shared, status)
         VALUES (?, ?, ?, ?, ?, 'pending')",
    );
    sqlx::query(&sql)
        .bind(&token)
        .bind(user_id)
        .bind(protocol)
        .bind(kind.as_str())
        .bind(if used_shared { 1_i64 } else { 0 })
        .execute(&installed.pool)
        .await
        .map_err(|e| err(StatusCode::INTERNAL_SERVER_ERROR, format!("db: {e}")))?;
    Ok(token)
}

async fn mark_running(state: &AppState, token: &str) {
    let Ok(installed) = state.require_installed().await else {
        return;
    };
    let now = db::now_expr(installed.kind);
    let sql = db::q(
        installed.kind,
        &format!(
            "UPDATE image_jobs SET status = 'running', started_at = {now} WHERE token = ?"
        ),
    );
    let _ = sqlx::query(&sql).bind(token).execute(&installed.pool).await;
}

async fn mark_done(state: &AppState, token: &str, result: &GeneratedImages) {
    let Ok(installed) = state.require_installed().await else {
        return;
    };
    let now = db::now_expr(installed.kind);
    let json = serde_json::to_string(result).unwrap_or_default();
    let sql = db::q(
        installed.kind,
        &format!(
            "UPDATE image_jobs SET status = 'done', result_json = ?, finished_at = {now}
             WHERE token = ?"
        ),
    );
    let _ = sqlx::query(&sql)
        .bind(&json)
        .bind(token)
        .execute(&installed.pool)
        .await;
}

async fn mark_failed(state: &AppState, token: &str, message: &str) {
    let Ok(installed) = state.require_installed().await else {
        return;
    };
    let now = db::now_expr(installed.kind);
    let trimmed: String = message.chars().take(2000).collect();
    let sql = db::q(
        installed.kind,
        &format!(
            "UPDATE image_jobs SET status = 'failed', error = ?, finished_at = {now}
             WHERE token = ?"
        ),
    );
    let _ = sqlx::query(&sql)
        .bind(&trimmed)
        .bind(token)
        .execute(&installed.pool)
        .await;
}

async fn start_openai_generate_job(
    State(state): State<AppState>,
    Extension(user): Extension<CurrentUser>,
    headers: HeaderMap,
    body: axum::body::Bytes,
) -> Response {
    let (url, key, used_shared, shared_model) =
        match resolve_image_upstream(&state, "openai", ImageKind::Generate, &headers).await {
            Ok(v) => v,
            Err(r) => return r,
        };
    let body = match (used_shared, shared_model.as_deref()) {
        (true, Some(m)) if !m.is_empty() => override_json_model(&body, m),
        _ => body.to_vec(),
    };
    if used_shared {
        if let Err(r) = deduct_image_credits(&state, user.id, "openai").await {
            return r;
        }
    }
    let token = match insert_job(&state, user.id, "openai", ImageKind::Generate, used_shared).await {
        Ok(t) => t,
        Err(r) => {
            if used_shared {
                refund_image_credits(&state, user.id, "refund_job_create_error").await;
            }
            return r;
        }
    };

    let state_c = state.clone();
    let token_c = token.clone();
    tokio::spawn(async move {
        mark_running(&state_c, &token_c).await;
        let res = call_openai_json(
            &state_c,
            OpenAiJsonReq { url, key, used_shared, body },
        )
        .await;
        match res {
            Ok(r) => mark_done(&state_c, &token_c, &r).await,
            Err(e) => {
                if used_shared {
                    refund_image_credits(&state_c, user.id, "refund_upstream_error").await;
                }
                mark_failed(&state_c, &token_c, &e.0).await;
            }
        }
    });

    Json(JobCreated { token }).into_response()
}

async fn start_openai_edit_job(
    State(state): State<AppState>,
    Extension(user): Extension<CurrentUser>,
    headers: HeaderMap,
    body: axum::body::Bytes,
) -> Response {
    let (url, key, used_shared, _shared_model) =
        match resolve_image_upstream(&state, "openai", ImageKind::Edit, &headers).await {
            Ok(v) => v,
            Err(r) => return r,
        };
    let content_type = match headers
        .get(header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
    {
        Some(v) if v.starts_with("multipart/form-data") => v.to_string(),
        _ => return err(StatusCode::BAD_REQUEST, "expected multipart/form-data body"),
    };
    if used_shared {
        if let Err(r) = deduct_image_credits(&state, user.id, "openai").await {
            return r;
        }
    }
    let token = match insert_job(&state, user.id, "openai", ImageKind::Edit, used_shared).await {
        Ok(t) => t,
        Err(r) => {
            if used_shared {
                refund_image_credits(&state, user.id, "refund_job_create_error").await;
            }
            return r;
        }
    };

    let state_c = state.clone();
    let token_c = token.clone();
    let body_vec = body.to_vec();
    tokio::spawn(async move {
        mark_running(&state_c, &token_c).await;
        let res = call_openai_multipart(
            &state_c,
            OpenAiMultipartReq {
                url,
                key,
                used_shared,
                content_type,
                body: body_vec,
            },
        )
        .await;
        match res {
            Ok(r) => mark_done(&state_c, &token_c, &r).await,
            Err(e) => {
                if used_shared {
                    refund_image_credits(&state_c, user.id, "refund_upstream_error").await;
                }
                mark_failed(&state_c, &token_c, &e.0).await;
            }
        }
    });

    Json(JobCreated { token }).into_response()
}

async fn start_gemini_job(
    State(state): State<AppState>,
    Extension(user): Extension<CurrentUser>,
    headers: HeaderMap,
    body: axum::body::Bytes,
) -> Response {
    let kind = headers
        .get("x-upstream-url")
        .and_then(|v| v.to_str().ok())
        .filter(|u| u.contains(":generateContent"))
        .map(|_| ImageKind::Edit)
        .unwrap_or(ImageKind::Generate);
    let (url, key, used_shared, _shared_model) =
        match resolve_image_upstream(&state, "gemini", kind, &headers).await {
            Ok(v) => v,
            Err(r) => return r,
        };
    if used_shared {
        if let Err(r) = deduct_image_credits(&state, user.id, "gemini").await {
            return r;
        }
    }
    let token = match insert_job(&state, user.id, "gemini", kind, used_shared).await {
        Ok(t) => t,
        Err(r) => {
            if used_shared {
                refund_image_credits(&state, user.id, "refund_job_create_error").await;
            }
            return r;
        }
    };

    let state_c = state.clone();
    let token_c = token.clone();
    let body_vec = body.to_vec();
    tokio::spawn(async move {
        mark_running(&state_c, &token_c).await;
        let res = call_gemini_json(
            &state_c,
            GeminiJsonReq { url, key, used_shared, body: body_vec },
        )
        .await;
        match res {
            Ok(r) => mark_done(&state_c, &token_c, &r).await,
            Err(e) => {
                if used_shared {
                    refund_image_credits(&state_c, user.id, "refund_upstream_error").await;
                }
                mark_failed(&state_c, &token_c, &e.0).await;
            }
        }
    });

    Json(JobCreated { token }).into_response()
}

async fn get_job(
    State(state): State<AppState>,
    Extension(user): Extension<CurrentUser>,
    Path(token): Path<String>,
) -> Response {
    let Ok(installed) = state.require_installed().await else {
        return err(StatusCode::SERVICE_UNAVAILABLE, "not installed");
    };
    let sql = db::q(
        installed.kind,
        "SELECT token, protocol, kind, status, result_json, error, created_at, finished_at
         FROM image_jobs WHERE token = ? AND user_id = ?",
    );
    let row: Option<(
        String,
        String,
        String,
        String,
        Option<String>,
        Option<String>,
        String,
        Option<String>,
    )> = sqlx::query_as(&sql)
        .bind(&token)
        .bind(user.id)
        .fetch_optional(&installed.pool)
        .await
        .ok()
        .flatten();
    let Some((token, protocol, kind, status, result_json, error, created_at, finished_at)) = row
    else {
        return err(StatusCode::NOT_FOUND, "job not found");
    };
    let images = result_json
        .as_deref()
        .and_then(|s| serde_json::from_str::<GeneratedImages>(s).ok())
        .map(|r| r.images);
    Json(JobStatus {
        token,
        status,
        protocol,
        kind,
        error,
        images,
        created_at,
        finished_at,
    })
    .into_response()
}

/// On startup, mark any still-running jobs as failed. Invoked from main
/// after the database is ready.
pub async fn cleanup_stale_jobs(pool: &db::Pool, kind: db::DbKind) {
    let now = db::now_expr(kind);
    let sql = db::q(
        kind,
        &format!(
            "UPDATE image_jobs SET status = 'failed', error = 'server restarted', finished_at = {now}
             WHERE status IN ('pending', 'running')"
        ),
    );
    let _ = sqlx::query(&sql).execute(pool).await;
}

// ---------------------------------------------------------------------------
// serve stored image
// ---------------------------------------------------------------------------

async fn serve_image(
    State(state): State<AppState>,
    Extension(_user): Extension<CurrentUser>,
    Path(name): Path<String>,
) -> Response {
    if name.contains("..") || name.contains('/') || name.contains('\\') {
        return StatusCode::BAD_REQUEST.into_response();
    }
    let path = state.data_dir.join("images").join(&name);
    let bytes = match tokio::fs::read(&path).await {
        Ok(b) => b,
        Err(_) => return StatusCode::NOT_FOUND.into_response(),
    };
    let mime = mime_guess::from_path(&path).first_or_octet_stream();
    Response::builder()
        .header(header::CONTENT_TYPE, mime.as_ref())
        .header(header::CACHE_CONTROL, "private, max-age=86400, immutable")
        .body(Body::from(bytes))
        .unwrap()
}

pub fn routes() -> Router<AppState> {
    Router::new()
        .route("/proxy/openai/images", post(proxy_openai_images))
        .route("/proxy/openai/images/edits", post(proxy_openai_images_edits))
        .route("/proxy/gemini/images", post(proxy_gemini_images))
        .route("/images/jobs/openai", post(start_openai_generate_job))
        .route("/images/jobs/openai/edits", post(start_openai_edit_job))
        .route("/images/jobs/gemini", post(start_gemini_job))
        .route("/images/jobs/{token}", get(get_job))
        .route("/images/{name}", get(serve_image))
}
