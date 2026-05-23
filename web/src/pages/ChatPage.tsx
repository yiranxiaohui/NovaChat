import { useEffect, useMemo, useRef, useState } from "react"
import { useNavigate, useParams, useSearchParams } from "react-router-dom"
import {
  ArrowUp,
  ArrowDown,
  BookMarked,
  Check,
  ClipboardCheck,
  Copy,
  Download,
  Globe,
  Images,
  Menu,
  MessageSquareText,
  Paperclip,
  Pencil,
  Plus,
  RefreshCcw,
  Settings,
  Sparkles,
  Square,
  Upload,
  Wand2,
  X,
} from "lucide-react"
import ReactMarkdown from "react-markdown"
import remarkGfm from "remark-gfm"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import { streamChat, type ChatMessage } from "@/lib/chat-stream"
import { listModels } from "@/lib/models"
import { listPlatformModels, type PlatformModel } from "@/lib/platform-models"
import { cn } from "@/lib/utils"
import { useAuth } from "@/lib/auth-context"
import {
  loadSettings,
  saveSettings,
  loadEffectiveSettings,
  settingsApi,
  likelyWebSearchCapable,
  PROTOCOL_META,
  type Protocol,
  type UpstreamSettings,
} from "@/lib/settings"
import { SettingsDialog } from "@/components/app/SettingsDialog"
import { RechargeDialog } from "@/components/app/RechargeDialog"
import { CreditsLedgerDialog } from "@/components/app/CreditsLedgerDialog"
import { Sidebar } from "@/components/app/Sidebar"
import { SystemPromptDialog } from "@/components/app/SystemPromptBar"
import { PromptLibrary } from "@/components/app/PromptLibrary"
import { SkillsDialog } from "@/components/app/SkillsDialog"
import { ImagePreview } from "@/components/app/ImagePreview"
import { conversationsApi } from "@/lib/conversations"
import {
  skillsApi,
  composeSystemPromptWithSkills,
  type Skill,
} from "@/lib/skills"
import { filenameFromPath, plazaApi } from "@/lib/image-plaza"
import { creditsApi, type CreditsMe } from "@/lib/credits"

type UiMessage = ChatMessage & { id?: number }

const PROTOCOL_COLOR: Record<Protocol, string> = {
  openai: "from-emerald-400 to-emerald-600",
  claude: "from-amber-400 to-orange-600",
  gemini: "from-sky-400 to-indigo-600",
}

function ModelPicker({
  protocol,
  model,
  settings,
  onChangeModel,
}: {
  protocol: Protocol
  model: string
  settings: UpstreamSettings
  onChangeModel: (next: string, protocol?: Protocol) => void
}) {
  const [open, setOpen] = useState(false)
  const [models, setModels] = useState<PlatformModel[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [query, setQuery] = useState("")
  const popRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => {
      if (!popRef.current) return
      if (!popRef.current.contains(e.target as Node)) setOpen(false)
    }
    window.addEventListener("mousedown", onDown)
    return () => window.removeEventListener("mousedown", onDown)
  }, [open])

  const baseUrl = settings.baseUrl
  const apiKey = settings.apiKey
  const useProxy = settings.useProxy
  const fetchProtocol = settings.protocol
  const chatMode = settings.chatMode

  async function fetchList() {
    setError(null)
    setLoading(true)
    try {
      const list =
        chatMode === "platform"
          ? await listPlatformModels("chat")
          : (
              await listModels({
                protocol: fetchProtocol as Protocol,
                baseUrl,
                apiKey,
                useProxy,
              })
            ).map((model) => ({
              model,
              display_name: null,
              kind: "chat" as const,
              cost_credits: 0,
              protocol: fetchProtocol as Protocol,
            }))
      setModels(list)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
      setModels([])
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    if (open && models.length === 0 && !loading && !error) void fetchList()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  // Reset model cache when upstream context changes (protocol/baseUrl).
  useEffect(() => {
    setModels([])
    setError(null)
  }, [baseUrl, fetchProtocol, chatMode])

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return models
    return models.filter((m) => {
      const display = m.display_name ?? ""
      return (
        m.model.toLowerCase().includes(q) ||
        display.toLowerCase().includes(q) ||
        m.protocol.toLowerCase().includes(q)
      )
    })
  }, [models, query])

  return (
    <div className="relative min-w-0" ref={popRef}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="inline-flex min-w-0 max-w-[7.5rem] items-center gap-1.5 rounded-full border border-border bg-muted/40 px-2.5 py-1 text-xs transition-colors hover:border-primary/60 hover:bg-primary/10 sm:max-w-[11rem] md:max-w-none"
        title="点击切换模型"
      >
        <span
          className={cn(
            "inline-block size-2 shrink-0 rounded-full bg-gradient-to-br",
            PROTOCOL_COLOR[protocol]
          )}
        />
        <span className="hidden font-medium md:inline">
          {PROTOCOL_META[protocol].label.replace(" 兼容", "")}
        </span>
        <span className="hidden text-muted-foreground md:inline">·</span>
        <span className="truncate text-muted-foreground">{model || "未配置"}</span>
        <span className="shrink-0 text-muted-foreground">▾</span>
      </button>

      {open && (
        <div className="absolute left-0 top-full z-40 mt-1 w-72 rounded-lg border border-border bg-popover p-2 shadow-panel">
          <div className="mb-2 flex items-center gap-1">
            <Input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="搜索模型…"
              className="h-8 text-xs"
              autoFocus
            />
            <Button
              type="button"
              size="icon"
              variant="ghost"
              onClick={() => void fetchList()}
              disabled={loading}
              title="重新拉取"
              className="size-8 shrink-0"
            >
              <RefreshCcw className={cn("size-3.5", loading && "animate-spin")} />
            </Button>
          </div>
          <div className="nc-scroll max-h-72 overflow-y-auto">
            {loading && models.length === 0 && (
              <p className="px-2 py-6 text-center text-xs text-muted-foreground">
                加载中…
              </p>
            )}
            {!loading && error && (
              <p className="rounded border border-destructive/40 bg-destructive/10 px-2 py-1.5 text-xs text-destructive">
                {error}
              </p>
            )}
            {!loading && !error && filtered.length === 0 && (
              <p className="px-2 py-6 text-center text-xs text-muted-foreground">
                {models.length === 0
                  ? "暂无可用模型"
                  : "没有匹配的模型"}
              </p>
            )}
            <ul className="flex flex-col">
              {filtered.map((m) => {
                const active = m.model === model
                return (
                  <li key={`${m.protocol}:${m.model}`}>
                    <button
                      type="button"
                      onClick={() => {
                        onChangeModel(m.model, m.protocol)
                        setOpen(false)
                      }}
                      className={cn(
                        "flex w-full items-center justify-between rounded px-2 py-1.5 text-left text-xs hover:bg-accent",
                        active && "bg-accent text-accent-foreground"
                      )}
                    >
                      <span className="min-w-0">
                        <span className="block truncate font-mono">
                          {m.display_name || m.model}
                        </span>
                        {chatMode === "platform" && (
                          <span className="block truncate text-[10px] text-muted-foreground">
                            {m.protocol} · {m.cost_credits} 积分/次
                          </span>
                        )}
                      </span>
                      {active && <Check className="ml-2 size-3.5 shrink-0 text-primary" />}
                    </button>
                  </li>
                )
              })}
            </ul>
          </div>
          <div className="mt-2 border-t border-border pt-2 text-[10px] text-muted-foreground">
            {chatMode === "platform"
              ? "云端积分 · 从管理员开放的模型获取"
              : "自带 Key · 从你配置的上游获取"}
          </div>
        </div>
      )}
    </div>
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

/// Copy an image URL's bytes onto the clipboard as a PNG ClipboardItem so
/// the user can paste it into Word / Slack / image editors.
/// Non-PNG sources (JPEG/WebP/data:) are re-encoded via canvas since the
/// Clipboard API requires image/png on all browsers.
async function copyImageToClipboard(url: string): Promise<void> {
  if (!navigator.clipboard || typeof window.ClipboardItem === "undefined") {
    throw new Error("当前浏览器不支持剪贴板复制图片")
  }
  const res = await fetch(url, { credentials: "same-origin" })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  const src = await res.blob()
  let png: Blob = src
  if (src.type !== "image/png") {
    png = await new Promise<Blob>((resolve, reject) => {
      const img = new Image()
      img.crossOrigin = "anonymous"
      const objectUrl = URL.createObjectURL(src)
      img.onload = () => {
        const canvas = document.createElement("canvas")
        canvas.width = img.naturalWidth
        canvas.height = img.naturalHeight
        const ctx = canvas.getContext("2d")
        if (!ctx) {
          URL.revokeObjectURL(objectUrl)
          reject(new Error("画布 2D 上下文不可用"))
          return
        }
        ctx.drawImage(img, 0, 0)
        canvas.toBlob((b) => {
          URL.revokeObjectURL(objectUrl)
          if (!b) reject(new Error("PNG 编码失败"))
          else resolve(b)
        }, "image/png")
      }
      img.onerror = () => {
        URL.revokeObjectURL(objectUrl)
        reject(new Error("图片加载失败"))
      }
      img.src = objectUrl
    })
  }
  await navigator.clipboard.write([new ClipboardItem({ "image/png": png })])
}

function CopyImageButton({
  url,
  variant = "inline",
}: {
  url: string
  variant?: "inline" | "circle"
}) {
  const [state, setState] = useState<"idle" | "busy" | "done" | "err">("idle")
  const resetTimerRef = useRef<number | null>(null)
  useEffect(
    () => () => {
      if (resetTimerRef.current) window.clearTimeout(resetTimerRef.current)
    },
    []
  )
  async function onClick(e: React.MouseEvent) {
    e.stopPropagation()
    e.preventDefault()
    if (state === "busy") return
    setState("busy")
    try {
      await copyImageToClipboard(url)
      setState("done")
    } catch {
      setState("err")
    } finally {
      if (resetTimerRef.current) window.clearTimeout(resetTimerRef.current)
      resetTimerRef.current = window.setTimeout(() => setState("idle"), 1800)
    }
  }
  const icon =
    state === "done" ? (
      <ClipboardCheck className={variant === "circle" ? "size-5 text-emerald-400" : "size-3 text-emerald-500"} />
    ) : (
      <Copy className={variant === "circle" ? "size-5" : "size-3"} />
    )
  const title =
    state === "done"
      ? "已复制到剪贴板"
      : state === "err"
        ? "复制失败（浏览器或协议限制）"
        : state === "busy"
          ? "复制中…"
          : "复制图片到剪贴板"
  if (variant === "circle") {
    return (
      <button
        type="button"
        onClick={onClick}
        aria-label={title}
        title={title}
        className="inline-flex size-9 items-center justify-center rounded-full bg-black/60 text-white hover:bg-black/80"
      >
        {icon}
      </button>
    )
  }
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      className="inline-flex items-center gap-1 rounded-md border border-border bg-background/80 px-2 py-1 text-xs backdrop-blur hover:bg-accent"
    >
      {icon}
      {state === "done" ? "已复制" : "复制"}
    </button>
  )
}

function CodeBlock({ children, ...rest }: React.HTMLAttributes<HTMLPreElement>) {
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

type UserSegment =
  | { type: "text"; value: string }
  | { type: "image"; url: string; alt: string }

function splitUserContent(content: string): UserSegment[] {
  // Match standard markdown image syntax: ![alt](url)
  const re = /!\[([^\]]*)\]\(([^)\s]+)\)/g
  const segments: UserSegment[] = []
  let lastIndex = 0
  let m: RegExpExecArray | null
  while ((m = re.exec(content)) !== null) {
    const text = content.slice(lastIndex, m.index).replace(/\n+$/, "")
    if (text.length > 0) segments.push({ type: "text", value: text })
    segments.push({ type: "image", alt: m[1] ?? "", url: m[2] ?? "" })
    lastIndex = m.index + m[0].length
    // Swallow a single trailing newline so consecutive images stack cleanly
    if (content[lastIndex] === "\n") lastIndex += 1
  }
  const tail = content.slice(lastIndex)
  if (tail.length > 0) segments.push({ type: "text", value: tail })
  if (segments.length === 0) segments.push({ type: "text", value: content })
  return segments
}

function Bubble({
  message,
  actions,
  onPublishImage,
  publishedFilenames,
  publishingFilename,
  userAvatarUrl,
  userInitial,
}: {
  message: UiMessage
  actions: BubbleActions
  onPublishImage?: (filename: string, alt: string) => void
  publishedFilenames?: Set<string>
  publishingFilename?: string | null
  userAvatarUrl?: string | null
  userInitial?: string
}) {
  const isUser = message.role === "user"
  const [preview, setPreview] = useState<{ src: string; alt: string } | null>(
    null
  )
  const [avatarBroken, setAvatarBroken] = useState(false)
  useEffect(() => {
    setAvatarBroken(false)
  }, [userAvatarUrl])

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
    const segments = splitUserContent(message.content)
    return (
      <div className="group flex flex-col items-end gap-1">
        <div className="flex max-w-[92%] items-end gap-2 sm:max-w-[82%]">
          <div className="rounded-2xl rounded-tr-md bg-primary px-4 py-2.5 text-sm leading-relaxed text-primary-foreground shadow-sm">
            {segments.map((seg, i) =>
              seg.type === "text" ? (
                <p key={i} className="whitespace-pre-wrap">
                  {seg.value}
                </p>
              ) : (
                <img
                  key={i}
                  src={seg.url}
                  alt={seg.alt}
                  loading="lazy"
                  onClick={() => setPreview({ src: seg.url, alt: seg.alt })}
                  className="my-1 max-h-80 w-auto cursor-zoom-in rounded-xl border border-primary-foreground/20"
                />
              )
            )}
          </div>
          {userAvatarUrl && !avatarBroken ? (
            <img
              src={userAvatarUrl}
              alt=""
              loading="lazy"
              onError={() => setAvatarBroken(true)}
              className="size-7 shrink-0 rounded-full border border-border object-cover"
            />
          ) : (
            <div className="grid size-7 shrink-0 place-items-center rounded-full bg-gradient-to-br from-primary to-chart-5 text-[11px] font-semibold text-primary-foreground">
              {(userInitial || "?").toUpperCase()}
            </div>
          )}
        </div>
        <div className="pr-9">{toolbar}</div>
        {preview && (
          <ImagePreview
            src={preview.src}
            alt={preview.alt}
            onClose={() => setPreview(null)}
            extraActions={<CopyImageButton url={preview.src} variant="circle" />}
          />
        )}
      </div>
    )
  }

  return (
    <div className="group flex flex-col items-start gap-1">
      <div className="flex max-w-[94%] items-start gap-2.5 sm:max-w-[88%]">
        <div className="grid size-7 shrink-0 place-items-center rounded-full bg-gradient-to-br from-primary to-chart-5 text-primary-foreground shadow-sm">
          <Sparkles className="size-3.5" />
        </div>
        <div
          className={cn(
            "prose prose-sm dark:prose-invert min-w-0 max-w-none",
            "rounded-2xl rounded-tl-md bg-card px-4 py-2.5 text-sm leading-relaxed",
            "border border-border/70 shadow-sm",
            "[&_pre]:max-w-full [&_pre]:overflow-x-auto [&_pre]:whitespace-pre",
            "[&_*]:break-words [&_a]:break-all",
            "prose-pre:bg-muted prose-pre:text-foreground prose-pre:border prose-pre:border-border",
            "[&_pre_code]:!text-foreground [&_pre_code]:!bg-transparent",
            "prose-img:max-w-full prose-img:rounded-xl prose-img:border prose-img:border-border prose-img:shadow-sm",
            "prose-code:rounded prose-code:bg-muted prose-code:px-1 prose-code:py-0.5 prose-code:text-[0.85em] prose-code:font-normal prose-code:before:content-none prose-code:after:content-none"
          )}
        >
          <ReactMarkdown
            remarkPlugins={[remarkGfm]}
            components={{
              pre: ({ node: _node, ...props }) => <CodeBlock {...props} />,
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
                    <div
                      className={cn(
                        "absolute bottom-2 right-2 z-10 flex items-center gap-1",
                        "opacity-0 transition-opacity group-hover/img:opacity-100",
                        published && "opacity-100"
                      )}
                    >
                      {url && (
                        <>
                          <CopyImageButton url={url} />
                          <a
                            href={url}
                            download={fname || "image"}
                            title="下载图片"
                            onClick={(e) => e.stopPropagation()}
                            className="inline-flex items-center gap-1 rounded-md border border-border bg-background/80 px-2 py-1 text-xs backdrop-blur hover:bg-accent"
                          >
                            <Download className="size-3" /> 下载
                          </a>
                        </>
                      )}
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
                            "inline-flex items-center gap-1 rounded-md border border-border bg-background/80 px-2 py-1 text-xs backdrop-blur",
                            published && "cursor-default",
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
                    </div>
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
        <ImagePreview
          src={preview.src}
          alt={preview.alt}
          onClose={() => setPreview(null)}
          extraActions={<CopyImageButton url={preview.src} variant="circle" />}
        />
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
  const [searchParams] = useSearchParams()
  const msgAnchorParam = searchParams.get("msg")
  const targetMsgId = msgAnchorParam ? Number(msgAnchorParam) : null
  const [highlightedMsgId, setHighlightedMsgId] = useState<number | null>(null)
  const msgAnchorScrolledRef = useRef<string | null>(null)

  const [settings, setSettings] = useState<UpstreamSettings>(() =>
    user
      ? loadSettings(user.id)
      : {
          chatMode: "platform",
          imageMode: "platform",
          protocol: "openai",
          baseUrl: "",
          apiKey: "",
          model: "",
          useProxy: true,
          imageProtocol: "openai",
          imageBaseUrl: "",
          imageApiKey: "",
          imageModel: "",
          imageUseProxy: true,
          webSearch: false,
          cloudSync: false,
        }
  )
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [rechargeOpen, setRechargeOpen] = useState(false)
  const [ledgerOpen, setLedgerOpen] = useState(false)
  const [libraryOpen, setLibraryOpen] = useState(false)
  const [skillsOpen, setSkillsOpen] = useState(false)
  const [mobileNavOpen, setMobileNavOpen] = useState(false)
  const [publishedFilenames, setPublishedFilenames] = useState<Set<string>>(
    new Set()
  )
  const [publishingFilename, setPublishingFilename] = useState<string | null>(
    null
  )
  const [creditsMe, setCreditsMe] = useState<CreditsMe | null>(null)
  const [attachedSkills, setAttachedSkills] = useState<Skill[]>([])
  const [systemPromptOpen, setSystemPromptOpen] = useState(false)
  const [messages, setMessages] = useState<UiMessage[]>([])
  const [systemPrompt, setSystemPrompt] = useState("")
  const [loadingMessages, setLoadingMessages] = useState(false)
  const [input, setInput] = useState("")
  const [streaming, setStreaming] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [sidebarReload, setSidebarReload] = useState(0)
  const [copiedKey, setCopiedKey] = useState<string | null>(null)
  const [attachments, setAttachments] = useState<
    Array<{ id: string; file: File; previewUrl: string }>
  >([])
  const abortRef = useRef<AbortController | null>(null)
  // Set to a freshly-created conversation id so the conversation-load effect
  // skips fetching it: send() already owns the message state and is about to
  // stream into it; loading the (empty) server list would clobber the stream.
  const skipLoadRef = useRef<number | null>(null)
  const bottomRef = useRef<HTMLDivElement>(null)
  const scrollRef = useRef<HTMLDivElement>(null)
  const atBottomRef = useRef(true)
  const [showJumpToBottom, setShowJumpToBottom] = useState(false)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const attachInputRef = useRef<HTMLInputElement>(null)

  // Release object URLs for removed / unmounted previews.
  useEffect(() => {
    return () => {
      for (const a of attachments) URL.revokeObjectURL(a.previewUrl)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    if (!user) return
    setSettings(loadSettings(user.id))
    let cancelled = false
    loadEffectiveSettings(user.id).then((s) => {
      if (!cancelled) setSettings(s)
    })
    creditsApi
      .me()
      .then((m) => {
        if (cancelled) return
        setCreditsMe(m)
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

  useEffect(() => {
    if (!conversationId) {
      setMessages([])
      setSystemPrompt("")
      setAttachedSkills([])
      return
    }
    // A conversation just created by send() that we're about to stream into:
    // skip the fetch — send() owns the message state, and loading the (still
    // empty) server list here would clobber the in-flight stream.
    if (skipLoadRef.current === conversationId) {
      skipLoadRef.current = null
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

  // Auto-delete a conversation when the user leaves it without ever sending
  // a message. Guarded by `loaded` so a slow-loading existing conversation
  // doesn't get nuked if the user clicks away mid-fetch.
  const emptyTrackRef = useRef<{
    id: number
    loaded: boolean
    hadMessages: boolean
  }>({ id: 0, loaded: false, hadMessages: false })
  useEffect(() => {
    if (conversationId == null) return
    if (emptyTrackRef.current.id !== conversationId) {
      emptyTrackRef.current = {
        id: conversationId,
        loaded: false,
        hadMessages: false,
      }
    }
    if (!loadingMessages) emptyTrackRef.current.loaded = true
    if (messages.length > 0) emptyTrackRef.current.hadMessages = true
  }, [conversationId, loadingMessages, messages])
  useEffect(() => {
    if (conversationId == null) return
    const id = conversationId
    return () => {
      const ref = emptyTrackRef.current
      if (ref.id === id && ref.loaded && !ref.hadMessages) {
        conversationsApi
          .remove(id)
          .then(() => setSidebarReload((x) => x + 1))
          .catch(() => {})
      }
    }
  }, [conversationId])

  // Scroll to the anchored message when arriving via Sidebar search (?msg=<id>).
  // Guarded by a per-(convId,msgId) ref so the effect doesn't re-scroll on
  // every messages re-render (e.g. mid-stream token updates).
  useEffect(() => {
    if (targetMsgId == null || conversationId == null) return
    if (loadingMessages) return
    if (!messages.some((m) => m.id === targetMsgId)) return
    const key = `${conversationId}-${targetMsgId}`
    if (msgAnchorScrolledRef.current === key) return
    const handle = requestAnimationFrame(() => {
      const el = document.getElementById(`msg-${targetMsgId}`)
      if (el) {
        el.scrollIntoView({ behavior: "smooth", block: "center" })
        setHighlightedMsgId(targetMsgId)
        msgAnchorScrolledRef.current = key
      }
    })
    return () => cancelAnimationFrame(handle)
  }, [targetMsgId, conversationId, loadingMessages, messages])

  useEffect(() => {
    if (highlightedMsgId == null) return
    const t = window.setTimeout(() => setHighlightedMsgId(null), 2200)
    return () => window.clearTimeout(t)
  }, [highlightedMsgId])

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

  const effectiveSystemPrompt = useMemo(
    () => composeSystemPromptWithSkills(systemPrompt, attachedSkills),
    [systemPrompt, attachedSkills]
  )

  // Sticky-bottom auto-scroll: only follow the stream when the user is already
  // pinned to the bottom. As soon as they scroll up to read earlier content we
  // stop fighting them — `atBottomRef` is updated by the container's onScroll.
  useEffect(() => {
    if (!atBottomRef.current) return
    bottomRef.current?.scrollIntoView({ behavior: "smooth" })
  }, [messages, streaming])

  function handleScroll(e: React.UIEvent<HTMLDivElement>) {
    const el = e.currentTarget
    const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight
    const atBottom = distanceFromBottom < 50
    atBottomRef.current = atBottom
    setShowJumpToBottom(!atBottom)
  }

  function jumpToBottom() {
    atBottomRef.current = true
    setShowJumpToBottom(false)
    bottomRef.current?.scrollIntoView({ behavior: "smooth" })
  }

  const configured =
    settings.chatMode === "platform"
      ? Boolean(settings.model)
      : Boolean(settings.baseUrl && settings.apiKey && settings.model)
  const canSend =
    (input.trim().length > 0 || attachments.length > 0) &&
    !streaming &&
    configured

  function addAttachments(files: FileList | File[]) {
    const picked = Array.from(files).filter((f) => f.type.startsWith("image/"))
    if (picked.length === 0) return
    const next = picked.map((file) => ({
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      file,
      previewUrl: URL.createObjectURL(file),
    }))
    setAttachments((prev) => [...prev, ...next])
  }

  function removeAttachment(id: string) {
    setAttachments((prev) => {
      const hit = prev.find((a) => a.id === id)
      if (hit) URL.revokeObjectURL(hit.previewUrl)
      return prev.filter((a) => a.id !== id)
    })
  }

  function clearAttachments() {
    setAttachments((prev) => {
      for (const a of prev) URL.revokeObjectURL(a.previewUrl)
      return []
    })
  }

  async function uploadAttachment(file: File): Promise<string> {
    const mime = file.type || "image/png"
    const buf = await file.arrayBuffer()
    const bytes = new Uint8Array(buf)
    let bin = ""
    const chunk = 0x8000
    for (let i = 0; i < bytes.length; i += chunk) {
      bin += String.fromCharCode(...bytes.subarray(i, i + chunk))
    }
    const b64 = btoa(bin)
    const res = await fetch("/api/images/save", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ b64, mime }),
      credentials: "same-origin",
    })
    if (!res.ok) {
      const text = await res.text().catch(() => res.statusText)
      throw new Error(text || `HTTP ${res.status}`)
    }
    const j = (await res.json()) as { path: string }
    return j.path
  }

  const banner = useMemo(() => {
    if (!configured) {
      return (
        <div className="rounded-xl border border-amber-500/40 bg-amber-500/5 px-4 py-3">
          <p className="text-sm">
            {settings.chatMode === "platform"
              ? <>尚未选择模型。点击右上角 <b>设置</b> 在「云端积分」模式下选择一个模型。</>
              : <>尚未配置模型。点击右上角 <b>设置</b> 填入 Base URL、Key 和模型名。</>}
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
      skipLoadRef.current = c.id
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

    const convId = await ensureConversation()
    if (!convId) return

    // Upload attachments first — fail early so the user message never gets
    // added if image saving breaks.
    const pending = attachments
    let uploadedPaths: string[] = []
    if (pending.length > 0) {
      try {
        uploadedPaths = await Promise.all(
          pending.map((a) => uploadAttachment(a.file))
        )
      } catch (e) {
        setError(`图片上传失败：${e instanceof Error ? e.message : String(e)}`)
        return
      }
    }

    setInput("")
    setError(null)
    clearAttachments()
    // User just hit send — they definitely want to see their own message and
    // the incoming response, so re-arm sticky-bottom regardless of where they
    // were scrolled before.
    atBottomRef.current = true
    setShowJumpToBottom(false)

    // Compose the user message. Text first, then each uploaded image
    // referenced as standard markdown — the chat-stream layer later
    // extracts these refs and re-encodes them as input_image parts.
    const imagesMd = uploadedPaths.map((p) => `![](${p})`).join("\n")
    const composed = text
      ? imagesMd
        ? `${text}\n\n${imagesMd}`
        : text
      : imagesMd

    const userMsg: UiMessage = { role: "user", content: composed }
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
        usePlatform: settings.chatMode === "platform",
        webSearch: settings.webSearch,
        imageGen: settings.protocol === "openai",
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
        patchAssistant: (update) => {
          setMessages((prev) => {
            const last = prev[prev.length - 1]
            if (last?.role !== "assistant") return prev
            const copy = prev.slice()
            copy[copy.length - 1] = { ...last, content: update(last.content) }
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
      { role: "user", content: composed },
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
        usePlatform: settings.chatMode === "platform",
        webSearch: settings.webSearch,
        imageGen: settings.protocol === "openai",
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
        patchAssistant: (update) => {
          setMessages((prev) => {
            const tail = prev[prev.length - 1]
            if (tail?.role !== "assistant") return prev
            const copy = prev.slice()
            copy[copy.length - 1] = { ...tail, content: update(tail.content) }
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
    setInput(target.content)
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
      {mobileNavOpen && (
        <button
          type="button"
          aria-label="关闭侧栏"
          onClick={() => setMobileNavOpen(false)}
          className="fixed inset-0 z-30 bg-black/50 md:hidden"
        />
      )}
      <div
        className={cn(
          "fixed inset-y-0 left-0 z-40 transition-transform",
          mobileNavOpen ? "translate-x-0 shadow-2xl" : "-translate-x-full",
          "md:static md:translate-x-0 md:shadow-none"
        )}
      >
        <Sidebar
          reloadKey={sidebarReload}
          onOpenLibrary={() => setLibraryOpen(true)}
          onNavigate={() => setMobileNavOpen(false)}
        />
      </div>

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="relative z-30 flex items-center justify-between gap-2 border-b border-border bg-background/70 px-2 py-3 backdrop-blur md:gap-3 md:px-5">
          <div className="flex min-w-0 flex-1 items-center gap-1.5 md:gap-3">
            <Button
              variant="ghost"
              size="icon"
              className="shrink-0 md:hidden"
              onClick={() => setMobileNavOpen(true)}
              aria-label="打开侧栏"
            >
              <Menu />
            </Button>
            <h1 className="hidden truncate text-base font-semibold tracking-tight md:block">
              {conversationId ? `会话 #${conversationId}` : "新对话"}
            </h1>
            <ModelPicker
              protocol={settings.protocol}
              model={settings.model}
              settings={settings}
              onChangeModel={(next, nextProtocol) => {
                const updated: UpstreamSettings = {
                  ...settings,
                  model: next,
                  ...(nextProtocol ? { protocol: nextProtocol } : {}),
                }
                setSettings(updated)
                if (user) saveSettings(user.id, updated)
                if (updated.cloudSync) {
                  settingsApi.save(updated).catch(() => {
                    /* non-fatal */
                  })
                }
              }}
            />
          </div>
          <div className="flex shrink-0 items-center">
            {creditsMe && (
              <div className="mr-1 inline-flex items-center overflow-hidden rounded-full border border-border bg-muted/40 text-xs tabular-nums transition-colors hover:border-primary/60">
                <button
                  type="button"
                  onClick={() => setLedgerOpen(true)}
                  className="inline-flex items-center gap-1 px-2 py-1 hover:bg-primary/10 md:px-2.5"
                  title={`剩余积分 ${creditsMe.balance}｜点击查看积分明细`}
                >
                  <span className="hidden text-muted-foreground md:inline">积分</span>
                  <span className="font-medium">{creditsMe.balance}</span>
                </button>
                <button
                  type="button"
                  onClick={() => setRechargeOpen(true)}
                  className="inline-flex items-center border-l border-border px-2 py-1 text-muted-foreground hover:bg-primary/10 hover:text-primary"
                  title="充值积分"
                  aria-label="充值积分"
                >
                  <Plus className="size-3" />
                </button>
              </div>
            )}
            <Button
              variant="ghost"
              size="icon"
              onClick={() => setSystemPromptOpen(true)}
              title={systemPrompt ? "系统提示词（已设置）" : "系统提示词"}
              className="relative size-8 md:size-9"
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
              className="hidden md:inline-flex"
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
              className="relative size-8 md:size-9"
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
              onClick={() => nav("/plaza")}
              title="图片广场"
              className="hidden size-8 sm:inline-flex md:size-9"
            >
              <Images />
            </Button>
            <Button
              variant="ghost"
              size="icon"
              onClick={() => setSettingsOpen(true)}
              title="设置"
              className="size-8 md:size-9"
            >
              <Settings />
            </Button>
          </div>
        </header>

        <div
          ref={scrollRef}
          onScroll={handleScroll}
          className="nc-scroll relative flex-1 overflow-y-auto"
        >
          <div className="mx-auto flex w-full max-w-3xl flex-col gap-4 px-3 py-5 md:px-5 md:py-6">
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
                    回车发送，Shift + 回车换行。
                    {settings.protocol === "openai"
                      ? "直接用文字描述就能让 AI 生图（如「画一只柯基」）；想多轮编辑或调参数请到侧栏「图像工作室」。"
                      : "想生图请切到 OpenAI 协议，或到侧栏「图像工作室」。"}
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
              const isHighlighted =
                m.id !== undefined && highlightedMsgId === m.id
              return (
                <div
                  key={key}
                  id={m.id != null ? `msg-${m.id}` : undefined}
                  className={cn(
                    "scroll-mt-24 rounded-2xl transition-colors duration-700",
                    isHighlighted
                      ? "bg-yellow-300/20 dark:bg-yellow-400/15"
                      : "bg-transparent"
                  )}
                >
                  <Bubble
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
                    userAvatarUrl={user?.avatar_url ?? null}
                    userInitial={(
                      user?.display_name?.trim() || user?.username || "?"
                    ).slice(0, 1)}
                  />
                </div>
              )
            })}
            {error && (
              <div className="rounded-xl border border-destructive/40 bg-destructive/10 px-4 py-2.5 text-sm text-destructive">
                {error}
              </div>
            )}
            <div ref={bottomRef} />
          </div>
          {showJumpToBottom && (
            <button
              type="button"
              onClick={jumpToBottom}
              aria-label="回到底部"
              className="sticky bottom-4 ml-auto mr-4 flex size-9 items-center justify-center rounded-full border border-border bg-background/90 text-foreground shadow-panel backdrop-blur-sm transition hover:bg-accent"
            >
              <ArrowDown className="size-4" />
            </button>
          )}
        </div>

        <div className="bg-background px-3 pb-3 pt-2 md:px-5 md:pb-4">
          <div className="mx-auto max-w-3xl">
            {attachments.length > 0 && (
              <div className="mb-2 flex flex-wrap gap-2 rounded-xl border border-border bg-card p-2">
                {attachments.map((a) => (
                  <div
                    key={a.id}
                    className="group relative size-16 overflow-hidden rounded-lg border border-border bg-muted"
                  >
                    <img
                      src={a.previewUrl}
                      alt={a.file.name}
                      className="size-full object-cover"
                    />
                    <button
                      type="button"
                      onClick={() => removeAttachment(a.id)}
                      className="absolute right-0.5 top-0.5 grid size-5 place-items-center rounded-full bg-background/80 text-muted-foreground opacity-0 transition-opacity hover:bg-background hover:text-foreground group-hover:opacity-100"
                      aria-label="移除图片"
                      title="移除图片"
                      disabled={streaming}
                    >
                      <X className="size-3" />
                    </button>
                  </div>
                ))}
              </div>
            )}
            <input
              ref={attachInputRef}
              type="file"
              accept="image/png,image/jpeg,image/webp,image/gif"
              multiple
              className="hidden"
              onChange={(e) => {
                if (e.target.files) addAttachments(e.target.files)
                e.target.value = ""
              }}
            />
            <div className="flex items-end gap-2 rounded-2xl border border-border bg-card p-2 shadow-panel focus-within:border-primary/40 focus-within:ring-2 focus-within:ring-ring">
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="shrink-0"
                aria-label="附加图片"
                title="附加图片（支持多选）"
                disabled={streaming}
                onClick={() => attachInputRef.current?.click()}
              >
                <Paperclip />
              </Button>
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
              <Textarea
                ref={textareaRef}
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onPaste={(e) => {
                  const items = e.clipboardData?.items
                  if (!items) return
                  const images: File[] = []
                  for (const item of items) {
                    if (item.kind !== "file") continue
                    if (!item.type.startsWith("image/")) continue
                    const f = item.getAsFile()
                    if (f) {
                      const ext = (f.type.split("/")[1] || "png").split("+")[0]
                      const named =
                        f.name && f.name !== "image.png"
                          ? f
                          : new File([f], `pasted-${Date.now()}.${ext}`, {
                              type: f.type,
                            })
                      images.push(named)
                    }
                  }
                  if (images.length > 0) {
                    e.preventDefault()
                    addAttachments(images)
                  }
                }}
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
                  !configured ? "先在设置中配置 API…" : "问点什么…"
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
                  aria-label="发送"
                  title="发送"
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

      <CreditsLedgerDialog
        open={ledgerOpen}
        onClose={() => setLedgerOpen(false)}
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

    </div>
  )
}
