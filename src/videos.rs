//! Video generation pricing rules — admin CRUD + user-facing model listing.
//!
//! Table `video_pricing` (see migrations/{sqlite,postgres,mysql}/0030_*.sql):
//! per-model base/per-second credit cost plus JSON-encoded allowed durations
//! and size multipliers. Job creation/advance lands in a later task; this
//! module only owns the pricing data layer, admin CRUD, and the public
//! `GET /videos/models` listing consumed by the frontend to compute price
//! locally before submitting a job.

use axum::{
    Extension, Json, Router,
    extract::{Path, State},
    http::StatusCode,
    middleware,
    response::{IntoResponse, Response},
    routing::{delete, get, post},
};
use rand::RngCore;
use serde::{Deserialize, Serialize};

use crate::{
    AppState, CurrentUser, InstalledState, admin, channels, credits,
    credits::LedgerMeta,
    db::{self, DbKind, Pool},
};

// ---------------------------------------------------------------------------
// types + data layer
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SizeRule {
    pub size: String,
    /// Percent multiplier, 100 = 1.0x.
    pub multiplier: i64,
}

#[derive(Debug, Clone, Serialize)]
pub struct VideoPricing {
    pub id: i64,
    pub model: String,
    pub display_name: Option<String>,
    pub enabled: bool,
    pub base_credits: i64,
    pub per_second: i64,
    pub allowed_seconds: Vec<i64>,
    pub size_rules: Vec<SizeRule>,
}

fn parse_pricing_row(
    (id, model, display_name, enabled, base_credits, per_second, allowed_seconds, size_rules):
        (i64, String, Option<String>, i64, i64, i64, String, String),
) -> VideoPricing {
    VideoPricing {
        id, model, display_name,
        enabled: enabled != 0,
        base_credits, per_second,
        allowed_seconds: serde_json::from_str(&allowed_seconds).unwrap_or_default(),
        size_rules: serde_json::from_str(&size_rules).unwrap_or_default(),
    }
}

pub async fn list_pricing(pool: &Pool, kind: DbKind) -> Result<Vec<VideoPricing>, sqlx::Error> {
    let enabled = db::bool_as_int(kind, "enabled");
    let sql = db::q(kind, &format!(
        "SELECT id, model, display_name, {enabled}, base_credits, per_second, \
         allowed_seconds, size_rules FROM video_pricing ORDER BY model ASC"
    ));
    let rows: Vec<(i64, String, Option<String>, i64, i64, i64, String, String)> =
        sqlx::query_as(&sql).fetch_all(pool).await?;
    Ok(rows.into_iter().map(parse_pricing_row).collect())
}

pub async fn get_pricing(pool: &Pool, kind: DbKind, model: &str)
    -> Result<Option<VideoPricing>, sqlx::Error>
{
    let enabled = db::bool_as_int(kind, "enabled");
    let sql = db::q(kind, &format!(
        "SELECT id, model, display_name, {enabled}, base_credits, per_second, \
         allowed_seconds, size_rules FROM video_pricing WHERE model = ?"
    ));
    let row: Option<(i64, String, Option<String>, i64, i64, i64, String, String)> =
        sqlx::query_as(&sql).bind(model).fetch_optional(pool).await?;
    Ok(row.map(parse_pricing_row))
}

/// None when seconds/size are not in the model's configured rules.
pub fn compute_cost(p: &VideoPricing, seconds: i64, size: &str) -> Option<i64> {
    if !p.allowed_seconds.contains(&seconds) { return None; }
    let mult = p.size_rules.iter().find(|r| r.size == size)?.multiplier;
    let raw = (p.base_credits + p.per_second * seconds) * mult;
    Some((raw + 50) / 100) // round half up on the percent multiplier
}

// ---------------------------------------------------------------------------
// admin CRUD
// ---------------------------------------------------------------------------

fn err(status: StatusCode, msg: impl Into<String>) -> Response {
    (status, Json(serde_json::json!({ "error": msg.into() }))).into_response()
}

#[derive(Debug, Deserialize)]
pub struct VideoPricingInput {
    pub model: String,
    pub display_name: Option<String>,
    pub enabled: Option<bool>,
    pub base_credits: i64,
    pub per_second: i64,
    pub allowed_seconds: Vec<i64>,
    pub size_rules: Vec<SizeRule>,
}

fn validate_input(input: &VideoPricingInput) -> Result<(), String> {
    if input.model.trim().is_empty() {
        return Err("model 不能为空".into());
    }
    if input.base_credits < 0 {
        return Err("base_credits 必须 >= 0".into());
    }
    if input.per_second < 0 {
        return Err("per_second 必须 >= 0".into());
    }
    if input.allowed_seconds.is_empty() {
        return Err("allowed_seconds 不能为空".into());
    }
    if input.allowed_seconds.iter().any(|s| *s <= 0) {
        return Err("allowed_seconds 中的时长必须大于 0".into());
    }
    if input.size_rules.is_empty() {
        return Err("size_rules 不能为空".into());
    }
    for r in &input.size_rules {
        let (w, h) = r.size.split_once('x').ok_or_else(|| format!("size 格式不合法: {}", r.size))?;
        if w.parse::<u32>().is_err() || h.parse::<u32>().is_err() {
            return Err(format!("size 格式不合法: {}", r.size));
        }
        if r.multiplier <= 0 {
            return Err(format!("size {} 的 multiplier 必须大于 0", r.size));
        }
    }
    Ok(())
}

/// Upsert following the "UPDATE first, INSERT if 0 rows affected" pattern —
/// one SQL statement per dialect, no ON CONFLICT.
pub async fn upsert_pricing(pool: &Pool, kind: DbKind, input: &VideoPricingInput) -> Result<(), sqlx::Error> {
    let enabled_bool = input.enabled.unwrap_or(true);
    let enabled_v: i64 = if enabled_bool { 1 } else { 0 };
    let allowed_seconds = serde_json::to_string(&input.allowed_seconds).unwrap_or_else(|_| "[]".into());
    let size_rules = serde_json::to_string(&input.size_rules).unwrap_or_else(|_| "[]".into());
    let now = db::now_expr(kind);

    let update_sql = db::q(kind, &format!(
        "UPDATE video_pricing SET display_name = ?, enabled = ?, base_credits = ?, \
         per_second = ?, allowed_seconds = ?, size_rules = ?, updated_at = {now} WHERE model = ?"
    ));
    let q = sqlx::query(&update_sql).bind(input.display_name.as_deref());
    // Postgres has a native BOOLEAN column; binding i64 there fails at runtime.
    let q = if matches!(kind, DbKind::Postgres) { q.bind(enabled_bool) } else { q.bind(enabled_v) };
    let result = q
        .bind(input.base_credits)
        .bind(input.per_second)
        .bind(&allowed_seconds)
        .bind(&size_rules)
        .bind(&input.model)
        .execute(pool)
        .await?;

    if result.rows_affected() == 0 {
        let insert_sql = db::q(kind, &format!(
            "INSERT INTO video_pricing \
             (model, display_name, enabled, base_credits, per_second, allowed_seconds, size_rules, created_at, updated_at) \
             VALUES (?, ?, ?, ?, ?, ?, ?, {now}, {now})"
        ));
        let q = sqlx::query(&insert_sql)
            .bind(&input.model)
            .bind(input.display_name.as_deref());
        let q = if matches!(kind, DbKind::Postgres) { q.bind(enabled_bool) } else { q.bind(enabled_v) };
        q.bind(input.base_credits)
            .bind(input.per_second)
            .bind(&allowed_seconds)
            .bind(&size_rules)
            .execute(pool)
            .await?;
    }
    Ok(())
}

pub async fn delete_pricing(pool: &Pool, kind: DbKind, model: &str) -> Result<(), sqlx::Error> {
    let sql = db::q(kind, "DELETE FROM video_pricing WHERE model = ?");
    sqlx::query(&sql).bind(model).execute(pool).await.map(|_| ())
}

async fn admin_list_video_pricing(Extension(s): Extension<InstalledState>) -> Response {
    match list_pricing(&s.pool, s.kind).await {
        Ok(v) => Json(v).into_response(),
        Err(e) => err(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()),
    }
}

async fn admin_upsert_video_pricing(
    Extension(s): Extension<InstalledState>,
    Json(input): Json<VideoPricingInput>,
) -> Response {
    if let Err(e) = validate_input(&input) {
        return err(StatusCode::BAD_REQUEST, e);
    }
    match upsert_pricing(&s.pool, s.kind, &input).await {
        Ok(_) => StatusCode::NO_CONTENT.into_response(),
        Err(e) => err(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()),
    }
}

async fn admin_delete_video_pricing(
    Extension(s): Extension<InstalledState>,
    Path(model): Path<String>,
) -> Response {
    match delete_pricing(&s.pool, s.kind, &model).await {
        Ok(_) => StatusCode::NO_CONTENT.into_response(),
        Err(e) => err(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()),
    }
}

pub fn admin_routes() -> Router<AppState> {
    Router::new()
        .route("/admin/video-pricing", get(admin_list_video_pricing).post(admin_upsert_video_pricing))
        .route("/admin/video-pricing/{model}", delete(admin_delete_video_pricing))
        .route_layer(middleware::from_fn(admin::require_admin))
}

// ---------------------------------------------------------------------------
// user-facing routes
// ---------------------------------------------------------------------------

#[derive(Serialize)]
struct UserVideoModel {
    model: String,
    display_name: Option<String>,
    base_credits: i64,
    per_second: i64,
    allowed_seconds: Vec<i64>,
    size_rules: Vec<SizeRule>,
}

/// Enabled video-pricing rows, gated on at least one enabled `openai`/`video`
/// channel existing. The video channel protocol is fixed to openai, so this
/// is a single check rather than a per-model lookup.
async fn user_list_models(Extension(s): Extension<InstalledState>) -> Response {
    let pricing = match list_pricing(&s.pool, s.kind).await {
        Ok(v) => v,
        Err(e) => return err(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()),
    };
    match channels::any_enabled_channel(&s.pool, s.kind, "openai", "video").await {
        Ok(Some(_)) => {}
        Ok(None) => return Json(Vec::<UserVideoModel>::new()).into_response(),
        Err(e) => return err(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()),
    }
    let out: Vec<UserVideoModel> = pricing
        .into_iter()
        .filter(|p| p.enabled)
        .map(|p| UserVideoModel {
            model: p.model,
            display_name: p.display_name,
            base_credits: p.base_credits,
            per_second: p.per_second,
            allowed_seconds: p.allowed_seconds,
            size_rules: p.size_rules,
        })
        .collect();
    Json(out).into_response()
}

fn random_hex(n: usize) -> String {
    let mut bytes = vec![0u8; n];
    rand::rngs::OsRng.fill_bytes(&mut bytes);
    hex::encode(bytes)
}

// ---------------------------------------------------------------------------
// job creation
// ---------------------------------------------------------------------------

#[derive(Debug, Deserialize)]
struct CreateJobReq {
    model: String,
    prompt: String,
    seconds: i64,
    size: String,
    /// e.g. "/api/images/abcd1234.png" — 先经 POST /api/images/save 上传。
    input_image_path: Option<String>,
}

#[derive(Serialize)]
struct CreateJobResp {
    token: String,
    cost: i64,
}

/// Refund a job's cost_credits exactly once. The UPDATE-guard makes retries
/// (sweeper + poll racing) safe: only the caller that flips refunded gets to
/// grant.
pub(crate) async fn refund_job(
    pool: &Pool,
    kind: DbKind,
    job_id: i64,
    user_id: i64,
    model: &str,
    cost: i64,
    suffix: &str,
) {
    if cost <= 0 {
        return;
    }
    let bt = db::bool_true(kind);
    let sql = db::q(
        kind,
        &format!("UPDATE video_jobs SET refunded = {bt} WHERE id = ? AND refunded <> {bt}"),
    );
    let n = sqlx::query(&sql)
        .bind(job_id)
        .execute(pool)
        .await
        .map(|r| r.rows_affected())
        .unwrap_or(0);
    if n == 0 {
        return; // already refunded (or DB error — err on not double-granting)
    }
    let reason = format!("refund_video_{model}_{suffix}");
    let _ = credits::grant(pool, kind, user_id, cost, &reason, &LedgerMeta::refund_video(model)).await;
}

/// Insert a new video_jobs row, returning its id. Three-dialect id-return
/// pattern mirrors `channels::create_channel`.
async fn insert_job(
    pool: &Pool,
    kind: DbKind,
    token: &str,
    user_id: i64,
    model: &str,
    prompt: &str,
    seconds: i64,
    size: &str,
    input_image_path: Option<&str>,
    channel_id: i64,
    cost: i64,
) -> Result<i64, sqlx::Error> {
    let returning = db::returning_id(kind);
    let sql = db::q(
        kind,
        &format!(
            "INSERT INTO video_jobs \
             (token, user_id, model, prompt, seconds, size, input_image_path, channel_id, cost_credits, status) \
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending'){returning}"
        ),
    );
    match kind {
        DbKind::Postgres | DbKind::Sqlite => {
            let row: (i64,) = sqlx::query_as(&sql)
                .bind(token)
                .bind(user_id)
                .bind(model)
                .bind(prompt)
                .bind(seconds)
                .bind(size)
                .bind(input_image_path)
                .bind(channel_id)
                .bind(cost)
                .fetch_one(pool)
                .await?;
            Ok(row.0)
        }
        DbKind::Mysql => {
            let r = sqlx::query(&sql)
                .bind(token)
                .bind(user_id)
                .bind(model)
                .bind(prompt)
                .bind(seconds)
                .bind(size)
                .bind(input_image_path)
                .bind(channel_id)
                .bind(cost)
                .execute(pool)
                .await?;
            Ok(r.last_insert_id().unwrap_or(0))
        }
    }
}

async fn mark_job_failed(pool: &Pool, kind: DbKind, job_id: i64, error: &str) {
    let now = db::now_expr(kind);
    let trimmed: String = error.chars().take(500).collect();
    let sql = db::q(
        kind,
        &format!(
            "UPDATE video_jobs SET status = 'failed', error = ?, finished_at = {now} WHERE id = ?"
        ),
    );
    let _ = sqlx::query(&sql).bind(&trimmed).bind(job_id).execute(pool).await;
}

async fn create_job(
    State(state): State<AppState>,
    Extension(s): Extension<InstalledState>,
    Extension(user): Extension<CurrentUser>,
    Json(req): Json<CreateJobReq>,
) -> Response {
    let pool = &s.pool;
    let kind = s.kind;

    let prompt = req.prompt.trim().to_string();
    if prompt.is_empty() {
        return err(StatusCode::BAD_REQUEST, "prompt 不能为空");
    }

    let pricing = match get_pricing(pool, kind, &req.model).await {
        Ok(Some(p)) if p.enabled => p,
        Ok(_) => return err(StatusCode::BAD_REQUEST, "模型不存在或未启用"),
        Err(e) => return err(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()),
    };

    let cost = match compute_cost(&pricing, req.seconds, &req.size) {
        Some(c) => c,
        None => return err(StatusCode::BAD_REQUEST, "该模型不支持所选时长或分辨率"),
    };

    // Load the optional reference image up-front so a bad path fails before
    // any credits move.
    let mut image_bytes: Option<Vec<u8>> = None;
    let mut image_name: String = String::new();
    let mut image_mime: String = "application/octet-stream".to_string();
    if let Some(path) = req.input_image_path.as_deref() {
        if !path.starts_with("/api/images/") {
            return err(StatusCode::BAD_REQUEST, "参考图不存在");
        }
        let name = path.rsplit('/').next().unwrap_or("");
        if name.is_empty() || name.contains("..") || name.contains('/') {
            return err(StatusCode::BAD_REQUEST, "参考图不存在");
        }
        let file_path = state.data_dir.join("images").join(name);
        match tokio::fs::read(&file_path).await {
            Ok(bytes) => {
                image_mime = mime_guess::from_path(&file_path)
                    .first_or_octet_stream()
                    .essence_str()
                    .to_string();
                image_name = name.to_string();
                image_bytes = Some(bytes);
            }
            Err(_) => return err(StatusCode::BAD_REQUEST, "参考图不存在"),
        }
    }

    let model = req.model.clone();

    // Deduct first, then attempt upstream — refunds happen on any failure past this point.
    let _new_balance = match credits::try_deduct(
        pool,
        kind,
        user.id,
        cost,
        &format!("video_{model}"),
        &LedgerMeta::video(&model),
    )
    .await
    {
        Ok(b) => b,
        Err(balance) => {
            return err(
                StatusCode::PAYMENT_REQUIRED,
                format!("积分不足：需要 {cost}，当前余额 {balance}"),
            );
        }
    };

    let choice = match channels::select_one(pool, kind, &model, "video").await {
        Ok(Some(c)) => c,
        Ok(None) => {
            let _ = credits::grant(
                pool,
                kind,
                user.id,
                cost,
                &format!("refund_video_{model}_no_channel"),
                &LedgerMeta::refund_video(&model),
            )
            .await;
            return err(StatusCode::BAD_REQUEST, "暂无可用视频渠道，请联系管理员");
        }
        Err(e) => {
            let _ = credits::grant(
                pool,
                kind,
                user.id,
                cost,
                &format!("refund_video_{model}_no_channel"),
                &LedgerMeta::refund_video(&model),
            )
            .await;
            return err(StatusCode::INTERNAL_SERVER_ERROR, e.to_string());
        }
    };

    let token = random_hex(16);
    let job_id = match insert_job(
        pool,
        kind,
        &token,
        user.id,
        &model,
        &prompt,
        req.seconds,
        &req.size,
        req.input_image_path.as_deref(),
        choice.channel.id,
        cost,
    )
    .await
    {
        Ok(id) => id,
        Err(e) => {
            let _ = credits::grant(
                pool,
                kind,
                user.id,
                cost,
                &format!("refund_video_{model}_no_channel"),
                &LedgerMeta::refund_video(&model),
            )
            .await;
            return err(StatusCode::INTERNAL_SERVER_ERROR, e.to_string());
        }
    };

    let base = choice.channel.base_url.trim_end_matches('/');
    let mut form = reqwest::multipart::Form::new()
        .text("model", choice.upstream_model.clone())
        .text("prompt", prompt.clone())
        .text("seconds", req.seconds.to_string())
        .text("size", req.size.clone());
    if let Some(bytes) = image_bytes {
        match reqwest::multipart::Part::bytes(bytes)
            .file_name(image_name.clone())
            .mime_str(&image_mime)
        {
            Ok(part) => form = form.part("input_reference", part),
            Err(e) => {
                let msg = format!("multipart: {e}");
                mark_job_failed(pool, kind, job_id, &msg).await;
                refund_job(pool, kind, job_id, user.id, &model, cost, "create_error").await;
                return err(StatusCode::BAD_GATEWAY, msg);
            }
        }
    }

    let res = state
        .http
        .post(format!("{base}/v1/videos"))
        .bearer_auth(&choice.channel.api_key)
        .multipart(form)
        .send()
        .await;

    let resp = match res {
        Ok(r) => r,
        Err(e) => {
            let msg = format!("上游请求失败: {e}");
            mark_job_failed(pool, kind, job_id, &msg).await;
            refund_job(pool, kind, job_id, user.id, &model, cost, "create_error").await;
            return err(StatusCode::BAD_GATEWAY, msg);
        }
    };

    if !resp.status().is_success() {
        let status = resp.status();
        let body = resp.text().await.unwrap_or_default();
        let truncated: String = body.chars().take(500).collect();
        let msg = format!("上游返回 {status}: {truncated}");
        mark_job_failed(pool, kind, job_id, &msg).await;
        refund_job(pool, kind, job_id, user.id, &model, cost, "create_error").await;
        return err(StatusCode::BAD_GATEWAY, msg);
    }

    let body: serde_json::Value = match resp.json().await {
        Ok(v) => v,
        Err(e) => {
            let msg = format!("上游响应解析失败: {e}");
            mark_job_failed(pool, kind, job_id, &msg).await;
            refund_job(pool, kind, job_id, user.id, &model, cost, "create_error").await;
            return err(StatusCode::BAD_GATEWAY, msg);
        }
    };

    let upstream_id = match body.get("id").and_then(|v| v.as_str()) {
        Some(id) => id.to_string(),
        None => {
            let msg = format!("上游响应缺少 id: {body}");
            mark_job_failed(pool, kind, job_id, &msg).await;
            refund_job(pool, kind, job_id, user.id, &model, cost, "create_error").await;
            return err(StatusCode::BAD_GATEWAY, msg);
        }
    };

    let now = db::now_expr(kind);
    let update_sql = db::q(
        kind,
        &format!(
            "UPDATE video_jobs SET upstream_video_id = ?, status = 'running', \
             started_at = {now}, last_polled_at = {now} WHERE id = ?"
        ),
    );
    let _ = sqlx::query(&update_sql)
        .bind(&upstream_id)
        .bind(job_id)
        .execute(pool)
        .await;

    (StatusCode::CREATED, Json(CreateJobResp { token, cost })).into_response()
}

pub fn routes() -> Router<AppState> {
    Router::new()
        .route("/videos/models", get(user_list_models))
        .route("/videos/jobs", post(create_job))
}
