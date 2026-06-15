import { useEffect, useRef, useState } from "react"
import ReactMarkdown from "react-markdown"
import remarkGfm from "remark-gfm"
import { ClipboardCheck, Copy } from "lucide-react"
import { cn } from "@/lib/utils"

export function CodeBlock({ children, ...rest }: React.HTMLAttributes<HTMLPreElement>) {
  const preRef = useRef<HTMLPreElement>(null)
  const [done, setDone] = useState(false)
  const timerRef = useRef<number | null>(null)
  useEffect(
    () => () => {
      if (timerRef.current) window.clearTimeout(timerRef.current)
    },
    []
  )
  async function onCopy(e: React.MouseEvent) {
    e.stopPropagation()
    e.preventDefault()
    const text = preRef.current?.innerText ?? ""
    try {
      await navigator.clipboard.writeText(text)
    } catch {
      // fallback for non-secure contexts
      const ta = document.createElement("textarea")
      ta.value = text
      ta.style.position = "fixed"
      ta.style.opacity = "0"
      document.body.appendChild(ta)
      ta.select()
      try {
        document.execCommand("copy")
      } catch {
        /* noop */
      }
      document.body.removeChild(ta)
    }
    setDone(true)
    if (timerRef.current) window.clearTimeout(timerRef.current)
    timerRef.current = window.setTimeout(() => setDone(false), 1500)
  }
  return (
    <div className="group/code relative my-2">
      <button
        type="button"
        onClick={onCopy}
        title={done ? "已复制" : "复制代码"}
        aria-label={done ? "已复制" : "复制代码"}
        className={cn(
          "absolute right-2 top-2 z-10 inline-flex items-center gap-1 rounded-md border border-border bg-background/80 px-2 py-1 text-xs backdrop-blur hover:bg-accent",
          "opacity-0 transition-opacity group-hover/code:opacity-100 focus-visible:opacity-100",
          done && "opacity-100"
        )}
      >
        {done ? (
          <ClipboardCheck className="size-3 text-emerald-500" />
        ) : (
          <Copy className="size-3" />
        )}
        {done ? "已复制" : "复制"}
      </button>
      <pre ref={preRef} {...rest}>
        {children}
      </pre>
    </div>
  )
}

const PROSE = cn(
  "prose prose-sm dark:prose-invert min-w-0 max-w-none",
  "[&_pre]:max-w-full [&_pre]:overflow-x-auto [&_pre]:whitespace-pre",
  "[&_*]:break-words [&_a]:break-all",
  "prose-pre:bg-muted prose-pre:text-foreground prose-pre:border prose-pre:border-border",
  "[&_pre_code]:!text-foreground [&_pre_code]:!bg-transparent",
  "prose-code:rounded prose-code:bg-muted prose-code:px-1 prose-code:py-0.5 prose-code:text-[0.85em] prose-code:font-normal prose-code:before:content-none prose-code:after:content-none"
)

/** 通用 markdown 渲染（不含聊天页特有的图片发布浮层）。 */
export function Markdown({ children, className }: { children: string; className?: string }) {
  return (
    <div className={cn(PROSE, className)}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          pre: ({ node: _node, ...props }) => <CodeBlock {...props} />,
        }}
      >
        {children || "…"}
      </ReactMarkdown>
    </div>
  )
}
