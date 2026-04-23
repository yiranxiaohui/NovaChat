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
  useShared?: boolean
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

// ---------------------------------------------------------------------------
// job polling (for proxy / shared paths — decouples browser from upstream)
// ---------------------------------------------------------------------------

type JobStatus = {
  token: string
  status: "pending" | "running" | "done" | "failed"
  protocol: string
  kind: string
  error: string | null
  images: GeneratedImage[] | null
}

async function pollImageJob(
  token: string,
  signal: AbortSignal | undefined
): Promise<GeneratedImage[]> {
  // Poll every 2s up to 15 minutes. Backend always completes the job even
  // if this polling stops — the next call to get_job will find it 'done'.
  const start = Date.now()
  const maxMs = 15 * 60 * 1000
  while (Date.now() - start < maxMs) {
    if (signal?.aborted) throw new DOMException("aborted", "AbortError")
    await new Promise((r) => setTimeout(r, 2000))
    if (signal?.aborted) throw new DOMException("aborted", "AbortError")

    const res = await fetch(`/api/images/jobs/${encodeURIComponent(token)}`, {
      credentials: "same-origin",
      signal,
    })
    if (!res.ok) {
      const text = await res.text().catch(() => res.statusText)
      throw new Error(text || `HTTP ${res.status}`)
    }
    const j = (await res.json()) as JobStatus
    if (j.status === "done" && j.images) return j.images
    if (j.status === "failed") throw new Error(j.error || "图像生成失败")
  }
  throw new Error("图像生成超时，请稍后在侧边栏重试或联系管理员")
}

// ---------------------------------------------------------------------------
// OpenAI Responses API — multi-turn image generation with real conversation
// context. The backend receives the serialized history, re-encodes stored
// images as input_image data URLs, and calls /v1/responses with the
// image_generation tool. Only supported for OpenAI-protocol upstreams.
// ---------------------------------------------------------------------------

export type ResponsesHistoryTurn = {
  role: "user" | "assistant"
  text?: string
  images?: string[]  // server-stored paths like "/api/images/xxx.png"
}

export type ResponsesImageOptions = {
  history: ResponsesHistoryTurn[]
  model?: string
  size?: GenerateImageOptions["size"]
  quality?: string
  useShared?: boolean
  baseUrl?: string   // used when not shared — backend appends /v1/responses
  apiKey?: string    // used when not shared
  signal?: AbortSignal
}

export async function generateWithResponses(
  o: ResponsesImageOptions
): Promise<GeneratedImage[]> {
  const headers: Record<string, string> = { "Content-Type": "application/json" }
  if (o.useShared) {
    headers["X-Use-Shared"] = "1"
    if (o.model) headers["X-Upstream-Model"] = o.model
  } else if (o.baseUrl && o.apiKey) {
    headers["X-Upstream-Url"] = o.baseUrl.replace(/\/+$/, "")
    headers["X-Upstream-Key"] = o.apiKey
  } else {
    throw new Error("缺少 baseUrl / apiKey（或启用共享后端）")
  }
  const body: Record<string, unknown> = { history: o.history }
  if (o.model) body.model = o.model
  if (o.size && o.size !== "auto") body.size = o.size
  if (o.quality) body.quality = o.quality

  const token = await submitJob(`/api/images/jobs/openai/responses`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
    credentials: "same-origin",
    signal: o.signal,
  })
  return pollImageJob(token, o.signal)
}

/// Parse assistant-role markdown content: extract every `![alt](path)` image
/// URL, return the residual text (with image tags stripped) and the list of
/// paths. Used to serialize history for the Responses API.
export function extractAssistantImages(md: string): {
  text: string
  images: string[]
} {
  const images: string[] = []
  const text = md
    .replace(/!\[[^\]]*\]\(([^)]+)\)/g, (_m, p1: string) => {
      if (p1) images.push(p1)
      return ""
    })
    .trim()
  return { text, images }
}

async function submitJob(
  path: string,
  init: RequestInit
): Promise<string> {
  const res = await fetch(path, init)
  if (!res.ok) {
    const text = await res.text().catch(() => res.statusText)
    throw new Error(text || `HTTP ${res.status}`)
  }
  const j = (await res.json()) as { token: string }
  return j.token
}

// ---------------------------------------------------------------------------
// generate
// ---------------------------------------------------------------------------

export async function generateImages(
  o: GenerateImageOptions
): Promise<GeneratedImage[]> {
  const protocol: ImageProtocol = o.protocol ?? "openai"
  const useProxy = o.useProxy !== false
  const { url: upstream, body } =
    protocol === "gemini" ? geminiRequest(o) : openaiRequest(o)

  // Proxy / shared modes → async job (poll until done). Direct mode stays
  // synchronous since it hits the provider directly without going through
  // our backend.
  if (o.useShared) {
    const token = await submitJob(`/api/images/jobs/${protocol}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Use-Shared": "1",
        "X-Upstream-Model": o.model ?? "",
      },
      body: JSON.stringify(body),
      credentials: "same-origin",
      signal: o.signal,
    })
    return pollImageJob(token, o.signal)
  }
  if (useProxy) {
    const token = await submitJob(`/api/images/jobs/${protocol}`, {
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
    return pollImageJob(token, o.signal)
  }

  // Direct mode: caller talks to provider; no backend involvement.
  const directHeaders: Record<string, string> =
    protocol === "gemini"
      ? { "Content-Type": "application/json", "x-goog-api-key": o.apiKey }
      : { "Content-Type": "application/json", Authorization: `Bearer ${o.apiKey}` }
  const res = await fetch(upstream, {
    method: "POST",
    headers: directHeaders,
    body: JSON.stringify(body),
    signal: o.signal,
  })
  if (!res.ok) {
    const text = await res.text().catch(() => res.statusText)
    throw new Error(text || `HTTP ${res.status}`)
  }
  const json = (await res.json()) as Record<string, unknown>
  if (protocol === "gemini") {
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
  const raw = (json.data as Array<Record<string, unknown>> | undefined) ?? []
  return raw.map((d) => ({
    path: d.b64_json
      ? `data:image/png;base64,${d.b64_json as string}`
      : ((d.url as string | undefined) ?? ""),
    revised_prompt: (d.revised_prompt as string | undefined) ?? null,
  }))
}

// ---------------------------------------------------------------------------
// edit
// ---------------------------------------------------------------------------

export type EditImageOptions = {
  protocol?: ImageProtocol
  baseUrl: string
  apiKey: string
  prompt: string
  image: Blob
  mask?: Blob
  model?: string
  size?: GenerateImageOptions["size"]
  n?: number
  useProxy?: boolean
  useShared?: boolean
  signal?: AbortSignal
}

async function blobToBase64(b: Blob): Promise<string> {
  const buf = await b.arrayBuffer()
  const bytes = new Uint8Array(buf)
  let bin = ""
  const chunk = 0x8000
  for (let i = 0; i < bytes.length; i += chunk) {
    bin += String.fromCharCode(...bytes.subarray(i, i + chunk))
  }
  return btoa(bin)
}

export async function editImages(o: EditImageOptions): Promise<GeneratedImage[]> {
  const protocol: ImageProtocol = o.protocol ?? "openai"
  const useProxy = o.useProxy !== false

  if (protocol === "gemini") {
    const model = o.model ?? "gemini-2.5-flash-image-preview"
    const upstream = `${trimSlash(o.baseUrl)}/v1beta/models/${encodeURIComponent(model)}:generateContent`
    const mime = o.image.type || "image/png"
    const data = await blobToBase64(o.image)
    const parts: unknown[] = [
      { text: o.prompt },
      { inline_data: { mime_type: mime, data } },
    ]
    if (o.mask) {
      const maskMime = o.mask.type || "image/png"
      const maskData = await blobToBase64(o.mask)
      parts.push({ inline_data: { mime_type: maskMime, data: maskData } })
    }
    const body = {
      contents: [{ role: "user", parts }],
      generationConfig: { responseModalities: ["IMAGE", "TEXT"] },
    }
    if (o.useShared) {
      const token = await submitJob(`/api/images/jobs/gemini`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Use-Shared": "1",
          "X-Upstream-Model": model,
        },
        body: JSON.stringify(body),
        credentials: "same-origin",
        signal: o.signal,
      })
      return pollImageJob(token, o.signal)
    }
    if (useProxy) {
      const token = await submitJob(`/api/images/jobs/gemini`, {
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
      return pollImageJob(token, o.signal)
    }
    const res = await fetch(upstream, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-goog-api-key": o.apiKey,
      },
      body: JSON.stringify(body),
      signal: o.signal,
    })
    if (!res.ok) {
      const text = await res.text().catch(() => res.statusText)
      throw new Error(text || `HTTP ${res.status}`)
    }
    const json = (await res.json()) as Record<string, unknown>
    const cands =
      (json.candidates as Array<Record<string, unknown>> | undefined) ?? []
    const out: GeneratedImage[] = []
    for (const c of cands) {
      const parts =
        ((c.content as { parts?: Array<Record<string, unknown>> } | undefined)
          ?.parts as Array<Record<string, unknown>> | undefined) ?? []
      for (const p of parts) {
        const inline =
          (p.inlineData as { data?: string; mimeType?: string } | undefined) ??
          (p.inline_data as { data?: string; mime_type?: string } | undefined)
        if (!inline?.data) continue
        const m =
          (inline as { mimeType?: string }).mimeType ??
          (inline as { mime_type?: string }).mime_type ??
          "image/png"
        out.push({ path: `data:${m};base64,${inline.data}`, revised_prompt: null })
      }
    }
    return out
  }

  // OpenAI edits: multipart to /v1/images/edits.
  const form = new FormData()
  form.append("model", o.model ?? "gpt-image-1")
  form.append("prompt", o.prompt)
  form.append("n", String(o.n ?? 1))
  form.append("image", o.image, imageFilename(o.image))
  if (o.mask) form.append("mask", o.mask, imageFilename(o.mask, "mask"))
  if (o.size && o.size !== "auto") form.append("size", o.size)

  const upstream = `${trimSlash(o.baseUrl)}/v1/images/edits`
  if (o.useShared) {
    const token = await submitJob(`/api/images/jobs/openai/edits`, {
      method: "POST",
      headers: {
        "X-Use-Shared": "1",
        "X-Upstream-Model": o.model ?? "",
      },
      body: form,
      credentials: "same-origin",
      signal: o.signal,
    })
    return pollImageJob(token, o.signal)
  }
  if (useProxy) {
    const token = await submitJob(`/api/images/jobs/openai/edits`, {
      method: "POST",
      headers: {
        "X-Upstream-Url": upstream,
        "X-Upstream-Key": o.apiKey,
      },
      body: form,
      credentials: "same-origin",
      signal: o.signal,
    })
    return pollImageJob(token, o.signal)
  }
  const res = await fetch(upstream, {
    method: "POST",
    headers: { Authorization: `Bearer ${o.apiKey}` },
    body: form,
    signal: o.signal,
  })
  if (!res.ok) {
    const text = await res.text().catch(() => res.statusText)
    throw new Error(text || `HTTP ${res.status}`)
  }
  const json = (await res.json()) as Record<string, unknown>
  const raw = (json.data as Array<Record<string, unknown>> | undefined) ?? []
  return raw.map((d) => ({
    path: d.b64_json
      ? `data:image/png;base64,${d.b64_json as string}`
      : ((d.url as string | undefined) ?? ""),
    revised_prompt: (d.revised_prompt as string | undefined) ?? null,
  }))
}

function imageFilename(b: Blob, fallback = "image"): string {
  const name = (b as File).name
  if (name) return name
  const ext = b.type === "image/webp" ? "webp" : b.type === "image/jpeg" ? "jpg" : "png"
  return `${fallback}.${ext}`
}
