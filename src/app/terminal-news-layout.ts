export type NewsPage = { start: number; end: number }

export function paginateNewsHeights(
  heights: readonly number[],
  available: number,
  gap = 8,
): NewsPage[] | null {
  if (
    !Number.isFinite(available) ||
    available < 0 ||
    !Number.isFinite(gap) ||
    gap < 0 ||
    heights.some((height) => !Number.isFinite(height) || height <= 0)
  )
    throw new RangeError('Invalid news card measurements')
  if (heights.some((height) => height > available)) return null
  const pages: NewsPage[] = []
  let start = 0
  let used = 0
  for (let index = 0; index < heights.length; index += 1) {
    const height = heights[index]!
    const next = used + (index === start ? 0 : gap) + height
    if (next > available) {
      pages.push({ start, end: index })
      start = index
      used = height
    } else used = next
  }
  if (start < heights.length) pages.push({ start, end: heights.length })
  return pages
}
