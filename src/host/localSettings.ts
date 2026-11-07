import type { App } from 'obsidian';
import { DEFAULT_LOCAL } from '../settings.ts';
import type { LocalSettings } from '../types.ts';

/* Obsidian's vault-scoped localStorage: per device, never synced. Paths to a
   Node binary and to a microphone mean nothing on another machine, so they
   stay out of the plugin's data.json. Paths are kept as typed: an empty
   `nodePath` means the Node the speech setup recorded, and a `runtimeDir` is
   resolved by `resolveRuntimeDir` when it is used. */
export const LOCAL_KEY = 'magical-hamster:local';

/** Stored values over the defaults; anything missing or of the wrong type falls back to its default. */
export function parseLocal(raw: unknown): LocalSettings {
  let value: unknown = raw;
  if (typeof value === 'string') {
    try {
      value = JSON.parse(value) as unknown;
    } catch {
      value = null;
    }
  }
  const stored =
    typeof value === 'object' && value !== null && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {};
  const text = (key: 'nodePath' | 'runtimeDir' | 'micDeviceId'): string => {
    const found = stored[key];
    return typeof found === 'string' ? found : DEFAULT_LOCAL[key];
  };
  return {
    nodePath: text('nodePath'),
    runtimeDir: text('runtimeDir'),
    micDeviceId: text('micDeviceId'),
    firstWriteConfirmed:
      typeof stored.firstWriteConfirmed === 'boolean'
        ? stored.firstWriteConfirmed
        : DEFAULT_LOCAL.firstWriteConfirmed,
    debugTab: typeof stored.debugTab === 'boolean' ? stored.debugTab : DEFAULT_LOCAL.debugTab,
  };
}

export function loadLocal(app: App): LocalSettings {
  return parseLocal(app.loadLocalStorage(LOCAL_KEY));
}

export function saveLocal(app: App, value: LocalSettings): void {
  app.saveLocalStorage(LOCAL_KEY, { ...value });
}
