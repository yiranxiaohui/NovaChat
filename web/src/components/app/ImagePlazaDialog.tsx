import { useEffect, useState } from "react"
import {
  Copy,
  Flame,
  ImageOff,
  Search,
  Sparkles,
  Trash2,
  Upload,
  Wand2,
} from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import {
  plazaApi,
  type MyPlazaImage,
  type PlazaImage,
  type PlazaSort,
} from "@/lib/image-plaza"

type Props = {
  open: boolean
  onClose: () => void
  onUsePrompt: (prompt: string) => void
  onUseAsEditBase: (filename: string, prompt: string) => void
}

type Tab = "discover" | "mine"

export function ImagePlazaDialog({
  open,
  onClose,
  onUsePrompt,
  onUseAsEditBase,
}: Props) {
  const [tab, setTab] = useState<Tab>("discover")
  const [items, setItems] = useState<PlazaImage[]>([])
  const [mineItems, setMineItems] = useState<MyPlazaImage[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [search, setSearch] = useState("")
  const [page, setPage] = useState(1)
  const [sort, setSort] = useState<PlazaSort>("hot")
  const [busyId, setBusyId] = useState<number | null>(null)
  const [copiedId, setCopiedId] = useState<number | null>(null)

  useEffect(() => {
    if (!open || tab !== "discover") return
    let cancelled = false
    setLoading(true)
    setError(null)
    plazaApi
      .listPublic({ search: search.trim() || undefined, page, sort })
      .then((r) => {
        if (!cancelled) setItems(r)
      })
      .catch((e) => {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e))
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [open, tab, search, page, sort])

  useEffect(() => {
    if (!open || tab !== "mine") return
    let cancelled = false
    setLoading(true)
    setError(null)
    plazaApi
      .listMine()
      .then((r) => {
        if (!cancelled) setMineItems(r)
      })
      .catch((e) => {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e))
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [open, tab])

  useEffect(() => {
    if (open) {
      setPage(1)
      setCopiedId(null)
    }
  }, [open])

  async function copyPrompt(p: PlazaImage | MyPlazaImage) {
    try {
      await navigator.clipboard.writeText(p.prompt)
      setCopiedId(p.id)
      setTimeout(() => {
        setCopiedId((x) => (x === p.id ? null : x))
      }, 1200)
    } catch {
      onUsePrompt(p.prompt)
    }
  }

  async function handleUsePrompt(p: PlazaImage) {
    setBusyId(p.id)
    try {
      await plazaApi.bumpClone(p.id)
      setItems((list) =>
        list.map((it) =>
          it.id === p.id ? { ...it, clone_count: it.clone_count + 1 } : it
        )
      )
      onUsePrompt(p.prompt)
      onClose()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusyId(null)
    }
  }

  async function handleUseAsBase(p: PlazaImage) {
    setBusyId(p.id)
    try {
      await plazaApi.bumpClone(p.id)
      setItems((list) =>
        list.map((it) =>
          it.id === p.id ? { ...it, clone_count: it.clone_count + 1 } : it
        )
      )
      onUseAsEditBase(p.filename, p.prompt)
      onClose()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusyId(null)
    }
  }

  async function remove(p: MyPlazaImage) {
    if (!window.confirm("从广场撤回这张图片？磁盘文件不会被删除。")) return
    try {
      await plazaApi.remove(p.id)
      setMineItems((list) => list.filter((x) => x.id !== p.id))
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  if (!open) return null

  return (
    <div
      className="fixed inset-0 z-50 grid place-items-center bg-black/50 p-4"
      onClick={onClose}
    >
      <div
        className="flex w-full max-w-5xl flex-col gap-3 rounded-lg border border-border bg-background p-6 shadow-lg"
        onClick={(e) => e.stopPropagation()}
        style={{ maxHeight: "calc(100svh - 2rem)" }}
      >
        <div className="flex items-start justify-between gap-2">
          <div>
            <h2 className="text-lg font-semibold">图片广场</h2>
            <p className="text-sm text-muted-foreground">
              浏览大家公开分享的生成图。点「用此提示词」直接复用，或点「以此图生图」用作编辑底图。
            </p>
          </div>
          <div className="flex items-center rounded-md border border-border p-0.5">
            <Button
              size="sm"
              variant={tab === "discover" ? "secondary" : "ghost"}
              className="h-7 px-2"
              onClick={() => setTab("discover")}
            >
              发现
            </Button>
            <Button
              size="sm"
              variant={tab === "mine" ? "secondary" : "ghost"}
              className="h-7 px-2"
              onClick={() => setTab("mine")}
            >
              我的发布
            </Button>
          </div>
        </div>

        {tab === "discover" && (
          <div className="flex flex-wrap items-center gap-2">
            <div className="relative min-w-[12rem] flex-1">
              <Search className="pointer-events-none absolute left-2 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                className="pl-8"
                placeholder="按提示词搜索…"
                value={search}
                onChange={(e) => {
                  setSearch(e.target.value)
                  setPage(1)
                }}
              />
            </div>
            <div className="flex items-center rounded-md border border-border p-0.5">
              <Button
                size="sm"
                variant={sort === "hot" ? "secondary" : "ghost"}
                className="h-7 px-2"
                onClick={() => {
                  setSort("hot")
                  setPage(1)
                }}
              >
                <Flame className="size-3.5" /> 热门
              </Button>
              <Button
                size="sm"
                variant={sort === "new" ? "secondary" : "ghost"}
                className="h-7 px-2"
                onClick={() => {
                  setSort("new")
                  setPage(1)
                }}
              >
                <Sparkles className="size-3.5" /> 最新
              </Button>
            </div>
            <div className="flex items-center gap-1 text-xs text-muted-foreground">
              <Button
                size="sm"
                variant="outline"
                disabled={page <= 1 || loading}
                onClick={() => setPage((p) => Math.max(1, p - 1))}
              >
                上一页
              </Button>
              <span className="px-1">第 {page} 页</span>
              <Button
                size="sm"
                variant="outline"
                disabled={loading || items.length < 24}
                onClick={() => setPage((p) => p + 1)}
              >
                下一页
              </Button>
            </div>
          </div>
        )}

        {error && (
          <div className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
            {error}
          </div>
        )}

        <div className="flex-1 overflow-y-auto">
          {loading && <p className="text-sm text-muted-foreground">加载中…</p>}

          {tab === "discover" && !loading && items.length === 0 && (
            <div className="flex flex-col items-center gap-2 py-12 text-sm text-muted-foreground">
              <ImageOff className="size-6" />
              {search ? "没有匹配结果。" : "还没有人发布图片。"}
            </div>
          )}
          {tab === "mine" && !loading && mineItems.length === 0 && (
            <div className="flex flex-col items-center gap-2 py-12 text-sm text-muted-foreground">
              <Upload className="size-6" />
              还没发布过图片；在聊天里生成后点图片右下角的「发布」按钮即可。
            </div>
          )}

          {tab === "discover" && (
            <ul className="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4">
              {items.map((p) => (
                <li
                  key={p.id}
                  className="flex flex-col overflow-hidden rounded-md border border-border bg-background"
                >
                  <div className="relative aspect-square bg-muted">
                    <img
                      src={`/api/images/${p.filename}`}
                      alt={p.prompt}
                      loading="lazy"
                      className="absolute inset-0 size-full object-cover"
                    />
                    <span
                      className="absolute right-1.5 top-1.5 inline-flex items-center gap-0.5 rounded bg-black/60 px-1.5 py-0.5 text-[10px] text-white"
                      title={`已被复用 ${p.clone_count} 次`}
                    >
                      <Flame className="size-3" />
                      {p.clone_count}
                    </span>
                  </div>
                  <div className="flex flex-col gap-1.5 p-2">
                    <p
                      className="line-clamp-3 text-xs text-muted-foreground"
                      title={p.prompt}
                    >
                      {p.prompt}
                    </p>
                    <p className="text-[10px] text-muted-foreground/80">
                      by @{p.author_username}
                    </p>
                    <div className="mt-1 flex items-center gap-1">
                      <Button
                        size="xs"
                        variant="outline"
                        className="flex-1"
                        onClick={() => void handleUsePrompt(p)}
                        disabled={busyId === p.id}
                        title="用此提示词新生成一张"
                      >
                        <Wand2 /> 用此提示词
                      </Button>
                      <Button
                        size="xs"
                        variant="ghost"
                        onClick={() => void handleUseAsBase(p)}
                        disabled={busyId === p.id}
                        title="以此图为底图进行编辑"
                      >
                        <Upload className="-rotate-90" />
                      </Button>
                      <Button
                        size="xs"
                        variant="ghost"
                        onClick={() => void copyPrompt(p)}
                        title="复制提示词"
                      >
                        <Copy />
                      </Button>
                    </div>
                    {copiedId === p.id && (
                      <p className="text-[10px] text-emerald-600 dark:text-emerald-400">
                        已复制
                      </p>
                    )}
                  </div>
                </li>
              ))}
            </ul>
          )}

          {tab === "mine" && (
            <ul className="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4">
              {mineItems.map((p) => (
                <li
                  key={p.id}
                  className="flex flex-col overflow-hidden rounded-md border border-border bg-background"
                >
                  <div className="relative aspect-square bg-muted">
                    <img
                      src={`/api/images/${p.filename}`}
                      alt={p.prompt}
                      loading="lazy"
                      className="absolute inset-0 size-full object-cover"
                    />
                    <span
                      className="absolute right-1.5 top-1.5 inline-flex items-center gap-0.5 rounded bg-black/60 px-1.5 py-0.5 text-[10px] text-white"
                      title={`已被复用 ${p.clone_count} 次`}
                    >
                      <Flame className="size-3" />
                      {p.clone_count}
                    </span>
                  </div>
                  <div className="flex flex-col gap-1.5 p-2">
                    <p
                      className="line-clamp-3 text-xs text-muted-foreground"
                      title={p.prompt}
                    >
                      {p.prompt}
                    </p>
                    <div className="mt-1 flex items-center gap-1">
                      <Button
                        size="xs"
                        variant="ghost"
                        onClick={() => void copyPrompt(p)}
                        className="flex-1"
                        title="复制提示词"
                      >
                        <Copy /> 复制
                      </Button>
                      <Button
                        size="xs"
                        variant="ghost"
                        onClick={() => remove(p)}
                        title="从广场撤回"
                      >
                        <Trash2 />
                      </Button>
                    </div>
                    {copiedId === p.id && (
                      <p className="text-[10px] text-emerald-600 dark:text-emerald-400">
                        已复制
                      </p>
                    )}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>

        <div className="flex justify-end">
          <Button variant="outline" onClick={onClose}>
            关闭
          </Button>
        </div>
      </div>
    </div>
  )
}
