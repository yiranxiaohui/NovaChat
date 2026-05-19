import { useEffect, useState } from "react"
import { Pencil, Plus, RefreshCw, Trash2 } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import {
  channelsAdminApi,
  type AllChannelModel,
  type ChannelKind,
  type ModelPrice,
  type PricingInput,
} from "@/lib/channels"

const KINDS: ChannelKind[] = ["chat", "image"]

type DialogMode =
  | { kind: "create" }
  | { kind: "edit"; row: ModelPrice }
  | null

export function PricingPanel() {
  const [rows, setRows] = useState<ModelPrice[]>([])
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [query, setQuery] = useState("")
  const [dialog, setDialog] = useState<DialogMode>(null)

  async function load() {
    setLoading(true)
    setError(null)
    try {
      setRows(await channelsAdminApi.listPricing())
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
          r.model.toLowerCase().includes(q) ||
          (r.display_name ?? "").toLowerCase().includes(q) ||
          r.kind.includes(q)
      )
    : rows

  async function onDelete(r: ModelPrice) {
    if (!confirm(`确认删除「${r.model}」的计费规则？删除后该模型将不再被白名单包含。`)) return
    try {
      await channelsAdminApi.deletePricing(r.model)
      await load()
    } catch (e) {
      alert(e instanceof Error ? e.message : String(e))
    }
  }

  async function onToggle(r: ModelPrice) {
    try {
      await channelsAdminApi.upsertPricing({
        model: r.model,
        kind: r.kind,
        cost_credits: r.cost_credits,
        display_name: r.display_name,
        enabled: !r.enabled,
      })
      await load()
    } catch (e) {
      alert(e instanceof Error ? e.message : String(e))
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <p className="text-sm text-muted-foreground">
        按模型独立的积分白名单：未列出的模型会被拒绝（403）。<code>cost_credits=0</code> 即免费白名单。修改 <code>model</code> 字段请先删除再新建。
      </p>

      <div className="flex items-center gap-2">
        <Input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="搜索模型名 / 显示名 / 类型…"
          className="max-w-xs"
        />
        <Button variant="outline" size="sm" onClick={() => void load()}>
          <RefreshCw /> 刷新
        </Button>
        <Button size="sm" onClick={() => setDialog({ kind: "create" })}>
          <Plus /> 新建模型
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
        <table className="w-full min-w-[40rem] text-sm">
          <thead className="bg-muted/40 text-xs uppercase text-muted-foreground">
            <tr>
              <th className="px-3 py-2 text-left font-medium">模型</th>
              <th className="px-3 py-2 text-left font-medium">显示名</th>
              <th className="px-3 py-2 text-left font-medium">类型</th>
              <th className="px-3 py-2 text-right font-medium">积分/次</th>
              <th className="px-3 py-2 text-left font-medium">启用</th>
              <th className="px-3 py-2 text-right font-medium">操作</th>
            </tr>
          </thead>
          <tbody>
            {loading && (
              <tr>
                <td colSpan={6} className="px-3 py-6 text-center text-muted-foreground">
                  加载中…
                </td>
              </tr>
            )}
            {!loading && filtered.length === 0 && (
              <tr>
                <td colSpan={6} className="px-3 py-6 text-center text-muted-foreground">
                  暂无计费规则。点击「新建模型」添加白名单条目。
                </td>
              </tr>
            )}
            {filtered.map((r) => (
              <tr key={r.id} className="border-t border-border hover:bg-accent/30">
                <td className="px-3 py-2 font-mono text-xs">{r.model}</td>
                <td className="px-3 py-2 text-muted-foreground">
                  {r.display_name ?? "—"}
                </td>
                <td className="px-3 py-2">
                  <span className="rounded bg-muted px-1.5 py-0.5 font-mono text-xs">
                    {r.kind}
                  </span>
                </td>
                <td className="px-3 py-2 text-right tabular-nums">
                  {r.cost_credits}
                </td>
                <td className="px-3 py-2">
                  <button
                    onClick={() => void onToggle(r)}
                    className={
                      "rounded px-2 py-0.5 text-xs " +
                      (r.enabled
                        ? "bg-emerald-500/20 text-emerald-600"
                        : "bg-muted text-muted-foreground")
                    }
                  >
                    {r.enabled ? "启用" : "禁用"}
                  </button>
                </td>
                <td className="px-3 py-2 text-right">
                  <div className="inline-flex items-center gap-1">
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => setDialog({ kind: "edit", row: r })}
                    >
                      <Pencil />
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => void onDelete(r)}
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
        <PricingDialog
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

function PricingDialog({
  mode,
  onClose,
  onSaved,
}: {
  mode: { kind: "create" } | { kind: "edit"; row: ModelPrice }
  onClose: () => void
  onSaved: () => void | Promise<void>
}) {
  const initial: PricingInput =
    mode.kind === "edit"
      ? {
          model: mode.row.model,
          kind: mode.row.kind,
          cost_credits: mode.row.cost_credits,
          display_name: mode.row.display_name,
          enabled: mode.row.enabled,
        }
      : {
          model: "",
          kind: "chat",
          cost_credits: 1,
          display_name: null,
          enabled: true,
        }
  const [form, setForm] = useState<PricingInput>(initial)
  const [saving, setSaving] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [allModels, setAllModels] = useState<AllChannelModel[]>([])
  const [probeErrors, setProbeErrors] = useState<
    { channel: string; error: string }[]
  >([])
  const [modelPickerOpen, setModelPickerOpen] = useState(false)

  // Load aggregated channel model list for the "new model" picker.
  useEffect(() => {
    if (mode.kind !== "create") return
    channelsAdminApi
      .listAllChannelModels()
      .then((res) => {
        setAllModels(res.models)
        setProbeErrors(res.errors)
      })
      .catch(() => {
        setAllModels([])
        setProbeErrors([])
      })
  }, [mode.kind])

  // Suggestions filtered by current kind and current input; selecting one fills the form.
  const suggestions = allModels.filter((m) => m.kind === form.kind)
  const modelQuery = form.model.trim().toLowerCase()
  const filteredSuggestions = suggestions
    .filter(
      (m) =>
        !modelQuery ||
        m.model.toLowerCase().includes(modelQuery) ||
        m.channels.some((c) => c.toLowerCase().includes(modelQuery))
    )
    .slice(0, 80)
  const currentMatch = suggestions.find((m) => m.model === form.model)

  async function submit() {
    setSaving(true)
    setErr(null)
    try {
      await channelsAdminApi.upsertPricing({
        ...form,
        display_name: form.display_name?.toString().trim() || null,
      })
      await onSaved()
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-background/80 backdrop-blur-sm">
      <div className="w-full max-w-md rounded-xl border border-border bg-card p-5 shadow-lg">
        <h3 className="mb-3 text-base font-semibold">
          {mode.kind === "create" ? "新建计费规则" : `编辑 ${mode.row.model}`}
        </h3>
        <div className="grid grid-cols-2 gap-3">
          <div className="col-span-2">
            <Label>模型 ID</Label>
            {mode.kind === "create" ? (
              <>
                <div className="relative">
                  <Input
                    value={form.model}
                    onFocus={() => setModelPickerOpen(true)}
                    onBlur={() => window.setTimeout(() => setModelPickerOpen(false), 120)}
                    onChange={(e) => {
                      setForm({ ...form, model: e.target.value })
                      setModelPickerOpen(true)
                    }}
                    onKeyDown={(e) => {
                      if (e.key === "Escape") setModelPickerOpen(false)
                    }}
                    placeholder="搜索上游模型，或输入自定义模型 ID"
                    autoComplete="off"
                  />
                  {modelPickerOpen && filteredSuggestions.length > 0 && (
                    <div className="absolute left-0 right-0 top-[calc(100%+0.35rem)] z-[60] max-h-72 overflow-y-auto rounded-lg border border-border bg-popover p-1 shadow-xl">
                      <div className="px-2 py-1.5 text-[11px] text-muted-foreground">
                        {modelQuery
                          ? `匹配 ${filteredSuggestions.length} / ${suggestions.length} 个候选`
                          : `实时探测到 ${suggestions.length} 个候选模型`}
                      </div>
                      {filteredSuggestions.map((m) => (
                        <button
                          key={m.model}
                          type="button"
                          className="flex w-full flex-col items-start gap-0.5 rounded-md px-2.5 py-2 text-left hover:bg-accent focus:bg-accent focus:outline-none"
                          onMouseDown={(e) => e.preventDefault()}
                          onClick={() => {
                            setForm({
                              ...form,
                              model: m.model,
                              display_name: form.display_name || m.model.toUpperCase(),
                            })
                            setModelPickerOpen(false)
                          }}
                        >
                          <span className="font-mono text-sm font-medium">{m.model}</span>
                          <span className="text-xs text-muted-foreground">
                            {m.channels.join("、")}
                          </span>
                        </button>
                      ))}
                    </div>
                  )}
                </div>
                <p className="mt-1 text-xs text-muted-foreground">
                  {currentMatch
                    ? `可用渠道：${currentMatch.channels.join("、")}`
                    : form.model.trim()
                    ? "⚠️ 未在实时候选中找到；仍可保存为自定义模型 ID，请确认上游渠道实际支持。"
                    : suggestions.length > 0
                    ? `候选来自所有启用渠道的实时 /models 探测（${suggestions.length} 个）`
                    : "暂无候选——请检查上游渠道是否可连通。"}
                </p>
                {probeErrors.length > 0 && (
                  <div className="mt-2 rounded border border-yellow-200 bg-yellow-50 px-2 py-1 text-xs text-yellow-800">
                    部分渠道探测失败：
                    {probeErrors.map((e) => e.channel).join("、")}
                    （不影响可用渠道）
                  </div>
                )}
              </>
            ) : (
              <>
                <Input value={form.model} disabled />
                <p className="mt-1 text-xs text-muted-foreground">
                  模型 ID 不可改；如需改名请先删除再新建。
                </p>
              </>
            )}
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
          <div>
            <Label>积分/次</Label>
            <Input
              type="number"
              min={0}
              value={form.cost_credits}
              onChange={(e) =>
                setForm({ ...form, cost_credits: Number(e.target.value) || 0 })
              }
            />
          </div>
          <div className="col-span-2">
            <Label>显示名（可空）</Label>
            <Input
              value={form.display_name ?? ""}
              onChange={(e) =>
                setForm({ ...form, display_name: e.target.value })
              }
              placeholder="GPT-4o mini"
            />
          </div>
          <div className="col-span-2">
            <label className="inline-flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={form.enabled ?? true}
                onChange={(e) =>
                  setForm({ ...form, enabled: e.target.checked })
                }
              />
              启用（白名单激活）
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
          <Button
            onClick={() => void submit()}
            disabled={saving || !form.model.trim()}
          >
            {saving ? "保存中…" : "保存"}
          </Button>
        </div>
      </div>
    </div>
  )
}
