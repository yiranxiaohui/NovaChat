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

export function WorkerRow({
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
    case "tool_call":
      return (
        <div className="flex items-start gap-1.5 text-blue-600 dark:text-blue-400">
          <Wrench className="mt-0.5 size-3.5 shrink-0" />
          <span className="font-medium">{item.data?.tool}</span>
          <code className="break-all text-xs">{JSON.stringify(item.data?.input)}</code>
        </div>
      )
    case "tool_result":
      return <ToolResult output={item.data?.output ?? ""} />
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
