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

    let parsed: serde_json::Value = match serde_json::from_slice(&raw) {
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
        .route("/images/{name}", get(serve_image))
}
