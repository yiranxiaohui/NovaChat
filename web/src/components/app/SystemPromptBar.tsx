import { useEffect, useState } from "react"
import { Button } from "@/components/ui/button"
import { Textarea } from "@/components/ui/textarea"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"

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

  return (
    <Dialog open={open} onOpenChange={(next) => !next && onClose()}>
      <DialogContent
        className="gap-3 sm:max-w-2xl"
        style={{ maxHeight: "calc(100svh - 2rem)" }}
      >
        <DialogHeader>
          <DialogTitle>系统提示词</DialogTitle>
          <DialogDescription>
            仅对本会话生效。留空则不发送 system 消息。
          </DialogDescription>
        </DialogHeader>
        <Textarea
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          rows={10}
          className="resize-y font-mono text-xs"
          placeholder="You are a helpful assistant…"
          autoFocus
        />
        <DialogFooter className="flex-row items-center justify-end">
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
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
