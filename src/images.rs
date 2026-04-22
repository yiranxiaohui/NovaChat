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

use crate::{AppState, CurrentUser};

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
            match state.http.get(remote).send().await {
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
    Extension(_user): Extension<CurrentUser>,
    headers: HeaderMap,
    body: axum::body::Bytes,
) -> Response {
    let Some(url) = headers.get("x-upstream-url").and_then(|v| v.to_str().ok()) else {
        return err(StatusCode::BAD_REQUEST, "missing X-Upstream-Url header");
    };
    let Some(key) = headers.get("x-upstream-key").and_then(|v| v.to_str().ok()) else {
        return err(StatusCode::BAD_REQUEST, "missing X-Upstream-Key header");
    };

    let resp = match state
        .http
        .post(url)
        .bearer_auth(key)
        .header(header::CONTENT_TYPE, "application/json")
        .body(body)
        .send()
        .await
    {
        Ok(r) => r,
        Err(e) => return err(StatusCode::BAD_GATEWAY, format!("upstream: {e}")),
    };

    let status = resp.status();
    let raw = resp.bytes().await.unwrap_or_default();
    if !status.is_success() {
        return err(
            StatusCode::BAD_GATEWAY,
            format!("upstream {status}: {}", String::from_utf8_lossy(&raw)),
        );
    }

    decode_openai_image_response(&state, &raw).await
}

async fn proxy_openai_images_edits(
    State(state): State<AppState>,
    Extension(_user): Extension<CurrentUser>,
    headers: HeaderMap,
    body: axum::body::Bytes,
) -> Response {
    let Some(url) = headers.get("x-upstream-url").and_then(|v| v.to_str().ok()) else {
        return err(StatusCode::BAD_REQUEST, "missing X-Upstream-Url header");
    };
    let Some(key) = headers.get("x-upstream-key").and_then(|v| v.to_str().ok()) else {
        return err(StatusCode::BAD_REQUEST, "missing X-Upstream-Key header");
    };
    let content_type = match headers
        .get(header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
    {
        Some(v) if v.starts_with("multipart/form-data") => v.to_string(),
        _ => return err(StatusCode::BAD_REQUEST, "expected multipart/form-data body"),
    };

    let resp = match state
        .http
        .post(url)
        .bearer_auth(key)
        .header(header::CONTENT_TYPE, content_type)
        .body(body)
        .send()
        .await
    {
        Ok(r) => r,
        Err(e) => return err(StatusCode::BAD_GATEWAY, format!("upstream: {e}")),
    };

    let status = resp.status();
    let raw = resp.bytes().await.unwrap_or_default();
    if !status.is_success() {
        return err(
            StatusCode::BAD_GATEWAY,
            format!("upstream {status}: {}", String::from_utf8_lossy(&raw)),
        );
    }

    decode_openai_image_response(&state, &raw).await
}

async fn proxy_gemini_images(
    State(state): State<AppState>,
    Extension(_user): Extension<CurrentUser>,
    headers: HeaderMap,
    body: axum::body::Bytes,
) -> Response {
    let Some(url) = headers.get("x-upstream-url").and_then(|v| v.to_str().ok()) else {
        return err(StatusCode::BAD_REQUEST, "missing X-Upstream-Url header");
    };
    let Some(key) = headers.get("x-upstream-key").and_then(|v| v.to_str().ok()) else {
        return err(StatusCode::BAD_REQUEST, "missing X-Upstream-Key header");
    };

    let resp = match state
        .http
        .post(url)
        .header("x-goog-api-key", key)
        .header(header::CONTENT_TYPE, "application/json")
        .body(body)
        .send()
        .await
    {
        Ok(r) => r,
        Err(e) => return err(StatusCode::BAD_GATEWAY, format!("upstream: {e}")),
    };

    let status = resp.status();
    let raw = resp.bytes().await.unwrap_or_default();
    if !status.is_success() {
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
