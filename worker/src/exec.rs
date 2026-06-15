//! 三工具执行逻辑：shell / read_file / write_file。
//! 每个函数返回 (ok, output)；输出超过 MAX_OUTPUT 截断。
use serde_json::Value;
use tokio::process::Command;

const MAX_OUTPUT: usize = 64 * 1024; // 64KB

/// 执行一个工具调用，返回 (ok, output, truncated)。
pub async fn run(tool: &str, args: &Value) -> (bool, String, bool) {
    let (ok, raw) = match tool {
        "shell" => shell(args).await,
        "read_file" => read_file(args).await,
        "write_file" => write_file(args).await,
        other => (false, format!("未知工具: {other}")),
    };
    let truncated = raw.len() > MAX_OUTPUT;
    let output = if truncated {
        // UTF-8-safe truncation: walk back from MAX_OUTPUT to a char boundary
        let mut end = MAX_OUTPUT;
        while !raw.is_char_boundary(end) {
            end -= 1;
        }
        let mut s = raw[..end].to_string();
        s.push_str("\n…[输出已截断]");
        s
    } else {
        raw
    };
    (ok, output, truncated)
}

async fn shell(args: &Value) -> (bool, String) {
    let cmd = match args.get("command").and_then(|v| v.as_str()) {
        Some(c) => c,
        None => return (false, "shell: 缺少 command 参数".into()),
    };
    // Windows 默认无 `sh`，用 `cmd /C`；其余平台用 `sh -c`。
    // Windows 上先 `chcp 65001` 切到 UTF-8 代码页，否则中文系统按 OEM(GBK)
    // 输出字节，被下方 from_utf8_lossy 当 UTF-8 解会变乱码。
    let mut c = if cfg!(windows) {
        let mut c = Command::new("cmd");
        c.arg("/C").arg(format!("chcp 65001>nul & {cmd}"));
        c
    } else {
        let mut c = Command::new("sh");
        c.arg("-c").arg(cmd);
        c
    };
    if let Some(cwd) = args.get("cwd").and_then(|v| v.as_str()) {
        c.current_dir(cwd);
    }
    match c.output().await {
        Ok(out) => {
            let mut s = String::new();
            s.push_str(&String::from_utf8_lossy(&out.stdout));
            let err = String::from_utf8_lossy(&out.stderr);
            if !err.is_empty() {
                s.push_str("\n[stderr]\n");
                s.push_str(&err);
            }
            let code = out.status.code().unwrap_or(-1);
            s.push_str(&format!("\n[exit code: {code}]"));
            (out.status.success(), s)
        }
        Err(e) => (false, format!("shell 执行失败: {e}")),
    }
}

async fn read_file(args: &Value) -> (bool, String) {
    let path = match args.get("path").and_then(|v| v.as_str()) {
        Some(p) => p,
        None => return (false, "read_file: 缺少 path 参数".into()),
    };
    match tokio::fs::read_to_string(path).await {
        Ok(content) => (true, content),
        Err(e) => (false, format!("读取失败 {path}: {e}")),
    }
}

async fn write_file(args: &Value) -> (bool, String) {
    let path = match args.get("path").and_then(|v| v.as_str()) {
        Some(p) => p,
        None => return (false, "write_file: 缺少 path 参数".into()),
    };
    let content = args.get("content").and_then(|v| v.as_str()).unwrap_or("");
    if let Some(parent) = std::path::Path::new(path).parent() {
        let _ = tokio::fs::create_dir_all(parent).await;
    }
    match tokio::fs::write(path, content).await {
        Ok(_) => (true, format!("已写入 {path}（{} 字节）", content.len())),
        Err(e) => (false, format!("写入失败 {path}: {e}")),
    }
}
