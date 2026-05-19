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
}

export type AdminSettings = {
  registration_enabled: boolean
  signup_grant: number
  cost_chat: number
  cost_image: number
  invite_grant_inviter: number
  invite_grant_invitee: number
  email_verification_required: boolean
  smtp_host: string
  smtp_port: number
  smtp_username: string
  smtp_from_email: string
  smtp_from_name: string
  smtp_security: string
  smtp_password_set: boolean
}

export type AdminSettingsUpdate = Partial<
  Omit<AdminSettings, "smtp_password_set"> & {
    smtp_password: string
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
  async sendTestEmail(email: string): Promise<void> {
    const res = await fetch("/api/admin/email/test", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email }),
      credentials: "same-origin",
    })
    if (!res.ok) {
      throw new Error(
        (await res.text().catch(() => res.statusText)) || `HTTP ${res.status}`
      )
    }
  },
}
