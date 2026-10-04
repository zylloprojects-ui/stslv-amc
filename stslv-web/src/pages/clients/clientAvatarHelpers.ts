/** Up to two letters: the first letters of the first two words, or the first two letters of a single word ("ABA" gives "AB"). */
export function initialsOf(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean)

  if (words.length === 0) {
    return '?'
  }
  if (words.length === 1) {
    return (words[0] ?? '').slice(0, 2).toUpperCase()
  }

  return `${words[0]?.[0] ?? ''}${words[1]?.[0] ?? ''}`.toUpperCase()
}

// The details dialog uses one navy-to-blue pair for its larger tile.
const AVATAR_COLORS: [string, string] = ['#1479BD', '#4aa3df']

export function avatarColors(): [string, string] {
  return AVATAR_COLORS
}
