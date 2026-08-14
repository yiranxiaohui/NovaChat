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
  library_assets: number
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

export type AdminStorageSettings = {
  backend: "local" | "s3"
  endpoint: string
  region: string
  bucket: string
  prefix: string
  path_style: boolean
  access_key_id_set: boolean
  access_key_id_hint: string | null
  secret_access_key_set: boolean
  session_token_set: boolean
  active_backend: "local" | "s3"
  active_location: string
}

export type AdminStorageSettingsUpdate = {
  backend: "local" | "s3"
  endpoint: string
  region: string
  bucket: string
  prefix: string
  path_style: boolean
  access_key_id?: string
  secret_access_key?: string
  session_token?: string
  clear_session_token?: boolean
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
  async storage(): Promise<AdminStorageSettings> {
    const res = await fetch("/api/admin/storage", {
      credentials: "same-origin",
    })
    return jsonOrThrow<AdminStorageSettings>(res)
  },
  async testStorage(updates: AdminStorageSettingsUpdate): Promise<void> {
    const res = await fetch("/api/admin/storage/test", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(updates),
      credentials: "same-origin",
    })
    await jsonOrThrow<{ ok: boolean }>(res)
  },
  async updateStorage(
    updates: AdminStorageSettingsUpdate
  ): Promise<AdminStorageSettings> {
    const res = await fetch("/api/admin/storage", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(updates),
      credentials: "same-origin",
    })
    return jsonOrThrow<AdminStorageSettings>(res)
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
