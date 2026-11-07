import { copyFile, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

/* Copies the built plugin into a vault.
 *
 * Deliberately does not guess: the vault is named by the first argument or by
 * HAMSTER_VAULT, and the script stops if that folder is not a vault.
 *
 *   HAMSTER_VAULT="/path/to/vault" pnpm install:plugin
 *   pnpm install:plugin ./dev-vault
 *
 * Obsidian keeps a vault's settings and plugins in `.obsidian` unless the
 * vault was given another config folder on this device (Settings, Files and
 * links, Override config folder). Such a vault often still has the old
 * `.obsidian`, which this device no longer reads, so the folder in use has to
 * be named: as the second argument or in HAMSTER_CONFIG_DIR.
 *
 *   pnpm install:plugin /path/to/vault .obsidian-desktop
 *   HAMSTER_VAULT="/path/to/vault" HAMSTER_CONFIG_DIR=".obsidian-desktop" pnpm install:plugin
 *
 * THIRD_PARTY_NOTICES.md goes along when it is there: main.js holds other
 * people's packages, and their licences ask that the notice travels with it.
 */

const NOTICES = 'THIRD_PARTY_NOTICES.md';

const vault = process.argv[2] ?? process.env.HAMSTER_VAULT;

if (!vault) {
  console.error('Name the vault: HAMSTER_VAULT="/path/to/vault" pnpm install:plugin');
  process.exit(1);
}

const configDir = process.argv[3] ?? process.env.HAMSTER_CONFIG_DIR ?? '.obsidian';
const config = join(resolve(vault), configDir);
try {
  if (!(await stat(config)).isDirectory()) throw new Error('not a directory');
} catch {
  console.error(`${config} is not there. That path does not look like an Obsidian vault.`);
  console.error(
    'A vault with another config folder can name it: as the second argument, or HAMSTER_CONFIG_DIR=".obsidian-desktop".',
  );
  process.exit(1);
}

const { id, name } = JSON.parse(await readFile(join('dist', 'manifest.json'), 'utf8'));
const dest = join(config, 'plugins', id);
await mkdir(dest, { recursive: true });

/* The build being replaced, as Obsidian may be running it: since src/host/selfReload.ts, a
   development build loads the next one by itself, and says so in its code. */
const SELF_RELOAD_MARK = 'magical-hamster:self-reload';
let previous = null;
try {
  previous = await readFile(join(dest, 'main.js'), 'utf8');
} catch {
  // a first install
}

for (const file of ['main.js', 'manifest.json', 'styles.css']) {
  await copyFile(join('dist', file), join(dest, file));
}
/* A development build reloads itself when a new one is installed beside it, and only where this
   file is (src/host/selfReload.ts). Not .hotreload: that would invite the Hot Reload plugin too,
   which reloads without waiting for a recording to end. */
await writeFile(join(dest, '.selfreload'), '');
// Left by earlier installs: it would let the Hot Reload plugin reload this one without waiting for a recording to end.
await rm(join(dest, '.hotreload'), { force: true });
// Beside the build, not in it: the file is written by hand and kept at the root of the repository.
try {
  await copyFile(NOTICES, join(dest, NOTICES));
} catch (error) {
  if (error?.code !== 'ENOENT') throw error;
}

console.log(`Installed to ${dest}`);
console.log(`Enable it in Obsidian: Settings, Community plugins, ${name}.`);
/* Obsidian keeps running the code it loaded until the plugin is reloaded: copying a new main.js
   changes nothing by itself. A build that reloads itself does it when it sees the new one;
   an older build needs turning off and on by hand. */
if (previous !== null) {
  if (previous.includes(SELF_RELOAD_MARK)) {
    console.log(
      `If Obsidian is open, ${name} loads this build by itself in a second; while a meeting with a recording is open, once that meeting is ended.`,
    );
  } else {
    console.log(
      `If Obsidian is open, it is still running the previous build: turn ${name} off and on again in Settings, Community plugins (or run "Reload app without saving"). A recorded meeting not yet saved in the sidebar is lost by the reload. From this build on, it reloads by itself.`,
    );
  }
}
