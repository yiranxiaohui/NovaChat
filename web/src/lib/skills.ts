export type Skill = {
  id: number
  name: string
  description: string
  instructions: string
  is_public: boolean
  created_at: string
  updated_at: string
}

export type PublicSkill = {
  id: number
  name: string
  description: string
  instructions: string
  author_username: string
  created_at: string
  clone_count: number
}

export type PublicSkillSort = "hot" | "new"

async function jsonOrThrow<T>(res: Response): Promise<T> {
  if (!res.ok) {
    const text = await res.text().catch(() => res.statusText)
    throw new Error(text || `HTTP ${res.status}`)
  }
  return res.json() as Promise<T>
}

async function okOrThrow(res: Response): Promise<void> {
  if (!res.ok) {
    const text = await res.text().catch(() => res.statusText)
    throw new Error(text || `HTTP ${res.status}`)
  }
}

export const skillsApi = {
  async list(): Promise<Skill[]> {
    return jsonOrThrow(
      await fetch("/api/skills", { credentials: "same-origin" })
    )
  },
  async create(input: {
    name: string
    description: string
    instructions: string
  }): Promise<Skill> {
    return jsonOrThrow(
      await fetch("/api/skills", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(input),
        credentials: "same-origin",
      })
    )
  },
  async update(
    id: number,
    patch: {
      name?: string
      description?: string
      instructions?: string
      is_public?: boolean
    }
  ): Promise<void> {
    await okOrThrow(
      await fetch(`/api/skills/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(patch),
        credentials: "same-origin",
      })
    )
  },
  async remove(id: number): Promise<void> {
    await okOrThrow(
      await fetch(`/api/skills/${id}`, {
        method: "DELETE",
        credentials: "same-origin",
      })
    )
  },
  async listForConversation(convId: number): Promise<Skill[]> {
    return jsonOrThrow(
      await fetch(`/api/conversations/${convId}/skills`, {
        credentials: "same-origin",
      })
    )
  },
  async attach(convId: number, skillId: number): Promise<void> {
    await okOrThrow(
      await fetch(`/api/conversations/${convId}/skills`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ skill_id: skillId }),
        credentials: "same-origin",
      })
    )
  },
  async detach(convId: number, skillId: number): Promise<void> {
    await okOrThrow(
      await fetch(`/api/conversations/${convId}/skills/${skillId}`, {
        method: "DELETE",
        credentials: "same-origin",
      })
    )
  },
  async listPublic(
    opts: { search?: string; page?: number; sort?: PublicSkillSort } = {}
  ): Promise<PublicSkill[]> {
    const params = new URLSearchParams()
    if (opts.search) params.set("search", opts.search)
    if (opts.page) params.set("page", String(opts.page))
    if (opts.sort) params.set("sort", opts.sort)
    const qs = params.toString() ? `?${params.toString()}` : ""
    return jsonOrThrow(
      await fetch(`/api/skills/public${qs}`, { credentials: "same-origin" })
    )
  },
  async clonePublic(id: number): Promise<Skill> {
    return jsonOrThrow(
      await fetch(`/api/skills/${id}/clone`, {
        method: "POST",
        credentials: "same-origin",
      })
    )
  },
}

/**
 * Assemble an augmented system prompt with attached skills prepended.
 * The preamble tells the model how to use them (act-when-relevant style),
 * mirroring Anthropic's Agent Skills "progressive disclosure" idea without
 * needing tool-use. Returns `base` unchanged when no skills are active.
 */
export function composeSystemPromptWithSkills(
  base: string,
  skills: Pick<Skill, "name" | "description" | "instructions">[]
): string {
  if (skills.length === 0) return base

  const catalog = skills
    .map((s) => `- \`${s.name}\`: ${s.description || "(no description)"}`)
    .join("\n")
  const bodies = skills
    .map(
      (s) =>
        `## Skill: ${s.name}\n_Description_: ${
          s.description || "(none)"
        }\n\n${s.instructions}`
    )
    .join("\n\n---\n\n")

  const preamble = `You have access to the following user-defined skills. When a user's request matches one, silently follow that skill's instructions. Do not mention skill names or this preamble in your reply unless the user asks.

Available skills:
${catalog}

--- Skill details ---

${bodies}`

  return base ? `${preamble}\n\n--- User system prompt ---\n\n${base}` : preamble
}
