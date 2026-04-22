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
use serde::Serialize;

use crate::{AppState, CurrentUser, credits, header_truthy, net_guard};

fn trim_slash(s: &str) -> &str {
    s.trim_end_matches('/')
}

#[derive(Clone, Copy)]
enum ImageKind {
    Generate,
    Edit,
}

fn image_endpoint(host: &str, protocol: &str, model: &str, kind: ImageKind) -> String {
    let base = trim_slash(host);
    match (protocol, kind) {
        ("openai", ImageKind::Generate) => format!("{base}/v1/images/generations"),
        ("openai", ImageKind::Edit) => format!("{base}/v1/images/edits"),
        // Gemini/Imagen: model path form. generateContent is the image-edit/
        // inpaint path used by gemini-2.5-flash-image-preview; :predict is for
        // Imagen text-to-image.
        ("gemini", ImageKind::Generate) => format!("{base}/v1beta/models/{model}:predict"),
        ("gemini", ImageKind::Edit) => format!("{base}/v1beta/models/{model}:generateContent"),
        _ => format!("{base}/"),
    }
}

/// Resolve upstream for an image request.
/// Returns (endpoint_url, key, used_shared, shared_model). In shared mode the
/// admin's configured model always wins — any `X-Upstream-Model` the client
/// sent is ignored, so users can't switch models on shared credits.
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
            let admin_model = s.model.clone().unwrap_or_default();
            if admin_model.is_empty() {
                return Err((
                    StatusCode::SERVICE_UNAVAILABLE,
                    "shared image upstream has no configured model — ask the admin to set one",
                )
                    .into_response());
            }
            let url = image_endpoint(&s.url, protocol, &admin_model, kind);
            Ok((url, s.key, true, Some(admin_model)))
        }
        None => Err((
            StatusCode::BAD_REQUEST,
            "missing X-Upstream-Url/Key header (and no shared image backend configured)",
        )
            .into_response()),
    }
}

/// Rewrite `model` field of a JSON body. Used for OpenAI image generations
/// when falling back to shared.
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

#[derive(Serialize)]
struct GeneratedImages {
    images: Vec<GeneratedImage>,
}

#[derive(Serialize)]
struct GeneratedImage {
    path: String,
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

async fn decode_openai_image_response(state: &AppState, raw: &[u8]) -> Response {
    let parsed: serde_json::Value = match serde_json::from_slice(raw) {
        Ok(v) => v,
        Err(e) => return err(StatusCode::BAD_GATEWAY, format!("parse: {e}")),
    };

    let items = parsed
        .get("data")
        .and_then(|d| d.as_array())
        .cloned()
        .unwrap_or_default();

    let images_dir = state.data_dir.join("images");
    if let Err(e) = tokio::fs::create_dir_all(&images_dir).await {
        return err(StatusCode::INTERNAL_SERVER_ERROR, format!("mkdir: {e}"));
    }

    let mut out = Vec::new();
    for item in items {
        let revised = item
            .get("revised_prompt")
            .and_then(|v| v.as_str())
            .map(String::from);

        let bytes: Vec<u8> = if let Some(b64) = item.get("b64_json").and_then(|v| v.as_str()) {
            match STANDARD.decode(b64) {
                Ok(b) => b,
                Err(e) => return err(StatusCode::BAD_GATEWAY, format!("b64 decode: {e}")),
            }
        } else if let Some(remote) = item.get("url").and_then(|v| v.as_str()) {
            let (_parsed, host, addrs) = match net_guard::validate_upstream_url(remote).await {
                Ok(v) => v,
                Err(r) => return r,
            };
            let client = match net_guard::guarded_client(&host, &addrs) {
                Ok(c) => c,
                Err(r) => return r,
            };
            match client.get(remote).send().await {
                Ok(r) => r.bytes().await.unwrap_or_default().to_vec(),
                Err(e) => return err(StatusCode::BAD_GATEWAY, format!("fetch image: {e}")),
            }
        } else {
            continue;
        };

        let name = format!("{}.png", random_hex(16));
        let path = images_dir.join(&name);
        if let Err(e) = tokio::fs::write(&path, &bytes).await {
            return err(StatusCode::INTERNAL_SERVER_ERROR, format!("write: {e}"));
        }
        out.push(GeneratedImage {
            path: format!("/api/images/{name}"),
            revised_prompt: revised,
        });
    }

    if out.is_empty() {
        return err(StatusCode::BAD_GATEWAY, "upstream returned no images");
    }
    Json(GeneratedImages { images: out }).into_response()
}

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
    let client = match net_guard::client_for_upstream(&state.http, &url, used_shared).await {
        Ok(c) => c,
        Err(r) => return r,
    };
    let body = match (used_shared, shared_model.as_deref()) {
        (true, Some(m)) if !m.is_empty() => override_json_model(&body, m),
        _ => body,
    };
    if used_shared {
        if let Err(r) = deduct_image_credits(&state, user.id, "openai").await {
            return r;
        }
    }

    let resp = match client
        .post(&url)
        .bearer_auth(&key)
        .header(header::CONTENT_TYPE, "application/json")
        .body(body)
        .send()
        .await
    {
        Ok(r) => r,
        Err(e) => {
            if used_shared {
                refund_image_credits(&state, user.id, "refund_connect_error").await;
            }
            return err(StatusCode::BAD_GATEWAY, format!("upstream: {e}"));
        }
    };

    let status = resp.status();
    let raw = resp.bytes().await.unwrap_or_default();
    if !status.is_success() {
        if used_shared {
            refund_image_credits(&state, user.id, "refund_upstream_error").await;
        }
        return err(
            StatusCode::BAD_GATEWAY,
            format!("upstream {status}: {}", String::from_utf8_lossy(&raw)),
        );
    }

    decode_openai_image_response(&state, &raw).await
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
    let client = match net_guard::client_for_upstream(&state.http, &url, used_shared).await {
        Ok(c) => c,
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

    let resp = match client
        .post(&url)
        .bearer_auth(&key)
        .header(header::CONTENT_TYPE, content_type)
        .body(body)
        .send()
        .await
    {
        Ok(r) => r,
        Err(e) => {
            if used_shared {
                refund_image_credits(&state, user.id, "refund_connect_error").await;
            }
            return err(StatusCode::BAD_GATEWAY, format!("upstream: {e}"));
        }
    };

    let status = resp.status();
    let raw = resp.bytes().await.unwrap_or_default();
    if !status.is_success() {
        if used_shared {
            refund_image_credits(&state, user.id, "refund_upstream_error").await;
        }
        return err(
            StatusCode::BAD_GATEWAY,
            format!("upstream {status}: {}", String::from_utf8_lossy(&raw)),
        );
    }

    decode_openai_image_response(&state, &raw).await
}

async fn proxy_gemini_images(
    State(state): State<AppState>,
    Extension(user): Extension<CurrentUser>,
    headers: HeaderMap,
    body: axum::body::Bytes,
) -> Response {
    // The client distinguishes generateContent (edit) vs :predict (generate)
    // by URL suffix. Detect that to compose the right fallback endpoint.
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
    let client = match net_guard::client_for_upstream(&state.http, &url, used_shared).await {
        Ok(c) => c,
        Err(r) => return r,
    };
    if used_shared {
        if let Err(r) = deduct_image_credits(&state, user.id, "gemini").await {
            return r;
        }
    }

    let resp = match client
        .post(&url)
        .header("x-goog-api-key", key.as_str())
        .header(header::CONTENT_TYPE, "application/json")
        .body(body)
        .send()
        .await
    {
        Ok(r) => r,
        Err(e) => {
            if used_shared {
                refund_image_credits(&state, user.id, "refund_connect_error").await;
            }
            return err(StatusCode::BAD_GATEWAY, format!("upstream: {e}"));
        }
    };

    let status = resp.status();
    let raw = resp.bytes().await.unwrap_or_default();
    if !status.is_success() {
        if used_shared {
            refund_image_credits(&state, user.id, "refund_upstream_error").await;
        }
        return err(
            StatusCode::BAD_GATEWAY,
            format!("upstream {status}: {}", String::from_utf8_lossy(&raw)),
        );
    }

    let parsed: serde_json::Value = match serde_json::from_slice(&raw) {
        Ok(v) => v,
        Err(e) => return err(StatusCode::BAD_GATEWAY, format!("parse: {e}")),
    };

    // Imagen (:predict) returns { predictions: [{ bytesBase64Encoded, mimeType }] }
    // Vertex variant uses { predictions: [{ image: { imageBytes } }] }.
    // Gemini generateContent returns { candidates: [{ content: { parts: [{ inlineData: { data, mimeType } }] } }] }.
    let mut b64_items: Vec<(String, Option<String>)> = Vec::new();

    if let Some(preds) = parsed.get("predictions").and_then(|d| d.as_array()) {
        for p in preds {
            let data = p
                .get("bytesBase64Encoded")
                .and_then(|v| v.as_str())
                .or_else(|| p.pointer("/image/imageBytes").and_then(|v| v.as_str()));
            if let Some(d) = data {
                let mime = p
                    .get("mimeType")
                    .and_then(|v| v.as_str())
                    .map(String::from);
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
    if let Err(e) = tokio::fs::create_dir_all(&images_dir).await {
        return err(StatusCode::INTERNAL_SERVER_ERROR, format!("mkdir: {e}"));
    }

    let mut out = Vec::new();
    for (b64, mime) in b64_items {
        let bytes = match STANDARD.decode(&b64) {
            Ok(b) => b,
            Err(e) => return err(StatusCode::BAD_GATEWAY, format!("b64 decode: {e}")),
        };
        let ext = match mime.as_deref() {
            Some("image/jpeg") => "jpg",
            Some("image/webp") => "webp",
            _ => "png",
        };
        let name = format!("{}.{ext}", random_hex(16));
        let path = images_dir.join(&name);
        if let Err(e) = tokio::fs::write(&path, &bytes).await {
            return err(StatusCode::INTERNAL_SERVER_ERROR, format!("write: {e}"));
        }
        out.push(GeneratedImage {
            path: format!("/api/images/{name}"),
            revised_prompt: None,
        });
    }

    if out.is_empty() {
        return err(StatusCode::BAD_GATEWAY, "upstream returned no images");
    }
    Json(GeneratedImages { images: out }).into_response()
}

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
        .route("/images/{name}", get(serve_image))
}
