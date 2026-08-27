// Video generation API client. Platform mode uses server-configured channels;
// custom mode forwards the user's upstream settings per request. The server
// never persists custom credentials in a video job.

async function jsonOrThrow<T>(res: Response): Promise<T> {
  if (!res.ok) {
    const text = await res.text().catch(() => res.statusText)
    throw new Error(text || `HTTP ${res.status}`)
  }
  return res.json() as Promise<T>
}

export type SizeRule = { size: string; multiplier: number }

export type VideoModel = {
  model: string
  display_name: string | null
  base_credits: number
  per_second: number
  allowed_seconds: number[]
  size_rules: SizeRule[]
}

export type VideoJob = {
  token: string
  model: string
  prompt: string
  seconds: number
  size: string
  input_image_path: string | null
  status: "pending" | "running" | "completed" | "failed"
  progress: number
  video_path: string | null
  error: string | null
  cost_credits: number
  refunded: boolean
  created_at: string
  finished_at: string | null
}

export type CreateVideoJobReq = {
  model: string
  prompt: string
  seconds: number
  size: string
  input_image_path?: string
}

export type VideoUpstreamConfig = {
  baseUrl: string
  apiKey?: string
}

const CUSTOM_VIDEO_SECONDS = Array.from({ length: 15 }, (_, index) => index + 1)
const CUSTOM_VIDEO_SIZES: SizeRule[] = [
  { size: "1280x720", multiplier: 100 },
  { size: "720x1280", multiplier: 100 },
  { size: "1920x1080", multiplier: 100 },
  { size: "1080x1920", multiplier: 100 },
]

function upstreamHeaders(upstream?: VideoUpstreamConfig): Record<string, string> {
  if (!upstream?.baseUrl.trim()) return {}
  const headers: Record<string, string> = {
    "X-Upstream-Url": upstream.baseUrl.trim().replace(/\/+$/, ""),
  }
  if (upstream.apiKey?.trim()) headers["X-Upstream-Key"] = upstream.apiKey.trim()
  return headers
}

function customModels(models: string[]): VideoModel[] {
  return models.filter(Boolean).map((model) => ({
    model,
    display_name: null,
    base_credits: 0,
    per_second: 0,
    allowed_seconds: CUSTOM_VIDEO_SECONDS,
    size_rules: CUSTOM_VIDEO_SIZES,
  }))
}

/** 与后端 videos::compute_cost 同式：(base + per_second*s) * multiplier / 100，四舍五入。 */
export function computeVideoCost(m: VideoModel, seconds: number, size: string): number | null {
  if (!m.allowed_seconds.includes(seconds)) return null
  const rule = m.size_rules.find((r) => r.size === size)
  if (!rule) return null
  return Math.round(((m.base_credits + m.per_second * seconds) * rule.multiplier) / 100)
}

export async function listVideoModels(upstream?: VideoUpstreamConfig): Promise<VideoModel[]> {
  const custom = Boolean(upstream?.baseUrl.trim())
  const res = await fetch(custom ? "/api/videos/custom-models" : "/api/videos/models", {
    credentials: "same-origin",
    headers: upstreamHeaders(upstream),
  })
  if (!res.ok) return jsonOrThrow(res)
  if (!custom) return res.json() as Promise<VideoModel[]>
  const models = (await res.json()) as string[]
  return customModels(models)
}

export async function createVideoJob(
  req: CreateVideoJobReq,
  upstream?: VideoUpstreamConfig
): Promise<{ token: string; cost: number }> {
  const res = await fetch("/api/videos/jobs", {
    method: "POST",
    credentials: "same-origin",
    headers: { "Content-Type": "application/json", ...upstreamHeaders(upstream) },
    body: JSON.stringify(req),
  })
  return jsonOrThrow(res)
}

export async function getVideoJob(token: string, upstream?: VideoUpstreamConfig): Promise<VideoJob> {
  const res = await fetch(`/api/videos/jobs/${encodeURIComponent(token)}`, {
    credentials: "same-origin",
    headers: upstreamHeaders(upstream),
  })
  return jsonOrThrow(res)
}

export async function listVideoJobs(page: number): Promise<{ jobs: VideoJob[]; has_more: boolean }> {
  const res = await fetch(`/api/videos/jobs?page=${page}`, { credentials: "same-origin" })
  return jsonOrThrow(res)
}

export async function deleteVideoJob(token: string): Promise<void> {
  const res = await fetch(`/api/videos/jobs/${encodeURIComponent(token)}`, {
    method: "DELETE",
    credentials: "same-origin",
  })
  if (!res.ok) {
    const text = await res.text().catch(() => res.statusText)
    throw new Error(text || `HTTP ${res.status}`)
  }
}
