import { useEffect, useState } from "react"
import { Link, useNavigate, useParams } from "react-router-dom"
import { BookMarked, LogOut, MoreHorizontal, Pencil, Plus, Trash2 } from "lucide-react"
import { Button } from "@/components/ui/button"
import { conversationsApi, type Conversation } from "@/lib/conversations"
import { cn } from "@/lib/utils"
import { useAuth } from "@/lib/auth-context"

type Props = {
  reloadKey: number
  onCreated?: (c: Conversation) => void
  onOpenLibrary?: () => void
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
    <aside className="flex h-full w-64 flex-col border-r border-border bg-muted/30">
      <div className="flex items-center justify-between gap-2 border-b border-border px-3 py-3">
        <h1 className="text-sm font-semibold tracking-tight">NovaChat</h1>
        <Button size="sm" variant="outline" onClick={createNew}>
          <Plus /> 新会话
        </Button>
      </div>

      <div className="flex-1 overflow-y-auto px-2 py-2">
        {loading && (
          <p className="px-2 py-1 text-xs text-muted-foreground">加载中…</p>
        )}
        {!loading && items.length === 0 && (
          <p className="px-2 py-1 text-xs text-muted-foreground">
            还没有会话，点「新会话」开始。
          </p>
        )}
        {error && (
          <p className="mx-2 my-1 rounded-md border border-destructive/40 bg-destructive/10 px-2 py-1 text-xs text-destructive">
            {error}
          </p>
        )}
        <ul className="flex flex-col gap-0.5">
          {items.map((c) => (
            <li key={c.id} className="relative">
              <div
                className={cn(
                  "group flex items-center rounded-md",
                  activeId === c.id ? "bg-accent" : "hover:bg-accent/60"
                )}
              >
                <Link
                  to={`/c/${c.id}`}
                  className="flex-1 truncate px-2 py-1.5 text-sm"
                  title={c.title}
                  onClick={() => setMenuFor(null)}
                >
                  {c.title}
                </Link>
                <button
                  type="button"
                  className="mr-1 rounded p-1 opacity-0 transition-opacity hover:bg-background group-hover:opacity-100 data-[open=true]:opacity-100"
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
                  className="absolute right-1 top-full z-10 mt-0.5 flex min-w-32 flex-col rounded-md border border-border bg-popover p-1 text-sm shadow-md"
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
          ))}
        </ul>
      </div>

      <div className="flex flex-col gap-1 border-t border-border px-2 py-2">
        {onOpenLibrary && (
          <button
            type="button"
            onClick={onOpenLibrary}
            className="flex items-center gap-2 rounded-md px-2 py-1.5 text-sm text-muted-foreground hover:bg-accent hover:text-foreground"
          >
            <BookMarked className="size-4" /> 提示词库
          </button>
        )}
        <div className="flex items-center justify-between gap-2 px-1">
          <span className="truncate text-xs text-muted-foreground">
            {user?.username}
          </span>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => void auth.logout()}
            title="退出登录"
          >
            <LogOut />
          </Button>
        </div>
      </div>
    </aside>
  )
}
