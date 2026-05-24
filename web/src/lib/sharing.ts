export type ShareCreated = {
  token: string
  path: string
  title: string
  created_at: string
}

export type ShareListRow = {
  token: string
  conversation_id: number
  title: string
  view_count: number
  created_at: string
  expires_at: string | null
}

export type SnapshotMessage = {
  role: "system" | "user" | "assistant"
  content: string
  created_at: string
}

export type PublicSnapshot = {
  token: string
  title: string
  creator_name: string | null
  created_at: string
  system_prompt: string
  messages: SnapshotMessage[]
  view_count: number
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

export const sharingApi = {
  async create(
    conversationId: number,
    opts: { expiresInDays?: number } = {}
  ): Promise<ShareCreated> {
    return jsonOrThrow(
      await fetch(`/api/conversations/${conversationId}/share`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          expires_in_days: opts.expiresInDays ?? null,
        }),
        credentials: "same-origin",
      })
    )
  },

  async listForConversation(conversationId: number): Promise<ShareListRow[]> {
    return jsonOrThrow(
      await fetch(`/api/conversations/${conversationId}/shares`, {
        credentials: "same-origin",
      })
    )
  },

  async listMine(): Promise<ShareListRow[]> {
    return jsonOrThrow(
      await fetch("/api/my-shares", { credentials: "same-origin" })
    )
  },

  async revoke(token: string): Promise<void> {
    await okOrThrow(
      await fetch(`/api/shares/${encodeURIComponent(token)}`, {
        method: "DELETE",
        credentials: "same-origin",
      })
    )
  },

  /** Public read — no credentials, no auth. Returns the frozen snapshot. */
  async getPublic(token: string): Promise<PublicSnapshot> {
    return jsonOrThrow(
      await fetch(`/api/shared/${encodeURIComponent(token)}`)
    )
  },
}
