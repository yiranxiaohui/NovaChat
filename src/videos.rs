//! Video generation jobs — creation, polling, downloads, user model listing.
//!
//! Pricing lives in `model_pricing` (kind='video') owned by [`crate::channels`]:
//! per-model base/per-second credit cost plus JSON-encoded allowed durations
//! and size multipliers. Grok video models expose their upstream-supported
//! continuous 1–15 second range even when an older row stores discrete presets.
//! This module owns job lifecycle and the public
//! `GET /videos/models` listing consumed by the frontend to compute price
//! locally before submitting a job.

use axum::{
    Extension, Json, Router,
    body::to_bytes,
    body::Body,
    extract::{Path, Query, State},
    http::{HeaderMap, StatusCode, header},
    response::{IntoResponse, Response},
    routing::{get, post},
};
use rand::RngCore;
use serde::{Deserialize, Serialize};

use crate::{
    AppState, CurrentUser, InstalledState, channels,
    channels::{ModelPrice, SizeRule},
    credits,
    credits::LedgerMeta,
    db::{self, DbKind, Pool},
    storage::{MediaKind, MediaStorage},
};

const GROK_VIDEO_MAX_SECONDS: i64 = 15;

fn is_grok_video_model(model: &str) -> bool {
    let normalized = model.trim().to_ascii_lowercase();
    normalized == "grok-imagine-video" || normalized.starts_with("grok-imagine-video-")
}

fn effective_allowed_seconds(p: &ModelPrice) -> Vec<i64> {
    if is_grok_video_model(&p.model) {
        return (1..=GROK_VIDEO_MAX_SECONDS).collect();
    }
    let mut seconds = p.allowed_seconds.clone().unwrap_or_default();
    seconds.sort_unstable();
    seconds.dedup();
    seconds
}

fn supports_seconds(p: &ModelPrice, seconds: i64) -> bool {
    if is_grok_video_model(&p.model) {
        return (1..=GROK_VIDEO_MAX_SECONDS).contains(&seconds);
    }
    p.allowed_seconds
        .as_deref()
        .is_some_and(|allowed| allowed.contains(&seconds))
}

/// None when seconds/size are not in the model's effective rules.
pub fn compute_cost(p: &ModelPrice, seconds: i64, size: &str) -> Option<i64> {
    if !supports_seconds(p, seconds) {
        return None;
    }
    let mult = p.size_rules.as_deref()?.iter().find(|r| r.size == size)?.multiplier;
    let raw = (p.base_credits + p.per_second * seconds) * mult;
    Some((raw + 50) / 100) // round half up on the percent multiplier
}

#[cfg(test)]
mod pricing_tests {
    use super::*;

    fn video_price(model: &str, allowed_seconds: Vec<i64>) -> ModelPrice {
        ModelPrice {
            id: 1,
            model: model.to_string(),
            kind: "video".to_string(),
            cost_credits: 0,
            display_name: None,
            enabled: true,
            protocol: "openai".to_string(),
            context_limit: None,
            base_credits: 5,
            per_second: 5,
            allowed_seconds: Some(allowed_seconds),
            size_rules: Some(vec![SizeRule {
                size: "1280x720".to_string(),
                multiplier: 100,
            }]),
        }
    }

    #[test]
    fn grok_accepts_every_whole_second_from_one_through_fifteen() {
        let price = video_price("grok-imagine-video", vec![4, 8, 12]);

        for seconds in 1..=15 {
            assert_eq!(
                compute_cost(&price, seconds, "1280x720"),
                Some(5 + 5 * seconds)
            );
        }
        assert_eq!(compute_cost(&price, 0, "1280x720"), None);
        assert_eq!(compute_cost(&price, 16, "1280x720"), None);
    }

    #[test]
    fn other_models_keep_their_configured_discrete_durations() {
        let price = video_price("veo3.1-fast", vec![4, 8]);

        assert_eq!(compute_cost(&price, 4, "1280x720"), Some(25));
        assert_eq!(compute_cost(&price, 6, "1280x720"), None);
    }
}

fn err(status: StatusCode, msg: impl Into<String>) -> Response {
    (status, Json(serde_json::json!({ "error": msg.into() }))).into_response()
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
    let pricing = match channels::list_pricing(&s.pool, s.kind).await {
        Ok(v) => v,
        Err(e) => return err(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()),
    };
    match channels::any_enabled_channel(&s.pool, s.kind, "openai").await {
        Ok(Some(_)) => {}
        Ok(None) => return Json(Vec::<UserVideoModel>::new()).into_response(),
        Err(e) => return err(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()),
    }
    let out: Vec<UserVideoModel> = pricing
        .into_iter()
        .filter(|p| p.enabled && p.kind == "video")
        .map(|p| {
            let allowed_seconds = effective_allowed_seconds(&p);
            UserVideoModel {
                model: p.model,
                display_name: p.display_name,
                base_credits: p.base_credits,
                per_second: p.per_second,
                allowed_seconds,
                size_rules: p.size_rules.unwrap_or_default(),
            }
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

pub(crate) struct WorkflowVideoRequest {
    pub model: String,
    pub prompt: String,
    pub seconds: i64,
    pub size: String,
    pub input_image_path: Option<String>,
}

pub(crate) struct WorkflowVideoState {
    pub status: String,
    pub output_path: Option<String>,
    pub error: Option<String>,
}

pub(crate) async fn start_workflow_video(
    state: AppState,
    installed: InstalledState,
    user_id: i64,
    request: WorkflowVideoRequest,
) -> Result<String, String> {
    let response = create_job(
        State(state),
        Extension(installed),
        Extension(CurrentUser { id: user_id }),
        Json(CreateJobReq {
            model: request.model,
            prompt: request.prompt,
            seconds: request.seconds,
            size: request.size,
            input_image_path: request.input_image_path,
        }),
    )
    .await;
    let status = response.status();
    let bytes = to_bytes(response.into_body(), 1024 * 1024)
        .await
        .map_err(|e| format!("读取视频任务响应失败: {e}"))?;
    if !status.is_success() {
        let parsed = serde_json::from_slice::<serde_json::Value>(&bytes)
            .ok()
            .and_then(|value| value.get("error").and_then(|v| v.as_str()).map(str::to_string));
        return Err(parsed.unwrap_or_else(|| String::from_utf8_lossy(&bytes).to_string()));
    }
    serde_json::from_slice::<serde_json::Value>(&bytes)
        .ok()
        .and_then(|value| value.get("token").and_then(|v| v.as_str()).map(str::to_string))
        .ok_or_else(|| "视频任务响应缺少 token".to_string())
}

pub(crate) async fn workflow_video_state(
    state: &AppState,
    installed: &InstalledState,
    user_id: i64,
    token: &str,
) -> Result<WorkflowVideoState, String> {
    advance_job(
        &state.http,
        &installed.pool,
        installed.kind,
        &state.storage,
        token,
    )
    .await;
    let row = fetch_job(&installed.pool, installed.kind, token)
        .await
        .filter(|job| job.user_id == user_id)
        .ok_or_else(|| "视频任务不存在".to_string())?;
    Ok(WorkflowVideoState {
        status: row.status,
        output_path: row.video_path,
        error: row.error,
    })
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

    let pricing = match channels::get_price(pool, kind, &req.model).await {
        Ok(Some(p)) if p.enabled && p.kind == "video" => p,
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
        match state.storage.get(MediaKind::Image, name).await {
            Ok(bytes) => {
                image_mime = mime_guess::from_path(name)
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

    let choice = match channels::select_one_by_advertised_model(
        &state.http,
        pool,
        kind,
        &model,
    )
    .await
    {
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
            return err(
                StatusCode::BAD_REQUEST,
                "暂无支持该模型的可用视频渠道，请联系管理员",
            );
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
             started_at = {now}, last_polled_at = {now} WHERE id = ? AND status = 'pending'"
        ),
    );
    let updated = sqlx::query(&update_sql)
        .bind(&upstream_id)
        .bind(job_id)
        .execute(pool)
        .await
        .map(|r| r.rows_affected())
        .unwrap_or(0);

    if updated == 0 {
        // Row was already reaped (and refunded) by the sweeper as an orphan
        // while our upstream POST was still in flight. The video may still
        // get created upstream, but we must not double-grant credits here —
        // just report the failure to the caller.
        return err(
            StatusCode::BAD_GATEWAY,
            "任务已超时被回收，积分已退还，请重试".to_string(),
        );
    }

    (StatusCode::CREATED, Json(CreateJobResp { token, cost })).into_response()
}

// ---------------------------------------------------------------------------
// lazy-poll advancement
// ---------------------------------------------------------------------------

/// SQL fragment for "3 seconds ago" in the given dialect's datetime domain.
fn three_seconds_ago_expr(kind: DbKind) -> &'static str {
    match kind {
        DbKind::Sqlite => "datetime('now','-3 seconds')",
        DbKind::Mysql => "DATE_SUB(NOW(), INTERVAL 3 SECOND)",
        DbKind::Postgres => "now() - interval '3 seconds'",
    }
}

/// SQL fragment for "N minutes ago" in the given dialect's datetime domain.
/// `n` is a validated caller-controlled literal (never user input), so
/// interpolating it directly into the SQL string is safe.
pub(crate) fn minutes_ago_expr(kind: DbKind, n: i64) -> String {
    match kind {
        DbKind::Sqlite => format!("datetime('now','-{n} minutes')"),
        DbKind::Mysql => format!("DATE_SUB(NOW(), INTERVAL {n} MINUTE)"),
        DbKind::Postgres => format!("now() - interval '{n} minutes'"),
    }
}

/// Look up a channel's (base_url, api_key) by id. No dependency on
/// channels.rs internals beyond the shared `upstream_channels` table.
pub(crate) async fn channel_by_id(
    pool: &Pool,
    kind: DbKind,
    id: i64,
) -> Result<Option<(String, String)>, sqlx::Error> {
    let sql = db::q(kind, "SELECT base_url, api_key FROM upstream_channels WHERE id = ?");
    let row: Option<(String, String)> = sqlx::query_as(&sql).bind(id).fetch_optional(pool).await?;
    Ok(row)
}

// Named struct (rather than a tuple) — sqlx's tuple `FromRow` impls only go
// up to ~16 elements and we have 21 columns. `refunded`/`polling` are read
// via `db::bool_as_int` so they decode as i64 across dialects (see db.rs);
// converted to bool right after fetch.
#[derive(Debug, Clone, sqlx::FromRow)]
struct JobRowRaw {
    id: i64,
    user_id: i64,
    token: String,
    model: String,
    prompt: String,
    seconds: i64,
    size: String,
    input_image_path: Option<String>,
    upstream_video_id: Option<String>,
    channel_id: Option<i64>,
    cost_credits: i64,
    status: String,
    progress: i64,
    video_path: Option<String>,
    error: Option<String>,
    refunded: i64,
    download_retries: i64,
    polling: i64,
    #[allow(dead_code)]
    last_polled_at: Option<String>,
    created_at: String,
    finished_at: Option<String>,
}

#[derive(Debug, Clone)]
struct JobRow {
    id: i64,
    user_id: i64,
    token: String,
    model: String,
    prompt: String,
    seconds: i64,
    size: String,
    input_image_path: Option<String>,
    upstream_video_id: Option<String>,
    channel_id: Option<i64>,
    cost_credits: i64,
    status: String,
    progress: i64,
    video_path: Option<String>,
    error: Option<String>,
    refunded: bool,
    download_retries: i64,
    #[allow(dead_code)]
    polling: bool,
    #[allow(dead_code)]
    last_polled_at: Option<String>,
    created_at: String,
    finished_at: Option<String>,
}

impl From<JobRowRaw> for JobRow {
    fn from(r: JobRowRaw) -> Self {
        JobRow {
            id: r.id,
            user_id: r.user_id,
            token: r.token,
            model: r.model,
            prompt: r.prompt,
            seconds: r.seconds,
            size: r.size,
            input_image_path: r.input_image_path,
            upstream_video_id: r.upstream_video_id,
            channel_id: r.channel_id,
            cost_credits: r.cost_credits,
            status: r.status,
            progress: r.progress,
            video_path: r.video_path,
            error: r.error,
            refunded: r.refunded != 0,
            download_retries: r.download_retries,
            polling: r.polling != 0,
            last_polled_at: r.last_polled_at,
            created_at: r.created_at,
            finished_at: r.finished_at,
        }
    }
}

const JOB_COLS: &str = "id, user_id, token, model, prompt, seconds, size, input_image_path, \
     upstream_video_id, channel_id, cost_credits, status, progress, video_path, error, \
     __REFUNDED__, download_retries, __POLLING__, last_polled_at, created_at, finished_at";

fn job_cols(kind: DbKind) -> String {
    JOB_COLS
        .replace("__REFUNDED__", &db::bool_as_int(kind, "refunded"))
        .replace("__POLLING__", &db::bool_as_int(kind, "polling"))
}

#[derive(Serialize)]
struct JobView {
    token: String,
    model: String,
    prompt: String,
    seconds: i64,
    size: String,
    input_image_path: Option<String>,
    status: String,
    progress: i64,
    video_path: Option<String>,
    error: Option<String>,
    cost_credits: i64,
    refunded: bool,
    created_at: String,
    finished_at: Option<String>,
}

impl From<&JobRow> for JobView {
    fn from(r: &JobRow) -> Self {
        JobView {
            token: r.token.clone(),
            model: r.model.clone(),
            prompt: r.prompt.clone(),
            seconds: r.seconds,
            size: r.size.clone(),
            input_image_path: r.input_image_path.clone(),
            status: r.status.clone(),
            progress: r.progress,
            video_path: r.video_path.clone(),
            error: r.error.clone(),
            cost_credits: r.cost_credits,
            refunded: r.refunded,
            created_at: r.created_at.clone(),
            finished_at: r.finished_at.clone(),
        }
    }
}

async fn fetch_job(pool: &Pool, kind: DbKind, token: &str) -> Option<JobRow> {
    let cols = job_cols(kind);
    let sql = db::q(kind, &format!("SELECT {cols} FROM video_jobs WHERE token = ?"));
    let row: Option<JobRowRaw> = sqlx::query_as(&sql).bind(token).fetch_optional(pool).await.ok()?;
    row.map(JobRow::from)
}

async fn release_lock(pool: &Pool, kind: DbKind, token: &str) {
    let bf = if matches!(kind, DbKind::Sqlite | DbKind::Mysql) { "0" } else { "FALSE" };
    let sql = db::q(kind, &format!("UPDATE video_jobs SET polling = {bf} WHERE token = ?"));
    let _ = sqlx::query(&sql).bind(token).execute(pool).await;
}

/// Advance a single job's state by polling the upstream provider once, subject
/// to a 3-second throttle. Consumed by the get_job handler for on-demand
/// polling and by the Task 6 sweeper for background advancement.
pub async fn advance_job(
    http: &reqwest::Client,
    pool: &Pool,
    kind: DbKind,
    storage: &MediaStorage,
    token: &str,
) {
    let Some(job) = fetch_job(pool, kind, token).await else { return };
    if job.status == "completed" || job.status == "failed" {
        return;
    }

    let bt = db::bool_true(kind);
    let now = db::now_expr(kind);
    let lock_sql = db::q(
        kind,
        &format!(
            "UPDATE video_jobs SET polling = {bt}, last_polled_at = {now} \
             WHERE token = ? AND polling <> {bt} \
               AND (last_polled_at IS NULL OR last_polled_at < {})",
            three_seconds_ago_expr(kind)
        ),
    );
    let got = sqlx::query(&lock_sql)
        .bind(token)
        .execute(pool)
        .await
        .map(|r| r.rows_affected())
        .unwrap_or(0);
    if got == 0 {
        return;
    }

    // Re-fetch after acquiring the lock: the pre-lock snapshot may be stale
    // (another poller could have completed/failed the job between our fetch
    // and the lock UPDATE), and polling from a stale row would re-download
    // and orphan the previous mp4 / miscount download_retries.
    match fetch_job(pool, kind, token).await {
        Some(job) if job.status != "completed" && job.status != "failed" => {
            poll_upstream_once(http, pool, kind, storage, &job).await;
        }
        _ => {}
    }
    release_lock(pool, kind, token).await;
}

/// Runs every ~60s from main. Three duties, cheap when idle:
/// 1) repair hung polling locks, 2) time out + refund stale jobs (>2h),
/// 3) advance orphaned jobs nobody is actively polling.
pub async fn sweep(http: &reqwest::Client, pool: &Pool, kind: DbKind, storage: &MediaStorage) {
    let bt = db::bool_true(kind);
    let bf = if matches!(kind, DbKind::Sqlite | DbKind::Mysql) { "0" } else { "FALSE" };

    // 1. Repair hung polling locks (crashed mid-poll > 5 min ago).
    let sql = db::q(
        kind,
        &format!(
            "UPDATE video_jobs SET polling = {bf} \
             WHERE polling = {bt} AND last_polled_at < {}",
            minutes_ago_expr(kind, 5)
        ),
    );
    let _ = sqlx::query(&sql).execute(pool).await;

    // 2. Timeout: > 2h and still not terminal → fail + refund.
    let stale: Vec<(i64, i64, String, i64)> = {
        let sql = db::q(
            kind,
            &format!(
                "SELECT id, user_id, model, cost_credits FROM video_jobs \
                 WHERE status IN ('pending','running') AND created_at < {}",
                minutes_ago_expr(kind, 120)
            ),
        );
        sqlx::query_as(&sql).fetch_all(pool).await.unwrap_or_default()
    };
    for (id, user_id, model, cost) in stale {
        let now = db::now_expr(kind);
        let sql = db::q(
            kind,
            &format!(
                "UPDATE video_jobs SET status = 'failed', error = '生成超时', finished_at = {now} \
                 WHERE id = ? AND status IN ('pending','running')"
            ),
        );
        let n = sqlx::query(&sql)
            .bind(id)
            .execute(pool)
            .await
            .map(|r| r.rows_affected())
            .unwrap_or(0);
        if n > 0 {
            refund_job(pool, kind, id, user_id, &model, cost, "timeout").await;
        }
    }

    // 3. Advance orphans: running/pending not polled for 10 min (user closed page).
    //    Guard against racing create_job: a freshly-inserted pending row has
    //    upstream_video_id = NULL and last_polled_at = NULL while the create
    //    POST is still in flight. Only treat it as orphaned once either the
    //    upstream id has been recorded, or the row itself is old enough
    //    (2 minutes) that the in-flight create attempt must have finished.
    let orphans: Vec<(String,)> = {
        let sql = db::q(
            kind,
            &format!(
                "SELECT token FROM video_jobs \
                 WHERE status IN ('pending','running') \
                   AND (last_polled_at IS NULL OR last_polled_at < {}) \
                   AND (upstream_video_id IS NOT NULL OR created_at < {}) \
                 ORDER BY created_at ASC LIMIT 20",
                minutes_ago_expr(kind, 10),
                minutes_ago_expr(kind, 2)
            ),
        );
        sqlx::query_as(&sql).fetch_all(pool).await.unwrap_or_default()
    };
    for (token,) in orphans {
        advance_job(http, pool, kind, storage, &token).await;
    }
}

async fn poll_upstream_once(
    http: &reqwest::Client,
    pool: &Pool,
    kind: DbKind,
    storage: &MediaStorage,
    job: &JobRow,
) {
    let Some(upstream_video_id) = job.upstream_video_id.as_deref() else {
        // create_job never got a usable upstream id — nothing to poll.
        mark_job_failed(pool, kind, job.id, "任务未成功创建").await;
        refund_job(pool, kind, job.id, job.user_id, &job.model, job.cost_credits, "create_error").await;
        return;
    };

    let Some(channel_id) = job.channel_id else {
        mark_job_failed(pool, kind, job.id, "渠道已删除").await;
        refund_job(pool, kind, job.id, job.user_id, &job.model, job.cost_credits, "upstream_failed").await;
        return;
    };

    let (base, key) = match channel_by_id(pool, kind, channel_id).await {
        Ok(Some(c)) => c,
        Ok(None) => {
            mark_job_failed(pool, kind, job.id, "渠道已删除").await;
            refund_job(pool, kind, job.id, job.user_id, &job.model, job.cost_credits, "upstream_failed").await;
            return;
        }
        Err(e) => {
            let _ = mark_error_only(pool, kind, job.id, &e.to_string()).await;
            return;
        }
    };
    let base = base.trim_end_matches('/');

    let resp = match http
        .get(format!("{base}/v1/videos/{upstream_video_id}"))
        .bearer_auth(&key)
        .send()
        .await
    {
        Ok(r) => r,
        Err(e) => {
            // Transient network failure: record error, keep status, retry next poll.
            mark_error_only(pool, kind, job.id, &format!("轮询失败: {e}")).await;
            return;
        }
    };

    let body: serde_json::Value = match resp.json().await {
        Ok(v) => v,
        Err(e) => {
            mark_error_only(pool, kind, job.id, &format!("轮询响应解析失败: {e}")).await;
            return;
        }
    };

    let status = body.get("status").and_then(|v| v.as_str()).unwrap_or("");
    match status {
        "queued" | "in_progress" => {
            let progress = body.get("progress").and_then(|v| v.as_i64()).unwrap_or(0);
            let sql = db::q(kind, "UPDATE video_jobs SET progress = ? WHERE id = ?");
            let _ = sqlx::query(&sql).bind(progress).bind(job.id).execute(pool).await;
        }
        "failed" => {
            let msg = body
                .get("error")
                .and_then(|e| e.get("message"))
                .and_then(|v| v.as_str())
                .unwrap_or("上游生成失败");
            mark_job_failed(pool, kind, job.id, msg).await;
            refund_job(pool, kind, job.id, job.user_id, &job.model, job.cost_credits, "upstream_failed").await;
        }
        "completed" => {
            download_completed_video(http, pool, kind, storage, job, base, upstream_video_id, &key).await;
        }
        _ => {
            mark_error_only(pool, kind, job.id, &format!("未知上游状态: {status}")).await;
        }
    }
}

async fn mark_error_only(pool: &Pool, kind: DbKind, job_id: i64, error: &str) {
    let trimmed: String = error.chars().take(500).collect();
    let sql = db::q(kind, "UPDATE video_jobs SET error = ? WHERE id = ?");
    let _ = sqlx::query(&sql).bind(&trimmed).bind(job_id).execute(pool).await;
}

#[allow(clippy::too_many_arguments)]
async fn download_completed_video(
    http: &reqwest::Client,
    pool: &Pool,
    kind: DbKind,
    storage: &MediaStorage,
    job: &JobRow,
    base: &str,
    upstream_video_id: &str,
    key: &str,
) {
    let result: Result<Vec<u8>, String> = async {
        let resp = http
            .get(format!("{base}/v1/videos/{upstream_video_id}/content"))
            .bearer_auth(key)
            .send()
            .await
            .map_err(|e| e.to_string())?;
        if !resp.status().is_success() {
            return Err(format!("上游返回 {}", resp.status()));
        }
        resp.bytes().await.map(|b| b.to_vec()).map_err(|e| e.to_string())
    }
    .await;

    let bytes = match result {
        Ok(b) => b,
        Err(e) => {
            handle_download_failure(pool, kind, job, &e).await;
            return;
        }
    };

    let name = format!("{}.mp4", random_hex(16));
    if let Err(e) = storage.put(MediaKind::Video, &name, bytes).await {
        handle_download_failure(pool, kind, job, &format!("写入媒体存储失败: {e}")).await;
        return;
    }

    let now = db::now_expr(kind);
    let video_path = format!("/api/videos/{name}");
    let sql = db::q(
        kind,
        &format!(
            "UPDATE video_jobs SET status = 'completed', video_path = ?, progress = 100, \
             finished_at = {now} WHERE id = ? AND status <> 'failed'"
        ),
    );
    let updated = sqlx::query(&sql)
        .bind(&video_path)
        .bind(job.id)
        .execute(pool)
        .await
        .map(|r| r.rows_affected())
        .unwrap_or(0);

    if updated == 0 {
        // Job was already marked failed (e.g. by the 2h-timeout sweeper)
        // while the download was in flight — don't resurrect it, and don't
        // leave an orphan file behind.
        let _ = storage.delete(MediaKind::Video, &name).await;
    }
}

async fn handle_download_failure(pool: &Pool, kind: DbKind, job: &JobRow, msg: &str) {
    let retries = job.download_retries + 1;
    let trimmed: String = msg.chars().take(500).collect();
    if retries < 5 {
        let sql = db::q(
            kind,
            "UPDATE video_jobs SET download_retries = ?, error = ? WHERE id = ?",
        );
        let _ = sqlx::query(&sql).bind(retries).bind(&trimmed).bind(job.id).execute(pool).await;
    } else {
        let now = db::now_expr(kind);
        let sql = db::q(
            kind,
            &format!(
                "UPDATE video_jobs SET status = 'failed', download_retries = ?, error = ?, \
                 finished_at = {now} WHERE id = ?"
            ),
        );
        let _ = sqlx::query(&sql).bind(retries).bind(&trimmed).bind(job.id).execute(pool).await;
        refund_job(pool, kind, job.id, job.user_id, &job.model, job.cost_credits, "download_failed").await;
    }
}

// ---------------------------------------------------------------------------
// get/list/delete handlers
// ---------------------------------------------------------------------------

async fn get_job(
    State(state): State<AppState>,
    Extension(s): Extension<InstalledState>,
    Extension(user): Extension<CurrentUser>,
    Path(token): Path<String>,
) -> Response {
    let pool = &s.pool;
    let kind = s.kind;

    let owned = fetch_job(pool, kind, &token).await;
    match &owned {
        Some(j) if j.user_id == user.id => {}
        _ => return err(StatusCode::NOT_FOUND, "任务不存在"),
    }

    advance_job(&state.http, pool, kind, &state.storage, &token).await;

    match fetch_job(pool, kind, &token).await {
        Some(j) if j.user_id == user.id => Json(JobView::from(&j)).into_response(),
        _ => err(StatusCode::NOT_FOUND, "任务不存在"),
    }
}

#[derive(Deserialize)]
struct ListJobsQuery {
    #[serde(default)]
    page: i64,
}

#[derive(Serialize)]
struct ListJobsResp {
    jobs: Vec<JobView>,
    has_more: bool,
}

async fn list_jobs(
    Extension(s): Extension<InstalledState>,
    Extension(user): Extension<CurrentUser>,
    Query(q): Query<ListJobsQuery>,
) -> Response {
    let pool = &s.pool;
    let kind = s.kind;
    let page = q.page.max(0);
    let offset = page * 24;

    let cols = job_cols(kind);
    let sql = db::q(
        kind,
        &format!("SELECT {cols} FROM video_jobs WHERE user_id = ? ORDER BY created_at DESC LIMIT 25 OFFSET ?"),
    );
    let rows: Vec<JobRowRaw> = match sqlx::query_as(&sql).bind(user.id).bind(offset).fetch_all(pool).await {
        Ok(v) => v,
        Err(e) => return err(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()),
    };

    let mut jobs: Vec<JobRow> = rows.into_iter().map(JobRow::from).collect();

    let has_more = jobs.len() > 24;
    jobs.truncate(24);
    let views: Vec<JobView> = jobs.iter().map(JobView::from).collect();
    Json(ListJobsResp { jobs: views, has_more }).into_response()
}

async fn delete_job(
    State(state): State<AppState>,
    Extension(s): Extension<InstalledState>,
    Extension(user): Extension<CurrentUser>,
    Path(token): Path<String>,
) -> Response {
    let pool = &s.pool;
    let kind = s.kind;

    let job = match fetch_job(pool, kind, &token).await {
        Some(j) if j.user_id == user.id => j,
        _ => return err(StatusCode::NOT_FOUND, "任务不存在"),
    };

    if job.status == "pending" || job.status == "running" {
        return err(StatusCode::CONFLICT, "任务进行中，暂不能删除");
    }

    if let Some(video_path) = job.video_path.as_deref() {
        if let Some(name) = video_path.rsplit('/').next() {
            let _ = state.storage.delete(MediaKind::Video, name).await;
        }
    }

    let sql = db::q(kind, "DELETE FROM video_jobs WHERE id = ?");
    let _ = sqlx::query(&sql).bind(job.id).execute(pool).await;

    StatusCode::NO_CONTENT.into_response()
}

// ---------------------------------------------------------------------------
// MP4 static serving (with Range support)
// ---------------------------------------------------------------------------

fn parse_video_range(value: &str, total: u64) -> Option<(u64, u64)> {
    if total == 0 || value.contains(',') {
        return None;
    }
    let (start, end) = value.trim().split_once('-')?;
    if start.is_empty() {
        let suffix = end.parse::<u64>().ok()?;
        if suffix == 0 {
            return None;
        }
        let length = suffix.min(total);
        return Some((total - length, total - 1));
    }

    let start = start.parse::<u64>().ok()?;
    if start >= total {
        return None;
    }
    let end = if end.is_empty() {
        total - 1
    } else {
        end.parse::<u64>().ok()?.min(total - 1)
    };
    (start <= end).then_some((start, end))
}

async fn serve_video(
    State(state): State<AppState>,
    Path(name): Path<String>,
    headers: HeaderMap,
) -> Response {
    if name.contains("..") || name.contains('/') || name.contains('\\') {
        return StatusCode::BAD_REQUEST.into_response();
    }
    let mime = mime_guess::from_path(&name).first_or_octet_stream();
    if let Some(r) = headers
        .get(header::RANGE)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.strip_prefix("bytes="))
    {
        let total = match state.storage.size(MediaKind::Video, &name).await {
            Ok(size) => size,
            Err(error) if error.is_not_found() => return StatusCode::NOT_FOUND.into_response(),
            Err(error) => {
                eprintln!("[storage] inspect video {name}: {error}");
                return StatusCode::BAD_GATEWAY.into_response();
            }
        };
        let Some((start, end)) = parse_video_range(r, total) else {
            return Response::builder()
                .status(StatusCode::RANGE_NOT_SATISFIABLE)
                .header(header::CONTENT_RANGE, format!("bytes */{total}"))
                .body(Body::empty())
                .unwrap();
        };
        let chunk = match state.storage.get_range(MediaKind::Video, &name, start..end + 1).await {
            Ok(bytes) => bytes,
            Err(error) if error.is_not_found() => return StatusCode::NOT_FOUND.into_response(),
            Err(error) => {
                eprintln!("[storage] serve video range {name}: {error}");
                return StatusCode::BAD_GATEWAY.into_response();
            }
        };
        return Response::builder()
            .status(StatusCode::PARTIAL_CONTENT)
            .header(header::CONTENT_TYPE, mime.as_ref())
            .header(header::ACCEPT_RANGES, "bytes")
            .header(header::CONTENT_RANGE, format!("bytes {start}-{end}/{total}"))
            .header(header::CACHE_CONTROL, "private, max-age=86400, immutable")
            .body(Body::from(chunk))
            .unwrap();
    }
    let bytes = match state.storage.get(MediaKind::Video, &name).await {
        Ok(bytes) => bytes,
        Err(error) if error.is_not_found() => return StatusCode::NOT_FOUND.into_response(),
        Err(error) => {
            eprintln!("[storage] serve video {name}: {error}");
            return StatusCode::BAD_GATEWAY.into_response();
        }
    };
    Response::builder()
        .header(header::CONTENT_TYPE, mime.as_ref())
        .header(header::ACCEPT_RANGES, "bytes")
        .header(header::CACHE_CONTROL, "private, max-age=86400, immutable")
        .body(Body::from(bytes))
        .unwrap()
}

pub fn public_routes() -> Router<AppState> {
    Router::new().route("/videos/{name}", get(serve_video))
}

pub fn routes() -> Router<AppState> {
    Router::new()
        .route("/videos/models", get(user_list_models))
        .route("/videos/jobs", post(create_job).get(list_jobs))
        .route("/videos/jobs/{token}", get(get_job).delete(delete_job))
}

#[cfg(test)]
mod tests {
    use super::{parse_video_range, JobRow, JobView};

    #[test]
    fn parses_http_byte_ranges() {
        assert_eq!(parse_video_range("0-99", 1000), Some((0, 99)));
        assert_eq!(parse_video_range("900-", 1000), Some((900, 999)));
        assert_eq!(parse_video_range("-100", 1000), Some((900, 999)));
        assert_eq!(parse_video_range("0-9999", 1000), Some((0, 999)));
        assert_eq!(parse_video_range("1000-", 1000), None);
        assert_eq!(parse_video_range("0-1,4-5", 1000), None);
        assert_eq!(parse_video_range("-0", 1000), None);
        assert_eq!(parse_video_range("0-", 0), None);
    }

    #[test]
    fn job_view_keeps_reference_image_for_retries() {
        let row = JobRow {
            id: 1,
            user_id: 2,
            token: "job-token".to_string(),
            model: "video-model".to_string(),
            prompt: "animate this image".to_string(),
            seconds: 4,
            size: "1280x720".to_string(),
            input_image_path: Some("/api/images/reference.png".to_string()),
            upstream_video_id: None,
            channel_id: Some(3),
            cost_credits: 25,
            status: "failed".to_string(),
            progress: 0,
            video_path: None,
            error: Some("temporary upstream error".to_string()),
            refunded: true,
            download_retries: 0,
            polling: false,
            last_polled_at: None,
            created_at: "2026-08-14 00:00:00".to_string(),
            finished_at: Some("2026-08-14 00:00:01".to_string()),
        };

        let json = serde_json::to_value(JobView::from(&row)).unwrap();
        assert_eq!(json["input_image_path"], "/api/images/reference.png");
    }
}
