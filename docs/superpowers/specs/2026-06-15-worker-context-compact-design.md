# 工蜂上下文显示与 /compact 压缩 — 设计

日期：2026-06-15

## 背景

工蜂(worker)会话每轮把 `worker_messages` 里的**全量历史**重建后塞给 Claude
(`src/worker.rs` `session_message` → `rebuild_messages`)。会话越长,每轮注入的
context 越大,直到撞上模型上下文窗口报错。当前 UI 对此无任何感知。

目标：
1. 在工蜂聊天输入框上方实时显示当前上下文占用(`X / 上限 (Y%)`)。
2. 占用超过 80% 时显示橙色提示,引导用户输入 `/compact`。
3. `/compact` 调 Claude 把旧历史压成摘要,保留最近 2 轮原文,显著降低占用。

## 决策汇总(已与用户确认)

| 议题 | 决定 |
|---|---|
| token 计量 | 用 Claude 响应里的真实 `usage.input_tokens`(+ 上一轮 output) |
| 上下文上限(分母) | 按模型查映射表(默认回退 200K) |
| 提示阈值 | 80% |
| compact 触发 | 手动:用户输入 `/compact` |
| compact 方式 | 调 LLM 生成摘要 |
| compact 保留 | 最近 2 轮对话原文,其余压成一段摘要 |

## 一、后端:暴露真实 token 用量

`call_claude` 当前丢弃响应里的 `usage`。改动：

- `call_claude` 返回的 `serde_json::Value` 本就含 `usage` 字段,无需改签名。
- 在 agent 循环每次拿到 `resp` 后,读取
  `resp.usage.input_tokens` + `resp.usage.output_tokens`,通过新的 SSE 事件
  `usage` 发给前端:
  ```json
  {"input_tokens": 12345, "output_tokens": 678, "model": "claude-opus-4-8"}
  ```
  其中 `input_tokens + output_tokens` 近似为"下一轮的 context 起点"。
- 该事件在循环里每次 Claude 调用后都发(取最后一次的值即为本轮结束时上下文)。

前端新增 `AgentEventType` 成员 `"usage"`,在 `worker.ts` 的 `sessionMessage`
解析中透传;`ChatPage` 收到后更新 `contextTokens` 状态。

**首条消息前 / 历史回看**:`replayMessages` 无 usage 数据。此时前端用本地
粗估(字符数/4 之和)兜底显示,真实 usage 一旦到达即覆盖。

## 二、上下文上限映射

前端常量(`web/src/lib/worker.ts` 或 ChatPage 内):

```ts
const CONTEXT_LIMITS: Record<string, number> = {
  "claude-opus-4-8": 200_000,
  "claude-sonnet-4-6": 200_000,
  "claude-haiku-4-5-20251001": 200_000,
}
const DEFAULT_LIMIT = 200_000
function contextLimit(model: string) {
  return CONTEXT_LIMITS[model] ?? DEFAULT_LIMIT
}
```

前缀匹配兜底(如 `claude-opus-*`)留待将来,先用精确表 + 默认值。

## 三、前端:输入框上方的上下文条

在工蜂模式输入框(`ChatPage` worker 分支的 `Textarea` 容器)上方加一行：

- 普通态(<80%):灰色小字 `上下文 12.3K / 200K (6%)`,带一个细进度条。
- 警戒态(≥80%):整行变橙色,文案 `上下文已用 82%,输入 /compact 压缩历史`,
  进度条橙色。
- 数字格式化:≥1000 显示 `xx.xK`,否则原数。

状态：
```ts
const [contextTokens, setContextTokens] = useState(0)
```
- 切换会话(`workerSessionId` 变化)时重置为 0,随后由首轮 usage 或本地估算填充。
- 收到 `usage` 事件 → `setContextTokens(input + output)`。

## 四、/compact 命令

### 4.1 前端拦截

worker 模式发送时,若输入文本 `trim() === "/compact"`：
- 不走普通 `sessionMessage`,改调新接口 `POST /api/worker/sessions/{sid}/compact`
  (body 含 `worker_id`, `model`)。
- 在 `workerLog` 推一条系统提示 `🗜️ 正在压缩上下文…`。
- 成功后推 `✅ 已压缩,上下文 X → Y`,并 `setContextTokens(Y)`。

### 4.2 后端 compact 端点

新增 `compact(State, InstalledState, CurrentUser, Path<sid>, Json<CompactReq>)`：

1. 校验会话归属(同 `session_message`)。
2. 读全部 `worker_messages`(id, role, content) `ORDER BY id`。
3. 确定"保留窗口":从尾部向前保留**最近 2 个 user 轮及其后续 assistant/tool**
   消息(即最近 2 次用户提问起的所有消息)。其余为"待压缩段"。
   - 若消息太少(待压缩段为空或只有 1 条),直接返回 `nothing_to_compact`,
     前端提示"历史太短,无需压缩"。
4. 把待压缩段 `rebuild_messages` 成 messages,调 Claude(复用 `call_claude` 但
   **不带 tools**,加一条 system/user 指令:"用中文简洁总结以下对话历史,保留
   关键事实、文件路径、命令结果、未完成任务,供后续继续。")得到摘要文本。
   - 此调用照常 `try_deduct_for_model` 扣费 / 失败退款。
5. **DB 重写(事务)**:
   - 删除待压缩段那些 `worker_messages` 行。
   - 插入一条新消息 `role = "summary"`,`content = 摘要文本`,
     其 `created_at` 早于保留窗口(用最小 id 技巧:见下)。
   - 保留窗口的行不动。
   - 顺序保证:summary 必须排在保留窗口之前。由于现有行 id 单调递增,删除旧行后
     新插入的 summary id 会更大,会排到后面 → **错序**。
     解决:compact 用事务把保留窗口也一并删除并按
     `summary → 保留窗口` 顺序重新插入,从而 id 重新单调。
     (worker_messages 无外键引用,安全。)
6. `rebuild_messages` 增加分支:`role == "summary"` →
   `{"role":"user","content":"[历史摘要]\n<summary>"}`(作为普通 user 文本注入,
   Claude 当成背景)。
7. 返回 `{"ok":true, "before_tokens":?, "after_estimate":?}`。
   - `after_estimate` 用本地粗估(摘要+保留窗口字符数/4),前端拿来更新进度条;
     真实值在下一轮 `usage` 事件到达时校正。

### 4.3 replay 兼容

`web/src/lib/worker.ts` `replayMessages` 增加 `role === "summary"` 分支,渲染成
一条系统样式条目 `🗜️ [历史摘要] …`,折叠显示。

## 五、数据流图

```
用户输入 ──/compact?──┬─ 是 → POST .../compact → Claude 摘要 → DB 重写 → 返回 after_estimate
                      │                                              → 前端更新 contextTokens
                      └─ 否 → POST .../message(SSE)
                                  └ 每轮 Claude resp.usage → SSE "usage" → 前端 contextTokens
```

## 六、改动文件清单

后端：
- `src/worker.rs`：
  - agent 循环发 `usage` SSE 事件。
  - 新增 `compact` 端点 + `CompactReq`,挂到 `routes()`:
    `.route("/worker/sessions/{sid}/compact", post(compact))`。
  - `rebuild_messages` 加 `"summary"` 分支。
  - `call_claude` 参数化:加 `with_tools: bool`,compact 调用传 `false`
    (请求体不带 `tools` 字段),agent 循环传 `true`。

前端：
- `web/src/lib/worker.ts`:`AgentEventType` 加 `"usage"`;`sessionMessage` 透传;
  新增 `compact(sid, body)` API;`replayMessages` 加 summary 分支;导出
  `CONTEXT_LIMITS`/`contextLimit`。
- `web/src/pages/ChatPage.tsx`:`contextTokens` 状态、会话切换重置、`usage` 事件
  处理、`/compact` 拦截、输入框上方上下文条 UI。

**无需新增 migration**(`summary` 复用现有 `worker_messages.role` 文本列)。

## 七、构建验证

- `cargo check`(后端)
- `cd web && bun run build`(前端)
- 手动:起服务,工蜂会话多轮对话观察上下文条增长 → 触发 80% 橙色 →
  `/compact` → 占用下降、摘要条出现、后续对话仍连贯。
