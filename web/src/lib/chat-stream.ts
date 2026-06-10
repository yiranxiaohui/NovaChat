import type { Protocol } from "./settings"
import { trimSlash } from "./settings"

export type ChatMessage = { role: "system" | "user" | "assistant"; content: string }

// --- attachment handling -------------------------------------------------
// User messages can embed markdown image refs like `![](/api/images/x.png)`
// or data URLs. We strip them out for the text sent to the model and
// upload each referenced image as a base64 `input_image` part.

type ExtractedImages = { text: string; images: string[] }

function extractImages(md: string): ExtractedImages {
  const images: string[] = []
  const text = md
    .replace(/!\[[^\]]*\]\(([^)]+)\)/g, (_m, p1: string) => {
      if (p1) images.push(p1)
      return ""
    })
    .trim()
  return { text, images }
}

// Document attachments are embedded in user messages as ordinary markdown
// links whose URL points at our own `/api/files/` store, e.g.
// `[report.pdf](/api/files/ab12.pdf)`. We strip them from the prompt text and
// re-attach each as a native document block for the active protocol.
type FileRef = { name: string; url: string }
type ExtractedFiles = { text: string; files: FileRef[] }

function extractFiles(md: string): ExtractedFiles {
  const files: FileRef[] = []
  const text = md
    .replace(
      /\[([^\]]*)\]\((\/api\/files\/[^)\s]+)\)/g,
      (_m, name: string, url: string) => {
        if (url) files.push({ name: name || "file", url })
        return ""
      }
    )
    .trim()
  return { text, files }
}

function isPdf(mime: string): boolean {
  return mime === "application/pdf" || mime.startsWith("application/pdf")
}

function isTextual(mime: string): boolean {
  return (
    mime.startsWith("text/") ||
    mime === "application/json" ||
    mime === "application/xml" ||
    mime === "application/x-yaml" ||
    mime === "application/javascript"
  )
}

async function fileRefToText(url: string): Promise<string | null> {
  try {
    const res = await fetch(url, { credentials: "same-origin" })
    if (!res.ok) return null
    return await res.text()
  } catch {
    return null
  }
}

/** Assistant content sometimes embeds markdown image refs (notably the OpenAI
 * Responses `image_generation` tool dumps `![alt](/api/images/…png)` into the
 * assistant message after it generates an image). None of OpenAI / Claude /
 * Gemini accept image content blocks under the assistant role on a follow-up
 * turn — sending them back causes a 400 and effectively bricks the
 * conversation. Strip the refs and replace with a short text marker so the
 * model still knows "I generated an image here" without re-uploading the
 * bitmap. */
function sanitizeAssistantContent(content: string): string {
  const { text, images } = extractImages(content)
  if (images.length === 0) return content
  const marker =
    images.length === 1
      ? "[已生成图像]"
      : `[已生成 ${images.length} 张图像]`
  return text ? `${text}\n\n${marker}` : marker
}

function mimeFromPath(path: string): string {
  const ext = path.split(".").pop()?.toLowerCase() ?? ""
  if (ext === "jpg" || ext === "jpeg") return "image/jpeg"
  if (ext === "webp") return "image/webp"
  if (ext === "gif") return "image/gif"
  return "image/png"
}

async function refToBase64(ref: string): Promise<{ mime: string; b64: string } | null> {
  // data URL: pass the base64 payload through.
  if (ref.startsWith("data:")) {
    const m = /^data:([^;]+);base64,(.*)$/.exec(ref)
    if (!m) return null
    return { mime: m[1], b64: m[2] }
  }
  try {
    const res = await fetch(ref, { credentials: "same-origin" })
    if (!res.ok) return null
    const blob = await res.blob()
    const mime = blob.type || mimeFromPath(ref)
    const buf = await blob.arrayBuffer()
    const bytes = new Uint8Array(buf)
    let bin = ""
    const chunk = 0x8000
    for (let i = 0; i < bytes.length; i += chunk) {
      bin += String.fromCharCode(...bytes.subarray(i, i + chunk))
    }
    return { mime, b64: btoa(bin) }
  } catch {
    return null
  }
}

async function refToDataUrl(ref: string): Promise<string | null> {
  if (ref.startsWith("data:")) return ref
  const enc = await refToBase64(ref)
  return enc ? `data:${enc.mime};base64,${enc.b64}` : null
}

export type ChatStreamOptions = {
  protocol: Protocol
  baseUrl: string
  apiKey: string
  model: string
  messages: ChatMessage[]
  useProxy?: boolean
  /**
   * When true, route through `/api/proxy/*` WITHOUT sending
   * `X-Upstream-Url/Key` headers — the server resolves an admin-configured
   * channel chain for the model and deducts credits. When false (default),
   * BYOK: the client supplies its own upstream creds via headers.
   */
  usePlatform?: boolean
  webSearch?: boolean
  // OpenAI protocol only. Declares the hosted `image_generation` tool on
  // the /v1/responses request so the model can emit images inline during
  // a normal chat turn. When an `image_generation_call` completes, its
  // base64 bytes are uploaded to /api/images/save and a markdown image
  // reference is spliced into the assistant message.
  imageGen?: boolean
  temperature?: number
  maxTokens?: number
  signal?: AbortSignal
  onDelta: (delta: string) => void
  // Apply a transformation to the current assistant message content. Used
  // by the hosted image_generation flow to show a ticking "生成图像中…"
  // placeholder without persisting it into the saved message content.
  patchAssistant?: (update: (prev: string) => string) => void
}

type PreparedRequest = {
  url: string
  body: unknown
  directHeaders: Record<string, string>
}

async function prepareOpenAi(o: ChatStreamOptions): Promise<PreparedRequest> {
  const system = o.messages
    .filter((m) => m.role === "system")
    .map((m) => m.content)
    .join("\n\n")
  const nonSystem = o.messages.filter((m) => m.role !== "system")
  const input = await Promise.all(
    nonSystem.map(async (m) => {
      const content =
        m.role === "assistant" ? sanitizeAssistantContent(m.content) : m.content
      const { text: t0, images } = extractImages(content)
      const { text, files } =
        m.role === "user" ? extractFiles(t0) : { text: t0, files: [] }
      if (images.length === 0 && files.length === 0) {
        return { role: m.role, content }
      }
      const parts: unknown[] = []
      if (text) {
        parts.push({
          type: m.role === "assistant" ? "output_text" : "input_text",
          text,
        })
      }
      for (const ref of images) {
        const durl = await refToDataUrl(ref)
        if (durl) parts.push({ type: "input_image", image_url: durl })
      }
      for (const f of files) {
        const durl = await refToDataUrl(f.url)
        if (durl)
          parts.push({ type: "input_file", filename: f.name, file_data: durl })
      }
      return { role: m.role, content: parts }
    })
  )
  const tools: unknown[] = []
  if (o.webSearch) tools.push({ type: "web_search" })
  if (o.imageGen) tools.push({ type: "image_generation" })
  return {
    url: `${trimSlash(o.baseUrl)}/v1/responses`,
    body: {
      model: o.model,
      input,
      stream: true,
      ...(system ? { instructions: system } : {}),
      ...(o.temperature !== undefined ? { temperature: o.temperature } : {}),
      ...(tools.length ? { tools } : {}),
    },
    directHeaders: {
      Authorization: `Bearer ${o.apiKey}`,
    },
  }
}

async function prepareClaude(o: ChatStreamOptions): Promise<PreparedRequest> {
  const system = o.messages
    .filter((m) => m.role === "system")
    .map((m) => m.content)
    .join("\n\n")
  const nonSystem = o.messages.filter((m) => m.role !== "system")
  const rest = await Promise.all(
    nonSystem.map(async (m) => {
      const content =
        m.role === "assistant" ? sanitizeAssistantContent(m.content) : m.content
      const { text: t0, images } = extractImages(content)
      const { text, files } =
        m.role === "user" ? extractFiles(t0) : { text: t0, files: [] }
      if (images.length === 0 && files.length === 0) {
        return { role: m.role, content }
      }
      const parts: unknown[] = []
      if (text) parts.push({ type: "text", text })
      for (const ref of images) {
        const enc = await refToBase64(ref)
        if (enc) {
          parts.push({
            type: "image",
            source: { type: "base64", media_type: enc.mime, data: enc.b64 },
          })
        }
      }
      for (const f of files) {
        const enc = await refToBase64(f.url)
        if (!enc) continue
        if (isPdf(enc.mime)) {
          parts.push({
            type: "document",
            source: { type: "base64", media_type: "application/pdf", data: enc.b64 },
            title: f.name,
          })
        } else if (isTextual(enc.mime)) {
          const raw = await fileRefToText(f.url)
          if (raw != null) {
            parts.push({
              type: "document",
              source: { type: "text", media_type: "text/plain", data: raw },
              title: f.name,
            })
          }
        }
      }
      return { role: m.role, content: parts }
    })
  )
  return {
    url: `${trimSlash(o.baseUrl)}/v1/messages`,
    body: {
      model: o.model,
      max_tokens: o.maxTokens ?? 4096,
      messages: rest,
      stream: true,
      ...(system ? { system } : {}),
      ...(o.temperature !== undefined ? { temperature: o.temperature } : {}),
      ...(o.webSearch
        ? {
            tools: [
              {
                type: "web_search_20250305",
                name: "web_search",
                max_uses: 5,
              },
            ],
          }
        : {}),
    },
    directHeaders: {
      "x-api-key": o.apiKey,
      "anthropic-version": "2023-06-01",
      "anthropic-dangerous-direct-browser-access": "true",
    },
  }
}

async function prepareGemini(o: ChatStreamOptions): Promise<PreparedRequest> {
  const system = o.messages
    .filter((m) => m.role === "system")
    .map((m) => m.content)
    .join("\n\n")
  const nonSystem = o.messages.filter((m) => m.role !== "system")
  const contents = await Promise.all(
    nonSystem.map(async (m) => {
      const content =
        m.role === "assistant" ? sanitizeAssistantContent(m.content) : m.content
      const { text: t0, images } = extractImages(content)
      const { text, files } =
        m.role === "user" ? extractFiles(t0) : { text: t0, files: [] }
      const parts: unknown[] = []
      if (text || (images.length === 0 && files.length === 0)) {
        parts.push({ text: text || content })
      }
      for (const ref of images) {
        const enc = await refToBase64(ref)
        if (enc) {
          parts.push({ inline_data: { mime_type: enc.mime, data: enc.b64 } })
        }
      }
      for (const f of files) {
        const enc = await refToBase64(f.url)
        if (enc && (isPdf(enc.mime) || isTextual(enc.mime))) {
          parts.push({ inline_data: { mime_type: enc.mime, data: enc.b64 } })
        }
      }
      return {
        role: m.role === "assistant" ? "model" : "user",
        parts,
      }
    })
  )
  const generationConfig =
    o.temperature !== undefined || o.maxTokens !== undefined
      ? {
          ...(o.temperature !== undefined ? { temperature: o.temperature } : {}),
          ...(o.maxTokens !== undefined ? { maxOutputTokens: o.maxTokens } : {}),
        }
      : undefined
  return {
    url: `${trimSlash(o.baseUrl)}/v1beta/models/${encodeURIComponent(
      o.model
    )}:streamGenerateContent?alt=sse`,
    body: {
      contents,
      ...(system ? { systemInstruction: { parts: [{ text: system }] } } : {}),
      ...(generationConfig ? { generationConfig } : {}),
      ...(o.webSearch ? { tools: [{ google_search: {} }] } : {}),
    },
    directHeaders: {
      "x-goog-api-key": o.apiKey,
    },
  }
}

function prepare(o: ChatStreamOptions): Promise<PreparedRequest> {
  switch (o.protocol) {
    case "openai":
      return prepareOpenAi(o)
    case "claude":
      return prepareClaude(o)
    case "gemini":
      return prepareGemini(o)
  }
}

function extractDelta(protocol: Protocol, json: unknown): string | undefined {
  const j = json as Record<string, unknown>
  switch (protocol) {
    case "openai": {
      // Responses API stream events carry a `type` field; text chunks come
      // through as `response.output_text.delta` with a string `delta`.
      if (j.type === "response.output_text.delta") {
        return typeof j.delta === "string" ? j.delta : undefined
      }
      // Tolerate relays that still emit chat-completions-style chunks via
      // the /v1/responses endpoint.
      const choices = (j.choices ?? []) as Array<{ delta?: { content?: string } }>
      return choices[0]?.delta?.content
    }
    case "claude": {
      if (j.type === "content_block_delta") {
        const delta = j.delta as { type?: string; text?: string } | undefined
        if (delta?.type === "text_delta") return delta.text
      }
      return undefined
    }
    case "gemini": {
      const cands = (j.candidates ?? []) as Array<{
        content?: { parts?: Array<{ text?: string }> }
      }>
      const parts = cands[0]?.content?.parts ?? []
      const text = parts.map((p) => p.text ?? "").join("")
      return text || undefined
    }
  }
}

export async function streamChat(o: ChatStreamOptions): Promise<void> {
  const prepared = await prepare(o)
  const payload = JSON.stringify(prepared.body)

  let res: Response
  // Platform mode MUST go through the backend proxy: the server resolves the
  // admin-configured shared channel and deducts credits, and the browser can
  // never reach that upstream directly. Force proxy whenever usePlatform is set
  // so a stale `useProxy=false` BYOK setting can't leak us onto a direct fetch.
  if (o.useProxy || o.usePlatform) {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    }
    // BYOK: forward upstream creds via headers. Platform mode: omit headers,
    // server resolves admin channel and deducts credits.
    if (!o.usePlatform) {
      headers["X-Upstream-Url"] = prepared.url
      headers["X-Upstream-Key"] = o.apiKey
    }
    res = await fetch(`/api/proxy/${o.protocol}`, {
      method: "POST",
      headers,
      body: payload,
      credentials: "same-origin",
      signal: o.signal,
    })
  } else {
    res = await fetch(prepared.url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "text/event-stream",
        ...prepared.directHeaders,
      },
      body: payload,
      signal: o.signal,
    })
  }

  if (!res.ok || !res.body) {
    const text = await res.text().catch(() => "")
    throw new Error(`HTTP ${res.status}: ${text || res.statusText}`)
  }

  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ""

  // State for the ticking "生成图像中…" placeholder shown while the hosted
  // image_generation tool is working. `imgPrefix` is the assistant content
  // snapshot taken at the moment generation started; the placeholder is
  // appended to it every tick and wiped when the tool completes.
  let imgPrefix: string | null = null
  let imgStartedAt = 0
  let imgTicker: ReturnType<typeof setInterval> | null = null

  const placeholderFor = (prefix: string, secs: number): string => {
    const sep = prefix ? "\n\n" : ""
    return `${prefix}${sep}🎨 生成图像中…（已等 ${secs}s）`
  }

  const startImgPlaceholder = () => {
    if (imgTicker != null || !o.patchAssistant) return
    imgStartedAt = Date.now()
    o.patchAssistant((prev) => {
      imgPrefix = prev
      return placeholderFor(prev, 0)
    })
    imgTicker = setInterval(() => {
      if (imgPrefix == null || !o.patchAssistant) return
      const secs = Math.floor((Date.now() - imgStartedAt) / 1000)
      const prefix = imgPrefix
      o.patchAssistant(() => placeholderFor(prefix, secs))
    }, 1000)
  }

  const stopImgPlaceholder = () => {
    if (imgTicker != null) {
      clearInterval(imgTicker)
      imgTicker = null
    }
    if (imgPrefix != null && o.patchAssistant) {
      const prefix = imgPrefix
      o.patchAssistant(() => prefix)
    }
    imgPrefix = null
  }

  while (true) {
    const { value, done } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })

    let sep: number
    while ((sep = buffer.indexOf("\n\n")) !== -1) {
      const rawEvent = buffer.slice(0, sep)
      buffer = buffer.slice(sep + 2)
      for (const line of rawEvent.split("\n")) {
        if (!line.startsWith("data:")) continue
        const data = line.slice(5).trim()
        if (!data || data === "[DONE]") continue
        try {
          const json = JSON.parse(data) as Record<string, unknown>
          if (o.protocol === "openai") {
            const ty = json.type as string | undefined
            // Generation kicking off — show the ticking placeholder.
            if (ty === "response.output_item.added") {
              const item = json.item as { type?: string } | undefined
              if (item?.type === "image_generation_call") {
                startImgPlaceholder()
                continue
              }
            }
            // Generation finished — stop the ticker, persist the image,
            // and splice its markdown reference into the assistant bubble.
            if (ty === "response.output_item.done") {
              const item = json.item as
                | {
                    type?: string
                    result?: string
                    revised_prompt?: string
                  }
                | undefined
              if (item?.type === "image_generation_call") {
                stopImgPlaceholder()
                if (item.result) {
                  await persistImageGenerationCall(item, o.onDelta)
                }
                continue
              }
            }
          }
          const delta = extractDelta(o.protocol, json)
          if (delta) o.onDelta(delta)
        } catch {
          // tolerate keep-alive / non-json frames
        }
      }
    }
  }

  // If the stream ends mid-generation (upstream closed, aborted, etc.),
  // make sure the placeholder gets cleaned up.
  stopImgPlaceholder()
}

async function persistImageGenerationCall(
  item: { result?: string; revised_prompt?: string },
  onDelta: (delta: string) => void
): Promise<void> {
  if (!item.result) return
  const alt = (item.revised_prompt || "image").replace(/[\[\]]/g, "")
  try {
    const res = await fetch("/api/images/save", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ b64: item.result, mime: "image/png" }),
      credentials: "same-origin",
    })
    if (res.ok) {
      const j = (await res.json()) as { path: string }
      onDelta(`\n\n![${alt}](${j.path})`)
    } else {
      const text = await res.text().catch(() => res.statusText)
      onDelta(`\n\n> 图像保存失败：${text || `HTTP ${res.status}`}`)
    }
  } catch (e) {
    onDelta(
      `\n\n> 图像保存失败：${e instanceof Error ? e.message : String(e)}`
    )
  }
}
