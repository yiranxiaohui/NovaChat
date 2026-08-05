import { useEffect, useMemo, useState, type ReactNode } from "react"
import { Link, useLocation, useNavigate, useParams } from "react-router-dom"
import {
  BookMarked,
  Bot,
  Clapperboard,
  ImageIcon,
  Images,
  LogOut,
  MessageSquareText,
  MoreHorizontal,
  Pencil,
  Plus,
  Search,
  Shield,
  Sparkles,
  Trash2,
  User,
} from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { conversationsApi, type Conversation } from "@/lib/conversations"
import { searchApi, type SearchHit } from "@/lib/search"
import { workerApi, type WorkerSession } from "@/lib/worker"
import { cn } from "@/lib/utils"
import { useAuth } from "@/lib/auth-context"
import { useConfirm } from "@/lib/confirm-context"
import { BrandMark } from "./BrandMark"
import { ProfileDialog } from "./ProfileDialog"

type Props = {
  reloadKey: number
  onCreated?: (c: Conversation) => void
  onOpenLibrary?: () => void
  /** Called after the user picks a navigation target (link or button).
   *  Parent uses this to close the mobile drawer. */
  onNavigate?: () => void
}

type SidebarItem =
  | { kind: "chat"; id: number; title: string; updated_at: string }
  | { kind: "worker"; id: number; title: string; updated_at: string }

function relativeTime(iso: string): string {
  const d = new Date(iso.replace(" ", "T") + (iso.endsWith("Z") ? "" : "Z"))
  const diff = Date.now() - d.getTime()
  const m = Math.floor(diff / 60000)
  if (m < 1) return "刚刚"
  if (m < 60) return `${m} 分钟前`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h} 小时前`
  const days = Math.floor(h / 24)
  if (days < 7) return `${days} 天前`
  return d.toLocaleDateString()
}

export function Sidebar({ reloadKey, onCreated, onOpenLibrary, onNavigate }: Props) {
  const { confirm, prompt } = useConfirm()
  const { id: paramId } = useParams()
  const activeId = paramId ? Number(paramId) : null
  const location = useLocation()
  const activeWorker = location.pathname.startsWith("/w/")
  const nav = useNavigate()
  const auth = useAuth()
  const user = auth.state.status === "authed" ? auth.state.user : null

  const [items, setItems] = useState<SidebarItem[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [menuFor, setMenuFor] = useState<string | null>(null)
  const [query, setQuery] = useState("")
  const [profileOpen, setProfileOpen] = useState(false)
  const [avatarBroken, setAvatarBroken] = useState(false)
  const [searchHits, setSearchHits] = useState<SearchHit[] | null>(null)
  const [searching, setSearching] = useState(false)
  const [searchError, setSearchError] = useState<string | null>(null)

  useEffect(() => {
    setAvatarBroken(false)
  }, [user?.avatar_url])

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    Promise.all([
      conversationsApi.list().catch(() => [] as Conversation[]),
      workerApi.sessions().catch(() => [] as WorkerSession[]),
    ])
      .then(([convs, sessions]) => {
        if (cancelled) return
        const merged: SidebarItem[] = [
          ...convs.map((c) => ({
            kind: "chat" as const,
            id: c.id,
            title: c.title,
            updated_at: c.updated_at,
          })),
          ...sessions.map((s) => ({
            kind: "worker" as const,
            id: s.id,
            title: s.title,
            updated_at: s.updated_at,
          })),
        ].sort((a, b) => (a.updated_at < b.updated_at ? 1 : -1))
        setItems(merged)
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
  }, [reloadKey])

  const trimmedQuery = query.trim()
  const isApiSearch = trimmedQuery.length >= 2
  const filtered = useMemo(() => {
    if (isApiSearch) return items
    const q = trimmedQuery.toLowerCase()
    if (!q) return items
    return items.filter((c) => c.title.toLowerCase().includes(q))
  }, [items, trimmedQuery, isApiSearch])

  useEffect(() => {
    if (!isApiSearch) {
      setSearchHits(null)
      setSearching(false)
      setSearchError(null)
      return
    }
    let cancelled = false
    setSearchError(null)
    setSearching(true)
    const handle = window.setTimeout(() => {
      searchApi
        .conversations(trimmedQuery)
        .then((hits) => {
          if (!cancelled) setSearchHits(hits)
        })
        .catch((e) => {
          if (!cancelled) {
            setSearchHits([])
            setSearchError(e instanceof Error ? e.message : String(e))
          }
        })
        .finally(() => {
          if (!cancelled) setSearching(false)
        })
    }, 280)
    return () => {
      cancelled = true
      window.clearTimeout(handle)
    }
  }, [trimmedQuery, isApiSearch])

  async function createNew() {
    try {
      const c = await conversationsApi.create()
      setItems((s) => [
        { kind: "chat" as const, id: c.id, title: c.title, updated_at: c.updated_at },
        ...s,
      ])
      onCreated?.(c)
      nav(`/c/${c.id}`)
      onNavigate?.()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  async function rename(c: SidebarItem) {
    const next = await prompt({
      title: "重命名会话",
      defaultValue: c.title,
      placeholder: "会话标题",
    })
    if (next == null) return
    const title = next.trim()
    if (!title || title === c.title) return
    try {
      if (c.kind === "worker") {
        await workerApi.renameSession(c.id, title)
      } else {
        await conversationsApi.update(c.id, { title })
      }
      setItems((s) =>
        s.map((x) => (x.kind === c.kind && x.id === c.id ? { ...x, title } : x))
      )
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  async function remove(c: SidebarItem) {
    const ok = await confirm({
      title: `删除会话 "${c.title}"？`,
      description: "此操作不可撤销。",
      confirmText: "删除",
      destructive: true,
    })
    if (!ok) return
    try {
      if (c.kind === "worker") {
        await workerApi.removeSession(c.id)
      } else {
        await conversationsApi.remove(c.id)
      }
      setItems((s) => s.filter((x) => !(x.kind === c.kind && x.id === c.id)))
      const isActive =
        c.kind === "worker" ? activeWorker && activeId === c.id : !activeWorker && activeId === c.id
      if (isActive) nav("/")
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  async function removeAll() {
    const chatCount = items.filter((x) => x.kind === "chat").length
    const ok = await confirm({
      title: `确定要清空全部 ${chatCount} 个会话吗？`,
      description: "此操作不可撤销。",
      confirmText: "清空",
      destructive: true,
    })
    if (!ok) return
    try {
      await conversationsApi.removeAll()
      setItems((s) => s.filter((x) => x.kind !== "chat"))
      nav("/")
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  return (
    <aside className="flex h-full w-72 shrink-0 flex-col border-r border-sidebar-border bg-sidebar text-sidebar-foreground">
      <div className="flex items-center justify-between px-4 pb-3 pt-4">
        <BrandMark />
      </div>

      <div className="flex flex-col gap-2 px-3 pb-2">
        <Button onClick={createNew} className="w-full justify-start gap-2" size="sm">
          <Plus className="size-4" /> 新建会话
        </Button>
        <Button
          asChild
          variant="outline"
          size="sm"
          className="w-full justify-start gap-2"
        >
          <Link to="/studio" onClick={() => onNavigate?.()} title="多轮对话式生图（Responses API）">
            <ImageIcon className="size-4" /> 图像工作室
          </Link>
        </Button>
        <Button asChild variant="outline" size="sm" className="w-full justify-start gap-2">
          <Link to="/videos" onClick={() => onNavigate?.()} title="文生视频 / 图生视频">
            <Clapperboard className="size-4" /> 视频工作室
          </Link>
        </Button>

        <div className="relative">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="搜索会话…"
            className="h-8 pl-8 text-sm"
          />
        </div>
      </div>

      <div className="nc-scroll flex-1 overflow-y-auto px-2 pb-2">
        {isApiSearch ? (
          <SearchResultsView
            query={trimmedQuery}
            hits={searchHits}
            searching={searching}
            error={searchError}
            onNavigate={() => {
              setMenuFor(null)
              onNavigate?.()
            }}
          />
        ) : (
          <>
        {loading && (
          <p className="px-2 py-1 text-xs text-muted-foreground">加载中…</p>
        )}
        {!loading && filtered.length === 0 && (
          <p className="px-2 py-6 text-center text-xs text-muted-foreground">
            {items.length === 0 ? "还没有会话" : "没有匹配结果"}
          </p>
        )}
        {error && (
          <p className="mx-2 my-1 rounded-md border border-destructive/40 bg-destructive/10 px-2 py-1 text-xs text-destructive">
            {error}
          </p>
        )}
        <ul className="flex flex-col gap-0.5">
          {filtered.map((c) => {
            const active = activeWorker
              ? c.kind === "worker" && activeId === c.id
              : c.kind === "chat" && activeId === c.id
            const itemKey = `${c.kind}-${c.id}`
            return (
              <li key={itemKey} className="relative">
                <div
                  className={cn(
                    "group relative flex items-center rounded-lg transition-colors",
                    active
                      ? "bg-sidebar-accent text-sidebar-accent-foreground"
                      : "hover:bg-sidebar-accent/50"
                  )}
                >
                  {active && (
                    <span className="absolute left-0 top-1/2 h-5 w-0.5 -translate-y-1/2 rounded-r bg-sidebar-primary" />
                  )}
                  <Link
                    to={c.kind === "worker" ? `/w/${c.id}` : `/c/${c.id}`}
                    className="min-w-0 flex-1 px-3 py-2"
                    title={c.title}
                    onClick={() => {
                      setMenuFor(null)
                      onNavigate?.()
                    }}
                  >
                    <div className="flex items-center gap-1 truncate text-sm font-medium">
                      {c.kind === "worker" && (
                        <Bot className="size-3.5 shrink-0 text-primary" />
                      )}
                      <span className="truncate">{c.title}</span>
                    </div>
                    <div className="mt-0.5 truncate text-[11px] text-muted-foreground">
                      {relativeTime(c.updated_at)}
                    </div>
                  </Link>
                  <button
                    type="button"
                    className="mr-1 rounded p-1 text-muted-foreground opacity-0 transition-opacity hover:bg-background/60 hover:text-foreground group-hover:opacity-100 data-[open=true]:opacity-100"
                    data-open={menuFor === itemKey}
                    onClick={(e) => {
                      e.stopPropagation()
                      setMenuFor(menuFor === itemKey ? null : itemKey)
                    }}
                    aria-label="菜单"
                  >
                    <MoreHorizontal className="size-4" />
                  </button>
                </div>
                {menuFor === itemKey && (
                  <div
                    className="absolute right-1 top-full z-10 mt-0.5 flex min-w-36 flex-col rounded-md border border-border bg-popover p-1 text-sm shadow-panel"
                    onMouseLeave={() => setMenuFor(null)}
                  >
                    <button
                      className="flex items-center gap-2 rounded px-2 py-1 text-left hover:bg-accent"
                      onClick={() => {
                        setMenuFor(null)
                        void rename(c)
                      }}
                    >
                      <Pencil className="size-3.5" /> 重命名
                    </button>
                    <button
                      className="flex items-center gap-2 rounded px-2 py-1 text-left text-destructive hover:bg-destructive/10"
                      onClick={() => {
                        setMenuFor(null)
                        void remove(c)
                      }}
                    >
                      <Trash2 className="size-3.5" /> 删除
                    </button>
                  </div>
                )}
              </li>
            )
          })}
        </ul>
        {!loading && items.some((x) => x.kind === "chat") && !trimmedQuery && (
          <button
            type="button"
            onClick={() => void removeAll()}
            className="mx-2 mt-2 flex w-[calc(100%-1rem)] items-center justify-center gap-1.5 rounded-md px-2 py-1.5 text-xs text-muted-foreground transition-colors hover:bg-destructive/10 hover:text-destructive"
            title="删除全部会话"
          >
            <Trash2 className="size-3.5" /> 清空全部会话
          </button>
        )}
          </>
        )}
      </div>

      <div className="flex flex-col gap-1 border-t border-sidebar-border px-2 py-2">
        <Link
          to="/plaza"
          onClick={() => onNavigate?.()}
          className="flex items-center gap-2 rounded-md px-2 py-1.5 text-sm text-muted-foreground transition-colors hover:bg-sidebar-accent/60 hover:text-sidebar-accent-foreground"
          title="浏览公开发布的生成图"
        >
          <Images className="size-4" /> 图片广场
        </Link>
        {user?.is_admin && (
          <Link
            to="/admin"
            onClick={() => onNavigate?.()}
            className="flex items-center gap-2 rounded-md px-2 py-1.5 text-sm text-muted-foreground transition-colors hover:bg-sidebar-accent/60 hover:text-sidebar-accent-foreground"
            title="进入管理控制台"
          >
            <Shield className="size-4" /> 管理控制台
          </Link>
        )}
        {onOpenLibrary && (
          <button
            type="button"
            onClick={() => {
              onOpenLibrary()
              onNavigate?.()
            }}
            className="flex items-center gap-2 rounded-md px-2 py-1.5 text-sm text-muted-foreground transition-colors hover:bg-sidebar-accent/60 hover:text-sidebar-accent-foreground"
          >
            <BookMarked className="size-4" /> 提示词库
          </button>
        )}
        <div className="mt-1 flex items-center justify-between gap-2 rounded-md bg-sidebar-accent/40 px-1 py-1">
          <button
            type="button"
            onClick={() => setProfileOpen(true)}
            className="flex min-w-0 flex-1 items-center gap-2 rounded px-1 py-0.5 text-left transition-colors hover:bg-sidebar-accent/70"
            title="个人资料"
          >
            {user?.avatar_url && !avatarBroken ? (
              <img
                src={user.avatar_url}
                alt=""
                className="size-7 shrink-0 rounded-full border border-border object-cover"
                onError={() => setAvatarBroken(true)}
              />
            ) : (
              <div className="grid size-7 shrink-0 place-items-center rounded-full bg-gradient-to-br from-primary to-chart-5 text-[11px] font-semibold text-primary-foreground">
                {((user?.display_name?.trim() || user?.username || "?")
                  .slice(0, 1)).toUpperCase()}
              </div>
            )}
            <span className="truncate text-xs">
              {user?.display_name?.trim() || user?.username}
            </span>
          </button>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => void auth.logout()}
            title="退出登录"
          >
            <LogOut className="size-4" />
          </Button>
        </div>
      </div>

      <ProfileDialog open={profileOpen} onClose={() => setProfileOpen(false)} />
    </aside>
  )
}

function highlightTerm(text: string, term: string): ReactNode[] {
  if (!term) return [text]
  const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
  const re = new RegExp(`(${escaped})`, "ig")
  const parts = text.split(re)
  return parts.map((p, i) =>
    i % 2 === 1 ? (
      <mark
        key={i}
        className="rounded-sm bg-yellow-300/60 px-0.5 text-foreground dark:bg-yellow-400/40"
      >
        {p}
      </mark>
    ) : (
      <span key={i}>{p}</span>
    )
  )
}

function SearchResultsView({
  query,
  hits,
  searching,
  error,
  onNavigate,
}: {
  query: string
  hits: SearchHit[] | null
  searching: boolean
  error: string | null
  onNavigate: () => void
}) {
  if (error) {
    return (
      <p className="mx-2 my-2 rounded-md border border-destructive/40 bg-destructive/10 px-2 py-1.5 text-xs text-destructive">
        搜索失败：{error}
      </p>
    )
  }
  if (hits == null) {
    return (
      <p className="px-2 py-3 text-xs text-muted-foreground">
        {searching ? "搜索中…" : "输入关键词搜索"}
      </p>
    )
  }
  if (hits.length === 0) {
    return (
      <p className="px-2 py-6 text-center text-xs text-muted-foreground">
        {searching ? "搜索中…" : "没有匹配结果"}
      </p>
    )
  }
  return (
    <>
      {searching && (
        <p className="px-2 py-1 text-[11px] text-muted-foreground">搜索中…</p>
      )}
      <ul className="flex flex-col gap-0.5">
        {hits.map((h, idx) => {
          const target =
            h.kind === "content" && h.message_id != null
              ? `/c/${h.conversation_id}?msg=${h.message_id}`
              : `/c/${h.conversation_id}`
          const key = `${h.kind}-${h.conversation_id}-${h.message_id ?? "t"}-${idx}`
          const Icon =
            h.kind === "title"
              ? MessageSquareText
              : h.role === "user"
                ? User
                : Sparkles
          return (
            <li key={key}>
              <Link
                to={target}
                onClick={onNavigate}
                className="flex flex-col gap-1 rounded-lg px-3 py-2 transition-colors hover:bg-sidebar-accent/60"
                title={h.conversation_title}
              >
                <div className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
                  <Icon className="size-3 shrink-0" />
                  <span className="truncate">
                    {highlightTerm(h.conversation_title, query)}
                  </span>
                </div>
                {h.kind === "content" && (
                  <div className="line-clamp-2 text-xs leading-snug text-foreground/90">
                    {highlightTerm(h.snippet, query)}
                  </div>
                )}
              </Link>
            </li>
          )
        })}
      </ul>
    </>
  )
}
