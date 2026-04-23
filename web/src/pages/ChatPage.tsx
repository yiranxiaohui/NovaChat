import { useEffect, useMemo, useRef, useState } from "react"
import { useNavigate, useParams } from "react-router-dom"
import {
  ArrowUp,
  BookMarked,
  Check,
  Copy,
  Globe,
  ImageIcon,
  ImagePlus,
  Images,
  MessageSquare,
  MessageSquareText,
  Pencil,
  RefreshCcw,
  Settings,
  Sparkles,
  Square,
  Upload,
  User,
  Wand2,
  X,
} from "lucide-react"
import ReactMarkdown from "react-markdown"
import remarkGfm from "remark-gfm"
import { Button } from "@/components/ui/button"
import { Textarea } from "@/components/ui/textarea"
import { streamChat, type ChatMessage } from "@/lib/chat-stream"
import { editImages, generateImages } from "@/lib/image-gen"
import { cn } from "@/lib/utils"
import { useAuth } from "@/lib/auth-context"
import {
  loadSettings,
  saveSettings,
  loadEffectiveSettings,
  settingsApi,
  isImageConfigured,
  likelyWebSearchCapable,
  PROTOCOL_META,
  IMAGE_PROTOCOL_META,
  type Protocol,
  type UpstreamSettings,
} from "@/lib/settings"
import { SettingsDialog } from "@/components/app/SettingsDialog"
import { RechargeDialog } from "@/components/app/RechargeDialog"
import { Sidebar } from "@/components/app/Sidebar"
import { SystemPromptDialog } from "@/components/app/SystemPromptBar"
import { PromptLibrary } from "@/components/app/PromptLibrary"
import { SkillsDialog } from "@/components/app/SkillsDialog"
import { ImagePlazaDialog } from "@/components/app/ImagePlazaDialog"
import { conversationsApi } from "@/lib/conversations"
import {
  skillsApi,
  composeSystemPromptWithSkills,
  type Skill,
} from "@/lib/skills"
import { filenameFromPath, plazaApi } from "@/lib/image-plaza"
import { creditsApi, type CreditsMe, type SharedStatus } from "@/lib/credits"

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
  onPublishImage,
  publishedFilenames,
  publishingFilename,
}: {
  message: UiMessage
  actions: BubbleActions
  onPublishImage?: (filename: string, alt: string) => void
  publishedFilenames?: Set<string>
  publishingFilename?: string | null
}) {
  const isUser = message.role === "user"
  const [preview, setPreview] = useState<{ src: string; alt: string } | null>(
    null
  )

  useEffect(() => {
    if (!preview) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setPreview(null)
    }
    window.addEventListener("keydown", onKey)
    const prevOverflow = document.body.style.overflow
    document.body.style.overflow = "hidden"
    return () => {
      window.removeEventListener("keydown", onKey)
      document.body.style.overflow = prevOverflow
    }
  }, [preview])

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
          <ReactMarkdown
            remarkPlugins={[remarkGfm]}
            components={{
              img: ({ src, alt }) => {
                const url = typeof src === "string" ? src : ""
                const altText = alt ?? ""
                const fname = filenameFromPath(url)
                const published = fname
                  ? publishedFilenames?.has(fname)
                  : false
                const busy = fname ? publishingFilename === fname : false
                const imgEl = (
                  <img
                    src={url}
                    alt={altText}
                    loading="lazy"
                    onClick={() => setPreview({ src: url, alt: altText })}
                    className="!my-0 max-h-80 w-auto cursor-zoom-in"
                  />
                )
                return (
                  <span className="group/img relative inline-block">
                    {imgEl}
                    {onPublishImage && fname && (
                      <button
                        type="button"
                        onClick={() => onPublishImage(fname, altText)}
                        disabled={busy || published}
                        title={
                          published
                            ? "已发布到广场"
                            : busy
                              ? "发布中…"
                              : "发布到图片广场"
                        }
                        className={cn(
                          "absolute bottom-2 right-2 z-10 inline-flex items-center gap-1 rounded-md border border-border bg-background/80 px-2 py-1 text-xs backdrop-blur",
                          "opacity-0 transition-opacity group-hover/img:opacity-100",
                          published && "cursor-default opacity-100",
                          !published && !busy && "hover:bg-accent"
                        )}
                      >
                        {published ? (
                          <>
                            <Check className="size-3 text-emerald-500" /> 已发布
                          </>
                        ) : (
                          <>
                            <Upload className="size-3" />{" "}
                            {busy ? "发布中…" : "发布到广场"}
                          </>
                        )}
                      </button>
                    )}
                  </span>
                )
              },
            }}
          >
            {message.content || "…"}
          </ReactMarkdown>
        </div>
      </div>
      <div className="pl-9">{toolbar}</div>
      {preview && (
        <div
          className="fixed inset-0 z-50 grid place-items-center bg-black/80 p-4"
          onClick={() => setPreview(null)}
          role="dialog"
          aria-label="图片预览"
        >
          <img
            src={preview.src}
            alt={preview.alt}
            className="max-h-[95vh] max-w-[95vw] rounded-lg shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          />
          <button
            type="button"
            onClick={() => setPreview(null)}
            aria-label="关闭预览"
            className="absolute right-4 top-4 inline-flex size-9 items-center justify-center rounded-full bg-black/60 text-white hover:bg-black/80"
          >
            <X className="size-5" />
          </button>
        </div>
      )}
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
          useShared: true,
          imageProtocol: "openai",
          imageBaseUrl: "",
          imageApiKey: "",
          imageModel: "",
          imageUseProxy: true,
          imageUseShared: true,
          webSearch: false,
          cloudSync: false,
        }
  )
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [rechargeOpen, setRechargeOpen] = useState(false)
  const [libraryOpen, setLibraryOpen] = useState(false)
  const [skillsOpen, setSkillsOpen] = useState(false)
  const [plazaOpen, setPlazaOpen] = useState(false)
  const [publishedFilenames, setPublishedFilenames] = useState<Set<string>>(
    new Set()
  )
  const [publishingFilename, setPublishingFilename] = useState<string | null>(
    null
  )
  const [creditsMe, setCreditsMe] = useState<CreditsMe | null>(null)
  const [sharedStatus, setSharedStatus] = useState<SharedStatus | null>(null)
  const [attachedSkills, setAttachedSkills] = useState<Skill[]>([])
  const [systemPromptOpen, setSystemPromptOpen] = useState(false)
  const [messages, setMessages] = useState<UiMessage[]>([])
  const [mode, setMode] = useState<"chat" | "image">("chat")
  const [systemPrompt, setSystemPrompt] = useState("")
  const [loadingMessages, setLoadingMessages] = useState(false)
  const [input, setInput] = useState("")
  const [streaming, setStreaming] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [sidebarReload, setSidebarReload] = useState(0)
  const [copiedKey, setCopiedKey] = useState<string | null>(null)
  const [editImage, setEditImage] = useState<File | null>(null)
  const [editImageUrl, setEditImageUrl] = useState<string | null>(null)
  const abortRef = useRef<AbortController | null>(null)
  const bottomRef = useRef<HTMLDivElement>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const editFileInputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (!editImage) {
      setEditImageUrl(null)
      return
    }
    const url = URL.createObjectURL(editImage)
    setEditImageUrl(url)
    return () => URL.revokeObjectURL(url)
  }, [editImage])

  useEffect(() => {
    if (mode !== "image") setEditImage(null)
  }, [mode])

  useEffect(() => {
    if (!user) return
    setSettings(loadSettings(user.id))
    let cancelled = false
    loadEffectiveSettings(user.id).then((s) => {
      if (!cancelled) setSettings(s)
    })
    creditsApi
      .sharedStatus()
      .then((s) => {
        if (cancelled) return
        setSharedStatus(s)
        setCreditsMe({
          balance: s.balance,
          lifetime_used: 0,
          cost_chat: s.cost_chat,
          cost_image: s.cost_image,
        })
      })
      .catch(() => {
        /* non-fatal */
      })
    plazaApi
      .listMine()
      .then((rows) => {
        if (cancelled) return
        setPublishedFilenames((prev) => {
          const next = new Set(prev)
          for (const r of rows) next.add(r.filename)
          return next
        })
      })
      .catch(() => {
        /* non-fatal */
      })
    return () => {
      cancelled = true
    }
  }, [user])

  async function refreshCredits() {
    try {
      const me = await creditsApi.me()
      setCreditsMe(me)
    } catch {
      /* ignore */
    }
  }

  function toggleWebSearch() {
    const next = { ...settings, webSearch: !settings.webSearch }
    setSettings(next)
    if (user) saveSettings(user.id, next)
    if (next.cloudSync) {
      settingsApi.save(next).catch(() => {
        /* non-fatal */
      })
    }
  }

  const imageConfigured = isImageConfigured(settings)

  useEffect(() => {
    if (!imageConfigured && mode === "image") {
      setMode("chat")
    }
  }, [imageConfigured, mode])

  useEffect(() => {
    if (!conversationId) {
      setMessages([])
      setSystemPrompt("")
      setAttachedSkills([])
      return
    }
    let cancelled = false
    setLoadingMessages(true)
    setError(null)
    Promise.all([
      conversationsApi.list(),
      conversationsApi.messages(conversationId),
      skillsApi.listForConversation(conversationId).catch(() => [] as Skill[]),
    ])
      .then(([convs, rows, skills]) => {
        if (cancelled) return
        const current = convs.find((c) => c.id === conversationId)
        setSystemPrompt(current?.system_prompt ?? "")
        setMessages(
          rows.map((m) => ({ id: m.id, role: m.role, content: m.content }))
        )
        setAttachedSkills(skills)
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

  async function refreshAttachedSkills(convId: number) {
    try {
      const list = await skillsApi.listForConversation(convId)
      setAttachedSkills(list)
    } catch {
      // leave existing state — dialog will show its own errors
    }
  }

  async function publishImage(filename: string, alt: string) {
    if (publishedFilenames.has(filename) || publishingFilename) return
    setPublishingFilename(filename)
    setError(null)
    try {
      await plazaApi.publish({
        filename,
        prompt: alt || filename,
      })
      setPublishedFilenames((s) => new Set(s).add(filename))
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      if (/already published|CONFLICT/i.test(msg)) {
        setPublishedFilenames((s) => new Set(s).add(filename))
      } else {
        setError(`发布失败：${msg}`)
      }
    } finally {
      setPublishingFilename(null)
    }
  }

  function applyPlazaPrompt(prompt: string) {
    if (settings.protocol === "openai" && imageConfigured) {
      setMode("image")
    }
    setInput(prompt)
    textareaRef.current?.focus()
  }

  async function applyPlazaAsEditBase(filename: string, prompt: string) {
    if (settings.protocol !== "openai" || !imageConfigured) {
      setError("请先在设置里配置 OpenAI 图像生成，才能以此图生图")
      return
    }
    try {
      const resp = await fetch(`/api/images/${filename}`, {
        credentials: "same-origin",
      })
      if (!resp.ok) {
        throw new Error(`HTTP ${resp.status}`)
      }
      const blob = await resp.blob()
      const file = new File([blob], filename, {
        type: blob.type || "image/png",
      })
      setMode("image")
      setEditImage(file)
      setInput(prompt)
      textareaRef.current?.focus()
    } catch (e) {
      setError(
        `加载底图失败：${e instanceof Error ? e.message : String(e)}`
      )
    }
  }

  const effectiveSystemPrompt = useMemo(
    () => composeSystemPromptWithSkills(systemPrompt, attachedSkills),
    [systemPrompt, attachedSkills]
  )

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" })
  }, [messages, streaming])

  const configured =
    settings.useShared ||
    Boolean(settings.baseUrl && settings.apiKey && settings.model)
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
      const attached = editImage
      await runImage(text, text, attached)
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

    const toModel: ChatMessage[] = (effectiveSystemPrompt
      ? [
          { role: "system", content: effectiveSystemPrompt } as ChatMessage,
          ...baseHistory,
        ]
      : (baseHistory as ChatMessage[])
    ).map((m) => ({ role: m.role, content: m.content }))

    try {
      await streamChat({
        protocol: settings.protocol,
        baseUrl: settings.baseUrl,
        apiKey: settings.apiKey,
        model: settings.model,
        useProxy: settings.useProxy,
        useShared: settings.useShared,
        webSearch: settings.webSearch,
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
      void refreshCredits()
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

  async function runImage(prompt: string, rawInput: string, attached?: File | null) {
    const convId = await ensureConversation()
    if (!convId) return

    setInput("")
    setError(null)

    const userPrefix = attached ? "🖼✏️ " : "🖼 "
    const userMsg: UiMessage = { role: "user", content: `${userPrefix}${rawInput}` }
    setMessages((prev) => [
      ...prev,
      userMsg,
      { role: "assistant", content: attached ? "✏️ 编辑图像中…" : "🎨 生成图像中…" },
    ])
    setStreaming(true)

    const ctrl = new AbortController()
    abortRef.current = ctrl

    let assistantContent = ""
    let genError: Error | null = null

    try {
      const imgMeta = IMAGE_PROTOCOL_META[settings.imageProtocol]
      const common = {
        protocol: settings.imageProtocol,
        baseUrl: settings.imageBaseUrl || imgMeta.defaultBaseUrl,
        apiKey: settings.imageApiKey,
        prompt,
        model: settings.imageModel || imgMeta.defaultModel,
        useProxy: settings.imageUseProxy,
        useShared: settings.imageUseShared,
        signal: ctrl.signal,
      }
      const imgs = attached
        ? await editImages({ ...common, image: attached })
        : await generateImages(common)
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
      void refreshCredits()
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
      if (attached) setEditImage(null)
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
    const toModel: ChatMessage[] = effectiveSystemPrompt
      ? [{ role: "system", content: effectiveSystemPrompt }, ...history]
      : history

    try {
      await streamChat({
        protocol: settings.protocol,
        baseUrl: settings.baseUrl,
        apiKey: settings.apiKey,
        model: settings.model,
        useProxy: settings.useProxy,
        useShared: settings.useShared,
        webSearch: settings.webSearch,
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
    const stripped = target.content.replace(/^(?:🖼✏️ |🖼 )/, "")
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
            <ModelBadge
              protocol={mode === "image" ? "openai" : settings.protocol}
              model={
                mode === "image"
                  ? settings.imageModel ||
                    (settings.imageUseShared
                      ? settings.imageProtocol === "gemini"
                        ? sharedStatus?.image_gemini_model ?? ""
                        : sharedStatus?.image_openai_model ?? ""
                      : "")
                  : settings.model ||
                    (settings.useShared
                      ? settings.protocol === "openai"
                        ? sharedStatus?.chat_openai_model ?? ""
                        : settings.protocol === "claude"
                          ? sharedStatus?.chat_claude_model ?? ""
                          : sharedStatus?.chat_gemini_model ?? ""
                      : "")
              }
            />
          </div>
          <div className="flex items-center gap-1">
            {sharedStatus?.enabled && creditsMe && (
              <button
                type="button"
                onClick={() => setRechargeOpen(true)}
                className="mr-1 inline-flex items-center gap-1 rounded-full border border-border bg-muted/40 px-2.5 py-1 text-xs tabular-nums transition-colors hover:border-primary/60 hover:bg-primary/10"
                title={`剩余积分 ${creditsMe.balance}｜对话 ${creditsMe.cost_chat} 分/次，生图 ${creditsMe.cost_image} 分/次。点击充值。`}
              >
                <span className="text-muted-foreground">积分</span>
                <span className="font-medium">{creditsMe.balance}</span>
                <span className="text-muted-foreground">+</span>
              </button>
            )}
            <Button
              variant="ghost"
              size="icon"
              onClick={() => setSystemPromptOpen(true)}
              title={systemPrompt ? "系统提示词（已设置）" : "系统提示词"}
              className="relative"
            >
              <MessageSquareText />
              {systemPrompt && (
                <span className="absolute right-1.5 top-1.5 size-1.5 rounded-full bg-primary" />
              )}
            </Button>
            <Button
              variant="ghost"
              size="icon"
              onClick={() => setLibraryOpen(true)}
              title="提示词库"
            >
              <BookMarked />
            </Button>
            <Button
              variant="ghost"
              size="icon"
              onClick={() => setSkillsOpen(true)}
              title={
                attachedSkills.length > 0
                  ? `Skills（已挂载 ${attachedSkills.length}）`
                  : "Skills"
              }
              className="relative"
            >
              <Wand2 />
              {attachedSkills.length > 0 && (
                <span className="absolute right-1 top-1 min-w-4 rounded-full bg-primary px-1 text-[10px] font-semibold leading-4 text-primary-foreground">
                  {attachedSkills.length}
                </span>
              )}
            </Button>
            <Button
              variant="ghost"
              size="icon"
              onClick={() => setPlazaOpen(true)}
              title="图片广场"
            >
              <Images />
            </Button>
            <Button
              variant="ghost"
              size="icon"
              onClick={() => setSettingsOpen(true)}
              title="设置"
            >
              <Settings />
            </Button>
          </div>
        </header>

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
                  onPublishImage={
                    m.role === "assistant" ? publishImage : undefined
                  }
                  publishedFilenames={publishedFilenames}
                  publishingFilename={publishingFilename}
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
            {mode === "image" && editImage && editImageUrl && (
              <div className="mb-2 flex items-center gap-2 rounded-xl border border-border bg-card px-2 py-1.5 text-xs">
                <img
                  src={editImageUrl}
                  alt="待编辑"
                  className="size-10 shrink-0 rounded-md border border-border object-cover"
                />
                <div className="min-w-0 flex-1">
                  <p className="truncate font-medium">{editImage.name}</p>
                  <p className="text-muted-foreground">
                    将基于这张图进行编辑 · 需要支持图像编辑的模型（如 gpt-image-1）
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => setEditImage(null)}
                  className="grid size-6 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
                  aria-label="移除图片"
                  title="移除图片"
                >
                  <X className="size-3.5" />
                </button>
              </div>
            )}
            <input
              ref={editFileInputRef}
              type="file"
              accept="image/png,image/jpeg,image/webp"
              className="hidden"
              onChange={(e) => {
                const f = e.target.files?.[0] ?? null
                setEditImage(f)
                e.target.value = ""
              }}
            />
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
              {mode === "chat" && (
                <Button
                  type="button"
                  variant={settings.webSearch ? "default" : "ghost"}
                  size="icon"
                  className="shrink-0"
                  aria-label={
                    settings.webSearch ? "关闭联网搜索" : "开启联网搜索"
                  }
                  title={
                    !likelyWebSearchCapable(settings.protocol, settings.model)
                      ? `当前模型可能不支持联网搜索（${
                          settings.model || "未选择"
                        }）；点击仍可切换，请求失败请改选支持的模型`
                      : settings.webSearch
                        ? "联网搜索：开启（点击关闭）"
                        : "联网搜索：关闭（点击开启）"
                  }
                  disabled={streaming}
                  onClick={toggleWebSearch}
                >
                  <Globe />
                </Button>
              )}
              {mode === "image" && (
                <Button
                  type="button"
                  variant={editImage ? "default" : "ghost"}
                  size="icon"
                  className="shrink-0"
                  aria-label="附加图片以编辑"
                  title={
                    editImage
                      ? "已附加图片（点击更换）"
                      : "附加图片以编辑"
                  }
                  disabled={streaming || !imageConfigured}
                  onClick={() => editFileInputRef.current?.click()}
                >
                  <ImagePlus />
                </Button>
              )}
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
                    ? editImage
                      ? "描述要对这张图做的修改…"
                      : "描述想要的图像…（留空并附加图片即可编辑）"
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
                  aria-label={
                    mode === "image"
                      ? editImage
                        ? "编辑图像"
                        : "生成图像"
                      : "发送"
                  }
                  title={
                    mode === "image"
                      ? editImage
                        ? "编辑图像"
                        : "生成图像"
                      : "发送"
                  }
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
          const prevCloud = settings.cloudSync
          if (user) saveSettings(user.id, s)
          setSettings(s)
          setSettingsOpen(false)
          if (s.cloudSync) {
            settingsApi.save(s).catch((e) => {
              setError(`云端同步失败：${e instanceof Error ? e.message : String(e)}`)
            })
          } else if (prevCloud) {
            settingsApi.remove().catch(() => {
              // ignore — user turned cloud off, best-effort cleanup
            })
          }
        }}
      />

      <RechargeDialog
        open={rechargeOpen}
        onClose={() => setRechargeOpen(false)}
        onPaid={() => void refreshCredits()}
      />

      <PromptLibrary
        open={libraryOpen}
        onClose={() => setLibraryOpen(false)}
        onApplyToCurrent={(content) => {
          void saveSystemPrompt(content)
          setLibraryOpen(false)
        }}
      />

      <SystemPromptDialog
        open={systemPromptOpen}
        value={systemPrompt}
        onClose={() => setSystemPromptOpen(false)}
        onSave={saveSystemPrompt}
      />

      <SkillsDialog
        open={skillsOpen}
        conversationId={conversationId}
        attachedIds={attachedSkills.map((s) => s.id)}
        onClose={() => {
          setSkillsOpen(false)
          if (conversationId) void refreshAttachedSkills(conversationId)
        }}
        onAttachedChange={(ids) => {
          setAttachedSkills((prev) => {
            const byId = new Map(prev.map((s) => [s.id, s]))
            return ids
              .map((id) => byId.get(id))
              .filter((x): x is Skill => Boolean(x))
          })
          if (conversationId) void refreshAttachedSkills(conversationId)
        }}
      />

      <ImagePlazaDialog
        open={plazaOpen}
        onClose={() => setPlazaOpen(false)}
        onUsePrompt={applyPlazaPrompt}
        onUseAsEditBase={(filename, prompt) =>
          void applyPlazaAsEditBase(filename, prompt)
        }
      />
    </div>
  )
}
