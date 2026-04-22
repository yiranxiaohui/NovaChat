use axum::{
    Extension, Json, Router,
    http::StatusCode,
    response::{IntoResponse, Response},
    routing::{get, post},
};
use serde::Deserialize;

use crate::{AppState, CurrentUser, InstalledState, UserDto, auth, db};

pub const MAX_DISPLAY_NAME: usize = 64;
pub const MAX_AVATAR_URL: usize = 512;

#[derive(Deserialize)]
pub struct UpdateProfile {
    pub display_name: Option<String>,
    pub avatar_url: Option<String>,
}

#[derive(Deserialize)]
pub struct ChangePassword {
    pub current_password: String,
    pub new_password: String,
}

fn err(status: StatusCode, msg: impl Into<String>) -> Response {
    (status, msg.into()).into_response()
}

fn normalize_display_name(v: &str) -> Result<Option<String>, Response> {
    let cleaned: String = v.chars().filter(|c| !c.is_control()).collect();
    let trimmed = cleaned.trim();
    if trimmed.chars().count() > MAX_DISPLAY_NAME {
        return Err(err(StatusCode::BAD_REQUEST, "display_name too long"));
    }
    if trimmed.is_empty() {
        Ok(None)
    } else {
        Ok(Some(trimmed.to_string()))
    }
}

fn normalize_avatar_url(v: &str) -> Result<Option<String>, Response> {
    let trimmed = v.trim();
    if trimmed.len() > MAX_AVATAR_URL {
        return Err(err(StatusCode::BAD_REQUEST, "avatar_url too long"));
    }
    if trimmed.is_empty() {
        return Ok(None);
    }
    if !(trimmed.starts_with("http://")
        || trimmed.starts_with("https://")
        || trimmed.starts_with("data:image/"))
    {
        return Err(err(
            StatusCode::BAD_REQUEST,
            "avatar_url must be an http(s) or data:image URL",
        ));
    }
    Ok(Some(trimmed.to_string()))
}

async fn load_user_dto(installed: &InstalledState, user_id: i64) -> Result<UserDto, Response> {
    let admin_col = db::bool_as_int(installed.kind, "is_admin");
    let sql = db::q(
        installed.kind,
        &format!(
            "SELECT id, username, display_name, avatar_url, {admin_col}
             FROM users WHERE id = ?"
        ),
    );
    let row: Option<(i64, String, Option<String>, Option<String>, i64)> = sqlx::query_as(&sql)
        .bind(user_id)
        .fetch_optional(&installed.pool)
        .await
        .map_err(|e| err(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
    match row {
        Some((id, username, display_name, avatar_url, is_admin)) => Ok(UserDto {
            id,
            username,
            display_name,
            avatar_url,
            is_admin: is_admin != 0,
        }),
        None => Err(err(StatusCode::NOT_FOUND, "user not found")),
    }
}

async fn get_profile(
    Extension(installed): Extension<InstalledState>,
    Extension(user): Extension<CurrentUser>,
) -> Response {
    match load_user_dto(&installed, user.id).await {
        Ok(dto) => Json(dto).into_response(),
        Err(r) => r,
    }
}

async fn update_profile(
    Extension(installed): Extension<InstalledState>,
    Extension(user): Extension<CurrentUser>,
    Json(body): Json<UpdateProfile>,
) -> Response {
    if let Some(raw) = body.display_name {
        let value = match normalize_display_name(&raw) {
            Ok(v) => v,
            Err(r) => return r,
        };
        let sql = db::q(
            installed.kind,
            "UPDATE users SET display_name = ? WHERE id = ?",
        );
        if let Err(e) = sqlx::query(&sql)
            .bind(value)
            .bind(user.id)
            .execute(&installed.pool)
            .await
        {
            return err(StatusCode::INTERNAL_SERVER_ERROR, e.to_string());
        }
    }
    if let Some(raw) = body.avatar_url {
        let value = match normalize_avatar_url(&raw) {
            Ok(v) => v,
            Err(r) => return r,
        };
        let sql = db::q(
            installed.kind,
            "UPDATE users SET avatar_url = ? WHERE id = ?",
        );
        if let Err(e) = sqlx::query(&sql)
            .bind(value)
            .bind(user.id)
            .execute(&installed.pool)
            .await
        {
            return err(StatusCode::INTERNAL_SERVER_ERROR, e.to_string());
        }
    }

    match load_user_dto(&installed, user.id).await {
        Ok(dto) => Json(dto).into_response(),
        Err(r) => r,
    }
}

async fn change_password(
    Extension(installed): Extension<InstalledState>,
    Extension(user): Extension<CurrentUser>,
    Json(body): Json<ChangePassword>,
) -> Response {
    if body.new_password.len() < 6 || body.new_password.len() > 256 {
        return err(
            StatusCode::BAD_REQUEST,
            "new password must be 6-256 characters",
        );
    }

    let sel = db::q(
        installed.kind,
        "SELECT password_hash FROM users WHERE id = ?",
    );
    let row: Option<(String,)> = sqlx::query_as(&sel)
        .bind(user.id)
        .fetch_optional(&installed.pool)
        .await
        .unwrap_or(None);
    let Some((phc,)) = row else {
        return err(StatusCode::UNAUTHORIZED, "user not found");
    };
    if !auth::verify_password(&body.current_password, &phc) {
        return err(StatusCode::UNAUTHORIZED, "current password incorrect");
    }
    let new_hash = match auth::hash_password(&body.new_password) {
        Ok(h) => h,
        Err(e) => return err(StatusCode::INTERNAL_SERVER_ERROR, e),
    };
    let sql = db::q(
        installed.kind,
        "UPDATE users SET password_hash = ? WHERE id = ?",
    );
    match sqlx::query(&sql)
        .bind(&new_hash)
        .bind(user.id)
        .execute(&installed.pool)
        .await
    {
        Ok(_) => StatusCode::NO_CONTENT.into_response(),
        Err(e) => err(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()),
    }
}

pub fn routes() -> Router<AppState> {
    Router::new()
        .route("/profile", get(get_profile).put(update_profile))
        .route("/profile/password", post(change_password))
}
