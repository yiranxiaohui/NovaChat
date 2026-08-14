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

export type AdminStats = {
  users: number
  admins: number
  conversations: number
  messages: number
  skills: number
  public_skills: number
  prompts: number
  public_prompts: number
  plaza_images: number
  sessions: number
}

export type AdminUser = {
  id: number
  username: string
  display_name: string | null
  avatar_url: string | null
  email: string | null
  is_admin: boolean
  created_at: string
  conversations: number
  messages: number
  skills: number
}

export type AdminInviteRow = {
  inviter_id: number
  inviter_username: string
  inviter_code: string | null
  invitee_id: number
  invitee_username: string
  invitee_created_at: string
}

export type AdminSystemInfo = {
  version: string
  db_kind: string
  data_dir: string
  config_path: string
  bind_addr: string
  images_dir_bytes: number
  storage_backend: "local" | "s3"
  storage_location: string
}

export type AdminUserUpdate = {
  is_admin?: boolean
  display_name?: string
  password?: string
}

export const adminApi = {
  async stats(): Promise<AdminStats> {
    const res = await fetch("/api/admin/stats", { credentials: "same-origin" })
    return jsonOrThrow<AdminStats>(res)
  },
  async system(): Promise<AdminSystemInfo> {
    const res = await fetch("/api/admin/system", { credentials: "same-origin" })
    return jsonOrThrow<AdminSystemInfo>(res)
  },
  async listUsers(): Promise<AdminUser[]> {
    const res = await fetch("/api/admin/users", { credentials: "same-origin" })
    return jsonOrThrow<AdminUser[]>(res)
  },
  async updateUser(id: number, updates: AdminUserUpdate): Promise<void> {
    const res = await fetch(`/api/admin/users/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(updates),
      credentials: "same-origin",
    })
    await okOrThrow(res)
  },
  async deleteUser(id: number): Promise<void> {
    const res = await fetch(`/api/admin/users/${id}`, {
      method: "DELETE",
      credentials: "same-origin",
    })
    await okOrThrow(res)
  },
  async listInvites(): Promise<AdminInviteRow[]> {
    const res = await fetch("/api/admin/invites", { credentials: "same-origin" })
    return jsonOrThrow<AdminInviteRow[]>(res)
  },
  async pruneSessions(): Promise<{ removed: number }> {
    const res = await fetch("/api/admin/sessions/prune", {
      method: "POST",
      credentials: "same-origin",
    })
    return jsonOrThrow<{ removed: number }>(res)
  },
}
