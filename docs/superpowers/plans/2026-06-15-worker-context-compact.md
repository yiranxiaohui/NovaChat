# 工蜂上下文显示与 /compact 压缩 — 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在工蜂聊天输入框上方实时显示上下文占用,超过 80% 时提示用户输入 `/compact`,并实现 LLM 摘要压缩历史。

**Architecture:** 后端 agent 循环把 Claude 响应里真实的 `usage` 通过新 SSE 事件 `usage` 推给前端;前端用它驱动一个上下文进度条。新增 `/compact` 端点:把"最近 2 轮之外"的历史调 Claude(无 tools)压成中文摘要,在事务里删除并按 `summary → 最近 2 轮` 顺序重排 insert,使 `worker_messages.id` 重新单调,`rebuild_messages` 把 `summary` 行当 user 背景注入。

**Tech Stack:** Rust/Axum + sqlx(三方言)后端;React 19 + Vite + Tailwind 前端。

**测试说明:** 本仓库无测试框架(见 CLAUDE.md)。每个任务的验证 = `cargo check`(后端)/ `cd web && bun run build`(前端)+ 必要时手动跑服务。不写单元测试,改用编译通过 + 手动验证。

---

## 文件清单

后端:
- 修改 `src/worker.rs`:
  - `call_claude` 加 `with_tools: bool` 参数。
  - agent 循环每轮发 `usage` SSE 事件。
  - `rebuild_messages` 加 `"summary"` 分支。
  - 新增 `compact` 端点 + `CompactReq`,注册到 `routes()`。

前端:
- 修改 `web/src/lib/worker.ts`:`AgentEventType` 加 `"usage"`;`sendAgentMessage` 透传 usage;新增 `workerApi.compact`;`replayMessages` 加 summary 分支;导出 `contextLimit`。
- 修改 `web/src/pages/ChatPage.tsx`:`contextTokens` 状态、会话切换重置、`usage` 事件处理、`/compact` 拦截、上下文条 UI。

无新 migration。

---

## Task 1: call_claude 参数化 with_tools

**Files:**
- Modify: `src/worker.rs`(`call_claude` 约 237-286 行;两处调用点之一在 agent 循环约 611 行)

- [ ] **Step 1: 给 call_claude 加 with_tools 参数**

把 `call_claude` 签名与请求体改成:

```rust
async fn call_claude(
    state: &AppState,
    chain: &[channels::ChannelChoice],
    model: &str,
    messages: &serde_json::Value,
    with_tools: bool,
) -> Result<serde_json::Value, String> {
    let mut base_body = json!({
        "model": model,
        "max_tokens": 4096,
        "messages": messages,
    });
    if with_tools {
        base_body["tools"] = tool_defs();
    }
    // ……以下 for choice in chain 循环保持不变……
```

(即:把原来 `base_body` 里写死的 `"tools": tool_defs()` 移到 `with_tools` 条件下。)

- [ ] **Step 2: 更新 agent 循环里的调用点**

在 `session_message` 的 agent 循环里(约 611 行),把

```rust
let resp = match call_claude(&state, &chain, &req.model, &messages_val).await {
```

改为

```rust
let resp = match call_claude(&state, &chain, &req.model, &messages_val, true).await {
```

- [ ] **Step 3: 编译验证**

Run: `cargo check`
Expected: 通过(此时还没有 compact 调用点,只是参数加了)。若报"unused"无关紧要。

- [ ] **Step 4: 提交**

```bash
git add src/worker.rs
git commit -m "refactor(worker): call_claude 增加 with_tools 参数"
```

---

## Task 2: agent 循环发出 usage SSE 事件

**Files:**
- Modify: `src/worker.rs`(agent 循环拿到 `resp` 之后,约 627-640 行附近)

- [ ] **Step 1: 在解析 content 之前发 usage 事件**

在 `let resp = match call_claude(...)` 成功拿到 `resp` 之后、解析 `content` 之前,插入:

```rust
            // 发出本轮真实 token 用量(input+output ≈ 下一轮 context 起点)
            {
                let usage = resp.get("usage").cloned().unwrap_or_else(|| json!({}));
                let it = usage.get("input_tokens").and_then(|x| x.as_i64()).unwrap_or(0);
                let ot = usage.get("output_tokens").and_then(|x| x.as_i64()).unwrap_or(0);
                emit!(
                    "usage",
                    serde_json::to_string(&json!({
                        "input_tokens": it,
                        "output_tokens": ot,
                    }))
                    .unwrap_or_else(|_| "{}".to_string())
                );
            }
```

- [ ] **Step 2: 编译验证**

Run: `cargo check`
Expected: 通过。

- [ ] **Step 3: 提交**

```bash
git add src/worker.rs
git commit -m "feat(worker): agent 循环发出 usage SSE 事件"
```

---

## Task 3: rebuild_messages 支持 summary 角色

**Files:**
- Modify: `src/worker.rs`(`rebuild_messages` 约 513-543 行)

- [ ] **Step 1: 加 summary 分支**

在 `rebuild_messages` 的 `match role.as_str()` 里,`"user"` 分支之后加:

```rust
            "summary" => msgs.push(json!({
                "role": "user",
                "content": format!("[历史摘要]\n{content}")
            })),
```

(放在 `"user"` 之后、`"assistant"` 之前即可;顺序不影响匹配。)

- [ ] **Step 2: 编译验证**

Run: `cargo check`
Expected: 通过。

- [ ] **Step 3: 提交**

```bash
git add src/worker.rs
git commit -m "feat(worker): rebuild_messages 支持 summary 角色"
```

---

## Task 4: compact 端点(后端核心)

**Files:**
- Modify: `src/worker.rs`(新增 `CompactReq` 结构、`compact` handler;`routes()` 约 255-268 行注册新路由)

- [ ] **Step 1: 新增 CompactReq 结构**

在文件里其它 `#[derive(Deserialize)]` 请求结构附近(如 `MessageReq` 旁)加:

```rust
#[derive(Deserialize)]
struct CompactReq {
    model: String,
}
```

- [ ] **Step 2: 实现 compact handler**

在 `session_message` 函数之后(或 `approve` 附近)新增。注意:这是普通 JSON 端点,不是 SSE。

```rust
async fn compact(
    State(state): State<AppState>,
    Extension(installed): Extension<InstalledState>,
    Extension(user): Extension<CurrentUser>,
    Path(sid): Path<i64>,
    headers: HeaderMap,
    Json(req): Json<CompactReq>,
) -> Json<serde_json::Value> {
    let pool = installed.pool.clone();
    let kind = installed.kind;

    macro_rules! fail {
        ($msg:expr) => {{
            return Json(json!({"ok": false, "message": $msg}));
        }};
    }

    // 1. 校验会话归属
    let owner: Option<(i64,)> = sqlx::query_as(&crate::db::q(
        kind,
        "SELECT user_id FROM worker_sessions WHERE id = ?",
    ))
    .bind(sid)
    .fetch_optional(&pool)
    .await
    .ok()
    .flatten();
    match owner {
        Some((uid,)) if uid == user.id => {}
        _ => fail!("会话不存在或无权限"),
    }

    // 2. 解析渠道链
    let route = channels::resolve_route(
        &pool, kind, &headers, "chat", "claude", &req.model,
    )
    .await;
    let chain = match route {
        Ok(channels::Route::Channels { chain, .. }) => chain,
        Ok(channels::Route::Byok(_)) => fail!("请使用服务端渠道（暂不支持 BYOK）"),
        Err(_) => fail!("无可用 Claude 渠道"),
    };

    // 3. 读全部消息(带 id,用于切分保留窗口)
    let rows: Vec<(i64, String, String)> = sqlx::query_as(&crate::db::q(
        kind,
        "SELECT id, role, content FROM worker_messages WHERE session_id = ? ORDER BY id",
    ))
    .bind(sid)
    .fetch_all(&pool)
    .await
    .unwrap_or_default();

    // 4. 切分:从尾部向前数到第 2 个 "user" 轮的起点 = 保留窗口起点
    //    保留窗口 = [keep_start..],其余为待压缩段。
    let user_idxs: Vec<usize> = rows
        .iter()
        .enumerate()
        .filter(|(_, (_, role, _))| role == "user")
        .map(|(i, _)| i)
        .collect();
    if user_idxs.len() < 3 {
        // 不足 3 个用户轮:压缩收益太小,直接返回。
        fail!("历史太短，无需压缩");
    }
    // 保留最近 2 个 user 轮:keep_start = 倒数第 2 个 user 的下标
    let keep_start = user_idxs[user_idxs.len() - 2];
    let (to_compact, keep) = rows.split_at(keep_start);
    if to_compact.is_empty() {
        fail!("历史太短，无需压缩");
    }

    // 5. 把待压缩段重建为 messages,调 Claude(无 tools)生成摘要
    let compact_pairs: Vec<(String, String)> = to_compact
        .iter()
        .map(|(_, r, c)| (r.clone(), c.clone()))
        .collect();
    let mut summary_msgs = rebuild_messages(&compact_pairs);
    summary_msgs.push(json!({
        "role": "user",
        "content": "请用中文简洁总结以上对话历史，保留关键事实、涉及的文件路径、\
命令及其结果、尚未完成的任务，供后续继续。只输出摘要正文，不要寒暄。"
    }));

    // 扣费
    let cost = match channels::try_deduct_for_model(
        &pool, kind, user.id, &req.model, "chat", "claude", "worker_compact",
    )
    .await
    {
        Ok((_bal, deducted)) => deducted,
        Err(_) => fail!("积分不足或模型未启用"),
    };

    let summary_val = serde_json::Value::Array(summary_msgs);
    let resp = match call_claude(&state, &chain, &req.model, &summary_val, false).await {
        Ok(v) => v,
        Err(e) => {
            if cost > 0 {
                let _ = crate::credits::grant(
                    &pool, kind, user.id, cost,
                    &format!("refund_worker_compact_{}_failed", req.model),
                    &crate::credits::LedgerMeta::refund_chat("claude", &req.model),
                )
                .await;
            }
            fail!(format!("压缩失败：{e}"));
        }
    };
    // 取摘要文本(content 数组里第一个 text 块)
    let summary_text = resp
        .get("content")
        .and_then(|c| c.as_array())
        .and_then(|arr| arr.iter().find(|b| b.get("type").and_then(|t| t.as_str()) == Some("text")))
        .and_then(|b| b.get("text").and_then(|t| t.as_str()))
        .unwrap_or("")
        .to_string();
    if summary_text.is_empty() {
        fail!("压缩失败：摘要为空");
    }

    // 6. 事务重写:删除 to_compact + keep 全部行,按 summary → keep 顺序重新插入
    let now = crate::db::now_expr(kind);
    let mut tx = match pool.begin().await {
        Ok(t) => t,
        Err(_) => fail!("数据库事务开启失败"),
    };
    // 删除本会话所有消息
    if sqlx::query(&crate::db::q(kind, "DELETE FROM worker_messages WHERE session_id = ?"))
        .bind(sid)
        .execute(&mut *tx)
        .await
        .is_err()
    {
        let _ = tx.rollback().await;
        fail!("数据库删除失败");
    }
    // 先插 summary 行(确保最小 id)
    let insert_sql = crate::db::q(
        kind,
        &format!(
            "INSERT INTO worker_messages (session_id, role, content, created_at) VALUES (?, ?, ?, {now})"
        ),
    );
    if sqlx::query(&insert_sql)
        .bind(sid)
        .bind("summary")
        .bind(&summary_text)
        .execute(&mut *tx)
        .await
        .is_err()
    {
        let _ = tx.rollback().await;
        fail!("写入摘要失败");
    }
    // 再按顺序插回保留窗口
    for (_, role, content) in keep {
        if sqlx::query(&insert_sql)
            .bind(sid)
            .bind(role)
            .bind(content)
            .execute(&mut *tx)
            .await
            .is_err()
        {
            let _ = tx.rollback().await;
            fail!("写入保留消息失败");
        }
    }
    if tx.commit().await.is_err() {
        fail!("事务提交失败");
    }

    // 7. 本地粗估压缩后 token(摘要 + 保留窗口字符数 / 4)
    let kept_chars: usize = summary_text.chars().count()
        + keep.iter().map(|(_, _, c)| c.chars().count()).sum::<usize>();
    let after_estimate = (kept_chars / 4) as i64;

    Json(json!({
        "ok": true,
        "after_estimate": after_estimate,
        "summary": summary_text,
    }))
}
```

- [ ] **Step 3: 注册路由**

在 `routes()`(约 267 行)的 `approve` 路由之后加:

```rust
        .route("/worker/sessions/{sid}/compact", post(compact))
```

- [ ] **Step 4: 确认依赖已 use**

确认文件顶部已 `use axum::extract::Path;`、`use axum::http::HeaderMap;`、`use axum::Json;`、`use serde_json::json;` 等(`session_message` 已用到这些,通常已具备)。若缺则补。

- [ ] **Step 5: 编译验证**

Run: `cargo check`
Expected: 通过。重点核对 `try_deduct_for_model` 返回元组解构、`now_expr`/`q` 用法与 `session_message` 一致。

- [ ] **Step 6: 提交**

```bash
git add src/worker.rs
git commit -m "feat(worker): 新增 /compact 端点，LLM 摘要压缩历史并事务重排"
```

---

## Task 5: 前端 worker.ts — usage 事件 / compact API / summary replay / 上限表

**Files:**
- Modify: `web/src/lib/worker.ts`

- [ ] **Step 1: AgentEventType 加 usage**

把(约 30-31 行):

```ts
export type AgentEventType =
  | "text" | "tool_call" | "approval_required" | "tool_result" | "done" | "error"
```

改为:

```ts
export type AgentEventType =
  | "text" | "tool_call" | "approval_required" | "tool_result" | "done" | "error" | "usage"
```

- [ ] **Step 2: 导出上下文上限表**

在文件末尾(或类型定义附近)加:

```ts
const CONTEXT_LIMITS: Record<string, number> = {
  "claude-opus-4-8": 200_000,
  "claude-sonnet-4-6": 200_000,
  "claude-haiku-4-5-20251001": 200_000,
}
export const DEFAULT_CONTEXT_LIMIT = 200_000
export function contextLimit(model: string): number {
  return CONTEXT_LIMITS[model] ?? DEFAULT_CONTEXT_LIMIT
}
```

- [ ] **Step 3: 新增 compact API**

在 `workerApi` 对象里(`approve` 方法之后、约 107 行的 `}` 之前)加:

```ts
  async compact(
    sid: number,
    body: { model: string }
  ): Promise<{ ok: boolean; message?: string; after_estimate?: number; summary?: string }> {
    return jsonOrThrow(
      await fetch(`/api/worker/sessions/${sid}/compact`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        credentials: "same-origin",
      })
    )
  },
```

- [ ] **Step 4: replayMessages 加 summary 分支**

在 `replayMessages`(约 159 行起)的循环里,`if (m.role === "tool")` 之前加:

```ts
    if (m.role === "summary") {
      out.push({ type: "text", data: `🗜️ [历史摘要] ${m.content}` })
      continue
    }
```

(`usage` 事件不落库,所以 replay 不涉及它。)

- [ ] **Step 5: 编译验证**

Run: `cd web && bun run build`
Expected: tsc 通过、vite 产出 dist。

- [ ] **Step 6: 提交**

```bash
git add web/src/lib/worker.ts
git commit -m "feat(worker-ui): worker.ts 支持 usage 事件、compact API、summary replay、上限表"
```

---

## Task 6: 前端 ChatPage — 上下文状态与 usage 处理

**Files:**
- Modify: `web/src/pages/ChatPage.tsx`

- [ ] **Step 1: 引入 contextLimit + 新增 contextTokens 状态**

在顶部从 `@/lib/worker` 的 import 里加上 `contextLimit`(约 64-73 行的 import 块):

```ts
  contextLimit,
```

在 worker 相关 state 附近(约 810 `const [workerSending...` 行旁)加:

```ts
  const [contextTokens, setContextTokens] = useState(0)
```

- [ ] **Step 2: 会话切换时重置 contextTokens**

在监听 `workerSessionId` 的 effect 里(约 987-1004 行,设置 `setWorkerLog([])` 那段),加一行 `setContextTokens(0)`,放在 `setWorkerLog([])` 旁边。

并在 `isWorkerRoute` 为 false 的清理 effect(约 1008-1015 行)里同样加 `setContextTokens(0)`。

- [ ] **Step 3: 在 sendWorker 的事件回调里处理 usage**

把 `sendWorker` 里(约 1532-1538 行)的回调:

```ts
      (ev) => {
        pushWorker(ev)
        if (ev.type === "done" || ev.type === "error") {
          setWorkerSending(false)
          workerAbort.current = null
        }
      }
```

改为:

```ts
      (ev) => {
        if (ev.type === "usage") {
          const it = Number(ev.data?.input_tokens ?? 0)
          const ot = Number(ev.data?.output_tokens ?? 0)
          setContextTokens(it + ot)
          return // usage 不入日志
        }
        pushWorker(ev)
        if (ev.type === "done" || ev.type === "error") {
          setWorkerSending(false)
          workerAbort.current = null
        }
      }
```

- [ ] **Step 4: 编译验证**

Run: `cd web && bun run build`
Expected: 通过(此时 UI 还没显示,但状态已就绪)。

- [ ] **Step 5: 提交**

```bash
git add web/src/pages/ChatPage.tsx
git commit -m "feat(worker-ui): ChatPage 接入 usage 事件维护 contextTokens"
```

---

## Task 7: 前端 ChatPage — /compact 拦截

**Files:**
- Modify: `web/src/pages/ChatPage.tsx`(`send` 约 1246-1252 行)

- [ ] **Step 1: 在 send() 的 worker 分支里拦截 /compact**

把 `send()` 开头的 worker 分支(约 1247-1252 行):

```ts
    if (workerMode) {
      const text = input
      setInput("")
      await sendWorker(text)
      return
    }
```

改为:

```ts
    if (workerMode) {
      const text = input
      setInput("")
      if (text.trim() === "/compact") {
        await compactWorker()
        return
      }
      await sendWorker(text)
      return
    }
```

- [ ] **Step 2: 新增 compactWorker 函数**

在 `sendWorker` 函数之后(约 1540 行 `}` 之后)加:

```ts
  async function compactWorker() {
    if (workerId == null || activeWorkerSession == null) {
      pushWorker({ type: "error", data: "请先在会话中发起对话再压缩" })
      return
    }
    if (workerSending) return
    pushWorker({ type: "text", data: "🗜️ 正在压缩上下文…" })
    try {
      const r = await workerApi.compact(activeWorkerSession, {
        model: workerModel,
      })
      if (!r.ok) {
        pushWorker({ type: "error", data: r.message ?? "压缩失败" })
        return
      }
      const after = Number(r.after_estimate ?? 0)
      pushWorker({
        type: "text",
        data: `✅ 已压缩，上下文约 ${formatTokens(contextTokens)} → ${formatTokens(after)}`,
      })
      setContextTokens(after)
    } catch (e) {
      pushWorker({ type: "error", data: `压缩失败：${String(e)}` })
    }
  }
```

- [ ] **Step 3: 新增 formatTokens 辅助函数**

在组件内任意函数定义区(如 `compactWorker` 上方)加:

```ts
  function formatTokens(n: number): string {
    return n >= 1000 ? `${(n / 1000).toFixed(1)}K` : String(n)
  }
```

- [ ] **Step 4: 编译验证**

Run: `cd web && bun run build`
Expected: 通过。

- [ ] **Step 5: 提交**

```bash
git add web/src/pages/ChatPage.tsx
git commit -m "feat(worker-ui): /compact 命令拦截并调用 compact 端点"
```

---

## Task 8: 前端 ChatPage — 上下文条 UI

**Files:**
- Modify: `web/src/pages/ChatPage.tsx`(输入框容器 `<div className="flex items-end gap-2 rounded-2xl ...">` 约 1972 行之前)

- [ ] **Step 1: 在输入框容器上方插入上下文条**

找到输入行容器开始处(约 1972 行的 `<div className="flex items-end gap-2 rounded-2xl border border-border bg-card p-2 ...">`),在它**之前**插入(仅 worker 模式显示):

```tsx
            {workerMode && (() => {
              const limit = contextLimit(workerModel)
              const pct = Math.min(100, Math.round((contextTokens / limit) * 100))
              const warn = pct >= 80
              return (
                <div className="mb-1.5 px-1">
                  <div
                    className={`flex items-center justify-between text-xs ${
                      warn ? "text-orange-500" : "text-muted-foreground"
                    }`}
                  >
                    <span>
                      {warn
                        ? `上下文已用 ${pct}%，输入 /compact 压缩历史`
                        : `上下文 ${formatTokens(contextTokens)} / ${formatTokens(limit)} (${pct}%)`}
                    </span>
                  </div>
                  <div className="mt-1 h-1 w-full overflow-hidden rounded-full bg-muted">
                    <div
                      className={`h-full rounded-full transition-all ${
                        warn ? "bg-orange-500" : "bg-primary/50"
                      }`}
                      style={{ width: `${pct}%` }}
                    />
                  </div>
                </div>
              )
            })()}
```

(注:`formatTokens` 已在 Task 7 定义于组件内,此处直接复用。)

- [ ] **Step 2: 编译验证**

Run: `cd web && bun run build`
Expected: 通过。

- [ ] **Step 3: 提交**

```bash
git add web/src/pages/ChatPage.tsx
git commit -m "feat(worker-ui): 输入框上方显示上下文进度条，≥80% 橙色提示 /compact"
```

---

## Task 9: 端到端手动验证

**Files:** 无(运行验证)

- [ ] **Step 1: 起后端**

Run: `cargo run`
确认编译运行,`/api` 可用。

- [ ] **Step 2: 起前端 dev(或用已 build 的嵌入资源)**

Run: `cd web && bun run dev`
浏览器开工蜂会话。

- [ ] **Step 3: 验证上下文条**

发若干轮对话,确认输入框上方上下文条数字随每轮 usage 增长;数字格式 `xx.xK / 200K (Y%)`。

- [ ] **Step 4: 验证 80% 提示**

(可临时把 `CONTEXT_LIMITS` 某模型调小,如 2000,快速触发)确认 ≥80% 时整行变橙、文案变为 `输入 /compact 压缩历史`、进度条橙色。验证后改回 200000。

- [ ] **Step 5: 验证 /compact**

输入 `/compact` 回车,确认:
- 日志出现 `🗜️ 正在压缩上下文…` → `✅ 已压缩，上下文 X → Y`
- 上下文条占比下降
- 刷新页面(replay)能看到 `🗜️ [历史摘要] …` 条目
- 继续对话,Claude 仍能基于摘要+最近 2 轮连贯回复

- [ ] **Step 6: 验证历史太短的兜底**

新会话只发 1 轮就 `/compact`,确认提示"历史太短,无需压缩",不报错。

- [ ] **Step 7: 最终提交(若验证中有微调)**

```bash
git add -A
git commit -m "chore(worker): 上下文显示与 /compact 端到端验证微调"
```

---

## 自检备注(写计划时已核对)

- **Spec 覆盖**:usage 计量(T1-2,T6)、按模型上限(T5,T8)、80% 提示(T8)、手动 /compact(T7)、LLM 摘要(T4)、保留最近 2 轮(T4 切分逻辑)、事务重排(T4)、summary replay(T5)、无新 migration(全程未加)——全覆盖。
- **类型一致**:`contextTokens`/`contextLimit`/`formatTokens` 跨 T6-T8 命名一致;`compact` body `{model}` 与后端 `CompactReq{model}` 一致;`usage` 事件字段 `input_tokens/output_tokens` 后端(T2)与前端(T6)一致。
- **保留窗口逻辑**:用 user 轮下标切分,`user_idxs.len() < 3` 兜底,`keep_start = 倒数第 2 个 user 下标`,确保保留"最近 2 轮"。
