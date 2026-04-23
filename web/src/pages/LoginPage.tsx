import { useState } from "react"
import { Link, useNavigate } from "react-router-dom"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { useAuth } from "@/lib/auth-context"
import { BrandMark } from "@/components/app/BrandMark"

export default function LoginPage() {
  const auth = useAuth()
  const nav = useNavigate()
  const [username, setUsername] = useState("")
  const [password, setPassword] = useState("")
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    setError(null)
    setBusy(true)
    try {
      await auth.login(username.trim(), password)
      nav("/", { replace: true })
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="bg-auth-grid grid min-h-svh place-items-center p-4">
      <div className="w-full max-w-sm rounded-2xl border border-border bg-card p-6 shadow-panel sm:p-8">
        <BrandMark subtitle="多协议对话 · 自托管" className="mb-6" />
        <h1 className="text-2xl font-semibold tracking-tight">欢迎回来</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          用你的账号进入 NovaChat。
        </p>

        <form onSubmit={submit} className="mt-6 flex flex-col gap-4">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="username">用户名</Label>
            <Input
              id="username"
              autoComplete="username"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              required
              autoFocus
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="password">密码</Label>
            <Input
              id="password"
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
            />
          </div>
          {error && (
            <div className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
              {error}
            </div>
          )}
          <Button type="submit" disabled={busy} className="w-full" size="lg">
            {busy ? "登录中…" : "登录"}
          </Button>
        </form>

        <p className="mt-6 text-center text-sm text-muted-foreground">
          还没有账号？{" "}
          <Link
            to="/register"
            className="font-medium text-foreground underline-offset-4 hover:underline"
          >
            注册
          </Link>
        </p>
      </div>
    </div>
  )
}
