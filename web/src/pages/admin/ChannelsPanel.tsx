import { useEffect, useState } from "react"
import { Pencil, Plus, RefreshCw, Trash2 } from "lucide-react"
import { Button } from "@/components/ui/button"
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
const KINDS: ChannelKind[] = ["chat", "image"]

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

      <div className="overflow-x-auto rounded-lg border border-border">
        <table className="w-full min-w-[48rem] text-sm">
          <thead className="bg-muted/40 text-xs uppercase text-muted-foreground">
            <tr>
              <th className="px-3 py-2 text-left font-medium">ID</th>
              <th className="px-3 py-2 text-left font-medium">名称</th>
              <th className="px-3 py-2 text-left font-medium">协议</th>
              <th className="px-3 py-2 text-left font-medium">类型</th>
              <th className="px-3 py-2 text-left font-medium">Base URL</th>
              <th className="px-3 py-2 text-left font-medium">API Key</th>
              <th className="px-3 py-2 text-left font-medium">优先级</th>
              <th className="px-3 py-2 text-left font-medium">启用</th>
              <th className="px-3 py-2 text-right font-medium">操作</th>
            </tr>
          </thead>
          <tbody>
            {loading && (
              <tr>
                <td colSpan={9} className="px-3 py-6 text-center text-muted-foreground">
                  加载中…
                </td>
              </tr>
            )}
            {!loading && filtered.length === 0 && (
              <tr>
                <td colSpan={9} className="px-3 py-6 text-center text-muted-foreground">
                  暂无渠道。点击「新建渠道」添加第一个上游。
                </td>
              </tr>
            )}
            {filtered.map((c) => (
              <tr key={c.id} className="border-t border-border hover:bg-accent/30">
                <td className="px-3 py-2 font-mono text-xs text-muted-foreground">
                  #{c.id}
                </td>
                <td className="px-3 py-2 font-medium">{c.name}</td>
                <td className="px-3 py-2">
                  <span className="rounded bg-muted px-1.5 py-0.5 font-mono text-xs">
                    {c.protocol}
                  </span>
                </td>
                <td className="px-3 py-2">
                  <span className="rounded bg-muted px-1.5 py-0.5 font-mono text-xs">
                    {c.kind}
                  </span>
                </td>
                <td className="px-3 py-2 max-w-[18rem] truncate font-mono text-xs text-muted-foreground">
                  {c.base_url}
                </td>
                <td className="px-3 py-2 font-mono text-xs text-muted-foreground">
                  {c.api_key}
                </td>
                <td className="px-3 py-2 tabular-nums">{c.priority}</td>
                <td className="px-3 py-2">
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
                </td>
                <td className="px-3 py-2 text-right">
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
                </td>
              </tr>
            ))}
          </tbody>
        </table>
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

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-background/80 backdrop-blur-sm">
      <div className="w-full max-w-lg rounded-xl border border-border bg-card p-5 shadow-lg">
        <h3 className="mb-3 text-base font-semibold">
          {mode.kind === "create" ? "新建渠道" : `编辑渠道 #${mode.channel.id}`}
        </h3>
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
            <select
              className="h-9 w-full rounded-md border border-input bg-background px-2 text-sm"
              value={form.protocol}
              onChange={(e) =>
                setForm({ ...form, protocol: e.target.value as ChannelProtocol })
              }
            >
              {PROTOCOLS.map((p) => (
                <option key={p} value={p}>
                  {p}
                </option>
              ))}
            </select>
          </div>
          <div>
            <Label>类型</Label>
            <select
              className="h-9 w-full rounded-md border border-input bg-background px-2 text-sm"
              value={form.kind}
              onChange={(e) =>
                setForm({ ...form, kind: e.target.value as ChannelKind })
              }
            >
              {KINDS.map((k) => (
                <option key={k} value={k}>
                  {k}
                </option>
              ))}
            </select>
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
        <div className="mt-4 flex justify-end gap-2">
          <Button variant="outline" onClick={onClose} disabled={saving}>
            取消
          </Button>
          <Button onClick={() => void submit()} disabled={saving}>
            {saving ? "保存中…" : "保存"}
          </Button>
        </div>
      </div>
    </div>
  )
}
