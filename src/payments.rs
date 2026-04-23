use std::collections::BTreeMap;

use axum::{
    Extension, Json, Router,
    extract::{Form, Path, Query, State},
    http::StatusCode,
    middleware,
    response::{IntoResponse, Redirect, Response},
    routing::{get, post},
};
use md5::{Digest, Md5};
use serde::{Deserialize, Serialize};

use crate::{
    AppState, CurrentUser, InstalledState, admin, credits,
    db::{self, DbKind, Pool},
};

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

/// Epay-style signing: sort params by key ascending, build `a=1&b=2&c=3`
/// (NOT url-encoded), append the merchant key, then take lowercase MD5 hex.
/// Excluded from the signed payload: `sign`, `sign_type`, and empty values.
fn epay_sign(params: &BTreeMap<String, String>, key: &str) -> String {
    let mut parts: Vec<String> = Vec::new();
    for (k, v) in params.iter() {
        if k == "sign" || k == "sign_type" {
            continue;
        }
        if v.is_empty() {
            continue;
        }
        parts.push(format!("{k}={v}"));
    }
    let joined = parts.join("&");
    let mut hasher = Md5::new();
    hasher.update(joined.as_bytes());
    hasher.update(key.as_bytes());
    let digest = hasher.finalize();
    let mut hex = String::with_capacity(32);
    for b in digest.iter() {
        use std::fmt::Write;
        let _ = write!(hex, "{:02x}", b);
    }
    hex
}

fn random_out_trade_no(user_id: i64) -> String {
    use rand::Rng;
    let ts = chrono::Utc::now().timestamp_millis();
    let r: u32 = rand::thread_rng().gen_range(100_000..999_999);
    format!("NC{ts}{user_id}{r}")
}

async fn s(pool: &Pool, kind: DbKind, key: &str) -> String {
    credits::get_setting(pool, kind, key).await.unwrap_or_default()
}

fn validate_payway(p: &str) -> Option<&'static str> {
    match p {
        "alipay" => Some("alipay"),
        "wxpay" => Some("wxpay"),
        "qqpay" => Some("qqpay"),
        "bank" => Some("bank"),
        _ => None,
    }
}

// ---------------------------------------------------------------------------
// user: create order
// ---------------------------------------------------------------------------

#[derive(Deserialize)]
struct CreateOrderReq {
    /// Amount in yuan (integer for simplicity — admin sets min/max).
    yuan: i64,
    payway: String,
}

#[derive(Serialize)]
struct CreateOrderResp {
    out_trade_no: String,
    pay_url: String,
    amount_cents: i64,
    credits: i64,
    payway: String,
}

async fn create_order(
    Extension(installed): Extension<InstalledState>,
    Extension(user): Extension<CurrentUser>,
    Json(body): Json<CreateOrderReq>,
) -> Response {
    let pool = &installed.pool;
    let kind = installed.kind;

    if !credits::get_setting_bool(pool, kind, "epay_enabled", false).await {
        return (StatusCode::SERVICE_UNAVAILABLE, "充值通道尚未开启").into_response();
    }

    let payway = match validate_payway(body.payway.trim()) {
        Some(p) => p,
        None => return (StatusCode::BAD_REQUEST, "不支持的支付方式").into_response(),
    };

    let min_yuan = credits::get_setting_i64(pool, kind, "epay_min_yuan", 1).await.max(1);
    let max_yuan = credits::get_setting_i64(pool, kind, "epay_max_yuan", 5000)
        .await
        .max(min_yuan);
    if body.yuan < min_yuan || body.yuan > max_yuan {
        return (
            StatusCode::BAD_REQUEST,
            format!("金额必须在 {min_yuan} - {max_yuan} 元之间"),
        )
            .into_response();
    }

    let per_yuan = credits::get_setting_i64(pool, kind, "epay_credits_per_yuan", 100)
        .await
        .max(1);

    let api_url = s(pool, kind, "epay_api_url").await;
    let pid = s(pool, kind, "epay_pid").await;
    let key = s(pool, kind, "epay_key").await;
    let notify_url = s(pool, kind, "epay_notify_url").await;
    let return_url = s(pool, kind, "epay_return_url").await;
    let product_name = {
        let n = s(pool, kind, "epay_product_name").await;
        if n.is_empty() { "NovaChat 积分充值".to_string() } else { n }
    };

    if api_url.is_empty() || pid.is_empty() || key.is_empty() || notify_url.is_empty() {
        return (
            StatusCode::SERVICE_UNAVAILABLE,
            "管理员尚未配置支付网关",
        )
            .into_response();
    }

    let amount_cents = body.yuan * 100;
    let credits_to_grant = body.yuan * per_yuan;
    let out_trade_no = random_out_trade_no(user.id);

    // persist the order as pending
    let ins = db::q(
        kind,
        "INSERT INTO payment_orders (user_id, out_trade_no, provider, payway, amount_cents, credits, status)
         VALUES (?, ?, 'epay', ?, ?, ?, 'pending')",
    );
    if let Err(e) = sqlx::query(&ins)
        .bind(user.id)
        .bind(&out_trade_no)
        .bind(payway)
        .bind(amount_cents)
        .bind(credits_to_grant)
        .execute(pool)
        .await
    {
        return (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()).into_response();
    }

    // build signing params — values must match what we append to the URL
    let money = format!("{}.00", body.yuan);
    let mut params: BTreeMap<String, String> = BTreeMap::new();
    params.insert("pid".into(), pid.clone());
    params.insert("type".into(), payway.to_string());
    params.insert("out_trade_no".into(), out_trade_no.clone());
    params.insert("notify_url".into(), notify_url.clone());
    if !return_url.is_empty() {
        params.insert("return_url".into(), return_url.clone());
    }
    params.insert("name".into(), product_name);
    params.insert("money".into(), money);

    let sign = epay_sign(&params, &key);
    params.insert("sign".into(), sign);
    params.insert("sign_type".into(), "MD5".into());

    // build redirect URL (GET submit.php)
    let mut url = api_url.trim_end_matches('/').to_string();
    if !url.contains('?') {
        url.push('?');
    } else {
        url.push('&');
    }
    let query: Vec<String> = params
        .iter()
        .map(|(k, v)| format!("{}={}", urlencoding::encode(k), urlencoding::encode(v)))
        .collect();
    url.push_str(&query.join("&"));

    Json(CreateOrderResp {
        out_trade_no,
        pay_url: url,
        amount_cents,
        credits: credits_to_grant,
        payway: payway.to_string(),
    })
    .into_response()
}

// ---------------------------------------------------------------------------
// user: query order + list own orders
// ---------------------------------------------------------------------------

#[derive(Serialize)]
struct OrderView {
    id: i64,
    out_trade_no: String,
    payway: String,
    amount_cents: i64,
    credits: i64,
    status: String,
    trade_no: Option<String>,
    created_at: String,
    paid_at: Option<String>,
}

async fn get_my_order(
    Extension(installed): Extension<InstalledState>,
    Extension(user): Extension<CurrentUser>,
    Path(out_trade_no): Path<String>,
) -> Response {
    let sql = db::q(
        installed.kind,
        "SELECT id, out_trade_no, payway, amount_cents, credits, status, trade_no, created_at, paid_at
         FROM payment_orders WHERE out_trade_no = ? AND user_id = ?",
    );
    let row: Option<(i64, String, String, i64, i64, String, Option<String>, String, Option<String>)> =
        sqlx::query_as(&sql)
            .bind(&out_trade_no)
            .bind(user.id)
            .fetch_optional(&installed.pool)
            .await
            .ok()
            .flatten();
    match row {
        Some((id, out_trade_no, payway, amount_cents, credits, status, trade_no, created_at, paid_at)) => {
            Json(OrderView {
                id,
                out_trade_no,
                payway,
                amount_cents,
                credits,
                status,
                trade_no,
                created_at,
                paid_at,
            })
            .into_response()
        }
        None => (StatusCode::NOT_FOUND, "order not found").into_response(),
    }
}

async fn list_my_orders(
    Extension(installed): Extension<InstalledState>,
    Extension(user): Extension<CurrentUser>,
) -> Response {
    let sql = db::q(
        installed.kind,
        "SELECT id, out_trade_no, payway, amount_cents, credits, status, trade_no, created_at, paid_at
         FROM payment_orders WHERE user_id = ?
         ORDER BY created_at DESC, id DESC
         LIMIT 100",
    );
    let rows: Result<Vec<(i64, String, String, i64, i64, String, Option<String>, String, Option<String>)>, _> =
        sqlx::query_as(&sql).bind(user.id).fetch_all(&installed.pool).await;
    match rows {
        Ok(rs) => {
            let out: Vec<OrderView> = rs
                .into_iter()
                .map(|(id, out_trade_no, payway, amount_cents, credits, status, trade_no, created_at, paid_at)| {
                    OrderView {
                        id,
                        out_trade_no,
                        payway,
                        amount_cents,
                        credits,
                        status,
                        trade_no,
                        created_at,
                        paid_at,
                    }
                })
                .collect();
            Json(out).into_response()
        }
        Err(e) => (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()).into_response(),
    }
}

// ---------------------------------------------------------------------------
// public: epay notify + return
// ---------------------------------------------------------------------------

/// Process an incoming notify (GET or POST). Returns the plain-text body
/// that epay expects ("success" on OK, "fail" otherwise).
async fn process_notify(state: &AppState, params: BTreeMap<String, String>) -> String {
    let Ok(installed) = state.require_installed().await else {
        return "fail".into();
    };
    let pool = &installed.pool;
    let kind = installed.kind;

    if !credits::get_setting_bool(pool, kind, "epay_enabled", false).await {
        return "fail".into();
    }

    let expected_pid = s(pool, kind, "epay_pid").await;
    let key = s(pool, kind, "epay_key").await;
    if expected_pid.is_empty() || key.is_empty() {
        return "fail".into();
    }

    let Some(pid) = params.get("pid") else { return "fail".into() };
    if pid != &expected_pid {
        return "fail".into();
    }
    let Some(sign) = params.get("sign").cloned() else { return "fail".into() };
    let computed = epay_sign(&params, &key);
    if !computed.eq_ignore_ascii_case(sign.as_str()) {
        return "fail".into();
    }

    let Some(out_trade_no) = params.get("out_trade_no").cloned() else { return "fail".into() };
    let money = params.get("money").cloned().unwrap_or_default();
    let trade_no = params.get("trade_no").cloned();
    let trade_status = params.get("trade_status").cloned().unwrap_or_default();

    if trade_status != "TRADE_SUCCESS" {
        return "fail".into();
    }

    // load order
    let sel = db::q(
        kind,
        "SELECT user_id, amount_cents, credits, status FROM payment_orders WHERE out_trade_no = ?",
    );
    let row: Option<(i64, i64, i64, String)> = sqlx::query_as(&sel)
        .bind(&out_trade_no)
        .fetch_optional(pool)
        .await
        .ok()
        .flatten();
    let Some((user_id, amount_cents, credits_to_grant, status)) = row else {
        return "fail".into();
    };

    // idempotency: already paid -> success
    if status == "paid" {
        return "success".into();
    }

    // validate amount — epay sends "10.00" as money string; compare as cents
    let reported_cents: i64 = money
        .split_once('.')
        .map(|(a, b)| {
            let ai: i64 = a.parse().unwrap_or(0);
            let bi: i64 = format!("{:0<2}", b.chars().take(2).collect::<String>())
                .parse()
                .unwrap_or(0);
            ai * 100 + bi
        })
        .unwrap_or_else(|| money.parse::<i64>().unwrap_or(0) * 100);
    if reported_cents != amount_cents {
        return "fail".into();
    }

    // atomic pending -> paid transition
    let now = db::now_expr(kind);
    let upd = db::q(
        kind,
        &format!(
            "UPDATE payment_orders
             SET status = 'paid', trade_no = ?, paid_at = {now}, updated_at = {now}
             WHERE out_trade_no = ? AND status = 'pending'"
        ),
    );
    let affected = sqlx::query(&upd)
        .bind(trade_no.as_deref())
        .bind(&out_trade_no)
        .execute(pool)
        .await
        .map(|r| r.rows_affected())
        .unwrap_or(0);
    if affected == 0 {
        // concurrent notify already handled it — still report success
        return "success".into();
    }

    // credit the user
    let reason = format!("epay_recharge:{out_trade_no}");
    let reason = if reason.len() > 80 {
        reason.chars().take(80).collect()
    } else {
        reason
    };
    if let Err(_) = credits::grant(pool, kind, user_id, credits_to_grant, &reason).await {
        // leave order as 'paid' — admin can manually adjust; still tell epay "success"
        // because the money IS received and retrying won't help.
    }
    "success".into()
}

async fn notify_get(
    State(state): State<AppState>,
    Query(params): Query<BTreeMap<String, String>>,
) -> Response {
    let body = process_notify(&state, params).await;
    (StatusCode::OK, body).into_response()
}

async fn notify_post(
    State(state): State<AppState>,
    Form(params): Form<BTreeMap<String, String>>,
) -> Response {
    let body = process_notify(&state, params).await;
    (StatusCode::OK, body).into_response()
}

/// Synchronous return URL — user's browser lands here after payment.
/// We verify the signature, update the order if possible, then redirect to the
/// SPA with out_trade_no so the UI can poll and show a result.
async fn return_handler(
    State(state): State<AppState>,
    Query(params): Query<BTreeMap<String, String>>,
) -> Response {
    let _ = process_notify(&state, params.clone()).await;
    let out_trade_no = params.get("out_trade_no").cloned().unwrap_or_default();
    let target = if out_trade_no.is_empty() {
        "/payments/return".to_string()
    } else {
        format!(
            "/payments/return?out_trade_no={}",
            urlencoding::encode(&out_trade_no)
        )
    };
    Redirect::to(&target).into_response()
}

// ---------------------------------------------------------------------------
// admin: config + order list
// ---------------------------------------------------------------------------

#[derive(Serialize)]
struct AdminPaymentConfig {
    enabled: bool,
    api_url: String,
    pid: String,
    key_set: bool,
    sign_type: String,
    credits_per_yuan: i64,
    product_name: String,
    min_yuan: i64,
    max_yuan: i64,
    return_url: String,
    notify_url: String,
}

async fn admin_get_config(Extension(installed): Extension<InstalledState>) -> Response {
    let pool = &installed.pool;
    let kind = installed.kind;
    let key = s(pool, kind, "epay_key").await;
    let view = AdminPaymentConfig {
        enabled: credits::get_setting_bool(pool, kind, "epay_enabled", false).await,
        api_url: s(pool, kind, "epay_api_url").await,
        pid: s(pool, kind, "epay_pid").await,
        key_set: !key.is_empty(),
        sign_type: {
            let v = s(pool, kind, "epay_sign_type").await;
            if v.is_empty() { "MD5".into() } else { v }
        },
        credits_per_yuan: credits::get_setting_i64(pool, kind, "epay_credits_per_yuan", 100).await,
        product_name: s(pool, kind, "epay_product_name").await,
        min_yuan: credits::get_setting_i64(pool, kind, "epay_min_yuan", 1).await,
        max_yuan: credits::get_setting_i64(pool, kind, "epay_max_yuan", 5000).await,
        return_url: s(pool, kind, "epay_return_url").await,
        notify_url: s(pool, kind, "epay_notify_url").await,
    };
    Json(view).into_response()
}

#[derive(Deserialize)]
struct AdminPaymentConfigUpdate {
    enabled: Option<bool>,
    api_url: Option<String>,
    pid: Option<String>,
    /// absent = unchanged, "" = clear, non-empty = set
    key: Option<String>,
    sign_type: Option<String>,
    credits_per_yuan: Option<i64>,
    product_name: Option<String>,
    min_yuan: Option<i64>,
    max_yuan: Option<i64>,
    return_url: Option<String>,
    notify_url: Option<String>,
}

async fn admin_patch_config(
    Extension(installed): Extension<InstalledState>,
    Json(body): Json<AdminPaymentConfigUpdate>,
) -> Response {
    let pool = &installed.pool;
    let kind = installed.kind;

    let ops: Vec<(&str, Option<String>)> = vec![
        ("epay_enabled", body.enabled.map(|b| b.to_string())),
        ("epay_api_url", body.api_url.map(|s| s.trim().to_string())),
        ("epay_pid", body.pid.map(|s| s.trim().to_string())),
        ("epay_key", body.key),
        ("epay_sign_type", body.sign_type.map(|s| s.trim().to_uppercase())),
        ("epay_credits_per_yuan", body.credits_per_yuan.map(|v| v.max(1).to_string())),
        ("epay_product_name", body.product_name.map(|s| s.trim().to_string())),
        ("epay_min_yuan", body.min_yuan.map(|v| v.max(1).to_string())),
        ("epay_max_yuan", body.max_yuan.map(|v| v.max(1).to_string())),
        ("epay_return_url", body.return_url.map(|s| s.trim().to_string())),
        ("epay_notify_url", body.notify_url.map(|s| s.trim().to_string())),
    ];
    for (k, v) in ops {
        if let Some(val) = v {
            if let Err(e) = credits::set_setting(pool, kind, k, &val).await {
                return (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()).into_response();
            }
        }
    }
    StatusCode::NO_CONTENT.into_response()
}

#[derive(Serialize)]
struct AdminOrderView {
    id: i64,
    user_id: i64,
    username: String,
    out_trade_no: String,
    payway: String,
    amount_cents: i64,
    credits: i64,
    status: String,
    trade_no: Option<String>,
    created_at: String,
    paid_at: Option<String>,
}

#[derive(Deserialize)]
struct AdminOrdersQuery {
    page: Option<i64>,
    status: Option<String>,
}

async fn admin_list_orders(
    Extension(installed): Extension<InstalledState>,
    Query(q): Query<AdminOrdersQuery>,
) -> Response {
    let page = q.page.unwrap_or(1).max(1);
    let per_page: i64 = 50;
    let offset = (page - 1) * per_page;
    let status_filter = q.status.as_deref().unwrap_or("");

    let base = "SELECT p.id, p.user_id, u.username, p.out_trade_no, p.payway, p.amount_cents,
                       p.credits, p.status, p.trade_no, p.created_at, p.paid_at
                FROM payment_orders p
                JOIN users u ON u.id = p.user_id";
    let (sql, has_status) = if matches!(status_filter, "pending" | "paid" | "failed") {
        (
            format!(
                "{base} WHERE p.status = ? ORDER BY p.created_at DESC, p.id DESC LIMIT ? OFFSET ?"
            ),
            true,
        )
    } else {
        (
            format!("{base} ORDER BY p.created_at DESC, p.id DESC LIMIT ? OFFSET ?"),
            false,
        )
    };
    let sql = db::q(installed.kind, &sql);

    let mut builder = sqlx::query_as::<_, (i64, i64, String, String, String, i64, i64, String, Option<String>, String, Option<String>)>(&sql);
    if has_status {
        builder = builder.bind(status_filter);
    }
    builder = builder.bind(per_page).bind(offset);

    match builder.fetch_all(&installed.pool).await {
        Ok(rs) => {
            let out: Vec<AdminOrderView> = rs
                .into_iter()
                .map(|(id, user_id, username, out_trade_no, payway, amount_cents, credits, status, trade_no, created_at, paid_at)| {
                    AdminOrderView {
                        id,
                        user_id,
                        username,
                        out_trade_no,
                        payway,
                        amount_cents,
                        credits,
                        status,
                        trade_no,
                        created_at,
                        paid_at,
                    }
                })
                .collect();
            Json(out).into_response()
        }
        Err(e) => (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()).into_response(),
    }
}

// ---------------------------------------------------------------------------
// routes
// ---------------------------------------------------------------------------

pub fn user_routes() -> Router<AppState> {
    Router::new()
        .route("/payments/orders", post(create_order).get(list_my_orders))
        .route("/payments/orders/{out_trade_no}", get(get_my_order))
}

pub fn admin_routes() -> Router<AppState> {
    Router::new()
        .route(
            "/admin/payments/config",
            get(admin_get_config).patch(admin_patch_config),
        )
        .route("/admin/payments/orders", get(admin_list_orders))
        .route_layer(middleware::from_fn(admin::require_admin))
}

pub fn public_routes() -> Router<AppState> {
    Router::new()
        .route(
            "/payments/epay/notify",
            get(notify_get).post(notify_post),
        )
        .route("/payments/epay/return", get(return_handler))
}
