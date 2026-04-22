export type Prompt = {
  id: number
  name: string
  content: string
  is_public: boolean
  created_at: string
  updated_at: string
}

export type PublicPrompt = {
  id: number
  name: string
  content: string
  author_username: string
  created_at: string
  clone_count: number
}

export type PublicSort = "hot" | "new"

export type Prefs = {
  default_prompt_id: number | null
}

export type ImportResult = {
  imported: number
  skipped: number
  errors: string[]
}

async function jsonOrThrow<T>(res: Response): Promise<T> {
  if (!res.ok) {
    const text = await res.text().catch(() => res.statusText)
    throw new Error(text || `HTTP ${res.status}`)
  }
  return res.json() as Promise<T>
}

async function okOrThrow(res: Response): Promise<void> {
  if (!res.ok) {
    const text = await res.text().catch(() => res.statusText)
    throw new Error(text || `HTTP ${res.status}`)
  }
}

export const promptsApi = {
  async list(): Promise<Prompt[]> {
    return jsonOrThrow(
      await fetch("/api/prompts", { credentials: "same-origin" })
    )
  },
  async create(name: string, content: string): Promise<Prompt> {
    return jsonOrThrow(
      await fetch("/api/prompts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, content }),
        credentials: "same-origin",
      })
    )
  },
  async update(
    id: number,
    patch: { name?: string; content?: string; is_public?: boolean }
  ): Promise<void> {
    await okOrThrow(
      await fetch(`/api/prompts/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(patch),
        credentials: "same-origin",
      })
    )
  },
  async listPublic(
    opts: { search?: string; page?: number; sort?: PublicSort } = {}
  ): Promise<PublicPrompt[]> {
    const params = new URLSearchParams()
    if (opts.search) params.set("search", opts.search)
    if (opts.page) params.set("page", String(opts.page))
    if (opts.sort) params.set("sort", opts.sort)
    const qs = params.toString() ? `?${params.toString()}` : ""
    return jsonOrThrow(
      await fetch(`/api/prompts/public${qs}`, { credentials: "same-origin" })
    )
  },
  async clonePublic(id: number): Promise<Prompt> {
    return jsonOrThrow(
      await fetch(`/api/prompts/${id}/clone`, {
        method: "POST",
        credentials: "same-origin",
      })
    )
  },
  exportUrl(): string {
    return "/api/prompts/export"
  },
  async importBundle(
    bundle: { version?: number; prompts: Array<{ name: string; content: string }> }
  ): Promise<ImportResult> {
    return jsonOrThrow(
      await fetch("/api/prompts/import", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(bundle),
        credentials: "same-origin",
      })
    )
  },
  async remove(id: number): Promise<void> {
    await okOrThrow(
      await fetch(`/api/prompts/${id}`, {
        method: "DELETE",
        credentials: "same-origin",
      })
    )
  },
  async prefs(): Promise<Prefs> {
    return jsonOrThrow(
      await fetch("/api/prefs", { credentials: "same-origin" })
    )
  },
  async setDefault(default_prompt_id: number | null): Promise<void> {
    await okOrThrow(
      await fetch("/api/prefs", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ default_prompt_id }),
        credentials: "same-origin",
      })
    )
  },
}
