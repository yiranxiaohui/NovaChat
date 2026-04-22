import { createContext, useContext, useEffect, useState, type ReactNode } from "react"
import { api, type User } from "./api"
import { setupApi } from "./setup"

type AuthState =
  | { status: "loading" }
  | { status: "setup" }
  | { status: "anon" }
  | { status: "authed"; user: User }

type AuthContextValue = {
  state: AuthState
  login: (username: string, password: string) => Promise<void>
  register: (username: string, password: string) => Promise<void>
  logout: () => Promise<void>
}

const AuthContext = createContext<AuthContextValue | null>(null)

export function AuthProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<AuthState>({ status: "loading" })

  useEffect(() => {
    setupApi
      .status()
      .then((s) => {
        if (!s.installed) {
          setState({ status: "setup" })
          return
        }
        api
          .me()
          .then((u) =>
            setState(u ? { status: "authed", user: u } : { status: "anon" })
          )
          .catch(() => setState({ status: "anon" }))
      })
      .catch(() => setState({ status: "anon" }))
  }, [])

  const value: AuthContextValue = {
    state,
    async login(username, password) {
      const u = await api.login(username, password)
      setState({ status: "authed", user: u })
    },
    async register(username, password) {
      const u = await api.register(username, password)
      setState({ status: "authed", user: u })
    },
    async logout() {
      await api.logout()
      setState({ status: "anon" })
    },
  }

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
}

export function useAuth() {
  const ctx = useContext(AuthContext)
  if (!ctx) throw new Error("useAuth must be used inside AuthProvider")
  return ctx
}
