// Video generation API client. Platform-credits only (no BYOK) — all calls
// ride the session cookie; no X-Upstream-* headers.

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

/** 与后端 videos::compute_cost 同式：(base + per_second*s) * multiplier / 100，四舍五入。 */
export function computeVideoCost(m: VideoModel, seconds: number, size: string): number | null {
  if (!m.allowed_seconds.includes(seconds)) return null
  const rule = m.size_rules.find((r) => r.size === size)
  if (!rule) return null
  return Math.round(((m.base_credits + m.per_second * seconds) * rule.multiplier) / 100)
}

export async function listVideoModels(): Promise<VideoModel[]> {
  const res = await fetch("/api/videos/models", { credentials: "same-origin" })
  return jsonOrThrow(res)
}

export async function createVideoJob(req: CreateVideoJobReq): Promise<{ token: string; cost: number }> {
  const res = await fetch("/api/videos/jobs", {
    method: "POST",
    credentials: "same-origin",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(req),
  })
  return jsonOrThrow(res)
}

export async function getVideoJob(token: string): Promise<VideoJob> {
  const res = await fetch(`/api/videos/jobs/${encodeURIComponent(token)}`, {
    credentials: "same-origin",
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
