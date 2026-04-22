import { useEffect, useState } from "react"
import { BookMarked, ChevronDown, ChevronRight } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Textarea } from "@/components/ui/textarea"

type Props = {
  value: string
  onSave: (next: string) => Promise<void> | void
  onOpenLibrary: () => void
}

export function SystemPromptBar({ value, onSave, onOpenLibrary }: Props) {
  const [expanded, setExpanded] = useState(false)
  const [draft, setDraft] = useState(value)
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    setDraft(value)
  }, [value])

  const dirty = draft !== value
  const summary = value
    ? value.replace(/\s+/g, " ").slice(0, 60) + (value.length > 60 ? "…" : "")
    : "（未设置）"

  async function save() {
    setSaving(true)
    try {
      await onSave(draft)
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="border-b border-border bg-muted/30">
      <div className="mx-auto flex max-w-3xl items-center gap-2 px-4 py-1.5 text-xs">
        <button
          type="button"
          className="flex items-center gap-1 text-muted-foreground hover:text-foreground"
          onClick={() => setExpanded((e) => !e)}
        >
          {expanded ? (
            <ChevronDown className="size-3.5" />
          ) : (
            <ChevronRight className="size-3.5" />
          )}
          <span className="font-medium">系统提示词</span>
        </button>
        {!expanded && (
          <span className="truncate text-muted-foreground">{summary}</span>
        )}
        <div className="ml-auto">
          <button
            type="button"
            onClick={onOpenLibrary}
            className="flex items-center gap-1 text-muted-foreground hover:text-foreground"
          >
            <BookMarked className="size-3.5" /> 管理库
          </button>
        </div>
      </div>
      {expanded && (
        <div className="mx-auto flex max-w-3xl flex-col gap-2 px-4 pb-3">
          <Textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            rows={4}
            className="max-h-64 resize-y font-mono text-xs"
            placeholder="You are a helpful assistant… （对本会话生效）"
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
            <Button size="sm" onClick={save} disabled={!dirty || saving}>
              {saving ? "保存中…" : "保存"}
            </Button>
          </div>
        </div>
      )}
    </div>
  )
}
