import { useEffect, useMemo, useRef, useState } from "react"
import { Link } from "react-router-dom"
import {
  ArrowLeft,
  Check,
  Copy,
  Download,
  ImageIcon,
  ImagePlus,
  Images,
  Loader2,
  RefreshCw,
  Sparkles,
  Trash2,
  Upload,
  X,
} from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { useAuth } from "@/lib/auth-context"
import { loadEffectiveSettings, IMAGE_PROTOCOL_META } from "@/lib/settings"
import { studioApi, type StudioGeneration } from "@/lib/studio"
import { creditsApi, type SharedStatus } from "@/lib/credits"
import { plazaApi, filenameFromPath } from "@/lib/image-plaza"
import { BrandMark } from "@/components/app/BrandMark"
import { ImagePlazaDialog } from "@/components/app/ImagePlazaDialog"

const SIZE_OPTIONS = [
  { value: "auto", label: "自动" },
  { value: "1024x1024", label: "1024×1024（正方）" },
  { value: "1024x1792", label: "1024×1792（竖版）" },
  { value: "1792x1024", label: "1792×1024（横版）" },
]
const QUALITY_OPTIONS = [
  { value: "auto", label: "自动" },
  { value: "low", label: "低" },
  { value: "medium", label: "中" },
  { value: "high", label: "高" },
  { value: "standard", label: "Standard（DALL·E）" },
  { value: "hd", label: "HD（DALL·E）" },
]
const STYLE_OPTIONS = [
  { value: "", label: "默认" },
  { value: "vivid", label: "Vivid（鲜艳）" },
  { value: "natural", label: "Natural（自然）" },
]

/// Heuristic for picking image-capable models out of a full /v1/models list.
const IMAGE_MODEL_RE = /image|dall.?e|imagen/i

function fileToDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader()
    r.onload = () => resolve(r.result as string)
    r.onerror = () => reject(r.error ?? new Error("读取失败"))
    r.readAsDataURL(file)
  })
}

// Copy an image URL to the OS clipboard. Many browsers only accept image/png
// via ClipboardItem, so re-encode through a canvas when the source isn't PNG.
async function copyImageToClipboard(url: string): Promise<void> {
  const res = await fetch(url, { credentials: "same-origin" })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  let blob = await res.blob()
  if (blob.type !== "image/png") {
    const objUrl = URL.createObjectURL(blob)
    try {
      const img = new Image()
      await new Promise<void>((resolve, reject) => {
        img.onload = () => resolve()
        img.onerror = () => reject(new Error("图片加载失败"))
        img.src = objUrl
      })
      const canvas = document.createElement("canvas")
      canvas.width = img.naturalWidth
      canvas.height = img.naturalHeight
      const ctx = canvas.getContext("2d")
      if (!ctx) throw new Error("Canvas 不可用")
      ctx.drawImage(img, 0, 0)
      blob = await new Promise<Blob>((resolve, reject) => {
        canvas.toBlob(
          (b) => (b ? resolve(b) : reject(new Error("PNG 编码失败"))),
          "image/png"
        )
      })
    } finally {
      URL.revokeObjectURL(objUrl)
    }
  }
  await navigator.clipboard.write([new ClipboardItem({ "image/png": blob })])
}

export default function ImageStudioPage() {
  const auth = useAuth()
  const user = auth.state.status === "authed" ? auth.state.user : null

  const [prompt, setPrompt] = useState("")
  const [model, setModel] = useState<string>("gpt-image-1")
  const [size, setSize] = useState<string>("1024x1024")
  const [quality, setQuality] = useState<string>("auto")
  const [style, setStyle] = useState<string>("")
  const [attached, setAttached] = useState<File | null>(null)
  const [attachedUrl, setAttachedUrl] = useState<string | null>(null)
  const fileRef = useRef<HTMLInputElement>(null)

  const [shared, setShared] = useState<SharedStatus | null>(null)
  const [sharedLoaded, setSharedLoaded] = useState(false)
  const [useShared, setUseShared] = useState(true)

  const [models, setModels] = useState<string[]>([])
  const [modelsLoading, setModelsLoading] = useState(false)
  const [modelsError, setModelsError] = useState<string | null>(null)
  const [showAllModels, setShowAllModels] = useState(false)

  const [submitting, setSubmitting] = useState(false)
  const [elapsed, setElapsed] = useState(0)
  const [current, setCurrent] = useState<StudioGeneration | null>(null)
  const [error, setError] = useState<string | null>(null)

  const [history, setHistory] = useState<StudioGeneration[]>([])
  const [publishedFilenames, setPublishedFilenames] = useState<Set<string>>(
    new Set()
  )
  const [publishingFilename, setPublishingFilename] = useState<string | null>(
    null
  )
  const [pastedFlash, setPastedFlash] = useState(false)
  const [plazaOpen, setPlazaOpen] = useState(false)
  const tickRef = useRef<number | null>(null)

  useEffect(() => {
    let cancelled = false
    creditsApi
      .sharedStatus()
      .then((s) => {
        if (cancelled) return
        setShared(s)
        setSharedLoaded(true)
      })
      .catch(() => {
        if (cancelled) return
        setShared(null)
        setSharedLoaded(true)
      })
    return () => {
      cancelled = true
    }
  }, [])

  useEffect(() => {
    if (!attached) {
      setAttachedUrl(null)
      return
    }
    const u = URL.createObjectURL(attached)
    setAttachedUrl(u)
    return () => URL.revokeObjectURL(u)
  }, [attached])

  // Accept pasted images anywhere on the page → attach as base image. We
  // preventDefault only when we actually consume an image, so plain text
  // pastes into the prompt textarea still work normally.
  useEffect(() => {
    function onPaste(e: ClipboardEvent) {
      const items = e.clipboardData?.items
      if (!items) return
      for (let i = 0; i < items.length; i++) {
        const it = items[i]!
        if (it.kind === "file" && it.type.startsWith("image/")) {
          const f = it.getAsFile()
          if (f) {
            e.preventDefault()
            setAttached(f)
            setPastedFlash(true)
            window.setTimeout(() => setPastedFlash(false), 1500)
            return
          }
        }
      }
    }
    window.addEventListener("paste", onPaste)
    return () => window.removeEventListener("paste", onPaste)
  }, [])

  async function reloadModels() {
    if (!user) return
    setModelsLoading(true)
    setModelsError(null)
    try {
      const effective = await loadEffectiveSettings(user.id)
      const imgMeta = IMAGE_PROTOCOL_META.openai
      const effectivelyShared = useShared && !!shared?.image_openai_available && !!shared?.enabled
      const list = await studioApi.listModels({
        useShared: effectivelyShared,
        upstreamUrl: effectivelyShared
          ? undefined
          : `${(effective.imageBaseUrl || imgMeta.defaultBaseUrl).replace(/\/+$/, "")}`,
        upstreamKey: effectivelyShared ? undefined : effective.imageApiKey,
      })
      setModels(list)
      // Snap to first available image-like model if current selection isn't in list.
      if (list.length > 0) {
        const imageLike = list.filter((m) => IMAGE_MODEL_RE.test(m))
        const visible = showAllModels ? list : imageLike.length > 0 ? imageLike : list
        if (!visible.includes(model)) {
          setModel(visible[0] ?? list[0]!)
        }
      }
    } catch (e) {
      setModelsError(e instanceof Error ? e.message : String(e))
      setModels([])
    } finally {
      setModelsLoading(false)
    }
  }

  async function loadHistory() {
    try {
      setHistory(await studioApi.list(1))
    } catch {
      /* non-fatal */
    }
  }
  useEffect(() => {
    void loadHistory()
    plazaApi
      .listMine()
      .then((rows) => {
        setPublishedFilenames(new Set(rows.map((r) => r.filename)))
      })
      .catch(() => {
        /* non-fatal */
      })
  }, [])

  // Load models whenever the shared toggle (or availability) changes.
  // Gate on sharedLoaded so we don't fire off a bogus "own key" request
  // before the sharedStatus call has resolved.
  useEffect(() => {
    if (!user || !sharedLoaded) return
    void reloadModels()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user?.id, useShared, sharedLoaded, shared?.image_openai_available, shared?.enabled])

  const sharedAvailable = !!shared?.image_openai_available && !!shared?.enabled

  async function generate() {
    if (!user) return
    const p = prompt.trim()
    if (!p) {
      setError("请填写 prompt")
      return
    }
    setError(null)
    setSubmitting(true)
    setCurrent(null)

    const effective = await loadEffectiveSettings(user.id)
    const imgMeta = IMAGE_PROTOCOL_META.openai

    let imageDataUrl: string | undefined
    if (attached) {
      try {
        imageDataUrl = await fileToDataUrl(attached)
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e))
        setSubmitting(false)
        return
      }
    }

    const startedAt = Date.now()
    setElapsed(0)
    if (tickRef.current) window.clearInterval(tickRef.current)
    tickRef.current = window.setInterval(() => {
      setElapsed(Math.floor((Date.now() - startedAt) / 1000))
    }, 1000)

    try {
      const { token } = await studioApi.submit({
        prompt: p,
        model,
        size: size === "auto" ? undefined : size,
        quality: quality === "auto" ? undefined : quality,
        style: style || undefined,
        imageDataUrl,
        useShared: useShared && sharedAvailable,
        upstreamUrl: !useShared || !sharedAvailable
          ? effective.imageBaseUrl || imgMeta.defaultBaseUrl
          : undefined,
        upstreamKey: !useShared || !sharedAvailable ? effective.imageApiKey : undefined,
      })
      const final = await studioApi.waitForJob(token)
      setCurrent(final)
      if (final.status === "failed") {
        setError(final.error || "生成失败")
      }
      await loadHistory()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      if (tickRef.current) {
        window.clearInterval(tickRef.current)
        tickRef.current = null
      }
      setSubmitting(false)
    }
  }

  async function publishToPlaza(g: StudioGeneration) {
    if (!g.image_path) return
    const fname = filenameFromPath(g.image_path)
    if (!fname) return
    if (publishedFilenames.has(fname) || publishingFilename === fname) return
    setPublishingFilename(fname)
    setError(null)
    try {
      await plazaApi.publish({
        filename: fname,
        prompt: g.prompt,
        revised_prompt: g.revised_prompt,
      })
      setPublishedFilenames((s) => new Set(s).add(fname))
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      if (/already published|CONFLICT/i.test(msg)) {
        setPublishedFilenames((s) => new Set(s).add(fname))
      } else {
        setError(`发布失败：${msg}`)
      }
    } finally {
      setPublishingFilename(null)
    }
  }

  async function removeHistory(g: StudioGeneration) {
    if (!window.confirm("删除这条历史？")) return
    try {
      await studioApi.remove(g.id)
      await loadHistory()
      if (current && current.id === g.id) setCurrent(null)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  const effectivePreview = useMemo(() => {
    if (submitting) return null
    return current
  }, [current, submitting])

  const canPublish = (g: StudioGeneration) =>
    !!g.image_path && !!filenameFromPath(g.image_path)

  return (
    <div className="flex h-svh bg-background text-foreground">
      {/* Left: parameter panel */}
      <aside className="flex h-full w-80 shrink-0 flex-col border-r border-sidebar-border bg-sidebar text-sidebar-foreground">
        <div className="flex items-center justify-between px-4 pb-3 pt-4">
          <BrandMark />
        </div>
        <div className="flex flex-col gap-1 px-3 pb-2">
          <Link
            to="/"
            className="flex items-center gap-2 rounded-md px-2 py-1.5 text-xs text-muted-foreground transition-colors hover:bg-sidebar-accent/60 hover:text-sidebar-accent-foreground"
          >
            <ArrowLeft className="size-3.5" /> 返回对话
          </Link>
        </div>

        <div className="nc-scroll flex-1 overflow-y-auto px-4 pb-4">
          <h2 className="mb-2 flex items-center gap-2 text-sm font-semibold">
            <Sparkles className="size-4 text-primary" /> 生成参数
          </h2>

          <div className="mb-3 flex items-center gap-2 rounded-md border border-border bg-card px-2 py-1.5 text-xs">
            <input
              type="checkbox"
              id="use-shared"
              className="size-3.5 accent-primary"
              checked={useShared}
              onChange={(e) => setUseShared(e.target.checked)}
              disabled={!sharedAvailable}
            />
            <label htmlFor="use-shared" className="cursor-pointer flex-1">
              使用共享后端
              {!sharedAvailable && (
                <span className="ml-1 text-muted-foreground">（未启用）</span>
              )}
            </label>
            {useShared && sharedAvailable && (
              <span className="tabular-nums text-muted-foreground">
                {shared?.balance ?? 0} 分
              </span>
            )}
          </div>

          <div className="mb-3 flex flex-col gap-1.5">
            <div className="flex items-center justify-between">
              <Label className="text-xs">模型</Label>
              <button
                type="button"
                onClick={() => void reloadModels()}
                disabled={modelsLoading}
                className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] text-muted-foreground hover:bg-accent hover:text-foreground"
                title="重新拉取模型列表"
              >
                <RefreshCw
                  className={"size-3 " + (modelsLoading ? "animate-spin" : "")}
                />
                {modelsLoading ? "加载中…" : "刷新"}
              </button>
            </div>
            {models.length === 0 ? (
              <Input
                value={model}
                onChange={(e) => setModel(e.target.value)}
                placeholder={modelsLoading ? "加载中…" : "gpt-image-1"}
              />
            ) : (
              <select
                value={model}
                onChange={(e) => setModel(e.target.value)}
                className="h-9 rounded-md border border-input bg-background px-3 text-sm"
              >
                {!(showAllModels ? models : models.filter((m) => IMAGE_MODEL_RE.test(m))).includes(
                  model
                ) && model && <option value={model}>{model}（手动输入）</option>}
                {(showAllModels
                  ? models
                  : models.filter((m) => IMAGE_MODEL_RE.test(m)).length > 0
                    ? models.filter((m) => IMAGE_MODEL_RE.test(m))
                    : models
                ).map((m) => (
                  <option key={m} value={m}>
                    {m}
                  </option>
                ))}
              </select>
            )}
            <div className="flex items-center justify-between text-[11px] text-muted-foreground">
              {modelsError ? (
                <span className="truncate text-destructive" title={modelsError}>
                  拉取失败：{modelsError}
                </span>
              ) : (
                <span>
                  {models.length > 0
                    ? `共 ${models.length} 个可用模型`
                    : modelsLoading
                      ? "正在拉取…"
                      : "点击刷新拉取上游模型"}
                </span>
              )}
              {models.length > 0 && (
                <label className="flex cursor-pointer items-center gap-1">
                  <input
                    type="checkbox"
                    className="size-3 accent-primary"
                    checked={showAllModels}
                    onChange={(e) => setShowAllModels(e.target.checked)}
                  />
                  显示全部
                </label>
              )}
            </div>
          </div>

          <div className="mb-3 flex flex-col gap-1.5">
            <Label className="text-xs">尺寸</Label>
            <select
              value={size}
              onChange={(e) => setSize(e.target.value)}
              className="h-9 rounded-md border border-input bg-background px-3 text-sm"
            >
              {SIZE_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
          </div>

          <div className="mb-3 flex flex-col gap-1.5">
            <Label className="text-xs">质量</Label>
            <select
              value={quality}
              onChange={(e) => setQuality(e.target.value)}
              className="h-9 rounded-md border border-input bg-background px-3 text-sm"
            >
              {QUALITY_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
          </div>

          <div className="mb-3 flex flex-col gap-1.5">
            <Label className="text-xs">
              风格 <span className="text-muted-foreground">(仅 DALL·E 3)</span>
            </Label>
            <select
              value={style}
              onChange={(e) => setStyle(e.target.value)}
              className="h-9 rounded-md border border-input bg-background px-3 text-sm"
            >
              {STYLE_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
          </div>

          <div className="mb-3 flex flex-col gap-1.5">
            <Label className="text-xs">
              底图 <span className="text-muted-foreground">(可选，作为 edit 输入)</span>
            </Label>
            {attachedUrl ? (
              <div
                className={
                  "flex items-center gap-2 rounded-md border p-2 text-xs transition-colors " +
                  (pastedFlash
                    ? "border-primary bg-primary/10"
                    : "border-border bg-card")
                }
              >
                <img
                  src={attachedUrl}
                  alt=""
                  className="size-14 rounded object-cover"
                />
                <span className="flex-1 truncate text-muted-foreground">
                  {pastedFlash ? "已粘贴" : "已上传"}
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
            ) : (
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => fileRef.current?.click()}
                className="w-full justify-start gap-2"
              >
                <ImagePlus className="size-4" /> 上传底图
              </Button>
            )}
            <p className="text-[11px] text-muted-foreground">
              也可直接 Ctrl+V 粘贴图片
            </p>
            <input
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
          </div>

          <div className="mb-3 flex flex-col gap-1.5">
            <Label className="text-xs">Prompt</Label>
            <Textarea
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              rows={5}
              placeholder="一只戴着红色礼帽的猫，坐在雪地里，黄昏，电影感…"
              className="text-sm"
            />
          </div>

          <Button
            onClick={() => void generate()}
            disabled={submitting || !prompt.trim()}
            className="w-full"
          >
            {submitting ? (
              <>
                <Loader2 className="size-4 animate-spin" /> 生成中…（{elapsed}s）
              </>
            ) : (
              <>
                <Sparkles className="size-4" /> 生成图片
              </>
            )}
          </Button>
        </div>
      </aside>

      {/* Right: preview + history */}
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex items-center justify-between border-b border-border bg-background/70 px-6 py-3 backdrop-blur">
          <div className="flex items-center gap-2">
            <ImageIcon className="size-4 text-muted-foreground" />
            <h1 className="text-base font-semibold">图像工作室</h1>
            <span className="text-xs text-muted-foreground">
              单图生成 · 可发布到广场
            </span>
          </div>
          <div className="flex items-center gap-1">
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setPlazaOpen(true)}
              title="图片广场"
            >
              <Images className="size-3.5" /> 图片广场
            </Button>
            <Button variant="ghost" size="sm" onClick={() => void loadHistory()}>
              <RefreshCw className="size-3.5" /> 刷新历史
            </Button>
          </div>
        </header>

        <main className="nc-scroll flex min-h-0 flex-1 flex-col overflow-y-auto">
          {error && (
            <div className="mx-auto my-3 w-full max-w-3xl rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
              <button
                type="button"
                onClick={() => setError(null)}
                className="float-right"
                aria-label="关闭"
              >
                <X className="size-3.5" />
              </button>
              {error}
            </div>
          )}

          <div className="mx-auto flex w-full max-w-5xl flex-col gap-6 px-6 py-6">
            {/* Main preview slot */}
            <div className="rounded-xl border border-border bg-card p-4 shadow-sm">
              {submitting && (
                <div className="flex h-80 flex-col items-center justify-center gap-3 text-muted-foreground">
                  <Loader2 className="size-8 animate-spin" />
                  <p className="text-sm">生成中…（已等 {elapsed}s）</p>
                  <p className="text-xs">
                    浏览器关掉再打开也不影响，结果会保留在历史里
                  </p>
                </div>
              )}

              {!submitting && !effectivePreview && (
                <div className="flex h-80 flex-col items-center justify-center gap-2 text-muted-foreground">
                  <Sparkles className="size-8" />
                  <p className="text-sm">在左侧填写参数后点「生成图片」</p>
                </div>
              )}

              {!submitting && effectivePreview && (
                <PreviewCard
                  gen={effectivePreview}
                  published={
                    effectivePreview.image_path
                      ? publishedFilenames.has(
                          filenameFromPath(effectivePreview.image_path) ?? ""
                        )
                      : false
                  }
                  publishing={
                    effectivePreview.image_path
                      ? publishingFilename ===
                        filenameFromPath(effectivePreview.image_path)
                      : false
                  }
                  onPublish={() => void publishToPlaza(effectivePreview)}
                  canPublish={canPublish(effectivePreview)}
                />
              )}
            </div>

            {/* History grid */}
            <div>
              <h2 className="mb-3 text-sm font-semibold">最近生成</h2>
              {history.length === 0 ? (
                <p className="text-xs text-muted-foreground">暂无历史</p>
              ) : (
                <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
                  {history.map((g) => {
                    const fname = g.image_path ? filenameFromPath(g.image_path) : null
                    const published = fname ? publishedFilenames.has(fname) : false
                    return (
                      <HistoryCard
                        key={g.id}
                        gen={g}
                        published={published}
                        publishing={fname ? publishingFilename === fname : false}
                        onSelect={() => setCurrent(g)}
                        onPublish={() => void publishToPlaza(g)}
                        onRemove={() => void removeHistory(g)}
                      />
                    )
                  })}
                </div>
              )}
            </div>
          </div>
        </main>
      </div>

      <ImagePlazaDialog
        open={plazaOpen}
        onClose={() => setPlazaOpen(false)}
        onUsePrompt={(p) => {
          setPrompt(p)
          setPlazaOpen(false)
        }}
      />
    </div>
  )
}

function PreviewCard({
  gen,
  published,
  publishing,
  canPublish,
  onPublish,
}: {
  gen: StudioGeneration
  published: boolean
  publishing: boolean
  canPublish: boolean
  onPublish: () => void
}) {
  const fname = gen.image_path ? filenameFromPath(gen.image_path) : null
  const [copyState, setCopyState] = useState<"idle" | "copying" | "done" | "error">(
    "idle"
  )
  const [copyError, setCopyError] = useState<string | null>(null)

  async function handleCopy() {
    if (!gen.image_path) return
    setCopyState("copying")
    setCopyError(null)
    try {
      await copyImageToClipboard(gen.image_path)
      setCopyState("done")
      window.setTimeout(() => setCopyState("idle"), 1500)
    } catch (e) {
      setCopyState("error")
      setCopyError(e instanceof Error ? e.message : String(e))
      window.setTimeout(() => setCopyState("idle"), 2500)
    }
  }

  if (gen.status === "failed") {
    return (
      <div className="flex flex-col items-center justify-center gap-3 py-10 text-destructive">
        <X className="size-8" />
        <p className="text-sm">生成失败</p>
        <p className="max-w-lg text-xs text-muted-foreground">
          {gen.error || "未知错误"}
        </p>
      </div>
    )
  }
  if (!gen.image_path) return null
  return (
    <div className="flex flex-col items-center gap-4">
      <img
        src={gen.image_path}
        alt={gen.prompt}
        className="max-h-[70vh] w-auto rounded-lg border border-border shadow-sm"
      />
      <div className="flex w-full max-w-lg flex-col gap-2 text-xs">
        <div className="flex flex-wrap gap-1.5 text-muted-foreground">
          {gen.model && (
            <span className="rounded bg-muted px-1.5 py-0.5">{gen.model}</span>
          )}
          {gen.size && (
            <span className="rounded bg-muted px-1.5 py-0.5">{gen.size}</span>
          )}
          {gen.quality && (
            <span className="rounded bg-muted px-1.5 py-0.5">
              质量 {gen.quality}
            </span>
          )}
          {gen.style && (
            <span className="rounded bg-muted px-1.5 py-0.5">{gen.style}</span>
          )}
        </div>
        <p className="text-sm">
          <b>Prompt：</b> {gen.prompt}
        </p>
        {gen.revised_prompt && gen.revised_prompt !== gen.prompt && (
          <p className="text-muted-foreground">
            <b>Revised：</b> {gen.revised_prompt}
          </p>
        )}
      </div>
      <div className="flex gap-2">
        <Button asChild variant="outline" size="sm">
          <a href={gen.image_path} download={fname || "image"}>
            <Download className="size-4" /> 下载
          </a>
        </Button>
        <Button
          variant="outline"
          size="sm"
          onClick={() => void handleCopy()}
          disabled={copyState === "copying"}
          title={copyError ?? "复制图片到剪贴板，然后可粘贴到左侧底图"}
        >
          {copyState === "done" ? (
            <>
              <Check className="size-4 text-emerald-500" /> 已复制
            </>
          ) : copyState === "error" ? (
            <>
              <X className="size-4 text-destructive" /> 复制失败
            </>
          ) : (
            <>
              <Copy className="size-4" />{" "}
              {copyState === "copying" ? "复制中…" : "复制图片"}
            </>
          )}
        </Button>
        <Button
          variant={published ? "secondary" : "default"}
          size="sm"
          disabled={!canPublish || published || publishing}
          onClick={onPublish}
        >
          {published ? (
            <>
              <Check className="size-4 text-emerald-500" /> 已发布到广场
            </>
          ) : (
            <>
              <Upload className="size-4" />{" "}
              {publishing ? "发布中…" : "发布到图片广场"}
            </>
          )}
        </Button>
      </div>
    </div>
  )
}

function PendingIndicator({ createdAt }: { createdAt: string }) {
  const [elapsed, setElapsed] = useState(() => computeElapsed(createdAt))
  useEffect(() => {
    const id = window.setInterval(() => setElapsed(computeElapsed(createdAt)), 1000)
    return () => window.clearInterval(id)
  }, [createdAt])
  return (
    <div className="flex flex-col items-center gap-1.5">
      <Loader2 className="size-5 animate-spin" />
      <span className="tabular-nums">已等 {elapsed}s</span>
    </div>
  )
}

function computeElapsed(isoUtc: string): number {
  if (!isoUtc) return 0
  // SQLite/Postgres store "YYYY-MM-DD HH:MM:SS" without timezone; treat as UTC.
  const normalized = isoUtc.includes("T")
    ? isoUtc.endsWith("Z") || /[+-]\d{2}:?\d{2}$/.test(isoUtc)
      ? isoUtc
      : `${isoUtc}Z`
    : `${isoUtc.replace(" ", "T")}Z`
  const t = Date.parse(normalized)
  if (Number.isNaN(t)) return 0
  return Math.max(0, Math.floor((Date.now() - t) / 1000))
}

function HistoryCard({
  gen,
  published,
  publishing,
  onSelect,
  onPublish,
  onRemove,
}: {
  gen: StudioGeneration
  published: boolean
  publishing: boolean
  onSelect: () => void
  onPublish: () => void
  onRemove: () => void
}) {
  return (
    <div className="group relative overflow-hidden rounded-lg border border-border bg-card">
      {gen.image_path ? (
        <button
          type="button"
          onClick={onSelect}
          className="block aspect-square w-full"
          title={gen.prompt}
        >
          <img
            src={gen.image_path}
            alt={gen.prompt}
            className="size-full object-cover transition-transform group-hover:scale-105"
          />
        </button>
      ) : (
        <div className="grid aspect-square w-full place-items-center bg-muted text-xs text-muted-foreground">
          {gen.status === "failed" ? (
            <span className="text-destructive">失败</span>
          ) : (
            <PendingIndicator createdAt={gen.created_at} />
          )}
        </div>
      )}

      <div className="absolute inset-x-0 bottom-0 flex flex-col gap-1 bg-gradient-to-t from-black/80 to-transparent p-2 text-xs text-white opacity-0 transition-opacity group-hover:opacity-100">
        <p className="line-clamp-2">{gen.prompt}</p>
        <div className="flex items-center gap-1">
          {gen.image_path && (
            <a
              href={gen.image_path}
              download={filenameFromPath(gen.image_path) || "image"}
              onClick={(e) => e.stopPropagation()}
              className="inline-flex items-center gap-1 rounded bg-white/10 px-1.5 py-0.5 text-[11px] hover:bg-white/20"
              title="下载"
            >
              <Download className="size-3" />
            </a>
          )}
          {gen.image_path && (
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation()
                onPublish()
              }}
              disabled={published || publishing}
              className="inline-flex items-center gap-1 rounded bg-white/10 px-1.5 py-0.5 text-[11px] hover:bg-white/20 disabled:cursor-default disabled:opacity-70"
              title={published ? "已发布" : "发布到广场"}
            >
              {published ? (
                <Check className="size-3 text-emerald-400" />
              ) : (
                <Upload className="size-3" />
              )}
            </button>
          )}
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation()
              onRemove()
            }}
            className="inline-flex items-center gap-1 rounded bg-white/10 px-1.5 py-0.5 text-[11px] hover:bg-red-500/40"
            title="删除"
          >
            <Trash2 className="size-3" />
          </button>
        </div>
      </div>
    </div>
  )
}
