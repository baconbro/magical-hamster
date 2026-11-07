import { readFile, writeFile } from 'node:fs/promises';

/* Finishes the plugin build.
 *
 * Obsidian loads a folder of three files by name: main.js, manifest.json,
 * styles.css. Vite produces the first and the last; this copies the manifest
 * across and keeps its version in step with package.json. */

const OUT = 'dist';
const MANIFEST = 'manifest.json';

const pkg = JSON.parse(await readFile('package.json', 'utf8'));
const manifest = JSON.parse(await readFile(MANIFEST, 'utf8'));

if (manifest.version !== pkg.version) {
  manifest.version = pkg.version;
  await writeFile(MANIFEST, `${JSON.stringify(manifest, null, 2)}\n`);
}

await writeFile(`${OUT}/manifest.json`, `${JSON.stringify(manifest, null, 2)}\n`);


console.log(`${OUT}/: main.js, styles.css, manifest.json (v${manifest.version})`);
