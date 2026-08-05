import { useEffect, useRef, useState } from "react"
import { Brain, ChevronRight } from "lucide-react"
import { cn } from "@/lib/utils"

/** 推理模型的思考过程折叠区，显示在 assistant 气泡正文之上。
 *
 * 内容不落库（messages 表没有对应列），刷新页面后消失——这是有意的取舍，
 * 见 chat-stream.ts 的 `onReasoning`。
 */
export function ReasoningBlock({
  reasoning,
  elapsedMs,
}: {
  reasoning: string
  /** 思考耗时。正文首字到达时定格；中途停止生成时由调用方兜底定格。
   * 有值即代表思考已结束——用它当唯一的结束标志，避免「思考完但正文为空」
   * （用户点了停止）时永远停在「思考中…」。 */
  elapsedMs?: number
}) {
  const done = elapsedMs !== undefined
  // null 表示「跟随自动」：思考中展开、正文开始后收起。用户点过一次之后由
  // manual 接管，后续 delta 不会再把它弹开或强制收起。派生而非在 effect 里
  // 写 state，避免 react-hooks/set-state-in-effect 告警。
  const [manual, setManual] = useState<boolean | null>(null)
  const open = manual ?? !done
  const bodyRef = useRef<HTMLDivElement>(null)

  // 思考流式增长时跟随滚动到底部，让最新一行始终可见。
  useEffect(() => {
    if (!open || done) return
    const el = bodyRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [reasoning, open, done])

  const label = done
    ? elapsedMs != null
      ? `已思考 ${Math.max(1, Math.round(elapsedMs / 1000))}s`
      : "已思考"
    : "思考中…"

  return (
    <div className="not-prose mb-2">
      <button
        type="button"
        onClick={() => setManual(!open)}
        className={cn(
          "flex items-center gap-1 rounded text-xs text-muted-foreground",
          "transition-colors hover:text-foreground"
        )}
      >
        <ChevronRight
          className={cn("size-3 transition-transform", open && "rotate-90")}
        />
        <Brain className={cn("size-3", !done && "animate-pulse")} />
        <span>{label}</span>
      </button>
      {open && (
        <div
          ref={bodyRef}
          className={cn(
            "mt-1 max-h-64 overflow-y-auto border-l-2 border-border/70 pl-3",
            "whitespace-pre-wrap break-words text-xs leading-relaxed",
            "text-muted-foreground/90"
          )}
        >
          {reasoning}
          {!done && (
            <span className="ml-0.5 inline-block animate-pulse">▌</span>
          )}
        </div>
      )}
    </div>
  )
}
