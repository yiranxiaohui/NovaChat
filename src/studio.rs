use std::time::Duration;

use axum::{
    Extension, Json, Router,
    extract::{Path, State},
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
// models
// ---------------------------------------------------------------------------

#[derive(Serialize, sqlx::FromRow)]
struct Conversation {
    id: i64,
    title: String,
    model: Option<String>,
    created_at: String,
    updated_at: String,
}

#[derive(Serialize, Clone)]
struct Message {
    id: i64,
    role: String,
    text: Option<String>,
    images: Vec<StoredImage>,
    created_at: String,
}

#[derive(Serialize, Deserialize, Clone)]
struct StoredImage {
    path: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    revised_prompt: Option<String>,
}

fn err(s: StatusCode, m: impl Into<String>) -> Response {
    (s, m.into()).into_response()
}

fn random_hex(n: usize) -> String {
    let mut bytes = vec![0u8; n];
    rand::rngs::OsRng.fill_bytes(&mut bytes);
    hex::encode(bytes)
}

// ---------------------------------------------------------------------------
// CRUD: conversations
// ---------------------------------------------------------------------------

async fn ensure_owner(
    pool: &db::Pool,
    kind: db::DbKind,
    conv_id: i64,
    user_id: i64,
) -> Result<(), Response> {
    let sql = db::q(
        kind,
        "SELECT 1 FROM studio_conversations WHERE id = ? AND user_id = ?",
    );
    let row: Option<(i32,)> = sqlx::query_as(&sql)
        .bind(conv_id)
        .bind(user_id)
        .fetch_optional(pool)
        .await
        .map_err(|e| err(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
    row.ok_or_else(|| err(StatusCode::NOT_FOUND, "工作台不存在"))
        .map(|_| ())
}

async fn list_conversations(
    Extension(installed): Extension<InstalledState>,
    Extension(user): Extension<CurrentUser>,
) -> Response {
    let sql = db::q(
        installed.kind,
        "SELECT id, title, model, created_at, updated_at FROM studio_conversations
         WHERE user_id = ? ORDER BY updated_at DESC",
    );
    let rows: Result<Vec<Conversation>, _> = sqlx::query_as(&sql)
        .bind(user.id)
        .fetch_all(&installed.pool)
        .await;
    match rows {
        Ok(r) => Json(r).into_response(),
        Err(e) => err(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()),
    }
}

#[derive(Deserialize)]
struct NewConv {
    title: Option<String>,
    model: Option<String>,
}

async fn create_conversation(
    Extension(installed): Extension<InstalledState>,
    Extension(user): Extension<CurrentUser>,
    Json(body): Json<NewConv>,
) -> Response {
    let title = body
        .title
        .as_deref()
        .map(|s| s.trim())
        .filter(|s| !s.is_empty())
        .unwrap_or("新建工作台")
        .chars()
        .take(80)
        .collect::<String>();
    let model = body
        .model
        .as_deref()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty());

    let ins = db::q(
        installed.kind,
        "INSERT INTO studio_conversations (user_id, title, model) VALUES (?, ?, ?)",
    );
    let id = match installed.kind {
        db::DbKind::Sqlite | db::DbKind::Postgres => {
            let row: Result<(i64,), _> = sqlx::query_as(&format!("{ins} RETURNING id"))
                .bind(user.id)
                .bind(&title)
                .bind(&model)
                .fetch_one(&installed.pool)
                .await;
            match row {
                Ok((id,)) => id,
                Err(e) => return err(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()),
            }
        }
        db::DbKind::Mysql => {
            let mut tx = match installed.pool.begin().await {
                Ok(t) => t,
                Err(e) => return err(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()),
            };
            if let Err(e) = sqlx::query(&ins)
                .bind(user.id)
                .bind(&title)
                .bind(&model)
                .execute(&mut *tx)
                .await
            {
                return err(StatusCode::INTERNAL_SERVER_ERROR, e.to_string());
            }
            let id_row: Result<(i64,), _> = sqlx::query_as("SELECT LAST_INSERT_ID()")
                .fetch_one(&mut *tx)
                .await;
            if let Err(e) = tx.commit().await {
                return err(StatusCode::INTERNAL_SERVER_ERROR, e.to_string());
            }
            match id_row {
                Ok((id,)) => id,
                Err(e) => return err(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()),
            }
        }
    };

    Json(json!({
        "id": id,
        "title": title,
        "model": model,
    }))
    .into_response()
}

#[derive(Deserialize)]
struct UpdateConv {
    title: Option<String>,
    model: Option<String>,
}

async fn update_conversation(
    Extension(installed): Extension<InstalledState>,
    Extension(user): Extension<CurrentUser>,
    Path(conv_id): Path<i64>,
    Json(body): Json<UpdateConv>,
) -> Response {
    if let Err(r) = ensure_owner(&installed.pool, installed.kind, conv_id, user.id).await {
        return r;
    }
    let now = db::now_expr(installed.kind);
    if let Some(t) = body.title.as_deref() {
        let sql = db::q(
            installed.kind,
            &format!("UPDATE studio_conversations SET title = ?, updated_at = {now} WHERE id = ?"),
        );
        if let Err(e) = sqlx::query(&sql)
            .bind(t.trim().chars().take(80).collect::<String>())
            .bind(conv_id)
            .execute(&installed.pool)
            .await
        {
            return err(StatusCode::INTERNAL_SERVER_ERROR, e.to_string());
        }
    }
    if let Some(m) = body.model.as_deref() {
        let sql = db::q(
            installed.kind,
            &format!("UPDATE studio_conversations SET model = ?, updated_at = {now} WHERE id = ?"),
        );
        let v = m.trim();
        let bind_model: Option<String> = if v.is_empty() { None } else { Some(v.to_string()) };
        if let Err(e) = sqlx::query(&sql)
            .bind(bind_model)
            .bind(conv_id)
            .execute(&installed.pool)
            .await
        {
            return err(StatusCode::INTERNAL_SERVER_ERROR, e.to_string());
        }
    }
    StatusCode::NO_CONTENT.into_response()
}

async fn delete_conversation(
    Extension(installed): Extension<InstalledState>,
    Extension(user): Extension<CurrentUser>,
    Path(conv_id): Path<i64>,
) -> Response {
    if let Err(r) = ensure_owner(&installed.pool, installed.kind, conv_id, user.id).await {
        return r;
    }
    let sql = db::q(
        installed.kind,
        "DELETE FROM studio_conversations WHERE id = ? AND user_id = ?",
    );
    let _ = sqlx::query(&sql)
        .bind(conv_id)
        .bind(user.id)
        .execute(&installed.pool)
        .await;
    StatusCode::NO_CONTENT.into_response()
}

// ---------------------------------------------------------------------------
// CRUD: messages
// ---------------------------------------------------------------------------

async fn load_messages(
    pool: &db::Pool,
    kind: db::DbKind,
    conv_id: i64,
) -> Result<Vec<Message>, sqlx::Error> {
    let sql = db::q(
        kind,
        "SELECT id, role, text, images_json, created_at FROM studio_messages
         WHERE conversation_id = ? ORDER BY id ASC",
    );
    let rows: Vec<(i64, String, Option<String>, Option<String>, String)> =
        sqlx::query_as(&sql).bind(conv_id).fetch_all(pool).await?;
    Ok(rows
        .into_iter()
        .map(|(id, role, text, images_json, created_at)| {
            let images: Vec<StoredImage> = images_json
                .as_deref()
                .and_then(|s| serde_json::from_str(s).ok())
                .unwrap_or_default();
            Message { id, role, text, images, created_at }
        })
        .collect())
}

async fn list_messages(
    Extension(installed): Extension<InstalledState>,
    Extension(user): Extension<CurrentUser>,
    Path(conv_id): Path<i64>,
) -> Response {
    if let Err(r) = ensure_owner(&installed.pool, installed.kind, conv_id, user.id).await {
        return r;
    }
    match load_messages(&installed.pool, installed.kind, conv_id).await {
        Ok(m) => Json(m).into_response(),
        Err(e) => err(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()),
    }
}

async fn insert_message(
    pool: &db::Pool,
    kind: db::DbKind,
    conv_id: i64,
    role: &str,
    text: Option<&str>,
    images: &[StoredImage],
) -> Result<i64, sqlx::Error> {
    let images_json = if images.is_empty() {
        None
    } else {
        Some(serde_json::to_string(images).unwrap_or_else(|_| "[]".into()))
    };
    let ins = db::q(
        kind,
        "INSERT INTO studio_messages (conversation_id, role, text, images_json) VALUES (?, ?, ?, ?)",
    );
    let id = match kind {
        db::DbKind::Sqlite | db::DbKind::Postgres => {
            let row: (i64,) = sqlx::query_as(&format!("{ins} RETURNING id"))
                .bind(conv_id)
                .bind(role)
                .bind(text)
                .bind(&images_json)
                .fetch_one(pool)
                .await?;
            row.0
        }
        db::DbKind::Mysql => {
            let mut tx = pool.begin().await?;
            sqlx::query(&ins)
                .bind(conv_id)
                .bind(role)
                .bind(text)
                .bind(&images_json)
                .execute(&mut *tx)
                .await?;
            let (id,): (i64,) =
                sqlx::query_as("SELECT LAST_INSERT_ID()").fetch_one(&mut *tx).await?;
            tx.commit().await?;
            id
        }
    };
    let now = db::now_expr(kind);
    let bump = db::q(
        kind,
        &format!("UPDATE studio_conversations SET updated_at = {now} WHERE id = ?"),
    );
    let _ = sqlx::query(&bump).bind(conv_id).execute(pool).await;
    Ok(id)
}

// ---------------------------------------------------------------------------
// turn: submit → spawn task → poll
// ---------------------------------------------------------------------------

#[derive(Deserialize)]
struct SubmitTurn {
    /// User's message text (can be empty if only attachment + implicit "edit")
    text: String,
    /// Optional attached image as data: URL (base64-encoded inline).
    /// Persisted with the user message and forwarded as input_image.
    #[serde(default)]
    image_data_url: Option<String>,
}

#[derive(Serialize)]
struct JobCreated {
    token: String,
    user_message_id: i64,
}

#[derive(Serialize)]
struct JobStatus {
    token: String,
    status: String,
    error: Option<String>,
    created_at: String,
    finished_at: Option<String>,
}

fn read_header<'a>(headers: &'a HeaderMap, name: &str) -> Option<&'a str> {
    headers.get(name).and_then(|v| v.to_str().ok())
}

async fn resolve_responses_upstream(
    state: &AppState,
    headers: &HeaderMap,
) -> Result<(String, String, bool), Response> {
    // Client may pass X-Upstream-Url (base host) and X-Upstream-Key; we append
    // /v1/responses. Or X-Use-Shared=1 → fall back to admin's chat-openai config.
    let want_shared = header_truthy(headers, "x-use-shared");
    if !want_shared {
        let hdr_url = read_header(headers, "x-upstream-url");
        let hdr_key = read_header(headers, "x-upstream-key");
        if let (Some(u), Some(k)) = (hdr_url, hdr_key) {
            if !u.is_empty() && !k.is_empty() {
                let base = u.trim_end_matches('/');
                return Ok((format!("{base}/v1/responses"), k.to_string(), false));
            }
        }
    }
    let installed = state.require_installed().await?;
    match credits::read_shared(
        &installed.pool,
        installed.kind,
        "openai",
        credits::SharedFlavor::Chat,
    )
    .await
    {
        Some(s) => {
            let base = s.url.trim_end_matches('/');
            Ok((format!("{base}/v1/responses"), s.key, true))
        }
        None => Err(err(
            StatusCode::BAD_REQUEST,
            "缺少 X-Upstream-Url/Key 头，且未配置共享 OpenAI 后端",
        )),
    }
}

/// Parse a data: URL into raw bytes + extension.
fn parse_data_url(s: &str) -> Option<(Vec<u8>, &'static str)> {
    let rest = s.strip_prefix("data:")?;
    let (meta, b64) = rest.split_once(";base64,")?;
    let ext = if meta.contains("jpeg") || meta.contains("jpg") {
        "jpg"
    } else if meta.contains("webp") {
        "webp"
    } else if meta.contains("gif") {
        "gif"
    } else {
        "png"
    };
    let bytes = STANDARD.decode(b64.trim()).ok()?;
    Some((bytes, ext))
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

async fn file_to_data_url(
    data_dir: &std::path::Path,
    web_path: &str,
) -> Option<String> {
    let name = web_path.rsplit('/').next()?;
    if name.contains("..") || name.contains('\\') {
        return None;
    }
    let p = data_dir.join("images").join(name);
    let bytes = tokio::fs::read(&p).await.ok()?;
    let mime = match p.extension().and_then(|e| e.to_str()) {
        Some("jpg" | "jpeg") => "image/jpeg",
        Some("webp") => "image/webp",
        Some("gif") => "image/gif",
        _ => "image/png",
    };
    Some(format!(
        "data:{mime};base64,{}",
        STANDARD.encode(&bytes)
    ))
}

fn extract_openai_image_b64(item: &Value) -> Option<String> {
    // Responses API returns output items. For image_generation_call items the
    // actual bytes live under "result" (base64) per OpenAI docs (as of 2026).
    // Also accept nested shapes seen in community relays.
    if let Some(s) = item.get("result").and_then(|v| v.as_str()) {
        return Some(s.to_string());
    }
    if let Some(s) = item.pointer("/image/b64_json").and_then(|v| v.as_str()) {
        return Some(s.to_string());
    }
    if let Some(s) = item.pointer("/output/b64_json").and_then(|v| v.as_str()) {
        return Some(s.to_string());
    }
    None
}

fn extract_openai_text(item: &Value) -> Option<String> {
    // Look for message.content[].text in assistant output items.
    let content = item.get("content")?.as_array()?;
    let mut out = String::new();
    for part in content {
        if let Some(t) = part.get("text").and_then(|v| v.as_str()) {
            out.push_str(t);
        }
    }
    if out.is_empty() { None } else { Some(out) }
}

async fn build_history_input(
    state: &AppState,
    messages: &[Message],
) -> Vec<Value> {
    let mut input = Vec::new();
    for m in messages {
        let mut parts: Vec<Value> = Vec::new();
        if let Some(t) = m.text.as_deref() {
            if !t.is_empty() {
                parts.push(json!({
                    "type": if m.role == "assistant" { "output_text" } else { "input_text" },
                    "text": t,
                }));
            }
        }
        for img in &m.images {
            if let Some(durl) = file_to_data_url(&state.data_dir, &img.path).await {
                // Assistant images re-submitted as input_image — widely supported
                // by Responses API for context continuity.
                parts.push(json!({
                    "type": "input_image",
                    "image_url": durl,
                }));
            }
        }
        if parts.is_empty() {
            continue;
        }
        input.push(json!({
            "role": m.role,
            "content": parts,
        }));
    }
    input
}

async fn insert_job(
    pool: &db::Pool,
    kind: db::DbKind,
    user_id: i64,
    conv_id: i64,
) -> Result<String, sqlx::Error> {
    let token = random_hex(16);
    let sql = db::q(
        kind,
        "INSERT INTO studio_jobs (token, user_id, conversation_id, status) VALUES (?, ?, ?, 'pending')",
    );
    sqlx::query(&sql)
        .bind(&token)
        .bind(user_id)
        .bind(conv_id)
        .execute(pool)
        .await?;
    Ok(token)
}

async fn finalize_job(
    pool: &db::Pool,
    kind: db::DbKind,
    token: &str,
    status: &str,
    error: Option<&str>,
) {
    let now = db::now_expr(kind);
    let sql = db::q(
        kind,
        &format!(
            "UPDATE studio_jobs SET status = ?, error = ?, finished_at = {now} WHERE token = ?"
        ),
    );
    let _ = sqlx::query(&sql)
        .bind(status)
        .bind(error)
        .bind(token)
        .execute(pool)
        .await;
}

async fn submit_turn(
    State(state): State<AppState>,
    Extension(installed): Extension<InstalledState>,
    Extension(user): Extension<CurrentUser>,
    Path(conv_id): Path<i64>,
    headers: HeaderMap,
    Json(body): Json<SubmitTurn>,
) -> Response {
    if let Err(r) = ensure_owner(&installed.pool, installed.kind, conv_id, user.id).await {
        return r;
    }
    let text = body.text.trim().to_string();
    if text.is_empty() && body.image_data_url.is_none() {
        return err(StatusCode::BAD_REQUEST, "消息不能为空");
    }

    let (url, key, used_shared) = match resolve_responses_upstream(&state, &headers).await {
        Ok(v) => v,
        Err(r) => return r,
    };

    // Persist user message (with optional attached image to disk).
    let mut user_images: Vec<StoredImage> = Vec::new();
    if let Some(durl) = body.image_data_url.as_deref() {
        if let Some((bytes, ext)) = parse_data_url(durl) {
            match write_image_to_disk(&state.data_dir, &bytes, ext).await {
                Ok(path) => user_images.push(StoredImage { path, revised_prompt: None }),
                Err(e) => return err(StatusCode::INTERNAL_SERVER_ERROR, format!("save attachment: {e}")),
            }
        } else {
            return err(StatusCode::BAD_REQUEST, "附加图片格式不支持");
        }
    }
    let user_msg_id = match insert_message(
        &installed.pool,
        installed.kind,
        conv_id,
        "user",
        if text.is_empty() { None } else { Some(&text) },
        &user_images,
    )
    .await
    {
        Ok(id) => id,
        Err(e) => return err(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()),
    };

    // Deduct credits for shared mode.
    if used_shared {
        let cost =
            credits::get_setting_i64(&installed.pool, installed.kind, "cost_image", 5).await;
        if cost > 0 {
            if let Err(bal) = credits::try_deduct(
                &installed.pool,
                installed.kind,
                user.id,
                cost,
                "studio_responses",
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

    // Pick model.
    let conv_model_sql = db::q(
        installed.kind,
        "SELECT model FROM studio_conversations WHERE id = ?",
    );
    let (conv_model,): (Option<String>,) = sqlx::query_as(&conv_model_sql)
        .bind(conv_id)
        .fetch_one(&installed.pool)
        .await
        .unwrap_or((None,));
    let shared_model = credits::get_setting(
        &installed.pool,
        installed.kind,
        "shared_chat_openai_model",
    )
    .await
    .unwrap_or_default();
    let model = conv_model
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| {
            if used_shared && !shared_model.is_empty() {
                shared_model
            } else {
                "gpt-image-1".into()
            }
        });

    let token = match insert_job(&installed.pool, installed.kind, user.id, conv_id).await {
        Ok(t) => t,
        Err(e) => return err(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()),
    };

    let state_c = state.clone();
    let token_c = token.clone();
    tokio::spawn(async move {
        let Ok(installed) = state_c.require_installed().await else {
            return;
        };
        let pool = installed.pool.clone();
        let kind = installed.kind;

        // Reload full history (including the user message we just inserted) so
        // the model sees its own prior outputs as context.
        let history = match load_messages(&pool, kind, conv_id).await {
            Ok(m) => m,
            Err(e) => {
                finalize_job(&pool, kind, &token_c, "failed", Some(&e.to_string())).await;
                if used_shared {
                    let cost = credits::get_setting_i64(&pool, kind, "cost_image", 5).await;
                    let _ = credits::grant(&pool, kind, user.id, cost, "refund_studio_error").await;
                }
                return;
            }
        };
        let input = build_history_input(&state_c, &history).await;

        let payload = json!({
            "model": model,
            "input": input,
            "tools": [{ "type": "image_generation" }],
        });

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
                finalize_job(&pool, kind, &token_c, "failed", Some("HTTP client 构建失败")).await;
                if used_shared {
                    let cost = credits::get_setting_i64(&pool, kind, "cost_image", 5).await;
                    let _ = credits::grant(&pool, kind, user.id, cost, "refund_studio_error").await;
                }
                return;
            }
        };

        let resp = match client
            .post(&url)
            .bearer_auth(&key)
            .header(header::CONTENT_TYPE, "application/json")
            .json(&payload)
            .send()
            .await
        {
            Ok(r) => r,
            Err(e) => {
                finalize_job(&pool, kind, &token_c, "failed", Some(&format!("upstream: {e}"))).await;
                if used_shared {
                    let cost = credits::get_setting_i64(&pool, kind, "cost_image", 5).await;
                    let _ = credits::grant(&pool, kind, user.id, cost, "refund_studio_error").await;
                }
                return;
            }
        };

        let status = resp.status();
        let raw = resp.bytes().await.unwrap_or_default();
        if !status.is_success() {
            let msg = format!("upstream {status}: {}", String::from_utf8_lossy(&raw));
            finalize_job(&pool, kind, &token_c, "failed", Some(&msg)).await;
            if used_shared {
                let cost = credits::get_setting_i64(&pool, kind, "cost_image", 5).await;
                let _ = credits::grant(&pool, kind, user.id, cost, "refund_studio_error").await;
            }
            return;
        }

        let parsed: Value = match serde_json::from_slice(&raw) {
            Ok(v) => v,
            Err(e) => {
                finalize_job(&pool, kind, &token_c, "failed", Some(&format!("parse: {e}")))
                    .await;
                if used_shared {
                    let cost = credits::get_setting_i64(&pool, kind, "cost_image", 5).await;
                    let _ = credits::grant(&pool, kind, user.id, cost, "refund_studio_error").await;
                }
                return;
            }
        };

        // Collect assistant text + images from parsed.output[]
        let mut text_out = String::new();
        let mut image_paths: Vec<StoredImage> = Vec::new();
        if let Some(items) = parsed.get("output").and_then(|v| v.as_array()) {
            for it in items {
                let t = it.get("type").and_then(|v| v.as_str()).unwrap_or_default();
                match t {
                    "image_generation_call" => {
                        if let Some(b64) = extract_openai_image_b64(it) {
                            if let Ok(bytes) = STANDARD.decode(&b64) {
                                if let Ok(path) =
                                    write_image_to_disk(&state_c.data_dir, &bytes, "png").await
                                {
                                    image_paths.push(StoredImage {
                                        path,
                                        revised_prompt: it
                                            .get("revised_prompt")
                                            .and_then(|v| v.as_str())
                                            .map(String::from),
                                    });
                                }
                            }
                        }
                    }
                    "message" => {
                        if let Some(t) = extract_openai_text(it) {
                            if !text_out.is_empty() {
                                text_out.push('\n');
                            }
                            text_out.push_str(&t);
                        }
                    }
                    _ => {}
                }
            }
        }
        // Fallback: some relays return `output_text` at top level.
        if text_out.is_empty() {
            if let Some(t) = parsed.get("output_text").and_then(|v| v.as_str()) {
                text_out.push_str(t);
            }
        }

        if text_out.is_empty() && image_paths.is_empty() {
            finalize_job(&pool, kind, &token_c, "failed", Some("上游未返回图片或文本")).await;
            if used_shared {
                let cost = credits::get_setting_i64(&pool, kind, "cost_image", 5).await;
                let _ = credits::grant(&pool, kind, user.id, cost, "refund_studio_error").await;
            }
            return;
        }

        if let Err(e) = insert_message(
            &pool,
            kind,
            conv_id,
            "assistant",
            if text_out.is_empty() { None } else { Some(&text_out) },
            &image_paths,
        )
        .await
        {
            finalize_job(&pool, kind, &token_c, "failed", Some(&e.to_string())).await;
            return;
        }

        finalize_job(&pool, kind, &token_c, "done", None).await;
    });

    Json(JobCreated { token, user_message_id: user_msg_id }).into_response()
}

async fn get_job(
    Extension(installed): Extension<InstalledState>,
    Extension(user): Extension<CurrentUser>,
    Path(token): Path<String>,
) -> Response {
    let sql = db::q(
        installed.kind,
        "SELECT token, status, error, created_at, finished_at FROM studio_jobs
         WHERE token = ? AND user_id = ?",
    );
    let row: Option<(String, String, Option<String>, String, Option<String>)> =
        sqlx::query_as(&sql)
            .bind(&token)
            .bind(user.id)
            .fetch_optional(&installed.pool)
            .await
            .ok()
            .flatten();
    let Some((token, status, error, created_at, finished_at)) = row else {
        return err(StatusCode::NOT_FOUND, "任务不存在");
    };
    Json(JobStatus { token, status, error, created_at, finished_at }).into_response()
}

// On startup, mark stuck jobs as failed.
pub async fn cleanup_stale_jobs(pool: &db::Pool, kind: db::DbKind) {
    let now = db::now_expr(kind);
    let sql = db::q(
        kind,
        &format!(
            "UPDATE studio_jobs SET status = 'failed', error = 'server restarted', finished_at = {now}
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
        .route(
            "/studio/conversations",
            get(list_conversations).post(create_conversation),
        )
        .route(
            "/studio/conversations/{id}",
            axum::routing::patch(update_conversation).delete(delete_conversation),
        )
        .route(
            "/studio/conversations/{id}/messages",
            get(list_messages),
        )
        .route("/studio/conversations/{id}/turn", post(submit_turn))
        .route("/studio/jobs/{token}", get(get_job))
}

