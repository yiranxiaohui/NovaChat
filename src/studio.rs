use std::time::Duration;

use axum::{
    Extension, Json, Router,
    extract::{Path, Query, State},
    http::{HeaderMap, StatusCode, header},
    response::{IntoResponse, Response},
    routing::{get, post},
};
use base64::{Engine, engine::general_purpose::STANDARD};
use rand::RngCore;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

use crate::{
    AppState, CurrentUser, InstalledState, credits, db,
    header_truthy, net_guard,
};

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

fn err(s: StatusCode, m: impl Into<String>) -> Response {
    (s, m.into()).into_response()
}

fn random_hex(n: usize) -> String {
    let mut bytes = vec![0u8; n];
    rand::rngs::OsRng.fill_bytes(&mut bytes);
    hex::encode(bytes)
}

fn read_header<'a>(headers: &'a HeaderMap, name: &str) -> Option<&'a str> {
    headers.get(name).and_then(|v| v.to_str().ok())
}

/// Parse a data: URL into raw bytes + best-guess extension.
fn parse_data_url(s: &str) -> Option<(Vec<u8>, &'static str, &'static str)> {
    let rest = s.strip_prefix("data:")?;
    let (meta, b64) = rest.split_once(";base64,")?;
    let (ext, mime) = if meta.contains("jpeg") || meta.contains("jpg") {
        ("jpg", "image/jpeg")
    } else if meta.contains("webp") {
        ("webp", "image/webp")
    } else {
        ("png", "image/png")
    };
    let bytes = STANDARD.decode(b64.trim()).ok()?;
    Some((bytes, ext, mime))
}

async fn write_image_to_disk(
    data_dir: &std::path::Path,
    bytes: &[u8],
    ext: &str,
) -> Result<String, std::io::Error> {
    let dir = data_dir.join("images");
    tokio::fs::create_dir_all(&dir).await?;
    let name = format!("{}.{}", random_hex(16), ext);
    let path = dir.join(&name);
    tokio::fs::write(&path, bytes).await?;
    Ok(format!("/api/images/{name}"))
}

// ---------------------------------------------------------------------------
// upstream resolution
// ---------------------------------------------------------------------------

async fn resolve_openai_image_upstream(
    state: &AppState,
    headers: &HeaderMap,
    edit: bool,
) -> Result<(String, String, bool, Option<String>), Response> {
    let want_shared = header_truthy(headers, "x-use-shared");
    if !want_shared {
        let hdr_url = read_header(headers, "x-upstream-url");
        let hdr_key = read_header(headers, "x-upstream-key");
        if let (Some(u), Some(k)) = (hdr_url, hdr_key) {
            if !u.is_empty() && !k.is_empty() {
                let base = u.trim_end_matches('/');
                let path = if edit { "/v1/images/edits" } else { "/v1/images/generations" };
                return Ok((format!("{base}{path}"), k.to_string(), false, None));
            }
        }
    }
    let installed = state.require_installed().await?;
    match credits::read_shared(
        &installed.pool,
        installed.kind,
        "openai",
        credits::SharedFlavor::Image,
    )
    .await
    {
        Some(s) => {
            let base = s.url.trim_end_matches('/');
            let path = if edit { "/v1/images/edits" } else { "/v1/images/generations" };
            Ok((format!("{base}{path}"), s.key, true, s.model))
        }
        None => Err(err(
            StatusCode::BAD_REQUEST,
            "缺少 X-Upstream-Url/Key 头，且未配置共享 OpenAI 图像后端",
        )),
    }
}

// ---------------------------------------------------------------------------
// generation row
// ---------------------------------------------------------------------------

#[derive(Serialize, Clone)]
struct Generation {
    id: i64,
    token: String,
    status: String,
    error: Option<String>,
    prompt: String,
    revised_prompt: Option<String>,
    model: Option<String>,
    size: Option<String>,
    quality: Option<String>,
    style: Option<String>,
    n: i64,
    image_path: Option<String>,
    source_path: Option<String>,
    used_shared: bool,
    created_at: String,
    finished_at: Option<String>,
}

type GenRow = (
    i64,
    String,
    String,
    Option<String>,
    String,
    Option<String>,
    Option<String>,
    Option<String>,
    Option<String>,
    Option<String>,
    i64,
    Option<String>,
    Option<String>,
    i64,
    String,
    Option<String>,
);

const GEN_COLS: &str =
    "id, token, status, error, prompt, revised_prompt, model, size, quality, style,
     n, image_path, source_path, used_shared, created_at, finished_at";

fn gen_from_row(r: GenRow) -> Generation {
    Generation {
        id: r.0,
        token: r.1,
        status: r.2,
        error: r.3,
        prompt: r.4,
        revised_prompt: r.5,
        model: r.6,
        size: r.7,
        quality: r.8,
        style: r.9,
        n: r.10,
        image_path: r.11,
        source_path: r.12,
        used_shared: r.13 != 0,
        created_at: r.14,
        finished_at: r.15,
    }
}

// ---------------------------------------------------------------------------
// params + submit
// ---------------------------------------------------------------------------

#[derive(Deserialize)]
struct GenerateReq {
    prompt: String,
    #[serde(default)]
    model: Option<String>,
    #[serde(default)]
    size: Option<String>,
    #[serde(default)]
    quality: Option<String>,
    #[serde(default)]
    style: Option<String>,
    /// Optional attached source image (data: URL) — switches to /v1/images/edits.
    #[serde(default)]
    image_data_url: Option<String>,
}

#[derive(Serialize)]
struct GenerateCreated {
    token: String,
}

async fn insert_pending(
    pool: &db::Pool,
    kind: db::DbKind,
    user_id: i64,
    token: &str,
    prompt: &str,
    model: Option<&str>,
    size: Option<&str>,
    quality: Option<&str>,
    style: Option<&str>,
    source_path: Option<&str>,
    used_shared: bool,
) -> Result<i64, sqlx::Error> {
    let ins = db::q(
        kind,
        "INSERT INTO studio_generations
           (token, user_id, status, prompt, model, size, quality, style,
            n, source_path, used_shared)
         VALUES (?, ?, 'pending', ?, ?, ?, ?, ?, 1, ?, ?)",
    );
    match kind {
        db::DbKind::Sqlite | db::DbKind::Postgres => {
            let row: (i64,) = sqlx::query_as(&format!("{ins} RETURNING id"))
                .bind(token)
                .bind(user_id)
                .bind(prompt)
                .bind(model)
                .bind(size)
                .bind(quality)
                .bind(style)
                .bind(source_path)
                .bind(if used_shared { 1_i64 } else { 0 })
                .fetch_one(pool)
                .await?;
            Ok(row.0)
        }
        db::DbKind::Mysql => {
            let mut tx = pool.begin().await?;
            sqlx::query(&ins)
                .bind(token)
                .bind(user_id)
                .bind(prompt)
                .bind(model)
                .bind(size)
                .bind(quality)
                .bind(style)
                .bind(source_path)
                .bind(if used_shared { 1_i64 } else { 0 })
                .execute(&mut *tx)
                .await?;
            let (id,): (i64,) =
                sqlx::query_as("SELECT LAST_INSERT_ID()").fetch_one(&mut *tx).await?;
            tx.commit().await?;
            Ok(id)
        }
    }
}

async fn finalize_done(
    pool: &db::Pool,
    kind: db::DbKind,
    token: &str,
    image_path: &str,
    revised_prompt: Option<&str>,
) {
    let now = db::now_expr(kind);
    let sql = db::q(
        kind,
        &format!(
            "UPDATE studio_generations
             SET status = 'done', image_path = ?, revised_prompt = ?, finished_at = {now}
             WHERE token = ?"
        ),
    );
    let _ = sqlx::query(&sql)
        .bind(image_path)
        .bind(revised_prompt)
        .bind(token)
        .execute(pool)
        .await;
}

async fn finalize_failed(pool: &db::Pool, kind: db::DbKind, token: &str, error: &str) {
    let now = db::now_expr(kind);
    let trimmed: String = error.chars().take(2000).collect();
    let sql = db::q(
        kind,
        &format!(
            "UPDATE studio_generations
             SET status = 'failed', error = ?, finished_at = {now}
             WHERE token = ?"
        ),
    );
    let _ = sqlx::query(&sql)
        .bind(&trimmed)
        .bind(token)
        .execute(pool)
        .await;
}

async fn submit_generate(
    State(state): State<AppState>,
    Extension(installed): Extension<InstalledState>,
    Extension(user): Extension<CurrentUser>,
    headers: HeaderMap,
    Json(body): Json<GenerateReq>,
) -> Response {
    let prompt = body.prompt.trim().to_string();
    if prompt.is_empty() {
        return err(StatusCode::BAD_REQUEST, "prompt 不能为空");
    }

    // Persist attached image as source (so it can be re-used in history view).
    let mut source_path: Option<String> = None;
    let mut source_bytes: Option<(Vec<u8>, &'static str)> = None;
    if let Some(durl) = body.image_data_url.as_deref() {
        match parse_data_url(durl) {
            Some((bytes, ext, mime)) => {
                match write_image_to_disk(&state.data_dir, &bytes, ext).await {
                    Ok(p) => source_path = Some(p),
                    Err(e) => {
                        return err(
                            StatusCode::INTERNAL_SERVER_ERROR,
                            format!("save source: {e}"),
                        );
                    }
                }
                source_bytes = Some((bytes, mime));
            }
            None => return err(StatusCode::BAD_REQUEST, "附加图片格式不支持"),
        }
    }

    let edit = source_bytes.is_some();
    let (url, key, used_shared, admin_model) =
        match resolve_openai_image_upstream(&state, &headers, edit).await {
            Ok(v) => v,
            Err(r) => return r,
        };

    // Model is always client-chosen now (body.model from studio UI).
    // admin_model is ignored — the admin-configured model field was removed
    // from the shared-backend panel so users can freely pick any model.
    let _ = admin_model;
    let model = body
        .model
        .clone()
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| "gpt-image-1".into());

    // Credits.
    if used_shared {
        let cost =
            credits::get_setting_i64(&installed.pool, installed.kind, "cost_image", 5).await;
        if cost > 0 {
            if let Err(bal) = credits::try_deduct(
                &installed.pool,
                installed.kind,
                user.id,
                cost,
                "studio_generate",
            )
            .await
            {
                return err(
                    StatusCode::PAYMENT_REQUIRED,
                    format!("积分不足：当前 {bal}，本次需要 {cost}"),
                );
            }
        }
    }

    let token = random_hex(16);
    if let Err(e) = insert_pending(
        &installed.pool,
        installed.kind,
        user.id,
        &token,
        &prompt,
        Some(&model),
        body.size.as_deref(),
        body.quality.as_deref(),
        body.style.as_deref(),
        source_path.as_deref(),
        used_shared,
    )
    .await
    {
        return err(StatusCode::INTERNAL_SERVER_ERROR, e.to_string());
    }

    // Spawn background task.
    let state_c = state.clone();
    let token_c = token.clone();
    let prompt_c = prompt.clone();
    let model_c = model.clone();
    let size_c = body.size.clone();
    let quality_c = body.quality.clone();
    let style_c = body.style.clone();
    let source_bytes_c = source_bytes;
    tokio::spawn(async move {
        let Ok(installed) = state_c.require_installed().await else { return };
        let pool = installed.pool.clone();
        let kind = installed.kind;

        let client = match net_guard::client_for_upstream_with_timeout(
            &state_c.image_http,
            &url,
            used_shared,
            Duration::from_secs(600),
        )
        .await
        {
            Ok(c) => c,
            Err(_) => {
                finalize_failed(&pool, kind, &token_c, "HTTP client 构建失败").await;
                if used_shared {
                    let cost = credits::get_setting_i64(&pool, kind, "cost_image", 5).await;
                    let _ = credits::grant(&pool, kind, user.id, cost, "refund_studio_error").await;
                }
                return;
            }
        };

        // Retry transient upstream errors (connection errors, 429, 5xx) up to
        // MAX_ATTEMPTS times with exponential backoff. 4xx other than 429 are
        // returned as terminal immediately — they're usually prompt violations
        // or config problems where retrying just wastes time.
        const MAX_ATTEMPTS: u32 = 3;
        let mut attempt: u32 = 0;
        let mut last_transient: Option<String> = None;
        let (status, raw) = loop {
            attempt += 1;
            let resp_result = if let Some((bytes, mime)) = source_bytes_c.as_ref() {
                // /v1/images/edits → multipart form. Bytes are cloned per
                // attempt so retries can rebuild the form.
                let part = match reqwest::multipart::Part::bytes(bytes.clone())
                    .file_name(format!("source.{}", mime_to_ext(mime)))
                    .mime_str(mime)
                {
                    Ok(p) => p,
                    Err(e) => {
                        finalize_failed(&pool, kind, &token_c, &format!("multipart: {e}")).await;
                        if used_shared {
                            let cost = credits::get_setting_i64(&pool, kind, "cost_image", 5).await;
                            let _ = credits::grant(&pool, kind, user.id, cost, "refund_studio_error").await;
                        }
                        return;
                    }
                };
                let mut form = reqwest::multipart::Form::new()
                    .text("model", model_c.clone())
                    .text("prompt", prompt_c.clone())
                    .text("n", "1")
                    .part("image", part);
                if let Some(s) = size_c.as_deref() {
                    if !s.is_empty() && s != "auto" {
                        form = form.text("size", s.to_string());
                    }
                }
                if let Some(q) = quality_c.as_deref() {
                    if !q.is_empty() {
                        form = form.text("quality", q.to_string());
                    }
                }
                client.post(&url).bearer_auth(&key).multipart(form).send().await
            } else {
                // /v1/images/generations → JSON
                let mut body = json!({
                    "model": model_c,
                    "prompt": prompt_c,
                    "n": 1,
                });
                if let Some(s) = size_c.as_deref() {
                    if !s.is_empty() {
                        body["size"] = json!(s);
                    }
                }
                if let Some(q) = quality_c.as_deref() {
                    if !q.is_empty() {
                        body["quality"] = json!(q);
                    }
                }
                if let Some(st) = style_c.as_deref() {
                    if !st.is_empty() {
                        body["style"] = json!(st);
                    }
                }
                // gpt-image-1 returns b64 by default; dall-e/classic models need
                // response_format explicitly. Always request b64 for consistent parsing.
                body["response_format"] = json!("b64_json");
                client
                    .post(&url)
                    .bearer_auth(&key)
                    .header(header::CONTENT_TYPE, "application/json")
                    .json(&body)
                    .send()
                    .await
            };

            match resp_result {
                Ok(r) => {
                    let status = r.status();
                    let code = status.as_u16();
                    let transient = code == 429 || code >= 500;
                    let raw = r.bytes().await.unwrap_or_default();
                    if status.is_success() || !transient || attempt >= MAX_ATTEMPTS {
                        break (status, raw);
                    }
                    last_transient = Some(format!(
                        "upstream {status}: {}",
                        String::from_utf8_lossy(&raw)
                    ));
                }
                Err(e) => {
                    if attempt >= MAX_ATTEMPTS {
                        let msg = match last_transient {
                            Some(prev) => format!(
                                "upstream: {e}（已重试 {} 次，上次：{}）",
                                attempt - 1,
                                prev
                            ),
                            None => format!("upstream: {e}（已重试 {} 次）", attempt - 1),
                        };
                        finalize_failed(&pool, kind, &token_c, &msg).await;
                        if used_shared {
                            let cost = credits::get_setting_i64(&pool, kind, "cost_image", 5).await;
                            let _ = credits::grant(&pool, kind, user.id, cost, "refund_studio_error").await;
                        }
                        return;
                    }
                    last_transient = Some(format!("upstream: {e}"));
                }
            }

            // Backoff: 0.8s, 2.4s (multiplied by 3^n).
            let delay_ms = 800u64 * 3u64.pow(attempt - 1);
            tokio::time::sleep(Duration::from_millis(delay_ms)).await;
        };

        if !status.is_success() {
            let msg = if attempt > 1 {
                format!(
                    "upstream {status}（已重试 {} 次）: {}",
                    attempt - 1,
                    String::from_utf8_lossy(&raw)
                )
            } else {
                format!("upstream {status}: {}", String::from_utf8_lossy(&raw))
            };
            finalize_failed(&pool, kind, &token_c, &msg).await;
            if used_shared {
                let cost = credits::get_setting_i64(&pool, kind, "cost_image", 5).await;
                let _ = credits::grant(&pool, kind, user.id, cost, "refund_studio_error").await;
            }
            return;
        }

        // Parse { data: [{ b64_json, revised_prompt? }] } — take first item.
        let parsed: Value = match serde_json::from_slice(&raw) {
            Ok(v) => v,
            Err(e) => {
                finalize_failed(&pool, kind, &token_c, &format!("parse: {e}")).await;
                return;
            }
        };
        let first = parsed
            .get("data")
            .and_then(|d| d.as_array())
            .and_then(|a| a.first());
        let Some(item) = first else {
            finalize_failed(&pool, kind, &token_c, "上游未返回图像数据").await;
            if used_shared {
                let cost = credits::get_setting_i64(&pool, kind, "cost_image", 5).await;
                let _ = credits::grant(&pool, kind, user.id, cost, "refund_studio_error").await;
            }
            return;
        };
        let revised = item
            .get("revised_prompt")
            .and_then(|v| v.as_str())
            .map(String::from);
        let bytes = if let Some(b64) = item.get("b64_json").and_then(|v| v.as_str()) {
            match STANDARD.decode(b64) {
                Ok(b) => b,
                Err(e) => {
                    finalize_failed(&pool, kind, &token_c, &format!("b64 decode: {e}")).await;
                    return;
                }
            }
        } else if let Some(remote) = item.get("url").and_then(|v| v.as_str()) {
            let (_parsed, host, addrs) = match net_guard::validate_upstream_url(remote).await {
                Ok(v) => v,
                Err(_) => {
                    finalize_failed(&pool, kind, &token_c, "remote image URL 校验失败").await;
                    return;
                }
            };
            let gc = match net_guard::guarded_client_with_timeout(
                &host,
                &addrs,
                Duration::from_secs(120),
            ) {
                Ok(c) => c,
                Err(_) => {
                    finalize_failed(&pool, kind, &token_c, "remote client 构建失败").await;
                    return;
                }
            };
            match gc.get(remote).send().await {
                Ok(r) => r.bytes().await.unwrap_or_default().to_vec(),
                Err(e) => {
                    finalize_failed(&pool, kind, &token_c, &format!("fetch image: {e}")).await;
                    return;
                }
            }
        } else {
            finalize_failed(&pool, kind, &token_c, "上游返回缺少 b64_json/url").await;
            return;
        };

        let stored = match write_image_to_disk(&state_c.data_dir, &bytes, "png").await {
            Ok(p) => p,
            Err(e) => {
                finalize_failed(&pool, kind, &token_c, &format!("write: {e}")).await;
                return;
            }
        };

        finalize_done(&pool, kind, &token_c, &stored, revised.as_deref()).await;
    });

    Json(GenerateCreated { token }).into_response()
}

fn mime_to_ext(mime: &str) -> &'static str {
    match mime {
        "image/jpeg" => "jpg",
        "image/webp" => "webp",
        _ => "png",
    }
}

// ---------------------------------------------------------------------------
// polling + history + delete
// ---------------------------------------------------------------------------

async fn get_generation(
    Extension(installed): Extension<InstalledState>,
    Extension(user): Extension<CurrentUser>,
    Path(token): Path<String>,
) -> Response {
    let sql = db::q(
        installed.kind,
        &format!(
            "SELECT {GEN_COLS} FROM studio_generations WHERE token = ? AND user_id = ?"
        ),
    );
    let row: Option<GenRow> = sqlx::query_as(&sql)
        .bind(&token)
        .bind(user.id)
        .fetch_optional(&installed.pool)
        .await
        .ok()
        .flatten();
    match row {
        Some(r) => Json(gen_from_row(r)).into_response(),
        None => err(StatusCode::NOT_FOUND, "任务不存在"),
    }
}

#[derive(Deserialize)]
struct ListQuery {
    page: Option<i64>,
}

async fn list_generations(
    Extension(installed): Extension<InstalledState>,
    Extension(user): Extension<CurrentUser>,
    Query(q): Query<ListQuery>,
) -> Response {
    let page = q.page.unwrap_or(1).max(1);
    let per_page: i64 = 30;
    let offset = (page - 1) * per_page;
    let sql = db::q(
        installed.kind,
        &format!(
            "SELECT {GEN_COLS} FROM studio_generations
             WHERE user_id = ?
             ORDER BY created_at DESC, id DESC
             LIMIT ? OFFSET ?"
        ),
    );
    let rows: Result<Vec<GenRow>, _> = sqlx::query_as(&sql)
        .bind(user.id)
        .bind(per_page)
        .bind(offset)
        .fetch_all(&installed.pool)
        .await;
    match rows {
        Ok(r) => Json(r.into_iter().map(gen_from_row).collect::<Vec<_>>()).into_response(),
        Err(e) => err(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()),
    }
}

async fn delete_generation(
    Extension(installed): Extension<InstalledState>,
    Extension(user): Extension<CurrentUser>,
    Path(id): Path<i64>,
) -> Response {
    let sql = db::q(
        installed.kind,
        "DELETE FROM studio_generations WHERE id = ? AND user_id = ?",
    );
    let _ = sqlx::query(&sql)
        .bind(id)
        .bind(user.id)
        .execute(&installed.pool)
        .await;
    StatusCode::NO_CONTENT.into_response()
}

/// On startup: anything left pending is stale.
pub async fn cleanup_stale_jobs(pool: &db::Pool, kind: db::DbKind) {
    let now = db::now_expr(kind);
    let sql = db::q(
        kind,
        &format!(
            "UPDATE studio_generations SET status = 'failed', error = 'server restarted',
                    finished_at = {now}
             WHERE status IN ('pending', 'running')"
        ),
    );
    let _ = sqlx::query(&sql).execute(pool).await;
}

// ---------------------------------------------------------------------------
// routes
// ---------------------------------------------------------------------------

pub fn routes() -> Router<AppState> {
    Router::new()
        .route("/studio/generate", post(submit_generate))
        .route("/studio/generations", get(list_generations))
        .route("/studio/generations/{id}", axum::routing::delete(delete_generation))
        .route("/studio/jobs/{token}", get(get_generation))
        .route("/studio/models", get(list_models))
}

// ---------------------------------------------------------------------------
// models: resolve the same upstream (image flavor for shared) and GET /v1/models
// ---------------------------------------------------------------------------

async fn list_models(
    State(state): State<AppState>,
    Extension(_installed): Extension<InstalledState>,
    Extension(_user): Extension<CurrentUser>,
    headers: HeaderMap,
) -> Response {
    let want_shared = header_truthy(&headers, "x-use-shared");

    let (base_url, key, used_shared) = if !want_shared {
        let hdr_url = read_header(&headers, "x-upstream-url");
        let hdr_key = read_header(&headers, "x-upstream-key");
        match (hdr_url, hdr_key) {
            (Some(u), Some(k)) if !u.is_empty() && !k.is_empty() => {
                (u.trim_end_matches('/').to_string(), k.to_string(), false)
            }
            _ => {
                return err(
                    StatusCode::BAD_REQUEST,
                    "缺少 X-Upstream-Url/Key 头",
                );
            }
        }
    } else {
        let installed = match state.require_installed().await {
            Ok(s) => s,
            Err(r) => return r,
        };
        match credits::read_shared(
            &installed.pool,
            installed.kind,
            "openai",
            credits::SharedFlavor::Image,
        )
        .await
        {
            Some(s) => (s.url.trim_end_matches('/').to_string(), s.key, true),
            None => {
                return err(
                    StatusCode::SERVICE_UNAVAILABLE,
                    "共享图像后端未配置",
                );
            }
        }
    };

    let url = format!("{base_url}/v1/models");
    let client = match net_guard::client_for_upstream(&state.http, &url, used_shared).await {
        Ok(c) => c,
        Err(r) => return r,
    };

    let resp = match client
        .get(&url)
        .header(header::ACCEPT, "application/json")
        .bearer_auth(&key)
        .send()
        .await
    {
        Ok(r) => r,
        Err(e) => return err(StatusCode::BAD_GATEWAY, format!("upstream: {e}")),
    };
    let status = resp.status();
    if !status.is_success() {
        let body = resp.text().await.unwrap_or_default();
        return err(StatusCode::BAD_GATEWAY, format!("upstream {status}: {body}"));
    }
    let parsed: Value = match resp.json().await {
        Ok(v) => v,
        Err(e) => return err(StatusCode::BAD_GATEWAY, format!("parse: {e}")),
    };

    let mut models: Vec<String> = parsed
        .get("data")
        .and_then(|d| d.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|m| m.get("id").and_then(|x| x.as_str()).map(String::from))
                .collect()
        })
        .unwrap_or_default();
    models.sort();
    models.dedup();

    Json(json!({ "models": models })).into_response()
}
