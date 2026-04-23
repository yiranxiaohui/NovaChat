export type StudioGeneration = {
  id: number
  token: string
  status: "pending" | "running" | "done" | "failed"
  error: string | null
  prompt: string
  revised_prompt: string | null
  model: string | null
  size: string | null
  quality: string | null
  style: string | null
  n: number
  image_path: string | null
  source_path: string | null
  used_shared: boolean
  created_at: string
  finished_at: string | null
}

export type GenerateParams = {
  prompt: string
  model?: string
  size?: string
  quality?: string
  style?: string
  imageDataUrl?: string
  useShared?: boolean
  upstreamUrl?: string
  upstreamKey?: string
  signal?: AbortSignal
}

async function jsonOrThrow<T>(res: Response): Promise<T> {
  if (!res.ok) {
    const text = await res.text().catch(() => res.statusText)
    throw new Error(text || `HTTP ${res.status}`)
  }
  return res.json() as Promise<T>
}

function headersFor(o: GenerateParams): Record<string, string> {
  const h: Record<string, string> = { "Content-Type": "application/json" }
  if (o.useShared) {
    h["X-Use-Shared"] = "1"
  } else if (o.upstreamUrl && o.upstreamKey) {
    h["X-Upstream-Url"] = o.upstreamUrl
    h["X-Upstream-Key"] = o.upstreamKey
  }
  return h
}

export const studioApi = {
  async submit(o: GenerateParams): Promise<{ token: string }> {
    return jsonOrThrow(
      await fetch("/api/studio/generate", {
        method: "POST",
        headers: headersFor(o),
        body: JSON.stringify({
          prompt: o.prompt,
          model: o.model,
          size: o.size,
          quality: o.quality,
          style: o.style,
          image_data_url: o.imageDataUrl,
        }),
        credentials: "same-origin",
        signal: o.signal,
      })
    )
  },
  async job(token: string): Promise<StudioGeneration> {
    return jsonOrThrow(
      await fetch(`/api/studio/jobs/${encodeURIComponent(token)}`, {
        credentials: "same-origin",
      })
    )
  },
  async waitForJob(
    token: string,
    signal?: AbortSignal
  ): Promise<StudioGeneration> {
    const start = Date.now()
    const maxMs = 15 * 60 * 1000
    while (Date.now() - start < maxMs) {
      if (signal?.aborted) throw new DOMException("aborted", "AbortError")
      await new Promise((r) => setTimeout(r, 2000))
      if (signal?.aborted) throw new DOMException("aborted", "AbortError")
      const j = await this.job(token)
      if (j.status === "done" || j.status === "failed") return j
    }
    throw new Error("生成超时")
  },
  async list(page = 1): Promise<StudioGeneration[]> {
    return jsonOrThrow(
      await fetch(`/api/studio/generations?page=${page}`, {
        credentials: "same-origin",
      })
    )
  },
  async remove(id: number): Promise<void> {
    const res = await fetch(`/api/studio/generations/${id}`, {
      method: "DELETE",
      credentials: "same-origin",
    })
    if (!res.ok) {
      throw new Error(
        (await res.text().catch(() => res.statusText)) || `HTTP ${res.status}`
      )
    }
  },
}
