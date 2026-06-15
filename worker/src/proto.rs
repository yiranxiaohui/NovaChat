//! 工蜂 ↔ 后端 WebSocket 消息协议（JSON 文本帧）。
//! 后端 src/worker.rs 里有一份结构等价的定义（不共享 crate，手动保持一致）。
use serde::{Deserialize, Serialize};

/// 工蜂 → 后端
#[derive(Debug, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ToServer {
    Hello { token: String, name: String },
    Heartbeat,
    ToolResult {
        call_id: String,
        ok: bool,
        output: String,
        #[serde(default)]
        truncated: bool,
    },
}

/// 后端 → 工蜂
#[derive(Debug, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ToWorker {
    HelloOk { worker_id: i64 },
    Error { message: String },
    Exec {
        call_id: String,
        tool: String,
        args: serde_json::Value,
    },
}
