use axum::{
    Extension, Json, Router,
    extract::{Path, Query, State},
    http::StatusCode,
    response::{IntoResponse, Response},
    routing::{delete, get, post},
};
use serde::{Deserialize, Serialize};

use crate::{
    AppState, CurrentUser, InstalledState,
    db::{self, DbKind},
};

pub const MAX_PLAZA_IMAGES_PER_USER: i64 = 200;
pub const MAX_PROMPT_LEN: usize = 4000;
pub const MAX_COMMENT_LEN: usize = 1000;

#[derive(Serialize, sqlx::FromRow)]
pub struct PlazaImage {
    pub id: i64,
    pub filename: String,
    pub prompt: String,
    pub revised_prompt: Option<String>,
    pub clone_count: i64,
    pub like_count: i64,
    pub comment_count: i64,
    pub liked_by_me: i64,
    pub created_at: String,
    pub author_username: String,
    pub author_avatar_url: Option<String>,
}

#[derive(Serialize, sqlx::FromRow)]
pub struct MyPlazaImage {
    pub id: i64,
    pub filename: String,
    pub prompt: String,
    pub revised_prompt: Option<String>,
    pub clone_count: i64,
    pub like_count: i64,
    pub comment_count: i64,
    pub created_at: String,
}

#[derive(Serialize, sqlx::FromRow)]
pub struct PlazaComment {
    pub id: i64,
    pub image_id: i64,
    pub user_id: i64,
    pub content: String,
    pub created_at: String,
    pub author_username: String,
    pub author_avatar_url: Option<String>,
}

#[derive(Deserialize)]
pub struct PublishImage {
    pub filename: String,
    pub prompt: String,
    pub revised_prompt: Option<String>,
}

#[derive(Deserialize)]
pub struct PublicQuery {
    pub search: Option<String>,
    pub page: Option<i64>,
    pub sort: Option<String>,
}

#[derive(Deserialize)]
pub struct NewComment {
    pub content: String,
}

fn err(status: StatusCode, msg: impl Into<String>) -> Response {
    (status, msg.into()).into_response()
}

fn validate_filename(name: &str) -> Result<String, Response> {
    let trimmed = name.trim();
    if trimmed.is_empty() {
        return Err(err(StatusCode::BAD_REQUEST, "filename is empty"));
    }
    if trimmed.contains("..") || trimmed.contains('/') || trimmed.contains('\\') {
        return Err(err(StatusCode::BAD_REQUEST, "invalid filename"));
    }
    if trimmed.len() > 128 {
        return Err(err(StatusCode::BAD_REQUEST, "filename too long"));
    }
    let ok = trimmed
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || c == '.' || c == '_' || c == '-');
    if !ok {
        return Err(err(StatusCode::BAD_REQUEST, "filename has invalid chars"));
    }
    Ok(trimmed.to_string())
}

fn validate_prompt(s: &str) -> Result<String, Response> {
    let trimmed: String = s.chars().filter(|c| !c.is_control() || *c == '\n').collect();
    let trimmed = trimmed.trim().to_string();
    if trimmed.is_empty() {
        return Err(err(StatusCode::BAD_REQUEST, "prompt is empty"));
    }
    if trimmed.len() > MAX_PROMPT_LEN {
        return Err(err(StatusCode::BAD_REQUEST, "prompt too long"));
    }
    Ok(trimmed)
}

fn validate_comment(s: &str) -> Result<String, Response> {
    let trimmed: String = s.chars().filter(|c| !c.is_control() || *c == '\n').collect();
    let trimmed = trimmed.trim().to_string();
    if trimmed.is_empty() {
        return Err(err(StatusCode::BAD_REQUEST, "comment is empty"));
    }
    if trimmed.len() > MAX_COMMENT_LEN {
        return Err(err(StatusCode::BAD_REQUEST, "comment too long"));
    }
    Ok(trimmed)
}

async fn list_public(
    Extension(installed): Extension<InstalledState>,
    Extension(user): Extension<CurrentUser>,
    Query(q): Query<PublicQuery>,
) -> Response {
    let page = q.page.unwrap_or(1).max(1);
    let per_page: i64 = 24;
    let offset = (page - 1) * per_page;
    let search = q
        .search
        .as_deref()
        .map(|s| s.trim())
        .filter(|s| !s.is_empty());
    let order_by = match q.sort.as_deref() {
        Some("new") => "p.created_at DESC, p.id DESC",
        Some("liked") => "p.like_count DESC, p.created_at DESC, p.id DESC",
        _ => "p.clone_count DESC, p.created_at DESC, p.id DESC",
    };

    let base = "SELECT p.id, p.filename, p.prompt, p.revised_prompt,
                       p.clone_count, p.like_count, p.comment_count,
                       CASE WHEN l.user_id IS NULL THEN 0 ELSE 1 END AS liked_by_me,
                       p.created_at,
                       u.username AS author_username,
                       u.avatar_url AS author_avatar_url
                FROM plaza_images p
                JOIN users u ON u.id = p.user_id
                LEFT JOIN plaza_image_likes l
                  ON l.image_id = p.id AND l.user_id = ?";

    let rows: Result<Vec<PlazaImage>, _> = if let Some(s) = search {
        let pattern = format!("%{s}%");
        let sql = db::q(
            installed.kind,
            &format!(
                "{base}
                 WHERE p.prompt LIKE ? OR p.revised_prompt LIKE ?
                 ORDER BY {order_by}
                 LIMIT ? OFFSET ?"
            ),
        );
        sqlx::query_as(&sql)
            .bind(user.id)
            .bind(&pattern)
            .bind(&pattern)
            .bind(per_page)
            .bind(offset)
            .fetch_all(&installed.pool)
            .await
    } else {
        let sql = db::q(
            installed.kind,
            &format!(
                "{base}
                 ORDER BY {order_by}
                 LIMIT ? OFFSET ?"
            ),
        );
        sqlx::query_as(&sql)
            .bind(user.id)
            .bind(per_page)
            .bind(offset)
            .fetch_all(&installed.pool)
            .await
    };
    match rows {
        Ok(r) => Json(r).into_response(),
        Err(e) => err(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()),
    }
}

async fn list_mine(
    Extension(installed): Extension<InstalledState>,
    Extension(user): Extension<CurrentUser>,
) -> Response {
    let sql = db::q(
        installed.kind,
        "SELECT id, filename, prompt, revised_prompt,
                clone_count, like_count, comment_count, created_at
         FROM plaza_images
         WHERE user_id = ?
         ORDER BY created_at DESC, id DESC",
    );
    let rows: Result<Vec<MyPlazaImage>, _> = sqlx::query_as(&sql)
        .bind(user.id)
        .fetch_all(&installed.pool)
        .await;
    match rows {
        Ok(r) => Json(r).into_response(),
        Err(e) => err(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()),
    }
}

async fn publish_image(
    State(state): State<AppState>,
    Extension(installed): Extension<InstalledState>,
    Extension(user): Extension<CurrentUser>,
    Json(body): Json<PublishImage>,
) -> Response {
    let filename = match validate_filename(&body.filename) {
        Ok(n) => n,
        Err(r) => return r,
    };
    let prompt = match validate_prompt(&body.prompt) {
        Ok(p) => p,
        Err(r) => return r,
    };
    let revised = body
        .revised_prompt
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty() && s.len() <= MAX_PROMPT_LEN);

    let disk_path = state.data_dir.join("images").join(&filename);
    match tokio::fs::metadata(&disk_path).await {
        Ok(m) if m.is_file() => {}
        _ => return err(StatusCode::NOT_FOUND, "image file not found on server"),
    }

    let (count_sql_str,): (i64,) = match sqlx::query_as(&db::q(
        installed.kind,
        "SELECT COUNT(*) FROM plaza_images WHERE user_id = ?",
    ))
    .bind(user.id)
    .fetch_one(&installed.pool)
    .await
    {
        Ok(r) => r,
        Err(e) => return err(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()),
    };
    if count_sql_str >= MAX_PLAZA_IMAGES_PER_USER {
        return err(
            StatusCode::BAD_REQUEST,
            format!("maximum {MAX_PLAZA_IMAGES_PER_USER} published images reached"),
        );
    }

    let exists_sql = db::q(
        installed.kind,
        "SELECT id FROM plaza_images WHERE filename = ?",
    );
    let existing: Option<(i64,)> = sqlx::query_as(&exists_sql)
        .bind(&filename)
        .fetch_optional(&installed.pool)
        .await
        .unwrap_or(None);
    if existing.is_some() {
        return err(StatusCode::CONFLICT, "image already published");
    }

    let insert = db::q(
        installed.kind,
        "INSERT INTO plaza_images (user_id, filename, prompt, revised_prompt)
         VALUES (?, ?, ?, ?)",
    );
    let id = match installed.kind {
        db::DbKind::Sqlite | db::DbKind::Postgres => {
            let row: Result<(i64,), _> = sqlx::query_as(&format!("{insert} RETURNING id"))
                .bind(user.id)
                .bind(&filename)
                .bind(&prompt)
                .bind(&revised)
                .fetch_one(&installed.pool)
                .await;
            match row {
                Ok((v,)) => v,
                Err(e) => return err(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()),
            }
        }
        db::DbKind::Mysql => {
            let mut tx = match installed.pool.begin().await {
                Ok(t) => t,
                Err(e) => return err(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()),
            };
            if let Err(e) = sqlx::query(&insert)
                .bind(user.id)
                .bind(&filename)
                .bind(&prompt)
                .bind(&revised)
                .execute(&mut *tx)
                .await
            {
                return err(StatusCode::INTERNAL_SERVER_ERROR, e.to_string());
            }
            let row: Result<(i64,), _> = sqlx::query_as("SELECT LAST_INSERT_ID()")
                .fetch_one(&mut *tx)
                .await;
            let id = match row {
                Ok((v,)) => v,
                Err(e) => return err(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()),
            };
            if let Err(e) = tx.commit().await {
                return err(StatusCode::INTERNAL_SERVER_ERROR, e.to_string());
            }
            id
        }
    };

    let sel = db::q(
        installed.kind,
        "SELECT id, filename, prompt, revised_prompt,
                clone_count, like_count, comment_count, created_at
         FROM plaza_images WHERE id = ?",
    );
    let row: Result<MyPlazaImage, _> = sqlx::query_as(&sel)
        .bind(id)
        .fetch_one(&installed.pool)
        .await;
    match row {
        Ok(r) => Json(r).into_response(),
        Err(e) => err(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()),
    }
}

async fn delete_image(
    Extension(installed): Extension<InstalledState>,
    Extension(user): Extension<CurrentUser>,
    Path(id): Path<i64>,
) -> Response {
    let sql = db::q(
        installed.kind,
        "DELETE FROM plaza_images WHERE id = ? AND user_id = ?",
    );
    let r = sqlx::query(&sql)
        .bind(id)
        .bind(user.id)
        .execute(&installed.pool)
        .await;
    match r {
        Ok(out) if out.rows_affected() > 0 => StatusCode::NO_CONTENT.into_response(),
        Ok(_) => err(StatusCode::NOT_FOUND, "plaza image not found"),
        Err(e) => err(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()),
    }
}

async fn bump_clone(
    Extension(installed): Extension<InstalledState>,
    Extension(user): Extension<CurrentUser>,
    Path(id): Path<i64>,
) -> Response {
    let sel = db::q(
        installed.kind,
        "SELECT user_id FROM plaza_images WHERE id = ?",
    );
    let row: Option<(i64,)> = match sqlx::query_as(&sel)
        .bind(id)
        .fetch_optional(&installed.pool)
        .await
    {
        Ok(r) => r,
        Err(e) => return err(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()),
    };
    let Some((author_id,)) = row else {
        return err(StatusCode::NOT_FOUND, "plaza image not found");
    };
    if author_id != user.id {
        let bump = db::q(
            installed.kind,
            "UPDATE plaza_images SET clone_count = clone_count + 1 WHERE id = ?",
        );
        let _ = sqlx::query(&bump).bind(id).execute(&installed.pool).await;
    }
    StatusCode::NO_CONTENT.into_response()
}

async fn image_exists(installed: &InstalledState, id: i64) -> Result<bool, Response> {
    let sel = db::q(installed.kind, "SELECT id FROM plaza_images WHERE id = ?");
    match sqlx::query_as::<_, (i64,)>(&sel)
        .bind(id)
        .fetch_optional(&installed.pool)
        .await
    {
        Ok(Some(_)) => Ok(true),
        Ok(None) => Ok(false),
        Err(e) => Err(err(StatusCode::INTERNAL_SERVER_ERROR, e.to_string())),
    }
}

async fn like_image(
    Extension(installed): Extension<InstalledState>,
    Extension(user): Extension<CurrentUser>,
    Path(id): Path<i64>,
) -> Response {
    match image_exists(&installed, id).await {
        Ok(true) => {}
        Ok(false) => return err(StatusCode::NOT_FOUND, "plaza image not found"),
        Err(r) => return r,
    }

    let insert_raw = match installed.kind {
        DbKind::Sqlite => {
            "INSERT OR IGNORE INTO plaza_image_likes (image_id, user_id) VALUES (?, ?)"
        }
        DbKind::Mysql => {
            "INSERT IGNORE INTO plaza_image_likes (image_id, user_id) VALUES (?, ?)"
        }
        DbKind::Postgres => {
            "INSERT INTO plaza_image_likes (image_id, user_id) VALUES (?, ?) ON CONFLICT DO NOTHING"
        }
    };
    let insert_sql = db::q(installed.kind, insert_raw);
    let inserted = match sqlx::query(&insert_sql)
        .bind(id)
        .bind(user.id)
        .execute(&installed.pool)
        .await
    {
        Ok(r) => r.rows_affected() > 0,
        Err(e) => return err(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()),
    };
    if inserted {
        let bump = db::q(
            installed.kind,
            "UPDATE plaza_images SET like_count = like_count + 1 WHERE id = ?",
        );
        if let Err(e) = sqlx::query(&bump).bind(id).execute(&installed.pool).await {
            return err(StatusCode::INTERNAL_SERVER_ERROR, e.to_string());
        }
    }

    let sel = db::q(
        installed.kind,
        "SELECT like_count FROM plaza_images WHERE id = ?",
    );
    let count: i64 = match sqlx::query_as::<_, (i64,)>(&sel)
        .bind(id)
        .fetch_one(&installed.pool)
        .await
    {
        Ok((n,)) => n,
        Err(e) => return err(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()),
    };
    Json(serde_json::json!({ "liked": true, "like_count": count })).into_response()
}

async fn unlike_image(
    Extension(installed): Extension<InstalledState>,
    Extension(user): Extension<CurrentUser>,
    Path(id): Path<i64>,
) -> Response {
    let del = db::q(
        installed.kind,
        "DELETE FROM plaza_image_likes WHERE image_id = ? AND user_id = ?",
    );
    let removed = match sqlx::query(&del)
        .bind(id)
        .bind(user.id)
        .execute(&installed.pool)
        .await
    {
        Ok(r) => r.rows_affected() > 0,
        Err(e) => return err(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()),
    };
    if removed {
        let bump = db::q(
            installed.kind,
            "UPDATE plaza_images SET like_count = CASE WHEN like_count > 0 THEN like_count - 1 ELSE 0 END WHERE id = ?",
        );
        if let Err(e) = sqlx::query(&bump).bind(id).execute(&installed.pool).await {
            return err(StatusCode::INTERNAL_SERVER_ERROR, e.to_string());
        }
    }
    let sel = db::q(
        installed.kind,
        "SELECT like_count FROM plaza_images WHERE id = ?",
    );
    let count: i64 = match sqlx::query_as::<_, (i64,)>(&sel)
        .bind(id)
        .fetch_one(&installed.pool)
        .await
    {
        Ok((n,)) => n,
        Err(_) => 0,
    };
    Json(serde_json::json!({ "liked": false, "like_count": count })).into_response()
}

async fn list_comments(
    Extension(installed): Extension<InstalledState>,
    Extension(_user): Extension<CurrentUser>,
    Path(id): Path<i64>,
) -> Response {
    let sql = db::q(
        installed.kind,
        "SELECT c.id, c.image_id, c.user_id, c.content, c.created_at,
                u.username AS author_username,
                u.avatar_url AS author_avatar_url
         FROM plaza_image_comments c
         JOIN users u ON u.id = c.user_id
         WHERE c.image_id = ?
         ORDER BY c.created_at ASC, c.id ASC
         LIMIT 500",
    );
    let rows: Result<Vec<PlazaComment>, _> = sqlx::query_as(&sql)
        .bind(id)
        .fetch_all(&installed.pool)
        .await;
    match rows {
        Ok(r) => Json(r).into_response(),
        Err(e) => err(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()),
    }
}

async fn add_comment(
    Extension(installed): Extension<InstalledState>,
    Extension(user): Extension<CurrentUser>,
    Path(id): Path<i64>,
    Json(body): Json<NewComment>,
) -> Response {
    let content = match validate_comment(&body.content) {
        Ok(s) => s,
        Err(r) => return r,
    };
    match image_exists(&installed, id).await {
        Ok(true) => {}
        Ok(false) => return err(StatusCode::NOT_FOUND, "plaza image not found"),
        Err(r) => return r,
    }

    let insert = db::q(
        installed.kind,
        "INSERT INTO plaza_image_comments (image_id, user_id, content)
         VALUES (?, ?, ?)",
    );
    let new_id = match installed.kind {
        DbKind::Sqlite | DbKind::Postgres => {
            let row: Result<(i64,), _> = sqlx::query_as(&format!("{insert} RETURNING id"))
                .bind(id)
                .bind(user.id)
                .bind(&content)
                .fetch_one(&installed.pool)
                .await;
            match row {
                Ok((v,)) => v,
                Err(e) => return err(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()),
            }
        }
        DbKind::Mysql => {
            let mut tx = match installed.pool.begin().await {
                Ok(t) => t,
                Err(e) => return err(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()),
            };
            if let Err(e) = sqlx::query(&insert)
                .bind(id)
                .bind(user.id)
                .bind(&content)
                .execute(&mut *tx)
                .await
            {
                return err(StatusCode::INTERNAL_SERVER_ERROR, e.to_string());
            }
            let row: Result<(i64,), _> = sqlx::query_as("SELECT LAST_INSERT_ID()")
                .fetch_one(&mut *tx)
                .await;
            let v = match row {
                Ok((v,)) => v,
                Err(e) => return err(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()),
            };
            if let Err(e) = tx.commit().await {
                return err(StatusCode::INTERNAL_SERVER_ERROR, e.to_string());
            }
            v
        }
    };

    let bump = db::q(
        installed.kind,
        "UPDATE plaza_images SET comment_count = comment_count + 1 WHERE id = ?",
    );
    let _ = sqlx::query(&bump).bind(id).execute(&installed.pool).await;

    let sel = db::q(
        installed.kind,
        "SELECT c.id, c.image_id, c.user_id, c.content, c.created_at,
                u.username AS author_username,
                u.avatar_url AS author_avatar_url
         FROM plaza_image_comments c
         JOIN users u ON u.id = c.user_id
         WHERE c.id = ?",
    );
    let row: Result<PlazaComment, _> = sqlx::query_as(&sel)
        .bind(new_id)
        .fetch_one(&installed.pool)
        .await;
    match row {
        Ok(r) => Json(r).into_response(),
        Err(e) => err(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()),
    }
}

async fn delete_comment(
    Extension(installed): Extension<InstalledState>,
    Extension(user): Extension<CurrentUser>,
    Path(id): Path<i64>,
) -> Response {
    let sel = db::q(
        installed.kind,
        "SELECT c.image_id, c.user_id, p.user_id
         FROM plaza_image_comments c
         JOIN plaza_images p ON p.id = c.image_id
         WHERE c.id = ?",
    );
    let row: Option<(i64, i64, i64)> = match sqlx::query_as(&sel)
        .bind(id)
        .fetch_optional(&installed.pool)
        .await
    {
        Ok(r) => r,
        Err(e) => return err(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()),
    };
    let Some((image_id, author_id, image_owner_id)) = row else {
        return err(StatusCode::NOT_FOUND, "comment not found");
    };
    if author_id != user.id && image_owner_id != user.id {
        return err(StatusCode::FORBIDDEN, "not allowed");
    }

    let del = db::q(
        installed.kind,
        "DELETE FROM plaza_image_comments WHERE id = ?",
    );
    let r = sqlx::query(&del).bind(id).execute(&installed.pool).await;
    match r {
        Ok(out) if out.rows_affected() > 0 => {
            let bump = db::q(
                installed.kind,
                "UPDATE plaza_images SET comment_count = CASE WHEN comment_count > 0 THEN comment_count - 1 ELSE 0 END WHERE id = ?",
            );
            let _ = sqlx::query(&bump)
                .bind(image_id)
                .execute(&installed.pool)
                .await;
            StatusCode::NO_CONTENT.into_response()
        }
        Ok(_) => err(StatusCode::NOT_FOUND, "comment not found"),
        Err(e) => err(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()),
    }
}

pub fn routes() -> Router<AppState> {
    Router::new()
        .route("/plaza/images", get(list_public).post(publish_image))
        .route("/plaza/images/mine", get(list_mine))
        .route("/plaza/images/{id}", delete(delete_image))
        .route("/plaza/images/{id}/clone", post(bump_clone))
        .route("/plaza/images/{id}/like", post(like_image).delete(unlike_image))
        .route(
            "/plaza/images/{id}/comments",
            get(list_comments).post(add_comment),
        )
        .route("/plaza/comments/{id}", delete(delete_comment))
}
