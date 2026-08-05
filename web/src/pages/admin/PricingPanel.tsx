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
  type AllChannelModel,
  type ChannelKind,
  type ChannelProtocol,
  type ModelPrice,
  type PricingInput,
  type VideoSizeRule,
} from "@/lib/channels"

const KINDS: ChannelKind[] = ["chat", "image", "video"]
const PROTOCOLS: ChannelProtocol[] = ["openai", "claude", "gemini"]
const SIZE_RE = /^\d+x\d+$/

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
        protocol: r.protocol,
        context_limit: r.context_limit,
        base_credits: r.base_credits,
        per_second: r.per_second,
        allowed_seconds: r.allowed_seconds,
        size_rules: r.size_rules,
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

      <div className="rounded-lg border border-border">
        {/* 表头/单元格的间距在父级统一设置，省得每个 Head/Cell 都写一遍 */}
        <Table className="min-w-[40rem]">
          <TableHeader className="bg-muted/40 text-xs uppercase [&_th]:h-9 [&_th]:px-3 [&_th]:text-muted-foreground">
            <TableRow>
              <TableHead>模型</TableHead>
              <TableHead>显示名</TableHead>
              <TableHead>类型</TableHead>
              <TableHead>协议</TableHead>
              <TableHead className="text-right">积分/次</TableHead>
              <TableHead className="text-right">上下文</TableHead>
              <TableHead>启用</TableHead>
              <TableHead className="text-right">操作</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody className="[&_td]:px-3 [&_td]:py-2">
            {loading && (
              <TableRow>
                <TableCell colSpan={8} className="py-6 text-center text-muted-foreground">
                  加载中…
                </TableCell>
              </TableRow>
            )}
            {!loading && filtered.length === 0 && (
              <TableRow>
                <TableCell colSpan={8} className="py-6 text-center text-muted-foreground">
                  暂无计费规则。点击「新建模型」添加白名单条目。
                </TableCell>
              </TableRow>
            )}
            {filtered.map((r) => (
              <TableRow key={r.id}>
                <TableCell className="font-mono text-xs">{r.model}</TableCell>
                <TableCell className="text-muted-foreground">
                  {r.display_name ?? "—"}
                </TableCell>
                <TableCell>
                  <span className="rounded bg-muted px-1.5 py-0.5 font-mono text-xs">
                    {r.kind}
                  </span>
                </TableCell>
                <TableCell>
                  <span className="rounded bg-muted px-1.5 py-0.5 font-mono text-xs">
                    {r.protocol}
                  </span>
                </TableCell>
                <TableCell className="text-right tabular-nums">
                  {r.kind === "video"
                    ? `${r.base_credits}+${r.per_second}/秒`
                    : r.cost_credits}
                </TableCell>
                <TableCell className="text-right tabular-nums text-muted-foreground">
                  {r.context_limit != null
                    ? r.context_limit >= 1_000_000
                      ? `${(r.context_limit / 1_000_000).toFixed(r.context_limit % 1_000_000 === 0 ? 0 : 1)}M`
                      : r.context_limit >= 1000
                        ? `${(r.context_limit / 1000).toFixed(r.context_limit % 1000 === 0 ? 0 : 1)}K`
                        : String(r.context_limit)
                    : "自动"}
                </TableCell>
                <TableCell>
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
                </TableCell>
                <TableCell className="text-right">
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
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
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

type FormState = PricingInput & { allowedSecondsText: string }

function PricingDialog({
  mode,
  onClose,
  onSaved,
}: {
  mode: { kind: "create" } | { kind: "edit"; row: ModelPrice }
  onClose: () => void
  onSaved: () => void | Promise<void>
}) {
  const initial: FormState =
    mode.kind === "edit"
      ? {
          model: mode.row.model,
          kind: mode.row.kind,
          cost_credits: mode.row.cost_credits,
          display_name: mode.row.display_name,
          enabled: mode.row.enabled,
          protocol: mode.row.protocol,
          context_limit: mode.row.context_limit,
          base_credits: mode.row.base_credits,
          per_second: mode.row.per_second,
          allowedSecondsText: (mode.row.allowed_seconds ?? []).join(", "),
          size_rules: mode.row.size_rules ?? [],
        }
      : {
          model: "",
          kind: "chat",
          cost_credits: 1,
          display_name: null,
          enabled: true,
          protocol: "openai",
          context_limit: null,
          base_credits: 0,
          per_second: 0,
          allowedSecondsText: "",
          size_rules: [],
        }
  const [form, setForm] = useState<FormState>(initial)
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

  const isVideo = form.kind === "video"
  const sizeRules = form.size_rules ?? []

  function updateSizeRule(idx: number, patch: Partial<VideoSizeRule>) {
    setForm({
      ...form,
      size_rules: sizeRules.map((r, i) => (i === idx ? { ...r, ...patch } : r)),
    })
  }

  function parseAllowedSeconds(): number[] | null {
    const text = form.allowedSecondsText.trim()
    if (!text) return []
    const nums: number[] = []
    for (const p of text.split(",").map((s) => s.trim()).filter(Boolean)) {
      const n = Number(p)
      if (!Number.isInteger(n) || n <= 0) return null
      nums.push(n)
    }
    return nums
  }

  async function submit() {
    setErr(null)
    let allowedSeconds: number[] | null = null
    if (isVideo) {
      allowedSeconds = parseAllowedSeconds()
      if (allowedSeconds === null) {
        setErr("时长必须为正整数，多个用逗号分隔，如 4,8,12")
        return
      }
      if (allowedSeconds.length === 0) {
        setErr("允许时长不能为空")
        return
      }
      if (sizeRules.length === 0) {
        setErr("至少需要一个分辨率档位")
        return
      }
      for (const r of sizeRules) {
        if (!SIZE_RE.test(r.size.trim())) {
          setErr(`分辨率格式不合法：「${r.size}」，应形如 1280x720`)
          return
        }
        if (!(r.multiplier > 0) || !Number.isInteger(r.multiplier)) {
          setErr(`倍率必须为正整数（百分比，100=原价），分辨率「${r.size}」`)
          return
        }
      }
    }
    setSaving(true)
    try {
      const { allowedSecondsText: _text, ...input } = form
      void _text
      await channelsAdminApi.upsertPricing({
        ...input,
        display_name: form.display_name?.toString().trim() || null,
        allowed_seconds: isVideo ? allowedSeconds : null,
        size_rules: isVideo
          ? sizeRules.map((r) => ({ size: r.size.trim(), multiplier: r.multiplier }))
          : null,
      })
      await onSaved()
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    } finally {
      setSaving(false)
    }
  }

  // 父级用 {dialog && <PricingDialog/>} 控制挂载，所以这里常开，关闭走 onClose
  return (
    <Dialog open onOpenChange={(next) => !next && onClose()}>
      <DialogContent
        aria-describedby={undefined}
        className="block max-h-[85vh] overflow-y-auto rounded-xl bg-card p-5 sm:max-w-md"
      >
        <DialogHeader className="mb-3">
          <DialogTitle className="text-base">
            {mode.kind === "create" ? "新建计费规则" : `编辑 ${mode.row.model}`}
          </DialogTitle>
        </DialogHeader>
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
                              display_name: form.display_name || m.model,
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
            <Select
              value={form.kind}
              onValueChange={(v) =>
                setForm({
                  ...form,
                  kind: v as ChannelKind,
                  // 后端约束：video 仅支持 openai 协议
                  ...(v === "video" ? { protocol: "openai" as ChannelProtocol } : {}),
                })
              }
            >
              <SelectTrigger className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {KINDS.map((k) => (
                  <SelectItem key={k} value={k}>
                    {k}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
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
            <p className="mt-1 text-xs text-muted-foreground">
              自动路由到该协议的启用渠道，无需手动绑定。
            </p>
          </div>
          {!isVideo && (
            <>
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
              <div>
                <Label>上下文 (tokens)</Label>
                <Input
                  type="number"
                  min={0}
                  value={form.context_limit ?? ""}
                  onChange={(e) => {
                    const n = Math.floor(Number(e.target.value))
                    setForm({ ...form, context_limit: n > 0 ? n : null })
                  }}
                  placeholder="留空自动推断"
                />
              </div>
            </>
          )}
          {isVideo && (
            <>
              <div>
                <Label>基础积分</Label>
                <Input
                  type="number"
                  min={0}
                  value={form.base_credits}
                  onChange={(e) =>
                    setForm({ ...form, base_credits: Number(e.target.value) || 0 })
                  }
                />
              </div>
              <div>
                <Label>积分/秒</Label>
                <Input
                  type="number"
                  min={0}
                  value={form.per_second}
                  onChange={(e) =>
                    setForm({ ...form, per_second: Number(e.target.value) || 0 })
                  }
                />
              </div>
              <div className="col-span-2">
                <Label>允许时长（秒，逗号分隔）</Label>
                <Input
                  value={form.allowedSecondsText}
                  onChange={(e) =>
                    setForm({ ...form, allowedSecondsText: e.target.value })
                  }
                  placeholder="4, 8, 12"
                />
                <p className="mt-1 text-xs text-muted-foreground">
                  计费 = (基础积分 + 积分/秒 × 时长) × 分辨率倍率。
                </p>
              </div>
              <div className="col-span-2">
                <Label>分辨率倍率（%，100 = 原价）</Label>
                <div className="mt-1 flex flex-col gap-2">
                  {sizeRules.map((r, idx) => (
                    <div key={idx} className="flex items-center gap-2">
                      <Input
                        value={r.size}
                        onChange={(e) => updateSizeRule(idx, { size: e.target.value })}
                        placeholder="1280x720"
                        className="flex-1"
                      />
                      <Input
                        type="number"
                        min={0}
                        step="1"
                        value={r.multiplier}
                        onChange={(e) =>
                          updateSizeRule(idx, { multiplier: Number(e.target.value) || 0 })
                        }
                        placeholder="倍率(%)"
                        className="w-24"
                      />
                      <Button
                        size="sm"
                        variant="ghost"
                        type="button"
                        onClick={() =>
                          setForm({
                            ...form,
                            size_rules: sizeRules.filter((_, i) => i !== idx),
                          })
                        }
                      >
                        <Trash2 />
                      </Button>
                    </div>
                  ))}
                  {sizeRules.length === 0 && (
                    <p className="text-xs text-muted-foreground">
                      至少添加一个分辨率档位。
                    </p>
                  )}
                  <Button
                    size="sm"
                    variant="outline"
                    type="button"
                    onClick={() =>
                      setForm({
                        ...form,
                        size_rules: [...sizeRules, { size: "", multiplier: 100 }],
                      })
                    }
                    className="self-start"
                  >
                    <Plus /> 添加档位
                  </Button>
                </div>
              </div>
            </>
          )}
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
        <DialogFooter className="mt-4 flex-row justify-end">
          <Button variant="outline" onClick={onClose} disabled={saving}>
            取消
          </Button>
          <Button
            onClick={() => void submit()}
            disabled={saving || !form.model.trim()}
          >
            {saving ? "保存中…" : "保存"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
