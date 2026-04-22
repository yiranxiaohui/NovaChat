import { useEffect, useState } from "react"
import { CopyPlus, Flame, Search, Sparkles } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import {
  skillsApi,
  type PublicSkill,
  type PublicSkillSort,
} from "@/lib/skills"

type Props = {
  open: boolean
  onClose: () => void
  onCloned?: () => void
}

export function SkillDiscoverDialog({ open, onClose, onCloned }: Props) {
  const [items, setItems] = useState<PublicSkill[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [search, setSearch] = useState("")
  const [page, setPage] = useState(1)
  const [sort, setSort] = useState<PublicSkillSort>("hot")
  const [cloningId, setCloningId] = useState<number | null>(null)
  const [clonedIds, setClonedIds] = useState<Set<number>>(new Set())

  useEffect(() => {
    if (!open) return
    let cancelled = false
    setLoading(true)
    setError(null)
    skillsApi
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
  }, [open, search, page, sort])

  useEffect(() => {
    if (open) {
      setClonedIds(new Set())
      setPage(1)
    }
  }, [open])

  async function clone(p: PublicSkill) {
    setCloningId(p.id)
    try {
      await skillsApi.clonePublic(p.id)
      setClonedIds((s) => new Set(s).add(p.id))
      setItems((list) =>
        list.map((it) =>
          it.id === p.id ? { ...it, clone_count: it.clone_count + 1 } : it
        )
      )
      onCloned?.()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setCloningId(null)
    }
  }

  if (!open) return null

  return (
    <div
      className="fixed inset-0 z-[60] grid place-items-center bg-black/50 p-4"
      onClick={onClose}
    >
      <div
        className="flex w-full max-w-3xl flex-col gap-3 rounded-lg border border-border bg-background p-6 shadow-lg"
        onClick={(e) => e.stopPropagation()}
        style={{ maxHeight: "calc(100svh - 2rem)" }}
      >
        <div>
          <h2 className="text-lg font-semibold">发现公开 Skills</h2>
          <p className="text-sm text-muted-foreground">
            点「克隆」把 skill 完整复制到你自己的库,之后可挂到任意会话。
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <div className="relative min-w-[12rem] flex-1">
            <Search className="pointer-events-none absolute left-2 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              className="pl-8"
              placeholder="按名称、描述或指令搜索…"
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
              disabled={loading || items.length < 20}
              onClick={() => setPage((p) => p + 1)}
            >
              下一页
            </Button>
          </div>
        </div>

        {error && (
          <div className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
            {error}
          </div>
        )}

        <div className="flex-1 overflow-y-auto">
          {loading && <p className="text-sm text-muted-foreground">加载中…</p>}
          {!loading && items.length === 0 && (
            <p className="text-sm text-muted-foreground">
              {search ? "没有匹配结果。" : "还没有人公开 skill。"}
            </p>
          )}
          <ul className="flex flex-col gap-2">
            {items.map((p) => (
              <li
                key={p.id}
                className="flex items-start gap-3 rounded-md border border-border bg-background p-3"
              >
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
                    <span className="truncate font-medium">{p.name}</span>
                    <span className="text-xs text-muted-foreground">
                      by @{p.author_username}
                    </span>
                    <span
                      className="inline-flex items-center gap-0.5 text-xs text-muted-foreground"
                      title={`已被克隆 ${p.clone_count} 次`}
                    >
                      <Flame className="size-3" />
                      {p.clone_count}
                    </span>
                  </div>
                  {p.description && (
                    <p className="mt-0.5 line-clamp-2 text-xs text-muted-foreground">
                      {p.description}
                    </p>
                  )}
                  <p className="mt-1 line-clamp-3 whitespace-pre-wrap text-xs text-muted-foreground/80">
                    {p.instructions || <em>（空指令）</em>}
                  </p>
                </div>
                <Button
                  size="sm"
                  variant={clonedIds.has(p.id) ? "ghost" : "outline"}
                  onClick={() => void clone(p)}
                  disabled={cloningId === p.id || clonedIds.has(p.id)}
                >
                  <CopyPlus />
                  {clonedIds.has(p.id)
                    ? "已添加"
                    : cloningId === p.id
                    ? "添加中…"
                    : "克隆"}
                </Button>
              </li>
            ))}
          </ul>
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
