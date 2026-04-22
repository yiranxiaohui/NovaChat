import { useEffect, useState } from "react"
import { Button } from "@/components/ui/button"
import { Textarea } from "@/components/ui/textarea"

type Props = {
  open: boolean
  value: string
  onClose: () => void
  onSave: (next: string) => Promise<void> | void
}

export function SystemPromptDialog({ open, value, onClose, onSave }: Props) {
  const [draft, setDraft] = useState(value)
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    if (open) setDraft(value)
  }, [open, value])

  const dirty = draft !== value

  async function save() {
    setSaving(true)
    try {
      await onSave(draft)
      onClose()
    } finally {
      setSaving(false)
    }
  }

  if (!open) return null

  return (
    <div
      className="fixed inset-0 z-50 grid place-items-center bg-black/50 p-4"
      onClick={onClose}
    >
      <div
        className="flex w-full max-w-2xl flex-col gap-3 rounded-lg border border-border bg-background p-6 shadow-lg"
        onClick={(e) => e.stopPropagation()}
        style={{ maxHeight: "calc(100svh - 2rem)" }}
      >
        <div>
          <h2 className="text-lg font-semibold">系统提示词</h2>
          <p className="text-sm text-muted-foreground">
            仅对本会话生效。留空则不发送 system 消息。
          </p>
        </div>
        <Textarea
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          rows={10}
          className="resize-y font-mono text-xs"
          placeholder="You are a helpful assistant…"
          autoFocus
        />
        <div className="flex items-center justify-end gap-2">
          <Button
            size="sm"
            variant="ghost"
            onClick={() => setDraft(value)}
            disabled={!dirty || saving}
          >
            还原
          </Button>
          <Button size="sm" variant="outline" onClick={onClose} disabled={saving}>
            取消
          </Button>
          <Button size="sm" onClick={save} disabled={!dirty || saving}>
            {saving ? "保存中…" : "保存"}
          </Button>
        </div>
      </div>
    </div>
  )
}
