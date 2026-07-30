# 普通聊天上下文占用率显示 — 设计

日期：2026-07-30
状态：已确认

## 目标

在聊天页输入栏上方显示当前会话的上下文占用情况（已用 token / 模型上限 / 百分比），仅普通聊天模式生效。工蜂模式已有同类显示，图像模式不需要。

## 数据来源：真实 usage 优先，估算兜底

### 真实 usage（改 `web/src/lib/chat-stream.ts`）

给流式聊天增加可选回调 `onUsage(promptTokens: number, completionTokens: number)`，三协议分别解析：

- **OpenAI 协议**：请求体加 `stream_options: { include_usage: true }`，解析流末尾带 `usage` 的 chunk（`usage.prompt_tokens` / `usage.completion_tokens`）。不支持该参数的中转站会忽略或不回传 usage，此时自然落到估算兜底。
- **Anthropic 协议**：`message_start` 事件读 `message.usage.input_tokens`，`message_delta` 事件读 `usage.output_tokens`（累计值，取最后一次）。
- **Gemini 协议**：流式 chunk 中的 `usageMetadata.promptTokenCount` / `candidatesTokenCount`。

### 估算兜底（新函数）

`estimateTokens(text: string): number`：CJK 字符按 1 token/字，其余按 4 字符/token 累加。会话级估算 = 系统提示词 + 技能附加内容 + 全部消息文本逐条估算求和。

### 显示值选取

- 本会话**拿到过**真实 usage：显示最近一次的 `prompt + completion`（与工蜂模式口径一致）。
- **从未拿到**：显示估算值，随消息列表变化实时重算。
- 切换/新建会话时清零真实值，回到估算。

## 上下文上限表（新文件 `web/src/lib/context-limits.ts`）

`contextLimit(model: string): number`，按模型名小写关键词匹配（从上到下首个命中）：

| 关键词 | 上限 |
|---|---|
| `gemini` | 1,000,000 |
| `gpt-5` | 400,000 |
| `claude` | 200,000 |
| `gpt-4o` / `o3` / `o4` | 128,000 |
| `deepseek` | 128,000 |
| 默认 | 128,000 |

工蜂模式的 `worker.ts` 中 `contextLimit`/`CONTEXT_LIMITS` 改为从该文件复用（行为不变：其模型均为 claude → 200k）。

## UI

位置：输入栏上方、工蜂模式勾选框同一行区域，普通聊天模式（非图像、非工蜂）显示。

- 样式：muted 灰色小字，`上下文 12.3k / 200k (6%)`，复用 ChatPage 已有 `formatTokens`。
- 阈值：占用 ≥80% 文字变黄；≥95% 变红并追加"建议新开会话"。
- 始终显示（含 0%），保持布局稳定。

## 不做的事

- 不做上下文压缩（/compact 是工蜂能力）。
- usage 不持久化到数据库；刷新页面后回到估算兜底。
- 后端零改动。

## 验证

- `bun run build`、`bun run lint` 通过。
- 运行服务，普通聊天发消息：OpenAI/Anthropic 上游能看到真实 usage 数字更新；断开 usage（或首条消息前）显示估算值；切换会话数字重置。
