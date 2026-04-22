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
  const res = await fetch("/api/proxy/openai/images", {
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
  if (!res.ok) {
    const text = await res.text().catch(() => res.statusText)
    throw new Error(text || `HTTP ${res.status}`)
  }
  const json = (await res.json()) as { images: GeneratedImage[] }
  return json.images ?? []
}
