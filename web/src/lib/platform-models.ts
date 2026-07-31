// Lists models available via admin-configured upstream channels (paid via
// platform credits). Backed by `GET /api/channels/models` (channels.rs).
//
// Distinct from `lib/models.ts` which lists models from the *user's* BYOK
// upstream — these two sources never mix.

export type PlatformModel = {
  model: string
  display_name: string | null
  kind: "chat" | "image"
  cost_credits: number
  protocol: "openai" | "claude" | "gemini"
  context_limit: number | null
}

export async function listPlatformModels(
  flavor: "chat" | "image",
  signal?: AbortSignal
): Promise<PlatformModel[]> {
  const res = await fetch(`/api/channels/models?flavor=${flavor}`, {
    credentials: "same-origin",
    signal,
  })
  if (!res.ok) {
    const text = await res.text().catch(() => res.statusText)
    throw new Error(`HTTP ${res.status}: ${text}`)
  }
  return (await res.json()) as PlatformModel[]
}
