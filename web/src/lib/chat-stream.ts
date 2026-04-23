import type { Protocol } from "./settings"
import { trimSlash } from "./settings"

export type ChatMessage = { role: "system" | "user" | "assistant"; content: string }

export type ChatStreamOptions = {
  protocol: Protocol
  baseUrl: string
  apiKey: string
  model: string
  messages: ChatMessage[]
  useProxy?: boolean
  // When true, route through the server proxy targeting the site-shared
  // backend (admin-configured URL/Key); baseUrl/apiKey are ignored.
  useShared?: boolean
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

function prepareOpenAi(o: ChatStreamOptions): PreparedRequest {
  const system = o.messages
    .filter((m) => m.role === "system")
    .map((m) => m.content)
    .join("\n\n")
  const input = o.messages
    .filter((m) => m.role !== "system")
    .map((m) => ({ role: m.role, content: m.content }))
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

function prepareClaude(o: ChatStreamOptions): PreparedRequest {
  const system = o.messages
    .filter((m) => m.role === "system")
    .map((m) => m.content)
    .join("\n\n")
  const rest = o.messages
    .filter((m) => m.role !== "system")
    .map((m) => ({ role: m.role, content: m.content }))
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

function prepareGemini(o: ChatStreamOptions): PreparedRequest {
  const system = o.messages
    .filter((m) => m.role === "system")
    .map((m) => m.content)
    .join("\n\n")
  const contents = o.messages
    .filter((m) => m.role !== "system")
    .map((m) => ({
      role: m.role === "assistant" ? "model" : "user",
      parts: [{ text: m.content }],
    }))
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

function prepare(o: ChatStreamOptions): PreparedRequest {
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
  const prepared = prepare(o)
  const payload = JSON.stringify(prepared.body)

  let res: Response
  if (o.useShared) {
    // Site-shared backend: server reads admin URL/Key, we just hand over
    // the user's chosen model (Gemini needs it in the URL it builds).
    res = await fetch(`/api/proxy/${o.protocol}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Use-Shared": "1",
        "X-Upstream-Model": o.model,
      },
      body: payload,
      credentials: "same-origin",
      signal: o.signal,
    })
  } else if (o.useProxy) {
    res = await fetch(`/api/proxy/${o.protocol}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Upstream-Url": prepared.url,
        "X-Upstream-Key": o.apiKey,
      },
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
