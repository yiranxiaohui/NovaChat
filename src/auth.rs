use argon2::{
    Argon2,
    password_hash::{PasswordHash, PasswordHasher, PasswordVerifier, SaltString, rand_core::OsRng},
};
use chrono::{DateTime, Duration, Utc};
use rand::RngCore;
use sha2::{Digest, Sha256};

use crate::db::{self, DbKind, Pool};

pub const SESSION_COOKIE: &str = "nc_session";
pub const SESSION_TTL_DAYS: i64 = 30;

pub fn hash_password(password: &str) -> Result<String, String> {
    let salt = SaltString::generate(&mut OsRng);
    Argon2::default()
        .hash_password(password.as_bytes(), &salt)
        .map(|h| h.to_string())
        .map_err(|e| e.to_string())
}

pub fn verify_password(password: &str, phc: &str) -> bool {
    let Ok(parsed) = PasswordHash::new(phc) else {
        return false;
    };
    Argon2::default()
        .verify_password(password.as_bytes(), &parsed)
        .is_ok()
}

pub fn generate_token() -> String {
    let mut bytes = [0u8; 32];
    rand::rngs::OsRng.fill_bytes(&mut bytes);
    hex::encode(bytes)
}

pub fn token_hash(token: &str) -> String {
    let mut h = Sha256::new();
    h.update(token.as_bytes());
    hex::encode(h.finalize())
}

pub async fn create_session(
    pool: &Pool,
    kind: DbKind,
    user_id: i64,
) -> Result<(String, DateTime<Utc>), sqlx::Error> {
    let token = generate_token();
    let hash = token_hash(&token);
    let expires = Utc::now() + Duration::days(SESSION_TTL_DAYS);
    let expires_str = expires.to_rfc3339();
    let sql = db::q(
        kind,
        "INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)",
    );
    sqlx::query(&sql)
        .bind(&hash)
        .bind(user_id)
        .bind(&expires_str)
        .execute(pool)
        .await?;
    Ok((token, expires))
}

pub async fn delete_session(pool: &Pool, kind: DbKind, token: &str) -> Result<(), sqlx::Error> {
    let hash = token_hash(token);
    let sql = db::q(kind, "DELETE FROM sessions WHERE token_hash = ?");
    sqlx::query(&sql).bind(&hash).execute(pool).await?;
    Ok(())
}

pub async fn user_for_token(pool: &Pool, kind: DbKind, token: &str) -> Option<(i64, String)> {
    let hash = token_hash(token);
    let sql = db::q(
        kind,
        "SELECT users.id, users.username, sessions.expires_at
         FROM sessions JOIN users ON users.id = sessions.user_id
         WHERE sessions.token_hash = ?",
    );
    let row: Option<(i64, String, String)> = sqlx::query_as(&sql)
        .bind(&hash)
        .fetch_optional(pool)
        .await
        .ok()
        .flatten();

    let (id, username, expires) = row?;
    let expires = DateTime::parse_from_rfc3339(&expires).ok()?.with_timezone(&Utc);
    if expires < Utc::now() {
        return None;
    }
    Some((id, username))
}
