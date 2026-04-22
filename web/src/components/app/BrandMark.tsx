import { Sparkles } from "lucide-react"
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
      <div className="grid size-10 place-items-center rounded-xl bg-gradient-to-br from-primary to-chart-5 text-primary-foreground shadow-panel">
        <Sparkles className="size-5" />
      </div>
      <div className="flex flex-col leading-tight">
        <span className="text-xl font-semibold tracking-tight">NovaChat</span>
        {subtitle && (
          <span className="text-xs text-muted-foreground">{subtitle}</span>
        )}
      </div>
    </div>
  )
}
