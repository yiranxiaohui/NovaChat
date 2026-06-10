import { cn } from "@/lib/utils"

export function BrandMark({
  className,
  subtitle,
}: {
  className?: string
  subtitle?: string
}) {
  return (
    <div className={cn("flex items-center gap-3", className)}>
      <img
        src="/logo.png"
        alt="NovaChat"
        className="size-10 rounded-xl shadow-panel"
      />
      <div className="flex flex-col leading-tight">
        <span className="text-xl font-semibold tracking-tight">NovaChat</span>
        {subtitle && (
          <span className="text-xs text-muted-foreground">{subtitle}</span>
        )}
      </div>
    </div>
  )
}
