// 模型上下文上限与 token 估算。真实 usage 拿不到时用估算兜底。

/** 按模型名关键词匹配上下文窗口上限（从上到下首个命中）。 */
const LIMIT_PATTERNS: Array<[RegExp, number]> = [
  [/gemini/i, 1_000_000],
  [/gpt-5/i, 400_000],
  [/claude/i, 200_000],
  [/gpt-4o|(^|[^a-z])o[34]([^a-z]|$)/i, 128_000],
  [/deepseek/i, 128_000],
]

export const DEFAULT_CONTEXT_LIMIT = 128_000

export function contextLimit(model: string): number {
  for (const [re, limit] of LIMIT_PATTERNS) {
    if (re.test(model)) return limit
  }
  return DEFAULT_CONTEXT_LIMIT
}

/** 粗略估算：CJK 字符按 1 token/字，其余按 4 字符/token。误差 ±20% 可接受。 */
export function estimateTokens(text: string): number {
  if (!text) return 0
  // eslint-disable-next-line no-irregular-whitespace
  const cjk = text.match(/[　-鿿豈-﫿＀-￯]/g)?.length ?? 0
  const rest = text.length - cjk
  return cjk + Math.ceil(rest / 4)
}

export function estimateMessagesTokens(texts: string[]): number {
  return texts.reduce((sum, t) => sum + estimateTokens(t), 0)
}
