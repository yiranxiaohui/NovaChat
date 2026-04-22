export type Protocol = "openai" | "claude" | "gemini"

export type UpstreamSettings = {
  // chat (protocol-aware)
  protocol: Protocol
  baseUrl: string
  apiKey: string
  model: string
  useProxy: boolean

  // image generation (OpenAI-compatible only; independent config)
  imageBaseUrl: string
  imageApiKey: string
  imageModel: string
  imageUseProxy: boolean

  cloudSync: boolean
}

export const PROTOCOL_META: Record<
  Protocol,
  { label: string; defaultBaseUrl: string; defaultModel: string; pathHint: string }
> = {
  openai: {
    label: "OpenAI 兼容",
    defaultBaseUrl: "https://api.openai.com",
    defaultModel: "gpt-4o-mini",
    pathHint: "/v1/chat/completions",
  },
  claude: {
    label: "Anthropic Claude",
    defaultBaseUrl: "https://api.anthropic.com",
    defaultModel: "claude-3-5-sonnet-latest",
    pathHint: "/v1/messages",
  },
  gemini: {
    label: "Google Gemini",
    defaultBaseUrl: "https://generativelanguage.googleapis.com",
    defaultModel: "gemini-2.0-flash",
    pathHint: "/v1beta/models/{model}:streamGenerateContent",
  },
}

export const IMAGE_DEFAULTS = {
  baseUrl: "https://api.openai.com",
  model: "dall-e-3",
  pathHint: "/v1/images/generations",
}

const EMPTY: UpstreamSettings = {
  protocol: "openai",
  baseUrl: "",
  apiKey: "",
  model: "",
  useProxy: true,
  imageBaseUrl: "",
  imageApiKey: "",
  imageModel: "",
  imageUseProxy: true,
  cloudSync: false,
}

function keyFor(userId: number | string) {
  return `novachat:upstream:v2:${userId}`
}

export function loadSettings(userId: number | string): UpstreamSettings {
  try {
    const raw = localStorage.getItem(keyFor(userId))
    if (!raw) return EMPTY
    const parsed = JSON.parse(raw) as Partial<UpstreamSettings>
    return { ...EMPTY, ...parsed }
  } catch {
    return EMPTY
  }
}

export function saveSettings(userId: number | string, s: UpstreamSettings) {
  localStorage.setItem(keyFor(userId), JSON.stringify(s))
}

export function clearSettings(userId: number | string) {
  localStorage.removeItem(keyFor(userId))
}

export function trimSlash(url: string): string {
  return url.replace(/\/+$/, "")
}

export function isImageConfigured(s: UpstreamSettings): boolean {
  return Boolean(s.imageBaseUrl && s.imageApiKey && s.imageModel)
}

// ---------------------------------------------------------------------------
// cloud sync
// ---------------------------------------------------------------------------

type CloudPayload = {
  protocol: Protocol
  base_url: string
  api_key: string
  model: string
  use_proxy: boolean
  image_base_url?: string | null
  image_api_key?: string | null
  image_model?: string | null
  image_use_proxy?: boolean | null
}

function toCloud(s: UpstreamSettings): CloudPayload {
  const hasImage = s.imageBaseUrl || s.imageApiKey || s.imageModel
  return {
    protocol: s.protocol,
    base_url: s.baseUrl,
    api_key: s.apiKey,
    model: s.model,
    use_proxy: s.useProxy,
    ...(hasImage
      ? {
          image_base_url: s.imageBaseUrl || null,
          image_api_key: s.imageApiKey || null,
          image_model: s.imageModel || null,
          image_use_proxy: s.imageUseProxy,
        }
      : {}),
  }
}

function fromCloud(p: CloudPayload): Omit<UpstreamSettings, "cloudSync"> {
  return {
    protocol: p.protocol,
    baseUrl: p.base_url ?? "",
    apiKey: p.api_key ?? "",
    model: p.model ?? "",
    useProxy: Boolean(p.use_proxy),
    imageBaseUrl: p.image_base_url ?? "",
    imageApiKey: p.image_api_key ?? "",
    imageModel: p.image_model ?? "",
    imageUseProxy: p.image_use_proxy == null ? true : Boolean(p.image_use_proxy),
  }
}

export const settingsApi = {
  async fetch(): Promise<Omit<UpstreamSettings, "cloudSync"> | null> {
    const res = await fetch("/api/settings", { credentials: "same-origin" })
    if (res.status === 404) return null
    if (!res.ok) {
      throw new Error((await res.text().catch(() => res.statusText)) || `HTTP ${res.status}`)
    }
    const data = (await res.json()) as CloudPayload
    return fromCloud(data)
  },
  async save(s: UpstreamSettings): Promise<void> {
    const res = await fetch("/api/settings", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(toCloud(s)),
      credentials: "same-origin",
    })
    if (!res.ok) {
      throw new Error((await res.text().catch(() => res.statusText)) || `HTTP ${res.status}`)
    }
  },
  async remove(): Promise<void> {
    const res = await fetch("/api/settings", {
      method: "DELETE",
      credentials: "same-origin",
    })
    if (!res.ok && res.status !== 404) {
      throw new Error((await res.text().catch(() => res.statusText)) || `HTTP ${res.status}`)
    }
  },
}

export async function loadEffectiveSettings(
  userId: number | string
): Promise<UpstreamSettings> {
  const local = loadSettings(userId)
  if (!local.cloudSync) return local
  try {
    const remote = await settingsApi.fetch()
    if (!remote) return local
    const merged: UpstreamSettings = { ...remote, cloudSync: true }
    saveSettings(userId, merged)
    return merged
  } catch {
    return local
  }
}
