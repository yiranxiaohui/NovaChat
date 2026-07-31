# 平台模型可配置上下文窗口 — 设计

日期：2026-07-31
状态：已确认

## 背景与目标

上下文占用率显示（2026-07-30 上线）用前端关键词表推断模型上限，未匹配的模型一律 128k，不准。本功能让管理员在平台模式的模型定价里为每个模型显式配置上下文窗口；未配置或 BYOK 模式仍回落关键词表。仅平台模式，不做 BYOK 用户自定义。

## 数据库

三方言各加迁移 `0029_model_pricing_context.sql`（当前最新为 0028）：

```sql
ALTER TABLE model_pricing ADD COLUMN context_limit BIGINT NULL;
```

（sqlite 用 `INTEGER NULL`，mysql/postgres 用 `BIGINT NULL`。）`NULL` = 未配置。在 `src/db.rs` 三个数组各注册 id 29。

## 后端（`src/channels.rs`）

- `ModelPrice` 结构与 `GET /api/admin/pricing` 列表查询加 `context_limit: Option<i64>`。
- upsert（`POST /api/admin/pricing`）入参加可选 `context_limit`；规整规则：`Some(n) 且 n > 0` 存 n，否则存 NULL。
- 用户侧 `GET /api/channels/models`（`list_available_models`）返回体加 `context_limit: Option<i64>`。

## 管理端 UI（`web/src/pages/admin/PricingPanel.tsx` + `web/src/lib/channels.ts`）

- `ModelPrice` / `PricingInput` 类型加 `context_limit: number | null`（input 可选）。
- 模型编辑表单加数字输入框，标签「上下文 (tokens)」，占位符「留空自动推断」；提交时空串/0 → null。列表行在已配置时显示（用 K/M 缩写）。

## 前端聊天页

- `web/src/lib/platform-models.ts` 的 `PlatformModel` 加 `context_limit: number | null`。
- `ChatPage.tsx` 顶层：平台聊天模式（`settings.chatMode === "platform"` 且非工蜂）时拉取一次 `listPlatformModels("chat")`，memo 成 `Map<model, context_limit>`；失败静默（回落关键词表）。
- 上限取值：`平台模式下 map.get(settings.model)（非空且 >0）` → 用它；否则 `contextLimit(settings.model)` 关键词表。显示逻辑其余不变（formatTokens 已支持 M）。

## 不做的事

- BYOK 模式的用户自定义上限。
- image 类模型的上下文（UI 只在 chat 流程用到）。
- 不改关键词表本身。

## 验证

- `cargo check`、web/ 下 `bun run build` + `bun run lint`（不新增 error）通过。
- 运行时：管理端给某模型配 context_limit（如 1000000）→ 聊天页选该平台模型，显示 `/ 1M`；清空配置后回落关键词表；BYOK 模式不受影响。
