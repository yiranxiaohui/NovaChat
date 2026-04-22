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
}

type PreparedRequest = {
  url: string
  body: unknown
  directHeaders: Record<string, string>
}

function prepareOpenAi(o: ChatStreamOptions): PreparedRequest {
  return {
    url: `${trimSlash(o.baseUrl)}/v1/chat/completions`,
    body: {
      model: o.model,
      messages: o.messages,
      stream: true,
      ...(o.temperature !== undefined ? { temperature: o.temperature } : {}),
      ...(o.webSearch ? { tools: [{ type: "web_search" }] } : {}),
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
          const json = JSON.parse(data)
          const delta = extractDelta(o.protocol, json)
          if (delta) o.onDelta(delta)
        } catch {
          // tolerate keep-alive / non-json frames
        }
      }
    }
  }
}
