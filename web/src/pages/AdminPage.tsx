import { useEffect, useState } from "react"
import { Link, Navigate } from "react-router-dom"
import {
  ArrowLeft,
  BarChart3,
  Database,
  Key,
  RefreshCw,
  Server,
  Shield,
  Trash2,
  UserCog,
  Users,
} from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { useAuth } from "@/lib/auth-context"
import {
  adminApi,
  type AdminStats,
  type AdminSystemInfo,
  type AdminUser,
} from "@/lib/admin"

type Section = "overview" | "users" | "system"

const NAV: { key: Section; label: string; icon: React.ComponentType<{ className?: string }> }[] = [
  { key: "overview", label: "概览", icon: BarChart3 },
  { key: "users", label: "用户管理", icon: Users },
  { key: "system", label: "系统信息", icon: Server },
]

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`
}

export default function AdminPage() {
  const { state } = useAuth()
  const currentUser = state.status === "authed" ? state.user : null
  const [section, setSection] = useState<Section>("overview")

  if (state.status === "loading") {
    return (
      <div className="grid min-h-svh place-items-center text-muted-foreground">
        加载中…
      </div>
    )
  }
  if (!currentUser || !currentUser.is_admin) {
    return <Navigate to="/" replace />
  }

  return (
    <div className="flex h-svh bg-background text-foreground">
      <aside className="flex h-full w-60 shrink-0 flex-col border-r border-sidebar-border bg-sidebar">
        <div className="flex items-center gap-2 px-4 pb-3 pt-4">
          <div className="grid size-8 place-items-center rounded-md bg-gradient-to-br from-primary to-chart-5 text-primary-foreground">
            <Shield className="size-4" />
          </div>
          <div className="min-w-0">
            <p className="text-sm font-semibold">管理控制台</p>
            <p className="truncate text-[11px] text-muted-foreground">
              {currentUser.display_name || currentUser.username}
            </p>
          </div>
        </div>

        <nav className="flex flex-col gap-0.5 px-2 py-2">
          {NAV.map((n) => {
            const active = section === n.key
            const Icon = n.icon
            return (
              <button
                key={n.key}
                type="button"
                onClick={() => setSection(n.key)}
                className={
                  "flex items-center gap-2 rounded-md px-3 py-2 text-left text-sm transition-colors " +
                  (active
                    ? "bg-sidebar-accent text-sidebar-accent-foreground"
                    : "text-muted-foreground hover:bg-sidebar-accent/50 hover:text-sidebar-accent-foreground")
                }
              >
                <Icon className="size-4" />
                {n.label}
              </button>
            )
          })}
        </nav>

        <div className="mt-auto border-t border-sidebar-border px-2 py-2">
          <Link
            to="/"
            className="flex items-center gap-2 rounded-md px-3 py-2 text-sm text-muted-foreground transition-colors hover:bg-sidebar-accent/60 hover:text-sidebar-accent-foreground"
          >
            <ArrowLeft className="size-4" /> 返回聊天
          </Link>
        </div>
      </aside>

      <div className="nc-scroll flex min-w-0 flex-1 flex-col overflow-y-auto">
        <header className="flex items-center justify-between border-b border-border bg-background/70 px-6 py-4 backdrop-blur">
          <div>
            <h1 className="text-xl font-semibold tracking-tight">
              {NAV.find((n) => n.key === section)?.label}
            </h1>
            <p className="text-sm text-muted-foreground">
              仅管理员可见。对系统全局生效。
            </p>
          </div>
        </header>

        <main className="mx-auto w-full max-w-5xl px-6 py-6">
          {section === "overview" && <OverviewPanel />}
          {section === "users" && <UsersPanel currentUserId={currentUser.id} />}
          {section === "system" && <SystemPanel />}
        </main>
      </div>
    </div>
  )
}

function StatCard({
  label,
  value,
  hint,
}: {
  label: string
  value: string | number
  hint?: string
}) {
  return (
    <div className="rounded-xl border border-border bg-card p-4 shadow-sm">
      <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
        {label}
      </p>
      <p className="mt-1 text-2xl font-semibold tabular-nums">{value}</p>
      {hint && <p className="mt-1 text-xs text-muted-foreground">{hint}</p>}
    </div>
  )
}

function OverviewPanel() {
  const [stats, setStats] = useState<AdminStats | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)

  async function load() {
    setLoading(true)
    setError(null)
    try {
      setStats(await adminApi.stats())
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setLoading(false)
    }
  }
  useEffect(() => {
    void load()
  }, [])

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between">
        <p className="text-sm text-muted-foreground">
          系统整体使用情况。数据实时来自数据库。
        </p>
        <Button variant="outline" size="sm" onClick={() => void load()}>
          <RefreshCw /> 刷新
        </Button>
      </div>

      {error && (
        <div className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {error}
        </div>
      )}
      {loading && !stats && (
        <p className="text-sm text-muted-foreground">加载中…</p>
      )}
      {stats && (
        <>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
            <StatCard
              label="用户"
              value={stats.users}
              hint={`其中管理员 ${stats.admins}`}
            />
            <StatCard label="会话" value={stats.conversations} />
            <StatCard label="消息" value={stats.messages} />
            <StatCard label="活跃会话凭证" value={stats.sessions} />
            <StatCard
              label="Skills"
              value={stats.skills}
              hint={`公开 ${stats.public_skills}`}
            />
            <StatCard
              label="提示词"
              value={stats.prompts}
              hint={`公开 ${stats.public_prompts}`}
            />
            <StatCard label="广场图片" value={stats.plaza_images} />
          </div>
        </>
      )}
    </div>
  )
}

function UsersPanel({ currentUserId }: { currentUserId: number }) {
  const [users, setUsers] = useState<AdminUser[]>([])
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [query, setQuery] = useState("")
  const [editing, setEditing] = useState<AdminUser | null>(null)

  async function load() {
    setLoading(true)
    setError(null)
    try {
      setUsers(await adminApi.listUsers())
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setLoading(false)
    }
  }
  useEffect(() => {
    void load()
  }, [])

  const q = query.trim().toLowerCase()
  const filtered = q
    ? users.filter(
        (u) =>
          u.username.toLowerCase().includes(q) ||
          (u.display_name ?? "").toLowerCase().includes(q)
      )
    : users

  async function toggleAdmin(u: AdminUser) {
    const next = !u.is_admin
    const verb = next ? "提升为管理员" : "撤销管理员"
    if (!window.confirm(`确认${verb} ${u.username}？`)) return
    try {
      await adminApi.updateUser(u.id, { is_admin: next })
      await load()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  async function removeUser(u: AdminUser) {
    if (
      !window.confirm(
        `删除用户 "${u.username}" 及其全部会话、消息、Skills？此操作不可撤销。`
      )
    )
      return
    try {
      await adminApi.deleteUser(u.id)
      await load()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center gap-2">
        <Input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="搜索用户名或昵称…"
          className="max-w-xs"
        />
        <Button variant="outline" size="sm" onClick={() => void load()}>
          <RefreshCw /> 刷新
        </Button>
      </div>

      {error && (
        <div className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {error}
        </div>
      )}

      <div className="overflow-hidden rounded-lg border border-border">
        <table className="w-full text-sm">
          <thead className="bg-muted/40 text-xs uppercase text-muted-foreground">
            <tr>
              <th className="px-3 py-2 text-left font-medium">ID</th>
              <th className="px-3 py-2 text-left font-medium">用户</th>
              <th className="px-3 py-2 text-left font-medium">角色</th>
              <th className="px-3 py-2 text-right font-medium">会话</th>
              <th className="px-3 py-2 text-right font-medium">消息</th>
              <th className="px-3 py-2 text-right font-medium">Skills</th>
              <th className="px-3 py-2 text-left font-medium">注册时间</th>
              <th className="px-3 py-2 text-right font-medium">操作</th>
            </tr>
          </thead>
          <tbody>
            {loading && (
              <tr>
                <td
                  colSpan={8}
                  className="px-3 py-6 text-center text-muted-foreground"
                >
                  加载中…
                </td>
              </tr>
            )}
            {!loading && filtered.length === 0 && (
              <tr>
                <td
                  colSpan={8}
                  className="px-3 py-6 text-center text-muted-foreground"
                >
                  没有匹配的用户
                </td>
              </tr>
            )}
            {filtered.map((u) => {
              const isSelf = u.id === currentUserId
              return (
                <tr
                  key={u.id}
                  className="border-t border-border hover:bg-accent/30"
                >
                  <td className="px-3 py-2 tabular-nums text-muted-foreground">
                    {u.id}
                  </td>
                  <td className="px-3 py-2">
                    <div className="flex items-center gap-2">
                      {u.avatar_url ? (
                        <img
                          src={u.avatar_url}
                          alt=""
                          className="size-6 rounded-full border border-border object-cover"
                        />
                      ) : (
                        <div className="grid size-6 place-items-center rounded-full bg-gradient-to-br from-primary to-chart-5 text-[10px] font-semibold text-primary-foreground">
                          {(u.display_name?.trim() || u.username)
                            .slice(0, 1)
                            .toUpperCase()}
                        </div>
                      )}
                      <div className="min-w-0">
                        <p className="truncate font-medium">{u.username}</p>
                        {u.display_name && (
                          <p className="truncate text-xs text-muted-foreground">
                            {u.display_name}
                          </p>
                        )}
                      </div>
                    </div>
                  </td>
                  <td className="px-3 py-2">
                    {u.is_admin ? (
                      <span className="inline-flex items-center gap-1 rounded-full bg-primary/10 px-2 py-0.5 text-xs font-medium text-primary">
                        <Shield className="size-3" /> 管理员
                      </span>
                    ) : (
                      <span className="text-xs text-muted-foreground">
                        普通用户
                      </span>
                    )}
                    {isSelf && (
                      <span className="ml-1 text-[10px] text-muted-foreground">
                        （你）
                      </span>
                    )}
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums">
                    {u.conversations}
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums">
                    {u.messages}
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums">
                    {u.skills}
                  </td>
                  <td className="px-3 py-2 text-xs text-muted-foreground">
                    {u.created_at.replace("T", " ").replace("Z", "")}
                  </td>
                  <td className="px-3 py-2">
                    <div className="flex justify-end gap-1">
                      <Button
                        size="xs"
                        variant="outline"
                        onClick={() => setEditing(u)}
                        title="编辑"
                      >
                        <UserCog /> 编辑
                      </Button>
                      <Button
                        size="xs"
                        variant="outline"
                        onClick={() => void toggleAdmin(u)}
                        disabled={isSelf && u.is_admin}
                        title={u.is_admin ? "撤销管理员" : "提升为管理员"}
                      >
                        <Shield />
                        {u.is_admin ? "撤销" : "提升"}
                      </Button>
                      <Button
                        size="xs"
                        variant="outline"
                        onClick={() => void removeUser(u)}
                        disabled={isSelf}
                        className="text-destructive hover:bg-destructive/10 hover:text-destructive"
                        title="删除用户"
                      >
                        <Trash2 />
                      </Button>
                    </div>
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>

      {editing && (
        <EditUserDialog
          user={editing}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null)
            void load()
          }}
        />
      )}
    </div>
  )
}

function EditUserDialog({
  user,
  onClose,
  onSaved,
}: {
  user: AdminUser
  onClose: () => void
  onSaved: () => void
}) {
  const [displayName, setDisplayName] = useState(user.display_name ?? "")
  const [password, setPassword] = useState("")
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function save() {
    setError(null)
    const updates: {
      display_name?: string
      password?: string
    } = {}
    if ((displayName.trim() || "") !== (user.display_name ?? "")) {
      updates.display_name = displayName
    }
    if (password) {
      if (password.length < 6 || password.length > 256) {
        setError("新密码需为 6-256 位")
        return
      }
      updates.password = password
    }
    if (Object.keys(updates).length === 0) {
      onClose()
      return
    }
    setSaving(true)
    try {
      await adminApi.updateUser(user.id, updates)
      onSaved()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setSaving(false)
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 grid place-items-center bg-black/50 p-4"
      onClick={onClose}
    >
      <div
        className="flex w-full max-w-md flex-col gap-4 rounded-lg border border-border bg-background p-6 shadow-lg"
        onClick={(e) => e.stopPropagation()}
      >
        <div>
          <h2 className="text-lg font-semibold">编辑用户 · {user.username}</h2>
          <p className="text-sm text-muted-foreground">
            修改昵称或重置密码。改密码会使该用户已有的登录全部失效。
          </p>
        </div>

        {error && (
          <div className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
            {error}
          </div>
        )}

        <div className="flex flex-col gap-1.5">
          <Label htmlFor="eu-name">昵称</Label>
          <Input
            id="eu-name"
            value={displayName}
            onChange={(e) => setDisplayName(e.target.value)}
            maxLength={64}
            placeholder="留空则显示用户名"
          />
        </div>

        <div className="flex flex-col gap-1.5">
          <Label htmlFor="eu-pw">重置密码</Label>
          <Input
            id="eu-pw"
            type="password"
            autoComplete="new-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder="留空不修改（6-256 位）"
          />
        </div>

        <div className="flex justify-end gap-2">
          <Button variant="outline" onClick={onClose} disabled={saving}>
            取消
          </Button>
          <Button onClick={() => void save()} disabled={saving}>
            {saving ? "保存中…" : "保存"}
          </Button>
        </div>
      </div>
    </div>
  )
}

function SystemPanel() {
  const [info, setInfo] = useState<AdminSystemInfo | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [pruneMsg, setPruneMsg] = useState<string | null>(null)
  const [pruning, setPruning] = useState(false)

  async function load() {
    setLoading(true)
    setError(null)
    try {
      setInfo(await adminApi.system())
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setLoading(false)
    }
  }
  useEffect(() => {
    void load()
  }, [])

  async function prune() {
    setPruneMsg(null)
    setPruning(true)
    try {
      const r = await adminApi.pruneSessions()
      setPruneMsg(`已清理 ${r.removed} 条过期登录凭证`)
    } catch (e) {
      setPruneMsg(e instanceof Error ? e.message : String(e))
    } finally {
      setPruning(false)
    }
  }

  return (
    <div className="flex flex-col gap-4">
      {error && (
        <div className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {error}
        </div>
      )}

      {loading && !info && (
        <p className="text-sm text-muted-foreground">加载中…</p>
      )}
      {info && (
        <div className="rounded-xl border border-border bg-card p-4 shadow-sm">
          <h2 className="mb-3 flex items-center gap-2 text-sm font-semibold">
            <Database className="size-4" /> 运行信息
          </h2>
          <dl className="grid grid-cols-1 gap-x-6 gap-y-2 text-sm sm:grid-cols-2">
            <InfoRow label="NovaChat 版本" value={info.version} />
            <InfoRow label="数据库类型" value={info.db_kind} />
            <InfoRow label="监听地址" value={info.bind_addr} />
            <InfoRow
              label="图片目录占用"
              value={formatBytes(info.images_dir_bytes)}
            />
            <InfoRow label="数据目录" value={info.data_dir} mono />
            <InfoRow label="配置文件" value={info.config_path} mono />
          </dl>
        </div>
      )}

      <div className="rounded-xl border border-border bg-card p-4 shadow-sm">
        <h2 className="mb-3 flex items-center gap-2 text-sm font-semibold">
          <Key className="size-4" /> 登录会话
        </h2>
        <p className="mb-3 text-sm text-muted-foreground">
          清理数据库中已过期但尚未被删除的登录凭证。仅影响已过期的会话。
        </p>
        <div className="flex items-center gap-3">
          <Button
            variant="outline"
            size="sm"
            onClick={() => void prune()}
            disabled={pruning}
          >
            <Trash2 /> {pruning ? "清理中…" : "清理过期会话"}
          </Button>
          {pruneMsg && (
            <span className="text-xs text-muted-foreground">{pruneMsg}</span>
          )}
        </div>
      </div>
    </div>
  )
}

function InfoRow({
  label,
  value,
  mono,
}: {
  label: string
  value: string
  mono?: boolean
}) {
  return (
    <div className="flex flex-col">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd
        className={
          "truncate " + (mono ? "font-mono text-xs" : "text-sm font-medium")
        }
        title={value}
      >
        {value}
      </dd>
    </div>
  )
}
