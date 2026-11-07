import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import {
  ADDRESS_CREDENTIALS,
  ADDRESS_EXAMPLE,
  DEFAULT_SETTINGS,
  SETTINGS_VERSION,
  SETTING_RANGES,
  addressProblem,
  parseSettings,
} from '../src/settings.ts';
import type { HamsterSettings } from '../src/types.ts';

/* data.json is synced between devices and edited by hand: every field it
   holds is checked against what the plugin can use before it is trusted. */

const stored = (patch: Record<string, unknown>): HamsterSettings => parseSettings({ ...DEFAULT_SETTINGS, ...patch });

describe('parseSettings: what is not an object', () => {
  test('null, a list, a string and a number give the defaults', () => {
    for (const raw of [null, undefined, [], 'settings', 42, true]) {
      assert.deepEqual(parseSettings(raw), DEFAULT_SETTINGS, String(raw));
    }
  });

  test('a valid object comes back as it is, with the current format version', () => {
    const valid: HamsterSettings = {
      ...DEFAULT_SETTINGS,
      ollamaUrl: 'http://192.168.1.50:11434',
      llmModel: 'gemma4:27b',
      liveModel: 'gemma4:4b',
      numCtx: 32768,
      enhanceStyle: 'concise',
      summaryStyle: 'actions',
      summaryLanguage: 'fr',
      sttLanguage: 'fr-CA',
      micLabel: 'Fred',
      companionFolder: '10 Work/Meetings',
      companionPrefix: 'Mtg ',
      dailyLinkPlacement: 'heading',
      entitiesPath: '40 Resources/Entities.md',
      companionProperties: 'area: work\nstatus: open',
      indexedFolders: ['10 Work', '/'],
      costPer1k: 0.01,
    };
    assert.deepEqual(parseSettings(valid), valid);
    assert.deepEqual(parseSettings({ ...valid, settingsVersion: 0 }), valid);
    assert.equal(parseSettings(valid).settingsVersion, SETTINGS_VERSION);
  });

  test('a key the plugin does not know is dropped', () => {
    const parsed = parseSettings({ ...DEFAULT_SETTINGS, apiKey: 'sk-…', theme: 'dark' }) as unknown as Record<
      string,
      unknown
    >;
    assert.equal('apiKey' in parsed, false);
    assert.equal('theme' in parsed, false);
    assert.deepEqual(Object.keys(parsed).sort(), Object.keys(DEFAULT_SETTINGS).sort());
  });
});

describe('parseSettings: one wrong field falls back to its default and the others stay', () => {
  test('text fields of the wrong type, or blank where a name is needed', () => {
    const parsed = stored({ micLabel: null, llmModel: '  ', embedModel: 7, liveModel: ' x ', dailyLinkAlias: 3 });
    assert.equal(parsed.micLabel, DEFAULT_SETTINGS.micLabel);
    assert.equal(parsed.llmModel, DEFAULT_SETTINGS.llmModel);
    assert.equal(parsed.embedModel, DEFAULT_SETTINGS.embedModel);
    assert.equal(parsed.liveModel, 'x');
    assert.equal(parsed.dailyLinkAlias, DEFAULT_SETTINGS.dailyLinkAlias);
    assert.equal(parsed.numCtx, DEFAULT_SETTINGS.numCtx, 'untouched');
  });

  test('the Ollama address must be http(s) without a user name or password', () => {
    assert.equal(stored({ ollamaUrl: 42 }).ollamaUrl, DEFAULT_SETTINGS.ollamaUrl);
    assert.equal(stored({ ollamaUrl: 'ftp://host:11434' }).ollamaUrl, DEFAULT_SETTINGS.ollamaUrl);
    assert.equal(stored({ ollamaUrl: 'localhost:11434' }).ollamaUrl, DEFAULT_SETTINGS.ollamaUrl);
    assert.equal(stored({ ollamaUrl: 'http://user:pw@host:11434' }).ollamaUrl, DEFAULT_SETTINGS.ollamaUrl);
    assert.equal(stored({ ollamaUrl: ' https://gpu-box.local:11434/ ' }).ollamaUrl, 'https://gpu-box.local:11434/');
  });

  test('addressProblem names the problem the tab shows', () => {
    assert.equal(addressProblem('http://localhost:11434'), null);
    assert.equal(addressProblem('https://gpu.local'), null);
    assert.equal(addressProblem('localhost:11434'), ADDRESS_EXAMPLE);
    assert.equal(addressProblem('ftp://x'), ADDRESS_EXAMPLE);
    assert.equal(addressProblem(''), ADDRESS_EXAMPLE);
    assert.equal(addressProblem('http://u:p@host'), ADDRESS_CREDENTIALS);
    assert.equal(addressProblem('http://u@host'), ADDRESS_CREDENTIALS);
  });

  test('numbers are clamped to what the tab accepts, rounded where whole, and replaced when not numbers', () => {
    assert.equal(stored({ numCtx: 1 }).numCtx, SETTING_RANGES.numCtx.min);
    assert.equal(stored({ numCtx: 1e9 }).numCtx, SETTING_RANGES.numCtx.max);
    assert.equal(stored({ numCtx: 8192.6 }).numCtx, 8193);
    assert.equal(stored({ numCtx: '16384' }).numCtx, DEFAULT_SETTINGS.numCtx);
    assert.equal(stored({ numCtx: Number.NaN }).numCtx, DEFAULT_SETTINGS.numCtx);
    assert.equal(stored({ costPer1k: 0.0025 }).costPer1k, 0.0025);
    assert.equal(stored({ costPer1k: -1 }).costPer1k, 0);
    assert.equal(stored({ enhanceDebounceMs: null }).enhanceDebounceMs, DEFAULT_SETTINGS.enhanceDebounceMs);
  });

  test('a choice outside the words the tab offers', () => {
    assert.equal(stored({ enhanceStyle: 'loud' }).enhanceStyle, DEFAULT_SETTINGS.enhanceStyle);
    assert.equal(stored({ summaryStyle: 1 }).summaryStyle, DEFAULT_SETTINGS.summaryStyle);
    assert.equal(stored({ summaryLanguage: 'de' }).summaryLanguage, DEFAULT_SETTINGS.summaryLanguage);
    assert.equal(stored({ sttLanguage: 'fr' }).sttLanguage, DEFAULT_SETTINGS.sttLanguage);
    assert.equal(stored({ dailyLinkPlacement: 'top' }).dailyLinkPlacement, DEFAULT_SETTINGS.dailyLinkPlacement);
  });

  test('toggles must be booleans', () => {
    assert.equal(stored({ liveEnhanceDefault: 'yes' }).liveEnhanceDefault, false);
    assert.equal(stored({ actionItemsAsTasks: 1 }).actionItemsAsTasks, false);
    assert.equal(stored({ linkEntitiesInCompanion: true }).linkEntitiesInCompanion, true);
  });

  test('folders lose their . and .. segments and outer slashes; the indexed folders must be a list of them', () => {
    assert.equal(stored({ companionFolder: '/../Meetings/' }).companionFolder, 'Meetings');
    assert.equal(stored({ companionFolder: '' }).companionFolder, '', 'empty means the vault root');
    assert.equal(stored({ entitiesPath: 'a/./b.md' }).entitiesPath, 'a/b.md');
    assert.deepEqual(stored({ indexedFolders: 'x' }).indexedFolders, []);
    assert.deepEqual(stored({ indexedFolders: ['10 Work/', ' ', 7, '../x', '/', '10 Work', 'a/b/'] }).indexedFolders, [
      '10 Work',
      '/',
      'a/b',
    ]);
  });

  test('the companion prefix and the extra properties must be usable as they are', () => {
    assert.equal(stored({ companionPrefix: 'a/b' }).companionPrefix, DEFAULT_SETTINGS.companionPrefix);
    assert.equal(stored({ companionPrefix: '' }).companionPrefix, DEFAULT_SETTINGS.companionPrefix);
    assert.equal(stored({ companionPrefix: 'Réunion ' }).companionPrefix, 'Réunion ');
    assert.equal(stored({ companionProperties: 'not a property' }).companionProperties, '');
    assert.equal(stored({ companionProperties: 'date: today' }).companionProperties, '', 'a key the plugin writes');
    assert.equal(stored({ companionProperties: 'area: work' }).companionProperties, 'area: work');
  });

  test('the soft-marker pattern is stored as text and judged where it runs', () => {
    assert.equal(stored({ softMarkerPattern: '(a+)+' }).softMarkerPattern, '(a+)+');
    assert.equal(stored({ softMarkerPattern: 5 }).softMarkerPattern, DEFAULT_SETTINGS.softMarkerPattern);
  });
});
