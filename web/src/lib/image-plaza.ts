export type PlazaImage = {
  id: number
  filename: string
  prompt: string
  revised_prompt: string | null
  clone_count: number
  created_at: string
  author_username: string
}

export type MyPlazaImage = {
  id: number
  filename: string
  prompt: string
  revised_prompt: string | null
  clone_count: number
  created_at: string
}

export type PlazaSort = "hot" | "new"

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

/**
 * Extracts the server-stored filename from a markdown-safe image path.
 * Only `/api/images/<name>` URLs are publishable (data: URLs and remote
 * URLs aren't stored on our server).
 */
export function filenameFromPath(path: string): string | null {
  const m = path.match(/^\/api\/images\/([A-Za-z0-9._-]+)$/)
  return m ? m[1]! : null
}

export const plazaApi = {
  async listPublic(
    opts: { search?: string; page?: number; sort?: PlazaSort } = {}
  ): Promise<PlazaImage[]> {
    const params = new URLSearchParams()
    if (opts.search) params.set("search", opts.search)
    if (opts.page) params.set("page", String(opts.page))
    if (opts.sort) params.set("sort", opts.sort)
    const qs = params.toString() ? `?${params.toString()}` : ""
    return jsonOrThrow(
      await fetch(`/api/plaza/images${qs}`, { credentials: "same-origin" })
    )
  },
  async listMine(): Promise<MyPlazaImage[]> {
    return jsonOrThrow(
      await fetch(`/api/plaza/images/mine`, { credentials: "same-origin" })
    )
  },
  async publish(input: {
    filename: string
    prompt: string
    revised_prompt?: string | null
  }): Promise<MyPlazaImage> {
    return jsonOrThrow(
      await fetch(`/api/plaza/images`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          filename: input.filename,
          prompt: input.prompt,
          revised_prompt: input.revised_prompt ?? null,
        }),
        credentials: "same-origin",
      })
    )
  },
  async remove(id: number): Promise<void> {
    await okOrThrow(
      await fetch(`/api/plaza/images/${id}`, {
        method: "DELETE",
        credentials: "same-origin",
      })
    )
  },
  async bumpClone(id: number): Promise<void> {
    await okOrThrow(
      await fetch(`/api/plaza/images/${id}/clone`, {
        method: "POST",
        credentials: "same-origin",
      })
    )
  },
}
