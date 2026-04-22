export type CreditsMe = {
  balance: number
  lifetime_used: number
  cost_chat: number
  cost_image: number
}

export type LedgerEntry = {
  id: number
  delta: number
  reason: string
  created_at: string
}

export type SharedStatus = {
  enabled: boolean
  openai_available: boolean
  claude_available: boolean
  gemini_available: boolean
  image_openai_available: boolean
  image_gemini_available: boolean
  cost_chat: number
  cost_image: number
  balance: number
}

async function jsonOrThrow<T>(res: Response): Promise<T> {
  if (!res.ok) {
    const text = await res.text().catch(() => res.statusText)
    throw new Error(text || `HTTP ${res.status}`)
  }
  return res.json() as Promise<T>
}

export const creditsApi = {
  async me(): Promise<CreditsMe> {
    return jsonOrThrow(
      await fetch("/api/credits/me", { credentials: "same-origin" })
    )
  },
  async ledger(page = 1): Promise<LedgerEntry[]> {
    return jsonOrThrow(
      await fetch(`/api/credits/ledger?page=${page}`, {
        credentials: "same-origin",
      })
    )
  },
  async sharedStatus(): Promise<SharedStatus> {
    return jsonOrThrow(
      await fetch("/api/shared/status", { credentials: "same-origin" })
    )
  },
}

export type AdminSettings = {
  shared_enabled: boolean
  signup_grant: number
  cost_chat: number
  cost_image: number
  invite_grant_inviter: number
  invite_grant_invitee: number
  shared_chat_openai_url: string
  shared_chat_claude_url: string
  shared_chat_gemini_url: string
  shared_image_openai_url: string
  shared_image_gemini_url: string
  shared_chat_openai_model: string
  shared_chat_claude_model: string
  shared_chat_gemini_model: string
  shared_image_openai_model: string
  shared_image_gemini_model: string
  shared_chat_openai_key_set: boolean
  shared_chat_claude_key_set: boolean
  shared_chat_gemini_key_set: boolean
  shared_image_openai_key_set: boolean
  shared_image_gemini_key_set: boolean
}

export type AdminSettingsUpdate = Partial<
  Omit<
    AdminSettings,
    | "shared_chat_openai_key_set"
    | "shared_chat_claude_key_set"
    | "shared_chat_gemini_key_set"
    | "shared_image_openai_key_set"
    | "shared_image_gemini_key_set"
  > & {
    shared_chat_openai_key: string
    shared_chat_claude_key: string
    shared_chat_gemini_key: string
    shared_image_openai_key: string
    shared_image_gemini_key: string
  }
>

export type AdminUserCredits = {
  user_id: number
  username: string
  balance: number
  lifetime_used: number
}

export const adminCreditsApi = {
  async getSettings(): Promise<AdminSettings> {
    return jsonOrThrow(
      await fetch("/api/admin/app-settings", { credentials: "same-origin" })
    )
  },
  async updateSettings(patch: AdminSettingsUpdate): Promise<void> {
    const res = await fetch("/api/admin/app-settings", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(patch),
      credentials: "same-origin",
    })
    if (!res.ok) {
      throw new Error((await res.text().catch(() => res.statusText)) || `HTTP ${res.status}`)
    }
  },
  async listUserCredits(): Promise<AdminUserCredits[]> {
    return jsonOrThrow(
      await fetch("/api/admin/credits", { credentials: "same-origin" })
    )
  },
  async adjust(
    userId: number,
    body: { balance?: number; delta?: number; reason?: string }
  ): Promise<{ balance: number }> {
    return jsonOrThrow(
      await fetch(`/api/admin/credits/${userId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        credentials: "same-origin",
      })
    )
  },
}
