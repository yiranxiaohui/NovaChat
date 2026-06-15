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
