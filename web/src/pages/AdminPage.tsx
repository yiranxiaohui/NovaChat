import { useEffect, useState } from "react"
import { Link, Navigate } from "react-router-dom"
import {
  ArrowLeft,
  BarChart3,
  Coins,
  Database,
  Key,
  Plug,
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
import {
  adminCreditsApi,
  type AdminSettings,
  type AdminSettingsUpdate,
  type AdminUserCredits,
} from "@/lib/credits"

type Section = "overview" | "users" | "credits" | "shared" | "system"

const NAV: { key: Section; label: string; icon: React.ComponentType<{ className?: string }> }[] = [
  { key: "overview", label: "概览", icon: BarChart3 },
  { key: "users", label: "用户管理", icon: Users },
  { key: "credits", label: "积分", icon: Coins },
  { key: "shared", label: "共享后端", icon: Plug },
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
          {section === "credits" && <CreditsPanel />}
          {section === "shared" && <SharedBackendPanel />}
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

function CreditsPanel() {
  const [rows, setRows] = useState<AdminUserCredits[]>([])
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [query, setQuery] = useState("")
  const [editing, setEditing] = useState<AdminUserCredits | null>(null)

  async function load() {
    setLoading(true)
    setError(null)
    try {
      setRows(await adminCreditsApi.listUserCredits())
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
    ? rows.filter((r) => r.username.toLowerCase().includes(q))
    : rows

  return (
    <div className="flex flex-col gap-3">
      <p className="text-sm text-muted-foreground">
        用户在未填自己 API Key 时会消耗站点共享额度；每次对话按「每次消耗」配置扣积分，图像按图像配置扣。上游报错会自动退款。
      </p>

      <div className="flex items-center gap-2">
        <Input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="按用户名搜索…"
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
              <th className="px-3 py-2 text-right font-medium">余额</th>
              <th className="px-3 py-2 text-right font-medium">历史消耗</th>
              <th className="px-3 py-2 text-right font-medium">操作</th>
            </tr>
          </thead>
          <tbody>
            {loading && (
              <tr>
                <td colSpan={5} className="px-3 py-6 text-center text-muted-foreground">
                  加载中…
                </td>
              </tr>
            )}
            {!loading && filtered.length === 0 && (
              <tr>
                <td colSpan={5} className="px-3 py-6 text-center text-muted-foreground">
                  没有匹配的用户
                </td>
              </tr>
            )}
            {filtered.map((r) => (
              <tr key={r.user_id} className="border-t border-border hover:bg-accent/30">
                <td className="px-3 py-2 tabular-nums text-muted-foreground">{r.user_id}</td>
                <td className="px-3 py-2 font-medium">{r.username}</td>
                <td className="px-3 py-2 text-right tabular-nums">{r.balance}</td>
                <td className="px-3 py-2 text-right tabular-nums text-muted-foreground">
                  {r.lifetime_used}
                </td>
                <td className="px-3 py-2">
                  <div className="flex justify-end">
                    <Button
                      size="xs"
                      variant="outline"
                      onClick={() => setEditing(r)}
                    >
                      <Coins /> 调整
                    </Button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {editing && (
        <AdjustCreditsDialog
          row={editing}
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

function AdjustCreditsDialog({
  row,
  onClose,
  onSaved,
}: {
  row: AdminUserCredits
  onClose: () => void
  onSaved: () => void
}) {
  const [mode, setMode] = useState<"delta" | "balance">("delta")
  const [delta, setDelta] = useState("100")
  const [balance, setBalance] = useState(String(row.balance))
  const [reason, setReason] = useState("")
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function save() {
    setError(null)
    setSaving(true)
    try {
      if (mode === "delta") {
        const n = Number(delta)
        if (!Number.isFinite(n) || n === 0) {
          setError("增减值需为非零整数（正数充值，负数扣减）")
          setSaving(false)
          return
        }
        await adminCreditsApi.adjust(row.user_id, {
          delta: Math.trunc(n),
          reason: reason.trim() || undefined,
        })
      } else {
        const n = Number(balance)
        if (!Number.isFinite(n) || n < 0) {
          setError("余额需为 >= 0 的整数")
          setSaving(false)
          return
        }
        await adminCreditsApi.adjust(row.user_id, {
          balance: Math.trunc(n),
          reason: reason.trim() || undefined,
        })
      }
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
          <h2 className="text-lg font-semibold">调整积分 · {row.username}</h2>
          <p className="text-sm text-muted-foreground">
            当前余额 {row.balance}，累计消耗 {row.lifetime_used}。所有改动都会写入流水。
          </p>
        </div>

        {error && (
          <div className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
            {error}
          </div>
        )}

        <div className="flex items-center rounded-md border border-border p-0.5">
          <Button
            size="sm"
            variant={mode === "delta" ? "secondary" : "ghost"}
            className="flex-1"
            onClick={() => setMode("delta")}
          >
            增减
          </Button>
          <Button
            size="sm"
            variant={mode === "balance" ? "secondary" : "ghost"}
            className="flex-1"
            onClick={() => setMode("balance")}
          >
            设置余额
          </Button>
        </div>

        {mode === "delta" ? (
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="adj-delta">增减值（正数充值、负数扣减）</Label>
            <Input
              id="adj-delta"
              type="number"
              value={delta}
              onChange={(e) => setDelta(e.target.value)}
              placeholder="例如 500 或 -100"
            />
          </div>
        ) : (
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="adj-bal">新余额</Label>
            <Input
              id="adj-bal"
              type="number"
              min="0"
              value={balance}
              onChange={(e) => setBalance(e.target.value)}
            />
          </div>
        )}

        <div className="flex flex-col gap-1.5">
          <Label htmlFor="adj-reason">备注（可选）</Label>
          <Input
            id="adj-reason"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            maxLength={80}
            placeholder="例：活动奖励、异常扣减补偿"
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

function SharedBackendPanel() {
  const [cfg, setCfg] = useState<AdminSettings | null>(null)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [saveMsg, setSaveMsg] = useState<string | null>(null)

  // form overrides
  const [patch, setPatch] = useState<AdminSettingsUpdate>({})

  async function load() {
    setLoading(true)
    setError(null)
    try {
      const c = await adminCreditsApi.getSettings()
      setCfg(c)
      setPatch({})
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setLoading(false)
    }
  }
  useEffect(() => {
    void load()
  }, [])

  function set<K extends keyof AdminSettingsUpdate>(
    k: K,
    v: AdminSettingsUpdate[K]
  ) {
    setPatch((p) => ({ ...p, [k]: v }))
  }

  async function save() {
    setSaveMsg(null)
    setError(null)
    setSaving(true)
    try {
      await adminCreditsApi.updateSettings(patch)
      setSaveMsg("已保存")
      await load()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setSaving(false)
    }
  }

  if (loading && !cfg) {
    return <p className="text-sm text-muted-foreground">加载中…</p>
  }
  if (!cfg) {
    return (
      <div className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
        {error ?? "无法加载设置"}
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-4">
      <p className="text-sm text-muted-foreground">
        当用户没填自己的 API Key 时，请求会落到下面这组上游，每次按「积分」配置扣费。Key 字段留空不改；填 <b>&ldquo;&ndash;&ldquo;</b> 可清除。
      </p>

      {error && (
        <div className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {error}
        </div>
      )}

      <div className="rounded-xl border border-border bg-card p-4 shadow-sm">
        <h2 className="mb-3 text-sm font-semibold">积分规则</h2>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <div className="flex items-center gap-2">
            <input
              type="checkbox"
              id="shared-on"
              className="size-4 accent-primary"
              defaultChecked={cfg.shared_enabled}
              onChange={(e) => set("shared_enabled", e.target.checked)}
            />
            <Label htmlFor="shared-on" className="cursor-pointer">
              启用共享后端
            </Label>
          </div>
          <NumField
            label="新用户赠送积分"
            initial={cfg.signup_grant}
            onChange={(v) => set("signup_grant", v)}
          />
          <NumField
            label="每次对话消耗"
            initial={cfg.cost_chat}
            onChange={(v) => set("cost_chat", v)}
          />
          <NumField
            label="每次生图消耗"
            initial={cfg.cost_image}
            onChange={(v) => set("cost_image", v)}
          />
        </div>
      </div>

      <div className="rounded-xl border border-border bg-card p-4 shadow-sm">
        <h2 className="mb-3 text-sm font-semibold">邀请奖励</h2>
        <p className="mb-3 text-xs text-muted-foreground">
          被邀请人注册成功后，邀请人获得「邀请人奖励」积分，被邀请人本人额外获得「被邀请人奖励」（叠加在新用户赠送积分之上）。
        </p>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <NumField
            label="邀请人奖励"
            initial={cfg.invite_grant_inviter}
            onChange={(v) => set("invite_grant_inviter", v)}
          />
          <NumField
            label="被邀请人奖励"
            initial={cfg.invite_grant_invitee}
            onChange={(v) => set("invite_grant_invitee", v)}
          />
        </div>
      </div>

      <UpstreamBlock
        title="对话 · OpenAI 兼容"
        keySet={cfg.shared_chat_openai_key_set}
        url={cfg.shared_chat_openai_url}
        model={cfg.shared_chat_openai_model}
        onUrl={(v) => set("shared_chat_openai_url", v)}
        onModel={(v) => set("shared_chat_openai_model", v)}
        onKey={(v) => set("shared_chat_openai_key", v)}
      />
      <UpstreamBlock
        title="对话 · Anthropic Claude"
        keySet={cfg.shared_chat_claude_key_set}
        url={cfg.shared_chat_claude_url}
        model={cfg.shared_chat_claude_model}
        onUrl={(v) => set("shared_chat_claude_url", v)}
        onModel={(v) => set("shared_chat_claude_model", v)}
        onKey={(v) => set("shared_chat_claude_key", v)}
      />
      <UpstreamBlock
        title="对话 · Google Gemini"
        keySet={cfg.shared_chat_gemini_key_set}
        url={cfg.shared_chat_gemini_url}
        model={cfg.shared_chat_gemini_model}
        onUrl={(v) => set("shared_chat_gemini_url", v)}
        onModel={(v) => set("shared_chat_gemini_model", v)}
        onKey={(v) => set("shared_chat_gemini_key", v)}
      />
      <UpstreamBlock
        title="图像 · OpenAI"
        keySet={cfg.shared_image_openai_key_set}
        url={cfg.shared_image_openai_url}
        model={cfg.shared_image_openai_model}
        onUrl={(v) => set("shared_image_openai_url", v)}
        onModel={(v) => set("shared_image_openai_model", v)}
        onKey={(v) => set("shared_image_openai_key", v)}
      />
      <UpstreamBlock
        title="图像 · Gemini / Imagen"
        keySet={cfg.shared_image_gemini_key_set}
        url={cfg.shared_image_gemini_url}
        model={cfg.shared_image_gemini_model}
        onUrl={(v) => set("shared_image_gemini_url", v)}
        onModel={(v) => set("shared_image_gemini_model", v)}
        onKey={(v) => set("shared_image_gemini_key", v)}
      />

      <div className="flex items-center gap-3">
        <Button onClick={() => void save()} disabled={saving}>
          {saving ? "保存中…" : "保存设置"}
        </Button>
        <Button variant="outline" onClick={() => void load()} disabled={saving}>
          <RefreshCw /> 重载
        </Button>
        {saveMsg && (
          <span className="text-xs text-emerald-600 dark:text-emerald-400">
            {saveMsg}
          </span>
        )}
      </div>
    </div>
  )
}

function NumField({
  label,
  initial,
  onChange,
}: {
  label: string
  initial: number
  onChange: (v: number) => void
}) {
  const [s, setS] = useState(String(initial))
  return (
    <div className="flex flex-col gap-1.5">
      <Label className="text-xs">{label}</Label>
      <Input
        type="number"
        min="0"
        value={s}
        onChange={(e) => {
          setS(e.target.value)
          const n = Number(e.target.value)
          if (Number.isFinite(n) && n >= 0) onChange(Math.trunc(n))
        }}
      />
    </div>
  )
}

function UpstreamBlock({
  title,
  keySet,
  url,
  model,
  onUrl,
  onModel,
  onKey,
}: {
  title: string
  keySet: boolean
  url: string
  model: string
  onUrl: (v: string) => void
  onModel: (v: string) => void
  onKey: (v: string) => void
}) {
  const [u, setU] = useState(url)
  const [m, setM] = useState(model)
  const [k, setK] = useState("")
  return (
    <div className="rounded-xl border border-border bg-card p-4 shadow-sm">
      <h3 className="mb-3 text-sm font-semibold">{title}</h3>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <div className="flex flex-col gap-1.5 sm:col-span-2">
          <Label className="text-xs">Base URL（含具体 endpoint）</Label>
          <Input
            value={u}
            onChange={(e) => {
              setU(e.target.value)
              onUrl(e.target.value)
            }}
            placeholder="https://api.example.com/v1/chat/completions"
          />
        </div>
        <div className="flex flex-col gap-1.5">
          <Label className="text-xs">默认模型</Label>
          <Input
            value={m}
            onChange={(e) => {
              setM(e.target.value)
              onModel(e.target.value)
            }}
            placeholder="如 gpt-4o-mini"
          />
        </div>
        <div className="flex flex-col gap-1.5 sm:col-span-3">
          <Label className="text-xs">
            API Key{" "}
            <span className="text-muted-foreground">
              （当前 {keySet ? "已设置" : "未设置"}；留空不改，填 &ldquo;&ndash;&ldquo; 清除）
            </span>
          </Label>
          <Input
            type="password"
            value={k}
            onChange={(e) => {
              setK(e.target.value)
              onKey(e.target.value === "-" ? "" : e.target.value)
            }}
            placeholder={keySet ? "••••（已设置，留空不修改）" : "sk-…"}
          />
        </div>
      </div>
    </div>
  )
}
