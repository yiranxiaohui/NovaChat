export type Protocol = "openai" | "claude" | "gemini"

export type UpstreamSettings = {
  protocol: Protocol
  baseUrl: string
  apiKey: string
  model: string
  useProxy: boolean
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

const EMPTY: UpstreamSettings = {
  protocol: "openai",
  baseUrl: "",
  apiKey: "",
  model: "",
  useProxy: true,
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
