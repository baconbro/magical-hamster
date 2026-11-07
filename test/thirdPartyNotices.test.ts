import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

/* THIRD_PARTY_NOTICES.md travels inside main.js, with the version of each
   bundled package. The lockfile decides which version is bundled: the two
   must agree, and every runtime dependency must have its notice. */

const REPO = fileURLToPath(new URL('..', import.meta.url));
const notices = readFileSync(join(REPO, 'THIRD_PARTY_NOTICES.md'), 'utf8');
const lockfile = readFileSync(join(REPO, 'pnpm-lock.yaml'), 'utf8');
const pkg = JSON.parse(readFileSync(join(REPO, 'package.json'), 'utf8')) as { dependencies: Record<string, string> };

/** The table under "Bundled in dist/main.js": package name and version per row. */
function bundledTable(): Array<{ name: string; version: string }> {
  const section = notices.split(/^## /m).find((part) => part.startsWith('Bundled in'));
  assert.ok(section, 'THIRD_PARTY_NOTICES.md has a "Bundled in" section');
  const rows: Array<{ name: string; version: string }> = [];
  for (const line of section.split('\n')) {
    const row = /^\| \[([^\]]+)\]\([^)]*\) \| (\S+) \|/.exec(line);
    if (row) rows.push({ name: row[1], version: row[2] });
  }
  assert.ok(rows.length > 0, 'the table has rows');
  return rows;
}

describe('THIRD_PARTY_NOTICES.md against the lockfile', () => {
  it('names the version the lockfile resolves for every bundled package', () => {
    for (const { name, version } of bundledTable()) {
      assert.match(lockfile, new RegExp(`^  ${name.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')}@${version.replaceAll('.', '\\.')}:`, 'm'), `${name}@${version}`);
    }
  });

  it('has a row for every runtime dependency of package.json', () => {
    const listed = new Set(bundledTable().map((row) => row.name));
    for (const name of Object.keys(pkg.dependencies)) assert.ok(listed.has(name), `${name} has a notice`);
  });

  it('has a licence text for every row', () => {
    for (const { name } of bundledTable()) assert.match(notices, new RegExp(`^### ${name}$`, 'm'), `a heading for ${name}`);
  });
});
