import { useEffect, useRef, useState } from "react"
import { ImageIcon, MessageSquare, RefreshCw } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import {
  IMAGE_DEFAULTS,
  PROTOCOL_META,
  type Protocol,
  type UpstreamSettings,
} from "@/lib/settings"
import { listModels } from "@/lib/models"
import { cn } from "@/lib/utils"

type Props = {
  open: boolean
  initial: UpstreamSettings
  onClose: () => void
  onSave: (s: UpstreamSettings) => void
}

type Tab = "chat" | "image"

const PROTOCOL_OPTIONS: Protocol[] = ["openai", "claude", "gemini"]

export function SettingsDialog({ open, initial, onClose, onSave }: Props) {
  // --- Chat state ---
  const [protocol, setProtocol] = useState<Protocol>(initial.protocol)
  const [baseUrl, setBaseUrl] = useState(initial.baseUrl)
  const [apiKey, setApiKey] = useState(initial.apiKey)
  const [model, setModel] = useState(initial.model)
  const [useProxy, setUseProxy] = useState(initial.useProxy)

  // --- Image state ---
  const [imageBaseUrl, setImageBaseUrl] = useState(initial.imageBaseUrl)
  const [imageApiKey, setImageApiKey] = useState(initial.imageApiKey)
  const [imageModel, setImageModel] = useState(initial.imageModel)
  const [imageUseProxy, setImageUseProxy] = useState(initial.imageUseProxy)

  const [cloudSync, setCloudSync] = useState(initial.cloudSync)
  const [tab, setTab] = useState<Tab>("chat")

  const [chatModels, setChatModels] = useState<string[]>([])
  const [chatLoading, setChatLoading] = useState(false)
  const [chatError, setChatError] = useState<string | null>(null)
  const [imageModels, setImageModels] = useState<string[]>([])
  const [imageLoading, setImageLoading] = useState(false)
  const [imageError, setImageError] = useState<string | null>(null)
  const chatAbortRef = useRef<AbortController | null>(null)
  const imageAbortRef = useRef<AbortController | null>(null)

  useEffect(() => {
    if (open) {
      setProtocol(initial.protocol)
      setBaseUrl(initial.baseUrl)
      setApiKey(initial.apiKey)
      setModel(initial.model)
      setUseProxy(initial.useProxy)
      setImageBaseUrl(initial.imageBaseUrl)
      setImageApiKey(initial.imageApiKey)
      setImageModel(initial.imageModel)
      setImageUseProxy(initial.imageUseProxy)
      setCloudSync(initial.cloudSync)
      setTab("chat")
      setChatModels([])
      setImageModels([])
      setChatError(null)
      setImageError(null)
    }
  }, [open, initial])

  useEffect(() => {
    setChatModels([])
    setChatError(null)
  }, [protocol, baseUrl])

  useEffect(() => {
    setImageModels([])
    setImageError(null)
  }, [imageBaseUrl])

  if (!open) return null

  const meta = PROTOCOL_META[protocol]
  const canLoadChat = Boolean(baseUrl.trim() && apiKey.trim())
  const canLoadImage = Boolean(imageBaseUrl.trim() && imageApiKey.trim())

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

  async function loadChatModels() {
    if (!canLoadChat || chatLoading) return
    chatAbortRef.current?.abort()
    const ctrl = new AbortController()
    chatAbortRef.current = ctrl
    setChatLoading(true)
    setChatError(null)
    try {
      const list = await listModels({
        protocol,
        baseUrl: baseUrl.trim(),
        apiKey: apiKey.trim(),
        useProxy,
        signal: ctrl.signal,
      })
      setChatModels(list)
      if (list.length > 0 && !list.includes(model)) setModel(list[0])
    } catch (e) {
      if ((e as { name?: string }).name !== "AbortError") {
        setChatError(e instanceof Error ? e.message : String(e))
      }
    } finally {
      setChatLoading(false)
      chatAbortRef.current = null
    }
  }

  async function loadImageModels() {
    if (!canLoadImage || imageLoading) return
    imageAbortRef.current?.abort()
    const ctrl = new AbortController()
    imageAbortRef.current = ctrl
    setImageLoading(true)
    setImageError(null)
    try {
      const list = await listModels({
        protocol: "openai",
        baseUrl: imageBaseUrl.trim(),
        apiKey: imageApiKey.trim(),
        useProxy: imageUseProxy,
        signal: ctrl.signal,
      })
      // Filter to plausibly image-capable model ids
      const filtered = list.filter((m) =>
        /dall-?e|gpt-image|image|flux|sd-?\d/i.test(m)
      )
      const pool = filtered.length > 0 ? filtered : list
      setImageModels(pool)
      if (pool.length > 0 && !pool.includes(imageModel)) setImageModel(pool[0])
    } catch (e) {
      if ((e as { name?: string }).name !== "AbortError") {
        setImageError(e instanceof Error ? e.message : String(e))
      }
    } finally {
      setImageLoading(false)
      imageAbortRef.current = null
    }
  }

  function copyChatAsImage() {
    if (!baseUrl && !apiKey) return
    if (!imageBaseUrl) setImageBaseUrl(baseUrl)
    if (!imageApiKey) setImageApiKey(apiKey)
    if (!imageModel) setImageModel(IMAGE_DEFAULTS.model)
  }

  return (
    <div
      className="fixed inset-0 z-50 grid place-items-center bg-black/50 p-4"
      onClick={onClose}
    >
      <div
        className="w-full max-w-md rounded-lg border border-border bg-background p-6 shadow-lg"
        onClick={(e) => e.stopPropagation()}
        style={{ maxHeight: "calc(100svh - 2rem)", overflow: "auto" }}
      >
        <h2 className="text-lg font-semibold">模型设置</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          {cloudSync
            ? "☁️ 已开启云端同步：所有字段会保存到服务器，登录后自动恢复。"
            : "仅保存在当前浏览器 (localStorage)，不会上传到服务器。"}
        </p>

        {/* Tabs */}
        <div className="mt-4 inline-flex rounded-lg border border-border bg-muted/40 p-1 text-sm">
          <TabBtn active={tab === "chat"} onClick={() => setTab("chat")}>
            <MessageSquare className="size-3.5" /> 对话
          </TabBtn>
          <TabBtn active={tab === "image"} onClick={() => setTab("image")}>
            <ImageIcon className="size-3.5" /> 图像
          </TabBtn>
        </div>

        {tab === "chat" ? (
          <div className="mt-4 flex flex-col gap-3">
            <div className="flex flex-col gap-1.5">
              <Label>协议</Label>
              <div className="grid grid-cols-3 gap-2">
                {PROTOCOL_OPTIONS.map((p) => (
                  <button
                    key={p}
                    type="button"
                    onClick={() => pickProtocol(p)}
                    className={cn(
                      "rounded-md border px-3 py-2 text-sm transition-colors",
                      protocol === p
                        ? "border-primary bg-primary/10 text-foreground"
                        : "border-border bg-background hover:bg-accent"
                    )}
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
                只填主机，路径自动补 <code>{meta.pathHint}</code>。
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

            <ModelField
              label="对话模型"
              value={model}
              onChange={setModel}
              models={chatModels}
              loading={chatLoading}
              error={chatError}
              canLoad={canLoadChat}
              onLoad={loadChatModels}
              placeholder={meta.defaultModel}
              datalistId="chat-model-options"
            />

            <label className="flex items-start gap-2 text-sm">
              <input
                type="checkbox"
                className="mt-1"
                checked={useProxy}
                onChange={(e) => setUseProxy(e.target.checked)}
              />
              <span>
                走服务端转发（推荐：规避浏览器 CORS 限制；key 只在浏览器，仅随每次请求发送）
              </span>
            </label>
          </div>
        ) : (
          <div className="mt-4 flex flex-col gap-3">
            <div className="rounded-md border border-border bg-muted/30 p-3 text-xs text-muted-foreground">
              图像生成走 OpenAI 兼容的 <code>/v1/images/generations</code>。可以单独配置（例如聊天走官方 OpenAI、生图走代理服务）。留空则禁用图像模式。
            </div>

            <div className="flex flex-col gap-1.5">
              <div className="flex items-center justify-between">
                <Label htmlFor="imageBaseUrl">图像 Base URL</Label>
                {(baseUrl || apiKey) && (
                  <button
                    type="button"
                    onClick={copyChatAsImage}
                    className="text-xs text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
                  >
                    复制对话配置
                  </button>
                )}
              </div>
              <Input
                id="imageBaseUrl"
                placeholder={IMAGE_DEFAULTS.baseUrl}
                value={imageBaseUrl}
                onChange={(e) => setImageBaseUrl(e.target.value)}
              />
              <p className="text-xs text-muted-foreground">
                路径自动补 <code>{IMAGE_DEFAULTS.pathHint}</code>。
              </p>
            </div>

            <div className="flex flex-col gap-1.5">
              <Label htmlFor="imageApiKey">图像 API Key</Label>
              <Input
                id="imageApiKey"
                type="text"
                autoComplete="off"
                spellCheck={false}
                placeholder="sk-…"
                value={imageApiKey}
                onChange={(e) => setImageApiKey(e.target.value)}
              />
            </div>

            <ModelField
              label="图像模型"
              value={imageModel}
              onChange={setImageModel}
              models={imageModels}
              loading={imageLoading}
              error={imageError}
              canLoad={canLoadImage}
              onLoad={loadImageModels}
              placeholder={IMAGE_DEFAULTS.model}
              datalistId="image-model-options"
            />

            <label className="flex items-start gap-2 text-sm">
              <input
                type="checkbox"
                className="mt-1"
                checked={imageUseProxy}
                onChange={(e) => setImageUseProxy(e.target.checked)}
              />
              <span>走服务端转发（同上）</span>
            </label>
          </div>
        )}

        <label className="mt-4 flex items-start gap-2 text-sm">
          <input
            type="checkbox"
            className="mt-1"
            checked={cloudSync}
            onChange={(e) => setCloudSync(e.target.checked)}
          />
          <span>
            云端同步 API Key / Base URL / 模型（保存到服务器账户，换设备登录后自动恢复；关闭后将从服务器删除）
          </span>
        </label>

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
                imageBaseUrl: imageBaseUrl.trim(),
                imageApiKey: imageApiKey.trim(),
                imageModel: imageModel.trim(),
                imageUseProxy,
                cloudSync,
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

function TabBtn({
  active,
  onClick,
  children,
}: {
  active: boolean
  onClick: () => void
  children: React.ReactNode
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "flex items-center gap-1.5 rounded-md px-3 py-1.5 transition-colors",
        active
          ? "bg-background text-foreground shadow-sm"
          : "text-muted-foreground hover:text-foreground"
      )}
    >
      {children}
    </button>
  )
}

function ModelField({
  label,
  value,
  onChange,
  models,
  loading,
  error,
  canLoad,
  onLoad,
  placeholder,
  datalistId,
}: {
  label: string
  value: string
  onChange: (v: string) => void
  models: string[]
  loading: boolean
  error: string | null
  canLoad: boolean
  onLoad: () => void
  placeholder: string
  datalistId: string
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-center justify-between">
        <Label htmlFor={datalistId + "-input"}>{label}</Label>
        <Button
          type="button"
          size="sm"
          variant="outline"
          onClick={onLoad}
          disabled={!canLoad || loading}
        >
          <RefreshCw className={loading ? "animate-spin" : ""} />
          {loading ? "加载中…" : models.length > 0 ? "刷新" : "加载列表"}
        </Button>
      </div>
      <Input
        id={datalistId + "-input"}
        list={datalistId}
        placeholder={placeholder}
        value={value}
        onChange={(e) => onChange(e.target.value)}
      />
      {models.length > 0 && (
        <>
          <datalist id={datalistId}>
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
                  onClick={() => onChange(m)}
                  className={cn(
                    "rounded px-2 py-0.5 text-xs transition-colors",
                    m === value
                      ? "bg-primary text-primary-foreground"
                      : "bg-background hover:bg-accent"
                  )}
                >
                  {m}
                </button>
              ))}
            </div>
          </div>
        </>
      )}
      {error && <p className="text-xs text-destructive">加载失败：{error}</p>}
    </div>
  )
}
