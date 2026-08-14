// Admin channels + pricing API client.
//
// Mirrors src/channels.rs handlers under /api/admin/channels and
// /api/admin/pricing. All routes require admin session.

async function jsonOrThrow<T>(res: Response): Promise<T> {
  if (!res.ok) {
    const text = await res.text().catch(() => res.statusText)
    throw new Error(text || `HTTP ${res.status}`)
  }
  return res.json() as Promise<T>
}

async function okOrThrow(res: Response): Promise<void> {
  if (!res.ok) {
    const text = await res.text().catch(() => res.statusText)
    throw new Error(text || `HTTP ${res.status}`)
  }
}

// ---------------------------------------------------------------------------
// channels
// ---------------------------------------------------------------------------

export type ChannelProtocol = "openai" | "claude" | "gemini"
export type ChannelKind = "chat" | "image" | "video"

export type Channel = {
  id: number
  name: string
  protocol: ChannelProtocol
  base_url: string
  api_key: string
  enabled: boolean
  priority: number
}

export type ChannelInput = {
  name: string
  protocol: ChannelProtocol
  base_url: string
  api_key: string
  enabled?: boolean
  priority?: number
}

export type ChannelPatch = Partial<{
  name: string
  protocol: ChannelProtocol
  base_url: string
  api_key: string
  enabled: boolean
  priority: number
}>

export type ChannelModel = {
  channel_id: number
  model: string
  upstream_id: string | null
}

export type ChannelModelEntry = {
  model: string
  upstream_id?: string | null
}

// ---------------------------------------------------------------------------
// pricing
// ---------------------------------------------------------------------------

export type VideoSizeRule = { size: string; multiplier: number }

export type ModelPrice = {
  id: number
  model: string
  kind: ChannelKind
  cost_credits: number
  display_name: string | null
  enabled: boolean
  protocol: ChannelProtocol
  context_limit: number | null
  // video-kind billing: (base_credits + per_second × 秒) × 尺寸倍率
  base_credits: number
  per_second: number
  allowed_seconds: number[] | null
  size_rules: VideoSizeRule[] | null
}

export type PricingInput = {
  model: string
  kind: ChannelKind
  /** Replace model-to-channel bindings when present; omit to preserve them. */
  channel_ids?: number[]
  cost_credits: number
  display_name?: string | null
  enabled?: boolean
  protocol: ChannelProtocol
  context_limit?: number | null
  base_credits?: number
  per_second?: number
  allowed_seconds?: number[] | null
  size_rules?: VideoSizeRule[] | null
}

export type AllChannelModel = {
  model: string
  /** channels that advertise this model — function is chosen in model pricing */
  channels: { id: number; name: string; protocol: ChannelProtocol }[]
}

export type AllChannelModelsResponse = {
  models: AllChannelModel[]
  /** per-channel probe failures (timeout, 4xx, parse errors) */
  errors: { channel: string; error: string }[]
}

// ---------------------------------------------------------------------------
// API
// ---------------------------------------------------------------------------

export const channelsAdminApi = {
  // channels
  async listChannels(): Promise<Channel[]> {
    return jsonOrThrow(
      await fetch("/api/admin/channels", { credentials: "same-origin" })
    )
  },
  async createChannel(input: ChannelInput): Promise<{ id: number }> {
    return jsonOrThrow(
      await fetch("/api/admin/channels", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(input),
        credentials: "same-origin",
      })
    )
  },
  async patchChannel(id: number, patch: ChannelPatch): Promise<void> {
    await okOrThrow(
      await fetch(`/api/admin/channels/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(patch),
        credentials: "same-origin",
      })
    )
  },
  async deleteChannel(id: number): Promise<void> {
    await okOrThrow(
      await fetch(`/api/admin/channels/${id}`, {
        method: "DELETE",
        credentials: "same-origin",
      })
    )
  },

  // channel models (bound model list)
  async getChannelModels(id: number): Promise<ChannelModel[]> {
    return jsonOrThrow(
      await fetch(`/api/admin/channels/${id}/models`, {
        credentials: "same-origin",
      })
    )
  },
  async setChannelModels(
    id: number,
    models: ChannelModelEntry[]
  ): Promise<void> {
    await okOrThrow(
      await fetch(`/api/admin/channels/${id}/models`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ models }),
        credentials: "same-origin",
      })
    )
  },

  // aggregated model list across all enabled channels, by live-probing each
  // upstream's /models endpoint (no DB whitelist required).
  async listAllChannelModels(): Promise<AllChannelModelsResponse> {
    return jsonOrThrow(
      await fetch("/api/admin/channels/all-models", {
        credentials: "same-origin",
      })
    )
  },

  // pricing
  async listPricing(): Promise<ModelPrice[]> {
    return jsonOrThrow(
      await fetch("/api/admin/pricing", { credentials: "same-origin" })
    )
  },
  async upsertPricing(input: PricingInput): Promise<void> {
    await okOrThrow(
      await fetch("/api/admin/pricing", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(input),
        credentials: "same-origin",
      })
    )
  },
  async deletePricing(model: string): Promise<void> {
    await okOrThrow(
      await fetch(`/api/admin/pricing/${encodeURIComponent(model)}`, {
        method: "DELETE",
        credentials: "same-origin",
      })
    )
  },
}
