//! Small in-memory per-IP rate limiter for public endpoints.
//!
//! Hand-rolled fixed-window counter, in-memory. Goal is brute-force
//! resistance and basic anonymous-proxy abuse control — not DDoS-grade
//! protection. A background task periodically
//! prunes stale buckets so the map stays bounded.
//!
//! ## Client IP
//! Reads `X-Forwarded-For` (leftmost) then `X-Real-IP`. If neither is set
//! (direct connection with no proxy in front), falls back to a single
//! shared "unknown" bucket — directly-exposed deployments thus get
//! aggressive limiting, which is the safer default. Behind a TLS-terminating
//! proxy that sets XFF, legitimate clients each get their own bucket.

use std::collections::HashMap;
use std::net::{IpAddr, Ipv4Addr};
use std::time::{Duration, Instant};

use axum::http::HeaderMap;
use tokio::sync::Mutex;

pub struct RateLimiter {
    inner: Mutex<HashMap<IpAddr, Bucket>>,
    max_attempts: usize,
    window: Duration,
}

#[derive(Clone, Copy)]
struct Bucket {
    count: usize,
    window_start: Instant,
}

impl RateLimiter {
    pub fn new(max_attempts: usize, window: Duration) -> Self {
        Self {
            inner: Mutex::new(HashMap::new()),
            max_attempts,
            window,
        }
    }

    /// Records one attempt from `ip` and returns `true` if it is within the
    /// allowed quota, `false` if the IP has exceeded `max_attempts` in
    /// `window` (fixed window, not sliding).
    pub async fn allow(&self, ip: IpAddr) -> bool {
        let now = Instant::now();
        let mut guard = self.inner.lock().await;
        let bucket = guard.entry(ip).or_insert(Bucket {
            count: 0,
            window_start: now,
        });
        if now.duration_since(bucket.window_start) > self.window {
            bucket.count = 0;
            bucket.window_start = now;
        }
        if bucket.count >= self.max_attempts {
            return false;
        }
        bucket.count += 1;
        true
    }

    /// Drop buckets whose window has elapsed twice over. Called from a
    /// background task so the map size stays proportional to active clients.
    pub async fn prune(&self) {
        let cutoff = self.window.saturating_mul(2);
        let now = Instant::now();
        let mut guard = self.inner.lock().await;
        guard.retain(|_, b| now.duration_since(b.window_start) < cutoff);
    }
}

/// Best-effort client IP extraction from the request headers.
pub fn client_ip(headers: &HeaderMap) -> IpAddr {
    if let Some(s) = headers.get("x-forwarded-for").and_then(|v| v.to_str().ok()) {
        if let Some(first) = s.split(',').next() {
            if let Ok(ip) = first.trim().parse() {
                return ip;
            }
        }
    }
    if let Some(s) = headers.get("x-real-ip").and_then(|v| v.to_str().ok()) {
        if let Ok(ip) = s.trim().parse() {
            return ip;
        }
    }
    IpAddr::V4(Ipv4Addr::UNSPECIFIED)
}
