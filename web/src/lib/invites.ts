export type InviteInfo = {
  invite_code: string
  invited_count: number
  total_earned: number
  grant_inviter: number
  grant_invitee: number
}

export type InvitedUser = {
  id: number
  username: string
  created_at: string
}

async function jsonOrThrow<T>(res: Response): Promise<T> {
  if (!res.ok) {
    const text = await res.text().catch(() => res.statusText)
    throw new Error(text || `HTTP ${res.status}`)
  }
  return res.json() as Promise<T>
}

export const invitesApi = {
  async me(): Promise<InviteInfo> {
    return jsonOrThrow(
      await fetch("/api/invites/me", { credentials: "same-origin" })
    )
  },
  async listInvited(): Promise<InvitedUser[]> {
    return jsonOrThrow(
      await fetch("/api/invites/mine", { credentials: "same-origin" })
    )
  },
}

export function buildInviteUrl(code: string): string {
  if (typeof window === "undefined") return `/register?ref=${code}`
  const origin = window.location.origin
  return `${origin}/register?ref=${encodeURIComponent(code)}`
}
