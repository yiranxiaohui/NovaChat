import { useEffect, useState } from "react"
import { CopyPlus, Search } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { promptsApi, type PublicPrompt } from "@/lib/prompts"

type Props = {
  open: boolean
  onClose: () => void
  onCloned?: () => void
}

export function DiscoverDialog({ open, onClose, onCloned }: Props) {
  const [items, setItems] = useState<PublicPrompt[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [search, setSearch] = useState("")
  const [page, setPage] = useState(1)
  const [cloningId, setCloningId] = useState<number | null>(null)
  const [clonedIds, setClonedIds] = useState<Set<number>>(new Set())

  useEffect(() => {
    if (!open) return
    let cancelled = false
    setLoading(true)
    setError(null)
    promptsApi
      .listPublic({ search: search.trim() || undefined, page })
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
  }, [open, search, page])

  useEffect(() => {
    if (open) {
      setClonedIds(new Set())
      setPage(1)
    }
  }, [open])

  async function clone(p: PublicPrompt) {
    setCloningId(p.id)
    try {
      await promptsApi.clonePublic(p.id)
      setClonedIds((s) => new Set(s).add(p.id))
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
      className="fixed inset-0 z-50 grid place-items-center bg-black/50 p-4"
      onClick={onClose}
    >
      <div
        className="flex w-full max-w-3xl flex-col gap-3 rounded-lg border border-border bg-background p-6 shadow-lg"
        onClick={(e) => e.stopPropagation()}
        style={{ maxHeight: "calc(100svh - 2rem)" }}
      >
        <div>
          <h2 className="text-lg font-semibold">发现公开提示词</h2>
          <p className="text-sm text-muted-foreground">
            点击「克隆」会把提示词完整复制到你自己的库。
          </p>
        </div>

        <div className="flex items-center gap-2">
          <div className="relative flex-1">
            <Search className="pointer-events-none absolute left-2 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              className="pl-8"
              placeholder="按名称或内容搜索…"
              value={search}
              onChange={(e) => {
                setSearch(e.target.value)
                setPage(1)
              }}
            />
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
              {search ? "没有匹配结果。" : "还没有人公开提示词。"}
            </p>
          )}
          <ul className="flex flex-col gap-2">
            {items.map((p) => (
              <li
                key={p.id}
                className="flex items-start gap-3 rounded-md border border-border bg-background p-3"
              >
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="truncate font-medium">{p.name}</span>
                    <span className="text-xs text-muted-foreground">
                      by @{p.author_username}
                    </span>
                  </div>
                  <p className="mt-1 line-clamp-3 whitespace-pre-wrap text-xs text-muted-foreground">
                    {p.content || <em>（空内容）</em>}
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
