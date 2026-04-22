import { trimSlash, type ImageProtocol } from "./settings"

export type GeneratedImage = {
  path: string
  revised_prompt?: string | null
}

export type GenerateImageOptions = {
  protocol?: ImageProtocol
  baseUrl: string
  apiKey: string
  prompt: string
  model?: string
  size?: "1024x1024" | "1024x1792" | "1792x1024" | "auto"
  n?: number
  useProxy?: boolean
  signal?: AbortSignal
}

function openaiRequest(o: GenerateImageOptions): { url: string; body: unknown } {
  return {
    url: `${trimSlash(o.baseUrl)}/v1/images/generations`,
    body: {
      model: o.model ?? "dall-e-3",
      prompt: o.prompt,
      n: o.n ?? 1,
      size: o.size ?? "1024x1024",
      response_format: "b64_json",
    },
  }
}

function sizeToAspect(size: GenerateImageOptions["size"]): string {
  switch (size) {
    case "1024x1792":
      return "9:16"
    case "1792x1024":
      return "16:9"
    default:
      return "1:1"
  }
}

function geminiRequest(o: GenerateImageOptions): { url: string; body: unknown } {
  const model = o.model ?? "imagen-3.0-generate-002"
  return {
    url: `${trimSlash(o.baseUrl)}/v1beta/models/${encodeURIComponent(model)}:predict`,
    body: {
      instances: [{ prompt: o.prompt }],
      parameters: {
        sampleCount: o.n ?? 1,
        aspectRatio: sizeToAspect(o.size),
      },
    },
  }
}

export async function generateImages(
  o: GenerateImageOptions
): Promise<GeneratedImage[]> {
  const protocol: ImageProtocol = o.protocol ?? "openai"
  const useProxy = o.useProxy !== false
  const { url: upstream, body } =
    protocol === "gemini" ? geminiRequest(o) : openaiRequest(o)

  let res: Response
  if (useProxy) {
    res = await fetch(`/api/proxy/${protocol}/images`, {
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
  } else {
    const directHeaders: Record<string, string> =
      protocol === "gemini"
        ? { "Content-Type": "application/json", "x-goog-api-key": o.apiKey }
        : { "Content-Type": "application/json", Authorization: `Bearer ${o.apiKey}` }
    res = await fetch(upstream, {
      method: "POST",
      headers: directHeaders,
      body: JSON.stringify(body),
      signal: o.signal,
    })
  }

  if (!res.ok) {
    const text = await res.text().catch(() => res.statusText)
    throw new Error(text || `HTTP ${res.status}`)
  }

  // Proxy mode: unified { images: [{path, revised_prompt}] } — files already stored.
  // Direct mode: protocol-native shape, which we normalize below.
  const json = (await res.json()) as Record<string, unknown>
  if (Array.isArray((json as { images?: unknown[] }).images)) {
    return (json as { images: GeneratedImage[] }).images
  }

  if (protocol === "gemini") {
    // predict: { predictions: [{ bytesBase64Encoded, mimeType } | { image: { imageBytes } }] }
    const preds = (json.predictions as Array<Record<string, unknown>> | undefined) ?? []
    const out: GeneratedImage[] = []
    for (const p of preds) {
      const b64 =
        (p.bytesBase64Encoded as string | undefined) ??
        ((p.image as { imageBytes?: string } | undefined)?.imageBytes as
          | string
          | undefined)
      if (!b64) continue
      const mime =
        (p.mimeType as string | undefined) ??
        ((p.image as { mimeType?: string } | undefined)?.mimeType as
          | string
          | undefined) ??
        "image/png"
      out.push({ path: `data:${mime};base64,${b64}`, revised_prompt: null })
    }
    return out
  }

  // OpenAI shape: { data: [{ b64_json } | { url }] }
  const raw = (json.data as Array<Record<string, unknown>> | undefined) ?? []
  return raw.map((d) => ({
    path: d.b64_json
      ? `data:image/png;base64,${d.b64_json as string}`
      : ((d.url as string | undefined) ?? ""),
    revised_prompt: (d.revised_prompt as string | undefined) ?? null,
  }))
}
