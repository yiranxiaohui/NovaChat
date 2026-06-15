# 工蜂工具块重设计（IN/OUT 卡片）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把工蜂工具调用与结果合并成 Claude-Code 风格的统一卡片（状态点 + 工具名 + 推导描述 + IN/OUT 段，OUT 超长折叠），其余事件保持。

**Architecture:** 在 `WorkerEvents.tsx` 加纯函数 `groupWorkerLog()` 把扁平事件按位置配成工具卡节点，新增 `ToolCard` 渲染卡片，导出 `WorkerLog` 组件统一渲染并替换 ChatPage 里手写的 `.map(WorkerRow)`；`replayMessages` 给 tool_result 补 `ok` 供状态点上色。纯前端，随服务端镜像上线。

**Tech Stack:** React 19 + TypeScript + Tailwind 4 + lucide-react + 现有共享 `Markdown` 组件。

**关于测试：** 仓库无测试运行器。前端用 `bunx tsc -b` 类型检查；功能靠手动验证。每个任务以 tsc 通过 + 提交收尾。

---

## File Structure

修改：
- `web/src/lib/worker.ts` — `replayMessages` 的 tool_result 补 `ok` 字段。
- `web/src/components/app/WorkerEvents.tsx` — 加 `groupWorkerLog`、`summarizeTool`、`renderInput`、`ToolCard`，导出 `WorkerLog`；保留 text/error/done/approval 渲染。
- `web/src/pages/ChatPage.tsx` — 工蜂渲染分支换成 `<WorkerLog .../>`。

---

## Task 1: replayMessages 补 ok 字段

**Files:**
- Modify: `web/src/lib/worker.ts`（tool 分支，约 190-210 行）

- [ ] **Step 1: 解析并带上 ok**

把 tool 分支改为同时取 `ok`。当前末尾是 `out.push({ type: "tool_result", data: { output } })`。在 `let output = m.content` 后加 `let ok: boolean | undefined`，在 try 内解析 `v.ok`，push 时带上：

```ts
    if (m.role === "tool") {
      // 存储格式: {tool_use_id, ok, output}
      let output = m.content
      let ok: boolean | undefined
      try {
        const v = JSON.parse(m.content) as Record<string, unknown>
        if (typeof v.ok === "boolean") ok = v.ok
        if (typeof v.output === "string") {
          output = v.output
        } else if (typeof v.content === "string") {
          // 兜底：Anthropic 风格 content 字符串
          output = v.content
        } else if (Array.isArray(v.content)) {
          // 兜底：Anthropic 风格 content block 数组，拼接 text 字段
          output = (v.content as Array<Record<string, unknown>>)
            .map((blk) => (typeof blk.text === "string" ? blk.text : ""))
            .join("")
        }
      } catch {
        /* 保留原始文本 */
      }
      out.push({ type: "tool_result", data: { ok, output } })
      continue
    }
```

> 仅改这一个分支。其余 replayMessages 逻辑不动。

- [ ] **Step 2: 类型检查**

Run: `bunx tsc -b`（在 `web/`）
Expected: 无类型错误。

- [ ] **Step 3: Commit**

```bash
git add web/src/lib/worker.ts
git commit -m "feat(web): 回看的 tool_result 带上 ok 供状态点上色"
```

---

## Task 2: WorkerEvents 重写为卡片 + 分组

**Files:**
- Modify: `web/src/components/app/WorkerEvents.tsx`（整体重写，保留 `WorkerLogItem`、`ToolResult`、text/error/done/approval 渲染）

- [ ] **Step 1: 重写文件**

完整新内容（保留现有 `ToolResult` 不变；新增 `summarizeTool`/`renderInput`/`StatusDot`/`ToolCard`/`groupWorkerLog`/`WorkerLog`；把现 `WorkerRow` 降级为只处理 raw 四类的内部 `RawRow`）：

```tsx
import { useState } from "react"
import { Check, Wrench, X } from "lucide-react"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"
import { Markdown } from "@/components/app/Markdown"
import type { AgentEvent } from "@/lib/worker"

export type WorkerLogItem = AgentEvent & { id: number; resolved?: boolean }

const COLLAPSE_LINES = 12

/** 工具结果：≤12 行完整展开；超长默认 clamp + 渐隐 + 展开/收起切换。 */
function ToolResult({ output }: { output: string }) {
  const lineCount = output ? output.split("\n").length : 0
  const long = lineCount > COLLAPSE_LINES
  const [open, setOpen] = useState(false)
  const collapsed = long && !open
  return (
    <div className="relative">
      <pre
        className={cn(
          "overflow-auto whitespace-pre-wrap rounded bg-muted p-2 text-xs",
          collapsed && "max-h-48 overflow-hidden"
        )}
      >
        {output}
      </pre>
      {collapsed && (
        <div className="pointer-events-none absolute inset-x-0 bottom-0 h-10 rounded-b bg-gradient-to-t from-muted to-transparent" />
      )}
      {long && (
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          className="mt-1 text-xs text-primary hover:underline"
        >
          {open ? "收起" : `展开（共 ${lineCount} 行）`}
        </button>
      )}
    </div>
  )
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function asStr(v: any): string {
  return typeof v === "string" ? v : ""
}

/** 卡片头一句话描述：从入参推导。无可显示信息时返回空串。 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function summarizeTool(tool: string, input: any): string {
  const i = input ?? {}
  if (tool === "shell") {
    const c = asStr(i.command)
    return c.length > 80 ? c.slice(0, 80) + "…" : c
  }
  if (tool === "read_file") return asStr(i.path)
  if (tool === "write_file") {
    const p = asStr(i.path)
    const n = asStr(i.content).length
    return p ? `${p}（${n} 字节）` : ""
  }
  return ""
}

/** IN 段内容：尽量精简，不展开 write_file 的整段 content。 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function renderInput(tool: string, input: any): string {
  const i = input ?? {}
  if (tool === "shell") return asStr(i.command)
  if (tool === "read_file") return asStr(i.path)
  if (tool === "write_file") {
    const p = asStr(i.path)
    const n = asStr(i.content).length
    return `${p}（写入 ${n} 字节）`
  }
  try {
    return JSON.stringify(input)
  } catch {
    return ""
  }
}

/** 状态点：运行中=琥珀脉冲，成功=绿，失败=红，未知=灰。 */
function StatusDot({ ok, running }: { ok?: boolean; running: boolean }) {
  return (
    <span
      aria-hidden
      className={cn(
        "mt-1 size-2.5 shrink-0 rounded-full",
        running
          ? "animate-pulse bg-amber-500"
          : ok === true
            ? "bg-green-500"
            : ok === false
              ? "bg-red-500"
              : "bg-muted-foreground/50"
      )}
    />
  )
}

/** 一次工具调用的统一卡片：状态点 + 工具名 + 描述 + IN + OUT。 */
function ToolCard({
  call,
  result,
}: {
  call: WorkerLogItem
  result: WorkerLogItem | null
}) {
  const tool = asStr(call.data?.tool) || "tool"
  const input = call.data?.input
  const desc = summarizeTool(tool, input)
  const inText = renderInput(tool, input)
  const running = result == null
  const ok = result?.data?.ok as boolean | undefined
  const output = asStr(result?.data?.output)
  return (
    <div className="rounded-lg border border-border/70 bg-card/40 p-2.5">
      <div className="flex items-start gap-2">
        <StatusDot ok={ok} running={running} />
        <Wrench className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />
        <span className="font-medium">{tool}</span>
        {desc && (
          <span className="min-w-0 flex-1 truncate text-muted-foreground">· {desc}</span>
        )}
      </div>
      {inText && (
        <div className="mt-2 flex gap-2 text-xs">
          <span className="shrink-0 select-none pt-0.5 font-mono text-[10px] text-muted-foreground">
            IN
          </span>
          <code className="min-w-0 flex-1 whitespace-pre-wrap break-all rounded bg-muted px-2 py-1">
            {inText}
          </code>
        </div>
      )}
      {result && (
        <div className="mt-2 flex gap-2 text-xs">
          <span className="shrink-0 select-none pt-0.5 font-mono text-[10px] text-muted-foreground">
            OUT
          </span>
          <div className="min-w-0 flex-1">
            <ToolResult output={output} />
          </div>
        </div>
      )}
    </div>
  )
}

/** 非工具事件渲染：text / error / done / approval_required。 */
function RawRow({
  item,
  onDecide,
}: {
  item: WorkerLogItem
  onDecide: (i: WorkerLogItem, decision: boolean) => void
}) {
  switch (item.type) {
    case "text":
      return (
        <Markdown>
          {typeof item.data === "string" ? item.data : JSON.stringify(item.data)}
        </Markdown>
      )
    case "error": {
      const msg = typeof item.data === "string" ? item.data : JSON.stringify(item.data)
      return (
        <div className="text-red-600 dark:text-red-400">
          <Markdown>{`⚠ ${msg}`}</Markdown>
        </div>
      )
    }
    case "done":
      return <div className="py-1 text-center text-xs text-muted-foreground">— 完成 —</div>
    case "approval_required":
      return (
        <div className="rounded-md border border-yellow-400 bg-yellow-50 p-2 dark:border-yellow-700 dark:bg-yellow-950/30">
          <div className="text-xs">
            需批准 <b>{item.data?.tool}</b>：
            <code className="break-all">{JSON.stringify(item.data?.input)}</code>
          </div>
          <div className="mt-2 flex gap-2">
            <Button
              size="sm"
              variant="outline"
              className="gap-1"
              disabled={item.resolved}
              onClick={() => onDecide(item, true)}
            >
              <Check className="size-3.5" /> 批准
            </Button>
            <Button
              size="sm"
              variant="outline"
              className="gap-1"
              disabled={item.resolved}
              onClick={() => onDecide(item, false)}
            >
              <X className="size-3.5" /> 拒绝
            </Button>
            {item.resolved && (
              <span className="self-center text-xs text-muted-foreground">已处理</span>
            )}
          </div>
        </div>
      )
    default:
      return null
  }
}

type ToolNode = { kind: "tool"; id: number; call: WorkerLogItem; result: WorkerLogItem | null }
type RawNode = { kind: "raw"; id: number; item: WorkerLogItem }
type WorkerNode = ToolNode | RawNode

/**
 * 把扁平事件分组成渲染节点：tool_call 与紧随其后的 tool_result 按位置配对成一张卡。
 * 假设后端串行执行工具（call→result 相邻），故 tool_result 归入最近一个 result 仍为 null 的工具卡。
 * text/error/done/approval_required 作为独立 raw 节点。落单的 tool_result 退化为无调用的卡（仅 OUT）。
 */
export function groupWorkerLog(items: WorkerLogItem[]): WorkerNode[] {
  const nodes: WorkerNode[] = []
  for (const item of items) {
    if (item.type === "tool_call") {
      nodes.push({ kind: "tool", id: item.id, call: item, result: null })
    } else if (item.type === "tool_result") {
      // 找最近一个未配对的工具卡
      let attached = false
      for (let k = nodes.length - 1; k >= 0; k--) {
        const n = nodes[k]
        if (n.kind === "tool" && n.result == null) {
          n.result = item
          attached = true
          break
        }
      }
      if (!attached) {
        // 落单结果：构造一个仅有 OUT 的卡（call 用占位）
        nodes.push({
          kind: "tool",
          id: item.id,
          call: { ...item, type: "tool_call", data: { tool: "", input: undefined } },
          result: item,
        })
      }
    } else {
      nodes.push({ kind: "raw", id: item.id, item })
    }
  }
  return nodes
}

/** 工蜂事件列表：分组后渲染工具卡与其余事件；空态提示。 */
export function WorkerLog({
  items,
  onDecide,
}: {
  items: WorkerLogItem[]
  onDecide: (i: WorkerLogItem, decision: boolean) => void
}) {
  if (items.length === 0) {
    return <div className="text-muted-foreground">发条消息让工蜂开始工作。</div>
  }
  const nodes = groupWorkerLog(items)
  return (
    <div className="space-y-2">
      {nodes.map((n) =>
        n.kind === "tool" ? (
          <ToolCard key={n.id} call={n.call} result={n.result} />
        ) : (
          <RawRow key={n.id} item={n.item} onDecide={onDecide} />
        )
      )}
    </div>
  )
}
```

> 注意：移除了对外导出的 `WorkerRow`（ChatPage 将改用 `WorkerLog`，Task 3）。若其它文件 import 了 `WorkerRow`，Task 3 的 tsc 会暴露——但仅 ChatPage 用它。

- [ ] **Step 2: 类型检查**

Run: `bunx tsc -b`（在 `web/`）
Expected: 仅可能报 ChatPage 还在 import 已删除的 `WorkerRow`（Task 3 修复）。WorkerEvents.tsx 本身无错。若想本任务内 tsc 全绿，可与 Task 3 连续做后再跑。

- [ ] **Step 3: Commit**

```bash
git add web/src/components/app/WorkerEvents.tsx
git commit -m "feat(web): 工蜂工具块重做为 IN/OUT 卡片 + 事件分组"
```

---

## Task 3: ChatPage 改用 WorkerLog

**Files:**
- Modify: `web/src/pages/ChatPage.tsx`（import 行 74；渲染分支约 1735-1745）

- [ ] **Step 1: 换 import**

把第 74 行：
```tsx
import { WorkerRow, type WorkerLogItem } from "@/components/app/WorkerEvents"
```
改为：
```tsx
import { WorkerLog, type WorkerLogItem } from "@/components/app/WorkerEvents"
```

- [ ] **Step 2: 换渲染分支**

把工蜂渲染分支（约 1735-1745）：
```tsx
            {workerMode ? (
              <div className="space-y-2">
                {workerLog.length === 0 && (
                  <div className="text-muted-foreground">
                    发条消息让工蜂开始工作。
                  </div>
                )}
                {workerLog.map((item) => (
                  <WorkerRow key={item.id} item={item} onDecide={decideWorker} />
                ))}
              </div>
            ) : (
```
改为：
```tsx
            {workerMode ? (
              <WorkerLog items={workerLog} onDecide={decideWorker} />
            ) : (
```

> 空态已移入 `WorkerLog`，故此处不再写空态。其余工蜂逻辑（state/effect/handler）一律不动。

- [ ] **Step 3: 类型检查**

Run: `bunx tsc -b`（在 `web/`）
Expected: 全绿，无 `WorkerRow` 悬空引用。

- [ ] **Step 4: 手动验证**

启动 server（需在线工蜂；用 Windows/Linux 工蜂均可）：
1. 发 `shell`（dir/ls）：看到卡片头 `🔧 shell · <命令>`、IN 段、OUT 段；超长输出折叠可展开；运行中→完成时状态点由琥珀变绿。
2. 故意跑个失败命令：状态点变红。
3. `read_file`/`write_file`：描述/IN 显示路径（写入附字节数）。
4. 触发需批准：approval 块正常，批准/拒绝生效。
5. 切到历史工蜂会话回看：工具卡分组正确、状态点按 ok 上色。
6. 普通对话无回归。

- [ ] **Step 5: Commit**

```bash
git add web/src/pages/ChatPage.tsx
git commit -m "feat(web): 聊天页工蜂渲染改用 WorkerLog 卡片组件"
```

---

## Final Verification

- [ ] `bunx tsc -b` 全绿。
- [ ] 手动走查工具卡（IN/OUT/折叠/状态点）、approval、回看分组、普通对话无回归。
- [ ] 使用 superpowers:verification-before-completion 复核。
