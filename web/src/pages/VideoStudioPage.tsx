import { useEffect, useRef, useState } from "react"
import { Link } from "react-router-dom"
import {
  ArrowLeft,
  Clapperboard,
  Download,
  ImagePlus,
  Loader2,
  Menu,
  RefreshCw,
  Trash2,
  X,
} from "lucide-react"
import { cn } from "@/lib/utils"
import { Button } from "@/components/ui/button"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { useConfirm } from "@/lib/confirm-context"
import {
  computeVideoCost,
  createVideoJob,
  deleteVideoJob,
  getVideoJob,
  listVideoJobs,
  listVideoModels,
  type VideoJob,
  type VideoModel,
} from "@/lib/video-gen"

const POLL_MS = 5000

function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader()
    r.onload = () => {
      const result = r.result as string
      // data:<mime>;base64,<payload> — /api/images/save 只要 payload。
      const idx = result.indexOf(",")
      resolve(idx >= 0 ? result.slice(idx + 1) : result)
    }
    r.onerror = () => reject(r.error ?? new Error("读取失败"))
    r.readAsDataURL(file)
  })
}

async function uploadRefImage(file: File): Promise<string> {
  const b64 = await fileToBase64(file)
  const res = await fetch("/api/images/save", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ b64, mime: file.type || "image/png" }),
    credentials: "same-origin",
  })
  if (!res.ok) {
    const text = await res.text().catch(() => res.statusText)
    throw new Error(text || `HTTP ${res.status}`)
  }
  const j = (await res.json()) as { path: string }
  return j.path
}

function firstSecondsAndSize(m: VideoModel): { seconds: number | null; size: string | null } {
  return {
    seconds: m.allowed_seconds[0] ?? null,
    size: m.size_rules[0]?.size ?? null,
  }
}

function statusLabel(job: VideoJob): string {
  switch (job.status) {
    case "pending":
      return "排队中"
    case "running":
      return "生成中"
    case "completed":
      return "已完成"
    case "failed":
      return "失败"
    default:
      return job.status
  }
}

export default function VideoStudioPage() {
  const { confirm } = useConfirm()

  const [models, setModels] = useState<VideoModel[]>([])
  const [modelsLoading, setModelsLoading] = useState(false)
  const [model, setModel] = useState<string>("")
  const [seconds, setSeconds] = useState<number | null>(null)
  const [size, setSize] = useState<string | null>(null)
  const [prompt, setPrompt] = useState("")
  const [refImage, setRefImage] = useState<string | null>(null)
  const [refImageUploading, setRefImageUploading] = useState(false)
  const fileRef = useRef<HTMLInputElement>(null)

  const [jobs, setJobs] = useState<VideoJob[]>([])
  const [hasMore, setHasMore] = useState(false)
  const [page, setPage] = useState(0)
  const [loadingMore, setLoadingMore] = useState(false)

  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [mobileNavOpen, setMobileNavOpen] = useState(false)

  const [deletingToken, setDeletingToken] = useState<string | null>(null)

  async function reloadModels() {
    setModelsLoading(true)
    try {
      const list = await listVideoModels()
      setModels(list)
      if (list.length > 0) {
        const m = list[0]!
        setModel((prev) => (list.some((x) => x.model === prev) ? prev : m.model))
        if (!list.some((x) => x.model === model)) {
          const { seconds: s, size: sz } = firstSecondsAndSize(m)
          setSeconds(s)
          setSize(sz)
        }
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setModelsLoading(false)
    }
  }

  async function loadJobs(p: number, append: boolean) {
    try {
      const { jobs: rows, has_more } = await listVideoJobs(p)
      setJobs((prev) => (append ? [...prev, ...rows] : rows))
      setHasMore(has_more)
      setPage(p)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  useEffect(() => {
    void reloadModels()
    void loadJobs(0, false)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // 切换模型时把时长/分辨率重置为该模型规则里的第一项。
  function handleModelChange(next: string) {
    setModel(next)
    const m = models.find((x) => x.model === next)
    if (m) {
      const { seconds: s, size: sz } = firstSecondsAndSize(m)
      setSeconds(s)
      setSize(sz)
    }
  }

  async function handlePickFile(e: React.ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0]
    e.target.value = ""
    if (!f) return
    setRefImageUploading(true)
    setError(null)
    try {
      const path = await uploadRefImage(f)
      setRefImage(path)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setRefImageUploading(false)
    }
  }

  const activeModel = models.find((m) => m.model === model)
  const cost =
    activeModel && seconds != null && size != null
      ? computeVideoCost(activeModel, seconds, size)
      : null

  async function handleSubmit() {
    if (!activeModel || seconds == null || size == null) return
    const p = prompt.trim()
    if (!p) return
    setSubmitting(true)
    setError(null)
    try {
      const { token } = await createVideoJob({
        model: activeModel.model,
        prompt: p,
        seconds,
        size,
        input_image_path: refImage ?? undefined,
      })
      const job = await getVideoJob(token)
      setJobs((prev) => [job, ...prev])
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setSubmitting(false)
    }
  }

  // 轮询：只要 jobs 里还有 pending/running 就每 5s 拉一次状态，合并回列表；
  // 没有 in-flight 任务或组件卸载即清 interval。
  useEffect(() => {
    const inFlight = jobs.filter((j) => j.status === "pending" || j.status === "running")
    if (inFlight.length === 0) return
    const id = window.setInterval(() => {
      void (async () => {
        for (const j of inFlight) {
          try {
            const updated = await getVideoJob(j.token)
            setJobs((prev) => prev.map((x) => (x.token === updated.token ? updated : x)))
          } catch {
            /* non-fatal: keep polling other jobs, retry this one next tick */
          }
        }
      })()
    }, POLL_MS)
    return () => window.clearInterval(id)
  }, [jobs])

  function regenerate(job: VideoJob) {
    setModel(job.model)
    const m = models.find((x) => x.model === job.model)
    setSeconds(job.seconds)
    setSize(job.size)
    setPrompt(job.prompt)
    if (!m) void reloadModels()
  }

  async function removeJob(job: VideoJob) {
    const ok = await confirm({
      title: "删除这条视频记录？",
      description: "此操作不可撤销。",
      confirmText: "删除",
      destructive: true,
    })
    if (!ok) return
    setDeletingToken(job.token)
    try {
      await deleteVideoJob(job.token)
      setJobs((prev) => prev.filter((x) => x.token !== job.token))
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setDeletingToken(null)
    }
  }

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
      <aside
        className={cn(
          "fixed inset-y-0 left-0 z-40 flex h-full w-80 max-w-[85vw] flex-col border-r border-sidebar-border bg-sidebar text-sidebar-foreground transition-transform",
          mobileNavOpen ? "translate-x-0 shadow-2xl" : "-translate-x-full",
          "md:static md:w-80 md:max-w-none md:shrink-0 md:translate-x-0 md:shadow-none"
        )}
      >
        <div className="flex flex-col gap-1 px-3 pb-2 pt-4">
          <Link
            to="/"
            className="flex items-center gap-2 rounded-md px-2 py-1.5 text-xs text-muted-foreground transition-colors hover:bg-sidebar-accent/60 hover:text-sidebar-accent-foreground"
          >
            <ArrowLeft className="size-3.5" /> 返回对话
          </Link>
        </div>

        <div className="nc-scroll flex-1 overflow-y-auto px-4 pb-4">
          <h2 className="mb-2 flex items-center gap-2 text-sm font-semibold">
            <Clapperboard className="size-4 text-primary" /> 生成参数
          </h2>

          {models.length === 0 && !modelsLoading && (
            <p className="mb-3 rounded-md border border-dashed border-border bg-muted/30 px-3 py-4 text-center text-xs text-muted-foreground">
              管理员尚未配置视频模型
            </p>
          )}

          <div className="mb-3 flex flex-col gap-1.5">
            <div className="flex items-center justify-between">
              <Label className="text-xs">模型</Label>
              <button
                type="button"
                onClick={() => void reloadModels()}
                disabled={modelsLoading}
                className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] text-muted-foreground hover:bg-accent hover:text-foreground"
              >
                <RefreshCw className={cn("size-3", modelsLoading && "animate-spin")} />
                {modelsLoading ? "加载中…" : "刷新"}
              </button>
            </div>
            <Select value={model} onValueChange={handleModelChange} disabled={models.length === 0}>
              <SelectTrigger className="w-full">
                <SelectValue placeholder="选择模型" />
              </SelectTrigger>
              <SelectContent>
                {models.map((m) => (
                  <SelectItem key={m.model} value={m.model}>
                    {m.display_name ?? m.model}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {activeModel && (
            <>
              <div className="mb-3 flex flex-col gap-1.5">
                <Label className="text-xs">时长</Label>
                <div className="flex flex-wrap gap-1.5">
                  {activeModel.allowed_seconds.map((s) => (
                    <Button
                      key={s}
                      type="button"
                      size="sm"
                      variant={seconds === s ? "default" : "outline"}
                      onClick={() => setSeconds(s)}
                    >
                      {s} 秒
                    </Button>
                  ))}
                </div>
              </div>

              <div className="mb-3 flex flex-col gap-1.5">
                <Label className="text-xs">分辨率</Label>
                <div className="flex flex-wrap gap-1.5">
                  {activeModel.size_rules.map((r) => (
                    <Button
                      key={r.size}
                      type="button"
                      size="sm"
                      variant={size === r.size ? "default" : "outline"}
                      onClick={() => setSize(r.size)}
                    >
                      {r.size}
                    </Button>
                  ))}
                </div>
              </div>
            </>
          )}

          <div className="mb-3 flex flex-col gap-1.5">
            <Label className="text-xs">
              参考图 <span className="text-muted-foreground">(可选，图生视频)</span>
            </Label>
            {refImage ? (
              <div className="group relative w-24">
                <img
                  src={refImage}
                  alt=""
                  className="aspect-square w-24 rounded-md border border-border object-cover"
                />
                <button
                  type="button"
                  onClick={() => setRefImage(null)}
                  aria-label="移除参考图"
                  className="absolute -right-1 -top-1 grid size-5 place-items-center rounded-full bg-background/90 text-foreground shadow ring-1 ring-border hover:bg-destructive hover:text-destructive-foreground"
                >
                  <X className="size-3" />
                </button>
              </div>
            ) : (
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => fileRef.current?.click()}
                disabled={refImageUploading}
                className="justify-start gap-2"
              >
                {refImageUploading ? (
                  <Loader2 className="size-4 animate-spin" />
                ) : (
                  <ImagePlus className="size-4" />
                )}
                {refImageUploading ? "上传中…" : "上传参考图"}
              </Button>
            )}
            <input
              ref={fileRef}
              type="file"
              accept="image/*"
              className="hidden"
              onChange={(e) => void handlePickFile(e)}
            />
          </div>

          <div className="mb-3 flex flex-col gap-1.5">
            <Label className="text-xs">Prompt</Label>
            <Textarea
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              rows={4}
              placeholder="描述想要的视频画面、镜头运动、氛围…"
              className="text-sm"
            />
          </div>
        </div>

        <div className="shrink-0 border-t border-sidebar-border px-4 py-3">
          <Button
            onClick={() => void handleSubmit()}
            disabled={submitting || !prompt.trim() || cost == null}
            className="w-full"
          >
            {submitting ? (
              <>
                <Loader2 className="size-4 animate-spin" /> 提交中…
              </>
            ) : (
              <>
                <Clapperboard className="size-4" />
                {cost != null ? `生成视频（消耗 ${cost} 积分）` : "生成视频"}
              </>
            )}
          </Button>
        </div>
      </aside>

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
            <Clapperboard className="size-4 shrink-0 text-muted-foreground" />
            <h1 className="truncate text-base font-semibold">视频工作室</h1>
            <span className="hidden text-xs text-muted-foreground sm:inline">
              文生视频 · 图生视频
            </span>
          </div>
          <div className="flex shrink-0 items-center gap-1">
            <Button
              variant="ghost"
              size="sm"
              onClick={() => void loadJobs(0, false)}
              title="刷新列表"
            >
              <RefreshCw className="size-3.5" />
              <span className="hidden sm:inline">刷新</span>
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

          <div className="mx-auto flex w-full max-w-5xl flex-col gap-4 px-3 py-4 md:px-6 md:py-6">
            {jobs.length === 0 ? (
              <div className="flex h-80 flex-col items-center justify-center gap-2 text-muted-foreground">
                <Clapperboard className="size-8" />
                <p className="text-sm">在左侧填写参数后点「生成视频」</p>
              </div>
            ) : (
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                {jobs.map((job) => (
                  <VideoJobCard
                    key={job.token}
                    job={job}
                    deleting={deletingToken === job.token}
                    onRegenerate={() => regenerate(job)}
                    onRemove={() => void removeJob(job)}
                  />
                ))}
              </div>
            )}

            {hasMore && (
              <div className="flex justify-center py-2">
                <Button
                  variant="outline"
                  size="sm"
                  disabled={loadingMore}
                  onClick={() => {
                    setLoadingMore(true)
                    void loadJobs(page + 1, true).finally(() => setLoadingMore(false))
                  }}
                >
                  {loadingMore ? (
                    <>
                      <Loader2 className="size-3.5 animate-spin" /> 加载中…
                    </>
                  ) : (
                    "加载更多"
                  )}
                </Button>
              </div>
            )}
          </div>
        </main>
      </div>
    </div>
  )
}

function VideoJobCard({
  job,
  deleting,
  onRegenerate,
  onRemove,
}: {
  job: VideoJob
  deleting: boolean
  onRegenerate: () => void
  onRemove: () => void
}) {
  const inFlight = job.status === "pending" || job.status === "running"

  if (job.status === "failed") {
    return (
      <div className="flex flex-col gap-2 rounded-lg border border-destructive/40 bg-destructive/5 p-3">
        <div className="flex items-center gap-2 text-sm font-medium text-destructive">
          <X className="size-4" /> 生成失败
        </div>
        <p className="line-clamp-3 whitespace-pre-wrap break-words text-xs text-foreground/80">
          {job.error || "未知错误"}
        </p>
        {job.refunded && (
          <p className="text-[11px] text-muted-foreground">
            已退还 {job.cost_credits} 积分
          </p>
        )}
        <div className="mt-1 flex flex-wrap gap-2">
          <Button variant="outline" size="sm" onClick={onRegenerate}>
            <RefreshCw className="size-3.5" /> 重新生成
          </Button>
          <Button variant="ghost" size="sm" onClick={onRemove} disabled={deleting}>
            <Trash2 className="size-3.5" /> 删除
          </Button>
        </div>
      </div>
    )
  }

  if (inFlight) {
    return (
      <div className="flex flex-col items-center justify-center gap-2 rounded-lg border border-border bg-card p-6 text-center">
        <Loader2 className="size-6 animate-spin text-primary" />
        <p className="text-sm font-medium">
          {statusLabel(job)} · 进度 {job.progress}%
        </p>
        <p className="line-clamp-2 text-xs text-muted-foreground">{job.prompt}</p>
        <p className="text-[11px] text-muted-foreground">
          可离开页面，任务将在后台继续，稍后回来查看
        </p>
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-2 rounded-lg border border-border bg-card p-3">
      {job.video_path && (
        <video
          controls
          preload="metadata"
          src={job.video_path}
          className="w-full rounded-lg"
        />
      )}
      <p className="line-clamp-2 text-xs text-foreground/90">{job.prompt}</p>
      <div className="flex flex-wrap gap-1.5 text-[11px] text-muted-foreground">
        <span className="rounded bg-muted px-1.5 py-0.5">{job.model}</span>
        <span className="rounded bg-muted px-1.5 py-0.5">{job.seconds} 秒</span>
        <span className="rounded bg-muted px-1.5 py-0.5">{job.size}</span>
        <span className="rounded bg-muted px-1.5 py-0.5">
          消耗 {job.cost_credits} 积分
        </span>
      </div>
      <div className="mt-1 flex flex-wrap gap-2">
        {job.video_path && (
          <Button asChild variant="outline" size="sm">
            <a href={job.video_path} download>
              <Download className="size-3.5" /> 下载
            </a>
          </Button>
        )}
        <Button variant="outline" size="sm" onClick={onRegenerate}>
          <RefreshCw className="size-3.5" /> 重新生成
        </Button>
        <Button variant="ghost" size="sm" onClick={onRemove} disabled={deleting}>
          <Trash2 className="size-3.5" /> 删除
        </Button>
      </div>
    </div>
  )
}
