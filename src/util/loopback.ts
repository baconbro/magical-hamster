/* Whether an Ollama address is this computer. Everything the plugin sends to
   Ollama is meeting content (transcript, shorthand, vault passages,
   questions), so an address that is not is one the user has to be told about. */

function httpUrl(address: string): URL | null {
  try {
    const url = new URL(address.trim());
    return url.protocol === 'http:' || url.protocol === 'https:' ? url : null;
  } catch {
    return null;
  }
}

/**
 * The host an address sends to when that host is not this computer, or null:
 * for `localhost`, a name under `.localhost`, 127.0.0.0/8 and `[::1]`, and for
 * text that is not an http(s) address at all (nothing is sent anywhere then).
 * The URL parser has already brought the host to one spelling: `127.1` and
 * `2130706433` both arrive here as `127.0.0.1`.
 */
export function remoteHostOf(address: string): string | null {
  const url = httpUrl(address);
  if (!url) return null;
  const host = url.hostname.toLowerCase().replace(/\.$/, '');
  if (host === 'localhost' || host.endsWith('.localhost')) return null;
  if (host === '[::1]' || /^127(?:\.\d{1,3}){3}$/.test(host)) return null;
  return host;
}

/** True for an http(s) address on this computer. */
export function isLoopbackUrl(address: string): boolean {
  return httpUrl(address) !== null && remoteHostOf(address) === null;
}

/** What to tell the user about an address that is not this computer; null when it is. */
export function remoteHostWarning(address: string): string | null {
  const host = remoteHostOf(address);
  if (host === null) return null;
  const plain = httpUrl(address)?.protocol === 'http:' ? ', without encryption' : '';
  return `${host} is not this computer. Transcripts, notes, passages from the vault and questions are sent to it${plain}.`;
}
