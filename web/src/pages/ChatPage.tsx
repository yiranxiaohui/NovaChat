import { useEffect, useMemo, useRef, useState } from "react"
import { useNavigate, useParams } from "react-router-dom"
import {
  ArrowUp,
  BookMarked,
  Check,
  ClipboardCheck,
  Copy,
  Download,
  Globe,
  Images,
  MessageSquareText,
  Minus,
  Pencil,
  Plus,
  RefreshCcw,
  RotateCcw,
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
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import { streamChat, type ChatMessage } from "@/lib/chat-stream"
import { listModels } from "@/lib/models"
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

function ModelPicker({
  protocol,
  model,
  settings,
  onChangeModel,
}: {
  protocol: Protocol
  model: string
  settings: UpstreamSettings
  onChangeModel: (next: string) => void
}) {
  const [open, setOpen] = useState(false)
  const [models, setModels] = useState<string[]>([])
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

  const useShared = settings.useShared
  const baseUrl = settings.baseUrl
  const apiKey = settings.apiKey
  const useProxy = settings.useProxy
  const fetchProtocol = settings.protocol

  async function fetchList() {
    setError(null)
    setLoading(true)
    try {
      const list = await listModels({
        protocol: fetchProtocol as Protocol,
        baseUrl,
        apiKey,
        useProxy,
        useShared,
        flavor: "chat",
      })
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

  // Reset model cache when upstream context changes (protocol/baseUrl/shared).
  useEffect(() => {
    setModels([])
    setError(null)
  }, [useShared, baseUrl, fetchProtocol])

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return models
    return models.filter((m) => m.toLowerCase().includes(q))
  }, [models, query])

  return (
    <div className="relative" ref={popRef}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="inline-flex items-center gap-1.5 rounded-full border border-border bg-muted/40 px-2.5 py-1 text-xs transition-colors hover:border-primary/60 hover:bg-primary/10"
        title="点击切换模型"
      >
        <span
          className={cn(
            "inline-block size-2 rounded-full bg-gradient-to-br",
            PROTOCOL_COLOR[protocol]
          )}
        />
        <span className="font-medium">
          {PROTOCOL_META[protocol].label.replace(" 兼容", "")}
        </span>
        <span className="text-muted-foreground">·</span>
        <span className="truncate text-muted-foreground">{model || "未配置"}</span>
        <span className="text-muted-foreground">▾</span>
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
                const active = m === model
                return (
                  <li key={m}>
                    <button
                      type="button"
                      onClick={() => {
                        onChangeModel(m)
                        setOpen(false)
                      }}
                      className={cn(
                        "flex w-full items-center justify-between rounded px-2 py-1.5 text-left text-xs hover:bg-accent",
                        active && "bg-accent text-accent-foreground"
                      )}
                    >
                      <span className="truncate font-mono">{m}</span>
                      {active && <Check className="size-3.5 text-primary" />}
                    </button>
                  </li>
                )
              })}
            </ul>
          </div>
          <div className="mt-2 border-t border-border pt-2 text-[10px] text-muted-foreground">
            {useShared
              ? "共享后端 · 实时从上游获取"
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

const MIN_ZOOM = 0.2
const MAX_ZOOM = 8

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

function ImagePreview({
  src,
  alt,
  onClose,
}: {
  src: string
  alt: string
  onClose: () => void
}) {
  const [scale, setScale] = useState(1)
  const [offset, setOffset] = useState({ x: 0, y: 0 })
  const dragRef = useRef<{ startX: number; startY: number; ox: number; oy: number } | null>(null)

  const reset = () => {
    setScale(1)
    setOffset({ x: 0, y: 0 })
  }
  const zoomBy = (factor: number) => {
    setScale((s) => Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, s * factor)))
  }

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose()
      else if (e.key === "+" || e.key === "=") zoomBy(1.2)
      else if (e.key === "-" || e.key === "_") zoomBy(1 / 1.2)
      else if (e.key === "0") reset()
    }
    window.addEventListener("keydown", onKey)
    const prevOverflow = document.body.style.overflow
    document.body.style.overflow = "hidden"
    return () => {
      window.removeEventListener("keydown", onKey)
      document.body.style.overflow = prevOverflow
    }
  }, [onClose])

  const onWheel = (e: React.WheelEvent) => {
    e.preventDefault()
    const factor = e.deltaY < 0 ? 1.12 : 1 / 1.12
    setScale((s) => Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, s * factor)))
  }

  const onPointerDown = (e: React.PointerEvent<HTMLImageElement>) => {
    if (scale <= 1) return
    ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
    dragRef.current = {
      startX: e.clientX,
      startY: e.clientY,
      ox: offset.x,
      oy: offset.y,
    }
  }
  const onPointerMove = (e: React.PointerEvent<HTMLImageElement>) => {
    const d = dragRef.current
    if (!d) return
    setOffset({
      x: d.ox + (e.clientX - d.startX),
      y: d.oy + (e.clientY - d.startY),
    })
  }
  const onPointerUp = (e: React.PointerEvent<HTMLImageElement>) => {
    dragRef.current = null
    try {
      ;(e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId)
    } catch {
      /* ignore */
    }
  }

  const onDoubleClick = (e: React.MouseEvent) => {
    e.stopPropagation()
    if (scale === 1) {
      setScale(2)
    } else {
      reset()
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center overflow-hidden bg-black/80 p-4 select-none"
      onClick={onClose}
      onWheel={onWheel}
      role="dialog"
      aria-label="图片预览"
    >
      <img
        src={src}
        alt={alt}
        draggable={false}
        onClick={(e) => e.stopPropagation()}
        onDoubleClick={onDoubleClick}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        style={{
          transform: `translate(${offset.x}px, ${offset.y}px) scale(${scale})`,
          cursor: scale > 1 ? (dragRef.current ? "grabbing" : "grab") : "zoom-in",
          transition: dragRef.current ? "none" : "transform 120ms ease-out",
        }}
        className="max-h-[95vh] max-w-[95vw] rounded-lg shadow-2xl will-change-transform"
      />

      <div
        className="absolute bottom-6 left-1/2 flex -translate-x-1/2 items-center gap-1 rounded-full border border-white/10 bg-black/60 px-1.5 py-1 text-white shadow-lg backdrop-blur"
        onClick={(e) => e.stopPropagation()}
      >
        <button
          type="button"
          onClick={() => zoomBy(1 / 1.2)}
          aria-label="缩小"
          title="缩小 ( - )"
          className="grid size-8 place-items-center rounded-full hover:bg-white/10"
        >
          <Minus className="size-4" />
        </button>
        <button
          type="button"
          onClick={reset}
          aria-label="重置"
          title="重置 ( 0 )"
          className="inline-flex h-8 min-w-[3.75rem] items-center justify-center gap-1 rounded-full px-2 text-xs tabular-nums hover:bg-white/10"
        >
          <RotateCcw className="size-3.5" />
          {Math.round(scale * 100)}%
        </button>
        <button
          type="button"
          onClick={() => zoomBy(1.2)}
          aria-label="放大"
          title="放大 ( + )"
          className="grid size-8 place-items-center rounded-full hover:bg-white/10"
        >
          <Plus className="size-4" />
        </button>
      </div>

      <div
        className="absolute right-4 top-4 flex items-center gap-2"
        onClick={(e) => e.stopPropagation()}
      >
        <CopyImageButton url={src} variant="circle" />
        <a
          href={src}
          download={filenameFromPath(src) || "image"}
          aria-label="下载图片"
          title="下载图片"
          className="inline-flex size-9 items-center justify-center rounded-full bg-black/60 text-white hover:bg-black/80"
        >
          <Download className="size-5" />
        </a>
        <button
          type="button"
          onClick={onClose}
          aria-label="关闭预览"
          className="inline-flex size-9 items-center justify-center rounded-full bg-black/60 text-white hover:bg-black/80"
        >
          <X className="size-5" />
        </button>
      </div>
    </div>
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
    setInput(prompt)
    textareaRef.current?.focus()
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
            <ModelPicker
              protocol={settings.protocol}
              model={settings.model}
              settings={settings}
              onChangeModel={(next) => {
                const updated: UpstreamSettings = { ...settings, model: next }
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
            <div className="flex items-end gap-2 rounded-2xl border border-border bg-card p-2 shadow-panel focus-within:border-primary/40 focus-within:ring-2 focus-within:ring-ring">
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
      />
    </div>
  )
}
