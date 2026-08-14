export type EditorAssetKind = "video" | "image" | "audio"
export type EditorTrackKind = "video" | "audio" | "text"

export type EditorTransform = {
  x: number
  y: number
  scale: number
  rotation: number
}

export type EditorClip = {
  id: string
  name: string
  asset_path?: string
  asset_kind?: EditorAssetKind
  start: number
  duration: number
  source_in: number
  speed: number
  opacity: number
  volume: number
  fade_in: number
  fade_out: number
  transform: EditorTransform
  text?: string
  font_size: number
  color: string
}

export type EditorTrack = {
  id: string
  name: string
  kind: EditorTrackKind
  hidden: boolean
  muted: boolean
  locked: boolean
  clips: EditorClip[]
}

export type EditorTimeline = {
  version: 1
  width: number
  height: number
  fps: number
  background: string
  tracks: EditorTrack[]
}

export type EditorProject = {
  id: number
  name: string
  timeline: EditorTimeline
  created_at: string
  updated_at: string
}

export type EditorAsset = {
  id: string
  library_id?: number
  title: string
  kind: EditorAssetKind
  path: string
  thumbnail_path?: string
  duration?: number
  width?: number
  height?: number
  source: "upload" | "imported" | "generated" | "workflow" | "public"
  is_public: boolean
  author?: string
  created_at: string
}

export type EditorExport = {
  token: string
  project_id: number | null
  status: "pending" | "running" | "completed" | "failed"
  progress: number
  video_path: string | null
  error: string | null
  created_at: string
  started_at: string | null
  finished_at: string | null
}

export function editorId(prefix: string): string {
  const random =
    typeof crypto.randomUUID === "function"
      ? crypto.randomUUID().replaceAll("-", "")
      : `${Date.now()}${Math.random().toString(16).slice(2)}`
  return `${prefix}_${random}`
}

export function emptyTimeline(): EditorTimeline {
  return {
    version: 1,
    width: 1920,
    height: 1080,
    fps: 30,
    background: "#000000",
    tracks: [
      {
        id: editorId("track"),
        name: "V1",
        kind: "video",
        hidden: false,
        muted: false,
        locked: false,
        clips: [],
      },
      {
        id: editorId("track"),
        name: "A1",
        kind: "audio",
        hidden: false,
        muted: false,
        locked: false,
        clips: [],
      },
      {
        id: editorId("track"),
        name: "T1",
        kind: "text",
        hidden: false,
        muted: false,
        locked: false,
        clips: [],
      },
    ],
  }
}

export function timelineDuration(timeline: EditorTimeline): number {
  return Math.max(
    0,
    ...timeline.tracks.flatMap((track) =>
      track.clips.map((clip) => clip.start + clip.duration)
    )
  )
}

async function jsonOrThrow<T>(response: Response): Promise<T> {
  if (!response.ok) {
    const body = await response.text().catch(() => response.statusText)
    let message = body
    try {
      const parsed = JSON.parse(body) as { error?: string }
      message = parsed.error || body
    } catch {
      // Some existing endpoints return plain text errors.
    }
    throw new Error(message || `HTTP ${response.status}`)
  }
  return response.json() as Promise<T>
}

export const videoEditorApi = {
  async projects(): Promise<EditorProject[]> {
    return jsonOrThrow(
      await fetch("/api/video-editor/projects", { credentials: "same-origin" })
    )
  },

  async project(id: number): Promise<EditorProject> {
    return jsonOrThrow(
      await fetch(`/api/video-editor/projects/${id}`, {
        credentials: "same-origin",
      })
    )
  },

  async save(
    id: number | null,
    name: string,
    timeline: EditorTimeline
  ): Promise<{ id: number }> {
    return jsonOrThrow(
      await fetch("/api/video-editor/projects", {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id, name, timeline }),
      })
    )
  },

  async removeProject(id: number): Promise<void> {
    const response = await fetch(`/api/video-editor/projects/${id}`, {
      method: "DELETE",
      credentials: "same-origin",
    })
    if (!response.ok) throw new Error(await response.text())
  },

  async assets(scope: "mine" | "public"): Promise<EditorAsset[]> {
    return jsonOrThrow(
      await fetch(`/api/video-editor/assets?scope=${scope}`, {
        credentials: "same-origin",
      })
    )
  },

  async uploadAsset(
    file: File,
    metadata: { duration?: number; width?: number; height?: number }
  ): Promise<{ id: number; path: string }> {
    const b64 = await fileToBase64(file)
    return jsonOrThrow(
      await fetch("/api/video-editor/assets/upload", {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          filename: file.name,
          mime: file.type || "application/octet-stream",
          b64,
          ...metadata,
        }),
      })
    )
  },

  async importAsset(asset: EditorAsset): Promise<{ id: number }> {
    return jsonOrThrow(
      await fetch("/api/video-editor/assets/import", {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title: asset.title,
          kind: asset.kind,
          path: asset.path,
          duration: asset.duration,
          width: asset.width,
          height: asset.height,
          thumbnail_path: asset.thumbnail_path,
        }),
      })
    )
  },

  async setVisibility(id: number, isPublic: boolean): Promise<void> {
    const response = await fetch(`/api/video-editor/assets/${id}/visibility`, {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ is_public: isPublic }),
    })
    if (!response.ok) throw new Error(await response.text())
  },

  async removeAsset(id: number): Promise<void> {
    const response = await fetch(`/api/video-editor/assets/${id}`, {
      method: "DELETE",
      credentials: "same-origin",
    })
    if (!response.ok) throw new Error(await response.text())
  },

  async startExport(projectId: number): Promise<{ token: string }> {
    return jsonOrThrow(
      await fetch(`/api/video-editor/projects/${projectId}/exports`, {
        method: "POST",
        credentials: "same-origin",
      })
    )
  },

  async export(token: string): Promise<EditorExport> {
    return jsonOrThrow(
      await fetch(`/api/video-editor/exports/${encodeURIComponent(token)}`, {
        credentials: "same-origin",
      })
    )
  },

  async exports(): Promise<EditorExport[]> {
    return jsonOrThrow(
      await fetch("/api/video-editor/exports", { credentials: "same-origin" })
    )
  },

  async removeExport(token: string): Promise<void> {
    const response = await fetch(
      `/api/video-editor/exports/${encodeURIComponent(token)}`,
      {
        method: "DELETE",
        credentials: "same-origin",
      }
    )
    if (!response.ok) {
      const body = await response.text().catch(() => response.statusText)
      let message = body
      try {
        const parsed = JSON.parse(body) as { error?: string }
        message = parsed.error || body
      } catch {
        // Some existing endpoints return plain text errors.
      }
      throw new Error(message || `HTTP ${response.status}`)
    }
  },
}

function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => {
      const value = String(reader.result ?? "")
      resolve(value.slice(value.indexOf(",") + 1))
    }
    reader.onerror = () => reject(reader.error ?? new Error("读取素材失败"))
    reader.readAsDataURL(file)
  })
}

export function inspectMediaFile(
  file: File
): Promise<{ duration?: number; width?: number; height?: number }> {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(file)
    if (file.type.startsWith("image/")) {
      const image = new Image()
      image.onload = () => {
        resolve({ width: image.naturalWidth, height: image.naturalHeight })
        URL.revokeObjectURL(url)
      }
      image.onerror = () => {
        resolve({})
        URL.revokeObjectURL(url)
      }
      image.src = url
      return
    }
    const media = document.createElement(
      file.type.startsWith("video/") ? "video" : "audio"
    )
    media.preload = "metadata"
    media.onloadedmetadata = () => {
      resolve({
        duration: Number.isFinite(media.duration) ? media.duration : undefined,
        width: media instanceof HTMLVideoElement ? media.videoWidth : undefined,
        height: media instanceof HTMLVideoElement ? media.videoHeight : undefined,
      })
      URL.revokeObjectURL(url)
    }
    media.onerror = () => {
      resolve({})
      URL.revokeObjectURL(url)
    }
    media.src = url
  })
}
