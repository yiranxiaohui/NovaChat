//! Multi-channel upstream + per-model pricing.
//!
//! Tables (see migrations/{sqlite,postgres,mysql}/0019_channels_pricing.sql):
//!   * `upstream_channels`  — admin-managed providers (protocol/kind/base_url/api_key/enabled/priority)
//!   * `model_pricing`      — whitelist of callable models + credit cost per call
//!   * `channel_models`     — which channels serve which model (optional upstream id alias)
//!
//! See: docs/plans/2026-05-18-multi-channel-pricing.md

use axum::{
    Extension, Json, Router,
    extract::Path,
    http::{HeaderMap, StatusCode},
    middleware,
    response::{IntoResponse, Response},
    routing::{delete, get, patch},
};
use serde::{Deserialize, Serialize};

use crate::{
    AppState, InstalledState, admin,
    db::{self, DbKind, Pool},
};

// ---------------------------------------------------------------------------
// types
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize, sqlx::FromRow)]
pub struct Channel {
    pub id: i64,
    pub name: String,
    pub protocol: String,   // 'openai' | 'claude' | 'gemini'
    pub kind: String,       // 'chat' | 'image'
    pub base_url: String,
    pub api_key: String,
    pub enabled: bool,
    pub priority: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize, sqlx::FromRow)]
pub struct ModelPrice {
    pub id: i64,
    pub model: String,
    pub kind: String,
    pub cost_credits: i64,
    pub display_name: Option<String>,
    pub enabled: bool,
    pub protocol: String,
    pub context_limit: Option<i64>,
}

#[derive(Debug, Clone, Serialize, Deserialize, sqlx::FromRow)]
pub struct ChannelModel {
    pub channel_id: i64,
    pub model: String,
    pub upstream_id: Option<String>,
}

// ---------------------------------------------------------------------------
// channel queries
// ---------------------------------------------------------------------------

pub async fn list_channels(pool: &Pool, kind: DbKind) -> Result<Vec<Channel>, sqlx::Error> {
    // Fetch `enabled` as i64 across all three backends (sqlx::Any on SQLite
    // reports INTEGER as BIGINT, which can't decode straight to Rust bool).
    let enabled_col = db::bool_as_int(kind, "enabled");
    let sql = db::q(
        kind,
        &format!(
            "SELECT id, name, protocol, kind, base_url, api_key, \
             {enabled_col}, priority \
             FROM upstream_channels ORDER BY priority ASC, id ASC"
        ),
    );
    let rows: Vec<(i64, String, String, String, String, String, i64, i64)> =
        sqlx::query_as(&sql).fetch_all(pool).await?;
    Ok(rows
        .into_iter()
        .map(|(id, name, protocol, kind_, base_url, api_key, enabled, priority)| Channel {
            id,
            name,
            protocol,
            kind: kind_,
            base_url,
            api_key,
            enabled: enabled != 0,
            priority,
        })
        .collect())
}

/// All enabled channels that can serve `model`, matching `kind` ('chat'|'image'),
/// sorted by priority ascending.
///
/// Routing first looks for explicit `channel_models` bindings for the model:
/// those act as routing restrictions and optional upstream aliases. When the
/// model has NO binding (the common case — there is no binding UI), we fall
/// back to every enabled channel of the right `kind`. `resolve_route` then
/// narrows that set to the channels whose protocol matches the wire protocol
/// the client declared (derived from `model_pricing.protocol` via the picker),
/// so auto-routing lands on the correct provider without manual binding.
#[allow(dead_code)] // consumed by Task 2.1 select_channel_for_model
pub async fn channels_for_model(
    pool: &Pool,
    kind: DbKind,
    model: &str,
    flavor: &str,
) -> Result<Vec<(Channel, Option<String>)>, sqlx::Error> {
    let enabled_c = db::bool_as_int(kind, "c.enabled");
    let bool_true = db::bool_true(kind);
    let explicit_sql = db::q(
        kind,
        &format!(
            "SELECT c.id, c.name, c.protocol, c.kind, c.base_url, c.api_key, \
             {enabled_c}, c.priority, cm.upstream_id \
             FROM upstream_channels c \
             INNER JOIN channel_models cm ON cm.channel_id = c.id \
             WHERE cm.model = ? AND c.kind = ? AND c.enabled = {bool_true} \
             ORDER BY c.priority ASC, c.id ASC"
        ),
    );
    let rows: Vec<(i64, String, String, String, String, String, i64, i64, Option<String>)> =
        sqlx::query_as(&explicit_sql)
            .bind(model)
            .bind(flavor)
            .fetch_all(pool)
            .await?;

    if !rows.is_empty() {
        return Ok(rows
            .into_iter()
            .map(|(id, name, protocol, kind_, base_url, api_key, enabled, priority, upstream_id)| {
                (
                    Channel {
                        id,
                        name,
                        protocol,
                        kind: kind_,
                        base_url,
                        api_key,
                        enabled: enabled != 0,
                        priority,
                    },
                    upstream_id,
                )
            })
            .collect());
    }

    // No explicit binding → auto-route to all enabled channels of this kind.
    // upstream_id is None (send the model name as-is); resolve_route narrows
    // this set to the matching protocol afterwards.
    let fallback_sql = db::q(
        kind,
        &format!(
            "SELECT c.id, c.name, c.protocol, c.kind, c.base_url, c.api_key, \
             {enabled_c}, c.priority \
             FROM upstream_channels c \
             WHERE c.kind = ? AND c.enabled = {bool_true} \
             ORDER BY c.priority ASC, c.id ASC"
        ),
    );
    let fb: Vec<(i64, String, String, String, String, String, i64, i64)> =
        sqlx::query_as(&fallback_sql).bind(flavor).fetch_all(pool).await?;
    Ok(fb
        .into_iter()
        .map(|(id, name, protocol, kind_, base_url, api_key, enabled, priority)| {
            (
                Channel {
                    id,
                    name,
                    protocol,
                    kind: kind_,
                    base_url,
                    api_key,
                    enabled: enabled != 0,
                    priority,
                },
                None,
            )
        })
        .collect())
}

/// Resolved channel + the model id to send upstream (alias or original).
#[allow(dead_code)] // consumed by Task 2.2 chat/image callers
#[derive(Debug, Clone)]
pub struct ChannelChoice {
    pub channel: Channel,
    /// Upstream model identifier — channel_models.upstream_id if set, else `model`.
    pub upstream_model: String,
}

/// Priority-sorted list of channels that can serve (model, flavor).
///
/// Caller iterates the list; on 5xx / network error, falls back to the next.
/// Returns empty vec when the model has no channel binding (caller should 404 / "no upstream available").
pub async fn select_chain(
    pool: &Pool,
    kind: DbKind,
    model: &str,
    flavor: &str,
) -> Result<Vec<ChannelChoice>, sqlx::Error> {
    let rows = channels_for_model(pool, kind, model, flavor).await?;
    Ok(rows
        .into_iter()
        .map(|(channel, upstream_id)| ChannelChoice {
            upstream_model: upstream_id.unwrap_or_else(|| model.to_string()),
            channel,
        })
        .collect())
}

/// Convenience: just the top-priority enabled channel, or None.
#[allow(dead_code)] // consumed by Task 2.2 single-shot callers (no fallback needed)
pub async fn select_one(
    pool: &Pool,
    kind: DbKind,
    model: &str,
    flavor: &str,
) -> Result<Option<ChannelChoice>, sqlx::Error> {
    Ok(select_chain(pool, kind, model, flavor).await?.into_iter().next())
}

#[derive(Debug, Deserialize)]
pub struct ChannelInput {
    pub name: String,
    pub protocol: String,
    pub kind: String,
    pub base_url: String,
    pub api_key: String,
    #[serde(default = "default_true")]
    pub enabled: bool,
    #[serde(default = "default_priority")]
    pub priority: i64,
}
fn default_true() -> bool { true }
fn default_priority() -> i64 { 100 }

pub async fn create_channel(
    pool: &Pool,
    kind: DbKind,
    input: &ChannelInput,
) -> Result<i64, sqlx::Error> {
    let returning = db::returning_id(kind);
    let sql = db::q(
        kind,
        &format!(
            "INSERT INTO upstream_channels (name, protocol, kind, base_url, api_key, enabled, priority) \
             VALUES (?, ?, ?, ?, ?, ?, ?){returning}"
        ),
    );
    let enabled_v: i64 = if input.enabled { 1 } else { 0 };
    match kind {
        DbKind::Postgres => {
            let row: (i64,) = sqlx::query_as(&sql)
                .bind(&input.name)
                .bind(&input.protocol)
                .bind(&input.kind)
                .bind(&input.base_url)
                .bind(&input.api_key)
                .bind(input.enabled)
                .bind(input.priority)
                .fetch_one(pool)
                .await?;
            Ok(row.0)
        }
        DbKind::Sqlite => {
            let row: (i64,) = sqlx::query_as(&sql)
                .bind(&input.name)
                .bind(&input.protocol)
                .bind(&input.kind)
                .bind(&input.base_url)
                .bind(&input.api_key)
                .bind(enabled_v)
                .bind(input.priority)
                .fetch_one(pool)
                .await?;
            Ok(row.0)
        }
        DbKind::Mysql => {
            let r = sqlx::query(&sql)
                .bind(&input.name)
                .bind(&input.protocol)
                .bind(&input.kind)
                .bind(&input.base_url)
                .bind(&input.api_key)
                .bind(enabled_v)
                .bind(input.priority)
                .execute(pool)
                .await?;
            Ok(r.last_insert_id().unwrap_or(0))
        }
    }
}

#[derive(Debug, Deserialize, Default)]
pub struct ChannelPatch {
    pub name: Option<String>,
    pub protocol: Option<String>,
    pub kind: Option<String>,
    pub base_url: Option<String>,
    pub api_key: Option<String>,
    pub enabled: Option<bool>,
    pub priority: Option<i64>,
}

pub async fn update_channel(
    pool: &Pool,
    kind: DbKind,
    id: i64,
    patch: &ChannelPatch,
) -> Result<(), sqlx::Error> {
    // Build SET clause dynamically.
    let mut sets: Vec<&str> = Vec::new();
    if patch.name.is_some()     { sets.push("name = ?"); }
    if patch.protocol.is_some() { sets.push("protocol = ?"); }
    if patch.kind.is_some()     { sets.push("kind = ?"); }
    if patch.base_url.is_some() { sets.push("base_url = ?"); }
    if patch.api_key.is_some()  { sets.push("api_key = ?"); }
    if patch.enabled.is_some()  { sets.push("enabled = ?"); }
    if patch.priority.is_some() { sets.push("priority = ?"); }
    if sets.is_empty() {
        return Ok(());
    }
    let now = db::now_expr(kind);
    let sql = db::q(
        kind,
        &format!(
            "UPDATE upstream_channels SET {}, updated_at = {now} WHERE id = ?",
            sets.join(", ")
        ),
    );
    let mut q = sqlx::query(&sql);
    if let Some(v) = &patch.name     { q = q.bind(v); }
    if let Some(v) = &patch.protocol { q = q.bind(v); }
    if let Some(v) = &patch.kind     { q = q.bind(v); }
    if let Some(v) = &patch.base_url { q = q.bind(v); }
    if let Some(v) = &patch.api_key  { q = q.bind(v); }
    if let Some(v) = patch.enabled   {
        q = if matches!(kind, DbKind::Postgres) { q.bind(v) } else { q.bind(if v { 1i64 } else { 0i64 }) };
    }
    if let Some(v) = patch.priority  { q = q.bind(v); }
    q.bind(id).execute(pool).await.map(|_| ())
}

pub async fn delete_channel(pool: &Pool, kind: DbKind, id: i64) -> Result<(), sqlx::Error> {
    let sql = db::q(kind, "DELETE FROM upstream_channels WHERE id = ?");
    sqlx::query(&sql).bind(id).execute(pool).await.map(|_| ())
}

// ---------------------------------------------------------------------------
// channel_models
// ---------------------------------------------------------------------------

pub async fn list_channel_models(
    pool: &Pool,
    kind: DbKind,
    channel_id: i64,
) -> Result<Vec<ChannelModel>, sqlx::Error> {
    let sql = db::q(
        kind,
        "SELECT channel_id, model, upstream_id FROM channel_models WHERE channel_id = ? ORDER BY model ASC",
    );
    sqlx::query_as::<_, ChannelModel>(&sql)
        .bind(channel_id)
        .fetch_all(pool)
        .await
}

#[derive(Debug, Deserialize)]
pub struct ChannelModelsInput {
    pub models: Vec<ChannelModelEntry>,
}
#[derive(Debug, Deserialize)]
pub struct ChannelModelEntry {
    pub model: String,
    #[serde(default)]
    pub upstream_id: Option<String>,
}

/// Replace the model set for `channel_id` atomically.
pub async fn set_channel_models(
    pool: &Pool,
    kind: DbKind,
    channel_id: i64,
    entries: &[ChannelModelEntry],
) -> Result<(), sqlx::Error> {
    let mut tx = pool.begin().await?;
    let del = db::q(kind, "DELETE FROM channel_models WHERE channel_id = ?");
    sqlx::query(&del).bind(channel_id).execute(&mut *tx).await?;
    let ins = db::q(
        kind,
        "INSERT INTO channel_models (channel_id, model, upstream_id) VALUES (?, ?, ?)",
    );
    for e in entries {
        sqlx::query(&ins)
            .bind(channel_id)
            .bind(&e.model)
            .bind(e.upstream_id.as_deref())
            .execute(&mut *tx)
            .await?;
    }
    tx.commit().await
}

// ---------------------------------------------------------------------------
// model_pricing
// ---------------------------------------------------------------------------

pub async fn list_pricing(pool: &Pool, kind: DbKind) -> Result<Vec<ModelPrice>, sqlx::Error> {
    let enabled_col = db::bool_as_int(kind, "enabled");
    let sql = db::q(
        kind,
        &format!(
            "SELECT id, model, kind, cost_credits, display_name, {enabled_col}, protocol, context_limit \
             FROM model_pricing ORDER BY kind, model"
        ),
    );
    let rows: Vec<(i64, String, String, i64, Option<String>, i64, String, Option<i64>)> =
        sqlx::query_as(&sql).fetch_all(pool).await?;
    Ok(rows
        .into_iter()
        .map(|(id, model, kind_, cost_credits, display_name, enabled, protocol, context_limit)| ModelPrice {
            id,
            model,
            kind: kind_,
            cost_credits,
            display_name,
            enabled: enabled != 0,
            protocol,
            context_limit,
        })
        .collect())
}

#[allow(dead_code)] // consumed by Task 2.3 try_deduct rewrite
pub async fn get_price(
    pool: &Pool,
    kind: DbKind,
    model: &str,
) -> Result<Option<ModelPrice>, sqlx::Error> {
    let enabled_col = db::bool_as_int(kind, "enabled");
    let sql = db::q(
        kind,
        &format!(
            "SELECT id, model, kind, cost_credits, display_name, {enabled_col}, protocol, context_limit \
             FROM model_pricing WHERE model = ?"
        ),
    );
    let row: Option<(i64, String, String, i64, Option<String>, i64, String, Option<i64>)> =
        sqlx::query_as(&sql).bind(model).fetch_optional(pool).await?;
    Ok(row.map(|(id, model, kind_, cost_credits, display_name, enabled, protocol, context_limit)| ModelPrice {
        id,
        model,
        kind: kind_,
        cost_credits,
        display_name,
        enabled: enabled != 0,
        protocol,
        context_limit,
    }))
}

#[derive(Debug, Deserialize)]
pub struct PricingInput {
    pub model: String,
    pub kind: String,
    pub cost_credits: i64,
    #[serde(default)]
    pub display_name: Option<String>,
    #[serde(default = "default_true")]
    pub enabled: bool,
    #[serde(default = "default_protocol")]
    pub protocol: String,
    #[serde(default)]
    pub context_limit: Option<i64>,
}
fn default_protocol() -> String { "openai".to_string() }

pub async fn upsert_price(
    pool: &Pool,
    kind: DbKind,
    input: &PricingInput,
) -> Result<(), sqlx::Error> {
    let now = db::now_expr(kind);
    let sql = match kind {
        DbKind::Sqlite => format!(
            "INSERT INTO model_pricing (model, kind, cost_credits, display_name, enabled, protocol, context_limit, updated_at) \
             VALUES (?, ?, ?, ?, ?, ?, ?, {now}) \
             ON CONFLICT(model) DO UPDATE SET kind = excluded.kind, cost_credits = excluded.cost_credits, \
             display_name = excluded.display_name, enabled = excluded.enabled, protocol = excluded.protocol, \
             context_limit = excluded.context_limit, updated_at = {now}"
        ),
        DbKind::Postgres => format!(
            "INSERT INTO model_pricing (model, kind, cost_credits, display_name, enabled, protocol, context_limit, updated_at) \
             VALUES (?, ?, ?, ?, ?, ?, ?, {now}) \
             ON CONFLICT (model) DO UPDATE SET kind = EXCLUDED.kind, cost_credits = EXCLUDED.cost_credits, \
             display_name = EXCLUDED.display_name, enabled = EXCLUDED.enabled, protocol = EXCLUDED.protocol, \
             context_limit = EXCLUDED.context_limit, updated_at = {now}"
        ),
        DbKind::Mysql => format!(
            "INSERT INTO model_pricing (model, kind, cost_credits, display_name, enabled, protocol, context_limit, updated_at) \
             VALUES (?, ?, ?, ?, ?, ?, ?, {now}) \
             ON DUPLICATE KEY UPDATE kind = VALUES(kind), cost_credits = VALUES(cost_credits), \
             display_name = VALUES(display_name), enabled = VALUES(enabled), protocol = VALUES(protocol), \
             context_limit = VALUES(context_limit), updated_at = {now}"
        ),
    };
    let sql = db::q(kind, &sql);
    let enabled_v: i64 = if input.enabled { 1 } else { 0 };
    let ctx: Option<i64> = input.context_limit.filter(|n| *n > 0);
    let q = sqlx::query(&sql)
        .bind(&input.model)
        .bind(&input.kind)
        .bind(input.cost_credits)
        .bind(input.display_name.as_deref());
    let q = if matches!(kind, DbKind::Postgres) { q.bind(input.enabled) } else { q.bind(enabled_v) };
    let q = q.bind(&input.protocol);
    let q = q.bind(ctx);
    q.execute(pool).await.map(|_| ())
}

pub async fn delete_price(pool: &Pool, kind: DbKind, model: &str) -> Result<(), sqlx::Error> {
    let sql = db::q(kind, "DELETE FROM model_pricing WHERE model = ?");
    sqlx::query(&sql).bind(model).execute(pool).await.map(|_| ())
}

/// Convenience: top-priority enabled channel matching (protocol, flavor),
/// regardless of any specific model binding. Used by GET /v1/models to
/// surface an upstream catalog when in shared mode.
#[allow(dead_code)] // consumed by main.rs proxy_get_forward
pub async fn any_enabled_channel(
    pool: &Pool,
    kind: DbKind,
    protocol: &str,
    flavor: &str,
) -> Result<Option<Channel>, sqlx::Error> {
    let enabled_col = db::bool_as_int(kind, "enabled");
    let bool_true = db::bool_true(kind);
    let sql = db::q(
        kind,
        &format!(
            "SELECT id, name, protocol, kind, base_url, api_key, \
             {enabled_col}, priority \
             FROM upstream_channels \
             WHERE protocol = ? AND kind = ? AND enabled = {bool_true} \
             ORDER BY priority ASC, id ASC LIMIT 1"
        ),
    );
    let row: Option<(i64, String, String, String, String, String, i64, i64)> =
        sqlx::query_as(&sql)
            .bind(protocol)
            .bind(flavor)
            .fetch_optional(pool)
            .await?;
    Ok(row.map(|(id, name, protocol, kind_, base_url, api_key, enabled, priority)| Channel {
        id,
        name,
        protocol,
        kind: kind_,
        base_url,
        api_key,
        enabled: enabled != 0,
        priority,
    }))
}

// ---------------------------------------------------------------------------
// admin routes
// ---------------------------------------------------------------------------

fn err(status: StatusCode, msg: impl Into<String>) -> Response {
    (status, Json(serde_json::json!({ "error": msg.into() }))).into_response()
}

async fn admin_list_channels(Extension(s): Extension<InstalledState>) -> Response {
    match list_channels(&s.pool, s.kind).await {
        Ok(v) => Json(v).into_response(),
        Err(e) => err(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()),
    }
}

async fn admin_create_channel(
    Extension(s): Extension<InstalledState>,
    Json(input): Json<ChannelInput>,
) -> Response {
    if let Err(e) = validate_protocol_kind(&input.protocol, &input.kind) {
        return err(StatusCode::BAD_REQUEST, e);
    }
    match create_channel(&s.pool, s.kind, &input).await {
        Ok(id) => Json(serde_json::json!({ "id": id })).into_response(),
        Err(e) => err(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()),
    }
}

async fn admin_patch_channel(
    Extension(s): Extension<InstalledState>,
    Path(id): Path<i64>,
    Json(patch): Json<ChannelPatch>,
) -> Response {
    if let (Some(p), Some(k)) = (&patch.protocol, &patch.kind) {
        if let Err(e) = validate_protocol_kind(p, k) {
            return err(StatusCode::BAD_REQUEST, e);
        }
    }
    match update_channel(&s.pool, s.kind, id, &patch).await {
        Ok(_) => StatusCode::NO_CONTENT.into_response(),
        Err(e) => err(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()),
    }
}

async fn admin_delete_channel(
    Extension(s): Extension<InstalledState>,
    Path(id): Path<i64>,
) -> Response {
    match delete_channel(&s.pool, s.kind, id).await {
        Ok(_) => StatusCode::NO_CONTENT.into_response(),
        Err(e) => err(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()),
    }
}

async fn admin_get_channel_models(
    Extension(s): Extension<InstalledState>,
    Path(id): Path<i64>,
) -> Response {
    match list_channel_models(&s.pool, s.kind, id).await {
        Ok(v) => Json(v).into_response(),
        Err(e) => err(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()),
    }
}

async fn admin_put_channel_models(
    Extension(s): Extension<InstalledState>,
    Path(id): Path<i64>,
    Json(input): Json<ChannelModelsInput>,
) -> Response {
    match set_channel_models(&s.pool, s.kind, id, &input.models).await {
        Ok(_) => StatusCode::NO_CONTENT.into_response(),
        Err(e) => err(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()),
    }
}

/// Aggregate model list across all enabled channels' whitelists.
/// `?flavor=chat|image` filters by channel kind. Used by the pricing
/// panel's "new model" picker so admins don't have to type model ids
/// they've already entered in some channel.
#[derive(Serialize)]
struct AllChannelModel {
    model: String,
    kind: String,
    /// channel names that have this model in their whitelist (for UI hint)
    channels: Vec<String>,
}

/// Probe a single channel's upstream `/models` endpoint and return the list of
/// model IDs it advertises. Returns Err(string) for caller-facing display.
async fn probe_channel_models(
    http: &reqwest::Client,
    ch: &Channel,
) -> Result<Vec<String>, String> {
    let base = ch.base_url.trim_end_matches('/');
    let (url, protocol) = match ch.protocol.as_str() {
        "openai" => (format!("{base}/v1/models"), "openai"),
        "claude" => (format!("{base}/v1/models"), "claude"),
        "gemini" => (format!("{base}/v1beta/models?pageSize=200"), "gemini"),
        other => return Err(format!("unknown protocol {other}")),
    };
    let mut req = http
        .get(&url)
        .header(axum::http::header::ACCEPT, "application/json")
        .timeout(std::time::Duration::from_secs(15));
    req = match protocol {
        "openai" => req.bearer_auth(&ch.api_key),
        "claude" => req
            .header("x-api-key", ch.api_key.as_str())
            .header("anthropic-version", "2023-06-01"),
        "gemini" => req.header("x-goog-api-key", ch.api_key.as_str()),
        _ => req,
    };
    let resp = req.send().await.map_err(|e| format!("connect: {e}"))?;
    let status = resp.status();
    let bytes = resp.bytes().await.map_err(|e| format!("read: {e}"))?;
    if !status.is_success() {
        let body = String::from_utf8_lossy(&bytes);
        let snippet: String = body.chars().take(120).collect();
        return Err(format!("upstream {status}: {snippet}"));
    }
    let v: serde_json::Value = serde_json::from_slice(&bytes)
        .map_err(|e| format!("parse: {e}"))?;
    // OpenAI: {"data":[{"id":"gpt-4o", ...}, ...]}
    // Claude: {"data":[{"id":"claude-3-5-sonnet-...", ...}, ...]}
    // Gemini: {"models":[{"name":"models/gemini-1.5-pro", ...}, ...]}
    let mut out: Vec<String> = Vec::new();
    if protocol == "gemini" {
        if let Some(arr) = v.get("models").and_then(|m| m.as_array()) {
            for item in arr {
                if let Some(name) = item.get("name").and_then(|n| n.as_str()) {
                    // strip "models/" prefix if present
                    let id = name.strip_prefix("models/").unwrap_or(name).to_string();
                    out.push(id);
                }
            }
        }
    } else if let Some(arr) = v.get("data").and_then(|d| d.as_array()) {
        for item in arr {
            if let Some(id) = item.get("id").and_then(|s| s.as_str()) {
                out.push(id.to_string());
            }
        }
    }
    Ok(out)
}

async fn admin_list_all_channel_models(
    axum::extract::State(state): axum::extract::State<AppState>,
    Extension(s): Extension<InstalledState>,
    axum::extract::Query(q): axum::extract::Query<std::collections::HashMap<String, String>>,
) -> Response {
    let flavor = q.get("flavor").cloned();
    let channels = match list_channels(&s.pool, s.kind).await {
        Ok(v) => v,
        Err(e) => return err(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()),
    };
    let channels: Vec<Channel> = channels
        .into_iter()
        .filter(|c| c.enabled)
        .filter(|c| match flavor.as_deref() {
            Some(f) if matches!(f, "chat" | "image" | "video") => c.kind == f,
            _ => true,
        })
        .collect();

    // Probe all channels concurrently.
    let http = state.http.clone();
    let mut futs = Vec::with_capacity(channels.len());
    for ch in &channels {
        let http = http.clone();
        let ch_clone = ch.clone();
        futs.push(async move {
            let res = probe_channel_models(&http, &ch_clone).await;
            (ch_clone, res)
        });
    }
    let results = futures_util::future::join_all(futs).await;

    let mut map: std::collections::BTreeMap<(String, String), Vec<String>> =
        std::collections::BTreeMap::new();
    let mut errors: Vec<serde_json::Value> = Vec::new();
    for (ch, res) in results {
        match res {
            Ok(models) => {
                for model in models {
                    map.entry((model, ch.kind.clone()))
                        .or_default()
                        .push(ch.name.clone());
                }
            }
            Err(e) => {
                errors.push(serde_json::json!({
                    "channel": ch.name,
                    "error": e,
                }));
            }
        }
    }
    let models: Vec<AllChannelModel> = map
        .into_iter()
        .map(|((model, kind), channels)| AllChannelModel { model, kind, channels })
        .collect();
    Json(serde_json::json!({
        "models": models,
        "errors": errors,
    }))
    .into_response()
}

async fn admin_list_pricing(Extension(s): Extension<InstalledState>) -> Response {
    match list_pricing(&s.pool, s.kind).await {
        Ok(v) => Json(v).into_response(),
        Err(e) => err(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()),
    }
}

async fn admin_upsert_pricing(
    Extension(s): Extension<InstalledState>,
    Json(input): Json<PricingInput>,
) -> Response {
    if !matches!(input.kind.as_str(), "chat" | "image") {
        return err(StatusCode::BAD_REQUEST, "kind must be 'chat' or 'image'");
    }
    if input.cost_credits < 0 {
        return err(StatusCode::BAD_REQUEST, "cost_credits must be >= 0");
    }
    match upsert_price(&s.pool, s.kind, &input).await {
        Ok(_) => StatusCode::NO_CONTENT.into_response(),
        Err(e) => err(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()),
    }
}

async fn admin_delete_pricing(
    Extension(s): Extension<InstalledState>,
    Path(model): Path<String>,
) -> Response {
    match delete_price(&s.pool, s.kind, &model).await {
        Ok(_) => StatusCode::NO_CONTENT.into_response(),
        Err(e) => err(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()),
    }
}

fn validate_protocol_kind(protocol: &str, kind: &str) -> Result<(), String> {
    if !matches!(protocol, "openai" | "claude" | "gemini") {
        return Err("protocol must be openai/claude/gemini".into());
    }
    if !matches!(kind, "chat" | "image" | "video") {
        return Err("kind must be chat/image/video".into());
    }
    if kind == "video" && protocol != "openai" {
        return Err("视频渠道仅支持 openai 协议".into());
    }
    Ok(())
}

pub fn admin_routes() -> Router<AppState> {
    Router::new()
        .route("/admin/channels", get(admin_list_channels).post(admin_create_channel))
        .route("/admin/channels/{id}", patch(admin_patch_channel).delete(admin_delete_channel))
        .route(
            "/admin/channels/{id}/models",
            get(admin_get_channel_models).put(admin_put_channel_models),
        )
        .route("/admin/channels/all-models", get(admin_list_all_channel_models))
        .route("/admin/pricing", get(admin_list_pricing).post(admin_upsert_pricing))
        .route("/admin/pricing/{model}", delete(admin_delete_pricing))
        .route_layer(middleware::from_fn(admin::require_admin))
}

// ---------------------------------------------------------------------------
// user-facing routes (no admin gate; auth via parent router)
// ---------------------------------------------------------------------------

/// Public model listing for the "use platform credits" mode in settings.
/// Returns every model in `model_pricing` (enabled=1) that has at least one
/// enabled `upstream_channels` row bound via `channel_models`. Each entry
/// carries the protocol of its top-priority channel so the client can group
/// chat models by OpenAI / Claude / Gemini in the picker.
#[derive(Serialize)]
struct PlatformModel {
    model: String,
    display_name: Option<String>,
    kind: String, // "chat" | "image"
    cost_credits: i64,
    protocol: String, // top-priority channel's protocol
    context_limit: Option<i64>,
}

async fn user_list_platform_models(
    Extension(s): Extension<InstalledState>,
    axum::extract::Query(q): axum::extract::Query<std::collections::HashMap<String, String>>,
) -> Response {
    let flavor_filter = q.get("flavor").cloned();
    let pricing = match list_pricing(&s.pool, s.kind).await {
        Ok(v) => v,
        Err(e) => return err(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()),
    };
    let mut out: Vec<PlatformModel> = Vec::new();
    for p in pricing {
        if !p.enabled { continue; }
        if let Some(ref f) = flavor_filter {
            if &p.kind != f { continue; }
        }
        // Auto-routing: a priced model declares its protocol in model_pricing.
        // Show it only when at least one enabled channel of that protocol+kind
        // exists, so the picker never lists a model the client can't route.
        match any_enabled_channel(&s.pool, s.kind, &p.protocol, &p.kind).await {
            Ok(Some(_)) => {}
            Ok(None) => continue,
            Err(_) => continue,
        }
        out.push(PlatformModel {
            model: p.model.clone(),
            display_name: p.display_name.clone(),
            kind: p.kind.clone(),
            cost_credits: p.cost_credits,
            protocol: p.protocol.clone(),
            context_limit: p.context_limit,
        });
    }
    Json(out).into_response()
}

pub fn user_routes() -> Router<AppState> {
    Router::new().route("/channels/models", get(user_list_platform_models))
}

// ---------------------------------------------------------------------------
// routing — call-site helpers (Task 2.2)
// ---------------------------------------------------------------------------
//
// Two-tier resolution:
//   1. BYOK — client supplies X-Upstream-Url/Key headers and didn't set
//      X-Use-Shared=1: no credits deducted, no routing.
//   2. Channels — admin-configured upstream_channels matching (model, kind),
//      sorted by priority ASC. Caller iterates the chain on transient errors.

fn header_str<'a>(h: &'a HeaderMap, name: &str) -> Option<&'a str> {
    h.get(name)
        .and_then(|v| v.to_str().ok())
        .map(str::trim)
        .filter(|s| !s.is_empty())
}


/// BYOK route: a single concrete upstream (base_url + key) provided by the
/// client. No credits, no fallback.
#[derive(Debug, Clone)]
pub struct ByokRoute {
    pub base_url: String,
    pub api_key: String,
}

/// Resolved route for a request.
#[derive(Debug)]
pub enum Route {
    /// Client supplied X-Upstream-Url/Key and didn't ask for shared.
    Byok(ByokRoute),
    /// Server-side channels matching (model, kind). Empty Vec means
    /// "no upstream available" — caller should return 400.
    Channels {
        model: String,
        chain: Vec<ChannelChoice>,
    },
}

/// Extract `model` from a chat request body / header.
/// OpenAI + Claude: JSON body `{"model": "..."}`. Gemini: URL path, but the
/// client sets `X-Upstream-Model` header for shared mode — we accept either.
pub fn extract_chat_model(body: &[u8], headers: &HeaderMap) -> Option<String> {
    if let Some(m) = header_str(headers, "x-upstream-model") {
        return Some(m.to_string());
    }
    let v: serde_json::Value = serde_json::from_slice(body).ok()?;
    v.get("model")
        .and_then(|m| m.as_str())
        .map(|s| s.to_string())
        .filter(|s| !s.is_empty())
}

/// Round-robin cursor keyed by `(protocol, model, priority-tier)`. Used to
/// rotate the starting channel among equal-priority channels so load spreads
/// evenly across them request-to-request. In-memory only (resets on restart) —
/// exact fairness across a process restart isn't required.
fn rr_next(key: &str) -> u64 {
    static COUNTERS: std::sync::OnceLock<std::sync::Mutex<std::collections::HashMap<String, u64>>> =
        std::sync::OnceLock::new();
    let m = COUNTERS.get_or_init(|| std::sync::Mutex::new(std::collections::HashMap::new()));
    let mut g = m.lock().unwrap_or_else(|e| e.into_inner());
    let c = g.entry(key.to_string()).or_insert(0);
    let v = *c;
    *c = c.wrapping_add(1);
    v
}

/// Reorder a priority-sorted chain so that, within each priority tier of 2+
/// channels, the starting channel rotates round-robin. Tiers stay in ascending
/// priority order, so failover still walks lower-priority tiers afterwards.
fn balance_chain(chain: Vec<ChannelChoice>, key_prefix: &str) -> Vec<ChannelChoice> {
    let mut out: Vec<ChannelChoice> = Vec::with_capacity(chain.len());
    let mut i = 0;
    while i < chain.len() {
        let prio = chain[i].channel.priority;
        let mut j = i;
        while j < chain.len() && chain[j].channel.priority == prio {
            j += 1;
        }
        let group = &chain[i..j];
        if group.len() > 1 {
            let start = (rr_next(&format!("{key_prefix}:{prio}")) as usize) % group.len();
            for k in 0..group.len() {
                out.push(group[(start + k) % group.len()].clone());
            }
        } else {
            out.push(group[0].clone());
        }
        i = j;
    }
    out
}

/// Resolve a request to either a BYOK route or a channel chain.
///
/// `flavor` is "chat" or "image". `protocol` is the wire protocol the client is
/// speaking ("openai"/"claude"/"gemini"); the channel chain is filtered to
/// channels of that exact protocol so a request is never sent to a channel that
/// speaks a different protocol. `model` is the user-requested model name.
/// For BYOK requests `model` may be empty — it's only used to look up channels.
pub async fn resolve_route(
    pool: &Pool,
    kind: DbKind,
    headers: &HeaderMap,
    flavor: &str,
    protocol: &str,
    model: &str,
) -> Result<Route, Response> {
    // BYOK only when both URL and key are present. `X-Use-Shared` header is
    // no longer consulted — admin-configured channels are the default path.
    let hdr_url = header_str(headers, "x-upstream-url");
    let hdr_key = header_str(headers, "x-upstream-key");
    if let (Some(u), Some(k)) = (hdr_url, hdr_key) {
        if !u.is_empty() && !k.is_empty() {
            return Ok(Route::Byok(ByokRoute {
                base_url: u.to_string(),
                api_key: k.to_string(),
            }));
        }
    }
    if model.is_empty() {
        return Err((
            StatusCode::BAD_REQUEST,
            "请求体缺少 model 字段（或 X-Upstream-Model 头）",
        )
            .into_response());
    }
    let chain = select_chain(pool, kind, model, flavor).await.map_err(|e| {
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            format!("channel lookup failed: {e}"),
        )
            .into_response()
    })?;
    let chain: Vec<ChannelChoice> = chain
        .into_iter()
        .filter(|c| c.channel.protocol == protocol)
        .collect();
    if chain.is_empty() {
        return Err((
            StatusCode::BAD_REQUEST,
            format!("模型 {model} 未配置任何可用的 {protocol} 渠道"),
        )
            .into_response());
    }
    let chain = balance_chain(chain, &format!("{flavor}:{protocol}:{model}"));
    Ok(Route::Channels {
        model: model.to_string(),
        chain,
    })
}

// ---------------------------------------------------------------------------
// pricing-aware deduct (Task 2.3)
// ---------------------------------------------------------------------------

#[derive(Debug)]
pub enum DeductError {
    /// model is not registered in `model_pricing`, or its row is disabled.
    NotWhitelisted,
    /// user's balance is below the model's cost. Carries (current_balance, cost).
    Insufficient { balance: i64, cost: i64 },
}

/// Look up `model` in `model_pricing` (must match `flavor` and be enabled),
/// then atomically deduct that many credits from `user_id`.
///
/// Returns `(new_balance, cost_deducted)` on success — callers MUST use the
/// returned `cost` for any refund rather than re-reading the price, which could
/// change between deduction and refund. Errors:
///   * `NotWhitelisted` — model is missing or disabled in `model_pricing`.
///     Caller should respond 403 "model not enabled".
///   * `Insufficient` — pricing OK but balance too low. Caller responds 402.
pub async fn try_deduct_for_model(
    pool: &Pool,
    kind: DbKind,
    user_id: i64,
    model: &str,
    flavor: &str,
    protocol: &str,
    reason: &str,
) -> Result<(i64, i64), DeductError> {
    let price = match get_price(pool, kind, model).await {
        Ok(Some(p)) => p,
        Ok(None) | Err(_) => return Err(DeductError::NotWhitelisted),
    };
    if !price.enabled || price.kind != flavor {
        return Err(DeductError::NotWhitelisted);
    }
    let cost = price.cost_credits.max(0);
    let meta = if flavor == "image" {
        crate::credits::LedgerMeta::image(protocol, model)
    } else {
        crate::credits::LedgerMeta::chat(protocol, model)
    };
    match crate::credits::try_deduct(pool, kind, user_id, cost, reason, &meta).await {
        Ok(bal) => Ok((bal, cost)),
        Err(bal) => Err(DeductError::Insufficient { balance: bal, cost }),
    }
}

/// Look up the cost of `model` (whitelist gate) without deducting — used by
/// refund paths that already deducted via `try_deduct_for_model` and need to
/// compute the credit amount to grant back on upstream failure.
pub async fn cost_for_model(
    pool: &Pool,
    kind: DbKind,
    model: &str,
    flavor: &str,
) -> Option<i64> {
    let p = get_price(pool, kind, model).await.ok().flatten()?;
    if !p.enabled || p.kind != flavor {
        return None;
    }
    Some(p.cost_credits.max(0))
}
