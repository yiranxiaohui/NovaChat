import { useEffect, useRef, useState } from "react"
import { Download, Minus, Plus, RotateCcw, X } from "lucide-react"
import { filenameFromPath } from "@/lib/media-path"

const MIN_ZOOM = 0.2
const MAX_ZOOM = 8

export function ImagePreview({
  src,
  alt,
  onClose,
  extraActions,
}: {
  src: string
  alt: string
  onClose: () => void
  extraActions?: React.ReactNode
}) {
  const [scale, setScale] = useState(1)
  const [offset, setOffset] = useState({ x: 0, y: 0 })
  const dragRef = useRef<{ startX: number; startY: number; ox: number; oy: number } | null>(null)

  const reset = () => {
    setScale(1)
    setOffset({ x: 0, y: 0 })
  }
  const zoomBy = (factor: number) => {
    setScale((s) => Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, s * factor)))
  }

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose()
      else if (e.key === "+" || e.key === "=") zoomBy(1.2)
      else if (e.key === "-" || e.key === "_") zoomBy(1 / 1.2)
      else if (e.key === "0") reset()
    }
    window.addEventListener("keydown", onKey)
    const prevOverflow = document.body.style.overflow
    document.body.style.overflow = "hidden"
    return () => {
      window.removeEventListener("keydown", onKey)
      document.body.style.overflow = prevOverflow
    }
  }, [onClose])

  const onWheel = (e: React.WheelEvent) => {
    e.preventDefault()
    const factor = e.deltaY < 0 ? 1.12 : 1 / 1.12
    setScale((s) => Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, s * factor)))
  }

  const onPointerDown = (e: React.PointerEvent<HTMLImageElement>) => {
    if (scale <= 1) return
    ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
    dragRef.current = {
      startX: e.clientX,
      startY: e.clientY,
      ox: offset.x,
      oy: offset.y,
    }
  }
  const onPointerMove = (e: React.PointerEvent<HTMLImageElement>) => {
    const d = dragRef.current
    if (!d) return
    setOffset({
      x: d.ox + (e.clientX - d.startX),
      y: d.oy + (e.clientY - d.startY),
    })
  }
  const onPointerUp = (e: React.PointerEvent<HTMLImageElement>) => {
    dragRef.current = null
    try {
      ;(e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId)
    } catch {
      /* ignore */
    }
  }

  const onDoubleClick = (e: React.MouseEvent) => {
    e.stopPropagation()
    if (scale === 1) {
      setScale(2)
    } else {
      reset()
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center overflow-hidden bg-black/80 p-4 select-none"
      onClick={onClose}
      onWheel={onWheel}
      role="dialog"
      aria-label="图片预览"
    >
      <img
        src={src}
        alt={alt}
        draggable={false}
        onClick={(e) => e.stopPropagation()}
        onDoubleClick={onDoubleClick}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        style={{
          transform: `translate(${offset.x}px, ${offset.y}px) scale(${scale})`,
          cursor: scale > 1 ? (dragRef.current ? "grabbing" : "grab") : "zoom-in",
          transition: dragRef.current ? "none" : "transform 120ms ease-out",
        }}
        className="max-h-[95vh] max-w-[95vw] rounded-lg shadow-2xl will-change-transform"
      />

      <div
        className="absolute bottom-6 left-1/2 flex -translate-x-1/2 items-center gap-1 rounded-full border border-white/10 bg-black/60 px-1.5 py-1 text-white shadow-lg backdrop-blur"
        onClick={(e) => e.stopPropagation()}
      >
        <button
          type="button"
          onClick={() => zoomBy(1 / 1.2)}
          aria-label="缩小"
          title="缩小 ( - )"
          className="grid size-8 place-items-center rounded-full hover:bg-white/10"
        >
          <Minus className="size-4" />
        </button>
        <button
          type="button"
          onClick={reset}
          aria-label="重置"
          title="重置 ( 0 )"
          className="inline-flex h-8 min-w-[3.75rem] items-center justify-center gap-1 rounded-full px-2 text-xs tabular-nums hover:bg-white/10"
        >
          <RotateCcw className="size-3.5" />
          {Math.round(scale * 100)}%
        </button>
        <button
          type="button"
          onClick={() => zoomBy(1.2)}
          aria-label="放大"
          title="放大 ( + )"
          className="grid size-8 place-items-center rounded-full hover:bg-white/10"
        >
          <Plus className="size-4" />
        </button>
      </div>

      <div
        className="absolute right-4 top-4 flex items-center gap-2"
        onClick={(e) => e.stopPropagation()}
      >
        {extraActions}
        <a
          href={src}
          download={filenameFromPath(src) || "image"}
          aria-label="下载图片"
          title="下载图片"
          className="inline-flex size-9 items-center justify-center rounded-full bg-black/60 text-white hover:bg-black/80"
        >
          <Download className="size-5" />
        </a>
        <button
          type="button"
          onClick={onClose}
          aria-label="关闭预览"
          className="inline-flex size-9 items-center justify-center rounded-full bg-black/60 text-white hover:bg-black/80"
        >
          <X className="size-5" />
        </button>
      </div>
    </div>
  )
}
