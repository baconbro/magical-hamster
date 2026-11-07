import type { TextTarget } from '../notes/textTarget.ts';
import type { LinkPlacement, Section } from '../types.ts';
import { findSection, isLinkLine, linkInsertion, wholeNoteSection, wikilinks } from './sectionAt.ts';
import type { SectionOptions } from './sectionAt.ts';

export interface DailyLinkArgs {
  section: { title: string; ordinal: number };
  companionBasename: string;
  line: string;
  placement: LinkPlacement;
}

export type DailyLinkResult =
  | { status: 'inserted'; via: 'editor' | 'vault' }
  | { status: 'exists' }
  | { status: 'no-daily' }
  | { status: 'no-section' };

function lastSegment(target: string): string {
  const slash = target.lastIndexOf('/');
  return slash < 0 ? target : target.slice(slash + 1);
}

/**
 * True when the section already holds the plugin's link line to that
 * companion. Decided by the link's target, not by `section.linkLine`: with
 * nested sections that can be a child's link to another companion.
 */
export function sectionLinksTo(
  docText: string,
  section: Section,
  companionBasename: string,
  linkPrefix?: string,
): boolean {
  const lines = docText.split('\n');
  const end = Math.min(section.bodyEndLine, lines.length);
  for (let i = section.bodyStartLine; i < end; i++) {
    const line = lines[i];
    if (!isLinkLine(line, linkPrefix)) continue;
    const target = wikilinks(line)[0];
    if (target === undefined) continue;
    const name = lastSegment(target);
    if (name === companionBasename || name === `${companionBasename}.md`) return true;
  }
  return false;
}

/**
 * Adds the companion's link line to its section of the daily note. This is
 * the only change the plugin ever makes to the user's own text.
 */
export async function insertDailyLink(
  target: TextTarget,
  dailyPath: string,
  args: DailyLinkArgs,
  opts: SectionOptions,
): Promise<DailyLinkResult> {
  // Set from inside the callback: an object, so the compiler does not assume it stays null.
  const found: { status: 'exists' | 'no-section' | null } = { status: null };
  const via = await target.insertLine(dailyPath, (text) => {
    /* Resolved from the text as it is at the moment of the write: the user may
       have typed, or moved the section, since the sidebar last looked. */
    const section = findSection(text, args.section, opts, args.companionBasename);
    if (!section) {
      found.status = 'no-section';
      return null;
    }
    if (sectionLinksTo(text, section, args.companionBasename, opts.linkPrefix)) {
      found.status = 'exists';
      return null;
    }
    found.status = null;
    const { afterLine, blankBefore } = linkInsertion(text, section, args.placement);
    // After a list item, a table row or a quote, a blank line keeps the link out of that block.
    return { afterLine, text: blankBefore ? `\n${args.line}` : args.line };
  });

  if (via === 'editor' || via === 'vault') return { status: 'inserted', via };
  if (via === 'missing') return { status: 'no-daily' };
  if (found.status !== null) return { status: found.status };
  /* The note stayed busy (edited moments ago, then closed) and nothing was
     written. The contract has no status of its own for that; to the caller it
     is the same outcome as a daily that could not be reached. */
  return { status: 'no-daily' };
}

export interface NoteLinkArgs {
  section: { title: string; ordinal: number } | null;
  /** What the meeting is called: the title of a whole-note section. */
  title: string;
  companionBasename: string;
  line: string;
  placement: LinkPlacement;
}

/** The line where a whole-note section's link goes when the note has nothing to put it after. */
function afterFrontmatter(text: string): number {
  const lines = text.split('\n');
  if ((lines[0] ?? '').trim() !== '---') return 0;
  const close = lines.findIndex((line, i) => i > 0 && line.trim() === '---');
  return close > 0 ? close : 0;
}

/**
 * Adds the companion's link line to a note other than the daily: at the end of the meeting's
 * section of it, or at the end of the note (before the plugin's own sections, if it has them)
 * when the meeting is the whole note.
 */
export async function insertNoteLink(
  target: TextTarget,
  notePath: string,
  args: NoteLinkArgs,
  opts: SectionOptions,
): Promise<DailyLinkResult> {
  const found: { status: 'exists' | 'no-section' | null } = { status: null };
  const via = await target.insertLine(notePath, (text) => {
    const section = args.section
      ? findSection(text, args.section, opts, args.companionBasename)
      : wholeNoteSection(text, args.title, opts);
    if (!section) {
      found.status = 'no-section';
      return null;
    }
    if (sectionLinksTo(text, section, args.companionBasename, opts.linkPrefix)) {
      found.status = 'exists';
      return null;
    }
    found.status = null;
    // A whole note has no heading for the line to go under.
    const placement = args.section ? args.placement : 'section-end';
    const at = linkInsertion(text, section, placement);
    const afterLine = at.afterLine < 0 ? afterFrontmatter(text) : at.afterLine;
    return { afterLine, text: at.blankBefore ? `\n${args.line}` : args.line };
  });
  if (via === 'editor' || via === 'vault') return { status: 'inserted', via };
  if (via === 'missing') return { status: 'no-daily' };
  if (found.status !== null) return { status: found.status };
  return { status: 'no-daily' };
}
