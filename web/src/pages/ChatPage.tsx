import { useEffect, useMemo, useRef, useState } from "react"
import { useNavigate, useParams } from "react-router-dom"
import { ArrowUp, Settings, Square } from "lucide-react"
import ReactMarkdown from "react-markdown"
import remarkGfm from "remark-gfm"
import { Button } from "@/components/ui/button"
import { Textarea } from "@/components/ui/textarea"
import { streamChat, type ChatMessage } from "@/lib/chat-stream"
import { cn } from "@/lib/utils"
import { useAuth } from "@/lib/auth-context"
import {
  loadSettings,
  saveSettings,
  type UpstreamSettings,
} from "@/lib/settings"
import { SettingsDialog } from "@/components/app/SettingsDialog"
import { Sidebar } from "@/components/app/Sidebar"
import { SystemPromptBar } from "@/components/app/SystemPromptBar"
import { PromptLibrary } from "@/components/app/PromptLibrary"
import { conversationsApi } from "@/lib/conversations"

function Bubble({ role, content }: ChatMessage) {
  const isUser = role === "user"
  return (
    <div className={cn("flex", isUser ? "justify-end" : "justify-start")}>
      <div
        className={cn(
          "max-w-[85%] rounded-2xl px-4 py-2.5 text-sm leading-relaxed",
          isUser
            ? "bg-primary text-primary-foreground"
            : "bg-muted text-foreground"
        )}
      >
        {isUser ? (
          <p className="whitespace-pre-wrap">{content}</p>
        ) : (
          <div className="prose prose-sm dark:prose-invert max-w-none prose-pre:bg-background prose-pre:border prose-pre:border-border">
            <ReactMarkdown remarkPlugins={[remarkGfm]}>
              {content || "…"}
            </ReactMarkdown>
          </div>
        )}
      </div>
    </div>
  )
}

export default function ChatPage() {
  const auth = useAuth()
  const user = auth.state.status === "authed" ? auth.state.user : null
  const nav = useNavigate()
  const { id: paramId } = useParams()
  const conversationId = paramId ? Number(paramId) : null

  const [settings, setSettings] = useState<UpstreamSettings>(() =>
    user
      ? loadSettings(user.id)
      : {
          protocol: "openai",
          baseUrl: "",
          apiKey: "",
          model: "",
          useProxy: true,
        }
  )
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [libraryOpen, setLibraryOpen] = useState(false)
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [systemPrompt, setSystemPrompt] = useState("")
  const [loadingMessages, setLoadingMessages] = useState(false)
  const [input, setInput] = useState("")
  const [streaming, setStreaming] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [sidebarReload, setSidebarReload] = useState(0)
  const abortRef = useRef<AbortController | null>(null)
  const bottomRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (user) setSettings(loadSettings(user.id))
  }, [user])

  useEffect(() => {
    if (!conversationId) {
      setMessages([])
      setSystemPrompt("")
      return
    }
    let cancelled = false
    setLoadingMessages(true)
    setError(null)
    Promise.all([
      conversationsApi.list(),
      conversationsApi.messages(conversationId),
    ])
      .then(([convs, rows]) => {
        if (cancelled) return
        const current = convs.find((c) => c.id === conversationId)
        setSystemPrompt(current?.system_prompt ?? "")
        setMessages(rows.map((m) => ({ role: m.role, content: m.content })))
      })
      .catch((e) => {
        if (cancelled) return
        const msg = e instanceof Error ? e.message : String(e)
        setError(msg)
        if (/404/.test(msg)) nav("/", { replace: true })
      })
      .finally(() => {
        if (!cancelled) setLoadingMessages(false)
      })
    return () => {
      cancelled = true
    }
  }, [conversationId, nav])

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" })
  }, [messages, streaming])

  const configured = Boolean(settings.baseUrl && settings.apiKey && settings.model)
  const canSend = input.trim().length > 0 && !streaming && configured

  const banner = useMemo(() => {
    if (!configured) {
      return (
        <div className="flex flex-col items-start gap-2 rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-sm">
          <p>尚未配置模型。点击右上角 <b>设置</b> 填入 Base URL、Key 和模型名。</p>
          <Button size="sm" variant="outline" onClick={() => setSettingsOpen(true)}>
            <Settings /> 打开设置
          </Button>
        </div>
      )
    }
    return null
  }, [configured])

  async function ensureConversation(): Promise<number | null> {
    if (conversationId) return conversationId
    try {
      const c = await conversationsApi.create()
      setSystemPrompt(c.system_prompt)
      setSidebarReload((x) => x + 1)
      nav(`/c/${c.id}`, { replace: true })
      return c.id
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
      return null
    }
  }

  async function saveSystemPrompt(next: string) {
    if (!conversationId) {
      setSystemPrompt(next)
      return
    }
    try {
      await conversationsApi.update(conversationId, { system_prompt: next })
      setSystemPrompt(next)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  async function send() {
    if (!canSend || !user) return
    const text = input.trim()

    const convId = await ensureConversation()
    if (!convId) return

    setInput("")
    setError(null)

    const userMsg: ChatMessage = { role: "user", content: text }
    const base: ChatMessage[] = [...messages, userMsg]
    setMessages([...base, { role: "assistant", content: "" }])
    setStreaming(true)

    const ctrl = new AbortController()
    abortRef.current = ctrl

    let assistantContent = ""
    let streamError: Error | null = null

    const toModel: ChatMessage[] = systemPrompt
      ? [{ role: "system", content: systemPrompt }, ...base]
      : base

    try {
      await streamChat({
        protocol: settings.protocol,
        baseUrl: settings.baseUrl,
        apiKey: settings.apiKey,
        model: settings.model,
        useProxy: settings.useProxy,
        messages: toModel,
        signal: ctrl.signal,
        onDelta: (delta) => {
          assistantContent += delta
          setMessages((prev) => {
            const copy = prev.slice()
            const last = copy[copy.length - 1]
            if (last?.role === "assistant") {
              copy[copy.length - 1] = {
                role: "assistant",
                content: last.content + delta,
              }
            }
            return copy
          })
        },
      })
    } catch (e) {
      if ((e as { name?: string }).name !== "AbortError") {
        streamError = e instanceof Error ? e : new Error(String(e))
      }
    } finally {
      setStreaming(false)
      abortRef.current = null
    }

    if (streamError) {
      setError(streamError.message)
      setMessages((prev) => {
        const copy = prev.slice()
        const last = copy[copy.length - 1]
        if (last?.role === "assistant" && last.content === "") copy.pop()
        return copy
      })
      return
    }

    const toSave: ChatMessage[] = [userMsg]
    if (assistantContent) {
      toSave.push({ role: "assistant", content: assistantContent })
    }
    try {
      await conversationsApi.append(convId, toSave)
      setSidebarReload((x) => x + 1)
    } catch (e) {
      setError(
        "已生成但保存失败：" +
          (e instanceof Error ? e.message : String(e))
      )
    }
  }

  function stop() {
    abortRef.current?.abort()
  }

  const title = conversationId ? `#${conversationId}` : "新对话"

  return (
    <div className="flex h-svh bg-background text-foreground">
      <Sidebar
        reloadKey={sidebarReload}
        onOpenLibrary={() => setLibraryOpen(true)}
      />

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex items-center justify-between border-b border-border px-4 py-3">
          <div className="flex items-baseline gap-2 truncate">
            <span className="text-sm text-muted-foreground">{title}</span>
            <span className="text-xs text-muted-foreground">
              · {settings.model || "未配置"}
            </span>
          </div>
          <div className="flex items-center gap-2">
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setSettingsOpen(true)}
              title="设置"
            >
              <Settings />
            </Button>
          </div>
        </header>

        <SystemPromptBar
          value={systemPrompt}
          onSave={saveSystemPrompt}
          onOpenLibrary={() => setLibraryOpen(true)}
        />

        <div className="flex-1 overflow-y-auto">
          <div className="mx-auto flex max-w-3xl flex-col gap-4 px-4 py-6">
            {banner}
            {loadingMessages && (
              <p className="text-center text-sm text-muted-foreground">加载中…</p>
            )}
            {!loadingMessages && messages.length === 0 && configured && (
              <div className="mt-20 flex flex-col items-center gap-2 text-center text-muted-foreground">
                <p className="text-base">和 {settings.model} 开始对话</p>
                <p className="text-xs">回车发送，Shift+回车换行。</p>
              </div>
            )}
            {messages.map((m, i) => (
              <Bubble key={i} {...m} />
            ))}
            {error && (
              <div className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
                {error}
              </div>
            )}
            <div ref={bottomRef} />
          </div>
        </div>

        <div className="border-t border-border bg-background">
          <div className="mx-auto flex max-w-3xl items-end gap-2 px-4 py-3">
            <Textarea
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                  e.preventDefault()
                  void send()
                }
              }}
              placeholder={configured ? "问点什么…" : "先在设置中配置 API…"}
              rows={1}
              className="max-h-48 min-h-[44px] resize-none"
            />
            {streaming ? (
              <Button onClick={stop} variant="secondary" size="icon" aria-label="停止">
                <Square />
              </Button>
            ) : (
              <Button
                onClick={() => void send()}
                disabled={!canSend}
                size="icon"
                aria-label="发送"
              >
                <ArrowUp />
              </Button>
            )}
          </div>
        </div>
      </div>

      <SettingsDialog
        open={settingsOpen}
        initial={settings}
        onClose={() => setSettingsOpen(false)}
        onSave={(s) => {
          if (user) saveSettings(user.id, s)
          setSettings(s)
          setSettingsOpen(false)
        }}
      />

      <PromptLibrary
        open={libraryOpen}
        onClose={() => setLibraryOpen(false)}
        onApplyToCurrent={(content) => {
          void saveSystemPrompt(content)
          setLibraryOpen(false)
        }}
      />
    </div>
  )
}
