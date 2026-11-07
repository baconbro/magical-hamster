/* Errors cross module boundaries as plain objects with a `kind`, so nothing
   has to import the Ollama client to recognise one. */

/** The `kind` of an error raised by the LLM or retrieval layers, if it has one. */
export function errorKind(e: unknown): string | null {
  if (typeof e !== 'object' || e === null) return null;
  const kind = (e as { kind?: unknown }).kind;
  return typeof kind === 'string' ? kind : null;
}

/** True for a cancelled request, whoever raised it (scheduler, client, embedder, DOM AbortError). */
export function isAborted(e: unknown): boolean {
  if (errorKind(e) === 'aborted') return true;
  return typeof e === 'object' && e !== null && (e as { name?: unknown }).name === 'AbortError';
}

/** An error that `isAborted` recognises. */
export function abortError(message = 'Cancelled'): Error & { kind: 'aborted' } {
  const error = new Error(message) as Error & { kind: 'aborted' };
  error.name = 'AbortError';
  error.kind = 'aborted';
  return error;
}
