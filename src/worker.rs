//! 后端工蜂模块：WS 接入、在线注册表、REST、agent 循环。
use crate::AppState;
use axum::Router;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::Arc;
use tokio::sync::{mpsc, oneshot, RwLock};

// --- WS 协议（与 worker/src/proto.rs 保持一致）---

#[derive(Debug, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ToServer {
    Hello { token: String, name: String },
    Heartbeat,
    ToolResult { call_id: String, ok: bool, output: String, #[serde(default)] truncated: bool },
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ToWorker {
    HelloOk { worker_id: i64 },
    Error { message: String },
    Exec { call_id: String, tool: String, args: serde_json::Value },
}

/// 一台在线工蜂的句柄：向其 WS 发送 Exec 的通道 + 等待结果的回执表。
pub struct WorkerHandle {
    pub user_id: i64,
    pub tx: mpsc::Sender<ToWorker>,
    /// call_id -> 结果回执 oneshot
    pub pending: Arc<RwLock<HashMap<String, oneshot::Sender<ToolOutcome>>>>,
}

#[derive(Clone, Debug)]
pub struct ToolOutcome {
    pub ok: bool,
    pub output: String,
}

/// 全局在线工蜂表：worker_id -> handle。
#[derive(Clone, Default)]
pub struct WorkerRegistry {
    inner: Arc<RwLock<HashMap<i64, Arc<WorkerHandle>>>>,
}

impl WorkerRegistry {
    pub fn new() -> Self { Self::default() }

    pub async fn insert(&self, worker_id: i64, handle: Arc<WorkerHandle>) {
        self.inner.write().await.insert(worker_id, handle);
    }
    pub async fn remove(&self, worker_id: i64) {
        self.inner.write().await.remove(&worker_id);
    }
    pub async fn get(&self, worker_id: i64) -> Option<Arc<WorkerHandle>> {
        self.inner.read().await.get(&worker_id).cloned()
    }
    pub async fn is_online(&self, worker_id: i64) -> bool {
        self.inner.read().await.contains_key(&worker_id)
    }
}

pub fn routes() -> Router<AppState> {
    Router::new() // REST 路由在后续任务里加
}
