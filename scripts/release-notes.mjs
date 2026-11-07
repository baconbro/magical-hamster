import { readFileSync, realpathSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/* The release notes of a version: its section of CHANGELOG.md.
 *
 *   node scripts/release-notes.mjs 0.2.0
 *
 * Prints what is under "## [0.2.0]" up to the next "## " heading, and nothing
 * at all when the changelog has no such section: .github/workflows/release.yml
 * then falls back to its fixed notes. */

/**
 * The body of the `## [version]` section of `changelog`, trimmed, or '' when
 * there is none. The closing bracket is part of what is looked for, so `0.1.4`
 * does not find `## [0.1.40]`.
 * @param {string} changelog
 * @param {string} version
 * @returns {string}
 */
export function sectionOf(changelog, version) {
  const lines = String(changelog).split(/\r?\n/);
  const start = lines.findIndex((line) => line.startsWith(`## [${version}]`));
  if (start < 0) return '';
  const rest = lines.slice(start + 1);
  const next = rest.findIndex((line) => line.startsWith('## '));
  return (next < 0 ? rest : rest.slice(0, next)).join('\n').trim();
}

const here = fileURLToPath(import.meta.url);

/** Run as a script, not imported: Node's argv[1] is this file, however it was spelled. */
function isMain() {
  try {
    return Boolean(process.argv[1]) && realpathSync(process.argv[1]) === realpathSync(here);
  } catch {
    return false;
  }
}

if (isMain()) {
  const notes = sectionOf(readFileSync(join(dirname(here), '..', 'CHANGELOG.md'), 'utf8'), process.argv[2] ?? '');
  // Nothing, not an empty line: the workflow tests the file for content.
  if (notes) console.log(notes);
}
