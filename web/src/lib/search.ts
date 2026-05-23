export type SearchHit = {
  conversation_id: number
  conversation_title: string
  message_id: number | null
  role: "system" | "user" | "assistant" | null
  snippet: string
  created_at: string
  kind: "title" | "content"
}

export const searchApi = {
  async conversations(q: string): Promise<SearchHit[]> {
    const url = `/api/search/conversations?q=${encodeURIComponent(q)}`
    const res = await fetch(url, { credentials: "same-origin" })
    if (!res.ok) {
      const text = await res.text().catch(() => res.statusText)
      throw new Error(text || `HTTP ${res.status}`)
    }
    return res.json()
  },
}
