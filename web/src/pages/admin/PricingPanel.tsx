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
const KIND_LABELS: Record<ChannelKind, string> = {
  chat: "对话",
  image: "图片",
  video: "视频",
}
const PROTOCOL_LABELS: Record<ChannelProtocol, string> = {
  openai: "OpenAI",
  claude: "Claude",
  gemini: "Gemini",
}

function parseAllowedSecondsText(text: string): number[] | null {
  if (!text.trim()) return []
  const nums: number[] = []
  for (const part of text.split(",").map((value) => value.trim()).filter(Boolean)) {
    const seconds = Number(part)
    if (!Number.isInteger(seconds) || seconds <= 0) return null
    nums.push(seconds)
  }
  return nums
}

function displaySize(size: string): string {
  return size.replace("x", "×")
}

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
          placeholder="搜索模型名 / 显示名 / 功能…"
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
              <TableHead>功能</TableHead>
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

  // Probe channel catalogs for model selection and binding refresh.
  useEffect(() => {
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

  // A model's function is selected below; channel discovery is function-agnostic.
  const suggestions = allModels
  const modelQuery = form.model.trim().toLowerCase()
  const filteredSuggestions = suggestions
    .filter(
      (m) =>
        !modelQuery ||
        m.model.toLowerCase().includes(modelQuery) ||
        m.channels.some((c) => c.name.toLowerCase().includes(modelQuery))
    )
    .slice(0, 80)
  const currentMatch = suggestions.find((m) => m.model === form.model)
  const compatibleChannels =
    currentMatch?.channels.filter((c) => c.protocol === form.protocol) ?? []

  const isVideo = form.kind === "video"
  const sizeRules = form.size_rules ?? []

  function updateSizeRule(idx: number, patch: Partial<VideoSizeRule>) {
    setForm({
      ...form,
      size_rules: sizeRules.map((r, i) => (i === idx ? { ...r, ...patch } : r)),
    })
  }

  const allowedSeconds = parseAllowedSecondsText(form.allowedSecondsText)
  const previewSeconds = allowedSeconds?.[0]
  const previewRule = sizeRules.find(
    (rule) => SIZE_RE.test(rule.size.trim()) && rule.multiplier > 0
  )
  const previewCost =
    previewSeconds && previewRule
      ? Math.round(
          (((form.base_credits ?? 0) +
            (form.per_second ?? 0) * previewSeconds) *
            previewRule.multiplier) /
            100
        )
      : null

  async function submit() {
    setErr(null)
    if (currentMatch && compatibleChannels.length === 0) {
      setErr(`该模型没有 ${form.protocol} 协议的可用渠道`)
      return
    }
    let allowedSeconds: number[] | null = null
    if (isVideo) {
      allowedSeconds = parseAllowedSecondsText(form.allowedSecondsText)
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
        channel_ids: currentMatch
          ? compatibleChannels.map((c) => c.id)
          : undefined,
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
        className="flex max-h-[min(90vh,46rem)] flex-col gap-0 overflow-hidden rounded-2xl bg-card p-0 sm:max-w-lg"
      >
        <DialogHeader className="border-b border-border/70 px-5 py-4 pr-12">
          <DialogTitle className="text-base leading-6">
            {mode.kind === "create" ? "新建模型" : "编辑模型"}
          </DialogTitle>
          {mode.kind === "edit" && (
            <div className="flex flex-wrap items-center gap-2 pt-0.5 text-xs">
              <span className="max-w-full truncate font-mono font-medium text-foreground">
                {form.model}
              </span>
              <span className="rounded-full bg-primary/10 px-2 py-0.5 font-medium text-primary">
                {KIND_LABELS[form.kind]}
              </span>
              <span className="rounded-full bg-muted px-2 py-0.5 text-muted-foreground">
                {PROTOCOL_LABELS[form.protocol]}
              </span>
            </div>
          )}
        </DialogHeader>

        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
          <div className="space-y-5">
            {mode.kind === "create" && (
              <section className="space-y-3">
                <div>
                  <Label>模型 ID</Label>
                  <p className="mt-0.5 text-xs text-muted-foreground">
                    从渠道探测结果中选择，也可以输入自定义 ID。
                  </p>
                </div>
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
                            {m.channels
                              .map((c) => `${c.name} (${c.protocol})`)
                              .join("、")}
                          </span>
                        </button>
                      ))}
                    </div>
                  )}
                </div>
                <p className="mt-1 text-xs text-muted-foreground">
                  {currentMatch
                    ? compatibleChannels.length > 0
                      ? `将绑定渠道：${compatibleChannels.map((c) => c.name).join("、")}`
                      : `该模型没有 ${form.protocol} 协议的可用渠道`
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
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <Label>功能</Label>
                    <Select
                      value={form.kind}
                      onValueChange={(value) =>
                        setForm({
                          ...form,
                          kind: value as ChannelKind,
                          ...(value === "video"
                            ? { protocol: "openai" as ChannelProtocol }
                            : {}),
                        })
                      }
                    >
                      <SelectTrigger className="w-full">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {KINDS.map((kind) => (
                          <SelectItem key={kind} value={kind}>
                            {KIND_LABELS[kind]}
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
                      onValueChange={(value) =>
                        setForm({
                          ...form,
                          protocol: value as ChannelProtocol,
                        })
                      }
                    >
                      <SelectTrigger className="w-full">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {PROTOCOLS.map((protocol) => (
                          <SelectItem key={protocol} value={protocol}>
                            {PROTOCOL_LABELS[protocol]}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                </div>
              </section>
            )}

            <section className="space-y-1.5">
              <Label>显示名称</Label>
              <Input
                value={form.display_name ?? ""}
                onChange={(e) =>
                  setForm({ ...form, display_name: e.target.value })
                }
                placeholder={form.model || "例如：GPT-4o mini"}
              />
            </section>

            {!isVideo && (
              <section className="rounded-xl border border-border/80 bg-muted/20 p-3.5">
                <div className="mb-3">
                  <h3 className="text-sm font-medium">计费设置</h3>
                  <p className="mt-0.5 text-xs text-muted-foreground">
                    设置每次调用的积分，以及可选的上下文长度。
                  </p>
                </div>
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <Label>积分/次</Label>
                    <Input
                      type="number"
                      min={0}
                      value={form.cost_credits}
                      onChange={(e) =>
                        setForm({
                          ...form,
                          cost_credits: Number(e.target.value) || 0,
                        })
                      }
                    />
                  </div>
                  <div>
                    <Label>上下文</Label>
                    <Input
                      type="number"
                      min={0}
                      value={form.context_limit ?? ""}
                      onChange={(e) => {
                        const value = Math.floor(Number(e.target.value))
                        setForm({
                          ...form,
                          context_limit: value > 0 ? value : null,
                        })
                      }}
                      placeholder="自动推断"
                    />
                  </div>
                </div>
              </section>
            )}

            {isVideo && (
              <>
                <section className="rounded-xl border border-border/80 bg-muted/20 p-3.5">
                  <div className="mb-3">
                    <h3 className="text-sm font-medium">计费设置</h3>
                    <p className="mt-0.5 text-xs text-muted-foreground">
                      总价由基础积分、生成时长和分辨率共同决定。
                    </p>
                  </div>
                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <Label>基础积分</Label>
                      <Input
                        type="number"
                        min={0}
                        value={form.base_credits}
                        onChange={(e) =>
                          setForm({
                            ...form,
                            base_credits: Number(e.target.value) || 0,
                          })
                        }
                      />
                    </div>
                    <div>
                      <Label>每秒积分</Label>
                      <Input
                        type="number"
                        min={0}
                        value={form.per_second}
                        onChange={(e) =>
                          setForm({
                            ...form,
                            per_second: Number(e.target.value) || 0,
                          })
                        }
                      />
                    </div>
                  </div>
                  <div
                    aria-live="polite"
                    className="mt-3 flex items-center justify-between gap-3 rounded-lg border border-primary/10 bg-primary/5 px-3 py-2"
                  >
                    <span className="text-xs text-muted-foreground">价格示例</span>
                    {previewCost !== null && previewSeconds && previewRule ? (
                      <span className="text-sm font-semibold tabular-nums text-foreground">
                        {previewSeconds} 秒 · {displaySize(previewRule.size)} = {previewCost} 积分
                      </span>
                    ) : (
                      <span className="text-xs text-muted-foreground">
                        完善时长与分辨率后显示
                      </span>
                    )}
                  </div>
                </section>

                <section className="space-y-2">
                  <div>
                    <Label>支持时长</Label>
                    <p className="mt-0.5 text-xs text-muted-foreground">
                      多个秒数用逗号分隔。
                    </p>
                  </div>
                  <Input
                    value={form.allowedSecondsText}
                    onChange={(e) =>
                      setForm({ ...form, allowedSecondsText: e.target.value })
                    }
                    placeholder="4, 8, 12"
                  />
                  {allowedSeconds && allowedSeconds.length > 0 && (
                    <div className="flex flex-wrap gap-1.5">
                      {allowedSeconds.map((seconds, index) => (
                        <span
                          key={`${seconds}-${index}`}
                          className="rounded-full bg-muted px-2 py-0.5 text-xs text-muted-foreground"
                        >
                          {seconds} 秒
                        </span>
                      ))}
                    </div>
                  )}
                </section>

                <section className="space-y-3">
                  <div>
                    <Label>分辨率与价格</Label>
                    <p className="mt-0.5 text-xs text-muted-foreground">
                      100% 为原价，例如 150% 表示 1.5 倍价格。
                    </p>
                  </div>
                  <div className="grid grid-cols-[minmax(0,1fr)_7rem_2rem] items-center gap-2 px-1 text-[11px] text-muted-foreground">
                    <span>分辨率</span>
                    <span>价格倍率</span>
                    <span className="sr-only">操作</span>
                  </div>
                  <div className="flex flex-col gap-2">
                    {sizeRules.map((r, idx) => (
                      <div
                        key={idx}
                        className="grid grid-cols-[minmax(0,1fr)_7rem_2rem] items-center gap-2"
                      >
                        <Input
                          value={r.size}
                          onChange={(e) =>
                            updateSizeRule(idx, { size: e.target.value })
                          }
                          placeholder="1280x720"
                        />
                        <div className="relative">
                          <Input
                            type="number"
                            min={1}
                            step="1"
                            value={r.multiplier}
                            onChange={(e) =>
                              updateSizeRule(idx, {
                                multiplier: Number(e.target.value) || 0,
                              })
                            }
                            className="pr-7"
                          />
                          <span className="pointer-events-none absolute inset-y-0 right-2.5 flex items-center text-xs text-muted-foreground">
                            %
                          </span>
                        </div>
                        <Button
                          size="icon-sm"
                          variant="ghost"
                          type="button"
                          aria-label={`删除 ${r.size || "分辨率"}`}
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
                      <div className="rounded-lg border border-dashed border-border px-3 py-4 text-center text-xs text-muted-foreground">
                        还没有分辨率，添加一个即可开始计价。
                      </div>
                    )}
                    <Button
                      size="sm"
                      variant="outline"
                      type="button"
                      onClick={() =>
                        setForm({
                          ...form,
                          size_rules: [
                            ...sizeRules,
                            { size: "", multiplier: 100 },
                          ],
                        })
                      }
                      className="w-full border-dashed text-muted-foreground"
                    >
                      <Plus /> 添加分辨率
                    </Button>
                  </div>
                </section>
              </>
            )}

            {mode.kind === "edit" && (
              <details className="group rounded-xl border border-border/80">
                <summary className="flex cursor-pointer list-none items-center justify-between gap-3 px-3.5 py-3 text-sm font-medium marker:hidden">
                  <span>
                    高级设置
                    <span className="ml-2 text-xs font-normal text-muted-foreground">
                      模型 ID、功能与协议
                    </span>
                  </span>
                  <span
                    aria-hidden="true"
                    className="text-muted-foreground transition-transform group-open:rotate-180"
                  >
                    ⌄
                  </span>
                </summary>
                <div className="space-y-3 border-t border-border/70 px-3.5 py-3">
                  <div>
                    <Label>模型 ID</Label>
                    <Input value={form.model} disabled />
                  </div>
                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <Label>功能</Label>
                      <Select
                        value={form.kind}
                        onValueChange={(value) =>
                          setForm({
                            ...form,
                            kind: value as ChannelKind,
                            ...(value === "video"
                              ? { protocol: "openai" as ChannelProtocol }
                              : {}),
                          })
                        }
                      >
                        <SelectTrigger className="w-full">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {KINDS.map((kind) => (
                            <SelectItem key={kind} value={kind}>
                              {KIND_LABELS[kind]}
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
                        onValueChange={(value) =>
                          setForm({
                            ...form,
                            protocol: value as ChannelProtocol,
                          })
                        }
                      >
                        <SelectTrigger className="w-full">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {PROTOCOLS.map((protocol) => (
                            <SelectItem key={protocol} value={protocol}>
                              {PROTOCOL_LABELS[protocol]}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                  </div>
                  <p className="text-xs text-muted-foreground">
                    修改功能或协议后，保存时会重新匹配可用渠道。
                  </p>
                </div>
              </details>
            )}

            <label className="flex cursor-pointer items-center gap-3 rounded-xl border border-border/80 px-3.5 py-3 transition-colors hover:bg-muted/30 has-[:checked]:border-primary/25 has-[:checked]:bg-primary/[0.04]">
              <input
                type="checkbox"
                checked={form.enabled ?? true}
                onChange={(e) =>
                  setForm({ ...form, enabled: e.target.checked })
                }
                className="size-4 accent-primary"
              />
              <span className="min-w-0">
                <span className="block text-sm font-medium">启用此模型</span>
                <span className="block text-xs text-muted-foreground">
                  启用后模型会出现在对应功能的可用列表中。
                </span>
              </span>
            </label>

            {mode.kind === "edit" && currentMatch && compatibleChannels.length === 0 && (
              <div className="rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-700 dark:text-amber-300">
                当前没有支持 {PROTOCOL_LABELS[form.protocol]} 协议的可用渠道。
              </div>
            )}

            {err && (
              <div className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
                {err}
              </div>
            )}
          </div>
        </div>

        <DialogFooter className="flex-row justify-end border-t border-border/70 bg-card px-5 py-3.5">
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
