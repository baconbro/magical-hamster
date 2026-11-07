import { MarkdownView } from 'obsidian';
import type { App, TFile, WorkspaceLeaf } from 'obsidian';
import { insertDailyLink, insertNoteLink } from '../editor/dailyLink.ts';
import type { DailyNoteLocator } from '../editor/dailyNote.ts';
import { entityNames, parseEntities } from '../editor/entities.ts';
import { readCompanionKeys, regionSkeleton } from '../notes/companion.ts';
import type { CompanionStore } from '../notes/companionStore.ts';
import type { TextTarget } from '../notes/textTarget.ts';
import { headingTitle, stripFrontmatter } from '../rag/chunk.ts';
import { softMarkerRegex } from '../settings.ts';
import type { Entity, HamsterSettings, NotesHost } from '../types.ts';
import { confirmWrite } from '../ui/ConfirmWriteModal.ts';
import { truncate } from '../util/text.ts';
import { showNotice } from './notice.ts';

const MAX_LINKED_NOTES = 4;

export interface NotesHostDeps {
  settings(): HamsterSettings;
  locator: DailyNoteLocator;
  target: TextTarget;
  companions: CompanionStore;
}

function closesFence(body: string, fence: { char: string; length: number }): boolean {
  const mark = body.replace(/^[ \t>]*/, '').trimEnd();
  if (mark.length < fence.length) return false;
  for (const char of mark) if (char !== fence.char) return false;
  return true;
}

/**
 * The note without its "Linked mentions" section. On an entity note that
 * section is a query listing every daily that mentions it: it is the other
 * notes' text, not this note's, and it would crowd out the note itself.
 */
export function stripLinkedMentions(markdown: string): string {
  const kept: string[] = [];
  let fence: { char: string; length: number } | null = null;
  // Level of the "Linked mentions" heading being skipped; 0 when none.
  let skipping = 0;

  for (const line of markdown.split('\n')) {
    const body = line.endsWith('\r') ? line.slice(0, -1) : line;
    if (fence) {
      if (closesFence(body, fence)) fence = null;
      if (!skipping) kept.push(line);
      continue;
    }
    const open = /^[ \t>]*(`{3,}|~{3,})(.*)$/.exec(body);
    // ```code``` on one line is an inline span, not a fence.
    if (open && !(open[1][0] === '`' && open[2].includes('`'))) {
      fence = { char: open[1][0], length: open[1].length };
      if (!skipping) kept.push(line);
      continue;
    }
    const heading = /^ {0,3}(#{1,6})(?:[ \t]+(.*))?$/.exec(body);
    if (heading) {
      const level = heading[1].length;
      if (skipping && level > skipping) continue;
      skipping = 0;
      const title = headingTitle(heading[2] ?? '')
        .replace(/[*_`]/g, '')
        .trim();
      if (/^linked mentions:?$/i.test(title)) {
        skipping = level;
        continue;
      }
    }
    if (!skipping) kept.push(line);
  }
  return kept.join('\n');
}

/** What a linked note contributes to a question: its own text, at most `maxChars` characters of it. */
export function linkedNoteText(markdown: string, maxChars: number): string {
  const text = stripLinkedMentions(stripFrontmatter(markdown)).replace(/\r\n?/g, '\n').trim();
  if (!(maxChars > 0)) return '';
  // `truncate` adds an ellipsis after the cut; one character is left for it.
  return text.length <= maxChars ? text : truncate(text, maxChars - 1);
}

/** Top-level and second-level folders, sorted, without the config folder. */
export function pickerFolders(paths: string[], configDir: string): string[] {
  return paths
    .filter((path) => {
      if (path === '' || path === '/') return false;
      if (path === configDir || path.startsWith(`${configDir}/`)) return false;
      return path.split('/').length <= 2;
    })
    .sort((a, b) => a.localeCompare(b));
}

function showsFile(leaf: WorkspaceLeaf, path: string): boolean {
  if (!leaf.isDeferred && leaf.view instanceof MarkdownView) return leaf.view.file?.path === path;
  // A deferred leaf has no view yet; its saved state still says which file it holds.
  return leaf.getViewState().state?.file === path;
}

/** Everything the session needs from the vault, on top of Obsidian. */
export function createNotesHost(app: App, deps: NotesHostDeps): NotesHost {
  const { locator, target, companions } = deps;
  let registry: { path: string; mtime: number; entities: Entity[] } | null = null;

  async function entities(): Promise<Entity[]> {
    const file = target.file(deps.settings().entitiesPath);
    if (!file) return [];
    if (registry && registry.path === file.path && registry.mtime === file.stat.mtime) {
      return registry.entities;
    }
    const parsed = parseEntities(await app.vault.cachedRead(file));
    registry = { path: file.path, mtime: file.stat.mtime, entities: parsed };
    return parsed;
  }

  async function open(file: TFile): Promise<void> {
    const { workspace } = app;
    for (const leaf of workspace.getLeavesOfType('markdown')) {
      if (!showsFile(leaf, file.path)) continue;
      await workspace.revealLeaf(leaf);
      workspace.setActiveLeaf(leaf, { focus: true });
      return;
    }
    /* A new tab rather than the current one: during a meeting the current tab
       is the daily note the user is typing in. An empty tab is reused. */
    const recent = workspace.getMostRecentLeaf();
    const leaf = recent && recent.view.getViewType() === 'empty' ? recent : workspace.getLeaf('tab');
    /* Asked to become the active tab: with "Always focus new tabs" off Obsidian
       leaves a new tab behind the current one, and the click came from the
       sidebar, so the note would load where nobody sees it. */
    await leaf.openFile(file, { active: true });
  }

  return {
    today: () => locator.today(),

    readDaily: () => target.read(locator.today().path),

    entities,

    exists: (path) => companions.exists(path),

    findCompanion: (date, source) => companions.find(date, source),

    // Resolved as a link written in today's daily, which is where the link line is.
    findCompanionByBasename: (basename, from) => companions.findByBasename(basename, from ?? locator.today().path),

    readNote: (path) => target.read(path),

    async insertNoteLink(args) {
      const settings = deps.settings();
      const known = await entities().catch((): Entity[] => []);
      return insertNoteLink(target, args.path, args, {
        softMarker: softMarkerRegex(settings),
        entityNames: entityNames(known),
        linkPrefix: settings.companionPrefix,
      });
    },

    async prepareMeetingNote(path, meta) {
      const file = target.file(path);
      if (!file) return 'missing';
      const current = await target.read(path);
      if (current === null) return 'missing';
      if (current.includes('<!-- hamster:begin')) return 'exists';
      // The sections first, through the same path as every other write: the editor when it is open.
      const added = await target.insertLine(path, (text) => {
        if (text.includes('<!-- hamster:begin')) return null;
        const lines = text.split('\n');
        let last = lines.length - 1;
        // After the last line that holds something, so trailing blank lines stay below.
        while (last > 0 && lines[last].trim() === '') last -= 1;
        return { afterLine: last, text: regionSkeleton().join('\n') };
      });
      if (added === 'missing') return 'missing';
      if (added === 'skipped') return 'busy';
      // Then the properties, with Obsidian's own frontmatter editor: the existing ones stay.
      await app.fileManager.processFrontMatter(file, (fm: Record<string, unknown>) => {
        if (fm.type === undefined) fm.type = 'meeting';
        fm.date = meta.date;
        fm.hamster_source = meta.source;
        const tags = Array.isArray(fm.tags) ? fm.tags.map(String) : typeof fm.tags === 'string' ? [fm.tags] : [];
        for (const tag of ['meeting', 'magical-hamster']) if (!tags.includes(tag)) tags.push(tag);
        fm.tags = tags;
      });
      return 'done';
    },

    async createCompanion(path, content) {
      // The store keeps track of new companions by this key until the metadata cache has read them.
      const keys = readCompanionKeys(content);
      await companions.create(path, content, {
        date: keys.date ?? locator.today().date,
        source: keys.source ?? '',
      });
    },

    writeCompanion: (path, patches) => target.writeRegions(path, patches),

    touchCompanion: (path, isoDate) => companions.touch(path, isoDate),

    readCompanion: (path) => companions.read(path),

    async insertDailyLink(args) {
      const daily = locator.today();
      if (!daily.exists) return { status: 'no-daily' };
      const settings = deps.settings();
      // The same options the session parses the daily with, so both see the same sections.
      const known = await entities().catch((): Entity[] => []);
      return insertDailyLink(target, daily.path, args, {
        softMarker: softMarkerRegex(settings),
        entityNames: entityNames(known),
        linkPrefix: settings.companionPrefix,
      });
    },

    confirmFirstWrite: (preview) => confirmWrite(app, preview),

    async readLinkedNotes(links, maxChars) {
      const notes: Array<{ title: string; path: string; text: string }> = [];
      const seen = new Set<string>();
      const from = locator.today().path;
      for (const link of links) {
        if (notes.length >= MAX_LINKED_NOTES) break;
        const file = app.metadataCache.getFirstLinkpathDest(link, from);
        if (!file || file.extension !== 'md' || seen.has(file.path)) continue;
        seen.add(file.path);
        let text: string;
        try {
          text = linkedNoteText(await app.vault.cachedRead(file), maxChars);
        } catch {
          continue;
        }
        if (text !== '') notes.push({ title: file.basename, path: file.path, text });
      }
      return notes;
    },

    listFolders: () =>
      pickerFolders(
        app.vault.getAllFolders(false).map((folder) => folder.path),
        app.vault.configDir,
      ),

    openNote(path) {
      const file = target.file(path);
      if (!file) {
        showNotice(`${path} is no longer in the vault.`);
        return;
      }
      open(file).catch((error: unknown) => {
        console.error('Magical Hamster: could not open the note', error);
      });
    },

    notice(message, ms) {
      showNotice(message, ms);
    },
  };
}
