export type User = {
  id: number
  username: string
  display_name?: string | null
  avatar_url?: string | null
  is_admin?: boolean
}

export type RegisterInput = {
  username: string
  password: string
  invite_code?: string
  email?: string
  email_code?: string
}

export type AuthConfig = {
  email_verification_required: boolean
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
  async register(input: RegisterInput): Promise<User> {
    const body: Record<string, string> = {
      username: input.username,
      password: input.password,
    }
    if (input.invite_code && input.invite_code.trim())
      body.invite_code = input.invite_code.trim()
    if (input.email && input.email.trim())
      body.email = input.email.trim().toLowerCase()
    if (input.email_code && input.email_code.trim())
      body.email_code = input.email_code.trim()
    const res = await fetch("/api/auth/register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
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
  async authConfig(): Promise<AuthConfig> {
    const res = await fetch("/api/auth/config", { credentials: "same-origin" })
    return jsonOrThrow<AuthConfig>(res)
  },
  async sendEmailCode(email: string): Promise<void> {
    const res = await fetch("/api/auth/email/send-code", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: email.trim().toLowerCase(), purpose: "register" }),
      credentials: "same-origin",
    })
    if (!res.ok) {
      const text = await res.text().catch(() => res.statusText)
      throw new Error(text || `HTTP ${res.status}`)
    }
  },
}
