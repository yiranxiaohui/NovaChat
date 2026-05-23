import { useEffect, useState } from "react"
import { Receipt, RefreshCw } from "lucide-react"
import { Button } from "@/components/ui/button"
import { creditsApi, type LedgerEntry } from "@/lib/credits"

type Props = {
  open: boolean
  onClose: () => void
}

const PAGE_SIZE = 50 // matches the backend default; if backend changes, "load more" still works

function formatTime(s: string): string {
  // Backend writes either "YYYY-MM-DD HH:MM:SS" (SQLite/MySQL) or ISO (Postgres).
  // Parse both, fall back to raw on error.
  const candidate = s.includes("T") ? s : s.replace(" ", "T")
  const withZ = candidate.endsWith("Z") ? candidate : `${candidate}Z`
  const d = new Date(withZ)
  if (Number.isNaN(d.getTime())) return s
  return d.toLocaleString()
}

export function CreditsLedgerDialog({ open, onClose }: Props) {
  const [entries, setEntries] = useState<LedgerEntry[]>([])
  const [page, setPage] = useState(1)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [hasMore, setHasMore] = useState(true)

  useEffect(() => {
    if (!open) return
    setEntries([])
    setError(null)
    setPage(1)
    setHasMore(true)
    void loadPage(1, true)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  async function loadPage(p: number, reset: boolean) {
    setLoading(true)
    setError(null)
    try {
      const rows = await creditsApi.ledger(p)
      setEntries((prev) => (reset ? rows : [...prev, ...rows]))
      // If the server returned fewer than a typical page, assume we hit the end.
      setHasMore(rows.length >= PAGE_SIZE)
      setPage(p)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setLoading(false)
    }
  }

  if (!open) return null

  return (
    <div
      className="fixed inset-0 z-50 grid place-items-center bg-black/50 p-4"
      onClick={onClose}
    >
      <div
        className="flex max-h-[80vh] w-full max-w-2xl flex-col gap-3 rounded-lg border border-border bg-background p-6 shadow-lg"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between">
          <div>
            <h2 className="flex items-center gap-2 text-lg font-semibold">
              <Receipt className="size-5" /> 积分明细
            </h2>
            <p className="text-xs text-muted-foreground">
              每次扣费 / 退款 / 充值 / 邀请奖励都会在这里记录
            </p>
          </div>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => void loadPage(1, true)}
            disabled={loading}
            title="刷新"
          >
            <RefreshCw className={"size-4 " + (loading ? "animate-spin" : "")} />
          </Button>
        </div>

        {error && (
          <div className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
            {error}
          </div>
        )}

        <div className="nc-scroll min-h-[200px] flex-1 overflow-y-auto rounded-md border border-border">
          {entries.length === 0 && !loading ? (
            <p className="px-3 py-10 text-center text-sm text-muted-foreground">
              {error ? "加载失败" : "还没有积分变动记录"}
            </p>
          ) : (
            <table className="w-full text-sm">
              <thead className="sticky top-0 bg-muted/50 text-xs text-muted-foreground">
                <tr>
                  <th className="px-3 py-2 text-left font-medium">时间</th>
                  <th className="px-3 py-2 text-right font-medium">变动</th>
                  <th className="px-3 py-2 text-left font-medium">原因</th>
                </tr>
              </thead>
              <tbody>
                {entries.map((e) => (
                  <tr key={e.id} className="border-t border-border">
                    <td className="whitespace-nowrap px-3 py-1.5 text-xs tabular-nums text-muted-foreground">
                      {formatTime(e.created_at)}
                    </td>
                    <td
                      className={
                        "whitespace-nowrap px-3 py-1.5 text-right tabular-nums font-medium " +
                        (e.delta > 0
                          ? "text-emerald-600 dark:text-emerald-400"
                          : e.delta < 0
                            ? "text-rose-600 dark:text-rose-400"
                            : "text-muted-foreground")
                      }
                    >
                      {e.delta > 0 ? "+" : ""}
                      {e.delta}
                    </td>
                    <td className="break-all px-3 py-1.5 font-mono text-xs">
                      {e.reason}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>

        <div className="flex items-center justify-between gap-2">
          <span className="text-xs text-muted-foreground">
            已加载 {entries.length} 条
          </span>
          <div className="flex gap-2">
            {hasMore && (
              <Button
                variant="outline"
                size="sm"
                onClick={() => void loadPage(page + 1, false)}
                disabled={loading}
              >
                {loading ? "加载中…" : "加载更多"}
              </Button>
            )}
            <Button variant="outline" size="sm" onClick={onClose}>
              关闭
            </Button>
          </div>
        </div>
      </div>
    </div>
  )
}
