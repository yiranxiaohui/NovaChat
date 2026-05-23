import { useEffect, useMemo, useRef, useState } from "react"
import { Link, useNavigate, useSearchParams } from "react-router-dom"
import {
  ArrowLeft,
  ArrowLeftToLine,
  Check,
  Copy,
  Download,
  ImageIcon,
  ImagePlus,
  Images,
  Loader2,
  Menu,
  RefreshCw,
  Sparkles,
  Trash2,
  Upload,
  X,
} from "lucide-react"
import { cn } from "@/lib/utils"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { useAuth } from "@/lib/auth-context"
import { loadEffectiveSettings, IMAGE_PROTOCOL_META } from "@/lib/settings"
import { studioApi, type StudioGeneration } from "@/lib/studio"
import { plazaApi, filenameFromPath } from "@/lib/image-plaza"
import { BrandMark } from "@/components/app/BrandMark"
import { ImagePreview } from "@/components/app/ImagePreview"

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

// Map a raw upstream error string to a short, human-oriented hint so the UI
// can tell the user which direction to go (change prompt, change params,
// contact admin, or just retry). Returns null when we can't classify.
function failureHint(err: string | null | undefined): string | null {
  if (!err) return null
  const s = err.toLowerCase()
  if (
    s.includes("content_policy") ||
    s.includes("safety system") ||
    s.includes("content policy") ||
    s.includes("was rejected") ||
    s.includes("moderation_blocked")
  ) {
    return "Prompt 可能触发了上游的内容审核。换个措辞试试（重试帮不上忙）。"
  }
  if (s.includes("does not support") || s.includes("unsupported")) {
    return "当前模型不支持这个参数（尺寸 / 质量 / 风格）。左侧换一下再试。"
  }
  if (
    s.includes("invalid_api_key") ||
    s.includes("incorrect api key") ||
    s.includes("401")
  ) {
    return "API key 无效。自己配 key 的用户检查设置里的密钥；用共享后端时请管理员处理。"
  }
  if (s.includes("insufficient_quota") || s.includes("quota")) {
    return "上游账号额度用尽。用共享后端时请联系管理员；自己配 key 请去 OpenAI 后台充值。"
  }
  if (s.includes("rate limit") || s.includes("429")) {
    return "上游限流，系统已自动重试过。稍等几秒再点重试。"
  }
  if (
    s.includes("timed out") ||
    s.includes("timeout") ||
    s.includes("connection") ||
    s.includes("network")
  ) {
    return "网络抖动或上游超时，系统已自动重试过。点「重试」再跑一次大概率能过。"
  }
  if (s.includes("502") || s.includes("503") || s.includes("504")) {
    return "上游临时故障，已自动重试多次仍失败。稍等一两分钟再重试。"
  }
  return null
}

// Fetch a same-origin image URL and turn it into a File the <input type=file>
// attach-flow can consume. Used by the 用作底图 button so users can round-trip
// a generated image back in as an edit input without downloading.
async function urlToImageFile(url: string, fallbackName = "image"): Promise<File> {
  const res = await fetch(url, { credentials: "same-origin" })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  const blob = await res.blob()
  const name = filenameFromPath(url) || fallbackName
  return new File([blob], name, { type: blob.type || "image/png" })
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
  const nav = useNavigate()
  const [searchParams, setSearchParams] = useSearchParams()

  const [prompt, setPrompt] = useState("")
  const [model, setModel] = useState<string>("gpt-image-1")
  const [size, setSize] = useState<string>("1024x1024")
  const [quality, setQuality] = useState<string>("auto")
  const [style, setStyle] = useState<string>("")
  const [n, setN] = useState<number>(1)
  const [negativePrompt, setNegativePrompt] = useState<string>("")
  const [seed, setSeed] = useState<string>("")
  const [background, setBackground] = useState<string>("")
  const [attached, setAttached] = useState<File | null>(null)
  const [attachedUrl, setAttachedUrl] = useState<string | null>(null)
  const fileRef = useRef<HTMLInputElement>(null)

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
  const [mobileNavOpen, setMobileNavOpen] = useState(false)
  const tickRef = useRef<number | null>(null)

  useEffect(() => {
    if (!attached) {
      setAttachedUrl(null)
      return
    }
    const u = URL.createObjectURL(attached)
    setAttachedUrl(u)
    return () => URL.revokeObjectURL(u)
  }, [attached])

  // Hydrate prompt/base from URL — used by the Image Plaza when the user
  // clicks 「用此提示词」 or 「以此图生图」 to land here with state. We strip
  // the params after consuming them so a refresh doesn't keep re-applying.
  useEffect(() => {
    const promptQ = searchParams.get("prompt")
    const baseQ = searchParams.get("base")
    if (!promptQ && !baseQ) return
    if (promptQ) setPrompt(promptQ)
    if (baseQ) {
      const safeBase = filenameFromPath(`/api/images/${baseQ}`)
      if (!safeBase) {
        setError("载入底图失败：图片文件名无效")
      } else {
        void (async () => {
          try {
            const f = await urlToImageFile(`/api/images/${safeBase}`, safeBase)
            setAttached(f)
          } catch (e) {
            setError(
              `载入底图失败：${e instanceof Error ? e.message : String(e)}`
            )
          }
        })()
      }
    }
    const next = new URLSearchParams(searchParams)
    next.delete("prompt")
    next.delete("base")
    setSearchParams(next, { replace: true })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

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
      const isPlatform = effective.imageMode === "platform"
      const list = await studioApi.listModels(
        isPlatform
          ? {}
          : {
              upstreamUrl: `${(effective.imageBaseUrl || imgMeta.defaultBaseUrl).replace(/\/+$/, "")}`,
              upstreamKey: effective.imageApiKey,
            }
      )
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

  // Load models on first user resolution.
  useEffect(() => {
    if (!user) return
    void reloadModels()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user?.id])

  // Shared submit + poll path used by both the "生成图片" button and the
  // per-card 重试 action. Callers pre-resolve the image to a data URL.
  async function runGeneration(params: {
    prompt: string
    model: string
    size?: string
    quality?: string
    style?: string
    imageDataUrl?: string
    n?: number
    negativePrompt?: string
    seed?: number
    background?: string
  }) {
    if (!user) return
    const effective = await loadEffectiveSettings(user.id)
    const imgMeta = IMAGE_PROTOCOL_META.openai

    setError(null)
    setSubmitting(true)
    setCurrent(null)

    const startedAt = Date.now()
    setElapsed(0)
    if (tickRef.current) window.clearInterval(tickRef.current)
    tickRef.current = window.setInterval(() => {
      setElapsed(Math.floor((Date.now() - startedAt) / 1000))
    }, 1000)

    try {
      const { token } = await studioApi.submit({
        prompt: params.prompt,
        model: params.model,
        size: params.size === "auto" ? undefined : params.size,
        quality: params.quality === "auto" ? undefined : params.quality,
        style: params.style || undefined,
        imageDataUrl: params.imageDataUrl,
        n: params.n,
        negativePrompt: params.negativePrompt,
        seed: params.seed,
        background: params.background,
        upstreamUrl:
          effective.imageMode === "platform"
            ? undefined
            : effective.imageBaseUrl || imgMeta.defaultBaseUrl,
        upstreamKey:
          effective.imageMode === "platform" ? undefined : effective.imageApiKey,
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

  async function generate() {
    if (!user) return
    const p = prompt.trim()
    if (!p) {
      setError("请填写 prompt")
      return
    }
    let imageDataUrl: string | undefined
    if (attached) {
      try {
        imageDataUrl = await fileToDataUrl(attached)
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e))
        return
      }
    }
    const parsedSeed = seed.trim() ? Number(seed.trim()) : NaN
    await runGeneration({
      prompt: p,
      model,
      size,
      quality,
      style,
      imageDataUrl,
      n,
      negativePrompt: negativePrompt.trim() || undefined,
      seed: Number.isFinite(parsedSeed) ? parsedSeed : undefined,
      background: background || undefined,
    })
  }

  // Load a past generation's params into the left-side form. Used when a
  // failed tile is clicked: the user almost always wants to tweak the prompt
  // or swap the model, and retyping everything is tedious.
  async function pickParams(gen: StudioGeneration) {
    setPrompt(gen.prompt)
    if (gen.model) setModel(gen.model)
    setSize(gen.size || "auto")
    setQuality(gen.quality || "auto")
    setStyle(gen.style || "")
    setN(gen.n || 1)
    setNegativePrompt(gen.negative_prompt || "")
    setSeed(gen.seed != null ? String(gen.seed) : "")
    setBackground(gen.background || "")
    if (gen.source_path) {
      try {
        const f = await urlToImageFile(gen.source_path, "source")
        setAttached(f)
      } catch {
        // Non-fatal: user can re-pick the base image manually.
      }
    } else {
      setAttached(null)
    }
  }

  // Re-run a failed generation with the same params. If the original request
  // used a base image (source_path), fetch it back and re-send as a data URL
  // so the retry is a true re-run, not a fresh text-to-image.
  async function retryGeneration(gen: StudioGeneration) {
    if (submitting) return
    if (!user) return
    let imageDataUrl: string | undefined
    if (gen.source_path) {
      try {
        const f = await urlToImageFile(gen.source_path, "source")
        imageDataUrl = await fileToDataUrl(f)
      } catch (e) {
        setError(
          `读取原底图失败：${e instanceof Error ? e.message : String(e)}`
        )
        return
      }
    }
    await runGeneration({
      prompt: gen.prompt,
      model: gen.model || model,
      size: gen.size || undefined,
      quality: gen.quality || undefined,
      style: gen.style || undefined,
      imageDataUrl,
      n: gen.n || undefined,
      negativePrompt: gen.negative_prompt || undefined,
      seed: gen.seed ?? undefined,
      background: gen.background || undefined,
    })
    // Drop the old failed record once the retry has finished — leaving it
    // around just clutters the history with stale "失败" tiles. Best-effort;
    // we don't block or surface errors if the delete fails.
    try {
      await studioApi.remove(gen.id)
      setHistory((s) => s.filter((x) => x.id !== gen.id))
      if (current?.id === gen.id) setCurrent(null)
    } catch {
      /* ignore */
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
      {mobileNavOpen && (
        <button
          type="button"
          aria-label="关闭参数面板"
          onClick={() => setMobileNavOpen(false)}
          className="fixed inset-0 z-30 bg-black/50 md:hidden"
        />
      )}
      {/* Left: parameter panel — drawer on mobile, static aside on md+. */}
      <aside
        className={cn(
          "fixed inset-y-0 left-0 z-40 flex h-full w-80 max-w-[85vw] flex-col border-r border-sidebar-border bg-sidebar text-sidebar-foreground transition-transform",
          mobileNavOpen ? "translate-x-0 shadow-2xl" : "-translate-x-full",
          "md:static md:w-80 md:max-w-none md:shrink-0 md:translate-x-0 md:shadow-none"
        )}
      >
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
            <Label className="text-xs">张数 (n)</Label>
            <Input
              type="number"
              min={1}
              max={10}
              value={n}
              onChange={(e) =>
                setN(Math.max(1, Math.min(10, parseInt(e.target.value, 10) || 1)))
              }
            />
            <p className="text-[11px] text-muted-foreground">
              1-10。当前仅保存首张，多图存储待后续。
            </p>
          </div>

          <div className="mb-3 flex flex-col gap-1.5">
            <Label className="text-xs">
              反向提示词 <span className="text-muted-foreground">(Gemini / SD 等)</span>
            </Label>
            <Textarea
              value={negativePrompt}
              onChange={(e) => setNegativePrompt(e.target.value)}
              rows={2}
              placeholder="不想出现的元素…"
              className="text-sm"
            />
          </div>

          <div className="mb-3 flex flex-col gap-1.5">
            <Label className="text-xs">
              随机种子 <span className="text-muted-foreground">(留空 = 随机)</span>
            </Label>
            <Input
              type="number"
              value={seed}
              onChange={(e) => setSeed(e.target.value)}
              placeholder="例如 1234"
            />
          </div>

          <div className="mb-3 flex flex-col gap-1.5">
            <Label className="text-xs">
              背景 <span className="text-muted-foreground">(仅 gpt-image-1)</span>
            </Label>
            <select
              value={background}
              onChange={(e) => setBackground(e.target.value)}
              className="h-9 rounded-md border border-input bg-background px-3 text-sm"
            >
              <option value="">默认</option>
              <option value="auto">auto</option>
              <option value="opaque">不透明</option>
              <option value="transparent">透明（PNG/WebP）</option>
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
        <header className="flex items-center justify-between gap-2 border-b border-border bg-background/70 px-3 py-3 backdrop-blur md:px-6">
          <div className="flex min-w-0 items-center gap-2">
            <Button
              variant="ghost"
              size="icon"
              className="md:hidden"
              onClick={() => setMobileNavOpen(true)}
              aria-label="打开参数面板"
            >
              <Menu />
            </Button>
            <ImageIcon className="size-4 shrink-0 text-muted-foreground" />
            <h1 className="truncate text-base font-semibold">图像工作室</h1>
            <span className="hidden text-xs text-muted-foreground sm:inline">
              单图生成 · 可发布到广场
            </span>
          </div>
          <div className="flex shrink-0 items-center gap-1">
            <Button
              variant="ghost"
              size="sm"
              onClick={() => nav("/plaza")}
              title="图片广场"
            >
              <Images className="size-3.5" />
              <span className="hidden sm:inline">图片广场</span>
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => void loadHistory()}
              title="刷新历史"
            >
              <RefreshCw className="size-3.5" />
              <span className="hidden sm:inline">刷新历史</span>
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

          <div className="mx-auto flex w-full max-w-5xl flex-col gap-6 px-3 py-4 md:px-6 md:py-6">
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
                  onUseAsBase={async () => {
                    if (!effectivePreview.image_path) return
                    try {
                      const f = await urlToImageFile(effectivePreview.image_path)
                      setAttached(f)
                      setPastedFlash(true)
                      window.setTimeout(() => setPastedFlash(false), 1500)
                    } catch (e) {
                      setError(e instanceof Error ? e.message : String(e))
                    }
                  }}
                  onRetry={() => void retryGeneration(effectivePreview)}
                  onPickParams={() => void pickParams(effectivePreview)}
                  retrying={submitting}
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
                        onRetry={() => void retryGeneration(g)}
                        onPickParams={() => void pickParams(g)}
                        retrying={submitting}
                      />
                    )
                  })}
                </div>
              )}
            </div>
          </div>
        </main>
      </div>

    </div>
  )
}

function PreviewCard({
  gen,
  published,
  publishing,
  canPublish,
  onPublish,
  onUseAsBase,
  onRetry,
  onPickParams,
  retrying,
}: {
  gen: StudioGeneration
  published: boolean
  publishing: boolean
  canPublish: boolean
  onPublish: () => void
  onUseAsBase: () => void | Promise<void>
  onRetry?: () => void
  onPickParams?: () => void
  retrying?: boolean
}) {
  const fname = gen.image_path ? filenameFromPath(gen.image_path) : null
  const [copyState, setCopyState] = useState<"idle" | "copying" | "done" | "error">(
    "idle"
  )
  const [copyError, setCopyError] = useState<string | null>(null)
  const [baseState, setBaseState] = useState<"idle" | "loading" | "done" | "error">(
    "idle"
  )
  const [zoomOpen, setZoomOpen] = useState(false)

  async function handleUseAsBase() {
    setBaseState("loading")
    try {
      await onUseAsBase()
      setBaseState("done")
      window.setTimeout(() => setBaseState("idle"), 1500)
    } catch {
      setBaseState("error")
      window.setTimeout(() => setBaseState("idle"), 2500)
    }
  }

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
    const hint = failureHint(gen.error)
    return (
      <div className="flex flex-col items-center gap-3 py-8">
        <div className="grid size-10 place-items-center rounded-full bg-destructive/10 text-destructive">
          <X className="size-6" />
        </div>
        <p className="text-base font-semibold text-destructive">生成失败</p>
        <div className="w-full max-w-xl rounded-md border border-destructive/30 bg-destructive/5 p-3 text-xs">
          <p className="mb-1 text-[11px] uppercase tracking-wide text-destructive/80">
            上游返回
          </p>
          <p className="whitespace-pre-wrap break-words font-mono text-[11px] leading-relaxed text-foreground/80">
            {gen.error || "未知错误"}
          </p>
          {hint && (
            <p className="mt-2 border-t border-destructive/20 pt-2 text-[12px] text-foreground/90">
              <b>建议：</b>
              {hint}
            </p>
          )}
        </div>
        <div className="flex flex-wrap justify-center gap-2">
          {onPickParams && (
            <Button variant="outline" size="sm" onClick={onPickParams}>
              载入到左侧参数
            </Button>
          )}
          {onRetry && (
            <Button
              variant="default"
              size="sm"
              onClick={onRetry}
              disabled={retrying}
            >
              <RefreshCw
                className={retrying ? "size-4 animate-spin" : "size-4"}
              />
              {retrying ? "重试中…" : "重试"}
            </Button>
          )}
        </div>
      </div>
    )
  }
  if (!gen.image_path) return null
  return (
    <div className="flex flex-col items-center gap-4">
      <img
        src={gen.image_path}
        alt={gen.prompt}
        onClick={() => setZoomOpen(true)}
        title="点击放大预览（滚轮缩放，支持拖动）"
        className="max-h-[70vh] max-w-full cursor-zoom-in rounded-lg border border-border shadow-sm"
      />
      {zoomOpen && (
        <ImagePreview
          src={gen.image_path}
          alt={gen.prompt}
          onClose={() => setZoomOpen(false)}
        />
      )}
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
      <div className="flex w-full flex-wrap justify-center gap-2">
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
          variant="outline"
          size="sm"
          onClick={() => void handleUseAsBase()}
          disabled={baseState === "loading"}
          title="把这张图当作底图继续编辑"
        >
          {baseState === "done" ? (
            <>
              <Check className="size-4 text-emerald-500" /> 已设为底图
            </>
          ) : baseState === "error" ? (
            <>
              <X className="size-4 text-destructive" /> 失败
            </>
          ) : (
            <>
              <ArrowLeftToLine className="size-4" />{" "}
              {baseState === "loading" ? "导入中…" : "用作底图"}
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
  onRetry,
  onPickParams,
  retrying,
}: {
  gen: StudioGeneration
  published: boolean
  publishing: boolean
  onSelect: () => void
  onPublish: () => void
  onRemove: () => void
  onRetry?: () => void
  /** Called when the user clicks a failed tile: populates the left-side form
   *  with this generation's params so they can tweak prompt/size/etc. and
   *  re-submit without re-typing. */
  onPickParams?: () => void
  retrying?: boolean
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
      ) : gen.status === "failed" ? (
        <button
          type="button"
          onClick={() => {
            onSelect()
            onPickParams?.()
          }}
          title={gen.error || "点击载入这次的参数，改后重发"}
          className="flex aspect-square w-full flex-col items-center justify-center gap-1.5 bg-muted p-2 text-xs text-muted-foreground transition-colors hover:bg-muted/70"
        >
          <X className="size-5 text-destructive" />
          <span className="font-medium text-destructive">失败</span>
          {gen.error && (
            <span className="line-clamp-3 max-w-full break-words text-center text-[10px] leading-tight text-muted-foreground">
              {gen.error}
            </span>
          )}
          {onRetry && (
            <span
              role="button"
              tabIndex={0}
              onClick={(e) => {
                e.stopPropagation()
                if (!retrying) onRetry()
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault()
                  e.stopPropagation()
                  if (!retrying) onRetry()
                }
              }}
              aria-disabled={retrying}
              className="mt-0.5 inline-flex items-center gap-1 rounded border border-border bg-background px-1.5 py-0.5 text-[11px] text-foreground hover:bg-accent aria-disabled:cursor-default aria-disabled:opacity-60"
            >
              <RefreshCw
                className={retrying ? "size-3 animate-spin" : "size-3"}
              />
              {retrying ? "重试中…" : "重试"}
            </span>
          )}
        </button>
      ) : (
        <div className="grid aspect-square w-full place-items-center bg-muted text-xs text-muted-foreground">
          <PendingIndicator createdAt={gen.created_at} />
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
