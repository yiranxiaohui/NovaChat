# 工蜂工具块重设计（Claude-Code 风格 IN/OUT 卡片）— 设计文档

日期：2026-06-16
分支：`worktree-worker-tool-cards`

## 背景与目标

工蜂当前渲染（`web/src/components/app/WorkerEvents.tsx`）：`tool_call` 是蓝色内联行（`🔧 shell {"command":"dir"}`），`tool_result` 是独立灰色 `<pre>`，两者分离。视觉零散，不如 VSCode Claude Code 插件那样把「一次工具调用」收成一张带 IN/OUT 的卡片清晰。

目标：把工具调用与其结果**合并成统一卡片**（状态点 + 工具名 + 一句话描述 + IN 段 + OUT 段），其余事件（text/error/done/approval）保持。纯前端改动，随服务端镜像上线。

非目标：不改后端 agent 循环；不改工蜂二进制；不引入新依赖；不把 approval 并入卡片。

## 已确认决策

- 工具块形态：**统一 IN/OUT 卡片**（像 Claude Code）。
- 卡片头描述：**从入参推导**（无 LLM 摘要）。
- approval_required：**保持独立块**，仅轻度配色统一。

## 事件配对（分组）

`workerLog` 是扁平 `WorkerLogItem[]`。新增纯函数 `groupWorkerLog(items)` 产出渲染节点列表：

- 遇 `tool_call` → 压入一个工具卡节点 `{kind:"tool", call, result:null, id}`。
- 遇 `tool_result` → 附到**最近一个 result 仍为 null 的工具卡节点**（按位置配对）。理由：实时 SSE 与回看里 call→result 都是相邻顺序；且事件本身不带 call_id（只有 `approval_required` 带），故用「最近未配对调用」配对最稳；工蜂后端串行执行工具，不会并发交错。
- 遇 `text`/`error`/`done`/`approval_required` → 原样作为独立节点（`{kind:"raw", item, id}`）。

节点 `id` 取该节点首个事件的 `id`，作为 React key。

## 卡片结构（ToolCard）

```
● 🔧 shell · 查看当前目录
  IN   dir
  OUT  Volume in drive D ...
       2026/06/16  any-mail …
       展开（共 22 行）
```

- **状态点**：
  - 结果未到（`result == null`）→ 琥珀色 + 脉冲（`animate-pulse`），表示运行中。
  - `result.data.ok === true` → 绿色。
  - `result.data.ok === false` → 红色。
  - `ok` 缺失（回看旧数据若无）→ 中性灰。
- **工具名**：`call.data.tool`，等宽/中等字重。
- **描述推导** `summarizeTool(tool, input)`：
  - `shell` → `input.command`（截断到 ~80 字符）。
  - `read_file` → `input.path`。
  - `write_file` → `input.path`（若有 content，附 `（N 字节）`）。
  - 其它/缺失 → 空（不显示描述）。
- **IN 段**：等宽小字。`shell` 显 `command`；`read_file` 显 `path`；`write_file` 显 `path`（**不展开整段 content**，附 `（写入 N 字节）`）；未知工具回退 `JSON.stringify(input)`。
- **OUT 段**：`result.data.output`，复用现 `ToolResult` 的折叠逻辑（>12 行 → clamp `max-h-48` + 底部渐隐 + 「展开（共 N 行）/收起」）。`result == null` 时 OUT 段不渲染（仅状态点显示运行中）。

## 其余节点渲染（保持）

- `text` → `<Markdown>`（不变）。
- `error` → 红色 `<Markdown>`（不变）。
- `done` → 「— 完成 —」（不变）。
- `approval_required` → 现有黄色待批准块 + 批准/拒绝按钮（`onDecide`），仅做轻度配色统一，按钮逻辑不变。

## 组件边界

- `WorkerEvents.tsx` 导出一个 `WorkerLog({ items, onDecide })` 组件：内部 `groupWorkerLog(items)` 后遍历渲染节点（工具卡 / raw 节点）。它取代 ChatPage 里手写的 `workerLog.map(item => <WorkerRow .../>)`。
- 内部组件：`ToolCard`（卡片）、`ToolResult`（OUT 折叠，已存在，复用）、raw 节点复用现有 `WorkerRow` 的 text/error/done/approval 分支（可保留 `WorkerRow` 仅处理这四类，或内联）。
- `summarizeTool` / `renderInput` 为模块内纯 helper。

## 数据改动

`web/src/lib/worker.ts` `replayMessages`：tool_result 节点的 `data` 增加 `ok`（从存库 `{tool_use_id, ok, output}` 取 `v.ok`），使回看也能给状态点上色。实时 SSE 的 `tool_result` 已带 `ok`，无需改后端。

## ChatPage 改动

工蜂渲染分支：把
```tsx
{workerLog.map((item) => <WorkerRow key={item.id} item={item} onDecide={decideWorker} />)}
```
换成
```tsx
<WorkerLog items={workerLog} onDecide={decideWorker} />
```
空态提示（「发条消息让工蜂开始工作。」）移入 `WorkerLog`（`items.length === 0` 时渲染），ChatPage 不再单独写空态。其余工蜂逻辑不动。

## 错误处理 / 边界

- 落单的 `tool_result`（前面没有未配对 call，理论不出现）→ 作为 raw 节点回退渲染为一个无头卡（仅 OUT），不崩。
- `input` 解析异常 / 字段缺失 → 描述与 IN 走 `JSON.stringify` 回退。
- 运行中卡（无 result）在流结束（done/error）后仍可能保持「运行中」点——可接受（done 是整轮结束，单卡若没收到 result 说明被中断）。

## 测试与验证

仓库无测试运行器。`bunx tsc -b` 类型检查 + 手动：用在线工蜂发 `shell`(dir/ls)、`read_file`、`write_file`，确认卡片头/描述/IN/OUT/折叠/状态点颜色；触发一次需批准看 approval 块；回看历史确认分组与状态点；普通对话无关联、无回归。

## 风险

- 配对靠位置而非 id：若后端将来并发执行多工具会错配。当前后端串行，低风险；实现时加注释说明该假设。
- `WorkerEvents.tsx` 体量增加（加卡片+分组），仍是单一职责组件，可接受。
