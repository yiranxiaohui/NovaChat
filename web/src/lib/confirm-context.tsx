import {
  createContext,
  useCallback,
  useContext,
  useRef,
  useState,
  type ReactNode,
} from "react"
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"

/** 替代 window.confirm / window.prompt 的应用内对话框。
 *
 * 原生弹窗带着「127.0.0.1:3000 显示」的浏览器外壳，样式完全不受控。这里用
 * Promise 包一层，调用点的写法几乎不用变：
 *
 *   if (!window.confirm("删除？")) return
 *   → if (!(await confirm({ title: "删除？" }))) return
 */

type ConfirmOptions = {
  title: string
  description?: string
  confirmText?: string
  cancelText?: string
  /** 确认按钮用红色，用于删除这类不可逆操作 */
  destructive?: boolean
}

type PromptOptions = {
  title: string
  description?: string
  defaultValue?: string
  placeholder?: string
  confirmText?: string
}

type ConfirmContextValue = {
  confirm: (options: ConfirmOptions) => Promise<boolean>
  prompt: (options: PromptOptions) => Promise<string | null>
}

const ConfirmContext = createContext<ConfirmContextValue | null>(null)

export function useConfirm(): ConfirmContextValue {
  const ctx = useContext(ConfirmContext)
  if (!ctx) throw new Error("useConfirm 必须在 ConfirmProvider 内使用")
  return ctx
}

export function ConfirmProvider({ children }: { children: ReactNode }) {
  const [confirmState, setConfirmState] = useState<ConfirmOptions | null>(null)
  const [promptState, setPromptState] = useState<PromptOptions | null>(null)
  const [draft, setDraft] = useState("")

  // 把 resolve 存在 ref 里，等用户点了按钮再兑现 Promise。
  const confirmResolve = useRef<((value: boolean) => void) | null>(null)
  const promptResolve = useRef<((value: string | null) => void) | null>(null)

  const confirm = useCallback((options: ConfirmOptions) => {
    setConfirmState(options)
    return new Promise<boolean>((resolve) => {
      confirmResolve.current = resolve
    })
  }, [])

  const prompt = useCallback((options: PromptOptions) => {
    setPromptState(options)
    setDraft(options.defaultValue ?? "")
    return new Promise<string | null>((resolve) => {
      promptResolve.current = resolve
    })
  }, [])

  // 点按钮和关闭浮层都会走到这里；先兑现的一次生效，ref 置空后重复调用是空操作。
  function settleConfirm(value: boolean) {
    confirmResolve.current?.(value)
    confirmResolve.current = null
    setConfirmState(null)
  }

  function settlePrompt(value: string | null) {
    promptResolve.current?.(value)
    promptResolve.current = null
    setPromptState(null)
  }

  return (
    <ConfirmContext.Provider value={{ confirm, prompt }}>
      {children}

      <AlertDialog
        open={confirmState !== null}
        onOpenChange={(next) => !next && settleConfirm(false)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{confirmState?.title}</AlertDialogTitle>
            {confirmState?.description && (
              <AlertDialogDescription>
                {confirmState.description}
              </AlertDialogDescription>
            )}
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel onClick={() => settleConfirm(false)}>
              {confirmState?.cancelText ?? "取消"}
            </AlertDialogCancel>
            <AlertDialogAction
              variant={confirmState?.destructive ? "destructive" : "default"}
              onClick={() => settleConfirm(true)}
            >
              {confirmState?.confirmText ?? "确定"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <Dialog
        open={promptState !== null}
        onOpenChange={(next) => !next && settlePrompt(null)}
      >
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{promptState?.title}</DialogTitle>
            {promptState?.description && (
              <DialogDescription>{promptState.description}</DialogDescription>
            )}
          </DialogHeader>
          <form
            onSubmit={(e) => {
              e.preventDefault()
              settlePrompt(draft)
            }}
          >
            <Input
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              placeholder={promptState?.placeholder}
              autoFocus
            />
            <DialogFooter className="mt-4 flex-row justify-end">
              <Button
                type="button"
                variant="outline"
                onClick={() => settlePrompt(null)}
              >
                取消
              </Button>
              <Button type="submit">{promptState?.confirmText ?? "确定"}</Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </ConfirmContext.Provider>
  )
}
