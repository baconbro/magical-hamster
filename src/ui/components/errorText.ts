/* Pure: the text of whatever a render threw, for the error boundary's message. Kept apart from
   the boundary, which is a component and so cannot be loaded by the node tests. */

/** The thrown value written out, or nothing when that cannot be done (an object with no prototype). */
function plain(error: unknown): string {
  try {
    return String(error);
  } catch {
    return '';
  }
}

/**
 * What to show for a thrown value: an Error's message, a string as it is, the `message` field of
 * any other object (the LLM and retrieval layers raise plain objects), or the value written out.
 * Never blank: a message with nothing in it reads as "Unknown error".
 */
export function errorMessageOf(error: unknown): string {
  let text: string;
  if (error instanceof Error) text = error.message;
  else if (typeof error === 'string') text = error;
  else if (typeof error === 'object' && error !== null && 'message' in error && typeof error.message === 'string') {
    text = error.message;
  } else text = error === null || error === undefined ? '' : plain(error);
  const trimmed = text.trim();
  return trimmed === '' ? 'Unknown error' : trimmed;
}
