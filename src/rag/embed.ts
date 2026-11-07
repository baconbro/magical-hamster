import type { Embedder, OllamaClient } from '../types.ts';
import { collapseWhitespace, estimateTokens } from '../util/text.ts';

/* Ollama applies no prompt template to embedding models, so the task prefixes
   EmbeddingGemma was trained with are added here. */

// Headroom under the model's 8,192-token window for the prefix and the title.
const MAX_TEXT_TOKENS = 7500;

function clip(text: string): string {
  let cut = text;
  let tokens = estimateTokens(cut);
  if (tokens <= MAX_TEXT_TOKENS) return cut;
  while (tokens > MAX_TEXT_TOKENS) {
    cut = cut.slice(0, Math.floor((cut.length * MAX_TEXT_TOKENS) / tokens));
    tokens = estimateTokens(cut);
  }
  const space = cut.lastIndexOf(' ');
  if (space > cut.length - 64) return cut.slice(0, space);
  // No word boundary nearby: at least do not leave half of a surrogate pair.
  const last = cut.charCodeAt(cut.length - 1);
  return last >= 0xd800 && last <= 0xdbff ? cut.slice(0, -1) : cut;
}

function prepare(text: string): string {
  return clip(collapseWhitespace(text));
}

export function queryPrompt(text: string): string {
  return `task: search result | query: ${prepare(text)}`;
}

export function documentPrompt(text: string, title?: string): string {
  return `title: ${collapseWhitespace(title ?? '') || 'none'} | text: ${prepare(text)}`;
}

/** L2-normalizes in place and returns the same array. A zero vector stays zero. */
export function normalize(v: Float32Array): Float32Array {
  let sum = 0;
  for (let i = 0; i < v.length; i++) sum += v[i] * v[i];
  const norm = Math.sqrt(sum);
  // Also leaves a vector with non-finite values alone rather than spreading NaN.
  if (!(norm > 0) || !Number.isFinite(norm)) return v;
  for (let i = 0; i < v.length; i++) v[i] /= norm;
  return v;
}

export interface EmbedderOptions {
  llm: OllamaClient;
  model(): string;
  numCtx(): number;
  dim(): number;
  /** Documents per request. Default 16. */
  batchSize?: number;
  /** Default '30m'. */
  keepAlive?: number | string;
  /** Prompt tokens spent, for the stats. */
  onTokens?(tokens: number): void;
}

// Same shape as the Ollama client's own abort, which callers detect by `kind`.
function abortError(): Error {
  return Object.assign(new Error('Embedding aborted'), { name: 'AbortError', kind: 'aborted' as const });
}

export function createEmbedder(opts: EmbedderOptions): Embedder {
  const requested = Math.floor(opts.batchSize ?? 16);
  const batchSize = requested >= 1 ? requested : 16;
  const keepAlive = opts.keepAlive ?? '30m';

  async function request(input: string[], signal?: AbortSignal): Promise<Float32Array[]> {
    const dim = opts.dim();
    const result = await opts.llm.embed(
      { model: opts.model(), input, numCtx: opts.numCtx(), dimensions: dim, keepAlive },
      signal,
    );
    if (result.vectors.length !== input.length) {
      throw new Error(`Embedding count mismatch: expected ${input.length}, got ${result.vectors.length}`);
    }
    for (const vector of result.vectors) {
      if (vector.length !== dim) {
        // The server ignores the dimension asked for: every request would fail the same way.
        throw Object.assign(new Error(`Embedding dimension mismatch: expected ${dim}, got ${vector.length}`), {
          kind: 'dimension' as const,
        });
      }
    }
    if (result.promptTokens > 0) opts.onTokens?.(result.promptTokens);
    return result.vectors.map(normalize);
  }

  return {
    get dim(): number {
      return opts.dim();
    },

    async embedQuery(text: string, signal?: AbortSignal): Promise<Float32Array> {
      const [vector] = await request([queryPrompt(text)], signal);
      return vector;
    },

    async embedDocuments(
      docs: Array<{ title?: string; text: string }>,
      signal?: AbortSignal,
    ): Promise<Float32Array[]> {
      const out: Float32Array[] = [];
      for (let start = 0; start < docs.length; start += batchSize) {
        if (signal?.aborted) throw abortError();
        const batch = docs.slice(start, start + batchSize);
        out.push(...(await request(batch.map((d) => documentPrompt(d.text, d.title)), signal)));
      }
      return out;
    },
  };
}
