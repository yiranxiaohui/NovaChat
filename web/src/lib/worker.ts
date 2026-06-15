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
