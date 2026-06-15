import { useEffect, useRef, useState } from "react"
import { Link } from "react-router-dom"
import { ArrowLeft, Bot, Check, Copy, Send, Trash2, Wrench, X } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { cn } from "@/lib/utils"
import { workerApi, sendAgentMessage, type Worker, type AgentEvent } from "@/lib/worker"

type LogItem = AgentEvent & { id: number; resolved?: boolean }

export default function WorkerPage() {
  const [workers, setWorkers] = useState<Worker[]>([])
  const [token, setToken] = useState<string | null>(null)
  const [pairing, setPairing] = useState(false)
  const [copied, setCopied] = useState(false)
  const [sel, setSel] = useState<number | null>(null)
  const [model, setModel] = useState("claude-opus-4-8")
  const [auto, setAuto] = useState(false)
  const [input, setInput] = useState("")
  const [log, setLog] = useState<LogItem[]>([])
  const [sid, setSid] = useState<number | null>(null)
  const [sending, setSending] = useState(false)
  const seq = useRef(0)
  const endRef = useRef<HTMLDivElement>(null)
  const abortRef = useRef<(() => void) | null>(null)

  const refresh = () => workerApi.list().then(setWorkers).catch(() => {})

  useEffect(() => {
    refresh()
    const t = setInterval(refresh, 5000)
    return () => clearInterval(t)
  }, [])

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth" })
  }, [log])

  // 离开页面或切换工蜂时中断进行中的会话
  useEffect(() => {
    return () => abortRef.current?.()
  }, [])

  const push = (e: AgentEvent) =>
    setLog((l) => [...l, { ...e, id: seq.current++ }])

  const deployCmd = (tok: string) =>
    `NOVACHAT_WORKER_URL=wss://你的域名/api/worker/connect NOVACHAT_WORKER_TOKEN=${tok} ./novachat-worker`

  async function pair() {
    if (pairing) return
    setPairing(true)
    try {
      const r = await workerApi.pair()
      setToken(r.token)
      setCopied(false)
      refresh()
    } catch (e) {
      push({ type: "error", data: `生成配对码失败：${String(e)}` })
    } finally {
      setPairing(false)
    }
  }

  async function copyDeploy() {
    if (!token) return
    try {
      await navigator.clipboard.writeText(deployCmd(token))
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch {
      /* 忽略剪贴板失败 */
    }
  }

  function selectWorker(id: number) {
    abortRef.current?.()
    abortRef.current = null
    setSel(id)
    setSid(null)
    setLog([])
    setSending(false)
  }

  async function removeWorker(id: number) {
    await workerApi.remove(id).catch(() => {})
    if (sel === id) {
      abortRef.current?.()
      abortRef.current = null
      setSel(null)
      setSid(null)
      setLog([])
      setSending(false)
    }
    refresh()
  }

  async function send() {
    if (sel == null || !input.trim() || sending) return
    let s = sid
    try {
      if (s == null) {
        s = (await workerApi.createSession(sel)).id
        setSid(s)
      }
    } catch (e) {
      push({ type: "error", data: `创建会话失败：${String(e)}` })
      return
    }
    const text = input.trim()
    setInput("")
    push({ type: "text", data: `🧑 ${text}` })
    setSending(true)
    abortRef.current = sendAgentMessage(
      s, { worker_id: sel, model, text, auto_approve: auto },
      (e) => {
        push(e)
        if (e.type === "done" || e.type === "error") {
          setSending(false)
          abortRef.current = null
        }
      }
    )
  }

  async function decide(item: LogItem, decision: boolean) {
    if (sid == null) return
    await workerApi.approve(sid, item.data?.call_id, decision).catch(() => {})
    setLog((l) => l.map((x) => (x.id === item.id ? { ...x, resolved: true } : x)))
  }

  return (
    <div className="mx-auto flex min-h-svh max-w-3xl flex-col gap-6 p-4 sm:p-6">
      <header className="flex items-center gap-2">
        <Button asChild variant="ghost" size="icon">
          <Link to="/" title="返回对话">
            <ArrowLeft className="size-4" />
          </Link>
        </Button>
        <Bot className="size-5 text-primary" />
        <h1 className="text-lg font-semibold">工蜂</h1>
        <span className="text-xs text-muted-foreground">远程 agent，操控你自己服务器上的工蜂</span>
      </header>

      {/* 工蜂管理 */}
      <section className="space-y-3">
        <div className="flex flex-wrap items-center gap-2">
          <Button size="sm" onClick={pair} disabled={pairing}>
            {pairing ? "生成中…" : "生成配对码"}
          </Button>
          <span className="text-xs text-muted-foreground">
            部署到你的服务器，连回本站受你操控
          </span>
        </div>

        {token && (
          <div className="space-y-2 rounded-md border bg-muted/40 p-3 text-sm">
            <div className="font-medium">配对码（仅显示一次，请妥善保存）</div>
            <code className="block break-all rounded bg-background p-2 font-mono text-xs">
              {token}
            </code>
            <div className="text-xs text-muted-foreground">部署命令：</div>
            <div className="flex items-start gap-2">
              <code className="block flex-1 break-all rounded bg-background p-2 font-mono text-xs">
                {deployCmd(token)}
              </code>
              <Button variant="outline" size="icon" className="shrink-0" onClick={copyDeploy} title="复制部署命令">
                {copied ? <Check className="size-4 text-green-500" /> : <Copy className="size-4" />}
              </Button>
            </div>
          </div>
        )}

        <ul className="space-y-1">
          {workers.map((w) => (
            <li
              key={w.id}
              className={cn(
                "flex items-center gap-2 rounded-md border px-3 py-2 text-sm transition-colors",
                sel === w.id && "border-primary bg-accent/40"
              )}
            >
              <span
                className={cn(
                  "size-2.5 shrink-0 rounded-full",
                  w.online ? "bg-green-500" : "bg-muted-foreground/50"
                )}
                aria-hidden
              />
              <button
                className="flex-1 truncate text-left hover:underline"
                onClick={() => selectWorker(w.id)}
              >
                {w.name}
              </button>
              <span className="shrink-0 text-xs text-muted-foreground">
                {w.online ? "在线" : "离线"}
              </span>
              <Button
                variant="ghost"
                size="icon"
                className="shrink-0"
                onClick={() => removeWorker(w.id)}
                title="删除工蜂"
              >
                <Trash2 className="size-4" />
              </Button>
            </li>
          ))}
          {workers.length === 0 && (
            <li className="rounded-md border border-dashed px-3 py-4 text-center text-sm text-muted-foreground">
              还没有工蜂，点上面「生成配对码」并部署。
            </li>
          )}
        </ul>
      </section>

      {/* Agent 会话 */}
      {sel != null && (
        <section className="flex flex-1 flex-col gap-3 border-t pt-4">
          <div className="flex flex-wrap items-center gap-4 text-sm">
            <div className="flex items-center gap-2">
              <Label htmlFor="worker-model" className="text-muted-foreground">模型</Label>
              <Input
                id="worker-model"
                className="h-8 w-52"
                value={model}
                onChange={(e) => setModel(e.target.value)}
              />
            </div>
            <label className="flex cursor-pointer items-center gap-1.5">
              <input
                type="checkbox"
                className="size-4 accent-primary"
                checked={auto}
                onChange={(e) => setAuto(e.target.checked)}
              />
              <span>自动批准</span>
            </label>
          </div>

          <div className="min-h-48 flex-1 space-y-2 overflow-auto rounded-md border p-3 text-sm">
            {log.length === 0 && (
              <div className="text-muted-foreground">发条消息让工蜂开始工作。</div>
            )}
            {log.map((item) => (
              <Row key={item.id} item={item} onDecide={decide} />
            ))}
            <div ref={endRef} />
          </div>

          <div className="flex gap-2">
            <Input
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault()
                  send()
                }
              }}
              placeholder="让工蜂做点什么…"
            />
            <Button onClick={send} disabled={sending || !input.trim()} className="gap-1.5">
              <Send className="size-4" /> 发送
            </Button>
          </div>
        </section>
      )}
    </div>
  )
}

function Row({ item, onDecide }: { item: LogItem; onDecide: (i: LogItem, d: boolean) => void }) {
  switch (item.type) {
    case "text":
      return (
        <div className="whitespace-pre-wrap leading-relaxed">
          {typeof item.data === "string" ? item.data : JSON.stringify(item.data)}
        </div>
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
      return (
        <pre className="overflow-auto whitespace-pre-wrap rounded bg-muted p-2 text-xs">
          {item.data?.output ?? ""}
        </pre>
      )
    case "error":
      return (
        <div className="text-red-600 dark:text-red-400">
          ⚠ {typeof item.data === "string" ? item.data : JSON.stringify(item.data)}
        </div>
      )
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
