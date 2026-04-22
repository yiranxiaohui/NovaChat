import { trimSlash, type Protocol } from "./settings"

export type ListModelsOptions = {
  protocol: Protocol
  baseUrl: string
  apiKey: string
  useProxy: boolean
  signal?: AbortSignal
}

function listUrl(protocol: Protocol, baseUrl: string): string {
  const base = trimSlash(baseUrl)
  switch (protocol) {
    case "openai":
      return `${base}/v1/models`
    case "claude":
      return `${base}/v1/models`
    case "gemini":
      return `${base}/v1beta/models?pageSize=200`
  }
}

function directHeaders(protocol: Protocol, apiKey: string): Record<string, string> {
  switch (protocol) {
    case "openai":
      return { Authorization: `Bearer ${apiKey}` }
    case "claude":
      return {
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
        "anthropic-dangerous-direct-browser-access": "true",
      }
    case "gemini":
      return { "x-goog-api-key": apiKey }
  }
}

function parseModels(protocol: Protocol, json: unknown): string[] {
  const j = json as Record<string, unknown>
  switch (protocol) {
    case "openai":
    case "claude": {
      const data = (j.data ?? []) as Array<{ id?: string }>
      return data
        .map((m) => m.id)
        .filter((x): x is string => Boolean(x))
        .sort()
    }
    case "gemini": {
      const list = (j.models ?? []) as Array<{
        name?: string
        supportedGenerationMethods?: string[]
      }>
      return list
        .filter((m) =>
          (m.supportedGenerationMethods ?? []).includes("generateContent")
        )
        .map((m) => (m.name ?? "").replace(/^models\//, ""))
        .filter(Boolean)
        .sort()
    }
  }
}

export async function listModels(o: ListModelsOptions): Promise<string[]> {
  const url = listUrl(o.protocol, o.baseUrl)
  let res: Response
  if (o.useProxy) {
    res = await fetch(`/api/proxy/${o.protocol}/models`, {
      headers: {
        "X-Upstream-Url": url,
        "X-Upstream-Key": o.apiKey,
      },
      credentials: "same-origin",
      signal: o.signal,
    })
  } else {
    res = await fetch(url, {
      headers: directHeaders(o.protocol, o.apiKey),
      signal: o.signal,
    })
  }
  if (!res.ok) {
    const text = await res.text().catch(() => res.statusText)
    throw new Error(`HTTP ${res.status}: ${text}`)
  }
  return parseModels(o.protocol, await res.json())
}
