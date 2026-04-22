import { useEffect, useState } from "react"
import {
  Compass,
  Globe,
  Lock,
  Pencil,
  Plus,
  Sparkles,
  Trash2,
} from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { skillsApi, type Skill } from "@/lib/skills"
import { cn } from "@/lib/utils"
import { SkillDiscoverDialog } from "./SkillDiscoverDialog"

type Props = {
  open: boolean
  conversationId: number | null
  attachedIds: number[]
  onClose: () => void
  onAttachedChange: (ids: number[]) => void
}

type EditorState = { mode: "create" } | { mode: "edit"; id: number } | null

export function SkillsDialog({
  open,
  conversationId,
  attachedIds,
  onClose,
  onAttachedChange,
}: Props) {
  const [items, setItems] = useState<Skill[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [editor, setEditor] = useState<EditorState>(null)
  const [name, setName] = useState("")
  const [description, setDescription] = useState("")
  const [instructions, setInstructions] = useState("")
  const [busyId, setBusyId] = useState<number | null>(null)
  const [discoverOpen, setDiscoverOpen] = useState(false)

  async function refresh() {
    setLoading(true)
    setError(null)
    try {
      const list = await skillsApi.list()
      setItems(list)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    if (!open) return
    let cancelled = false
    setLoading(true)
    setError(null)
    skillsApi
      .list()
      .then((list) => {
        if (!cancelled) setItems(list)
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
  }, [open])

  function openCreate() {
    setEditor({ mode: "create" })
    setName("")
    setDescription("")
    setInstructions("")
  }

  function openEdit(s: Skill) {
    setEditor({ mode: "edit", id: s.id })
    setName(s.name)
    setDescription(s.description)
    setInstructions(s.instructions)
  }

  function closeEditor() {
    setEditor(null)
  }

  async function save() {
    if (!editor) return
    const trimmedName = name.trim()
    const trimmedDesc = description.trim()
    if (!trimmedName) {
      setError("名称不能为空")
      return
    }
    if (!instructions.trim()) {
      setError("指令不能为空")
      return
    }
    try {
      if (editor.mode === "create") {
        const created = await skillsApi.create({
          name: trimmedName,
          description: trimmedDesc,
          instructions,
        })
        setItems((s) => [created, ...s])
      } else {
        await skillsApi.update(editor.id, {
          name: trimmedName,
          description: trimmedDesc,
          instructions,
        })
        setItems((s) =>
          s.map((x) =>
            x.id === editor.id
              ? {
                  ...x,
                  name: trimmedName,
                  description: trimmedDesc,
                  instructions,
                }
              : x
          )
        )
      }
      closeEditor()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  async function remove(s: Skill) {
    if (!window.confirm(`删除 skill "${s.name}"？所有会话的关联都会被移除。`)) return
    try {
      await skillsApi.remove(s.id)
      setItems((list) => list.filter((x) => x.id !== s.id))
      if (attachedIds.includes(s.id)) {
        onAttachedChange(attachedIds.filter((id) => id !== s.id))
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  async function togglePublic(s: Skill) {
    const next = !s.is_public
    try {
      await skillsApi.update(s.id, { is_public: next })
      setItems((list) =>
        list.map((x) => (x.id === s.id ? { ...x, is_public: next } : x))
      )
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  async function toggleAttach(s: Skill) {
    if (!conversationId) return
    const attached = attachedIds.includes(s.id)
    setBusyId(s.id)
    setError(null)
    try {
      if (attached) {
        await skillsApi.detach(conversationId, s.id)
        onAttachedChange(attachedIds.filter((id) => id !== s.id))
      } else {
        await skillsApi.attach(conversationId, s.id)
        onAttachedChange([...attachedIds, s.id])
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusyId(null)
    }
  }

  if (!open) return null

  return (
    <div
      className="fixed inset-0 z-50 grid place-items-center bg-black/50 p-4"
      onClick={onClose}
    >
      <div
        className="flex w-full max-w-3xl flex-col gap-3 rounded-lg border border-border bg-background p-6 shadow-lg"
        onClick={(e) => e.stopPropagation()}
        style={{ maxHeight: "calc(100svh - 2rem)" }}
      >
        <div className="flex items-start justify-between gap-2">
          <div>
            <h2 className="text-lg font-semibold">Skills</h2>
            <p className="text-sm text-muted-foreground">
              {conversationId
                ? "勾选的 skill 会拼到本会话系统提示词;模型按描述自主应用。"
                : "新建会话后可勾选挂载到会话。"}
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button
              size="sm"
              variant="outline"
              onClick={() => setDiscoverOpen(true)}
            >
              <Compass /> 发现
            </Button>
            <Button onClick={openCreate} size="sm">
              <Plus /> 新建
            </Button>
          </div>
        </div>

        {error && (
          <div className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
            {error}
          </div>
        )}

        {editor && (
          <div className="flex flex-col gap-3 rounded-md border border-border bg-muted/30 p-3">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="s-name">名称</Label>
              <Input
                id="s-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                maxLength={80}
                placeholder="pdf-extractor"
                autoFocus
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="s-desc">
                描述 <span className="text-muted-foreground">（模型据此判断何时应用）</span>
              </Label>
              <Input
                id="s-desc"
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                maxLength={500}
                placeholder="当用户需要从 PDF 中提取结构化信息时使用"
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="s-body">指令</Label>
              <Textarea
                id="s-body"
                value={instructions}
                onChange={(e) => setInstructions(e.target.value)}
                rows={8}
                className="max-h-80 min-h-[10rem] resize-y font-mono text-xs"
                placeholder="遵循以下步骤: 1) …"
              />
            </div>
            <div className="flex justify-end gap-2">
              <Button variant="ghost" size="sm" onClick={closeEditor}>
                取消
              </Button>
              <Button size="sm" onClick={save}>
                保存
              </Button>
            </div>
          </div>
        )}

        <div className="flex-1 overflow-y-auto">
          {loading && <p className="text-sm text-muted-foreground">加载中…</p>}
          {!loading && items.length === 0 && !editor && (
            <p className="text-sm text-muted-foreground">
              还没有 skill,点「新建」创建一个。
            </p>
          )}
          <ul className="flex flex-col gap-2">
            {items.map((s) => {
              const attached = attachedIds.includes(s.id)
              const canToggle = conversationId !== null
              return (
                <li
                  key={s.id}
                  className="flex items-start gap-3 rounded-md border border-border bg-background p-3"
                >
                  <label
                    className={cn(
                      "mt-0.5 flex cursor-pointer select-none items-center",
                      !canToggle && "cursor-not-allowed opacity-40"
                    )}
                    title={
                      canToggle
                        ? attached
                          ? "已挂载到本会话 — 点击取消"
                          : "点击挂载到本会话"
                        : "打开会话后可挂载"
                    }
                  >
                    <input
                      type="checkbox"
                      className="size-4 accent-primary"
                      checked={attached}
                      disabled={!canToggle || busyId === s.id}
                      onChange={() => void toggleAttach(s)}
                    />
                  </label>
                  <Sparkles className="mt-0.5 size-4 shrink-0 text-primary" />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="truncate font-medium">{s.name}</span>
                      {attached && (
                        <span className="rounded bg-primary/10 px-1.5 py-0.5 text-[10px] text-primary">
                          已挂载
                        </span>
                      )}
                      {s.is_public && (
                        <span
                          className="inline-flex items-center gap-0.5 rounded bg-emerald-500/10 px-1 py-0.5 text-[10px] text-emerald-600 dark:text-emerald-400"
                          title="公开"
                        >
                          <Globe className="size-3" /> 公开
                        </span>
                      )}
                    </div>
                    {s.description && (
                      <p className="mt-0.5 line-clamp-2 text-xs text-muted-foreground">
                        {s.description}
                      </p>
                    )}
                    <p className="mt-1 line-clamp-2 whitespace-pre-wrap text-xs text-muted-foreground/80">
                      {s.instructions}
                    </p>
                  </div>
                  <div className="flex flex-col gap-1">
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => togglePublic(s)}
                      title={s.is_public ? "改为私有" : "公开分享"}
                    >
                      {s.is_public ? (
                        <Lock className="size-3.5" />
                      ) : (
                        <Globe className="size-3.5" />
                      )}
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => openEdit(s)}
                      title="编辑"
                    >
                      <Pencil className="size-3.5" />
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => remove(s)}
                      title="删除"
                    >
                      <Trash2 className="size-3.5" />
                    </Button>
                  </div>
                </li>
              )
            })}
          </ul>
        </div>

        <div className="flex justify-end">
          <Button variant="outline" onClick={onClose}>
            关闭
          </Button>
        </div>
      </div>

      <SkillDiscoverDialog
        open={discoverOpen}
        onClose={() => setDiscoverOpen(false)}
        onCloned={() => void refresh()}
      />
    </div>
  )
}
