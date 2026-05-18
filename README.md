# NovaChat

Rust Axum + React 的多模型聊天 / 图像生成平台，内置积分计费。

## 计费模型（v2，2026-05）

v1 的「全局共享上游 + cost_chat / cost_image 两档定价」已被替换为：

- **多渠道（Channel）路由**：每种协议（OpenAI / Claude / Gemini）可配置 N 个上游 channel；按 `priority` 升序 fallback，第一个成功的 channel 处理请求。
- **按模型定价（ModelPricing）白名单**：`model_pricing` 表里没有的 model 直接 403 `NotWhitelisted`；`cost_credits=0` 表示放行不扣费。
- **扣费链路**：`try_deduct_for_model` 在请求前查 `model_pricing` 一次性扣；失败全部 channel 后通过 `cost_for_model` 二次查价精确退款。
- **Ledger reason 格式**：成功 `chat_<model>@<channel_name>`，全失败退款 `refund_chat_<model>_all_failed`。

### 数据流

```
POST /api/chat {model:"gpt-5",...}
 → lookup_pricing("gpt-5")    → cost=3, kind="chat"
 → try_deduct_for_model       → balance -= 3
 → list_channels_for_model    → [ch1(p=10), ch2(p=20)]
 → try ch1 → 503 → try ch2 → 200 OK stream
 → ledger: -3 "chat_gpt-5@Azure"
全失败 → grant(+3 "refund_chat_gpt-5_all_failed") → 502
```

### 后台管理

`Admin → Channels`：CRUD 渠道、启用/停用、绑定 model 列表（每行 `model` 或 `model=client_model=upstream_id`）。
`Admin → Pricing`：CRUD model 白名单 + 单价。

旧的「Shared Backend」面板与 KV (`shared_chat_openai_*` 等) 暂时保留只用于历史 seed，新链路不再读它们。

## 三库并行 migration

每次 schema 变更**必须**同时落地三份同号 SQL：
- `migrations/sqlite/NNNN_*.sql` — `INTEGER` + `TEXT DEFAULT (datetime('now'))`
- `migrations/postgres/NNNN_*.sql` — `BIGSERIAL / BOOLEAN / TIMESTAMPTZ DEFAULT NOW()`
- `migrations/mysql/NNNN_*.sql` — `BIGINT AUTO_INCREMENT / TINYINT(1) / DATETIME(3) DEFAULT CURRENT_TIMESTAMP(3) ENGINE=InnoDB utf8mb4_unicode_ci`

并把文件名追加到 `src/db.rs` 三个 `MIGRATIONS_*` 数组。

跨方言 SQL 助手：
- `db::q(kind, sql)` — Postgres 自动 `?` → `$1..$N`
- `db::bool_as_int(kind, col)` / `db::bool_true(kind)` — bool 列读 / 写

## 本地开发

```bash
cargo run                # 后端 :3001
cd web && bun run dev    # 前端 :5173 → /api 走 vite proxy
```

测试在本地跑：`cargo test` + `cd web && npx tsc -b`。CI 只负责构建镜像、不跑测试。

## 部署

镜像 tag：`docker.yunnet.top/github/yiranxiaohui/novachat:sha-XXX`。

- push `main` → GHA self-hosted 构建并推 registry
- prod 机器：`docker compose pull && docker compose up -d`（**禁本地 build**）
- migration 在容器启动时自动跑

详见 `docs/plans/2026-05-18-multi-channel-pricing.md` 阶段 5 部署 checklist。
