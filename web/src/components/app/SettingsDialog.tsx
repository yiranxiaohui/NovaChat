import { useEffect, useRef, useState } from "react"
import { RefreshCw } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import {
  PROTOCOL_META,
  type Protocol,
  type UpstreamSettings,
} from "@/lib/settings"
import { listModels } from "@/lib/models"

type Props = {
  open: boolean
  initial: UpstreamSettings
  onClose: () => void
  onSave: (s: UpstreamSettings) => void
}

const PROTOCOL_OPTIONS: Protocol[] = ["openai", "claude", "gemini"]

export function SettingsDialog({ open, initial, onClose, onSave }: Props) {
  const [protocol, setProtocol] = useState<Protocol>(initial.protocol)
  const [baseUrl, setBaseUrl] = useState(initial.baseUrl)
  const [apiKey, setApiKey] = useState(initial.apiKey)
  const [model, setModel] = useState(initial.model)
  const [useProxy, setUseProxy] = useState(initial.useProxy)

  const [models, setModels] = useState<string[]>([])
  const [loadingModels, setLoadingModels] = useState(false)
  const [loadError, setLoadError] = useState<string | null>(null)
  const abortRef = useRef<AbortController | null>(null)

  useEffect(() => {
    if (open) {
      setProtocol(initial.protocol)
      setBaseUrl(initial.baseUrl)
      setApiKey(initial.apiKey)
      setModel(initial.model)
      setUseProxy(initial.useProxy)
      setModels([])
      setLoadError(null)
    }
  }, [open, initial])

  useEffect(() => {
    setModels([])
    setLoadError(null)
  }, [protocol, baseUrl])

  if (!open) return null

  const meta = PROTOCOL_META[protocol]
  const canLoadModels = Boolean(baseUrl.trim() && apiKey.trim())

  function pickProtocol(next: Protocol) {
    if (next === protocol) return
    const prev = PROTOCOL_META[protocol]
    setProtocol(next)
    const nextMeta = PROTOCOL_META[next]
    if (!baseUrl || baseUrl === prev.defaultBaseUrl) {
      setBaseUrl(nextMeta.defaultBaseUrl)
    }
    if (!model || model === prev.defaultModel) {
      setModel(nextMeta.defaultModel)
    }
  }

  async function loadModels() {
    if (!canLoadModels || loadingModels) return
    abortRef.current?.abort()
    const ctrl = new AbortController()
    abortRef.current = ctrl
    setLoadingModels(true)
    setLoadError(null)
    try {
      const list = await listModels({
        protocol,
        baseUrl: baseUrl.trim(),
        apiKey: apiKey.trim(),
        useProxy,
        signal: ctrl.signal,
      })
      setModels(list)
      if (list.length > 0 && !list.includes(model)) {
        setModel(list[0])
      }
    } catch (e) {
      if ((e as { name?: string }).name !== "AbortError") {
        setLoadError(e instanceof Error ? e.message : String(e))
      }
    } finally {
      setLoadingModels(false)
      abortRef.current = null
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 grid place-items-center bg-black/50 p-4"
      onClick={onClose}
    >
      <div
        className="w-full max-w-md rounded-lg border border-border bg-background p-6 shadow-lg"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 className="text-lg font-semibold">模型设置</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          仅保存在当前浏览器 (localStorage)，不会上传到服务器。
        </p>

        <div className="mt-4 flex flex-col gap-3">
          <div className="flex flex-col gap-1.5">
            <Label>协议</Label>
            <div className="grid grid-cols-3 gap-2">
              {PROTOCOL_OPTIONS.map((p) => (
                <button
                  key={p}
                  type="button"
                  onClick={() => pickProtocol(p)}
                  className={
                    "rounded-md border px-3 py-2 text-sm transition-colors " +
                    (protocol === p
                      ? "border-primary bg-primary/10 text-foreground"
                      : "border-border bg-background hover:bg-accent")
                  }
                >
                  {PROTOCOL_META[p].label}
                </button>
              ))}
            </div>
          </div>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="baseUrl">Base URL</Label>
            <Input
              id="baseUrl"
              placeholder={meta.defaultBaseUrl}
              value={baseUrl}
              onChange={(e) => setBaseUrl(e.target.value)}
            />
            <p className="text-xs text-muted-foreground">
              只填主机，例如 <code>{meta.defaultBaseUrl}</code>；实际请求路径自动补 <code>{meta.pathHint}</code>。
            </p>
          </div>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="apiKey">API Key</Label>
            <Input
              id="apiKey"
              type="text"
              autoComplete="off"
              spellCheck={false}
              placeholder={protocol === "gemini" ? "AIza…" : "sk-…"}
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
            />
          </div>

          <div className="flex flex-col gap-1.5">
            <div className="flex items-center justify-between">
              <Label htmlFor="model">模型</Label>
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={loadModels}
                disabled={!canLoadModels || loadingModels}
              >
                <RefreshCw className={loadingModels ? "animate-spin" : ""} />
                {loadingModels ? "加载中…" : models.length > 0 ? "刷新" : "加载列表"}
              </Button>
            </div>
            <Input
              id="model"
              list="model-options"
              placeholder={meta.defaultModel}
              value={model}
              onChange={(e) => setModel(e.target.value)}
            />
            {models.length > 0 && (
              <>
                <datalist id="model-options">
                  {models.map((m) => (
                    <option key={m} value={m} />
                  ))}
                </datalist>
                <div className="max-h-24 overflow-y-auto rounded-md border border-border bg-muted/30 p-1.5">
                  <div className="flex flex-wrap gap-1">
                    {models.map((m) => (
                      <button
                        key={m}
                        type="button"
                        onClick={() => setModel(m)}
                        className={
                          "rounded px-2 py-0.5 text-xs transition-colors " +
                          (m === model
                            ? "bg-primary text-primary-foreground"
                            : "bg-background hover:bg-accent")
                        }
                      >
                        {m}
                      </button>
                    ))}
                  </div>
                </div>
              </>
            )}
            {loadError && (
              <p className="text-xs text-destructive">加载失败：{loadError}</p>
            )}
          </div>

          <label className="flex items-start gap-2 text-sm">
            <input
              type="checkbox"
              className="mt-1"
              checked={useProxy}
              onChange={(e) => setUseProxy(e.target.checked)}
            />
            <span>
              走服务端转发（推荐：规避浏览器 CORS 限制；key 仍只保留在浏览器，每次请求随头发送）
            </span>
          </label>
        </div>

        <div className="mt-6 flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>
            取消
          </Button>
          <Button
            onClick={() =>
              onSave({
                protocol,
                baseUrl: baseUrl.trim(),
                apiKey: apiKey.trim(),
                model: model.trim(),
                useProxy,
              })
            }
          >
            保存
          </Button>
        </div>
      </div>
    </div>
  )
}
