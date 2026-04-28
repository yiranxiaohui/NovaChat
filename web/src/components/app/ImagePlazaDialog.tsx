import { useEffect, useRef, useState } from "react"
import {
  Copy,
  Flame,
  Heart,
  ImageOff,
  MessageCircle,
  Search,
  Send,
  Smile,
  Sparkles,
  Trash2,
  Upload,
  Wand2,
  X,
} from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import { useAuth } from "@/lib/auth-context"
import {
  plazaApi,
  type MyPlazaImage,
  type PlazaComment,
  type PlazaImage,
  type PlazaSort,
} from "@/lib/image-plaza"

type Props = {
  open: boolean
  onClose: () => void
  onUsePrompt: (prompt: string) => void
  onUseAsEditBase?: (filename: string, prompt: string) => void
}

type Tab = "discover" | "mine"

type DetailTarget =
  | { kind: "discover"; image: PlazaImage }
  | { kind: "mine"; image: MyPlazaImage }

export function ImagePlazaDialog({
  open,
  onClose,
  onUsePrompt,
  onUseAsEditBase,
}: Props) {
  const { state: authState } = useAuth()
  const currentUsername =
    authState.status === "authed" ? authState.user.username : null
  const currentUserIsAdmin =
    authState.status === "authed" ? authState.user.is_admin === true : false

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
  const [likeBusy, setLikeBusy] = useState<number | null>(null)
  const [detail, setDetail] = useState<DetailTarget | null>(null)

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
      setDetail(null)
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
    if (!onUseAsEditBase) return
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

  async function toggleLike(p: PlazaImage) {
    if (likeBusy === p.id) return
    setLikeBusy(p.id)
    const wasLiked = p.liked_by_me > 0
    try {
      const res = wasLiked
        ? await plazaApi.unlike(p.id)
        : await plazaApi.like(p.id)
      setItems((list) =>
        list.map((it) =>
          it.id === p.id
            ? {
                ...it,
                liked_by_me: res.liked ? 1 : 0,
                like_count: res.like_count,
              }
            : it
        )
      )
      if (detail && detail.kind === "discover" && detail.image.id === p.id) {
        setDetail({
          kind: "discover",
          image: {
            ...detail.image,
            liked_by_me: res.liked ? 1 : 0,
            like_count: res.like_count,
          },
        })
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setLikeBusy(null)
    }
  }

  function openDetail(
    kind: "discover" | "mine",
    image: PlazaImage | MyPlazaImage
  ) {
    if (kind === "discover") {
      setDetail({ kind, image: image as PlazaImage })
    } else {
      setDetail({ kind, image: image as MyPlazaImage })
    }
  }

  function handleCommentCountChange(imageId: number, delta: number) {
    setItems((list) =>
      list.map((it) =>
        it.id === imageId
          ? { ...it, comment_count: Math.max(0, it.comment_count + delta) }
          : it
      )
    )
    setMineItems((list) =>
      list.map((it) =>
        it.id === imageId
          ? { ...it, comment_count: Math.max(0, it.comment_count + delta) }
          : it
      )
    )
    setDetail((d) => {
      if (!d || d.image.id !== imageId) return d
      const image = {
        ...d.image,
        comment_count: Math.max(0, d.image.comment_count + delta),
      }
      return d.kind === "discover"
        ? { kind: "discover", image: image as PlazaImage }
        : { kind: "mine", image: image as MyPlazaImage }
    })
  }

  if (!open) return null

  return (
    <div
      className="fixed inset-0 z-50 grid place-items-center bg-black/50 p-4"
      onClick={onClose}
    >
      <div
        className="relative flex w-full max-w-5xl flex-col gap-3 rounded-lg border border-border bg-background p-6 shadow-lg"
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
                variant={sort === "liked" ? "secondary" : "ghost"}
                className="h-7 px-2"
                onClick={() => {
                  setSort("liked")
                  setPage(1)
                }}
              >
                <Heart className="size-3.5" /> 点赞
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
              {items.map((p) => {
                const liked = p.liked_by_me > 0
                return (
                  <li
                    key={p.id}
                    className="flex flex-col overflow-hidden rounded-md border border-border bg-background"
                  >
                    <div className="relative aspect-square bg-muted">
                      <img
                        src={`/api/images/${p.filename}`}
                        alt={p.prompt}
                        loading="lazy"
                        className="absolute inset-0 size-full cursor-zoom-in object-cover"
                        onClick={() => openDetail("discover", p)}
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
                      <div className="flex items-center justify-between gap-1 text-[10px] text-muted-foreground/80">
                        <span className="truncate">by @{p.author_username}</span>
                        <span
                          className="shrink-0"
                          title={new Date(
                            p.created_at.includes("T")
                              ? p.created_at
                              : p.created_at.replace(" ", "T") + "Z"
                          ).toLocaleString()}
                        >
                          {formatTime(p.created_at)}
                        </span>
                      </div>
                      <div className="flex items-center gap-1">
                        <Button
                          size="xs"
                          variant={liked ? "secondary" : "ghost"}
                          className="h-6 px-1.5"
                          onClick={() => void toggleLike(p)}
                          disabled={likeBusy === p.id}
                          title={liked ? "取消点赞" : "点赞"}
                        >
                          <Heart
                            className={
                              liked
                                ? "size-3.5 fill-red-500 text-red-500"
                                : "size-3.5"
                            }
                          />
                          <span className="text-[10px]">{p.like_count}</span>
                        </Button>
                        <Button
                          size="xs"
                          variant="ghost"
                          className="h-6 px-1.5"
                          onClick={() => openDetail("discover", p)}
                          title="查看评论"
                        >
                          <MessageCircle className="size-3.5" />
                          <span className="text-[10px]">{p.comment_count}</span>
                        </Button>
                      </div>
                      <div className="flex items-center gap-1">
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
                )
              })}
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
                      className="absolute inset-0 size-full cursor-zoom-in object-cover"
                      onClick={() => openDetail("mine", p)}
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
                    <div className="flex items-center justify-between gap-2 text-[10px] text-muted-foreground">
                      <div className="flex items-center gap-2">
                        <span
                          className="inline-flex items-center gap-0.5"
                          title="点赞"
                        >
                          <Heart className="size-3" /> {p.like_count}
                        </span>
                        <button
                          type="button"
                          className="inline-flex items-center gap-0.5 hover:text-foreground"
                          title="查看评论"
                          onClick={() => openDetail("mine", p)}
                        >
                          <MessageCircle className="size-3" /> {p.comment_count}
                        </button>
                      </div>
                      <span
                        className="shrink-0"
                        title={new Date(
                          p.created_at.includes("T")
                            ? p.created_at
                            : p.created_at.replace(" ", "T") + "Z"
                        ).toLocaleString()}
                      >
                        {formatTime(p.created_at)}
                      </span>
                    </div>
                    <div className="flex items-center gap-1">
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

        {detail && (
          <DetailOverlay
            detail={detail}
            currentUsername={currentUsername}
            currentUserIsAdmin={currentUserIsAdmin}
            likeBusy={likeBusy === detail.image.id}
            onClose={() => setDetail(null)}
            onToggleLike={() => {
              if (detail.kind === "discover") void toggleLike(detail.image)
            }}
            onCommentCountChange={(delta) =>
              handleCommentCountChange(detail.image.id, delta)
            }
            onError={(msg) => setError(msg)}
          />
        )}
      </div>
    </div>
  )
}

function DetailOverlay({
  detail,
  currentUsername,
  currentUserIsAdmin,
  likeBusy,
  onClose,
  onToggleLike,
  onCommentCountChange,
  onError,
}: {
  detail: DetailTarget
  currentUsername: string | null
  currentUserIsAdmin: boolean
  likeBusy: boolean
  onClose: () => void
  onToggleLike: () => void
  onCommentCountChange: (delta: number) => void
  onError: (msg: string) => void
}) {
  const image = detail.image
  const isMine = detail.kind === "mine"
  const authorUsername = isMine
    ? currentUsername
    : (image as PlazaImage).author_username
  const canDeleteComment = (c: PlazaComment) =>
    currentUsername !== null &&
    (c.author_username === currentUsername ||
      authorUsername === currentUsername ||
      currentUserIsAdmin)

  const [comments, setComments] = useState<PlazaComment[]>([])
  const [loading, setLoading] = useState(true)
  const [draft, setDraft] = useState("")
  const [sending, setSending] = useState(false)
  const [emojiOpen, setEmojiOpen] = useState(false)
  const textareaRef = useRef<HTMLTextAreaElement | null>(null)

  function insertEmoji(emoji: string) {
    const el = textareaRef.current
    if (!el) {
      setDraft((d) => d + emoji)
      return
    }
    const start = el.selectionStart ?? draft.length
    const end = el.selectionEnd ?? draft.length
    const next = draft.slice(0, start) + emoji + draft.slice(end)
    setDraft(next)
    queueMicrotask(() => {
      el.focus()
      const pos = start + emoji.length
      el.setSelectionRange(pos, pos)
    })
  }

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    plazaApi
      .listComments(image.id)
      .then((r) => {
        if (!cancelled) setComments(r)
      })
      .catch((e) => {
        if (!cancelled) onError(e instanceof Error ? e.message : String(e))
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [image.id, onError])

  async function submit() {
    const text = draft.trim()
    if (!text || sending) return
    setSending(true)
    try {
      const c = await plazaApi.addComment(image.id, text)
      setComments((list) => [...list, c])
      setDraft("")
      onCommentCountChange(1)
    } catch (e) {
      onError(e instanceof Error ? e.message : String(e))
    } finally {
      setSending(false)
    }
  }

  async function remove(c: PlazaComment) {
    if (!window.confirm("删除这条评论？")) return
    try {
      await plazaApi.deleteComment(c.id)
      setComments((list) => list.filter((x) => x.id !== c.id))
      onCommentCountChange(-1)
    } catch (e) {
      onError(e instanceof Error ? e.message : String(e))
    }
  }

  const liked = !isMine && (image as PlazaImage).liked_by_me > 0

  return (
    <div
      className="absolute inset-0 z-10 grid place-items-center bg-background/95 p-4"
      onClick={onClose}
    >
      <div
        className="flex w-full max-w-4xl flex-col overflow-hidden rounded-lg border border-border bg-background shadow-lg md:h-[80vh] md:flex-row"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="relative flex min-h-[40vh] flex-1 items-center justify-center bg-muted md:min-h-0">
          <img
            src={`/api/images/${image.filename}`}
            alt={image.prompt}
            className="max-h-full max-w-full object-contain"
          />
          <Button
            size="icon"
            variant="secondary"
            className="absolute right-2 top-2 size-7"
            onClick={onClose}
            title="关闭"
          >
            <X className="size-4" />
          </Button>
        </div>
        <div className="flex w-full flex-col gap-3 border-t border-border p-4 md:w-[22rem] md:border-l md:border-t-0">
          <div className="flex flex-col gap-1">
            {!isMine && (
              <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
                <Avatar
                  name={(image as PlazaImage).author_username}
                  url={(image as PlazaImage).author_avatar_url}
                  size={18}
                />
                <span>by @{(image as PlazaImage).author_username}</span>
              </div>
            )}
            <p
              className="whitespace-pre-wrap break-words text-xs"
              title={image.prompt}
            >
              {image.prompt}
            </p>
            <div className="mt-1 flex items-center gap-3 text-xs text-muted-foreground">
              <span className="inline-flex items-center gap-1" title="复用次数">
                <Flame className="size-3.5" /> {image.clone_count}
              </span>
              {isMine ? (
                <span className="inline-flex items-center gap-1" title="点赞">
                  <Heart className="size-3.5" /> {image.like_count}
                </span>
              ) : (
                <Button
                  size="xs"
                  variant={liked ? "secondary" : "outline"}
                  className="h-6 px-1.5"
                  onClick={onToggleLike}
                  disabled={likeBusy}
                >
                  <Heart
                    className={
                      liked
                        ? "size-3.5 fill-red-500 text-red-500"
                        : "size-3.5"
                    }
                  />
                  <span className="text-[11px]">{image.like_count}</span>
                </Button>
              )}
              <span className="inline-flex items-center gap-1" title="评论数">
                <MessageCircle className="size-3.5" /> {image.comment_count}
              </span>
              <span
                className="ml-auto text-[11px]"
                title={new Date(
                  image.created_at.includes("T")
                    ? image.created_at
                    : image.created_at.replace(" ", "T") + "Z"
                ).toLocaleString()}
              >
                {formatTime(image.created_at)}
              </span>
            </div>
          </div>

          <div className="flex flex-1 flex-col gap-2 overflow-hidden">
            <div className="flex-1 overflow-y-auto rounded-md border border-border p-2">
              {loading && (
                <p className="text-xs text-muted-foreground">加载评论中…</p>
              )}
              {!loading && comments.length === 0 && (
                <p className="text-xs text-muted-foreground">
                  还没有评论，来说点什么吧。
                </p>
              )}
              <ul className="flex flex-col gap-2">
                {comments.map((c) => (
                  <li
                    key={c.id}
                    className="flex gap-2 rounded border border-border/60 bg-muted/30 p-2"
                  >
                    <Avatar
                      name={c.author_username}
                      url={c.author_avatar_url}
                      size={22}
                    />
                    <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                      <div className="flex items-center justify-between gap-2">
                        <span className="truncate text-[11px] font-medium">
                          @{c.author_username}
                        </span>
                        <div className="flex shrink-0 items-center gap-1">
                          <span className="text-[10px] text-muted-foreground">
                            {formatTime(c.created_at)}
                          </span>
                          {canDeleteComment(c) && (
                            <button
                              type="button"
                              className="text-[10px] text-muted-foreground hover:text-destructive"
                              onClick={() => void remove(c)}
                              title="删除评论"
                            >
                              <Trash2 className="size-3" />
                            </button>
                          )}
                        </div>
                      </div>
                      <p className="whitespace-pre-wrap break-words text-xs">
                        {c.content}
                      </p>
                    </div>
                  </li>
                ))}
              </ul>
            </div>
            <div className="relative flex items-end gap-2">
              <Textarea
                ref={textareaRef}
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                placeholder="写一条评论…（Ctrl/⌘+Enter 发送）"
                className="min-h-[2.5rem] flex-1 resize-none text-xs"
                maxLength={1000}
                onKeyDown={(e) => {
                  if (
                    e.key === "Enter" &&
                    (e.ctrlKey || e.metaKey) &&
                    !sending
                  ) {
                    e.preventDefault()
                    void submit()
                  }
                }}
              />
              <Button
                size="sm"
                variant="ghost"
                onClick={() => setEmojiOpen((v) => !v)}
                title="插入表情"
              >
                <Smile className="size-3.5" />
              </Button>
              <Button
                size="sm"
                onClick={() => void submit()}
                disabled={sending || draft.trim().length === 0}
                title="发送"
              >
                <Send className="size-3.5" />
              </Button>
              {emojiOpen && (
                <EmojiPicker
                  onPick={(e) => {
                    insertEmoji(e)
                  }}
                  onClose={() => setEmojiOpen(false)}
                />
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}

function Avatar({
  name,
  url,
  size = 22,
}: {
  name: string
  url: string | null
  size?: number
}) {
  const letter = (name?.trim()?.slice(0, 1) || "?").toUpperCase()
  const dim = { width: size, height: size }
  if (url) {
    return (
      <img
        src={url}
        alt=""
        style={dim}
        className="shrink-0 rounded-full border border-border object-cover"
      />
    )
  }
  return (
    <div
      style={{ ...dim, fontSize: Math.max(9, Math.floor(size * 0.45)) }}
      className="grid shrink-0 place-items-center rounded-full bg-gradient-to-br from-primary to-chart-5 font-semibold text-primary-foreground"
    >
      {letter}
    </div>
  )
}

const EMOJI_GROUPS: { label: string; items: string[] }[] = [
  {
    label: "表情",
    items: [
      "😀", "😁", "😂", "🤣", "😊", "😍", "😘", "😎", "🤩", "🥰",
      "😇", "🙂", "😉", "😌", "😋", "🤗", "🤔", "😴", "🤤", "😪",
      "😏", "😬", "🫣", "🫢", "🫠", "🙃", "😅", "😆", "😃", "😄",
      "😮", "😯", "😲", "🥺", "😢", "😭", "😤", "😠", "😡", "🤬",
      "😱", "😨", "😰", "😥", "🤯", "🫨", "🤒", "🤕", "🤧", "🤮",
    ],
  },
  {
    label: "手势",
    items: [
      "👍", "👎", "👏", "🙌", "🙏", "👋", "🤝", "✌️", "🤞", "🤟",
      "🤘", "👌", "🤌", "🤏", "💪", "🫡", "🫶", "👀", "👂", "👃",
    ],
  },
  {
    label: "符号",
    items: [
      "❤️", "🧡", "💛", "💚", "💙", "💜", "🖤", "🤍", "💔", "💖",
      "✨", "⭐", "🌟", "🔥", "💯", "🎉", "🎊", "🎁", "🏆", "🥇",
      "✅", "❌", "❓", "❗", "⚠️", "💡", "💬", "💭", "🫧", "☀️",
    ],
  },
]

function EmojiPicker({
  onPick,
  onClose,
}: {
  onPick: (emoji: string) => void
  onClose: () => void
}) {
  const ref = useRef<HTMLDivElement | null>(null)
  useEffect(() => {
    function onDown(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose()
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose()
    }
    window.addEventListener("mousedown", onDown)
    window.addEventListener("keydown", onKey)
    return () => {
      window.removeEventListener("mousedown", onDown)
      window.removeEventListener("keydown", onKey)
    }
  }, [onClose])

  return (
    <div
      ref={ref}
      className="absolute bottom-full right-0 z-20 mb-2 flex w-64 flex-col gap-2 rounded-md border border-border bg-popover p-2 shadow-lg"
    >
      {EMOJI_GROUPS.map((g) => (
        <div key={g.label} className="flex flex-col gap-1">
          <p className="text-[10px] uppercase tracking-wide text-muted-foreground">
            {g.label}
          </p>
          <div className="grid grid-cols-8 gap-0.5">
            {g.items.map((e) => (
              <button
                key={e}
                type="button"
                className="rounded text-lg leading-none hover:bg-accent"
                onClick={() => onPick(e)}
                title={e}
              >
                {e}
              </button>
            ))}
          </div>
        </div>
      ))}
    </div>
  )
}

function formatTime(s: string): string {
  const d = new Date(s.includes("T") ? s : s.replace(" ", "T") + "Z")
  if (Number.isNaN(d.getTime())) return s
  const diff = Date.now() - d.getTime()
  const mins = Math.floor(diff / 60000)
  if (mins < 1) return "刚刚"
  if (mins < 60) return `${mins} 分钟前`
  const hrs = Math.floor(mins / 60)
  if (hrs < 24) return `${hrs} 小时前`
  const days = Math.floor(hrs / 24)
  if (days < 7) return `${days} 天前`
  return d.toLocaleDateString()
}
