import { useEffect, useMemo, useRef, useState } from "react"
import { useNavigate, useParams } from "react-router-dom"
import {
  ArrowUp,
  Check,
  Copy,
  ImageIcon,
  MessageSquare,
  Pencil,
  RefreshCcw,
  Settings,
  Sparkles,
  Square,
  User,
} from "lucide-react"
import ReactMarkdown from "react-markdown"
import remarkGfm from "remark-gfm"
import { Button } from "@/components/ui/button"
import { Textarea } from "@/components/ui/textarea"
import { streamChat, type ChatMessage } from "@/lib/chat-stream"
import { generateImages } from "@/lib/image-gen"
import { cn } from "@/lib/utils"
import { useAuth } from "@/lib/auth-context"
import {
  loadSettings,
  saveSettings,
  PROTOCOL_META,
  type Protocol,
  type UpstreamSettings,
} from "@/lib/settings"
import { SettingsDialog } from "@/components/app/SettingsDialog"
import { Sidebar } from "@/components/app/Sidebar"
import { SystemPromptBar } from "@/components/app/SystemPromptBar"
import { PromptLibrary } from "@/components/app/PromptLibrary"
import { conversationsApi } from "@/lib/conversations"

type UiMessage = ChatMessage & { id?: number }

const PROTOCOL_COLOR: Record<Protocol, string> = {
  openai: "from-emerald-400 to-emerald-600",
  claude: "from-amber-400 to-orange-600",
  gemini: "from-sky-400 to-indigo-600",
}

function ModelBadge({ protocol, model }: { protocol: Protocol; model: string }) {
  return (
    <span className="inline-flex items-center gap-1.5 rounded-full border border-border bg-muted/40 px-2.5 py-1 text-xs">
      <span
        className={cn(
          "inline-block size-2 rounded-full bg-gradient-to-br",
          PROTOCOL_COLOR[protocol]
        )}
      />
      <span className="font-medium">{PROTOCOL_META[protocol].label.replace(" 兼容", "")}</span>
      <span className="text-muted-foreground">·</span>
      <span className="truncate text-muted-foreground">{model || "未配置"}</span>
    </span>
  )
}

type BubbleActions = {
  onCopy: () => Promise<void> | void
  copied: boolean
  onRetry?: () => void
  onEdit?: () => void
}

function ActionIcon({
  label,
  onClick,
  children,
}: {
  label: string
  onClick: () => void
  children: React.ReactNode
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={label}
      aria-label={label}
      className="grid size-7 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
    >
      {children}
    </button>
  )
}

function Bubble({
  message,
  actions,
}: {
  message: UiMessage
  actions: BubbleActions
}) {
  const isUser = message.role === "user"
  const toolbar = (
    <div
      className={cn(
        "flex items-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-100",
        isUser ? "justify-end" : "justify-start"
      )}
    >
      <ActionIcon label={actions.copied ? "已复制" : "复制"} onClick={() => void actions.onCopy()}>
        {actions.copied ? (
          <Check className="size-3.5 text-emerald-500" />
        ) : (
          <Copy className="size-3.5" />
        )}
      </ActionIcon>
      {actions.onEdit && (
        <ActionIcon label="编辑并重发" onClick={actions.onEdit}>
          <Pencil className="size-3.5" />
        </ActionIcon>
      )}
      {actions.onRetry && (
        <ActionIcon label="重新生成" onClick={actions.onRetry}>
          <RefreshCcw className="size-3.5" />
        </ActionIcon>
      )}
    </div>
  )

  if (isUser) {
    return (
      <div className="group flex flex-col items-end gap-1">
        <div className="flex max-w-[82%] items-end gap-2">
          <div className="rounded-2xl rounded-tr-md bg-primary px-4 py-2.5 text-sm leading-relaxed text-primary-foreground shadow-sm">
            <p className="whitespace-pre-wrap">{message.content}</p>
          </div>
          <div className="grid size-7 shrink-0 place-items-center rounded-full border border-border bg-card text-muted-foreground">
            <User className="size-3.5" />
          </div>
        </div>
        <div className="pr-9">{toolbar}</div>
      </div>
    )
  }

  return (
    <div className="group flex flex-col items-start gap-1">
      <div className="flex max-w-[88%] items-start gap-2.5">
        <div className="grid size-7 shrink-0 place-items-center rounded-full bg-gradient-to-br from-primary to-chart-5 text-primary-foreground shadow-sm">
          <Sparkles className="size-3.5" />
        </div>
        <div
          className={cn(
            "prose prose-sm dark:prose-invert min-w-0 max-w-none",
            "rounded-2xl rounded-tl-md bg-card px-4 py-2.5 text-sm leading-relaxed",
            "border border-border/70 shadow-sm",
            "prose-pre:bg-muted prose-pre:border prose-pre:border-border",
            "prose-img:max-w-full prose-img:rounded-xl prose-img:border prose-img:border-border prose-img:shadow-sm",
            "prose-code:rounded prose-code:bg-muted prose-code:px-1 prose-code:py-0.5 prose-code:text-[0.85em] prose-code:font-normal prose-code:before:content-none prose-code:after:content-none"
          )}
        >
          <ReactMarkdown remarkPlugins={[remarkGfm]}>
            {message.content || "…"}
          </ReactMarkdown>
        </div>
      </div>
      <div className="pl-9">{toolbar}</div>
    </div>
  )
}

const SAMPLE_PROMPTS = [
  { title: "解释概念", body: "用通俗比喻解释「向量数据库」是什么。" },
  { title: "写代码", body: "用 Rust 写一个简单的 HTTP 客户端示例。" },
  { title: "头脑风暴", body: "帮我想 5 个给副业独立开发者的产品点子。" },
  { title: "改写润色", body: "把这段话改得更简洁、更专业：" },
]

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
  const [messages, setMessages] = useState<UiMessage[]>([])
  const [mode, setMode] = useState<"chat" | "image">("chat")
  const [systemPrompt, setSystemPrompt] = useState("")
  const [loadingMessages, setLoadingMessages] = useState(false)
  const [input, setInput] = useState("")
  const [streaming, setStreaming] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [sidebarReload, setSidebarReload] = useState(0)
  const [copiedKey, setCopiedKey] = useState<string | null>(null)
  const abortRef = useRef<AbortController | null>(null)
  const bottomRef = useRef<HTMLDivElement>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  useEffect(() => {
    if (user) setSettings(loadSettings(user.id))
  }, [user])

  useEffect(() => {
    if (settings.protocol !== "openai" && mode === "image") {
      setMode("chat")
    }
  }, [settings.protocol, mode])

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
        setMessages(
          rows.map((m) => ({ id: m.id, role: m.role, content: m.content }))
        )
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
        <div className="rounded-xl border border-amber-500/40 bg-amber-500/5 px-4 py-3">
          <p className="text-sm">
            尚未配置模型。点击右上角 <b>设置</b> 填入 Base URL、Key 和模型名。
          </p>
          <Button
            size="sm"
            variant="outline"
            className="mt-2"
            onClick={() => setSettingsOpen(true)}
          >
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

  async function refetchMessages(convId: number) {
    try {
      const rows = await conversationsApi.messages(convId)
      setMessages(
        rows.map((m) => ({ id: m.id, role: m.role, content: m.content }))
      )
    } catch {
      // tolerate; IDs can't be refreshed, retry/edit just won't work
    }
  }

  async function send() {
    if (!canSend || !user) return
    const text = input.trim()

    if (mode === "image") {
      if (settings.protocol !== "openai") {
        setError("图像模式仅在 OpenAI 协议下可用")
        return
      }
      await runImage(text, text)
      return
    }

    const convId = await ensureConversation()
    if (!convId) return

    setInput("")
    setError(null)

    const userMsg: UiMessage = { role: "user", content: text }
    const baseHistory: UiMessage[] = [...messages, userMsg]
    setMessages([...baseHistory, { role: "assistant", content: "" }])
    setStreaming(true)

    const ctrl = new AbortController()
    abortRef.current = ctrl

    let assistantContent = ""
    let streamError: Error | null = null

    const toModel: ChatMessage[] = (systemPrompt
      ? [{ role: "system", content: systemPrompt } as ChatMessage, ...baseHistory]
      : (baseHistory as ChatMessage[])
    ).map((m) => ({ role: m.role, content: m.content }))

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
                ...last,
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

    const toSave: Array<{ role: "user" | "assistant"; content: string }> = [
      { role: "user", content: text },
    ]
    if (assistantContent) {
      toSave.push({ role: "assistant", content: assistantContent })
    }
    try {
      await conversationsApi.append(convId, toSave)
      setSidebarReload((x) => x + 1)
      await refetchMessages(convId)
    } catch (e) {
      setError(
        "已生成但保存失败：" + (e instanceof Error ? e.message : String(e))
      )
    }
  }

  async function runImage(prompt: string, rawInput: string) {
    const convId = await ensureConversation()
    if (!convId) return

    setInput("")
    setError(null)

    const userMsg: UiMessage = { role: "user", content: `🖼 ${rawInput}` }
    setMessages((prev) => [
      ...prev,
      userMsg,
      { role: "assistant", content: "🎨 生成图像中…" },
    ])
    setStreaming(true)

    const ctrl = new AbortController()
    abortRef.current = ctrl

    let assistantContent = ""
    let genError: Error | null = null

    try {
      const imgs = await generateImages({
        baseUrl: settings.baseUrl,
        apiKey: settings.apiKey,
        prompt,
        model: /^(dall-e|gpt-image)/.test(settings.model)
          ? settings.model
          : "dall-e-3",
        signal: ctrl.signal,
      })
      assistantContent = imgs
        .map(
          (i) =>
            `![${(i.revised_prompt || prompt).replace(/[\[\]]/g, "")}](${i.path})`
        )
        .join("\n\n")
      if (!assistantContent) assistantContent = "(no images returned)"
      setMessages((prev) => {
        const copy = prev.slice()
        copy[copy.length - 1] = { role: "assistant", content: assistantContent }
        return copy
      })
    } catch (e) {
      if ((e as { name?: string }).name !== "AbortError") {
        genError = e instanceof Error ? e : new Error(String(e))
      }
    } finally {
      setStreaming(false)
      abortRef.current = null
    }

    if (genError) {
      setError(genError.message)
      setMessages((prev) => {
        const copy = prev.slice()
        if (copy[copy.length - 1]?.role === "assistant") copy.pop()
        return copy
      })
      return
    }

    try {
      await conversationsApi.append(convId, [
        { role: "user", content: userMsg.content },
        { role: "assistant", content: assistantContent },
      ])
      setSidebarReload((x) => x + 1)
      await refetchMessages(convId)
    } catch (e) {
      setError(
        "图像已生成但消息保存失败：" +
          (e instanceof Error ? e.message : String(e))
      )
    }
  }

  async function regenerateLastAssistant() {
    if (!conversationId || streaming) return
    const last = messages[messages.length - 1]
    if (!last || last.role !== "assistant" || last.id === undefined) return
    const prevUser = messages[messages.length - 2]
    if (!prevUser || prevUser.role !== "user") return

    try {
      await conversationsApi.truncate(conversationId, last.id)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
      return
    }

    const trimmed = messages.slice(0, -1)
    setMessages([...trimmed, { role: "assistant", content: "" }])
    setStreaming(true)
    setError(null)

    const ctrl = new AbortController()
    abortRef.current = ctrl
    let assistantContent = ""
    let streamError: Error | null = null

    const history: ChatMessage[] = trimmed.map((m) => ({
      role: m.role,
      content: m.content,
    }))
    const toModel: ChatMessage[] = systemPrompt
      ? [{ role: "system", content: systemPrompt }, ...history]
      : history

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
            const tail = copy[copy.length - 1]
            if (tail?.role === "assistant") {
              copy[copy.length - 1] = { ...tail, content: tail.content + delta }
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
        const tail = copy[copy.length - 1]
        if (tail?.role === "assistant" && tail.content === "") copy.pop()
        return copy
      })
      return
    }

    if (assistantContent) {
      try {
        await conversationsApi.append(conversationId, [
          { role: "assistant", content: assistantContent },
        ])
        setSidebarReload((x) => x + 1)
        await refetchMessages(conversationId)
      } catch (e) {
        setError(
          "已生成但保存失败：" + (e instanceof Error ? e.message : String(e))
        )
      }
    }
  }

  async function editLastUser() {
    if (!conversationId || streaming) return
    const last = messages[messages.length - 1]
    let target: UiMessage | undefined
    if (last?.role === "user") target = last
    else if (last?.role === "assistant" && messages[messages.length - 2]?.role === "user")
      target = messages[messages.length - 2]
    if (!target || target.id === undefined) return

    try {
      await conversationsApi.truncate(conversationId, target.id)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
      return
    }

    const keepUntil = messages.findIndex((m) => m.id === target!.id)
    setMessages(keepUntil < 0 ? messages : messages.slice(0, keepUntil))
    const stripped = target.content.replace(/^🖼 /, "")
    setInput(stripped)
    setMode("chat")
    setTimeout(() => textareaRef.current?.focus(), 0)
  }

  async function copyText(content: string, key: string) {
    try {
      await navigator.clipboard.writeText(content)
      setCopiedKey(key)
      setTimeout(() => setCopiedKey((k) => (k === key ? null : k)), 1500)
    } catch {
      setError("复制失败：浏览器不允许剪贴板访问")
    }
  }

  function stop() {
    abortRef.current?.abort()
  }

  function fillSample(text: string) {
    setInput((v) => (v ? v : text))
    textareaRef.current?.focus()
  }

  const lastIdx = messages.length - 1

  return (
    <div className="flex h-svh bg-background text-foreground">
      <Sidebar
        reloadKey={sidebarReload}
        onOpenLibrary={() => setLibraryOpen(true)}
      />

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex items-center justify-between gap-3 border-b border-border bg-background/70 px-5 py-3 backdrop-blur">
          <div className="flex min-w-0 items-center gap-3">
            <h1 className="truncate text-base font-semibold tracking-tight">
              {conversationId ? `会话 #${conversationId}` : "新对话"}
            </h1>
            <ModelBadge protocol={settings.protocol} model={settings.model} />
          </div>
          <div className="flex items-center gap-1">
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

        <div className="nc-scroll flex-1 overflow-y-auto">
          <div className="mx-auto flex w-full max-w-3xl flex-col gap-4 px-5 py-6">
            {banner}
            {loadingMessages && (
              <p className="text-center text-sm text-muted-foreground">加载中…</p>
            )}
            {!loadingMessages && messages.length === 0 && configured && (
              <div className="mt-16 flex flex-col items-center gap-6 text-center">
                <div className="grid size-14 place-items-center rounded-2xl bg-gradient-to-br from-primary to-chart-5 text-primary-foreground shadow-panel">
                  <Sparkles className="size-6" />
                </div>
                <div>
                  <p className="text-lg font-semibold tracking-tight">
                    开始一段对话
                  </p>
                  <p className="mt-1 text-sm text-muted-foreground">
                    回车发送，Shift + 回车换行
                    {settings.protocol === "openai"
                      ? "；点左下角按钮可切到图像模式。"
                      : "。"}
                  </p>
                </div>
                <div className="grid w-full grid-cols-1 gap-2 sm:grid-cols-2">
                  {SAMPLE_PROMPTS.map((p) => (
                    <button
                      key={p.title}
                      type="button"
                      onClick={() => fillSample(p.body)}
                      className="group flex flex-col items-start gap-1 rounded-xl border border-border bg-card px-4 py-3 text-left transition-colors hover:border-primary/40 hover:bg-accent"
                    >
                      <span className="text-xs font-semibold text-muted-foreground group-hover:text-accent-foreground">
                        {p.title}
                      </span>
                      <span className="line-clamp-2 text-sm">{p.body}</span>
                    </button>
                  ))}
                </div>
              </div>
            )}
            {messages.map((m, i) => {
              const key = m.id !== undefined ? `m-${m.id}` : `t-${i}`
              const isLast = i === lastIdx
              const isLastAssistant =
                isLast && m.role === "assistant" && m.id !== undefined && !streaming
              const isLastUser =
                isLast && m.role === "user" && m.id !== undefined && !streaming
              // Edit should also be available when last assistant follows a last user
              const isSecondLastUser =
                i === lastIdx - 1 &&
                m.role === "user" &&
                m.id !== undefined &&
                !streaming &&
                messages[lastIdx]?.role === "assistant"
              return (
                <Bubble
                  key={key}
                  message={m}
                  actions={{
                    onCopy: () => copyText(m.content, key),
                    copied: copiedKey === key,
                    onRetry: isLastAssistant ? regenerateLastAssistant : undefined,
                    onEdit:
                      isLastUser || isSecondLastUser ? editLastUser : undefined,
                  }}
                />
              )
            })}
            {error && (
              <div className="rounded-xl border border-destructive/40 bg-destructive/10 px-4 py-2.5 text-sm text-destructive">
                {error}
              </div>
            )}
            <div ref={bottomRef} />
          </div>
        </div>

        <div className="bg-background px-5 pb-4 pt-2">
          <div className="mx-auto max-w-3xl">
            <div className="flex items-end gap-2 rounded-2xl border border-border bg-card p-2 shadow-panel focus-within:border-primary/40 focus-within:ring-2 focus-within:ring-ring">
              <Button
                type="button"
                variant={mode === "image" ? "default" : "ghost"}
                size="icon"
                className="shrink-0"
                aria-label={mode === "image" ? "切换到文字" : "切换到图像"}
                title={
                  settings.protocol !== "openai"
                    ? "图像模式仅在 OpenAI 协议可用"
                    : mode === "image"
                    ? "当前：图像（点击切回文字）"
                    : "当前：文字（点击切到图像）"
                }
                disabled={settings.protocol !== "openai" || streaming}
                onClick={() =>
                  setMode((m) => (m === "image" ? "chat" : "image"))
                }
              >
                {mode === "image" ? <ImageIcon /> : <MessageSquare />}
              </Button>
              <Textarea
                ref={textareaRef}
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={(e) => {
                  if (
                    e.key === "Enter" &&
                    !e.shiftKey &&
                    !e.nativeEvent.isComposing
                  ) {
                    e.preventDefault()
                    void send()
                  }
                }}
                placeholder={
                  !configured
                    ? "先在设置中配置 API…"
                    : mode === "image"
                    ? "描述想要的图像…（DALL·E）"
                    : "问点什么…"
                }
                rows={1}
                className="max-h-60 min-h-[40px] flex-1 resize-none border-0 bg-transparent px-2 py-2 shadow-none focus-visible:ring-0"
              />
              {streaming ? (
                <Button
                  onClick={stop}
                  variant="secondary"
                  size="icon"
                  className="shrink-0"
                  aria-label="停止"
                >
                  <Square />
                </Button>
              ) : (
                <Button
                  onClick={() => void send()}
                  disabled={!canSend}
                  size="icon"
                  className="shrink-0"
                  aria-label={mode === "image" ? "生成图像" : "发送"}
                  title={mode === "image" ? "生成图像" : "发送"}
                >
                  <ArrowUp />
                </Button>
              )}
            </div>
            <p className="mt-1.5 text-center text-[11px] text-muted-foreground">
              消息经过你选的协议发送；API key 仅保留在本机浏览器。
            </p>
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
