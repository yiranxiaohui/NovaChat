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
  temperature?: number
  maxTokens?: number
  signal?: AbortSignal
  onDelta: (delta: string) => void
  // When set (OpenAI-protocol only), declares a `generate_image` function
  // tool in the /v1/responses request. Invoked when the model emits a
  // `function_call` for that function. Should return a markdown snippet
  // (e.g. `![prompt](/api/images/xxx.png)`) to splice into the assistant
  // message as if it were streamed text.
  onImageToolCall?: (args: {
    prompt: string
    size?: string
  }) => Promise<string>
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
  if (o.onImageToolCall) {
    tools.push({
      type: "function",
      name: "generate_image",
      description:
        "Generate an image from a text prompt. Call this when the user asks to draw, create, or edit an image.",
      parameters: {
        type: "object",
        properties: {
          prompt: {
            type: "string",
            description: "A detailed English prompt describing the image.",
          },
          size: {
            type: "string",
            description: "Image dimensions in WxH format, e.g. 1024x1024.",
          },
        },
        required: ["prompt"],
      },
    })
  }
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

  // Pending function-call invocations collected during the stream. We run
  // them after the stream ends so we don't stall the reader (some upstreams
  // buffer the final [DONE] until the client drains all bytes).
  type PendingCall = { name: string; args: string }
  const pendingCalls: PendingCall[] = []

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
          if (
            o.protocol === "openai" &&
            json.type === "response.function_call_arguments.done"
          ) {
            // Some relays send the function name on the output_item.added
            // event; others repeat it here. Resolve it from whichever
            // field is present.
            const name =
              (json.name as string | undefined) ??
              ((json.item as { name?: string } | undefined)?.name ?? "")
            const args = (json.arguments as string | undefined) ?? ""
            pendingCalls.push({ name, args })
            continue
          }
          if (
            o.protocol === "openai" &&
            json.type === "response.output_item.done"
          ) {
            // Fallback: some streams only surface the full function_call on
            // output_item.done, not on arguments.done.
            const item = json.item as
              | { type?: string; name?: string; arguments?: string }
              | undefined
            if (item?.type === "function_call" && item.name && item.arguments) {
              pendingCalls.push({ name: item.name, args: item.arguments })
            }
            continue
          }
          const delta = extractDelta(o.protocol, json)
          if (delta) o.onDelta(delta)
        } catch {
          // tolerate keep-alive / non-json frames
        }
      }
    }
  }

  // Execute any collected function calls sequentially. Each returns a
  // markdown snippet we splice in via onDelta so the UI renders it inline.
  if (pendingCalls.length && o.onImageToolCall) {
    const seen = new Set<string>()
    for (const c of pendingCalls) {
      if (c.name !== "generate_image") continue
      // Dedupe — function_call_arguments.done and output_item.done often
      // both fire for the same call.
      const key = `${c.name}:${c.args}`
      if (seen.has(key)) continue
      seen.add(key)
      let parsed: { prompt?: string; size?: string } = {}
      try {
        parsed = JSON.parse(c.args) as { prompt?: string; size?: string }
      } catch {
        continue
      }
      if (!parsed.prompt) continue
      try {
        const md = await o.onImageToolCall({
          prompt: parsed.prompt,
          size: parsed.size,
        })
        if (md) o.onDelta(md)
      } catch (e) {
        o.onDelta(
          `\n\n> 图像生成失败：${e instanceof Error ? e.message : String(e)}`
        )
      }
    }
  }
}
