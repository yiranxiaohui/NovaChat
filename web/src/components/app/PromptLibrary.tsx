import { useEffect, useRef, useState } from "react"
import {
  Compass,
  Download,
  Globe,
  Lock,
  Pencil,
  Plus,
  Star,
  Trash2,
  Upload,
} from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { promptsApi, type Prompt } from "@/lib/prompts"
import { cn } from "@/lib/utils"
import { DiscoverDialog } from "./DiscoverDialog"

type Props = {
  open: boolean
  onClose: () => void
  onApplyToCurrent?: (content: string) => void
}

type EditorState =
  | { mode: "create" }
  | { mode: "edit"; id: number }
  | null

export function PromptLibrary({ open, onClose, onApplyToCurrent }: Props) {
  const [items, setItems] = useState<Prompt[]>([])
  const [defaultId, setDefaultId] = useState<number | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [editor, setEditor] = useState<EditorState>(null)
  const [name, setName] = useState("")
  const [content, setContent] = useState("")
  const [discoverOpen, setDiscoverOpen] = useState(false)
  const [importing, setImporting] = useState(false)
  const fileRef = useRef<HTMLInputElement>(null)

  async function refresh() {
    setLoading(true)
    setError(null)
    try {
      const [list, prefs] = await Promise.all([
        promptsApi.list(),
        promptsApi.prefs(),
      ])
      setItems(list)
      setDefaultId(prefs.default_prompt_id)
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
    setNotice(null)
    Promise.all([promptsApi.list(), promptsApi.prefs()])
      .then(([list, prefs]) => {
        if (cancelled) return
        setItems(list)
        setDefaultId(prefs.default_prompt_id)
      })
      .catch((e) => {
        if (cancelled) return
        setError(e instanceof Error ? e.message : String(e))
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
    setContent("")
  }

  function openEdit(p: Prompt) {
    setEditor({ mode: "edit", id: p.id })
    setName(p.name)
    setContent(p.content)
  }

  function closeEditor() {
    setEditor(null)
  }

  async function save() {
    if (!editor) return
    const trimmedName = name.trim()
    if (!trimmedName) {
      setError("名称不能为空")
      return
    }
    try {
      if (editor.mode === "create") {
        const created = await promptsApi.create(trimmedName, content)
        setItems((s) => [created, ...s])
      } else {
        await promptsApi.update(editor.id, { name: trimmedName, content })
        setItems((s) =>
          s.map((x) =>
            x.id === editor.id ? { ...x, name: trimmedName, content } : x
          )
        )
      }
      closeEditor()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  async function remove(p: Prompt) {
    if (!window.confirm(`删除提示词 "${p.name}"？`)) return
    try {
      await promptsApi.remove(p.id)
      setItems((s) => s.filter((x) => x.id !== p.id))
      if (defaultId === p.id) setDefaultId(null)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  async function toggleDefault(p: Prompt) {
    const next = defaultId === p.id ? null : p.id
    try {
      await promptsApi.setDefault(next)
      setDefaultId(next)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  async function togglePublic(p: Prompt) {
    const next = !p.is_public
    try {
      await promptsApi.update(p.id, { is_public: next })
      setItems((s) =>
        s.map((x) => (x.id === p.id ? { ...x, is_public: next } : x))
      )
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  function exportAll() {
    window.location.href = promptsApi.exportUrl()
  }

  async function importFromFile(file: File) {
    setImporting(true)
    setError(null)
    setNotice(null)
    try {
      const text = await file.text()
      const parsed = JSON.parse(text) as {
        version?: number
        prompts?: Array<{ name: string; content: string }>
      }
      if (!parsed.prompts || !Array.isArray(parsed.prompts)) {
        throw new Error("文件格式错误：缺少 prompts 数组")
      }
      const res = await promptsApi.importBundle({
        version: parsed.version,
        prompts: parsed.prompts,
      })
      setNotice(
        `导入完成：新增 ${res.imported} 条，跳过 ${res.skipped} 条` +
          (res.errors.length ? `；错误：${res.errors.slice(0, 3).join("; ")}` : "")
      )
      await refresh()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setImporting(false)
    }
  }

  if (!open) return null

  return (
    <>
      <div
        className="fixed inset-0 z-50 grid place-items-center bg-black/50 p-2 sm:p-4"
        onClick={onClose}
      >
        <div
          className="flex w-full max-w-3xl flex-col gap-3 overflow-y-auto rounded-lg border border-border bg-background p-4 shadow-lg sm:p-6"
          onClick={(e) => e.stopPropagation()}
          style={{ maxHeight: "calc(100svh - 1rem)" }}
        >
          <div className="flex items-start justify-between gap-2">
            <div>
              <h2 className="text-lg font-semibold">提示词库</h2>
              <p className="text-sm text-muted-foreground">
                标星 = 新会话默认；地球图标 = 对所有注册用户公开。
              </p>
            </div>
            <div className="flex flex-wrap gap-2">
              <Button size="sm" variant="outline" onClick={() => setDiscoverOpen(true)}>
                <Compass /> 发现
              </Button>
              <Button size="sm" variant="outline" onClick={exportAll}>
                <Download /> 导出
              </Button>
              <Button
                size="sm"
                variant="outline"
                onClick={() => fileRef.current?.click()}
                disabled={importing}
              >
                <Upload /> {importing ? "导入中…" : "导入"}
              </Button>
              <input
                ref={fileRef}
                type="file"
                accept="application/json,.json"
                className="hidden"
                onChange={(e) => {
                  const f = e.target.files?.[0]
                  e.target.value = ""
                  if (f) void importFromFile(f)
                }}
              />
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
          {notice && (
            <div className="rounded-md border border-emerald-500/40 bg-emerald-500/10 px-3 py-2 text-sm">
              {notice}
            </div>
          )}

          {editor && (
            <div className="flex flex-col gap-3 rounded-md border border-border bg-muted/30 p-3">
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="p-name">名称</Label>
                <Input
                  id="p-name"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  maxLength={80}
                  autoFocus
                />
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="p-content">内容</Label>
                <Textarea
                  id="p-content"
                  value={content}
                  onChange={(e) => setContent(e.target.value)}
                  rows={6}
                  className="max-h-64 min-h-[8rem] resize-y font-mono text-xs"
                  placeholder="You are a helpful assistant…"
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
                还没有提示词，点「新建」或「发现」开始。
              </p>
            )}
            <ul className="flex flex-col gap-2">
              {items.map((p) => (
                <li
                  key={p.id}
                  className="flex items-start gap-2 rounded-md border border-border bg-background p-3"
                >
                  <button
                    type="button"
                    onClick={() => toggleDefault(p)}
                    className={cn(
                      "mt-0.5 rounded p-1 transition-colors",
                      defaultId === p.id
                        ? "text-amber-500"
                        : "text-muted-foreground hover:text-foreground"
                    )}
                    title={defaultId === p.id ? "取消默认" : "设为默认"}
                  >
                    <Star
                      className="size-4"
                      fill={defaultId === p.id ? "currentColor" : "none"}
                    />
                  </button>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="truncate font-medium">{p.name}</span>
                      {p.is_public && (
                        <span
                          className="inline-flex items-center gap-0.5 rounded bg-emerald-500/10 px-1 py-0.5 text-[10px] text-emerald-600 dark:text-emerald-400"
                          title="公开"
                        >
                          <Globe className="size-3" /> 公开
                        </span>
                      )}
                    </div>
                    <p className="mt-1 line-clamp-3 whitespace-pre-wrap text-xs text-muted-foreground">
                      {p.content || <em>（空内容）</em>}
                    </p>
                  </div>
                  <div className="flex flex-col items-end gap-1">
                    {onApplyToCurrent && (
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => onApplyToCurrent(p.content)}
                      >
                        用于本会话
                      </Button>
                    )}
                    <div className="flex gap-1">
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => togglePublic(p)}
                        title={p.is_public ? "改为私有" : "公开分享"}
                      >
                        {p.is_public ? (
                          <Lock className="size-3.5" />
                        ) : (
                          <Globe className="size-3.5" />
                        )}
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => openEdit(p)}
                        title="编辑"
                      >
                        <Pencil className="size-3.5" />
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => remove(p)}
                        title="删除"
                      >
                        <Trash2 className="size-3.5" />
                      </Button>
                    </div>
                  </div>
                </li>
              ))}
            </ul>
          </div>

          <div className="flex justify-end">
            <Button variant="outline" onClick={onClose}>
              关闭
            </Button>
          </div>
        </div>
      </div>

      <DiscoverDialog
        open={discoverOpen}
        onClose={() => setDiscoverOpen(false)}
        onCloned={() => void refresh()}
      />
    </>
  )
}
