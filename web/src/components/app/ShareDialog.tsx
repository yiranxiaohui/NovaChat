import { useEffect, useState } from "react"
import { toast } from "sonner"
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
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { useConfirm } from "@/lib/confirm-context"
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
  const { confirm } = useConfirm()
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

  // open 交给 Dialog 管；conversation 为空时整个组件不渲染，内部可放心解引用
  if (!conversation) return null

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
    const ok = await confirm({
      title: "撤销这个分享链接？",
      description: "撤销后此链接立即失效，无法恢复。",
      confirmText: "撤销",
      destructive: true,
    })
    if (!ok) return
    try {
      await sharingApi.revoke(token)
      setShares((s) => s.filter((r) => r.token !== token))
      toast.success("分享链接已撤销")
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
      toast.success(`已导出 ${format === "markdown" ? "Markdown" : "JSON"}`)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setExporting(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={(next) => !next && onClose()}>
      <DialogContent className="nc-scroll flex max-h-[90vh] flex-col gap-4 overflow-y-auto p-4 sm:p-6">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Share2 className="size-5" /> 分享与导出
          </DialogTitle>
          <DialogDescription className="text-xs">
            分享生成只读快照——快照创建后即冻结，之后修改 / 删除原对话都不影响。
          </DialogDescription>
        </DialogHeader>

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
            <Select value={expiry} onValueChange={(v) => setExpiry(v as Expiry)}>
              <SelectTrigger id="exp" size="sm" className="text-xs">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {(Object.keys(EXPIRY_LABEL) as Expiry[]).map((k) => (
                  <SelectItem key={k} value={k} className="text-xs">
                    {EXPIRY_LABEL[k]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
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

        <DialogFooter className="border-t border-border pt-3">
          <Button variant="outline" size="sm" onClick={onClose}>
            关闭
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
