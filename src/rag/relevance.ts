/**
 * How close a passage must be to count as related. Cosine scores are not comparable from one
 * embedding model to the next: the same unrelated pair scores about 0.2 with one model and 0.6
 * with another, so one fixed floor either filters nothing or everything.
 *
 * EmbeddingGemma, measured through this plugin's prefixes on 3,500 pairs of shorthand lines and
 * transcript chunks and on 130 questions over 1,077 note passages: unrelated text scores 0.51 to
 * 0.75, related text 0.64 to 0.87. A floor of 0.35 let every pair through, so a line about
 * something nobody said was handed three excerpts all the same. No floor separates the two
 * cleanly, so a line's excerpts must also be near its best one: the runners-up of a real match
 * are mostly noise.
 */
export interface RetrievalFloors {
  /** Transcript excerpts for a shorthand line. */
  enhance: number;
  /** An excerpt further than this below the line's best excerpt is left out. */
  enhanceGap: number;
  /** Transcript excerpts for a question. */
  transcript: number;
  /** Note passages for a question. */
  vault: number;
}

/* Models nobody has measured keep the floors the plugin always had, and no gap: a wrong guess
   here would silently remove excerpts. */
export const UNMEASURED_FLOORS: RetrievalFloors = {
  enhance: 0.35,
  enhanceGap: Number.POSITIVE_INFINITY,
  transcript: 0.3,
  vault: 0.25,
};

const EMBEDDING_GEMMA: RetrievalFloors = { enhance: 0.68, enhanceGap: 0.04, transcript: 0.6, vault: 0.6 };

export function retrievalFloors(embedModel: string): RetrievalFloors {
  const name = embedModel.trim().toLowerCase();
  const base = name.slice(name.lastIndexOf('/') + 1);
  return base.startsWith('embeddinggemma') ? EMBEDDING_GEMMA : UNMEASURED_FLOORS;
}

/** The hits no further than `gap` below the best one, in their order. */
export function nearBest<T extends { score: number }>(hits: readonly T[], gap: number): T[] {
  if (hits.length === 0) return [];
  let best = Number.NEGATIVE_INFINITY;
  for (const hit of hits) if (hit.score > best) best = hit.score;
  return hits.filter((hit) => best - hit.score <= gap);
}
