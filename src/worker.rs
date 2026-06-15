//! 后端工蜂模块：WS 接入、在线注册表、REST、agent 循环。
use crate::AppState;
use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::extract::State;
use axum::response::Response;
use axum::routing::get;
use axum::Router;
use futures_util::{SinkExt, StreamExt};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
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

/// WS 接入端点 —— 公开（鉴权靠配对 token），单独挂载，不经 require_auth。
pub fn public_routes() -> Router<AppState> {
    Router::new().route("/worker/connect", get(ws_connect))
}

fn hash_token(token: &str) -> String {
    let mut h = Sha256::new();
    h.update(token.as_bytes());
    hex::encode(h.finalize())
}

async fn ws_connect(State(state): State<AppState>, ws: WebSocketUpgrade) -> Response {
    ws.on_upgrade(move |socket| handle_socket(state, socket))
}

async fn handle_socket(state: AppState, socket: WebSocket) {
    let (mut sink, mut stream) = socket.split();

    // 第一帧必须是 hello
    let first = match stream.next().await {
        Some(Ok(Message::Text(t))) => t.to_string(),
        _ => return,
    };
    let hello: ToServer = match serde_json::from_str(&first) {
        Ok(m) => m,
        Err(_) => return,
    };
    let (token, name) = match hello {
        ToServer::Hello { token, name } => (token, name),
        _ => return,
    };

    let installed = {
        let g = state.installed.read().await;
        match g.clone() {
            Some(i) => i,
            None => return,
        }
    };
    let th = hash_token(&token);
    let row: Option<(i64, i64)> = sqlx::query_as(&crate::db::q(
        installed.kind,
        "SELECT id, user_id FROM workers WHERE token_hash = ?",
    ))
    .bind(&th)
    .fetch_optional(&installed.pool)
    .await
    .ok()
    .flatten();
    let (worker_id, user_id) = match row {
        Some(v) => v,
        None => {
            let err =
                serde_json::to_string(&ToWorker::Error { message: "配对码无效".into() }).unwrap();
            let _ = sink.send(Message::Text(err.into())).await;
            return;
        }
    };

    // 更新名字 + last_seen
    let _ = sqlx::query(&crate::db::q(
        installed.kind,
        &format!(
            "UPDATE workers SET name = ?, last_seen_at = {} WHERE id = ?",
            crate::db::now_expr(installed.kind)
        ),
    ))
    .bind(&name)
    .bind(worker_id)
    .execute(&installed.pool)
    .await;

    // 注册
    let (tx, mut rx) = mpsc::channel::<ToWorker>(64);
    let pending: Arc<RwLock<HashMap<String, oneshot::Sender<ToolOutcome>>>> =
        Arc::new(RwLock::new(HashMap::new()));
    let handle = Arc::new(WorkerHandle {
        user_id,
        tx: tx.clone(),
        pending: pending.clone(),
    });
    state.workers.insert(worker_id, handle).await;

    // 确认
    let ok = serde_json::to_string(&ToWorker::HelloOk { worker_id }).unwrap();
    if sink.send(Message::Text(ok.into())).await.is_err() {
        state.workers.remove(worker_id).await;
        return;
    }

    // 出站任务：把 Exec 推给工蜂
    let mut send_task = tokio::spawn(async move {
        while let Some(msg) = rx.recv().await {
            let txt = serde_json::to_string(&msg).unwrap();
            if sink.send(Message::Text(txt.into())).await.is_err() {
                break;
            }
        }
    });

    // 入站循环：心跳 / tool_result
    let pool = installed.pool.clone();
    let kind = installed.kind;
    let mut recv_task = tokio::spawn(async move {
        while let Some(Ok(frame)) = stream.next().await {
            match frame {
                Message::Text(t) => {
                    if let Ok(msg) = serde_json::from_str::<ToServer>(&t) {
                        match msg {
                            ToServer::Heartbeat => {
                                let _ = sqlx::query(&crate::db::q(
                                    kind,
                                    &format!(
                                        "UPDATE workers SET last_seen_at = {} WHERE id = ?",
                                        crate::db::now_expr(kind)
                                    ),
                                ))
                                .bind(worker_id)
                                .execute(&pool)
                                .await;
                            }
                            ToServer::ToolResult { call_id, ok, output, .. } => {
                                if let Some(slot) = pending.write().await.remove(&call_id) {
                                    let _ = slot.send(ToolOutcome { ok, output });
                                }
                            }
                            ToServer::Hello { .. } => {}
                        }
                    }
                }
                Message::Close(_) => break,
                _ => {}
            }
        }
    });

    // 任一任务结束即下线
    tokio::select! {
        _ = &mut send_task => {}
        _ = &mut recv_task => {}
    }
    send_task.abort();
    recv_task.abort();
    state.workers.remove(worker_id).await;
}
