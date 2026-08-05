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
    extract::Path,
    http::StatusCode,
    middleware,
    response::{IntoResponse, Response},
    routing::{delete, get},
};
use serde::{Deserialize, Serialize};

use crate::{
    AppState, InstalledState, admin, channels,
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

pub fn routes() -> Router<AppState> {
    Router::new().route("/videos/models", get(user_list_models))
}
