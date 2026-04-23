import { useEffect, useMemo, useRef, useState } from "react"
import { Link, useNavigate, useParams } from "react-router-dom"
import {
  ArrowLeft,
  ArrowUp,
  Image as ImageIcon,
  ImagePlus,
  Loader2,
  Pencil,
  Plus,
  Sparkles,
  Trash2,
  User,
  X,
} from "lucide-react"
import { Button } from "@/components/ui/button"
import { Textarea } from "@/components/ui/textarea"
import { Input } from "@/components/ui/input"
import { useAuth } from "@/lib/auth-context"
import { loadEffectiveSettings } from "@/lib/settings"
import {
  studioApi,
  type StudioConversation,
  type StudioMessage,
} from "@/lib/studio"
import { creditsApi, type SharedStatus } from "@/lib/credits"
import { BrandMark } from "@/components/app/BrandMark"

type TurnState = "idle" | "running"

function fileToDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader()
    r.onload = () => resolve(r.result as string)
    r.onerror = () => reject(r.error ?? new Error("读取失败"))
    r.readAsDataURL(file)
  })
}

export default function ImageStudioPage() {
  const auth = useAuth()
  const user = auth.state.status === "authed" ? auth.state.user : null
  const nav = useNavigate()
  const { id: paramId } = useParams()
  const convId = paramId ? Number(paramId) : null

  const [convs, setConvs] = useState<StudioConversation[]>([])
  const [messages, setMessages] = useState<StudioMessage[]>([])
  const [loadingConvs, setLoadingConvs] = useState(true)
  const [loadingMsgs, setLoadingMsgs] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [turnState, setTurnState] = useState<TurnState>("idle")
  const [turnElapsed, setTurnElapsed] = useState(0)
  const [input, setInput] = useState("")
  const [attached, setAttached] = useState<File | null>(null)
  const [attachedUrl, setAttachedUrl] = useState<string | null>(null)
  const [shared, setShared] = useState<SharedStatus | null>(null)
  const [useShared, setUseShared] = useState(true)
  const bottomRef = useRef<HTMLDivElement>(null)
  const fileRef = useRef<HTMLInputElement>(null)
  const tickRef = useRef<number | null>(null)

  // Load shared status once.
  useEffect(() => {
    creditsApi
      .sharedStatus()
      .then(setShared)
      .catch(() => setShared(null))
  }, [])

  // Load conversation list.
  async function loadConvs() {
    setLoadingConvs(true)
    try {
      setConvs(await studioApi.list())
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setLoadingConvs(false)
    }
  }
  useEffect(() => {
    void loadConvs()
  }, [])

  // Load messages for current conv.
  async function loadMessages(id: number) {
    setLoadingMsgs(true)
    try {
      setMessages(await studioApi.messages(id))
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setLoadingMsgs(false)
    }
  }
  useEffect(() => {
    if (convId == null) {
      setMessages([])
      return
    }
    void loadMessages(convId)
  }, [convId])

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth", block: "end" })
  }, [messages, turnState])

  useEffect(() => {
    if (!attached) {
      setAttachedUrl(null)
      return
    }
    const u = URL.createObjectURL(attached)
    setAttachedUrl(u)
    return () => URL.revokeObjectURL(u)
  }, [attached])

  async function createNew() {
    try {
      const c = await studioApi.create({})
      await loadConvs()
      nav(`/studio/${c.id}`)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  async function removeConv(c: StudioConversation) {
    if (!window.confirm(`删除「${c.title}」及其所有消息？`)) return
    try {
      await studioApi.remove(c.id)
      await loadConvs()
      if (convId === c.id) nav("/studio")
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  async function rename(c: StudioConversation) {
    const next = window.prompt("重命名工作台", c.title)
    if (next == null) return
    const title = next.trim()
    if (!title || title === c.title) return
    try {
      await studioApi.update(c.id, { title })
      await loadConvs()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  async function submit() {
    if (!user) return
    if (turnState === "running") return

    let cid = convId
    if (cid == null) {
      try {
        const c = await studioApi.create({})
        await loadConvs()
        cid = c.id
        nav(`/studio/${c.id}`, { replace: true })
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e))
        return
      }
    }
    if (cid == null) return

    const text = input.trim()
    if (!text && !attached) return

    const effective = await loadEffectiveSettings(user.id)

    let imageDataUrl: string | undefined
    if (attached) {
      try {
        imageDataUrl = await fileToDataUrl(attached)
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e))
        return
      }
    }

    setInput("")
    setAttached(null)
    setError(null)
    setTurnState("running")

    // Optimistic user message.
    setMessages((prev) => [
      ...prev,
      {
        id: -1,
        role: "user",
        text: text || null,
        images: imageDataUrl
          ? [{ path: imageDataUrl }]  // inline preview; real path comes from refetch
          : [],
        created_at: new Date().toISOString(),
      },
    ])

    const startedAt = Date.now()
    setTurnElapsed(0)
    if (tickRef.current) window.clearInterval(tickRef.current)
    tickRef.current = window.setInterval(() => {
      setTurnElapsed(Math.floor((Date.now() - startedAt) / 1000))
    }, 1000)

    try {
      const { token } = await studioApi.submitTurn(cid, {
        text,
        imageDataUrl,
        useShared,
        upstreamUrl: useShared ? undefined : effective.baseUrl,
        upstreamKey: useShared ? undefined : effective.apiKey,
      })
      const j = await studioApi.waitForJob(token)
      if (j.status === "failed") {
        setError(j.error || "生成失败")
      }
    } catch (e) {
      if ((e as { name?: string })?.name !== "AbortError") {
        setError(e instanceof Error ? e.message : String(e))
      }
    } finally {
      if (tickRef.current) {
        window.clearInterval(tickRef.current)
        tickRef.current = null
      }
      setTurnState("idle")
      await loadMessages(cid)
      await loadConvs()
    }
  }

  const canSubmit = useMemo(() => {
    const hasText = input.trim().length > 0
    return (hasText || !!attached) && turnState === "idle"
  }, [input, attached, turnState])

  const sharedAvailable = !!shared?.openai_available && !!shared?.enabled

  return (
    <div className="flex h-svh bg-background text-foreground">
      <aside className="flex h-full w-72 shrink-0 flex-col border-r border-sidebar-border bg-sidebar text-sidebar-foreground">
        <div className="flex items-center justify-between px-4 pb-3 pt-4">
          <BrandMark />
        </div>

        <div className="flex flex-col gap-2 px-3 pb-2">
          <Link
            to="/"
            className="flex items-center gap-2 rounded-md px-2 py-1.5 text-xs text-muted-foreground transition-colors hover:bg-sidebar-accent/60 hover:text-sidebar-accent-foreground"
          >
            <ArrowLeft className="size-3.5" /> 返回对话
          </Link>
          <Button onClick={() => void createNew()} className="w-full justify-start gap-2" size="sm">
            <Plus className="size-4" /> 新建工作台
          </Button>
        </div>

        <div className="nc-scroll flex-1 overflow-y-auto px-2 pb-2">
          {loadingConvs && (
            <p className="px-2 py-1 text-xs text-muted-foreground">加载中…</p>
          )}
          {!loadingConvs && convs.length === 0 && (
            <p className="px-2 py-6 text-center text-xs text-muted-foreground">
              还没有工作台
            </p>
          )}
          <ul className="flex flex-col gap-0.5">
            {convs.map((c) => {
              const active = convId === c.id
              return (
                <li key={c.id} className="group relative">
                  <div
                    className={
                      "flex items-center rounded-lg transition-colors " +
                      (active
                        ? "bg-sidebar-accent text-sidebar-accent-foreground"
                        : "hover:bg-sidebar-accent/50")
                    }
                  >
                    <Link
                      to={`/studio/${c.id}`}
                      className="min-w-0 flex-1 px-3 py-2"
                      title={c.title}
                    >
                      <div className="truncate text-sm font-medium">
                        {c.title}
                      </div>
                      <div className="mt-0.5 truncate text-[11px] text-muted-foreground">
                        {c.model || "默认模型"}
                      </div>
                    </Link>
                    <button
                      type="button"
                      className="mr-1 hidden rounded p-1 text-muted-foreground hover:bg-background/60 hover:text-foreground group-hover:block"
                      onClick={(e) => {
                        e.preventDefault()
                        void rename(c)
                      }}
                      aria-label="重命名"
                      title="重命名"
                    >
                      <Pencil className="size-3.5" />
                    </button>
                    <button
                      type="button"
                      className="mr-1 hidden rounded p-1 text-destructive hover:bg-destructive/10 group-hover:block"
                      onClick={(e) => {
                        e.preventDefault()
                        void removeConv(c)
                      }}
                      aria-label="删除"
                      title="删除"
                    >
                      <Trash2 className="size-3.5" />
                    </button>
                  </div>
                </li>
              )
            })}
          </ul>
        </div>

        <div className="border-t border-sidebar-border px-3 py-2 text-[11px] text-muted-foreground">
          多轮生图（OpenAI Responses API，工具 image_generation）
        </div>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex items-center justify-between border-b border-border bg-background/70 px-6 py-3 backdrop-blur">
          <div className="flex items-center gap-2">
            <ImageIcon className="size-4 text-muted-foreground" />
            <h1 className="text-base font-semibold">图像工作室</h1>
            {convId && (
              <span className="text-xs text-muted-foreground">
                · #{convId}
              </span>
            )}
          </div>
          <div className="flex items-center gap-2">
            <label className="flex cursor-pointer items-center gap-2 rounded-md border border-border px-2 py-1 text-xs">
              <input
                type="checkbox"
                className="size-3.5 accent-primary"
                checked={useShared}
                onChange={(e) => setUseShared(e.target.checked)}
                disabled={!sharedAvailable}
              />
              使用共享后端
              {!sharedAvailable && (
                <span className="text-muted-foreground">（未启用）</span>
              )}
            </label>
          </div>
        </header>

        <main className="nc-scroll flex min-h-0 flex-1 flex-col overflow-y-auto">
          {error && (
            <div className="mx-auto my-3 w-full max-w-3xl rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
              {error}
              <button
                type="button"
                onClick={() => setError(null)}
                className="float-right"
                aria-label="关闭"
              >
                <X className="size-3.5" />
              </button>
            </div>
          )}

          {convId == null && (
            <div className="m-auto flex max-w-md flex-col items-center gap-3 text-center text-sm text-muted-foreground">
              <div className="grid size-12 place-items-center rounded-full bg-primary/10">
                <Sparkles className="size-5 text-primary" />
              </div>
              <p className="text-base font-semibold text-foreground">
                多轮图像生成
              </p>
              <p>
                用对话的方式生图：说"画一只戴帽子的猫"后，下一轮直接说"把帽子改成红色"——模型能看到前面生成的图，自动在上面改。
              </p>
              <Button onClick={() => void createNew()}>
                <Plus className="size-4" /> 新建工作台开始
              </Button>
            </div>
          )}

          {convId != null && (
            <div className="mx-auto flex w-full max-w-3xl flex-col gap-4 px-6 py-4">
              {loadingMsgs && messages.length === 0 && (
                <p className="text-center text-sm text-muted-foreground">加载中…</p>
              )}
              {!loadingMsgs && messages.length === 0 && (
                <p className="text-center text-sm text-muted-foreground">
                  输入提示词开始生成。可在左下角附上一张图进行编辑。
                </p>
              )}
              {messages.map((m) => (
                <MessageRow key={m.id === -1 ? `tmp-${m.created_at}` : m.id} message={m} />
              ))}
              {turnState === "running" && (
                <div className="flex items-center gap-2 pl-9 text-sm text-muted-foreground">
                  <Loader2 className="size-4 animate-spin" /> 生成中…（已等
                  {turnElapsed}s）
                </div>
              )}
              <div ref={bottomRef} />
            </div>
          )}
        </main>

        <div className="border-t border-border bg-background/60 px-6 py-3">
          <div className="mx-auto w-full max-w-3xl">
            {attachedUrl && (
              <div className="mb-2 flex items-center gap-2 rounded-md border border-border bg-card p-2 text-xs">
                <img
                  src={attachedUrl}
                  alt="附加图"
                  className="size-12 rounded object-cover"
                />
                <span className="flex-1 truncate text-muted-foreground">
                  已附加图片 — 本轮作为编辑输入
                </span>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => setAttached(null)}
                  aria-label="移除"
                >
                  <X className="size-3.5" />
                </Button>
              </div>
            )}
            <div className="flex items-end gap-2">
              <Input
                ref={fileRef}
                type="file"
                accept="image/*"
                className="hidden"
                onChange={(e) => {
                  const f = e.target.files?.[0]
                  if (f) setAttached(f)
                  e.target.value = ""
                }}
              />
              <Button
                type="button"
                variant="outline"
                size="icon"
                onClick={() => fileRef.current?.click()}
                disabled={turnState === "running"}
                title="附加图片"
              >
                <ImagePlus className="size-4" />
              </Button>
              <Textarea
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.shiftKey) {
                    e.preventDefault()
                    if (canSubmit) void submit()
                  }
                }}
                rows={1}
                placeholder="描述你想要的图片，或对上一张图的修改…"
                className="min-h-[44px] resize-none"
              />
              <Button
                onClick={() => void submit()}
                disabled={!canSubmit}
                size="icon"
                title="发送"
              >
                <ArrowUp className="size-4" />
              </Button>
            </div>
            <p className="mt-1 text-[10px] text-muted-foreground">
              Enter 发送 · Shift + Enter 换行 · 多轮上下文自动保留
            </p>
          </div>
        </div>
      </div>
    </div>
  )
}

function MessageRow({ message }: { message: StudioMessage }) {
  const isUser = message.role === "user"
  if (isUser) {
    return (
      <div className="flex flex-col items-end gap-1.5">
        <div className="flex max-w-[80%] items-end gap-2">
          <div className="flex flex-col gap-1.5 rounded-2xl rounded-tr-md bg-primary px-4 py-2 text-sm text-primary-foreground shadow-sm">
            {message.text && (
              <p className="whitespace-pre-wrap">{message.text}</p>
            )}
            {message.images.map((img, i) => (
              <img
                key={i}
                src={img.path}
                alt=""
                className="max-h-60 w-auto rounded-md"
              />
            ))}
          </div>
          <div className="grid size-7 shrink-0 place-items-center rounded-full border border-border bg-card text-muted-foreground">
            <User className="size-3.5" />
          </div>
        </div>
      </div>
    )
  }
  return (
    <div className="flex items-start gap-2.5">
      <div className="grid size-7 shrink-0 place-items-center rounded-full bg-gradient-to-br from-primary to-chart-5 text-primary-foreground shadow-sm">
        <Sparkles className="size-3.5" />
      </div>
      <div className="min-w-0 flex-1 rounded-2xl rounded-tl-md border border-border/70 bg-card px-4 py-2.5 shadow-sm">
        {message.text && (
          <p className="mb-2 whitespace-pre-wrap text-sm leading-relaxed">
            {message.text}
          </p>
        )}
        <div className="flex flex-wrap gap-2">
          {message.images.map((img, i) => (
            <a
              key={i}
              href={img.path}
              target="_blank"
              rel="noreferrer"
              className="block"
              title={img.revised_prompt ?? undefined}
            >
              <img
                src={img.path}
                alt=""
                className="max-h-96 w-auto rounded-lg border border-border"
              />
            </a>
          ))}
        </div>
      </div>
    </div>
  )
}
