import { useEffect, useState } from "react"
import { Pencil, Plus, RefreshCw, Trash2 } from "lucide-react"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
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
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import {
  channelsAdminApi,
  type Channel,
  type ChannelInput,
  type ChannelKind,
  type ChannelPatch,
  type ChannelProtocol,
} from "@/lib/channels"

const PROTOCOLS: ChannelProtocol[] = ["openai", "claude", "gemini"]
const KINDS: ChannelKind[] = ["chat", "image", "video"]
const KIND_LABELS: Record<ChannelKind, string> = {
  chat: "对话",
  image: "生图",
  video: "视频",
}

type DialogMode =
  | { kind: "create" }
  | { kind: "edit"; channel: Channel }
  | null

export function ChannelsPanel() {
  const [rows, setRows] = useState<Channel[]>([])
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [query, setQuery] = useState("")
  const [dialog, setDialog] = useState<DialogMode>(null)

  async function load() {
    setLoading(true)
    setError(null)
    try {
      setRows(await channelsAdminApi.listChannels())
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setLoading(false)
    }
  }
  useEffect(() => {
    void load()
  }, [])

  const q = query.trim().toLowerCase()
  const filtered = q
    ? rows.filter(
        (r) =>
          r.name.toLowerCase().includes(q) ||
          r.base_url.toLowerCase().includes(q) ||
          r.protocol.includes(q) ||
          r.kind.includes(q)
      )
    : rows

  async function onDelete(c: Channel) {
    if (!confirm(`确认删除渠道「${c.name}」？`)) return
    try {
      await channelsAdminApi.deleteChannel(c.id)
      await load()
    } catch (e) {
      alert(e instanceof Error ? e.message : String(e))
    }
  }

  async function onToggle(c: Channel) {
    try {
      await channelsAdminApi.patchChannel(c.id, { enabled: !c.enabled })
      await load()
    } catch (e) {
      alert(e instanceof Error ? e.message : String(e))
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <p className="text-sm text-muted-foreground">
        多上游渠道：同一 kind 下按 priority 升序作为 fallback 路由。优先级数字越小越先尝试。
      </p>

      <div className="flex items-center gap-2">
        <Input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="搜索名称 / base_url / 协议…"
          className="max-w-xs"
        />
        <Button variant="outline" size="sm" onClick={() => void load()}>
          <RefreshCw /> 刷新
        </Button>
        <Button size="sm" onClick={() => setDialog({ kind: "create" })}>
          <Plus /> 新建渠道
        </Button>
        <span className="ml-auto text-xs text-muted-foreground">
          共 {rows.length} 条
        </span>
      </div>

      {error && (
        <div className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {error}
        </div>
      )}

      <div className="rounded-lg border border-border">
        {/* 表头/单元格的间距在父级统一设置，省得每个 Head/Cell 都写一遍 */}
        <Table className="min-w-[48rem]">
          <TableHeader className="bg-muted/40 text-xs uppercase [&_th]:h-9 [&_th]:px-3 [&_th]:text-muted-foreground">
            <TableRow>
              <TableHead>ID</TableHead>
              <TableHead>名称</TableHead>
              <TableHead>协议</TableHead>
              <TableHead>类型</TableHead>
              <TableHead>Base URL</TableHead>
              <TableHead>API Key</TableHead>
              <TableHead>优先级</TableHead>
              <TableHead>启用</TableHead>
              <TableHead className="text-right">操作</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody className="[&_td]:px-3 [&_td]:py-2">
            {loading && (
              <TableRow>
                <TableCell colSpan={9} className="py-6 text-center text-muted-foreground">
                  加载中…
                </TableCell>
              </TableRow>
            )}
            {!loading && filtered.length === 0 && (
              <TableRow>
                <TableCell colSpan={9} className="py-6 text-center text-muted-foreground">
                  暂无渠道。点击「新建渠道」添加第一个上游。
                </TableCell>
              </TableRow>
            )}
            {filtered.map((c) => (
              <TableRow key={c.id}>
                <TableCell className="font-mono text-xs text-muted-foreground">
                  #{c.id}
                </TableCell>
                <TableCell className="font-medium">{c.name}</TableCell>
                <TableCell>
                  <span className="rounded bg-muted px-1.5 py-0.5 font-mono text-xs">
                    {c.protocol}
                  </span>
                </TableCell>
                <TableCell>
                  <span className="rounded bg-muted px-1.5 py-0.5 font-mono text-xs">
                    {c.kind}
                  </span>
                </TableCell>
                <TableCell className="max-w-[18rem] truncate font-mono text-xs text-muted-foreground">
                  {c.base_url}
                </TableCell>
                <TableCell className="font-mono text-xs text-muted-foreground">
                  {c.api_key}
                </TableCell>
                <TableCell className="tabular-nums">{c.priority}</TableCell>
                <TableCell>
                  <button
                    onClick={() => void onToggle(c)}
                    className={
                      "rounded px-2 py-0.5 text-xs " +
                      (c.enabled
                        ? "bg-emerald-500/20 text-emerald-600"
                        : "bg-muted text-muted-foreground")
                    }
                  >
                    {c.enabled ? "启用" : "禁用"}
                  </button>
                </TableCell>
                <TableCell className="text-right">
                  <div className="inline-flex items-center gap-1">
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => setDialog({ kind: "edit", channel: c })}
                    >
                      <Pencil />
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => void onDelete(c)}
                    >
                      <Trash2 />
                    </Button>
                  </div>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>

      {dialog && (
        <ChannelDialog
          mode={dialog}
          onClose={() => setDialog(null)}
          onSaved={async () => {
            setDialog(null)
            await load()
          }}
        />
      )}
    </div>
  )
}

function ChannelDialog({
  mode,
  onClose,
  onSaved,
}: {
  mode: { kind: "create" } | { kind: "edit"; channel: Channel }
  onClose: () => void
  onSaved: () => void | Promise<void>
}) {
  const initial: ChannelInput =
    mode.kind === "edit"
      ? {
          name: mode.channel.name,
          protocol: mode.channel.protocol,
          kind: mode.channel.kind,
          base_url: mode.channel.base_url,
          api_key: "", // never prefill (server returns redacted)
          enabled: mode.channel.enabled,
          priority: mode.channel.priority,
        }
      : {
          name: "",
          protocol: "openai",
          kind: "chat",
          base_url: "",
          api_key: "",
          enabled: true,
          priority: 100,
        }
  const [form, setForm] = useState<ChannelInput>(initial)
  const [saving, setSaving] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  async function submit() {
    setSaving(true)
    setErr(null)
    try {
      if (mode.kind === "create") {
        await channelsAdminApi.createChannel(form)
      } else {
        const patch: ChannelPatch = {
          name: form.name,
          protocol: form.protocol,
          kind: form.kind,
          base_url: form.base_url,
          enabled: form.enabled,
          priority: form.priority,
        }
        if (form.api_key.trim()) patch.api_key = form.api_key
        await channelsAdminApi.patchChannel(mode.channel.id, patch)
      }
      await onSaved()
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    } finally {
      setSaving(false)
    }
  }

  // 父级用 {dialog && <ChannelDialog/>} 控制挂载，所以这里常开，关闭走 onClose
  return (
    <Dialog open onOpenChange={(next) => !next && onClose()}>
      <DialogContent
        aria-describedby={undefined}
        className="block rounded-xl bg-card p-5"
      >
        <DialogHeader className="mb-3">
          <DialogTitle className="text-base">
            {mode.kind === "create" ? "新建渠道" : `编辑渠道 #${mode.channel.id}`}
          </DialogTitle>
        </DialogHeader>
        <div className="grid grid-cols-2 gap-3">
          <div className="col-span-2">
            <Label>名称</Label>
            <Input
              value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
              placeholder="e.g. OpenAI 主线 / Anthropic 备线"
            />
          </div>
          <div>
            <Label>协议</Label>
            <Select
              value={form.protocol}
              disabled={form.kind === "video"}
              onValueChange={(v) =>
                setForm({ ...form, protocol: v as ChannelProtocol })
              }
            >
              <SelectTrigger className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {PROTOCOLS.map((p) => (
                  <SelectItem key={p} value={p}>
                    {p}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {form.kind === "video" && (
              <p className="mt-1 text-xs text-muted-foreground">
                视频渠道仅支持 OpenAI 兼容协议。
              </p>
            )}
          </div>
          <div>
            <Label>类型</Label>
            <Select
              value={form.kind}
              onValueChange={(v) => {
                const kind = v as ChannelKind
                setForm({
                  ...form,
                  kind,
                  // 视频渠道目前只接 OpenAI 兼容协议，后端也会校验兜底。
                  protocol: kind === "video" ? "openai" : form.protocol,
                })
              }}
            >
              <SelectTrigger className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {KINDS.map((k) => (
                  <SelectItem key={k} value={k}>
                    {KIND_LABELS[k]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="col-span-2">
            <Label>Base URL</Label>
            <Input
              value={form.base_url}
              onChange={(e) => setForm({ ...form, base_url: e.target.value })}
              placeholder="https://api.openai.com/v1"
            />
          </div>
          <div className="col-span-2">
            <Label>
              API Key
              {mode.kind === "edit" && (
                <span className="ml-2 text-xs font-normal text-muted-foreground">
                  （留空保持不变）
                </span>
              )}
            </Label>
            <Input
              type="password"
              value={form.api_key}
              onChange={(e) => setForm({ ...form, api_key: e.target.value })}
              placeholder="sk-..."
            />
          </div>
          <div>
            <Label>优先级</Label>
            <Input
              type="number"
              value={form.priority ?? 100}
              onChange={(e) =>
                setForm({ ...form, priority: Number(e.target.value) || 0 })
              }
            />
          </div>
          <div className="flex items-end">
            <label className="inline-flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={form.enabled ?? true}
                onChange={(e) => setForm({ ...form, enabled: e.target.checked })}
              />
              启用
            </label>
          </div>
        </div>
        {err && (
          <div className="mt-3 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
            {err}
          </div>
        )}
        <DialogFooter className="mt-4 flex-row justify-end">
          <Button variant="outline" onClick={onClose} disabled={saving}>
            取消
          </Button>
          <Button onClick={() => void submit()} disabled={saving}>
            {saving ? "保存中…" : "保存"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
