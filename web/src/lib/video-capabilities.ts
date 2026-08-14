export type VideoSizeOption = {
  value: string
  label: string
}

export const GROK_VIDEO_SECONDS = Array.from({ length: 15 }, (_, index) => index + 1)

const GROK_BASE_SIZES: VideoSizeOption[] = [
  { value: "1280x720", label: "720p · 横屏 16:9（1280×720）" },
  { value: "720x1280", label: "720p · 竖屏 9:16（720×1280）" },
  { value: "854x480", label: "480p · 横屏 16:9（854×480）" },
  { value: "480x854", label: "480p · 竖屏 9:16（480×854）" },
]

const GROK_15_SIZES: VideoSizeOption[] = [
  ...GROK_BASE_SIZES,
  { value: "1920x1080", label: "1080p · 横屏 16:9（1920×1080）" },
  { value: "1080x1920", label: "1080p · 竖屏 9:16（1080×1920）" },
]

const VEO_SIZES: VideoSizeOption[] = [
  { value: "1280x720", label: "720p · 横屏 16:9（1280×720）" },
  { value: "720x1280", label: "720p · 竖屏 9:16（720×1280）" },
  { value: "1920x1080", label: "1080p · 横屏 16:9（1920×1080）" },
  { value: "1080x1920", label: "1080p · 竖屏 9:16（1080×1920）" },
  { value: "3840x2160", label: "4K · 横屏 16:9（3840×2160）" },
  { value: "2160x3840", label: "4K · 竖屏 9:16（2160×3840）" },
]

const DEFAULT_VIDEO_SIZES: VideoSizeOption[] = [
  { value: "1280x720", label: "720p · 横屏（1280×720）" },
  { value: "720x1280", label: "720p · 竖屏（720×1280）" },
  { value: "1024x1024", label: "方形（1024×1024）" },
  { value: "1920x1080", label: "1080p · 横屏（1920×1080）" },
  { value: "1080x1920", label: "1080p · 竖屏（1080×1920）" },
]

export function isGrokVideoModel(model: string): boolean {
  const normalized = model.trim().toLowerCase()
  return (
    normalized === "grok-imagine-video" ||
    normalized.startsWith("grok-imagine-video-")
  )
}

function isGrok15VideoModel(model: string): boolean {
  return model.trim().toLowerCase().startsWith("grok-imagine-video-1.5")
}

function baseVideoSizeOptions(model: string): VideoSizeOption[] {
  const normalized = model.trim().toLowerCase()
  if (isGrok15VideoModel(normalized)) return GROK_15_SIZES
  if (isGrokVideoModel(normalized)) return GROK_BASE_SIZES
  if (normalized.includes("veo")) return VEO_SIZES
  return DEFAULT_VIDEO_SIZES
}

/**
 * Return model-aware presets while preserving any legacy value already stored
 * in pricing, so opening and saving an older rule never drops its resolution.
 */
export function videoSizeOptions(
  model: string,
  currentSizes: string[] = []
): VideoSizeOption[] {
  const options = [...baseVideoSizeOptions(model)]
  for (const size of currentSizes) {
    const value = size.trim()
    if (value && !options.some((option) => option.value === value)) {
      options.push({ value, label: `${displayVideoSize(value)}（已有配置）` })
    }
  }
  return options
}

export function defaultVideoSize(model: string): string {
  return baseVideoSizeOptions(model)[0]?.value ?? "1280x720"
}

export function displayVideoSize(size: string): string {
  return size.replace("x", "×")
}

export function videoSizeLabel(model: string, size: string): string {
  return (
    videoSizeOptions(model, [size]).find((option) => option.value === size)?.label ??
    displayVideoSize(size)
  )
}

export function effectiveAllowedSeconds(
  model: string,
  configured: number[]
): number[] {
  if (isGrokVideoModel(model)) return [...GROK_VIDEO_SECONDS]
  return [...configured]
}

export function consecutiveSecondsRange(
  values: number[]
): { min: number; max: number } | null {
  const sorted = [...new Set(values)].sort((a, b) => a - b)
  if (sorted.length < 2) return null
  for (let index = 1; index < sorted.length; index += 1) {
    if (sorted[index] !== sorted[index - 1]! + 1) return null
  }
  return { min: sorted[0]!, max: sorted[sorted.length - 1]! }
}
