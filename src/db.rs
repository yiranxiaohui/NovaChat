use std::str::FromStr;

use sqlx::any::{AnyConnectOptions, AnyPoolOptions};
use sqlx::{AnyPool, Executor};

pub type Pool = AnyPool;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum DbKind {
    Sqlite,
    Mysql,
    Postgres,
}

impl DbKind {
    pub fn from_url(url: &str) -> Option<Self> {
        let u = url.trim().to_ascii_lowercase();
        if u.starts_with("sqlite:") {
            Some(Self::Sqlite)
        } else if u.starts_with("mysql:") || u.starts_with("mariadb:") {
            Some(Self::Mysql)
        } else if u.starts_with("postgres:") || u.starts_with("postgresql:") {
            Some(Self::Postgres)
        } else {
            None
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Self::Sqlite => "sqlite",
            Self::Mysql => "mysql",
            Self::Postgres => "postgres",
        }
    }
}

pub fn install_drivers() {
    sqlx::any::install_default_drivers();
}

pub async fn connect(url: &str) -> Result<Pool, sqlx::Error> {
    let normalized = normalize_url(url);
    let options = AnyConnectOptions::from_str(&normalized)?;
    AnyPoolOptions::new()
        .max_connections(5)
        .connect_with(options)
        .await
}

fn normalize_url(url: &str) -> String {
    // SQLite: ensure create-if-missing via URL query (`mode=rwc`).
    if url.starts_with("sqlite:") && !url.contains("mode=") {
        return if url.contains('?') {
            format!("{url}&mode=rwc")
        } else {
            format!("{url}?mode=rwc")
        };
    }
    url.to_string()
}

// ---------------------------------------------------------------------------
// migrations
// ---------------------------------------------------------------------------

static SQLITE_MIGRATIONS: &[(i32, &str)] = &[
    (1, include_str!("../migrations/sqlite/0001_init.sql")),
    (2, include_str!("../migrations/sqlite/0002_user_settings.sql")),
    (3, include_str!("../migrations/sqlite/0003_image_settings.sql")),
    (4, include_str!("../migrations/sqlite/0004_image_protocol.sql")),
    (5, include_str!("../migrations/sqlite/0005_prompt_clone_count.sql")),
    (6, include_str!("../migrations/sqlite/0006_skills.sql")),
    (7, include_str!("../migrations/sqlite/0007_skills_public.sql")),
    (8, include_str!("../migrations/sqlite/0008_user_profile.sql")),
    (9, include_str!("../migrations/sqlite/0009_plaza_images.sql")),
    (10, include_str!("../migrations/sqlite/0010_admin.sql")),
    (11, include_str!("../migrations/sqlite/0011_credits.sql")),
    (12, include_str!("../migrations/sqlite/0012_plaza_social.sql")),
    (13, include_str!("../migrations/sqlite/0013_invites.sql")),
    (14, include_str!("../migrations/sqlite/0014_email.sql")),
    (15, include_str!("../migrations/sqlite/0015_payments.sql")),
];
static MYSQL_MIGRATIONS: &[(i32, &str)] = &[
    (1, include_str!("../migrations/mysql/0001_init.sql")),
    (2, include_str!("../migrations/mysql/0002_user_settings.sql")),
    (3, include_str!("../migrations/mysql/0003_image_settings.sql")),
    (4, include_str!("../migrations/mysql/0004_image_protocol.sql")),
    (5, include_str!("../migrations/mysql/0005_prompt_clone_count.sql")),
    (6, include_str!("../migrations/mysql/0006_skills.sql")),
    (7, include_str!("../migrations/mysql/0007_skills_public.sql")),
    (8, include_str!("../migrations/mysql/0008_user_profile.sql")),
    (9, include_str!("../migrations/mysql/0009_plaza_images.sql")),
    (10, include_str!("../migrations/mysql/0010_admin.sql")),
    (11, include_str!("../migrations/mysql/0011_credits.sql")),
    (12, include_str!("../migrations/mysql/0012_plaza_social.sql")),
    (13, include_str!("../migrations/mysql/0013_invites.sql")),
    (14, include_str!("../migrations/mysql/0014_email.sql")),
    (15, include_str!("../migrations/mysql/0015_payments.sql")),
];
static POSTGRES_MIGRATIONS: &[(i32, &str)] = &[
    (1, include_str!("../migrations/postgres/0001_init.sql")),
    (2, include_str!("../migrations/postgres/0002_user_settings.sql")),
    (3, include_str!("../migrations/postgres/0003_image_settings.sql")),
    (4, include_str!("../migrations/postgres/0004_image_protocol.sql")),
    (5, include_str!("../migrations/postgres/0005_prompt_clone_count.sql")),
    (6, include_str!("../migrations/postgres/0006_skills.sql")),
    (7, include_str!("../migrations/postgres/0007_skills_public.sql")),
    (8, include_str!("../migrations/postgres/0008_user_profile.sql")),
    (9, include_str!("../migrations/postgres/0009_plaza_images.sql")),
    (10, include_str!("../migrations/postgres/0010_admin.sql")),
    (11, include_str!("../migrations/postgres/0011_credits.sql")),
    (12, include_str!("../migrations/postgres/0012_plaza_social.sql")),
    (13, include_str!("../migrations/postgres/0013_invites.sql")),
    (14, include_str!("../migrations/postgres/0014_email.sql")),
    (15, include_str!("../migrations/postgres/0015_payments.sql")),
];

fn migrations_for(kind: DbKind) -> &'static [(i32, &'static str)] {
    match kind {
        DbKind::Sqlite => SQLITE_MIGRATIONS,
        DbKind::Mysql => MYSQL_MIGRATIONS,
        DbKind::Postgres => POSTGRES_MIGRATIONS,
    }
}

pub async fn migrate(pool: &Pool, kind: DbKind) -> Result<(), sqlx::Error> {
    let create_table = match kind {
        DbKind::Sqlite => {
            "CREATE TABLE IF NOT EXISTS _migrations (
                id INTEGER PRIMARY KEY,
                applied_at TEXT NOT NULL DEFAULT (datetime('now'))
            )"
        }
        DbKind::Mysql => {
            "CREATE TABLE IF NOT EXISTS _migrations (
                id INT NOT NULL PRIMARY KEY,
                applied_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4"
        }
        DbKind::Postgres => {
            "CREATE TABLE IF NOT EXISTS _migrations (
                id INT PRIMARY KEY,
                applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
            )"
        }
    };
    pool.execute(create_table).await?;

    let rows: Vec<(i32,)> = sqlx::query_as("SELECT id FROM _migrations")
        .fetch_all(pool)
        .await?;
    let applied: std::collections::HashSet<i32> = rows.into_iter().map(|(x,)| x).collect();

    for (id, body) in migrations_for(kind) {
        if applied.contains(id) {
            continue;
        }
        for stmt in split_sql(body) {
            let s = stmt.trim();
            if s.is_empty() {
                continue;
            }
            pool.execute(s).await?;
        }
        sqlx::query("INSERT INTO _migrations (id) VALUES (?)")
            .bind(id)
            .execute(pool)
            .await?;
    }
    Ok(())
}

/// Splits a SQL blob into individual statements separated by `;` outside strings/comments.
/// Good enough for the migration files we ship (no dollar-quoting, no stored procs).
fn split_sql(src: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut buf = String::new();
    let mut chars = src.chars().peekable();
    let mut in_single = false;
    let mut in_double = false;
    while let Some(c) = chars.next() {
        match c {
            '-' if !in_single && !in_double && chars.peek() == Some(&'-') => {
                // line comment
                while let Some(cc) = chars.next() {
                    if cc == '\n' {
                        buf.push('\n');
                        break;
                    }
                }
            }
            '\'' if !in_double => {
                in_single = !in_single;
                buf.push(c);
            }
            '"' if !in_single => {
                in_double = !in_double;
                buf.push(c);
            }
            ';' if !in_single && !in_double => {
                out.push(std::mem::take(&mut buf));
            }
            _ => buf.push(c),
        }
    }
    if !buf.trim().is_empty() {
        out.push(buf);
    }
    out
}

// ---------------------------------------------------------------------------
// dialect-aware SQL helpers
// ---------------------------------------------------------------------------

/// `now()`-style default timestamp expression, for use in UPDATE statements.
pub fn now_expr(kind: DbKind) -> &'static str {
    match kind {
        DbKind::Sqlite => "datetime('now')",
        DbKind::Mysql => "CURRENT_TIMESTAMP(3)",
        DbKind::Postgres => "NOW()",
    }
}

/// Returns a fragment that appends "RETURNING id" on Postgres or empty for others.
pub fn returning_id(kind: DbKind) -> &'static str {
    match kind {
        DbKind::Postgres => " RETURNING id",
        _ => "",
    }
}

/// Rewrites `?` placeholders to `$1, $2, …` for Postgres.
pub fn q(kind: DbKind, sql: &str) -> String {
    match kind {
        DbKind::Postgres => {
            let mut out = String::with_capacity(sql.len() + 8);
            let mut i = 0usize;
            let mut in_single = false;
            let mut in_double = false;
            for c in sql.chars() {
                match c {
                    '\'' if !in_double => in_single = !in_single,
                    '"' if !in_single => in_double = !in_double,
                    '?' if !in_single && !in_double => {
                        i += 1;
                        out.push('$');
                        out.push_str(&i.to_string());
                        continue;
                    }
                    _ => {}
                }
                out.push(c);
            }
            out
        }
        _ => sql.to_string(),
    }
}

/// Case-insensitive equality fragment for usernames: `LOWER(col) = LOWER(?)` on PG/MySQL,
/// direct `col = ?` on SQLite (handled by COLLATE NOCASE on the column).
pub fn ci_eq(kind: DbKind, col: &str) -> String {
    match kind {
        DbKind::Sqlite => format!("{col} = ?"),
        DbKind::Mysql | DbKind::Postgres => format!("LOWER({col}) = LOWER(?)"),
    }
}

/// Select a nullable bool-valued column as an optional integer across backends.
pub fn opt_bool_as_int(kind: DbKind, col: &str) -> String {
    match kind {
        DbKind::Postgres => format!(
            "CASE WHEN {col} IS NULL THEN NULL WHEN {col} THEN 1 ELSE 0 END AS {}",
            col_alias(col)
        ),
        _ => col.to_string(),
    }
}

/// Select a bool-valued column as an integer so Rust `i64` decoding works across backends.
/// SQLite/MySQL already store it as INTEGER/TINYINT; Postgres needs a cast from BOOLEAN.
pub fn bool_as_int(kind: DbKind, col: &str) -> String {
    match kind {
        DbKind::Postgres => format!("CASE WHEN {col} THEN 1 ELSE 0 END AS {}", col_alias(col)),
        _ => col.to_string(),
    }
}

fn col_alias(col: &str) -> String {
    // given "p.is_public" return "is_public"
    col.rsplit('.').next().unwrap_or(col).to_string()
}

/// Literal "true" value for the given dialect, usable inside WHERE clauses against a bool column.
pub fn bool_true(kind: DbKind) -> &'static str {
    match kind {
        DbKind::Postgres => "TRUE",
        _ => "1",
    }
}
