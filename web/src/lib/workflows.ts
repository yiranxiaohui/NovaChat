export type WorkflowNodeType =
  | "image_generation"
  | "video_generation"
  | "video_trim"
  | "video_merge"

export type WorkflowNodeData = Record<string, string | number>

export type WorkflowNode = {
  id: string
  type: WorkflowNodeType
  x: number
  y: number
  data: WorkflowNodeData
}

export type WorkflowEdge = {
  id: string
  source: string
  target: string
  priority?: number
}

export type WorkflowGraph = {
  version: 1
  nodes: WorkflowNode[]
  edges: WorkflowEdge[]
}

export type Workflow = {
  id: number
  name: string
  graph: WorkflowGraph
  created_at: string
  updated_at: string
}

export type WorkflowNodeRun = {
  node_id: string
  node_type: WorkflowNodeType
  status:
    | "waiting"
    | "starting"
    | "running"
    | "completed"
    | "failed"
    | "blocked"
    | "cancelled"
  job_token: string | null
  output_paths: string[]
  error: string | null
  started_at: string | null
  finished_at: string | null
}

export type WorkflowRunLog = {
  id: number
  node_id: string | null
  level: "info" | "success" | "warning" | "error"
  message: string
  created_at: string
}

export type WorkflowRun = {
  token: string
  workflow_id: number | null
  name: string
  graph: WorkflowGraph
  status: "running" | "completed" | "failed" | "cancelled"
  error: string | null
  created_at: string
  finished_at: string | null
  nodes: WorkflowNodeRun[]
  logs: WorkflowRunLog[]
}

async function jsonOrThrow<T>(response: Response): Promise<T> {
  if (!response.ok) {
    const body = await response.text().catch(() => response.statusText)
    let message = body
    try {
      message = (JSON.parse(body) as { error?: string }).error || body
    } catch {
      // Plain-text errors are returned by a few existing generation endpoints.
    }
    throw new Error(message || `HTTP ${response.status}`)
  }
  return response.json() as Promise<T>
}

export const workflowApi = {
  async list(): Promise<Workflow[]> {
    return jsonOrThrow(
      await fetch("/api/workflows", { credentials: "same-origin" })
    )
  },

  async save(
    id: number | null,
    name: string,
    graph: WorkflowGraph
  ): Promise<{ id: number }> {
    return jsonOrThrow(
      await fetch("/api/workflows", {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id, name, graph }),
      })
    )
  },

  async remove(id: number): Promise<void> {
    const response = await fetch(`/api/workflows/${id}`, {
      method: "DELETE",
      credentials: "same-origin",
    })
    if (!response.ok) throw new Error(await response.text())
  },

  async start(id: number): Promise<{ token: string }> {
    return jsonOrThrow(
      await fetch(`/api/workflows/${id}/runs`, {
        method: "POST",
        credentials: "same-origin",
      })
    )
  },

  async run(token: string): Promise<WorkflowRun> {
    return jsonOrThrow(
      await fetch(`/api/workflow-runs/${encodeURIComponent(token)}`, {
        credentials: "same-origin",
      })
    )
  },

  async listRuns(): Promise<WorkflowRun[]> {
    return jsonOrThrow(
      await fetch("/api/workflow-runs", { credentials: "same-origin" })
    )
  },

  async cancel(token: string): Promise<void> {
    const response = await fetch(
      `/api/workflow-runs/${encodeURIComponent(token)}/cancel`,
      { method: "POST", credentials: "same-origin" }
    )
    if (!response.ok) throw new Error(await response.text())
  },

  async retryNode(token: string, nodeId: string): Promise<void> {
    const response = await fetch(
      `/api/workflow-runs/${encodeURIComponent(token)}/nodes/${encodeURIComponent(nodeId)}/retry`,
      { method: "POST", credentials: "same-origin" }
    )
    if (!response.ok) throw new Error(await response.text())
  },
}
