import { useEffect, useState } from "react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { useAuth } from "@/lib/auth-context"
import { profileApi } from "@/lib/profile"

type Props = {
  open: boolean
  onClose: () => void
}

export function ProfileDialog({ open, onClose }: Props) {
  const auth = useAuth()
  const user = auth.state.status === "authed" ? auth.state.user : null

  const [displayName, setDisplayName] = useState("")
  const [avatarUrl, setAvatarUrl] = useState("")
  const [avatarBroken, setAvatarBroken] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)

  const [pwOpen, setPwOpen] = useState(false)
  const [currentPw, setCurrentPw] = useState("")
  const [newPw, setNewPw] = useState("")
  const [confirmPw, setConfirmPw] = useState("")
  const [pwSaving, setPwSaving] = useState(false)
  const [pwMsg, setPwMsg] = useState<string | null>(null)

  useEffect(() => {
    if (!open || !user) return
    setDisplayName(user.display_name ?? "")
    setAvatarUrl(user.avatar_url ?? "")
    setAvatarBroken(false)
    setError(null)
    setPwOpen(false)
    setCurrentPw("")
    setNewPw("")
    setConfirmPw("")
    setPwMsg(null)
  }, [open, user])

  useEffect(() => {
    setAvatarBroken(false)
  }, [avatarUrl])

  if (!open || !user) return null

  const trimmedAvatar = avatarUrl.trim()
  const initial = (
    (displayName.trim() || user.username || "?").slice(0, 1) || "?"
  ).toUpperCase()
  const dirty =
    (displayName.trim() || null) !== (user.display_name ?? null) ||
    (trimmedAvatar || null) !== (user.avatar_url ?? null)

  async function save() {
    setError(null)
    setSaving(true)
    try {
      const updated = await profileApi.update({
        display_name: displayName,
        avatar_url: avatarUrl,
      })
      auth.updateUser(updated)
      onClose()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setSaving(false)
    }
  }

  async function changePassword() {
    setPwMsg(null)
    if (!currentPw) {
      setPwMsg("请输入当前密码")
      return
    }
    if (newPw.length < 6 || newPw.length > 256) {
      setPwMsg("新密码需为 6-256 位")
      return
    }
    if (newPw !== confirmPw) {
      setPwMsg("两次输入的新密码不一致")
      return
    }
    setPwSaving(true)
    try {
      await profileApi.changePassword(currentPw, newPw)
      setPwMsg("密码已更新")
      setCurrentPw("")
      setNewPw("")
      setConfirmPw("")
    } catch (e) {
      setPwMsg(e instanceof Error ? e.message : String(e))
    } finally {
      setPwSaving(false)
    }
  }

  const showImage = trimmedAvatar && !avatarBroken

  return (
    <div
      className="fixed inset-0 z-50 grid place-items-center bg-black/50 p-4"
      onClick={onClose}
    >
      <div
        className="flex w-full max-w-lg flex-col gap-4 rounded-lg border border-border bg-background p-6 shadow-lg"
        onClick={(e) => e.stopPropagation()}
        style={{ maxHeight: "calc(100svh - 2rem)", overflowY: "auto" }}
      >
        <div>
          <h2 className="text-lg font-semibold">个人资料</h2>
          <p className="text-sm text-muted-foreground">
            修改昵称、头像或密码。用户名一旦注册后不可更改。
          </p>
        </div>

        {error && (
          <div className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
            {error}
          </div>
        )}

        <div className="flex items-center gap-4">
          {showImage ? (
            <img
              src={trimmedAvatar}
              alt=""
              className="size-16 shrink-0 rounded-full border border-border object-cover"
              onError={() => setAvatarBroken(true)}
            />
          ) : (
            <div className="grid size-16 shrink-0 place-items-center rounded-full bg-gradient-to-br from-primary to-chart-5 text-xl font-semibold text-primary-foreground">
              {initial}
            </div>
          )}
          <div className="min-w-0 flex-1">
            <p className="text-xs text-muted-foreground">用户名</p>
            <p className="truncate font-medium">{user.username}</p>
            {trimmedAvatar && avatarBroken && (
              <p className="mt-0.5 text-xs text-destructive">头像链接无法加载</p>
            )}
          </div>
        </div>

        <div className="flex flex-col gap-1.5">
          <Label htmlFor="p-name">昵称</Label>
          <Input
            id="p-name"
            value={displayName}
            onChange={(e) => setDisplayName(e.target.value)}
            maxLength={64}
            placeholder="留空则显示用户名"
          />
        </div>

        <div className="flex flex-col gap-1.5">
          <Label htmlFor="p-avatar">头像 URL</Label>
          <Input
            id="p-avatar"
            value={avatarUrl}
            onChange={(e) => setAvatarUrl(e.target.value)}
            maxLength={512}
            placeholder="https://… 或 data:image/…"
          />
          <p className="text-xs text-muted-foreground">
            支持 http(s) 图片链接或 data:image 编码。留空使用首字母头像。
          </p>
        </div>

        <div className="flex flex-col gap-2 rounded-md border border-border bg-muted/30 p-3">
          <button
            type="button"
            className="flex items-center justify-between text-sm font-medium"
            onClick={() => setPwOpen((o) => !o)}
          >
            <span>修改密码</span>
            <span className="text-xs text-muted-foreground">
              {pwOpen ? "收起" : "展开"}
            </span>
          </button>
          {pwOpen && (
            <div className="flex flex-col gap-2">
              <Input
                type="password"
                autoComplete="current-password"
                placeholder="当前密码"
                value={currentPw}
                onChange={(e) => setCurrentPw(e.target.value)}
              />
              <Input
                type="password"
                autoComplete="new-password"
                placeholder="新密码（6-256 位）"
                value={newPw}
                onChange={(e) => setNewPw(e.target.value)}
              />
              <Input
                type="password"
                autoComplete="new-password"
                placeholder="确认新密码"
                value={confirmPw}
                onChange={(e) => setConfirmPw(e.target.value)}
              />
              {pwMsg && (
                <p className="text-xs text-muted-foreground">{pwMsg}</p>
              )}
              <div className="flex justify-end">
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => void changePassword()}
                  disabled={
                    pwSaving || !currentPw || !newPw || !confirmPw
                  }
                >
                  {pwSaving ? "更新中…" : "更新密码"}
                </Button>
              </div>
            </div>
          )}
        </div>

        <div className="flex justify-end gap-2">
          <Button variant="outline" onClick={onClose} disabled={saving}>
            取消
          </Button>
          <Button onClick={() => void save()} disabled={saving || !dirty}>
            {saving ? "保存中…" : "保存"}
          </Button>
        </div>
      </div>
    </div>
  )
}
