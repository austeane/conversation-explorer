export type SnippetOptions<T> = {
  diversityKey?: (item: T) => string | null | undefined;
  diversityPenalty?: number;
};

export function selectSnippets<T>(
  items: T[],
  scoreFn: (item: T) => number,
  limit: number,
  options: SnippetOptions<T> = {},
): T[] {
  if (limit <= 0 || items.length === 0) return [];
  const penalty = options.diversityPenalty ?? 0.2;
  const candidates = items
    .map((item, index) => ({ item, index, score: scoreFn(item) }))
    .filter((candidate) => Number.isFinite(candidate.score));
  const selected: T[] = [];
  const used = new Set<number>();
  const diversityCounts = new Map<string, number>();

  while (selected.length < limit && used.size < candidates.length) {
    let best: (typeof candidates)[number] | null = null;
    let bestScore = Number.NEGATIVE_INFINITY;

    for (const candidate of candidates) {
      if (used.has(candidate.index)) continue;
      const key = options.diversityKey?.(candidate.item);
      const adjusted = key ? candidate.score - (diversityCounts.get(key) ?? 0) * penalty : candidate.score;
      if (!best || adjusted > bestScore || (adjusted === bestScore && candidate.index < best.index)) {
        best = candidate;
        bestScore = adjusted;
      }
    }

    if (!best) break;
    used.add(best.index);
    selected.push(best.item);
    const key = options.diversityKey?.(best.item);
    if (key) diversityCounts.set(key, (diversityCounts.get(key) ?? 0) + 1);
  }

  return selected;
}
