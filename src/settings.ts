import { parseCompanionProperties } from './notes/companion.ts';
import { hasDotSegments, vaultFolder } from './notes/sanitize.ts';
import type {
  EnhanceStyle,
  HamsterSettings,
  LanguagePref,
  LinkPlacement,
  LocalSettings,
  SttLanguage,
  SummaryStyle,
} from './types.ts';

export const PLUGIN_ID = 'magical-hamster';
export const VIEW_TYPE = 'magical-hamster-view';
/** userEvent / origin stamped on the plugin's own editor writes. */
export const EDIT_ORIGIN = 'hamster';
/** The format of data.json this version writes. Raised when a field changes meaning or name. */
export const SETTINGS_VERSION = 1;

export const DEFAULT_SETTINGS: HamsterSettings = {
  settingsVersion: SETTINGS_VERSION,
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

/** The words a choice setting can hold. The tab offers them; `parseSettings` accepts nothing else. */
export const ENHANCE_STYLES: readonly EnhanceStyle[] = ['standard', 'concise'];
export const SUMMARY_STYLES: readonly SummaryStyle[] = ['executive', 'recap', 'actions'];
export const LANGUAGE_PREFS: readonly LanguagePref[] = ['auto', 'fr', 'en'];
export const STT_LANGUAGES: readonly SttLanguage[] = ['auto', 'fr-CA', 'fr-FR', 'en-US'];
export const LINK_PLACEMENTS: readonly LinkPlacement[] = ['section-end', 'heading'];

export interface NumberRule {
  min: number;
  max: number;
  integer?: boolean;
}

/** The number settings the tab lets the user type, and what each accepts. */
export type RangedKey =
  | 'numCtx'
  | 'embedNumCtx'
  | 'embedDimensions'
  | 'enhanceDebounceMs'
  | 'enhanceMaxWaitMs'
  | 'costPer1k';

/**
 * What the tab accepts in each number field, and what `parseSettings` clamps a
 * stored value to. The prompts assume at least 4096 tokens of context: below
 * that the summary's own instructions would be cut from the prompt.
 */
export const SETTING_RANGES: Record<RangedKey, NumberRule> = {
  numCtx: { min: 4096, max: 1048576, integer: true },
  embedNumCtx: { min: 128, max: 32768, integer: true },
  embedDimensions: { min: 32, max: 8192, integer: true },
  enhanceDebounceMs: { min: 200, max: 60000, integer: true },
  enhanceMaxWaitMs: { min: 500, max: 300000, integer: true },
  costPer1k: { min: 0, max: 1000 },
};

const ILLEGAL_IN_FILE_NAME = /[[\]#^|/\\:*?"<>\r\n]/;

/** Why a companion prefix must not be saved, or null when it may. */
export function checkPrefix(prefix: string): string | null {
  if (prefix.trim() === '') return 'Enter a prefix. Companion notes are found by it.';
  if (ILLEGAL_IN_FILE_NAME.test(prefix)) return 'A file name cannot contain [ ] # ^ | / \\ : * ? " < >';
  if (prefix.startsWith('.')) return 'A file name that starts with a dot is hidden.';
  return null;
}

export const ADDRESS_EXAMPLE = 'Enter an address such as http://localhost:11434';
export const ADDRESS_CREDENTIALS = 'Enter the address without a user name or password.';

/**
 * Why an Ollama address cannot be used, or null. A user name or password in
 * the address is refused rather than stripped: the browser's fetch cannot send
 * them, so such an address never works, and it would otherwise sit in the
 * synced data.json and in the "not reachable" notice.
 */
export function addressProblem(value: string): string | null {
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    return ADDRESS_EXAMPLE;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return ADDRESS_EXAMPLE;
  if (url.username !== '' || url.password !== '') return ADDRESS_CREDENTIALS;
  return null;
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

type Stored = Record<string, unknown>;

/**
 * Brings the fields of an older data.json to what this version expects.
 * Nothing has been renamed yet: the step is here so that the first rename has
 * a place to go, keyed on `settingsVersion`.
 */
function migrateSettings(stored: Stored): Stored {
  const version = typeof stored.settingsVersion === 'number' ? stored.settingsVersion : 0;
  switch (version) {
    default:
      return stored;
  }
}

/**
 * The settings in data.json, each checked against what the plugin can use.
 * data.json is synced between devices and edited by hand, so a value may be
 * of the wrong type, out of range, or a word the tab never offers; such a
 * value falls back to its default, and a key the plugin does not know is
 * dropped. `parseLocal` does the same for the device's own settings.
 */
export function parseSettings(raw: unknown): HamsterSettings {
  const stored = migrateSettings(
    typeof raw === 'object' && raw !== null && !Array.isArray(raw) ? (raw as Stored) : {},
  );
  const d = DEFAULT_SETTINGS;

  /** A string, passed through `accept`, which returns what to keep or null to fall back. */
  const text = <K extends keyof HamsterSettings>(
    key: K,
    accept: (value: string) => string | null = (value) => value,
  ): string => {
    const value = stored[key];
    if (typeof value !== 'string') return d[key] as string;
    return accept(value) ?? (d[key] as string);
  };
  const nonBlank = (value: string): string | null => (value.trim() === '' ? null : value.trim());
  const oneOf = <T extends string>(key: keyof HamsterSettings, words: readonly T[]): T => {
    const value = stored[key];
    return typeof value === 'string' && (words as readonly string[]).includes(value) ? (value as T) : (d[key] as T);
  };
  const flag = (key: keyof HamsterSettings): boolean => {
    const value = stored[key];
    return typeof value === 'boolean' ? value : (d[key] as boolean);
  };
  const number = (key: RangedKey): number => {
    const value = stored[key];
    if (typeof value !== 'number' || !Number.isFinite(value)) return d[key];
    const rule = SETTING_RANGES[key];
    const clamped = Math.min(rule.max, Math.max(rule.min, value));
    return rule.integer ? Math.round(clamped) : clamped;
  };
  const folders = (): string[] => {
    const value = stored.indexedFolders;
    if (!Array.isArray(value)) return [...d.indexedFolders];
    const kept: string[] = [];
    for (const item of value) {
      if (typeof item !== 'string' || item.trim() === '' || hasDotSegments(item)) continue;
      // `/` is the whole vault; any other folder loses its outer slashes.
      const folder = vaultFolder(item) || '/';
      if (!kept.includes(folder)) kept.push(folder);
    }
    return kept;
  };

  return {
    settingsVersion: SETTINGS_VERSION,
    ollamaUrl: text('ollamaUrl', (value) => (addressProblem(value) === null ? value.trim() : null)),
    llmModel: text('llmModel', nonBlank),
    liveModel: text('liveModel', (value) => value.trim()),
    embedModel: text('embedModel', nonBlank),
    numCtx: number('numCtx'),
    embedNumCtx: number('embedNumCtx'),
    embedDimensions: number('embedDimensions'),

    enhanceStyle: oneOf('enhanceStyle', ENHANCE_STYLES),
    liveEnhanceDefault: flag('liveEnhanceDefault'),
    enhanceDebounceMs: number('enhanceDebounceMs'),
    enhanceMaxWaitMs: number('enhanceMaxWaitMs'),

    summaryStyle: oneOf('summaryStyle', SUMMARY_STYLES),
    summaryLanguage: oneOf('summaryLanguage', LANGUAGE_PREFS),

    sttLanguage: oneOf('sttLanguage', STT_LANGUAGES),
    micLabel: text('micLabel', nonBlank),

    companionFolder: text('companionFolder', vaultFolder),
    companionPrefix: text('companionPrefix', (value) => (checkPrefix(value) === null ? value : null)),
    dailyLinkPlacement: oneOf('dailyLinkPlacement', LINK_PLACEMENTS),
    dailyLinkAlias: text('dailyLinkAlias'),
    actionItemsAsTasks: flag('actionItemsAsTasks'),
    linkEntitiesInCompanion: flag('linkEntitiesInCompanion'),
    entitiesPath: text('entitiesPath', vaultFolder),
    // Checked for shape and speed where it is used (main.ts); any text is stored.
    softMarkerPattern: text('softMarkerPattern'),
    companionProperties: text('companionProperties', (value) =>
      'error' in parseCompanionProperties(value) ? null : value,
    ),

    indexedFolders: folders(),
    costPer1k: number('costPer1k'),
  };
}
