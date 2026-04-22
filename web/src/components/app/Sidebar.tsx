import { useEffect, useMemo, useState } from "react"
import { Link, useNavigate, useParams } from "react-router-dom"
import {
  BookMarked,
  LogOut,
  MoreHorizontal,
  Pencil,
  Plus,
  Search,
  Trash2,
} from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { conversationsApi, type Conversation } from "@/lib/conversations"
import { cn } from "@/lib/utils"
import { useAuth } from "@/lib/auth-context"
import { BrandMark } from "./BrandMark"

type Props = {
  reloadKey: number
  onCreated?: (c: Conversation) => void
  onOpenLibrary?: () => void
}

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

export function Sidebar({ reloadKey, onCreated, onOpenLibrary }: Props) {
  const { id: paramId } = useParams()
  const activeId = paramId ? Number(paramId) : null
  const nav = useNavigate()
  const auth = useAuth()
  const user = auth.state.status === "authed" ? auth.state.user : null

  const [items, setItems] = useState<Conversation[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [menuFor, setMenuFor] = useState<number | null>(null)
  const [query, setQuery] = useState("")

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    conversationsApi
      .list()
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
  }, [reloadKey])

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return items
    return items.filter((c) => c.title.toLowerCase().includes(q))
  }, [items, query])

  async function createNew() {
    try {
      const c = await conversationsApi.create()
      setItems((s) => [c, ...s])
      onCreated?.(c)
      nav(`/c/${c.id}`)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  async function rename(c: Conversation) {
    const next = window.prompt("重命名会话", c.title)
    if (next == null) return
    const title = next.trim()
    if (!title || title === c.title) return
    try {
      await conversationsApi.update(c.id, { title })
      setItems((s) => s.map((x) => (x.id === c.id ? { ...x, title } : x)))
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  async function remove(c: Conversation) {
    if (!window.confirm(`删除会话 "${c.title}"？此操作不可撤销。`)) return
    try {
      await conversationsApi.remove(c.id)
      setItems((s) => s.filter((x) => x.id !== c.id))
      if (activeId === c.id) nav("/")
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
            const active = activeId === c.id
            return (
              <li key={c.id} className="relative">
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
                    to={`/c/${c.id}`}
                    className="min-w-0 flex-1 px-3 py-2"
                    title={c.title}
                    onClick={() => setMenuFor(null)}
                  >
                    <div className="truncate text-sm font-medium">{c.title}</div>
                    <div className="mt-0.5 truncate text-[11px] text-muted-foreground">
                      {relativeTime(c.updated_at)}
                    </div>
                  </Link>
                  <button
                    type="button"
                    className="mr-1 rounded p-1 text-muted-foreground opacity-0 transition-opacity hover:bg-background/60 hover:text-foreground group-hover:opacity-100 data-[open=true]:opacity-100"
                    data-open={menuFor === c.id}
                    onClick={(e) => {
                      e.stopPropagation()
                      setMenuFor(menuFor === c.id ? null : c.id)
                    }}
                    aria-label="菜单"
                  >
                    <MoreHorizontal className="size-4" />
                  </button>
                </div>
                {menuFor === c.id && (
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
      </div>

      <div className="flex flex-col gap-1 border-t border-sidebar-border px-2 py-2">
        {onOpenLibrary && (
          <button
            type="button"
            onClick={onOpenLibrary}
            className="flex items-center gap-2 rounded-md px-2 py-1.5 text-sm text-muted-foreground transition-colors hover:bg-sidebar-accent/60 hover:text-sidebar-accent-foreground"
          >
            <BookMarked className="size-4" /> 提示词库
          </button>
        )}
        <div className="mt-1 flex items-center justify-between gap-2 rounded-md bg-sidebar-accent/40 px-2 py-1.5">
          <div className="flex min-w-0 items-center gap-2">
            <div className="grid size-7 place-items-center rounded-full bg-gradient-to-br from-primary to-chart-5 text-[11px] font-semibold text-primary-foreground">
              {(user?.username ?? "?").slice(0, 1).toUpperCase()}
            </div>
            <span className="truncate text-xs">{user?.username}</span>
          </div>
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
    </aside>
  )
}
