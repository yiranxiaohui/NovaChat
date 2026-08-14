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

## S3 媒体存储

NovaChat 默认把图片、视频和头像保存在 `NOVACHAT_DATA_DIR`。可在
管理员后台的「媒体存储」页面中启用 AWS S3、Cloudflare R2、MinIO 等 S3 兼容
存储。页面支持连接测试，保存后立即生效，无需重启；Access Key 和 Secret Key
不会通过管理接口回显。

配置保存在数据目录下的 `novachat.toml`。也可以直接维护该文件：

```toml
database_url = "sqlite:///data/novachat.db"

[storage]
backend = "s3"
endpoint = "https://<account-id>.r2.cloudflarestorage.com" # AWS S3 可省略
region = "auto"                                            # AWS 填实际 region
bucket = "novachat-media"
access_key_id = "..."
secret_access_key = "..."
prefix = "novachat"
path_style = true                                           # 自定义 endpoint 默认 true
```

手动修改配置文件后需要重启 NovaChat。为兼容已有 Docker/Kubernetes 部署，仍支持
以下环境变量作为未配置 `[storage]` 时的后备方式；新部署推荐使用管理页面：

| 环境变量 | 说明 |
| --- | --- |
| `NOVACHAT_STORAGE_BACKEND` | 设为 `s3` 启用 S3；默认 `local` |
| `NOVACHAT_S3_ENDPOINT` | S3 兼容 endpoint；AWS S3 可省略 |
| `NOVACHAT_S3_REGION` | 区域，默认 `us-east-1` |
| `NOVACHAT_S3_BUCKET` | bucket 名称 |
| `NOVACHAT_S3_ACCESS_KEY_ID` | Access Key ID |
| `NOVACHAT_S3_SECRET_ACCESS_KEY` | Secret Access Key |
| `NOVACHAT_S3_SESSION_TOKEN` | 临时凭证的 session token（可选） |
| `NOVACHAT_S3_PREFIX` | 对象 key 前缀，默认 `novachat` |
| `NOVACHAT_S3_PATH_STYLE` | 是否使用 path-style，支持 `true/false` |

网页或 `novachat.toml` 中保存的配置优先于环境变量。凭证和区域也兼容标准的
`AWS_ACCESS_KEY_ID`、`AWS_SECRET_ACCESS_KEY`、
`AWS_SESSION_TOKEN`、`AWS_REGION` / `AWS_DEFAULT_REGION`。bucket 可以保持私有，
NovaChat 会代理读取并保留原有 `/api/images/...`、`/api/videos/...` 地址以及视频
Range 播放。启用后新图片、视频和头像只写入 S3；切换前的本地媒体仍可回退读取，
但不会自动上传或删除。普通聊天文档附件仍保存在本地 `files/` 目录。

## 部署

正式版本镜像 tag：`docker.yunnet.top/github/yiranxiaohui/novachat:X.Y.Z`。

- push `main` → GitHub Actions 构建开发镜像
- push `vX.Y.Z` → GitHub Actions 构建正式镜像与 Worker 多平台附件
- 两个发布工作流成功后，由 Codex 从可信服务器 SSH 部署生产环境
- migration 在容器启动时自动跑
- 默认版本策略只递增最后一位：`vX.Y.Z` → `vX.Y.(Z+1)`
