import { useEffect, useState } from "react"
import { Link, Navigate } from "react-router-dom"
import {
  ArrowLeft,
  BarChart3,
  Coins,
  CreditCard,
  Database,
  Key,
  Mail,
  Menu,
  Plug,
  RefreshCw,
  Send,
  Server,
  Shield,
  Ticket,
  Trash2,
  UserCog,
  Users,
} from "lucide-react"
import { cn } from "@/lib/utils"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { useAuth } from "@/lib/auth-context"
import {
  adminApi,
  type AdminInviteRow,
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
import {
  adminPaymentsApi,
  type AdminOrder,
  type AdminPaymentConfig,
  type AdminPaymentConfigUpdate,
} from "@/lib/payments"

type Section =
  | "overview"
  | "users"
  | "credits"
  | "payments"
  | "invites"
  | "shared"
  | "email"
  | "system"

const NAV: { key: Section; label: string; icon: React.ComponentType<{ className?: string }> }[] = [
  { key: "overview", label: "概览", icon: BarChart3 },
  { key: "users", label: "用户管理", icon: Users },
  { key: "credits", label: "积分", icon: Coins },
  { key: "payments", label: "支付 / 充值", icon: CreditCard },
  { key: "invites", label: "邀请", icon: Ticket },
  { key: "shared", label: "共享后端", icon: Plug },
  { key: "email", label: "邮箱 / SMTP", icon: Mail },
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
  const [mobileNavOpen, setMobileNavOpen] = useState(false)

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
      {mobileNavOpen && (
        <button
          type="button"
          aria-label="关闭侧栏"
          onClick={() => setMobileNavOpen(false)}
          className="fixed inset-0 z-30 bg-black/50 md:hidden"
        />
      )}
      <aside
        className={cn(
          "fixed inset-y-0 left-0 z-40 flex h-full w-60 max-w-[85vw] flex-col border-r border-sidebar-border bg-sidebar transition-transform",
          mobileNavOpen ? "translate-x-0 shadow-2xl" : "-translate-x-full",
          "md:static md:w-60 md:max-w-none md:shrink-0 md:translate-x-0 md:shadow-none"
        )}
      >
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
                onClick={() => {
                  setSection(n.key)
                  setMobileNavOpen(false)
                }}
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
        <header className="flex items-center justify-between gap-2 border-b border-border bg-background/70 px-3 py-3 backdrop-blur md:px-6 md:py-4">
          <div className="flex min-w-0 items-center gap-2">
            <Button
              variant="ghost"
              size="icon"
              className="md:hidden"
              onClick={() => setMobileNavOpen(true)}
              aria-label="打开侧栏"
            >
              <Menu />
            </Button>
            <div className="min-w-0">
              <h1 className="truncate text-lg font-semibold tracking-tight md:text-xl">
                {NAV.find((n) => n.key === section)?.label}
              </h1>
              <p className="hidden text-sm text-muted-foreground sm:block">
                仅管理员可见。对系统全局生效。
              </p>
            </div>
          </div>
        </header>

        <main className="mx-auto w-full max-w-5xl px-3 py-4 md:px-6 md:py-6">
          {section === "overview" && <OverviewPanel />}
          {section === "users" && <UsersPanel currentUserId={currentUser.id} />}
          {section === "credits" && <CreditsPanel />}
          {section === "payments" && <PaymentsPanel />}
          {section === "invites" && <InvitesPanel />}
          {section === "shared" && <SharedBackendPanel />}
          {section === "email" && <EmailPanel />}
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

      <div className="overflow-x-auto rounded-lg border border-border">
        <table className="w-full min-w-[36rem] text-sm">
          <thead className="bg-muted/40 text-xs uppercase text-muted-foreground">
            <tr>
              <th className="px-3 py-2 text-left font-medium">ID</th>
              <th className="px-3 py-2 text-left font-medium">用户</th>
              <th className="px-3 py-2 text-left font-medium">角色</th>
              <th className="px-3 py-2 text-left font-medium">邮箱</th>
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
                  colSpan={9}
                  className="px-3 py-6 text-center text-muted-foreground"
                >
                  加载中…
                </td>
              </tr>
            )}
            {!loading && filtered.length === 0 && (
              <tr>
                <td
                  colSpan={9}
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
                  <td
                    className="max-w-[14rem] truncate px-3 py-2 text-xs text-muted-foreground"
                    title={u.email ?? ""}
                  >
                    {u.email || "—"}
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

      <div className="overflow-x-auto rounded-lg border border-border">
        <table className="w-full min-w-[36rem] text-sm">
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

function InvitesPanel() {
  const [rows, setRows] = useState<AdminInviteRow[]>([])
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [query, setQuery] = useState("")

  async function load() {
    setLoading(true)
    setError(null)
    try {
      setRows(await adminApi.listInvites())
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
    ? rows.filter(
        (r) =>
          r.inviter_username.toLowerCase().includes(q) ||
          r.invitee_username.toLowerCase().includes(q) ||
          (r.inviter_code ?? "").toLowerCase().includes(q)
      )
    : rows

  const leaderboard = (() => {
    const m = new Map<
      number,
      { id: number; username: string; code: string | null; count: number }
    >()
    for (const r of rows) {
      const cur = m.get(r.inviter_id)
      if (cur) cur.count += 1
      else
        m.set(r.inviter_id, {
          id: r.inviter_id,
          username: r.inviter_username,
          code: r.inviter_code,
          count: 1,
        })
    }
    return Array.from(m.values())
      .sort((a, b) => b.count - a.count || a.username.localeCompare(b.username))
      .slice(0, 10)
  })()

  return (
    <div className="flex flex-col gap-4">
      <p className="text-sm text-muted-foreground">
        全站所有成功触发邀请奖励的注册关系。最多展示最近 500 条。
      </p>

      <div className="flex items-center gap-2">
        <Input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="搜索邀请人 / 被邀请人 / 邀请码…"
          className="max-w-xs"
        />
        <Button variant="outline" size="sm" onClick={() => void load()}>
          <RefreshCw /> 刷新
        </Button>
        <span className="ml-auto text-xs text-muted-foreground">
          共 {rows.length} 条
        </span>
      </div>

      {error && (
        <div className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {error}
        </div>
      )}

      {leaderboard.length > 0 && (
        <div className="rounded-xl border border-border bg-card p-4 shadow-sm">
          <h2 className="mb-3 text-sm font-semibold">邀请榜 · Top 10</h2>
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
            {leaderboard.map((l, idx) => (
              <div
                key={l.id}
                className="flex items-center justify-between rounded-md border border-border/60 bg-background px-3 py-2 text-sm"
              >
                <div className="flex min-w-0 items-center gap-2">
                  <span className="w-5 text-right font-mono text-xs text-muted-foreground">
                    {idx + 1}
                  </span>
                  <span className="truncate font-medium">{l.username}</span>
                  {l.code && (
                    <span className="truncate font-mono text-[11px] text-muted-foreground">
                      {l.code}
                    </span>
                  )}
                </div>
                <span className="tabular-nums text-sm">
                  <b>{l.count}</b>{" "}
                  <span className="text-xs text-muted-foreground">人</span>
                </span>
              </div>
            ))}
          </div>
        </div>
      )}

      <div className="overflow-x-auto rounded-lg border border-border">
        <table className="w-full min-w-[36rem] text-sm">
          <thead className="bg-muted/40 text-xs uppercase text-muted-foreground">
            <tr>
              <th className="px-3 py-2 text-left font-medium">邀请人</th>
              <th className="px-3 py-2 text-left font-medium">邀请码</th>
              <th className="px-3 py-2 text-left font-medium">被邀请人</th>
              <th className="px-3 py-2 text-left font-medium">注册时间</th>
            </tr>
          </thead>
          <tbody>
            {loading && (
              <tr>
                <td colSpan={4} className="px-3 py-6 text-center text-muted-foreground">
                  加载中…
                </td>
              </tr>
            )}
            {!loading && filtered.length === 0 && (
              <tr>
                <td colSpan={4} className="px-3 py-6 text-center text-muted-foreground">
                  暂无邀请记录
                </td>
              </tr>
            )}
            {filtered.map((r) => (
              <tr
                key={`${r.inviter_id}-${r.invitee_id}`}
                className="border-t border-border hover:bg-accent/30"
              >
                <td className="px-3 py-2">
                  <span className="font-medium">{r.inviter_username}</span>
                  <span className="ml-1 text-xs text-muted-foreground">
                    #{r.inviter_id}
                  </span>
                </td>
                <td className="px-3 py-2 font-mono text-xs text-muted-foreground">
                  {r.inviter_code ?? "—"}
                </td>
                <td className="px-3 py-2">
                  <span className="font-medium">{r.invitee_username}</span>
                  <span className="ml-1 text-xs text-muted-foreground">
                    #{r.invitee_id}
                  </span>
                </td>
                <td className="px-3 py-2 text-xs text-muted-foreground">
                  {r.invitee_created_at.replace("T", " ").replace("Z", "")}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
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
        hostPlaceholder="https://api.openai.com"
        pathHint="/v1/chat/completions"
        onUrl={(v) => set("shared_chat_openai_url", v)}
        onKey={(v) => set("shared_chat_openai_key", v)}
      />
      <UpstreamBlock
        title="对话 · Anthropic Claude"
        keySet={cfg.shared_chat_claude_key_set}
        url={cfg.shared_chat_claude_url}
        hostPlaceholder="https://api.anthropic.com"
        pathHint="/v1/messages"
        onUrl={(v) => set("shared_chat_claude_url", v)}
        onKey={(v) => set("shared_chat_claude_key", v)}
      />
      <UpstreamBlock
        title="对话 · Google Gemini"
        keySet={cfg.shared_chat_gemini_key_set}
        url={cfg.shared_chat_gemini_url}
        hostPlaceholder="https://generativelanguage.googleapis.com"
        pathHint="/v1beta/models/{model}:streamGenerateContent"
        onUrl={(v) => set("shared_chat_gemini_url", v)}
        onKey={(v) => set("shared_chat_gemini_key", v)}
      />
      <UpstreamBlock
        title="图像 · OpenAI"
        keySet={cfg.shared_image_openai_key_set}
        url={cfg.shared_image_openai_url}
        hostPlaceholder="https://api.openai.com"
        pathHint="/v1/images/generations"
        onUrl={(v) => set("shared_image_openai_url", v)}
        onKey={(v) => set("shared_image_openai_key", v)}
      />
      <UpstreamBlock
        title="图像 · Gemini / Imagen"
        keySet={cfg.shared_image_gemini_key_set}
        url={cfg.shared_image_gemini_url}
        hostPlaceholder="https://generativelanguage.googleapis.com"
        pathHint="/v1beta/models/{model}:predict"
        onUrl={(v) => set("shared_image_gemini_url", v)}
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
  hostPlaceholder,
  pathHint,
  onUrl,
  onKey,
}: {
  title: string
  keySet: boolean
  url: string
  hostPlaceholder: string
  pathHint: string
  onUrl: (v: string) => void
  onKey: (v: string) => void
}) {
  const [u, setU] = useState(url)
  const [k, setK] = useState("")

  return (
    <div className="rounded-xl border border-border bg-card p-4 shadow-sm">
      <h3 className="mb-3 text-sm font-semibold">{title}</h3>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <div className="flex flex-col gap-1.5 sm:col-span-3">
          <Label className="text-xs">
            Base URL{" "}
            <span className="text-muted-foreground">
              （只填主机，路径自动补 <code>{pathHint}</code>）
            </span>
          </Label>
          <Input
            value={u}
            onChange={(e) => {
              const v = e.target.value.replace(/\/+$/, "")
              setU(e.target.value)
              onUrl(v)
            }}
            placeholder={hostPlaceholder}
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
        <p className="text-[11px] text-muted-foreground sm:col-span-3">
          模型不再在此处配置——用户在设置或图像工作室里实时从上游拉取并自由选择。
        </p>
      </div>
    </div>
  )
}

function EmailPanel() {
  const [cfg, setCfg] = useState<AdminSettings | null>(null)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [saveMsg, setSaveMsg] = useState<string | null>(null)
  const [patch, setPatch] = useState<AdminSettingsUpdate>({})
  const [testEmail, setTestEmail] = useState("")
  const [testing, setTesting] = useState(false)
  const [testMsg, setTestMsg] = useState<string | null>(null)
  const [testErr, setTestErr] = useState<string | null>(null)

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

  async function sendTest() {
    setTestMsg(null)
    setTestErr(null)
    if (!testEmail.trim()) {
      setTestErr("请输入收件邮箱")
      return
    }
    setTesting(true)
    try {
      await adminCreditsApi.sendTestEmail(testEmail.trim())
      setTestMsg("已发送，请检查收件箱（可能在垃圾邮件中）")
    } catch (e) {
      setTestErr(e instanceof Error ? e.message : String(e))
    } finally {
      setTesting(false)
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
        配置发信 SMTP 及是否要求新用户注册时通过邮箱验证码验证。密码留空不修改；填 <b>&ldquo;&ndash;&ldquo;</b> 可清除。
      </p>

      {error && (
        <div className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {error}
        </div>
      )}

      <div className="rounded-xl border border-border bg-card p-4 shadow-sm">
        <h2 className="mb-3 text-sm font-semibold">注册策略</h2>
        <div className="flex items-center gap-2">
          <input
            type="checkbox"
            id="registration-enabled"
            className="size-4 accent-primary"
            defaultChecked={cfg.registration_enabled}
            onChange={(e) => set("registration_enabled", e.target.checked)}
          />
          <Label htmlFor="registration-enabled" className="cursor-pointer">
            允许新用户注册
          </Label>
        </div>
        <p className="mt-2 mb-4 text-xs text-muted-foreground">
          关闭后，注册接口返回 403；仅管理员可在「用户管理」为新成员手动创建账号时才能加人。建议公开部署在配置完初始管理员后关闭。
        </p>
        <div className="flex items-center gap-2">
          <input
            type="checkbox"
            id="email-required"
            className="size-4 accent-primary"
            defaultChecked={cfg.email_verification_required}
            onChange={(e) =>
              set("email_verification_required", e.target.checked)
            }
          />
          <Label htmlFor="email-required" className="cursor-pointer">
            注册时要求邮箱验证码
          </Label>
        </div>
        <p className="mt-2 text-xs text-muted-foreground">
          开启后，注册页会要求填写邮箱并输入接收到的 6 位验证码（10 分钟有效，60 秒冷却）。
        </p>
      </div>

      <div className="rounded-xl border border-border bg-card p-4 shadow-sm">
        <h2 className="mb-3 text-sm font-semibold">SMTP 服务器</h2>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <div className="flex flex-col gap-1.5 sm:col-span-2">
            <Label className="text-xs">主机</Label>
            <Input
              defaultValue={cfg.smtp_host}
              placeholder="smtp.example.com"
              onChange={(e) => set("smtp_host", e.target.value)}
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label className="text-xs">端口</Label>
            <Input
              type="number"
              min="1"
              max="65535"
              defaultValue={String(cfg.smtp_port)}
              onChange={(e) => {
                const n = Number(e.target.value)
                if (Number.isFinite(n) && n > 0 && n < 65536)
                  set("smtp_port", Math.trunc(n))
              }}
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label className="text-xs">加密方式</Label>
            <select
              defaultValue={cfg.smtp_security || "starttls"}
              onChange={(e) => set("smtp_security", e.target.value)}
              className="h-9 rounded-md border border-input bg-background px-3 text-sm"
            >
              <option value="starttls">STARTTLS（推荐，端口 587）</option>
              <option value="tls">TLS / SSL（端口 465）</option>
              <option value="none">不加密（仅局域网测试）</option>
            </select>
          </div>
          <div className="flex flex-col gap-1.5">
            <Label className="text-xs">用户名</Label>
            <Input
              defaultValue={cfg.smtp_username}
              placeholder="通常为发件邮箱"
              onChange={(e) => set("smtp_username", e.target.value)}
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label className="text-xs">
              密码{" "}
              <span className="text-muted-foreground">
                （当前 {cfg.smtp_password_set ? "已设置" : "未设置"}；留空不改，填 &ldquo;&ndash;&ldquo; 清除）
              </span>
            </Label>
            <Input
              type="password"
              placeholder={
                cfg.smtp_password_set ? "••••（已设置，留空不修改）" : ""
              }
              onChange={(e) =>
                set("smtp_password", e.target.value === "-" ? "" : e.target.value)
              }
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label className="text-xs">发件人邮箱</Label>
            <Input
              type="email"
              defaultValue={cfg.smtp_from_email}
              placeholder="noreply@example.com"
              onChange={(e) => set("smtp_from_email", e.target.value)}
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label className="text-xs">发件人名称</Label>
            <Input
              defaultValue={cfg.smtp_from_name}
              placeholder="NovaChat"
              onChange={(e) => set("smtp_from_name", e.target.value)}
            />
          </div>
        </div>
      </div>

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

      <div className="rounded-xl border border-border bg-card p-4 shadow-sm">
        <h2 className="mb-3 text-sm font-semibold">发送测试邮件</h2>
        <p className="mb-3 text-xs text-muted-foreground">
          保存 SMTP 配置后，向指定邮箱发送一封测试邮件验证连通性。
        </p>
        <div className="flex flex-col gap-2 sm:flex-row">
          <Input
            type="email"
            placeholder="收件邮箱"
            value={testEmail}
            onChange={(e) => setTestEmail(e.target.value)}
            className="flex-1"
          />
          <Button onClick={() => void sendTest()} disabled={testing}>
            <Send /> {testing ? "发送中…" : "发送测试邮件"}
          </Button>
        </div>
        {testMsg && (
          <p className="mt-2 text-xs text-emerald-600 dark:text-emerald-400">
            {testMsg}
          </p>
        )}
        {testErr && <p className="mt-2 text-xs text-destructive">{testErr}</p>}
      </div>
    </div>
  )
}

function PaymentsPanel() {
  const [cfg, setCfg] = useState<AdminPaymentConfig | null>(null)
  const [patch, setPatch] = useState<AdminPaymentConfigUpdate>({})
  const [orders, setOrders] = useState<AdminOrder[]>([])
  const [statusFilter, setStatusFilter] = useState<"" | "pending" | "paid" | "failed">("")
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [saveMsg, setSaveMsg] = useState<string | null>(null)

  async function loadAll() {
    setLoading(true)
    setError(null)
    try {
      const [c, o] = await Promise.all([
        adminPaymentsApi.getConfig(),
        adminPaymentsApi.listOrders(
          statusFilter ? { status: statusFilter } : {}
        ),
      ])
      setCfg(c)
      setOrders(o)
      setPatch({})
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setLoading(false)
    }
  }
  useEffect(() => {
    void loadAll()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [statusFilter])

  function set<K extends keyof AdminPaymentConfigUpdate>(
    k: K,
    v: AdminPaymentConfigUpdate[K]
  ) {
    setPatch((p) => ({ ...p, [k]: v }))
  }

  async function save() {
    setSaveMsg(null)
    setError(null)
    setSaving(true)
    try {
      await adminPaymentsApi.updateConfig(patch)
      setSaveMsg("已保存")
      await loadAll()
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
        {error ?? "无法加载支付配置"}
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-4">
      <p className="text-sm text-muted-foreground">
        当前对接 <b>易支付</b>（epay）通用协议。用户在充值弹窗下单后会跳转到
        <code>API URL</code> 完成支付，支付平台异步回调 <code>notify_url</code>，回调里的
        <code>MD5</code> 签名用「商户密钥」校验，成功即按「1 元 = N 积分」比例入账。
      </p>

      {error && (
        <div className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {error}
        </div>
      )}

      <div className="rounded-xl border border-border bg-card p-4 shadow-sm">
        <h2 className="mb-3 text-sm font-semibold">网关配置</h2>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <div className="flex items-center gap-2 sm:col-span-2">
            <input
              type="checkbox"
              id="epay-on"
              className="size-4 accent-primary"
              defaultChecked={cfg.enabled}
              onChange={(e) => set("enabled", e.target.checked)}
            />
            <Label htmlFor="epay-on" className="cursor-pointer">
              启用充值入口（关闭时，前端不显示「充值」按钮，API 拒绝下单）
            </Label>
          </div>
          <div className="flex flex-col gap-1.5 sm:col-span-2">
            <Label className="text-xs">
              API URL <span className="text-muted-foreground">（如 https://pay.example.com/submit.php）</span>
            </Label>
            <Input
              defaultValue={cfg.api_url}
              onChange={(e) => set("api_url", e.target.value.trim())}
              placeholder="https://pay.example.com/submit.php"
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label className="text-xs">商户 ID (pid)</Label>
            <Input
              defaultValue={cfg.pid}
              onChange={(e) => set("pid", e.target.value.trim())}
              placeholder="1000"
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label className="text-xs">
              商户密钥{" "}
              <span className="text-muted-foreground">
                （当前 {cfg.key_set ? "已设置" : "未设置"}；留空不改，填
                &ldquo;&ndash;&ldquo; 清除）
              </span>
            </Label>
            <Input
              type="password"
              onChange={(e) =>
                set("key", e.target.value === "-" ? "" : e.target.value)
              }
              placeholder={cfg.key_set ? "••••（已设置，留空不修改）" : ""}
            />
          </div>
          <div className="flex flex-col gap-1.5 sm:col-span-2">
            <Label className="text-xs">
              异步通知地址 notify_url{" "}
              <span className="text-muted-foreground">
                （必须是公网可达的绝对 URL，指向本站 /api/payments/epay/notify）
              </span>
            </Label>
            <Input
              defaultValue={cfg.notify_url}
              onChange={(e) => set("notify_url", e.target.value.trim())}
              placeholder="https://your-domain.com/api/payments/epay/notify"
            />
          </div>
          <div className="flex flex-col gap-1.5 sm:col-span-2">
            <Label className="text-xs">
              同步回跳地址 return_url{" "}
              <span className="text-muted-foreground">
                （用户支付后浏览器跳回此地址，指向本站
                /api/payments/epay/return）
              </span>
            </Label>
            <Input
              defaultValue={cfg.return_url}
              onChange={(e) => set("return_url", e.target.value.trim())}
              placeholder="https://your-domain.com/api/payments/epay/return"
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label className="text-xs">1 元 = 多少积分</Label>
            <Input
              type="number"
              min="1"
              defaultValue={cfg.credits_per_yuan}
              onChange={(e) => {
                const n = Number(e.target.value)
                if (Number.isFinite(n) && n >= 1) set("credits_per_yuan", Math.trunc(n))
              }}
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label className="text-xs">商品名称</Label>
            <Input
              defaultValue={cfg.product_name}
              onChange={(e) => set("product_name", e.target.value)}
              placeholder="NovaChat 积分充值"
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label className="text-xs">最小金额（元）</Label>
            <Input
              type="number"
              min="1"
              defaultValue={cfg.min_yuan}
              onChange={(e) => {
                const n = Number(e.target.value)
                if (Number.isFinite(n) && n >= 1) set("min_yuan", Math.trunc(n))
              }}
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label className="text-xs">最大金额（元）</Label>
            <Input
              type="number"
              min="1"
              defaultValue={cfg.max_yuan}
              onChange={(e) => {
                const n = Number(e.target.value)
                if (Number.isFinite(n) && n >= 1) set("max_yuan", Math.trunc(n))
              }}
            />
          </div>
        </div>

        <div className="mt-4 flex items-center gap-3">
          <Button onClick={() => void save()} disabled={saving}>
            {saving ? "保存中…" : "保存配置"}
          </Button>
          <Button variant="outline" onClick={() => void loadAll()} disabled={saving}>
            <RefreshCw /> 重载
          </Button>
          {saveMsg && (
            <span className="text-xs text-emerald-600 dark:text-emerald-400">
              {saveMsg}
            </span>
          )}
        </div>
      </div>

      <div className="rounded-xl border border-border bg-card p-4 shadow-sm">
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-sm font-semibold">充值订单</h2>
          <div className="flex items-center gap-2">
            <select
              className="h-8 rounded-md border border-input bg-background px-2 text-xs"
              value={statusFilter}
              onChange={(e) =>
                setStatusFilter(e.target.value as typeof statusFilter)
              }
            >
              <option value="">全部状态</option>
              <option value="pending">待支付</option>
              <option value="paid">已支付</option>
              <option value="failed">已关闭</option>
            </select>
            <Button variant="outline" size="sm" onClick={() => void loadAll()}>
              <RefreshCw /> 刷新
            </Button>
          </div>
        </div>

        <div className="overflow-x-auto rounded-lg border border-border">
          <table className="w-full min-w-[32rem] text-xs">
            <thead className="bg-muted/40 text-[10px] uppercase text-muted-foreground">
              <tr>
                <th className="px-2 py-2 text-left font-medium">订单号</th>
                <th className="px-2 py-2 text-left font-medium">用户</th>
                <th className="px-2 py-2 text-left font-medium">方式</th>
                <th className="px-2 py-2 text-right font-medium">金额</th>
                <th className="px-2 py-2 text-right font-medium">积分</th>
                <th className="px-2 py-2 text-left font-medium">状态</th>
                <th className="px-2 py-2 text-left font-medium">创建</th>
                <th className="px-2 py-2 text-left font-medium">支付时间</th>
              </tr>
            </thead>
            <tbody>
              {orders.length === 0 && (
                <tr>
                  <td colSpan={8} className="px-2 py-6 text-center text-muted-foreground">
                    暂无订单
                  </td>
                </tr>
              )}
              {orders.map((o) => (
                <tr key={o.id} className="border-t border-border">
                  <td className="px-2 py-1.5 font-mono text-[11px]">
                    {o.out_trade_no}
                  </td>
                  <td className="px-2 py-1.5">{o.username}</td>
                  <td className="px-2 py-1.5">{o.payway}</td>
                  <td className="px-2 py-1.5 text-right tabular-nums">
                    ¥{(o.amount_cents / 100).toFixed(2)}
                  </td>
                  <td className="px-2 py-1.5 text-right tabular-nums">
                    +{o.credits}
                  </td>
                  <td className="px-2 py-1.5">
                    <OrderStatus status={o.status} />
                  </td>
                  <td className="px-2 py-1.5 text-muted-foreground">
                    {o.created_at}
                  </td>
                  <td className="px-2 py-1.5 text-muted-foreground">
                    {o.paid_at ?? "-"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  )
}

function OrderStatus({ status }: { status: "pending" | "paid" | "failed" }) {
  const map = {
    pending: { label: "待支付", cls: "bg-amber-500/10 text-amber-600 dark:text-amber-400" },
    paid: { label: "已支付", cls: "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400" },
    failed: { label: "已关闭", cls: "bg-destructive/10 text-destructive" },
  } as const
  const m = map[status]
  return (
    <span className={`inline-block rounded px-1.5 py-0.5 text-[10px] ${m.cls}`}>
      {m.label}
    </span>
  )
}
