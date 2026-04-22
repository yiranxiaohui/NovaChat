export type User = {
  id: number
  username: string
  display_name?: string | null
  avatar_url?: string | null
  is_admin?: boolean
}

async function jsonOrThrow<T>(res: Response): Promise<T> {
  if (!res.ok) {
    const text = await res.text().catch(() => res.statusText)
    throw new Error(text || `HTTP ${res.status}`)
  }
  return res.json() as Promise<T>
}

export const api = {
  async me(): Promise<User | null> {
    const res = await fetch("/api/auth/me", { credentials: "same-origin" })
    if (res.status === 401) return null
    return jsonOrThrow<User>(res)
  },
  async login(username: string, password: string): Promise<User> {
    const res = await fetch("/api/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username, password }),
      credentials: "same-origin",
    })
    return jsonOrThrow<User>(res)
  },
  async register(username: string, password: string): Promise<User> {
    const res = await fetch("/api/auth/register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username, password }),
      credentials: "same-origin",
    })
    return jsonOrThrow<User>(res)
  },
  async logout(): Promise<void> {
    await fetch("/api/auth/logout", {
      method: "POST",
      credentials: "same-origin",
    })
  },
}
