export type StudioConversation = {
  id: number
  title: string
  model: string | null
  created_at: string
  updated_at: string
}

export type StudioImage = {
  path: string
  revised_prompt?: string | null
}

export type StudioMessage = {
  id: number
  role: "user" | "assistant"
  text: string | null
  images: StudioImage[]
  created_at: string
}

export type StudioJobStatus = {
  token: string
  status: "pending" | "running" | "done" | "failed"
  error: string | null
  created_at: string
  finished_at: string | null
}

async function jsonOrThrow<T>(res: Response): Promise<T> {
  if (!res.ok) {
    const text = await res.text().catch(() => res.statusText)
    throw new Error(text || `HTTP ${res.status}`)
  }
  return res.json() as Promise<T>
}

export type TurnOptions = {
  text: string
  imageDataUrl?: string
  useShared?: boolean
  upstreamUrl?: string
  upstreamKey?: string
  signal?: AbortSignal
}

function turnHeaders(o: TurnOptions): Record<string, string> {
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
  async list(): Promise<StudioConversation[]> {
    return jsonOrThrow(
      await fetch("/api/studio/conversations", { credentials: "same-origin" })
    )
  },
  async create(body: {
    title?: string
    model?: string
  }): Promise<{ id: number; title: string; model: string | null }> {
    return jsonOrThrow(
      await fetch("/api/studio/conversations", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        credentials: "same-origin",
      })
    )
  },
  async update(
    id: number,
    body: { title?: string; model?: string }
  ): Promise<void> {
    const res = await fetch(`/api/studio/conversations/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      credentials: "same-origin",
    })
    if (!res.ok) {
      throw new Error(
        (await res.text().catch(() => res.statusText)) || `HTTP ${res.status}`
      )
    }
  },
  async remove(id: number): Promise<void> {
    const res = await fetch(`/api/studio/conversations/${id}`, {
      method: "DELETE",
      credentials: "same-origin",
    })
    if (!res.ok) {
      throw new Error(
        (await res.text().catch(() => res.statusText)) || `HTTP ${res.status}`
      )
    }
  },
  async messages(id: number): Promise<StudioMessage[]> {
    return jsonOrThrow(
      await fetch(`/api/studio/conversations/${id}/messages`, {
        credentials: "same-origin",
      })
    )
  },
  async submitTurn(
    id: number,
    o: TurnOptions
  ): Promise<{ token: string; user_message_id: number }> {
    return jsonOrThrow(
      await fetch(`/api/studio/conversations/${id}/turn`, {
        method: "POST",
        headers: turnHeaders(o),
        body: JSON.stringify({
          text: o.text,
          image_data_url: o.imageDataUrl,
        }),
        credentials: "same-origin",
        signal: o.signal,
      })
    )
  },
  async job(token: string): Promise<StudioJobStatus> {
    return jsonOrThrow(
      await fetch(`/api/studio/jobs/${encodeURIComponent(token)}`, {
        credentials: "same-origin",
      })
    )
  },
  async waitForJob(
    token: string,
    signal?: AbortSignal
  ): Promise<StudioJobStatus> {
    const start = Date.now()
    const maxMs = 15 * 60 * 1000
    while (Date.now() - start < maxMs) {
      if (signal?.aborted) throw new DOMException("aborted", "AbortError")
      await new Promise((r) => setTimeout(r, 2000))
      if (signal?.aborted) throw new DOMException("aborted", "AbortError")
      const j = await this.job(token)
      if (j.status === "done" || j.status === "failed") return j
    }
    throw new Error("任务超时")
  },
}
