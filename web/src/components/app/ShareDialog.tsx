import { useEffect, useState } from "react"
import {
  Check,
  Copy,
  Download,
  ExternalLink,
  Plus,
  Share2,
  Trash2,
} from "lucide-react"
import { Button } from "@/components/ui/button"
import { conversationsApi, type Conversation } from "@/lib/conversations"
import { downloadConversation } from "@/lib/export-conversation"
import { sharingApi, type ShareListRow } from "@/lib/sharing"

type Props = {
  open: boolean
  conversation: Conversation | null
  onClose: () => void
}

type Expiry = "never" | "1" | "7" | "30"

const EXPIRY_LABEL: Record<Expiry, string> = {
  never: "永不过期",
  "1": "1 天后",
  "7": "7 天后",
  "30": "30 天后",
}

export function ShareDialog({ open, conversation, onClose }: Props) {
  const [shares, setShares] = useState<ShareListRow[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [expiry, setExpiry] = useState<Expiry>("never")
  const [creating, setCreating] = useState(false)
  const [copiedToken, setCopiedToken] = useState<string | null>(null)
  const [exporting, setExporting] = useState(false)

  useEffect(() => {
    if (!open || !conversation) return
    let cancelled = false
    setLoading(true)
    setError(null)
    sharingApi
      .listForConversation(conversation.id)
      .then((rows) => {
        if (!cancelled) setShares(rows)
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
  }, [open, conversation])

  if (!open || !conversation) return null

  async function createShare() {
    if (!conversation) return
    setCreating(true)
    setError(null)
    try {
      const days = expiry === "never" ? undefined : Number(expiry)
      const created = await sharingApi.create(conversation.id, {
        expiresInDays: days,
      })
      // Refetch to get full list (the create response is a subset).
      const rows = await sharingApi.listForConversation(conversation.id)
      setShares(rows)
      // Copy the new link to clipboard for the common case.
      const fullUrl = `${window.location.origin}${created.path}`
      try {
        await navigator.clipboard.writeText(fullUrl)
        setCopiedToken(created.token)
        window.setTimeout(() => setCopiedToken(null), 2000)
      } catch {
        /* clipboard blocked — user can still click 复制 manually */
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setCreating(false)
    }
  }

  async function revoke(token: string) {
    if (!window.confirm("撤销后此链接立即失效，无法恢复。继续？")) return
    try {
      await sharingApi.revoke(token)
      setShares((s) => s.filter((r) => r.token !== token))
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  async function copyLink(token: string) {
    const fullUrl = `${window.location.origin}/s/${token}`
    try {
      await navigator.clipboard.writeText(fullUrl)
      setCopiedToken(token)
      window.setTimeout(() => setCopiedToken(null), 2000)
    } catch (e) {
      setError("复制失败，浏览器拒绝了剪贴板访问")
      void e
    }
  }

  async function doExport(format: "markdown" | "json") {
    if (!conversation) return
    setExporting(true)
    setError(null)
    try {
      const messages = await conversationsApi.messages(conversation.id)
      downloadConversation({ conversation, messages }, format)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setExporting(false)
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 grid place-items-center bg-black/50 p-2 sm:p-4"
      onClick={onClose}
    >
      <div
        className="flex max-h-[90vh] w-full max-w-lg flex-col gap-4 overflow-y-auto rounded-lg border border-border bg-background p-4 shadow-lg sm:p-6"
        onClick={(e) => e.stopPropagation()}
      >
        <div>
          <h2 className="flex items-center gap-2 text-lg font-semibold">
            <Share2 className="size-5" /> 分享与导出
          </h2>
          <p className="text-xs text-muted-foreground">
            分享生成只读快照——快照创建后即冻结，之后修改 / 删除原对话都不影响。
          </p>
        </div>

        {error && (
          <div className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
            {error}
          </div>
        )}

        <section className="flex flex-col gap-2">
          <h3 className="text-sm font-semibold">当前分享</h3>
          {loading ? (
            <p className="text-xs text-muted-foreground">加载中…</p>
          ) : shares.length === 0 ? (
            <p className="text-xs text-muted-foreground">
              这个对话还没有分享链接。
            </p>
          ) : (
            <ul className="flex flex-col gap-2">
              {shares.map((s) => (
                <li
                  key={s.token}
                  className="flex flex-col gap-1.5 rounded-md border border-border bg-muted/30 p-2.5"
                >
                  <div className="flex items-start gap-2">
                    <code className="min-w-0 flex-1 truncate text-xs">
                      {window.location.origin}/s/{s.token}
                    </code>
                    <Button
                      size="xs"
                      variant="outline"
                      onClick={() => void copyLink(s.token)}
                      title="复制链接"
                    >
                      {copiedToken === s.token ? (
                        <>
                          <Check className="text-emerald-500" /> 已复制
                        </>
                      ) : (
                        <>
                          <Copy /> 复制
                        </>
                      )}
                    </Button>
                  </div>
                  <div className="flex items-center justify-between gap-2 text-[11px] text-muted-foreground">
                    <span>
                      浏览 {s.view_count} 次 ·{" "}
                      {s.expires_at ? `${s.expires_at.replace("T", " ")} 过期` : "永不过期"}
                    </span>
                    <div className="flex gap-1">
                      <Button
                        size="xs"
                        variant="ghost"
                        asChild
                        title="新窗口打开"
                      >
                        <a
                          href={`/s/${s.token}`}
                          target="_blank"
                          rel="noreferrer"
                        >
                          <ExternalLink />
                        </a>
                      </Button>
                      <Button
                        size="xs"
                        variant="ghost"
                        onClick={() => void revoke(s.token)}
                        title="撤销链接"
                        className="text-destructive hover:bg-destructive/10 hover:text-destructive"
                      >
                        <Trash2 />
                      </Button>
                    </div>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </section>

        <section className="flex flex-col gap-2 border-t border-border pt-3">
          <h3 className="text-sm font-semibold">新建分享</h3>
          <div className="flex flex-wrap items-center gap-2">
            <label className="text-xs text-muted-foreground" htmlFor="exp">
              有效期
            </label>
            <select
              id="exp"
              value={expiry}
              onChange={(e) => setExpiry(e.target.value as Expiry)}
              className="h-8 rounded-md border border-input bg-background px-2 text-xs"
            >
              {(Object.keys(EXPIRY_LABEL) as Expiry[]).map((k) => (
                <option key={k} value={k}>
                  {EXPIRY_LABEL[k]}
                </option>
              ))}
            </select>
            <Button
              size="sm"
              onClick={() => void createShare()}
              disabled={creating}
              className="gap-1.5"
            >
              <Plus />
              {creating ? "创建中…" : "创建分享链接"}
            </Button>
          </div>
        </section>

        <section className="flex flex-col gap-2 border-t border-border pt-3">
          <h3 className="text-sm font-semibold">导出到本地</h3>
          <p className="text-[11px] text-muted-foreground">
            离线保存对话。Markdown 适合人阅读；JSON 保留全部字段，方便导入到其他工具。
          </p>
          <div className="flex flex-wrap gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={() => void doExport("markdown")}
              disabled={exporting}
            >
              <Download /> Markdown
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={() => void doExport("json")}
              disabled={exporting}
            >
              <Download /> JSON
            </Button>
          </div>
        </section>

        <div className="flex justify-end gap-2 border-t border-border pt-3">
          <Button variant="outline" size="sm" onClick={onClose}>
            关闭
          </Button>
        </div>
      </div>
    </div>
  )
}
