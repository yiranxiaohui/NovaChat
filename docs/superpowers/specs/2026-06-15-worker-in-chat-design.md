# 工蜂融入对话 — 设计文档

日期：2026-06-15
分支：`worktree-worker-in-chat`

## 背景与目标

工蜂（远程 agent）目前是独立的 `/worker` 页面，有自己的一套 API、SSE 事件流和数据表，与普通对话完全平行。两处问题：

1. 工蜂页文本不渲染 markdown（`**bold**`、代码块都显示原文），工具结果是常开的 `<pre>`，超长输出刷屏、无法折叠。
2. 工蜂是孤立的二级页面，与对话体验割裂。

目标：**取消独立工蜂页，把工蜂作为对话里的一个「模式」**，由用户在聊天页内开启并配置；工蜂会话进侧边栏历史、与普通对话混排、能回看；工具/文本渲染复用聊天页的 markdown 与气泡，工具结果超长可折叠。

非目标：不改数据库表结构；不统一 conversations/worker_sessions 两张表；不重写 worker 后端的 agent 循环逻辑。

## 方案概述（已确认）

- 集成深度：**A — 对话内「工蜂模式」开关**。worker session 仍是独立概念，但 UI 整体并入聊天页。
- 历史：工蜂会话**进侧边栏，与普通对话混排**。
- 工具结果折叠：**超长才折叠**（短输出照常展开）。
- markdown 渲染范围：工蜂的 `text` 与 `error` 事件都走 markdown。
- 工蜂管理（配对/部署/删除）：挪到设置弹窗。

## 数据模型

**不动表结构。** 现有四张表保持原样：

- `workers(id, user_id, name, token_hash, last_seen_at, created_at)`
- `worker_sessions(id, user_id, worker_id, title, created_at, updated_at)`
- `worker_messages(id, session_id, role, content, created_at)`
- `conversations` / `messages`（普通对话）

`worker_messages.content` 的既有约定（沿用，前端据此还原历史）：
- `role="user"` → 纯文本
- `role="assistant"` → Anthropic content block 数组的序列化 JSON（含 `text` 块与 `tool_use` 块）
- `role="tool"` → 工具结果 JSON

## 后端改动

最小化。新增/调整：

1. **列工蜂会话接口**（供侧边栏混排）：`GET /api/worker/sessions`，返回当前用户全部 worker_sessions（`id, worker_id, title, updated_at`，可附 worker 名）。若现有代码已有等价能力则复用，否则在 `src/worker.rs` 新增 handler + 路由。
2. 其余 worker API（pair / list / sessions / messages / message(SSE) / approve / DELETE）保持不变。

无迁移文件。

## 前端改动

### 1. 共享 Markdown 组件 — `web/src/components/app/Markdown.tsx`

- 从 `ChatPage.tsx` 抽出 `CodeBlock`（带复制按钮）并导出。
- 导出 `<Markdown>{text}</Markdown>`：复用聊天页 `prose prose-sm` 样式 + `remark-gfm`，`pre` 用 `CodeBlock`；**不含**聊天页特有的「发布到广场」图片浮层逻辑（保持纯净、可复用）。
- `ChatPage.tsx` 改为 `import { CodeBlock } from "@/components/app/Markdown"`，删除本地 `CodeBlock` 定义；其内联 markdown 的图片浮层逻辑保持不动（零回归）。

### 2. 工蜂事件渲染 — 复用 + 折叠

把现 `WorkerPage` 里的 `Row` 逻辑迁移为聊天页可用的工蜂消息渲染（可放在 `web/src/components/app/WorkerEvents.tsx` 或聊天页内）：

- `text` → `<Markdown>`
- `error` → 红色 `⚠` + `<Markdown>`
- `tool_call` → 工具名 + 入参（紧凑单行，沿用现样式）
- `tool_result` → `ToolResult` 子组件：
  - 输出 ≤ 12 行：完整展开。
  - 输出 > 12 行：默认 clamp 到约 10 行高度 + 底部渐隐，提供「展开（共 N 行）/ 收起」切换。
- `approval_required` → 内联「批准/拒绝」按钮（沿用现样式）。
- `done` → 「— 完成 —」分隔。

### 3. 历史回看解析器

`web/src/lib/worker.ts` 新增 `replayMessages(rows: WorkerMessage[]): AgentEvent[]`：
- `user` → 渲染为用户气泡（`text`，前缀 🧑，与发送时一致）
- `assistant` → 解析 content block 数组：`text` 块 → `text` 事件；`tool_use` 块 → `tool_call` 事件
- `tool` → `tool_result` 事件（解析出 output）

打开工蜂会话时调用 `workerApi.messages(sid)` → `replayMessages` → 渲染。

### 4. 聊天页工蜂模式 — `web/src/pages/ChatPage.tsx`

- 输入框上方加「工蜂」开关（图标 `Bot`）。
- 开启后显示配置条：**在线工蜂下拉**（`workerApi.list()`，仅在线可选）、**模型输入/选择**、**自动批准** 复选框。
- 工蜂模式下发送：
  - 若当前对话尚未绑定 worker_session，先 `workerApi.createSession(worker_id)`，并把它登记为当前会话（侧边栏据此刷新出现该会话）。
  - 调 `sendAgentMessage` 走 SSE，事件 push 进消息列表，用第 2 节渲染器渲染。
  - `approval_required` 的「批准/拒绝」调 `workerApi.approve`。
- 当前对话的「工蜂 / 普通」由它绑定的是 worker_session 还是 conversation 决定；从侧边栏点开工蜂会话即进入工蜂模式并锁定对应 worker。
- 普通对话发送逻辑完全不动。

### 5. 侧边栏混排 — `web/src/components/app/Sidebar.tsx`

- 同时拉 `conversations`（现有）与 `worker_sessions`（新接口），各打 `kind: "chat" | "worker"`。
- 合并后按 `updated_at` 倒序排成同一列表。
- 工蜂条目前缀 🐝/`Bot` 图标以区分；普通条目维持原样。
- 点击：普通 → 现有打开逻辑；工蜂 → 路由到聊天页并以工蜂模式加载该 session。
- 删除/重命名：分别走各自的 API（worker_session 用 `workerApi.remove` 等）。

### 6. 工蜂管理挪到设置 — `web/src/components/app/SettingsDialog.tsx`

- 新增「工蜂」分区：生成配对码、显示部署命令（带复制）、工蜂列表（在线状态 + 删除）。
- 逻辑从 `WorkerPage` 迁移。

### 7. 清理

- 删除路由 `/worker`（`web/src/App.tsx`）。
- 删除侧边栏「工蜂」入口链接（`Sidebar.tsx`）。
- 删除 `web/src/pages/WorkerPage.tsx`。

## 错误处理

- 工蜂离线 / 无可用工蜂：配置条下拉为空时禁用发送并提示「没有在线工蜂，去设置里配对」。
- SSE 中断 / 错误：渲染 `error` 事件（红色 markdown），并复位发送态（沿用现有 `done`/`error` 复位逻辑）。
- 历史解析失败：单条消息解析异常时降级为纯文本渲染，不影响整段。

## 测试与验证

仓库无测试运行器。验证方式：
- `cargo check`（类型检查；按服务器规约不实际打包，仅本地 type-check）。
- `bun run build` 仅做 `tsc` 类型检查层面确认（不在本地/服务器实际执行打包产物分发）。
- 手动跑 server，逐项验证：开关工蜂模式、选在线工蜂发消息、工具调用/结果渲染与超长折叠、批准流程、侧边栏混排显示与回看、设置里配对/删除、普通对话无回归。

## 风险

- `ChatPage.tsx` 约 2000 行，新增工蜂模式分支需谨慎，避免污染普通对话路径。缓解：工蜂渲染与发送逻辑尽量隔离到独立组件/函数，聊天页只做模式分发。
- 侧边栏两来源合并的排序/分页若现有对话列表有分页逻辑，需对工蜂会话做一致处理（实现时确认现有分页方式）。
