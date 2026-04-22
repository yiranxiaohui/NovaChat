import { useEffect, useState } from "react"
import { useNavigate } from "react-router-dom"
import { CheckCircle2, Database, Loader2 } from "lucide-react"
import { Button } from "@/components/ui/button"
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { setupApi, type ConnectionForm } from "@/lib/setup"

type Kind = "sqlite" | "mysql" | "postgres"

const KIND_META: Record<Kind, { label: string; port: number; placeholder: string }> = {
  sqlite: { label: "SQLite", port: 0, placeholder: "novachat.db" },
  mysql: { label: "MySQL", port: 3306, placeholder: "novachat" },
  postgres: { label: "PostgreSQL", port: 5432, placeholder: "novachat" },
}

export default function SetupPage() {
  const nav = useNavigate()
  const [kind, setKind] = useState<Kind>("sqlite")
  const [sqlitePath, setSqlitePath] = useState("novachat.db")
  const [host, setHost] = useState("localhost")
  const [port, setPort] = useState<number>(3306)
  const [dbUser, setDbUser] = useState("")
  const [dbPass, setDbPass] = useState("")
  const [database, setDatabase] = useState("")
  const [tls, setTls] = useState(false)

  const [adminUser, setAdminUser] = useState("")
  const [adminPass, setAdminPass] = useState("")

  const [testing, setTesting] = useState(false)
  const [testOk, setTestOk] = useState(false)
  const [installing, setInstalling] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    setupApi
      .status()
      .then((s) => {
        if (s.installed) nav("/login", { replace: true })
      })
      .catch(() => {})
  }, [nav])

  useEffect(() => {
    setTestOk(false)
    if (kind === "mysql") setPort(3306)
    if (kind === "postgres") setPort(5432)
  }, [kind])

  function buildConnection(): ConnectionForm {
    if (kind === "sqlite") {
      return { kind: "sqlite", sqlite_path: sqlitePath.trim() || "novachat.db" }
    }
    return {
      kind,
      host: host.trim(),
      port,
      user: dbUser,
      password: dbPass,
      database: database.trim(),
      tls,
    }
  }

  async function runTest() {
    setError(null)
    setTesting(true)
    setTestOk(false)
    try {
      await setupApi.test(buildConnection())
      setTestOk(true)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setTesting(false)
    }
  }

  async function runInstall(e: React.FormEvent) {
    e.preventDefault()
    setError(null)
    if (adminPass.length < 6) {
      setError("管理员密码至少 6 位")
      return
    }
    setInstalling(true)
    try {
      await setupApi.install({
        connection: buildConnection(),
        admin_username: adminUser.trim(),
        admin_password: adminPass,
      })
      nav("/login", { replace: true })
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setInstalling(false)
    }
  }

  return (
    <div className="min-h-svh bg-background p-4">
      <div className="mx-auto max-w-xl py-10">
        <div className="mb-6 flex items-center gap-3">
          <Database className="size-6" />
          <h1 className="text-2xl font-semibold">NovaChat 初始化</h1>
        </div>

        <form onSubmit={runInstall} className="flex flex-col gap-4">
          <Card>
            <CardHeader>
              <CardTitle>1. 选择数据库</CardTitle>
              <CardDescription>
                SQLite 零依赖，适合本地/小规模；MySQL / PostgreSQL 适合多用户或生产部署。
              </CardDescription>
            </CardHeader>
            <CardContent className="flex flex-col gap-3">
              <div className="grid grid-cols-3 gap-2">
                {(Object.keys(KIND_META) as Kind[]).map((k) => (
                  <button
                    key={k}
                    type="button"
                    onClick={() => setKind(k)}
                    className={
                      "rounded-md border px-3 py-2 text-sm transition-colors " +
                      (kind === k
                        ? "border-primary bg-primary/10 text-foreground"
                        : "border-border bg-background hover:bg-accent")
                    }
                  >
                    {KIND_META[k].label}
                  </button>
                ))}
              </div>

              {kind === "sqlite" ? (
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="path">数据库文件路径</Label>
                  <Input
                    id="path"
                    value={sqlitePath}
                    onChange={(e) => setSqlitePath(e.target.value)}
                    placeholder={KIND_META.sqlite.placeholder}
                  />
                  <p className="text-xs text-muted-foreground">
                    相对路径会放到服务端的 <code>data/</code> 目录下；绝对路径原样使用。不存在会自动创建。
                  </p>
                </div>
              ) : (
                <div className="grid grid-cols-2 gap-3">
                  <div className="flex flex-col gap-1.5">
                    <Label htmlFor="host">主机</Label>
                    <Input
                      id="host"
                      value={host}
                      onChange={(e) => setHost(e.target.value)}
                    />
                  </div>
                  <div className="flex flex-col gap-1.5">
                    <Label htmlFor="port">端口</Label>
                    <Input
                      id="port"
                      type="number"
                      value={port}
                      onChange={(e) => setPort(Number(e.target.value))}
                    />
                  </div>
                  <div className="flex flex-col gap-1.5">
                    <Label htmlFor="db">数据库名</Label>
                    <Input
                      id="db"
                      value={database}
                      onChange={(e) => setDatabase(e.target.value)}
                      placeholder={KIND_META[kind].placeholder}
                      required
                    />
                  </div>
                  <div className="flex flex-col gap-1.5">
                    <Label htmlFor="dbuser">用户名</Label>
                    <Input
                      id="dbuser"
                      value={dbUser}
                      onChange={(e) => setDbUser(e.target.value)}
                    />
                  </div>
                  <div className="col-span-2 flex flex-col gap-1.5">
                    <Label htmlFor="dbpass">密码</Label>
                    <Input
                      id="dbpass"
                      type="password"
                      value={dbPass}
                      onChange={(e) => setDbPass(e.target.value)}
                    />
                  </div>
                  <label className="col-span-2 flex items-center gap-2 text-sm">
                    <input
                      type="checkbox"
                      checked={tls}
                      onChange={(e) => setTls(e.target.checked)}
                    />
                    <span>启用 TLS</span>
                  </label>
                </div>
              )}

              <div className="flex items-center gap-2">
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={runTest}
                  disabled={testing}
                >
                  {testing ? <Loader2 className="animate-spin" /> : null}
                  {testing ? "测试中…" : "测试连接"}
                </Button>
                {testOk && (
                  <span className="inline-flex items-center gap-1 text-sm text-emerald-600 dark:text-emerald-400">
                    <CheckCircle2 className="size-4" /> 连接成功
                  </span>
                )}
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>2. 创建管理员账号</CardTitle>
              <CardDescription>首位用户，用于登录系统；稍后可在界面内再注册更多用户。</CardDescription>
            </CardHeader>
            <CardContent className="grid grid-cols-2 gap-3">
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="au">用户名</Label>
                <Input
                  id="au"
                  value={adminUser}
                  onChange={(e) => setAdminUser(e.target.value)}
                  minLength={3}
                  maxLength={32}
                  pattern="[A-Za-z0-9_\-]+"
                  required
                />
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="ap">密码</Label>
                <Input
                  id="ap"
                  type="password"
                  value={adminPass}
                  onChange={(e) => setAdminPass(e.target.value)}
                  minLength={6}
                  required
                />
              </div>
            </CardContent>
          </Card>

          {error && (
            <div className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
              {error}
            </div>
          )}

          <div className="flex justify-end">
            <Button type="submit" disabled={installing}>
              {installing ? <Loader2 className="animate-spin" /> : null}
              {installing ? "初始化中…" : "完成安装"}
            </Button>
          </div>
        </form>
      </div>
    </div>
  )
}
