/** Returns the stored image filename for a local NovaChat image path. */
export function filenameFromPath(path: string): string | null {
  const match = path.match(/^\/api\/images\/([A-Za-z0-9._-]+)$/)
  return match ? match[1]! : null
}
