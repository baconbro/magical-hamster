import type { HamsterSettings, LocalSettings } from './types.ts';

export const PLUGIN_ID = 'magical-hamster';
export const VIEW_TYPE = 'magical-hamster-view';
/** userEvent / origin stamped on the plugin's own editor writes. */
export const EDIT_ORIGIN = 'hamster';

export const DEFAULT_SETTINGS: HamsterSettings = {
  ollamaUrl: 'http://localhost:11434',
  llmModel: 'gemma4:12b',
  liveModel: '',
  embedModel: 'embeddinggemma-2:270m',
  numCtx: 16384,
  embedNumCtx: 2048,
  embedDimensions: 768,

  enhanceStyle: 'standard',
  liveEnhanceDefault: false,
  enhanceDebounceMs: 2500,
  enhanceMaxWaitMs: 8000,

  summaryStyle: 'executive',
  summaryLanguage: 'auto',

  sttLanguage: 'auto',
  micLabel: 'Me',

  companionFolder: 'Meetings',
  companionPrefix: 'Mtg-',
  dailyLinkPlacement: 'section-end',
  dailyLinkAlias: 'Meeting notes',
  actionItemsAsTasks: false,
  linkEntitiesInCompanion: false,
  entitiesPath: '',
  softMarkerPattern: '^(1:1|Meeting|Sync|Standup|Prep|Réunion|Rencontre)\\b',
  companionProperties: '',

  indexedFolders: [],
  costPer1k: 0.002,
};

export const DEFAULT_LOCAL: LocalSettings = {
  /* Empty: use the Node recorded by `pnpm setup:stt` in runtime.json, the one its self-test passed with. */
  nodePath: '',
  runtimeDir: '',
  micDeviceId: '',
  firstWriteConfirmed: false,
  debugTab: false,
};

/** The model Live Enhance runs on. */
export function liveModelOf(s: HamsterSettings): string {
  return s.liveModel.trim() || s.llmModel;
}

const MAX_COUNT = 8;
const MAX_COUNT_TOTAL = 16;

/**
 * Why a soft-marker pattern uses a construct the plugin does not accept, or
 * null. The pattern runs on every line of the daily note at every keystroke,
 * and the settings tab times it on growing probes to catch one that backtracks
 * without end. That timing cannot see a blow-up hidden behind a gate: with a
 * lookahead or a long counted repetition in front, nothing is slow until the
 * line is long enough to pass the gate, and then one match never returns, in
 * the check itself as well. So the constructs that make such a gate are
 * refused by their shape, before anything is run.
 */
export function softMarkerUnsupported(source: string): string | null {
  if (typeof source !== 'string') return 'The pattern is not text.';
  let minimums = 0;
  for (let i = 0; i < source.length; i++) {
    const ch = source[i];
    if (ch === '\\') {
      const next = source[i + 1] ?? '';
      if (/[1-9]/.test(next) || (next === 'k' && source[i + 2] === '<')) {
        return 'Back-references are not supported in this pattern.';
      }
      i += 1;
      continue;
    }
    if (ch === '[') {
      // A character class: nothing in it is a group or a repetition.
      i += 1;
      if (source[i] === '^') i += 1;
      if (source[i] === ']') i += 1;
      while (i < source.length && source[i] !== ']') i += source[i] === '\\' ? 2 : 1;
      continue;
    }
    if (ch === '(' && source[i + 1] === '?') {
      const mark = source.slice(i + 2, i + 4);
      if (mark[0] === '=' || mark[0] === '!' || mark === '<=' || mark === '<!') {
        return 'Lookahead and lookbehind are not supported in this pattern.';
      }
    }
    if (ch === '{') {
      const counted = /^\{(\d+)(?:,\d*)?\}/.exec(source.slice(i));
      if (counted) {
        const minimum = Number(counted[1]);
        minimums += minimum;
        if (minimum > MAX_COUNT || minimums > MAX_COUNT_TOTAL) {
          return `A repetition of more than ${MAX_COUNT} at a time is not supported in this pattern.`;
        }
        i += counted[0].length - 1;
      }
    }
  }
  return null;
}

/** The heading-less meeting matcher, or a pattern that never matches when the setting is invalid or not accepted. */
export function softMarkerRegex(s: HamsterSettings): RegExp {
  if (softMarkerUnsupported(s.softMarkerPattern) !== null) return /$^/;
  try {
    return new RegExp(s.softMarkerPattern, 'i');
  } catch {
    return /$^/;
  }
}

/** Fills in anything missing from stored settings (older versions, hand edits). */
export function withDefaults(stored: Partial<HamsterSettings> | null | undefined): HamsterSettings {
  return { ...DEFAULT_SETTINGS, ...(stored ?? {}) };
}
