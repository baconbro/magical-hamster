import { errorKind, isAborted } from '../util/errors.ts';

const FALLBACK = 'Something went wrong.';

function messageOf(e: unknown): string {
  return e instanceof Error && e.message.trim() !== '' ? e.message : '';
}

/** A short sentence fit to show the user, for any thrown value. */
export function describeError(e: unknown): string {
  // Read by `kind`, not by class: the scheduler, the client and the embedder each raise their own objects.
  if (isAborted(e)) return 'Cancelled.';
  switch (errorKind(e)) {
    case 'unreachable':
      return 'Ollama is not running.';
    case 'model_missing': {
      const model = (e as { model?: unknown }).model;
      if (typeof model === 'string' && model.trim() !== '') {
        return `Model ${model} is not installed. Run: ollama pull ${model}`;
      }
      return messageOf(e) || 'The model is not installed.';
    }
    case 'busy':
      return 'Ollama is busy. Try again in a moment.';
    case 'stalled':
      return 'The model stopped responding.';
    default:
      return messageOf(e) || FALLBACK;
  }
}
