import { trimSlash } from "./settings"

export type GeneratedImage = {
  path: string
  revised_prompt?: string | null
}

export type GenerateImageOptions = {
  baseUrl: string
  apiKey: string
  prompt: string
  model?: string
  size?: "1024x1024" | "1024x1792" | "1792x1024" | "auto"
  n?: number
  useProxy?: boolean
  signal?: AbortSignal
}

export async function generateImages(
  o: GenerateImageOptions
): Promise<GeneratedImage[]> {
  const upstream = `${trimSlash(o.baseUrl)}/v1/images/generations`
  const body = {
    model: o.model ?? "dall-e-3",
    prompt: o.prompt,
    n: o.n ?? 1,
    size: o.size ?? "1024x1024",
    response_format: "b64_json",
  }
  const useProxy = o.useProxy !== false
  const res = useProxy
    ? await fetch("/api/proxy/openai/images", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Upstream-Url": upstream,
          "X-Upstream-Key": o.apiKey,
        },
        body: JSON.stringify(body),
        credentials: "same-origin",
        signal: o.signal,
      })
    : await fetch(upstream, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${o.apiKey}`,
        },
        body: JSON.stringify(body),
        signal: o.signal,
      })
  if (!res.ok) {
    const text = await res.text().catch(() => res.statusText)
    throw new Error(text || `HTTP ${res.status}`)
  }
  // Direct upstream returns { data: [{b64_json} | {url}] }; proxy returns
  // { images: [{path, revised_prompt}] } where files are already stored.
  const json = (await res.json()) as
    | { images: GeneratedImage[] }
    | { data?: Array<{ b64_json?: string; url?: string; revised_prompt?: string }> }
  if ("images" in json && Array.isArray(json.images)) return json.images
  const raw = "data" in json ? (json.data ?? []) : []
  return raw.map((d) => ({
    // For direct-mode fallback: we can only show base64 inline as data URL,
    // or a remote URL. Remote URLs expire; base64 is safer.
    path: d.b64_json
      ? `data:image/png;base64,${d.b64_json}`
      : d.url ?? "",
    revised_prompt: d.revised_prompt ?? null,
  }))
}
