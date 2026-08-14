import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type DragEvent,
  type ReactNode,
} from "react"
import { Link } from "react-router-dom"
import {
  ArrowLeft,
  Download,
  Eye,
  EyeOff,
  Film,
  FolderOpen,
  ImageIcon,
  Library,
  Loader2,
  Music2,
  Plus,
  RefreshCw,
  Scissors,
  Search,
  Sparkles,
  Trash2,
  Upload,
  Users,
} from "lucide-react"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { useConfirm } from "@/lib/confirm-context"
import { cn } from "@/lib/utils"
import {
  inspectMediaFile,
  videoEditorApi,
  type EditorAsset,
} from "@/lib/video-editor"

type AssetScope = "mine" | "public"
type AssetKindFilter = "all" | EditorAsset["kind"]

function sourceLabel(source: EditorAsset["source"]): string {
  switch (source) {
    case "generated":
      return "AI 生成"
    case "workflow":
      return "流水线产物"
    case "imported":
      return "已收藏"
    case "public":
      return "公开分享"
    default:
      return "本地上传"
  }
}

function kindLabel(kind: EditorAsset["kind"]): string {
  if (kind === "video") return "视频"
  if (kind === "audio") return "音频"
  return "图片"
}

function formatDuration(seconds?: number): string | null {
  if (seconds == null || !Number.isFinite(seconds)) return null
  const minutes = Math.floor(seconds / 60)
  const rest = Math.floor(seconds % 60)
  return minutes > 0
    ? `${minutes}:${String(rest).padStart(2, "0")}`
    : `${seconds.toFixed(seconds < 10 ? 1 : 0)}s`
}

function formatDate(value: string): string {
  const normalized = value.includes("T") ? value : value.replace(" ", "T")
  const hasTimezone = /(?:Z|[+-]\d{2}:?\d{2})$/i.test(normalized)
  const date = new Date(hasTimezone ? normalized : `${normalized}Z`)
  if (Number.isNaN(date.getTime())) return value
  return date.toLocaleDateString("zh-CN", { month: "short", day: "numeric" })
}

function mediaFiles(files: FileList | File[]): File[] {
  return Array.from(files).filter(
    (file) =>
      file.type.startsWith("image/") ||
      file.type.startsWith("video/") ||
      file.type.startsWith("audio/")
  )
}

export default function MediaLibraryPage() {
  const { confirm } = useConfirm()
  const uploadRef = useRef<HTMLInputElement>(null)
  const [scope, setScope] = useState<AssetScope>("mine")
  const [kind, setKind] = useState<AssetKindFilter>("all")
  const [query, setQuery] = useState("")
  const [mine, setMine] = useState<EditorAsset[]>([])
  const [shared, setShared] = useState<EditorAsset[]>([])
  const [loading, setLoading] = useState(true)
  const [uploading, setUploading] = useState(false)
  const [uploadProgress, setUploadProgress] = useState("")
  const [shareUploads, setShareUploads] = useState(false)
  const [dragging, setDragging] = useState(false)
  const [busy, setBusy] = useState<Set<string>>(() => new Set())

  const reload = useCallback(async () => {
    setLoading(true)
    try {
      const [personal, publicAssets] = await Promise.all([
        videoEditorApi.assets("mine"),
        videoEditorApi.assets("public"),
      ])
      setMine(personal)
      setShared(publicAssets)
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    // Initial remote synchronization is intentionally kicked off after mount.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void reload()
  }, [reload])

  const assets = scope === "mine" ? mine : shared
  const filtered = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase()
    return assets.filter((asset) => {
      if (kind !== "all" && asset.kind !== kind) return false
      if (!needle) return true
      return `${asset.title} ${asset.author ?? ""} ${sourceLabel(asset.source)}`
        .toLocaleLowerCase()
        .includes(needle)
    })
  }, [assets, kind, query])

  const counts = useMemo(
    () => ({
      mine: mine.length,
      minePublic: mine.filter((asset) => asset.is_public).length,
      shared: shared.length,
    }),
    [mine, shared]
  )

  function markBusy(key: string, value: boolean) {
    setBusy((current) => {
      const next = new Set(current)
      if (value) next.add(key)
      else next.delete(key)
      return next
    })
  }

  async function uploadFiles(input: FileList | File[]) {
    const files = mediaFiles(input)
    if (files.length === 0) {
      toast.error("请选择图片、视频或音频文件")
      return
    }
    setUploading(true)
    try {
      for (const [index, file] of files.entries()) {
        setUploadProgress(`${index + 1}/${files.length} · ${file.name}`)
        const metadata = await inspectMediaFile(file)
        const uploaded = await videoEditorApi.uploadAsset(file, metadata)
        if (shareUploads) {
          await videoEditorApi.setVisibility(uploaded.id, true)
        }
      }
      await reload()
      setScope("mine")
      toast.success(
        shareUploads
          ? `${files.length} 个素材已上传并公开分享`
          : `${files.length} 个素材已加入个人素材库`
      )
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error))
    } finally {
      setUploading(false)
      setUploadProgress("")
      if (uploadRef.current) uploadRef.current.value = ""
    }
  }

  async function togglePublic(asset: EditorAsset) {
    const key = `visibility:${asset.id}`
    if (busy.has(key)) return
    markBusy(key, true)
    try {
      let libraryId = asset.library_id
      if (!libraryId) {
        libraryId = (await videoEditorApi.importAsset(asset)).id
      }
      await videoEditorApi.setVisibility(libraryId, !asset.is_public)
      await reload()
      toast.success(asset.is_public ? "素材已转为仅自己可见" : "素材已分享到公有素材库")
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error))
    } finally {
      markBusy(key, false)
    }
  }

  async function collect(asset: EditorAsset) {
    const key = `collect:${asset.id}`
    if (busy.has(key)) return
    markBusy(key, true)
    try {
      await videoEditorApi.importAsset(asset)
      await reload()
      toast.success("已收藏到个人素材库")
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error))
    } finally {
      markBusy(key, false)
    }
  }

  async function remove(asset: EditorAsset) {
    if (!asset.library_id) return
    const ok = await confirm({
      title: "从个人素材库移除？",
      description: asset.is_public
        ? "这个素材也会从公有素材库撤下。已用于剪辑项目的片段不会受影响。"
        : "已用于剪辑项目的片段不会受影响。",
      confirmText: "移除素材",
      destructive: true,
    })
    if (!ok) return
    const key = `remove:${asset.id}`
    markBusy(key, true)
    try {
      await videoEditorApi.removeAsset(asset.library_id)
      await reload()
      toast.success("素材已移除")
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error))
    } finally {
      markBusy(key, false)
    }
  }

  function handleDrop(event: DragEvent<HTMLDivElement>) {
    event.preventDefault()
    setDragging(false)
    if (!uploading && event.dataTransfer.files.length > 0) {
      void uploadFiles(event.dataTransfer.files)
    }
  }

  return (
    <div className="min-h-svh bg-background text-foreground">
      <header className="sticky top-0 z-30 border-b border-border/70 bg-background/85 backdrop-blur-xl">
        <div className="mx-auto flex h-14 max-w-[1600px] items-center justify-between gap-3 px-4 md:px-7">
          <div className="flex min-w-0 items-center gap-3">
            <Button asChild variant="ghost" size="icon-sm">
              <Link to="/" aria-label="返回对话">
                <ArrowLeft />
              </Link>
            </Button>
            <span className="grid size-8 shrink-0 place-items-center rounded-xl bg-primary/10 text-primary">
              <Library className="size-4" />
            </span>
            <div className="min-w-0">
              <h1 className="truncate text-sm font-semibold">素材库</h1>
              <p className="hidden text-[11px] text-muted-foreground sm:block">
                图片、视频、音频与 AI 产物统一管理
              </p>
            </div>
          </div>
          <div className="flex shrink-0 items-center gap-1.5">
            <Button
              variant="ghost"
              size="sm"
              disabled={loading}
              onClick={() => void reload()}
              title="刷新素材"
            >
              <RefreshCw className={cn(loading && "animate-spin")} />
              <span className="hidden sm:inline">刷新</span>
            </Button>
            <Button asChild size="sm">
              <Link to="/editor">
                <Scissors /> 在线剪辑
              </Link>
            </Button>
          </div>
        </div>
      </header>

      <main
        className="mx-auto max-w-[1600px] px-4 py-6 md:px-7 md:py-8"
        onDragEnter={(event) => {
          event.preventDefault()
          if (!uploading) setDragging(true)
        }}
        onDragOver={(event) => event.preventDefault()}
        onDragLeave={(event) => {
          if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
            setDragging(false)
          }
        }}
        onDrop={handleDrop}
      >
        <section className="relative overflow-hidden rounded-3xl border border-border bg-gradient-to-br from-primary/[0.09] via-card to-card p-5 shadow-sm md:p-7">
          <div className="pointer-events-none absolute -right-16 -top-20 size-64 rounded-full bg-primary/10 blur-3xl" />
          <div className="relative grid gap-6 xl:grid-cols-[minmax(0,1fr)_430px] xl:items-center">
            <div>
              <div className="mb-3 inline-flex items-center gap-1.5 rounded-full border border-primary/15 bg-primary/10 px-2.5 py-1 text-[11px] font-medium text-primary">
                <Sparkles className="size-3" /> 创作资产中心
              </div>
              <h2 className="max-w-2xl text-2xl font-semibold tracking-tight md:text-3xl">
                一个素材库，连接生成、分享与剪辑
              </h2>
              <p className="mt-3 max-w-2xl text-sm leading-6 text-muted-foreground">
                上传自己的图片、视频和音频，也可以直接管理 AI 生成与流水线产物。公开分享后，所有用户都能在公有素材中发现并收藏。
              </p>
              <div className="mt-5 grid max-w-2xl grid-cols-3 gap-2">
                <Summary label="我的素材" value={counts.mine} icon={<FolderOpen />} />
                <Summary label="我的分享" value={counts.minePublic} icon={<Eye />} />
                <Summary label="公有素材" value={counts.shared} icon={<Users />} />
              </div>
            </div>

            <div
              className={cn(
                "rounded-2xl border border-dashed p-4 transition-colors",
                dragging
                  ? "border-primary bg-primary/10"
                  : "border-border bg-background/60"
              )}
            >
              <input
                ref={uploadRef}
                type="file"
                accept="image/*,video/*,audio/*"
                multiple
                hidden
                onChange={(event) =>
                  event.target.files && void uploadFiles(event.target.files)
                }
              />
              <button
                type="button"
                disabled={uploading}
                onClick={() => uploadRef.current?.click()}
                className="flex w-full items-center gap-3 rounded-xl p-2 text-left transition-colors hover:bg-accent/60 disabled:cursor-wait"
              >
                <span className="grid size-11 shrink-0 place-items-center rounded-xl bg-primary text-primary-foreground shadow-sm">
                  {uploading ? (
                    <Loader2 className="size-5 animate-spin" />
                  ) : (
                    <Upload className="size-5" />
                  )}
                </span>
                <span className="min-w-0">
                  <span className="block text-sm font-medium">
                    {uploading ? "正在上传素材" : "点击选择或拖入素材"}
                  </span>
                  <span className="block truncate text-xs text-muted-foreground">
                    {uploadProgress || "支持图片、视频和音频，可多选"}
                  </span>
                </span>
              </button>
              <div className="mt-3 grid grid-cols-2 rounded-xl bg-muted/60 p-1 text-xs">
                <button
                  type="button"
                  disabled={uploading}
                  onClick={() => setShareUploads(false)}
                  className={cn(
                    "rounded-lg px-3 py-2 transition-colors",
                    !shareUploads
                      ? "bg-background font-medium shadow-sm"
                      : "text-muted-foreground hover:text-foreground"
                  )}
                >
                  仅自己可见
                </button>
                <button
                  type="button"
                  disabled={uploading}
                  onClick={() => setShareUploads(true)}
                  className={cn(
                    "rounded-lg px-3 py-2 transition-colors",
                    shareUploads
                      ? "bg-background font-medium shadow-sm"
                      : "text-muted-foreground hover:text-foreground"
                  )}
                >
                  上传后公开
                </button>
              </div>
            </div>
          </div>
        </section>

        <section className="mt-6">
          <div className="flex flex-col gap-3 border-b border-border pb-4 lg:flex-row lg:items-center lg:justify-between">
            <div className="grid grid-cols-2 rounded-xl bg-muted/60 p-1 text-sm lg:w-72">
              {(["mine", "public"] as const).map((value) => (
                <button
                  key={value}
                  type="button"
                  onClick={() => setScope(value)}
                  className={cn(
                    "rounded-lg px-3 py-2 transition-colors",
                    scope === value
                      ? "bg-background font-medium shadow-sm"
                      : "text-muted-foreground hover:text-foreground"
                  )}
                >
                  {value === "mine" ? "我的素材" : "公有素材"}
                </button>
              ))}
            </div>
            <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
              <div className="flex items-center gap-1 overflow-x-auto rounded-xl bg-muted/50 p-1">
                {(["all", "image", "video", "audio"] as const).map((value) => (
                  <button
                    key={value}
                    type="button"
                    onClick={() => setKind(value)}
                    className={cn(
                      "shrink-0 rounded-lg px-3 py-1.5 text-xs transition-colors",
                      kind === value
                        ? "bg-background font-medium shadow-sm"
                        : "text-muted-foreground hover:text-foreground"
                    )}
                  >
                    {value === "all" ? "全部" : kindLabel(value)}
                  </button>
                ))}
              </div>
              <div className="relative sm:w-64">
                <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
                <Input
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                  placeholder="搜索名称或作者…"
                  className="h-9 rounded-xl pl-9"
                />
              </div>
            </div>
          </div>

          {loading ? (
            <div className="grid min-h-72 place-items-center text-muted-foreground">
              <span className="flex items-center gap-2 text-sm">
                <Loader2 className="size-4 animate-spin" /> 正在载入素材
              </span>
            </div>
          ) : filtered.length === 0 ? (
            <div className="flex min-h-72 flex-col items-center justify-center rounded-2xl border border-dashed border-border text-center text-muted-foreground">
              <Library className="mb-3 size-9 opacity-50" />
              <p className="text-sm font-medium text-foreground">没有匹配的素材</p>
              <p className="mt-1 max-w-sm text-xs leading-5">
                {scope === "mine"
                  ? "上传文件，或先在图像、视频和流水线工作室生成内容。"
                  : "还没有用户公开分享此类素材。"}
              </p>
              {scope === "mine" && (
                <Button
                  size="sm"
                  className="mt-4"
                  onClick={() => uploadRef.current?.click()}
                >
                  <Plus /> 上传第一个素材
                </Button>
              )}
            </div>
          ) : (
            <div className="mt-5 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3 2xl:grid-cols-4">
              {filtered.map((asset) => (
                <AssetCard
                  key={asset.id}
                  asset={asset}
                  scope={scope}
                  busy={busy}
                  onTogglePublic={() => void togglePublic(asset)}
                  onCollect={() => void collect(asset)}
                  onRemove={() => void remove(asset)}
                />
              ))}
            </div>
          )}
        </section>
      </main>
    </div>
  )
}

function Summary({
  label,
  value,
  icon,
}: {
  label: string
  value: number
  icon: ReactNode
}) {
  return (
    <div className="rounded-xl border border-border/70 bg-background/55 p-3 backdrop-blur-sm">
      <div className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
        <span className="[&>svg]:size-3">{icon}</span>
        {label}
      </div>
      <div className="mt-1 text-xl font-semibold tabular-nums">{value}</div>
    </div>
  )
}

function AssetCard({
  asset,
  scope,
  busy,
  onTogglePublic,
  onCollect,
  onRemove,
}: {
  asset: EditorAsset
  scope: AssetScope
  busy: Set<string>
  onTogglePublic: () => void
  onCollect: () => void
  onRemove: () => void
}) {
  const visibilityBusy = busy.has(`visibility:${asset.id}`)
  const collectBusy = busy.has(`collect:${asset.id}`)
  const removeBusy = busy.has(`remove:${asset.id}`)
  const duration = formatDuration(asset.duration)

  return (
    <article className="group overflow-hidden rounded-2xl border border-border bg-card shadow-sm transition-all hover:-translate-y-0.5 hover:border-primary/25 hover:shadow-md">
      <div className="relative aspect-video overflow-hidden bg-muted">
        {asset.kind === "image" ? (
          <img
            src={asset.thumbnail_path ?? asset.path}
            alt={asset.title}
            loading="lazy"
            className="size-full object-cover transition-transform duration-300 group-hover:scale-[1.025]"
          />
        ) : asset.kind === "video" ? (
          asset.thumbnail_path ? (
            <img
              src={asset.thumbnail_path}
              alt={asset.title}
              loading="lazy"
              className="size-full object-cover"
            />
          ) : (
            <video
              src={asset.path}
              preload="metadata"
              muted
              controls
              className="size-full object-cover"
            />
          )
        ) : (
          <div className="grid size-full place-items-center bg-gradient-to-br from-violet-500/15 via-background to-sky-500/10">
            <Music2 className="size-10 text-violet-500/70" />
            <audio
              src={asset.path}
              controls
              preload="metadata"
              className="absolute inset-x-3 bottom-3 h-8 max-w-[calc(100%-1.5rem)]"
            />
          </div>
        )}
        <span className="absolute left-2 top-2 inline-flex items-center gap-1 rounded-md bg-black/65 px-1.5 py-1 text-[10px] font-medium text-white backdrop-blur">
          {asset.kind === "image" ? (
            <ImageIcon className="size-3" />
          ) : asset.kind === "video" ? (
            <Film className="size-3" />
          ) : (
            <Music2 className="size-3" />
          )}
          {kindLabel(asset.kind)}
        </span>
        {duration && (
          <span className="absolute right-2 top-2 rounded-md bg-black/65 px-1.5 py-1 font-mono text-[10px] text-white backdrop-blur">
            {duration}
          </span>
        )}
        {scope === "mine" && asset.is_public && (
          <span className="absolute bottom-2 left-2 inline-flex items-center gap-1 rounded-md bg-emerald-500/90 px-1.5 py-1 text-[10px] font-medium text-white">
            <Eye className="size-3" /> 已公开
          </span>
        )}
      </div>

      <div className="p-3.5">
        <h3 className="truncate text-sm font-medium" title={asset.title}>
          {asset.title}
        </h3>
        <div className="mt-1.5 flex items-center justify-between gap-2 text-[11px] text-muted-foreground">
          <span className="truncate">
            {scope === "public" && asset.author
              ? `@${asset.author}`
              : sourceLabel(asset.source)}
          </span>
          <span className="shrink-0">{formatDate(asset.created_at)}</span>
        </div>
        {(asset.width || asset.height) && (
          <p className="mt-1 text-[10px] text-muted-foreground/75">
            {asset.width ?? "?"} × {asset.height ?? "?"}
          </p>
        )}

        <div className="mt-3 flex items-center gap-1.5 border-t border-border/70 pt-3">
          {scope === "mine" ? (
            <Button
              size="xs"
              variant={asset.is_public ? "outline" : "default"}
              disabled={visibilityBusy}
              onClick={onTogglePublic}
              className="flex-1"
            >
              {visibilityBusy ? (
                <Loader2 className="animate-spin" />
              ) : asset.is_public ? (
                <EyeOff />
              ) : (
                <Users />
              )}
              {asset.is_public ? "转为私有" : "公开分享"}
            </Button>
          ) : (
            <Button
              size="xs"
              disabled={collectBusy}
              onClick={onCollect}
              className="flex-1"
            >
              {collectBusy ? <Loader2 className="animate-spin" /> : <Plus />}
              收藏到我的素材
            </Button>
          )}
          <Button asChild size="icon-xs" variant="outline" title="下载素材">
            <a href={asset.path} download>
              <Download />
            </a>
          </Button>
          {scope === "mine" && asset.library_id && (
            <Button
              size="icon-xs"
              variant="outline"
              disabled={removeBusy}
              onClick={onRemove}
              className="text-muted-foreground hover:border-destructive/30 hover:bg-destructive/10 hover:text-destructive"
              title="移除素材"
            >
              {removeBusy ? <Loader2 className="animate-spin" /> : <Trash2 />}
            </Button>
          )}
        </div>
      </div>
    </article>
  )
}
