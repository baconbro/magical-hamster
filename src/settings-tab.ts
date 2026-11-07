import { Notice, PluginSettingTab, Setting, normalizePath } from 'obsidian';
import type { App, DropdownComponent, Plugin } from 'obsidian';
import { softMarkerUnsupported } from './settings.ts';
import { remoteHostWarning } from './util/loopback.ts';
import type { HamsterSettings, LocalSettings } from './types.ts';
import { SPEECH_SETUP_COMMAND } from './project.ts';
import { parseCompanionProperties } from './notes/companion.ts';

export interface SettingsTabDeps {
  settings(): HamsterSettings;
  /** Saves the change and lets the session react to it. */
  updateSettings(patch: Partial<HamsterSettings>): Promise<void>;
  local(): LocalSettings;
  setLocal(patch: Partial<LocalSettings>): void;
  /** The runtime directory used when the device has none of its own set. */
  defaultRuntimeDir(): string;
  /** The runtime directory in use: the device's own with a leading `~` expanded, or the default. */
  runtimeDir(): string;
  /** The speech runtime installed in that directory, or null. `node` is the Node its setup recorded. */
  readRuntime(runtimeDir: string): InstalledRuntime | null;
}

export interface InstalledRuntime {
  model: string;
  node: string;
}

/* Text fields are saved once typing pauses: every save makes the session
   look at Ollama again, and one request per keystroke is too many. */
const SAVE_DELAY_MS = 400;

const PROBE_BUDGET_MS = 20;
/* All probes of one pattern together. An ordinary pattern needs a small part
   of it; one that is slow everywhere without any single probe going over its
   budget would otherwise keep the check busy for minutes. */
const PROBE_TOTAL_MS = 1500;
const PROBE_RUN_LENGTH = 50;
/* What a meeting line is made of. A pattern that backtracks without end does
   so on a run of whatever it repeats, when what follows the run does not
   match: each of these is tried as a run, behind each way the line can start
   and in front of something unexpected. */
const PROBE_UNITS = ['a', '1', ' ', 'a ', 'a1', '-', 'é', ':', '.'];
/* After the run: a sign no meeting word holds, nothing, and a space before the
   sign, for a repetition that takes signs but stops at a space: (\S+)+$ */
const PROBE_TAILS = ['!', '', ' !'];
const PROBE_OWN_UNITS = 16;
const PROBE_OWN_WORDS = 6;
const PROBE_OWN_STARTS = 12;

const TOO_SLOW =
  'This pattern is too slow on a long line and would freeze typing. Avoid a repetition inside a repetition, such as (a+)+.';

const ILLEGAL_IN_FILE_NAME = /[[\]#^|/\\:*?"<>\r\n]/;

// Where Homebrew puts Node on Apple silicon: an example of what the field takes.
const NODE_PATH_EXAMPLE = '/opt/homebrew/bin/node';

type Keys<V> = { [K in keyof HamsterSettings]: HamsterSettings[K] extends V ? K : never }[keyof HamsterSettings];
/** Settings that hold free text, as opposed to one of a fixed set of words. */
type TextKey = { [K in Keys<string>]: string extends HamsterSettings[K] ? K : never }[Keys<string>];
type ChoiceKey = Exclude<Keys<string>, TextKey>;
type NumberKey = Keys<number>;
type ToggleKey = Keys<boolean>;

export interface NumberRule {
  min: number;
  max: number;
  integer?: boolean;
}

/** The number typed into a field, or null when it is not one the rule accepts. */
export function parseNumber(text: string, rule: NumberRule): number | null {
  const trimmed = text.trim().replace(',', '.');
  if (!/^-?(?:\d+\.?\d*|\.\d+)$/.test(trimmed)) return null;
  const value = Number(trimmed);
  if (!Number.isFinite(value) || value < rule.min || value > rule.max) return null;
  if (rule.integer && !Number.isInteger(value)) return null;
  return value;
}

function describeRule(rule: NumberRule): string {
  const kind = rule.integer ? 'a whole number' : 'a number';
  return `Enter ${kind} from ${rule.min} to ${rule.max}.`;
}

interface Starts {
  /** The literal texts read so far, one for each way through the alternatives. */
  texts: string[];
  /** False once something that is not literal text was met: nothing can be added behind it. */
  whole: boolean;
}

/**
 * The literal text a match of `source` can begin with, for each way through
 * its alternatives and optional parts, up to the first thing that is not plain
 * text (a class, `\w`, a repetition): `^Point (hebdo|mensuel) : (\w+ ?)+$`
 * gives `Point hebdo : ` and `Point mensuel : `. Reads only as much of the
 * syntax as that takes; whatever it does not know ends the text there.
 */
function literalStarts(source: string): string[] {
  let at = 0;

  const joined = (heads: string[], tails: string[]): string[] => {
    const out: string[] = [];
    for (const head of heads) for (const tail of tails) if (out.length < PROBE_OWN_STARTS) out.push(head + tail);
    return out;
  };

  /** Moves to the end of the alternative being read: its `|`, the `)` that closes its group, or the end. */
  const skipAlternative = (): void => {
    let depth = 0;
    for (; at < source.length; at++) {
      const char = source[at];
      if (char === '\\') at += 1;
      else if (char === '[') {
        for (at += 1; at < source.length && source[at] !== ']'; at++) if (source[at] === '\\') at += 1;
      } else if (char === '(') depth += 1;
      else if (depth === 0 && (char === ')' || char === '|')) return;
      else if (char === ')') depth -= 1;
    }
  };

  const alternatives = (): Starts => {
    const texts: string[] = [];
    let whole = true;
    for (;;) {
      const one = sequence();
      texts.push(...one.texts);
      whole &&= one.whole;
      if (source[at] !== '|') break;
      at += 1;
    }
    return { texts: texts.slice(0, PROBE_OWN_STARTS), whole };
  };

  const sequence = (): Starts => {
    let texts = [''];
    const ended = (): Starts => {
      skipAlternative();
      return { texts, whole: false };
    };
    for (;;) {
      const char = source[at];
      if (char === undefined || char === '|' || char === ')') return { texts, whole: true };
      const next = source[at + 1] ?? '';
      // Where a line starts and where a word ends take no text.
      if (char === '^' || (char === '\\' && (next === 'b' || next === 'B'))) {
        at += char === '^' ? 1 : 2;
        continue;
      }
      let piece: Starts;
      if (char === '\\') {
        // \w, \d, \s, \1, \p{L}: not literal. An escaped sign is the sign.
        if (next === '' || /[a-zA-Z0-9]/.test(next)) return ended();
        piece = { texts: [next], whole: true };
        at += 2;
      } else if (char === '(') {
        // A plain, non-capturing or named group. A lookaround is not text.
        const opener = /^\((?:\?:|\?<[A-Za-z_]\w*>|(?!\?))/.exec(source.slice(at, at + 64));
        if (!opener) return ended();
        at += opener[0].length;
        piece = alternatives();
        if (source[at] === ')') at += 1;
      } else if ('[.$*+?{'.includes(char)) {
        return ended();
      } else {
        piece = { texts: [char], whole: true };
        at += 1;
      }
      const after = source[at];
      // A repetition starts here: the literal text ends in front of it.
      if (after === '*' || after === '+' || after === '{') return ended();
      if (after === '?') {
        at += source[at + 1] === '?' ? 2 : 1;
        texts = [...texts, ...joined(texts, piece.texts)].slice(0, PROBE_OWN_STARTS);
      } else {
        texts = joined(texts, piece.texts);
      }
      if (!piece.whole) return ended();
    }
  };

  return alternatives().texts;
}

/**
 * The ways a line can start that take a soft-marker pattern past its opening
 * words, read off the pattern itself: `^(Sync|Standup) (\w+ ?)+$` only reaches
 * its repetition behind `Sync ` or `Standup `. First the literal text the
 * pattern begins with; then, for a pattern that begins with something else,
 * each literal word of the source, each two that follow one another and the
 * words from the first on, joined and spaced. Each with and without a space
 * behind. The words are a guess, not a parse of the pattern: a head that leads
 * nowhere costs a few fast probes.
 */
export function probeHeads(source: string): string[] {
  // The first two are how a meeting line starts with the default pattern, and how any line can.
  const heads = new Set(['1:1 ', '']);
  const add = (head: string): void => {
    heads.add(head);
    heads.add(`${head} `);
  };
  try {
    for (const start of literalStarts(source)) add(start);
  } catch {
    // Groups nested deeper than the reader can follow: the words below still give heads.
  }

  const literal = source
    // \w, \d, \b, \p{L}, a character given by its number: none stands for the letters it is written with.
    .replace(/\\(?:[pPk][{<][^}>]*[}>]|u\{[^}]*\}|u[0-9a-fA-F]{4}|x[0-9a-fA-F]{2}|[a-zA-Z0-9])/g, ' ')
    // So do a character class, a counted repetition and the opening of a special group.
    .replace(/\[(?:\\.|[^\]\\])*\]|\{[^}]*\}|\(\?(?:<?[=!]|:|<[^>]*>)/g, ' ')
    // An escaped sign is the sign: 1\:1
    .replace(/\\(.)/g, '$1');
  const words = (literal.match(/[\p{L}\p{N}]+(?:[:'’.-][\p{L}\p{N}]+)*/gu) ?? []).slice(0, PROBE_OWN_WORDS);
  words.forEach((word, i) => {
    add(word);
    const next = words[i + 1];
    if (next !== undefined) {
      add(word + next);
      add(`${word} ${next}`);
    }
    if (i >= 2) add(words.slice(0, i + 1).join(' '));
  });
  return [...heads];
}

/**
 * Why a soft-marker pattern must not be saved, or null when it may. The
 * pattern runs on every line of the daily note at every keystroke, so one that
 * backtracks without end would freeze typing. Such a pattern cannot be timed
 * on a long line (it would never return): each probe grows one step at a time
 * and the check stops at the first step that is too slow.
 */
export function checkSoftMarkerPattern(
  source: string,
  now: () => number = () => performance.now(),
): string | null {
  if (source.trim() === '') return 'Enter a pattern. To match nothing, use $^';
  let pattern: RegExp;
  try {
    pattern = new RegExp(source, 'i');
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return `This is not a valid regular expression. ${detail}`;
  }
  /* Before anything is timed: behind a lookahead or a long counted repetition
     a slow pattern is fast on every probe until one probe never returns. */
  const unsupported = softMarkerUnsupported(source);
  if (unsupported !== null) return unsupported;
  const elapsed = (probe: string): number => {
    const started = now();
    pattern.test(probe);
    return now() - started;
  };
  // A pattern can also repeat a character of its own: `(x+x+)+y` is only slow on a run of x.
  const own = (source.toLowerCase().match(/[\p{L}\p{N}]/gu) ?? []).slice(0, PROBE_OWN_UNITS);
  const heads = probeHeads(source);
  let spent = 0;
  for (const unit of new Set([...PROBE_UNITS, ...own])) {
    for (const head of heads) {
      for (const tail of PROBE_TAILS) {
        /* One start and one end at a time, the run growing between them: the
           first combination that is slow is caught on its way up, before the
           others have each paid for a step that is almost too slow. */
        let run = '';
        while (run.length + unit.length <= PROBE_RUN_LENGTH) {
          run += unit;
          const probe = head + run + tail;
          const took = elapsed(probe);
          // Measured twice before refusing: one slow run can be the machine, not the pattern.
          if (took > PROBE_BUDGET_MS && elapsed(probe) > PROBE_BUDGET_MS) return TOO_SLOW;
          spent += took;
          if (spent > PROBE_TOTAL_MS) return TOO_SLOW;
        }
      }
    }
  }
  return null;
}

/** What stands under the Ollama address: where Ollama normally is, or that this address sends the meeting elsewhere. */
export function describeOllamaAddress(address: string): { text: string; warning: boolean } {
  const warning = remoteHostWarning(address);
  if (warning === null) return { text: 'Where Ollama listens on this computer.', warning: false };
  return {
    text: `${warning} The address is synced with the vault: every device that opens the vault sends them there too.`,
    warning: true,
  };
}

function isHttpAddress(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

/** Why a companion prefix must not be saved, or null when it may. */
export function checkPrefix(prefix: string): string | null {
  if (prefix.trim() === '') return 'Enter a prefix. Companion notes are found by it.';
  if (ILLEGAL_IN_FILE_NAME.test(prefix)) return 'A file name cannot contain [ ] # ^ | / \\ : * ? " < >';
  if (prefix.startsWith('.')) return 'A file name that starts with a dot is hidden.';
  return null;
}

/** Folders as typed, one per line: as vault paths (Obsidian's normalizePath), without duplicates. `/` is the whole vault. */
export function parseFolderList(text: string): string[] {
  const folders: string[] = [];
  for (const line of text.split('\n')) {
    const raw = line.trim();
    if (raw === '') continue;
    const folder = normalizePath(raw);
    if (!folders.includes(folder)) folders.push(folder);
  }
  return folders;
}

/**
 * What the Node path field shows while it is empty: the Node an empty field
 * runs, which is the one the speech setup recorded, or an example of a path
 * when no runtime is installed.
 */
export function nodePathPlaceholder(installed: { node: string } | null): string {
  return installed?.node.trim() || NODE_PATH_EXAMPLE;
}

function cleanPath(value: string): string {
  const trimmed = value.trim();
  if (trimmed === '' || /^\/+$/.test(trimmed)) return '';
  return normalizePath(trimmed);
}

export class HamsterSettingTab extends PluginSettingTab {
  private readonly deps: SettingsTabDeps;
  private queued: Partial<HamsterSettings> = {};
  private timer: number | null = null;
  /* Typed and valid, but not in effect before the field is left: see `ollamaAddress`. */
  private held: Partial<HamsterSettings> = {};

  constructor(app: App, plugin: Plugin, deps: SettingsTabDeps) {
    super(app, plugin);
    this.deps = deps;
  }

  display(): void {
    this.commit();
    this.flush();
    const { containerEl } = this;
    containerEl.empty();

    this.heading('Models');
    this.ollamaAddress();
    this.text(
      'Model',
      'Writes enhanced notes, summaries and answers. Changing the model reloads it in Ollama.',
      'llmModel',
      (raw) => (raw.trim() === '' ? { error: 'Enter a model name, such as gemma4:12b' } : { value: raw.trim() }),
    );
    this.text(
      'Live enhance model',
      'Leave empty to use the same model. A second model takes memory of its own.',
      'liveModel',
      (raw) => ({ value: raw.trim() }),
      'Same as the model above',
    );
    this.number(
      'Context size',
      'Tokens the model reads at once, sent with every request. Changing it reloads the model in Ollama.',
      'numCtx',
      { min: 1024, max: 1048576, integer: true },
    );
    this.text(
      'Embedding model',
      'Finds the passages that match a note line or a question. After changing it, build the knowledge index again.',
      'embedModel',
      (raw) => (raw.trim() === '' ? { error: 'Enter a model name, such as embeddinggemma-2:270m' } : { value: raw.trim() }),
    );
    this.number(
      'Embedding context size',
      'Tokens per passage. Changing it reloads the embedding model in Ollama.',
      'embedNumCtx',
      { min: 128, max: 32768, integer: true },
    );
    this.number(
      'Embedding dimensions',
      'Length of each vector. After changing it, build the knowledge index again.',
      'embedDimensions',
      { min: 32, max: 8192, integer: true },
    );

    this.heading('Notes');
    this.text(
      'Companion folder',
      'Where companion notes are created. The folder is created when missing. Empty means the vault root.',
      'companionFolder',
      (raw) => ({ value: cleanPath(raw) }),
    );
    this.text(
      'Companion prefix',
      'Start of every companion file name. Companions are found by it: notes made with another prefix are no longer recognized.',
      'companionPrefix',
      (raw) => {
        const value = raw.trimStart().normalize('NFC');
        const error = checkPrefix(value);
        return error ? { error } : { value };
      },
    );
    const properties = new Setting(this.containerEl)
      .setName('Extra properties')
      .setDesc(
        "Added to the properties of each new companion note, one key: value per line, for example area: work. The plugin's own (type, date, tags, links and the like) stay as they are.",
      );
    properties.addTextArea((area) => {
      area.setValue(this.deps.settings().companionProperties);
      area.setPlaceholder('area: work');
      area.inputEl.rows = 3;
      area.onChange((raw) => {
        const result = parseCompanionProperties(raw);
        if ('error' in result) {
          // Not saved: the last valid value stays in use.
          this.unqueue('companionProperties');
          properties.setErrorMessage(result.error);
          return;
        }
        properties.setErrorMessage(null);
        this.saveSoon({ companionProperties: raw.trim() });
      });
    });
    this.choice(
      'Link placement',
      'Where the one line goes in the daily note. Directly under a heading, it becomes part of the excerpt other notes show for that heading.',
      'dailyLinkPlacement',
      { 'section-end': 'End of the section', heading: 'Under the heading' },
    );
    this.text(
      'Link text',
      'Shown in place of the note name. Leave empty to show the name.',
      'dailyLinkAlias',
      (raw) => ({ value: raw.trim() }),
    );
    this.toggle(
      'Keep wikilinks in generated text',
      'Each link adds a generated excerpt to the linked mentions of that note.',
      'linkEntitiesInCompanion',
    );
    this.text(
      'Entity registry',
      'Optional. Vault path of a note that lists people, projects and governance bodies, to recognize meetings and attendees (see the README). Empty: none.',
      'entitiesPath',
      (raw) => ({ value: cleanPath(raw) }),
    );
    this.text(
      'Meeting lines without a heading',
      'A regular expression, not case-sensitive. A short line that matches starts a meeting.',
      'softMarkerPattern',
      (raw) => {
        const error = checkSoftMarkerPattern(raw);
        return error ? { error } : { value: raw };
      },
    );
    new Setting(containerEl)
      .setName('First-write confirmation')
      .setDesc('Shown once on this device, before the first companion note is created.')
      .addButton((button) =>
        button.setButtonText('Ask again before the first write').onClick(() => {
          this.deps.setLocal({ firstWriteConfirmed: false });
          new Notice('Magical Hamster: The confirmation will be shown before the next first write.');
        }),
      );

    this.heading('Enhance');
    this.choice(
      'Enhance style',
      'Standard writes full sentences. Concise writes short phrases. A change applies at once: the enhanced notes of the current meeting are written again. The sidebar can change it too, until Obsidian restarts.',
      'enhanceStyle',
      { standard: 'Standard', concise: 'Concise' },
    );
    this.toggle(
      'Live enhance on at start',
      'Applies the next time Obsidian starts. The sidebar turns it on and off at any time.',
      'liveEnhanceDefault',
    );
    this.number(
      'Typing pause',
      'Milliseconds without typing before live enhance runs.',
      'enhanceDebounceMs',
      { min: 200, max: 60000, integer: true },
    );
    this.number(
      'Longest wait',
      'Milliseconds after which live enhance runs even while typing continues.',
      'enhanceMaxWaitMs',
      { min: 500, max: 300000, integer: true },
    );

    this.heading('Summary');
    this.choice('Summary style', 'Used for the summary written when a recording stops.', 'summaryStyle', {
      executive: 'Executive summary',
      recap: 'Recap',
      actions: 'Action items',
    });
    this.choice('Summary language', 'Auto keeps the language the meeting was held in.', 'summaryLanguage', {
      auto: 'Auto',
      fr: 'French',
      en: 'English',
    });
    this.toggle(
      'Tasks as checkboxes',
      'In the companion note, writes the action items, and the bullets of the tasks you type ("- [ ] ..."), as checkboxes. Other task tools in the vault will count them, so a task you type is listed twice: tick it in your own note. Off, your tasks are marked ☐ (☑ when done).',
      'actionItemsAsTasks',
    );

    this.heading('Speech');
    this.choice(
      'Speech language',
      'Auto follows the language as people speak, sentence by sentence. A fixed language drops what is said in the other one, so keep Auto for meetings in both. Applies to the next recording.',
      'sttLanguage',
      { auto: 'Auto', 'fr-CA': 'French (Canada)', 'fr-FR': 'French (France)', 'en-US': 'English (US)' },
    );
    this.text(
      'Microphone label',
      'Name given to the microphone in transcripts. On speakers it hears everyone: use Mic (room).',
      'micLabel',
      (raw) => (raw.trim() === '' ? { error: 'Enter a label.' } : { value: raw.trim() }),
    );
    this.microphone();
    const showNodePlaceholder = this.localText(
      'Node path',
      'The Node program that runs speech recognition. Leave empty to use the Node that the speech setup recorded. This device only.',
      'nodePath',
      NODE_PATH_EXAMPLE,
    );
    let showRuntime = (): void => undefined;
    this.localText(
      'Runtime folder',
      'Holds the speech model, the knowledge index and the stats, outside the vault. Leave empty for the default. This device only. A new folder is used for speech at the next recording, and for the index and the stats the next time Obsidian starts. Nothing is copied into it.',
      'runtimeDir',
      this.deps.defaultRuntimeDir(),
      () => showRuntime(),
    );
    const runtime = new Setting(containerEl).setName('Speech runtime');
    new Setting(containerEl)
      .setName('Set up speech recognition')
      .setDesc(
        `Once, in Terminal (Applications, Utilities), with Node.js 20 or later installed. It downloads about 490 MB, the sherpa-onnx speech library from npm and the speech model from GitHub, into the runtime folder; run it again to repair or update. For a runtime folder of your own, add --runtime and the folder. The command (the button copies it): ${SPEECH_SETUP_COMMAND} (in Terminal).`,
      )
      .addButton((button) => {
        button.setButtonText('Copy command').onClick(() => {
          navigator.clipboard.writeText(SPEECH_SETUP_COMMAND).then(
            () => new Notice('Setup command copied: paste it into Terminal.'),
            (error: unknown) => console.error('Magical Hamster: could not copy', error),
          );
        });
      });
    showRuntime = () => {
      const installed = this.installedRuntime();
      // Each runtime folder records its own Node: the empty field shows the one it would run.
      showNodePlaceholder(nodePathPlaceholder(installed));
      runtime.setDesc(
        installed
          ? `Installed: ${installed.model}`
          : 'Not installed. Set it up with the command below.',
      );
    };
    showRuntime();

    this.heading('Knowledge index');
    new Setting(containerEl)
      .setName('Indexed folders')
      .setDesc('One folder per line. A single / is the whole vault. Press Rebuild index in the sidebar to apply.')
      .addTextArea((area) => {
        area.setValue(this.deps.settings().indexedFolders.join('\n'));
        area.inputEl.rows = 4;
        area.onChange((raw) => this.saveSoon({ indexedFolders: parseFolderList(raw) }));
      });

    this.heading('Stats');
    this.number(
      'Cost per 1,000 tokens',
      'In dollars. Used for the figure of what running on this computer saved.',
      'costPer1k',
      { min: 0, max: 1000 },
    );

    this.heading('Debug');
    new Setting(this.containerEl)
      .setName('Show the debug tab')
      .setDesc(
        'A sidebar tab with every exchange with the model: what was sent and what came back. It holds your notes and transcript, is kept in memory only for the last 100 calls, and is gone when Obsidian closes. This computer only.',
      )
      .addToggle((toggle) => {
        toggle.setValue(this.deps.local().debugTab);
        toggle.onChange((value) => this.deps.setLocal({ debugTab: value }));
      });
  }

  hide(): void {
    // A field edited just before closing must not lose its last characters.
    this.commit();
    this.flush();
    super.hide();
  }

  private heading(name: string): void {
    new Setting(this.containerEl).setName(name).setHeading();
  }

  /* The Ollama address decides where the text of a meeting is sent. Unlike the
     other fields it is not saved when typing pauses: `http://192.168.1.5`, on
     the way to `http://192.168.1.50`, is an address too, and it would be asked
     for its models, and sent the next request, at once. It takes effect when
     the field is left, on Enter, and when the settings close. An address that
     is not this computer says so under the field as soon as it is typed. */
  private ollamaAddress(): void {
    const setting = new Setting(this.containerEl).setName('Ollama address');
    const describe = (address: string): void => {
      const { text, warning } = describeOllamaAddress(address);
      setting.setDesc(text);
      setting.descEl.toggleClass('mod-warning', warning);
    };
    describe(this.deps.settings().ollamaUrl);
    setting.addText((field) => {
      field.setValue(this.deps.settings().ollamaUrl);
      field.onChange((raw) => {
        const value = raw.trim();
        if (!isHttpAddress(value)) {
          // Not saved: the last valid value stays in use, and it is the one described.
          delete this.held.ollamaUrl;
          setting.setErrorMessage('Enter an address such as http://localhost:11434');
          describe(this.deps.settings().ollamaUrl);
          return;
        }
        setting.setErrorMessage(null);
        describe(value);
        this.held.ollamaUrl = value;
      });
      field.inputEl.addEventListener('blur', () => this.commit());
      field.inputEl.addEventListener('keydown', (event) => {
        if (event.key === 'Enter' && !event.isComposing) this.commit();
      });
    });
  }

  private text(
    name: string,
    desc: string,
    key: TextKey,
    read: (raw: string) => { value: string } | { error: string },
    placeholder?: string,
  ): void {
    const setting = new Setting(this.containerEl).setName(name).setDesc(desc);
    setting.addText((field) => {
      field.setValue(this.deps.settings()[key]);
      if (placeholder) field.setPlaceholder(placeholder);
      field.onChange((raw) => {
        const result = read(raw);
        if ('error' in result) {
          // Not saved: the last valid value stays in use.
          this.unqueue(key);
          setting.setErrorMessage(result.error);
          return;
        }
        setting.setErrorMessage(null);
        this.saveSoon({ [key]: result.value });
      });
    });
  }

  private number(name: string, desc: string, key: NumberKey, rule: NumberRule): void {
    const setting = new Setting(this.containerEl).setName(name).setDesc(desc);
    setting.addText((field) => {
      field.setValue(String(this.deps.settings()[key]));
      field.inputEl.inputMode = rule.integer ? 'numeric' : 'decimal';
      field.onChange((raw) => {
        const value = parseNumber(raw, rule);
        if (value === null) {
          this.unqueue(key);
          setting.setErrorMessage(describeRule(rule));
          return;
        }
        setting.setErrorMessage(null);
        this.saveSoon({ [key]: value });
      });
    });
  }

  private toggle(name: string, desc: string, key: ToggleKey): void {
    new Setting(this.containerEl)
      .setName(name)
      .setDesc(desc)
      .addToggle((toggle) => {
        toggle.setValue(this.deps.settings()[key]);
        toggle.onChange((value) => this.saveNow({ [key]: value }));
      });
  }

  private choice<K extends ChoiceKey>(
    name: string,
    desc: string,
    key: K,
    options: Record<HamsterSettings[K], string>,
  ): void {
    new Setting(this.containerEl)
      .setName(name)
      .setDesc(desc)
      .addDropdown((dropdown) => {
        dropdown.addOptions(options);
        dropdown.setValue(this.deps.settings()[key]);
        dropdown.onChange((value) => {
          if (Object.hasOwn(options, value)) this.saveNow({ [key]: value });
        });
      });
  }

  /**
   * A path of this device's own. Saved as typed, and an emptied field as ''.
   * Returns the way to change what the empty field shows.
   */
  private localText(
    name: string,
    desc: string,
    key: 'nodePath' | 'runtimeDir',
    placeholder: string,
    changed?: () => void,
  ): (placeholder: string) => void {
    let show = (_text: string): void => undefined;
    new Setting(this.containerEl)
      .setName(name)
      .setDesc(desc)
      .addText((field) => {
        field.setValue(this.deps.local()[key]);
        field.setPlaceholder(placeholder);
        field.onChange((raw) => {
          this.deps.setLocal({ [key]: raw.trim() });
          changed?.();
        });
        show = (text) => {
          field.setPlaceholder(text);
        };
      });
    return (text) => show(text);
  }

  private microphone(): void {
    const setting = new Setting(this.containerEl)
      .setName('Microphone')
      .setDesc('This device only. Applies to the next recording.');
    setting.addDropdown((dropdown) => {
      const saved = this.deps.local().micDeviceId;
      dropdown.addOption('', 'System default');
      if (saved !== '') dropdown.addOption(saved, 'Saved microphone');
      dropdown.setValue(saved);
      dropdown.onChange((value) => this.deps.setLocal({ micDeviceId: value }));
      this.listMicrophones(dropdown, setting).catch((error: unknown) => {
        console.error('Magical Hamster: could not list the microphones', error);
      });
    });
  }

  private async listMicrophones(dropdown: DropdownComponent, setting: Setting): Promise<void> {
    const devices = (await navigator.mediaDevices?.enumerateDevices?.()) ?? [];
    const select = dropdown.selectEl;
    // The tab may have been closed or drawn again while the list was read.
    if (!select.isConnected) return;

    // Until Obsidian has been allowed to use a microphone, devices come without an id or a name.
    const inputs = devices.filter(
      (device) => device.kind === 'audioinput' && device.deviceId !== '' && device.deviceId !== 'default',
    );
    const saved = this.deps.local().micDeviceId;
    select.empty();
    dropdown.addOption('', 'System default');
    inputs.forEach((device, i) => {
      dropdown.addOption(device.deviceId, device.label || `Microphone ${i + 1}`);
    });
    if (saved !== '' && !inputs.some((device) => device.deviceId === saved)) {
      dropdown.addOption(saved, 'Saved microphone (not connected)');
    }
    dropdown.setValue(saved);
    if (inputs.length === 0) {
      setting.setDesc(
        'This device only. Microphones are listed here once Obsidian has been allowed to use one: start a recording first.',
      );
    }
  }

  /** The speech runtime in the folder in use, or null when none is installed there. */
  private installedRuntime(): InstalledRuntime | null {
    try {
      return this.deps.readRuntime(this.deps.runtimeDir());
    } catch {
      return null;
    }
  }

  private saveSoon(patch: Partial<HamsterSettings>): void {
    Object.assign(this.queued, patch);
    if (this.timer !== null) window.clearTimeout(this.timer);
    this.timer = window.setTimeout(() => this.flush(), SAVE_DELAY_MS);
  }

  private saveNow(patch: Partial<HamsterSettings>): void {
    Object.assign(this.queued, patch);
    this.flush();
  }

  /** Puts into effect what was typed into a field that waits for the typing to be over. */
  private commit(): void {
    const { ollamaUrl } = this.held;
    this.held = {};
    if (ollamaUrl !== undefined && ollamaUrl !== this.deps.settings().ollamaUrl) this.saveNow({ ollamaUrl });
  }

  /** Drops a value typed a moment ago that has since been edited into something invalid. */
  private unqueue(key: keyof HamsterSettings): void {
    delete this.queued[key];
  }

  private flush(): void {
    if (this.timer !== null) {
      window.clearTimeout(this.timer);
      this.timer = null;
    }
    const patch = this.queued;
    this.queued = {};
    if (Object.keys(patch).length === 0) return;
    this.deps.updateSettings(patch).catch((error: unknown) => {
      console.error('Magical Hamster: could not save the settings', error);
      new Notice('Magical Hamster: The settings could not be saved.');
    });
  }
}
