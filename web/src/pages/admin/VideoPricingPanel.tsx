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
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { useConfirm } from "@/lib/confirm-context"
import {
  deleteVideoPricing,
  listVideoPricing,
  upsertVideoPricing,
  type VideoPricing,
  type VideoPricingInput,
  type VideoSizeRule,
} from "@/lib/channels"

const SIZE_RE = /^\d+x\d+$/

type DialogMode =
  | { kind: "create" }
  | { kind: "edit"; row: VideoPricing }
  | null

export function VideoPricingPanel() {
  const [rows, setRows] = useState<VideoPricing[]>([])
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [query, setQuery] = useState("")
  const [dialog, setDialog] = useState<DialogMode>(null)
  const { confirm } = useConfirm()

  async function load() {
    setLoading(true)
    setError(null)
    try {
      setRows(await listVideoPricing())
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
          (r.display_name ?? "").toLowerCase().includes(q)
      )
    : rows

  async function onDelete(r: VideoPricing) {
    const ok = await confirm({
      title: `确认删除「${r.model}」的视频计费规则？`,
      description: "删除后该模型将不再被白名单包含。",
      destructive: true,
    })
    if (!ok) return
    try {
      await deleteVideoPricing(r.model)
      await load()
    } catch (e) {
      alert(e instanceof Error ? e.message : String(e))
    }
  }

  async function onToggle(r: VideoPricing) {
    try {
      await upsertVideoPricing({
        model: r.model,
        display_name: r.display_name,
        enabled: !r.enabled,
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
        视频生成按模型独立计费：基础积分 + 每秒积分 × 时长，再按分辨率档位乘以倍率。未列出的模型会被拒绝（403）。
      </p>

      <div className="flex items-center gap-2">
        <Input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="搜索模型名 / 显示名…"
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
        <Table className="min-w-[48rem]">
          <TableHeader className="bg-muted/40 text-xs uppercase [&_th]:h-9 [&_th]:px-3 [&_th]:text-muted-foreground">
            <TableRow>
              <TableHead>模型</TableHead>
              <TableHead>显示名</TableHead>
              <TableHead className="text-right">基础积分</TableHead>
              <TableHead className="text-right">积分/秒</TableHead>
              <TableHead>允许时长</TableHead>
              <TableHead>分辨率档位</TableHead>
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
                <TableCell className="text-right tabular-nums">
                  {r.base_credits}
                </TableCell>
                <TableCell className="text-right tabular-nums">
                  {r.per_second}
                </TableCell>
                <TableCell className="text-xs text-muted-foreground">
                  {r.allowed_seconds.length > 0
                    ? r.allowed_seconds.join("、") + " 秒"
                    : "—"}
                </TableCell>
                <TableCell className="text-xs text-muted-foreground">
                  {r.size_rules.length} 档
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
        <VideoPricingDialog
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

type FormState = {
  model: string
  display_name: string
  enabled: boolean
  base_credits: number
  per_second: number
  allowedSecondsText: string
  size_rules: VideoSizeRule[]
}

function VideoPricingDialog({
  mode,
  onClose,
  onSaved,
}: {
  mode: { kind: "create" } | { kind: "edit"; row: VideoPricing }
  onClose: () => void
  onSaved: () => void | Promise<void>
}) {
  const initial: FormState =
    mode.kind === "edit"
      ? {
          model: mode.row.model,
          display_name: mode.row.display_name ?? "",
          enabled: mode.row.enabled,
          base_credits: mode.row.base_credits,
          per_second: mode.row.per_second,
          allowedSecondsText: mode.row.allowed_seconds.join(", "),
          size_rules: mode.row.size_rules,
        }
      : {
          model: "",
          display_name: "",
          enabled: true,
          base_credits: 0,
          per_second: 0,
          allowedSecondsText: "",
          size_rules: [],
        }
  const [form, setForm] = useState<FormState>(initial)
  const [saving, setSaving] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  function addSizeRule() {
    setForm({
      ...form,
      size_rules: [...form.size_rules, { size: "", multiplier: 1 }],
    })
  }

  function updateSizeRule(idx: number, patch: Partial<VideoSizeRule>) {
    setForm({
      ...form,
      size_rules: form.size_rules.map((r, i) =>
        i === idx ? { ...r, ...patch } : r
      ),
    })
  }

  function removeSizeRule(idx: number) {
    setForm({
      ...form,
      size_rules: form.size_rules.filter((_, i) => i !== idx),
    })
  }

  function parseAllowedSeconds(): number[] | null {
    const text = form.allowedSecondsText.trim()
    if (!text) return []
    const parts = text.split(",").map((s) => s.trim()).filter(Boolean)
    const nums: number[] = []
    for (const p of parts) {
      const n = Number(p)
      if (!Number.isInteger(n) || n <= 0) return null
      nums.push(n)
    }
    return nums
  }

  function validateSizeRules(): string | null {
    for (const r of form.size_rules) {
      if (!SIZE_RE.test(r.size.trim())) {
        return `分辨率格式不合法：「${r.size}」，应形如 1280x720`
      }
      if (!(r.multiplier > 0)) {
        return `分辨率「${r.size}」的倍率必须大于 0`
      }
    }
    return null
  }

  async function submit() {
    setErr(null)
    if (!form.model.trim()) {
      setErr("模型 ID 不能为空")
      return
    }
    const allowedSeconds = parseAllowedSeconds()
    if (allowedSeconds === null) {
      setErr("时长必须为正整数，多个用逗号分隔，如 4,8,12")
      return
    }
    if (allowedSeconds.length === 0) {
      setErr("允许时长不能为空")
      return
    }
    if (form.size_rules.length === 0) {
      setErr("至少需要一个分辨率档位")
      return
    }
    const sizeErr = validateSizeRules()
    if (sizeErr) {
      setErr(sizeErr)
      return
    }
    setSaving(true)
    try {
      const input: VideoPricingInput = {
        model: form.model.trim(),
        display_name: form.display_name.trim() || null,
        enabled: form.enabled,
        base_credits: form.base_credits,
        per_second: form.per_second,
        allowed_seconds: allowedSeconds,
        size_rules: form.size_rules.map((r) => ({
          size: r.size.trim(),
          multiplier: r.multiplier,
        })),
      }
      await upsertVideoPricing(input)
      await onSaved()
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    } finally {
      setSaving(false)
    }
  }

  return (
    <Dialog open onOpenChange={(next) => !next && onClose()}>
      <DialogContent
        aria-describedby={undefined}
        className="block max-h-[85vh] overflow-y-auto rounded-xl bg-card p-5 sm:max-w-lg"
      >
        <DialogHeader className="mb-3">
          <DialogTitle className="text-base">
            {mode.kind === "create" ? "新建视频计费规则" : `编辑 ${mode.row.model}`}
          </DialogTitle>
        </DialogHeader>
        <div className="grid grid-cols-2 gap-3">
          <div className="col-span-2">
            <Label>模型 ID</Label>
            {mode.kind === "create" ? (
              <Input
                value={form.model}
                onChange={(e) => setForm({ ...form, model: e.target.value })}
                placeholder="例如 sora-2"
                autoComplete="off"
              />
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
            <Label>显示名（可空）</Label>
            <Input
              value={form.display_name}
              onChange={(e) => setForm({ ...form, display_name: e.target.value })}
              placeholder="Sora 2"
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
              必填，如 4,8,12。
            </p>
          </div>
          <div className="col-span-2">
            <Label>分辨率倍率</Label>
            <div className="mt-1 flex flex-col gap-2">
              {form.size_rules.map((r, idx) => (
                <div key={idx} className="flex items-center gap-2">
                  <Input
                    value={r.size}
                    onChange={(e) =>
                      updateSizeRule(idx, { size: e.target.value })
                    }
                    placeholder="1280x720"
                    className="flex-1"
                  />
                  <Input
                    type="number"
                    min={0}
                    step="0.1"
                    value={r.multiplier}
                    onChange={(e) =>
                      updateSizeRule(idx, {
                        multiplier: Number(e.target.value) || 0,
                      })
                    }
                    placeholder="倍率"
                    className="w-24"
                  />
                  <Button
                    size="sm"
                    variant="ghost"
                    type="button"
                    onClick={() => removeSizeRule(idx)}
                  >
                    <Trash2 />
                  </Button>
                </div>
              ))}
              {form.size_rules.length === 0 && (
                <p className="text-xs text-muted-foreground">
                  至少添加一个分辨率档位。
                </p>
              )}
              <Button
                size="sm"
                variant="outline"
                type="button"
                onClick={addSizeRule}
                className="self-start"
              >
                <Plus /> 添加档位
              </Button>
            </div>
          </div>
          <div className="col-span-2">
            <label className="inline-flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={form.enabled}
                onChange={(e) => setForm({ ...form, enabled: e.target.checked })}
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
