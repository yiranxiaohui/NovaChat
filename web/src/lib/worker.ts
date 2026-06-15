async function jsonOrThrow<T>(res: Response): Promise<T> {
  if (!res.ok) {
    const text = await res.text().catch(() => res.statusText)
    throw new Error(text || `HTTP ${res.status}`)
  }
  return res.json() as Promise<T>
}

export interface Worker {
  id: number
  name: string
  last_seen_at: string | null
  online: boolean
}

export interface WorkerSession {
  id: number
  worker_id: number
  title: string
  updated_at: string
}

export interface WorkerMessage {
  id: number
  role: string
  content: string
  created_at: string
}

export type AgentEventType =
  | "text" | "tool_call" | "approval_required" | "tool_result" | "done" | "error"

export interface AgentEvent {
  type: AgentEventType
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  data: any
}

export const workerApi = {
  async pair(): Promise<{ token: string }> {
    return jsonOrThrow(
      await fetch("/api/worker/pair", { method: "POST", credentials: "same-origin" })
    )
  },
  async list(): Promise<Worker[]> {
    return jsonOrThrow(await fetch("/api/worker/list", { credentials: "same-origin" }))
  },
  async rename(id: number, name: string): Promise<void> {
    await jsonOrThrow(
      await fetch(`/api/worker/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name }),
        credentials: "same-origin",
      })
    )
  },
  async remove(id: number): Promise<void> {
    await jsonOrThrow(
      await fetch(`/api/worker/${id}`, { method: "DELETE", credentials: "same-origin" })
    )
  },
  async createSession(worker_id: number): Promise<{ id: number }> {
    return jsonOrThrow(
      await fetch("/api/worker/sessions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ worker_id }),
        credentials: "same-origin",
      })
    )
  },
  async sessions(): Promise<WorkerSession[]> {
    return jsonOrThrow(
      await fetch("/api/worker/sessions", { credentials: "same-origin" })
    )
  },
  async messages(sid: number): Promise<WorkerMessage[]> {
    return jsonOrThrow(
      await fetch(`/api/worker/sessions/${sid}/messages`, { credentials: "same-origin" })
    )
  },
  async approve(sid: number, call_id: string, decision: boolean): Promise<void> {
    await jsonOrThrow(
      await fetch(`/api/worker/sessions/${sid}/approve`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ call_id, decision }),
        credentials: "same-origin",
      })
    )
  },
}

/**
 * 发起一轮 agent 会话。逐事件回调，返回中断函数。
 * 用 fetch + ReadableStream 手动解析 SSE（因为是 POST，EventSource 不适用）。
 */
export function sendAgentMessage(
  sid: number,
  body: { worker_id: number; model: string; text: string; auto_approve: boolean },
  onEvent: (e: AgentEvent) => void
): () => void {
  const ctrl = new AbortController()
  ;(async () => {
    const resp = await fetch(`/api/worker/sessions/${sid}/message`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      credentials: "same-origin",
      signal: ctrl.signal,
    })
    if (!resp.body) {
      onEvent({ type: "error", data: "无响应流" })
      return
    }
    const reader = resp.body.getReader()
    const decoder = new TextDecoder()
    let buf = ""
    let evName = "message"
    for (;;) {
      const { value, done } = await reader.read()
      if (done) break
      buf += decoder.decode(value, { stream: true })
      // SSE 事件以空行分隔；逐行解析
      const lines = buf.split("\n")
      buf = lines.pop() ?? ""
      for (const rawLine of lines) {
        const line = rawLine.replace(/\r$/, "")
        if (line === "") { evName = "message"; continue }
        if (line.startsWith("event:")) {
          evName = line.slice(6).trim()
        } else if (line.startsWith("data:")) {
          const raw = line.slice(5).trim()
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          let data: any = raw
          try { data = JSON.parse(raw) } catch { /* 纯文本保留原样 */ }
          onEvent({ type: evName as AgentEventType, data })
        }
      }
    }
  })().catch((e) => {
    if ((e as Error)?.name !== "AbortError") {
      onEvent({ type: "error", data: String(e) })
    }
  })
  return () => ctrl.abort()
}

/**
 * 把历史 WorkerMessage[] 重建为 AgentEvent[]，供历史回看渲染。
 *
 * 存储约定（来自 src/worker.rs）：
 *   role "user"      → content 是纯文本
 *   role "assistant" → content 是 Anthropic content-block 数组的序列化 JSON
 *                      block: {type:"text", text} | {type:"tool_use", id, name, input}
 *   role "tool"      → content 是 {tool_use_id, ok, output} 的序列化 JSON
 */
export function replayMessages(rows: WorkerMessage[]): AgentEvent[] {
  const out: AgentEvent[] = []
  for (const m of rows) {
    if (m.role === "user") {
      out.push({ type: "text", data: `🧑 ${m.content}` })
      continue
    }
    if (m.role === "assistant") {
      let blocks: unknown
      try {
        blocks = JSON.parse(m.content)
      } catch {
        out.push({ type: "text", data: m.content })
        continue
      }
      if (Array.isArray(blocks)) {
        for (const b of blocks as Array<Record<string, unknown>>) {
          if (b?.type === "text" && typeof b.text === "string") {
            out.push({ type: "text", data: b.text })
          } else if (b?.type === "tool_use") {
            out.push({
              type: "tool_call",
              data: { tool: b.name, input: b.input, call_id: b.id },
            })
          }
        }
      } else {
        out.push({ type: "text", data: m.content })
      }
      continue
    }
    if (m.role === "tool") {
      // 存储格式: {tool_use_id, ok, output}
      let output = m.content
      let ok: boolean | undefined
      try {
        const v = JSON.parse(m.content) as Record<string, unknown>
        if (typeof v.ok === "boolean") ok = v.ok
        if (typeof v.output === "string") {
          output = v.output
        } else if (typeof v.content === "string") {
          // 兜底：Anthropic 风格 content 字符串
          output = v.content
        } else if (Array.isArray(v.content)) {
          // 兜底：Anthropic 风格 content block 数组，拼接 text 字段
          output = (v.content as Array<Record<string, unknown>>)
            .map((blk) => (typeof blk.text === "string" ? blk.text : ""))
            .join("")
        }
      } catch {
        /* 保留原始文本 */
      }
      out.push({ type: "tool_result", data: { ok, output } })
      continue
    }
    // 未知 role，作为文本降级
    out.push({ type: "text", data: m.content })
  }
  return out
}
